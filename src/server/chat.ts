import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { bareAddress } from "./aws/mime";
import { sha256Hex } from "./aws/sigv4";
import { orgOf } from "./brands";
import { pushToRoom } from "./chat-room";
import { db, schema } from "./db";
import type { ChatAttachment } from "./db/schema";
import { baseUrl, cfg } from "./env";
import { ApiError, notFound, validation } from "./errors";
import { sign } from "./inbound";
import { checkSendLists, type Inbox, type InboxActor, logInbox, need } from "./inboxes";
import { iso } from "./time";

/**
 * Website chat: a widget on a brand's sites (chat-widget.js, served with its settings at
 * /chat/<key>.js) that opens a conversation in one of its agent inboxes. The visitor sees a chat;
 * the team sees the conversation in the dashboard, live, and gets an email about new messages
 * that they can answer by replying. So the same conversation, read state, drafts, approvals and
 * agent credentials work for chats as for email.
 *
 * - Settings are one row per inbox (chat_widgets): a public key, the websites it may run on,
 *   how it looks, who's notified.
 * - A visitor's token (mrv_…, in the website's localStorage) is their chat; we keep its hash.
 * - Every line is a chat_messages row; the ChatRoom Durable Object pushes it to open sockets.
 * - The team's notification email goes Reply-To <inbox>+chat-<key>@…; a reply from a notified
 *   address (DKIM or DMARC passing) becomes the team's line. A visitor who left gets the team's
 *   lines by email, Reply-To +chatv-<key>, and their answer joins the chat.
 * - Nothing a visitor types is ever emailed to anyone but the team: the visitor's email address
 *   gets only what the team wrote.
 */

export type ChatWidget = typeof schema.chatWidgets.$inferSelect;
export type ChatLine = typeof schema.chatMessages.$inferSelect;
type Conversation = typeof schema.conversations.$inferSelect;

const cw = schema.chatWidgets;
const cm = schema.chatMessages;
const cv = schema.chatVisitors;
const c = schema.conversations;

// ── Limits ─────────────────────────────────────────────────────────────────

export const CHAT_LIMITS = {
	/** Characters in one message. */
	text: 4000,
	/** Visitor messages a minute, per chat. */
	perMinute: 20,
	/** Visitor messages in one chat. */
	perChat: 500,
	/** New chats per IP address an hour. */
	startsPerHour: 6,
	/** One file's size, and files per chat. */
	fileBytes: 10 * 1024 * 1024,
	filesPerChat: 30,
	/** Websites per widget. */
	origins: 20,
};

export const FILE_TYPES: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/heic": "heic",
	"application/pdf": "pdf",
	"text/plain": "txt",
	"text/csv": "csv",
	"application/zip": "zip",
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Shown in the page (an <img>): the rest are downloads. */
export const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// ── Design ─────────────────────────────────────────────────────────────────

const hex = z
	.string()
	.trim()
	.regex(/^#[0-9a-fA-F]{6}$/, "a color like #2563eb");

const shortText = (max: number) => z.string().trim().max(max);

/** How the widget looks and what it says. Every key optional; missing ones take the defaults. */
export const chatDesign = z.object({
	/** The panel's header: the team or business name (default: the brand's name). */
	title: shortText(60).nullish(),
	/** Under the title ("We usually reply in a few minutes"). */
	subtitle: shortText(120).nullish(),
	/** The first message the visitor sees, from the team. */
	greeting: shortText(500).nullish(),
	/** The composer's placeholder. */
	placeholder: shortText(80).nullish(),
	/** Accent color: the launcher, the visitor's bubbles, buttons. */
	color: hex.optional(),
	position: z.enum(["right", "left"]).optional(),
	theme: z.enum(["auto", "light", "dark"]).optional(),
	/** The launcher: a round bubble, a pill with a label, none (your own button opens it), or
	 * "auto": none until the visitor opens the chat from your button, then the bubble. */
	launcher: z.enum(["bubble", "label", "hidden", "auto"]).optional(),
	launcher_text: shortText(40).nullish(),
	/** Show the brand's logo in the header. */
	show_logo: z.boolean().optional(),
	/** Told after the visitor's first message when nobody is connected ("We'll email you"). */
	away: shortText(300).nullish(),
	/** Tell the visitor how long chats are kept. */
	show_retention: z.boolean().optional(),
	/** Ask for a name too (with the email). */
	ask_name: z.boolean().optional(),
	/** Spacing from the corner, in pixels. */
	offset_x: z.number().int().min(0).max(200).optional(),
	offset_y: z.number().int().min(0).max(200).optional(),
	/** How round everything is: the panel, bubbles, fields, the launcher. */
	corners: z.enum(["square", "soft", "rounded", "pill"]).optional(),
	/** The header: the accent, a gradient (to color2), or plain like the panel. */
	header: z.enum(["solid", "gradient", "plain"]).optional(),
	color2: hex.nullish(),
	/** Behind the messages. */
	background: z.enum(["plain", "tint", "gradient", "dots", "grid"]).optional(),
	/** The visitor's bubbles and the team's. */
	bubbles: z.enum(["filled", "soft", "outline"]).optional(),
	team_bubbles: z.enum(["gray", "accent", "outline"]).optional(),
	/** The website's own font, or one of a few that every device has. */
	font: z.enum(["system", "site", "rounded", "serif", "mono"]).optional(),
	text_size: z.enum(["small", "medium", "large"]).optional(),
	/** The panel's size on computers (phones always get the whole screen). */
	width: z.enum(["compact", "regular", "wide"]).optional(),
	shadow: z.enum(["none", "soft", "strong"]).optional(),
	launcher_size: z.enum(["small", "medium", "large"]).optional(),
	launcher_icon: z
		.enum(["chat", "message", "help", "headset", "sparkle", "hand", "logo"])
		.optional(),
	/** No launcher on phones (MailroomChat.open() and #mailroom-chat links still open it). */
	hide_mobile: z.boolean().optional(),
	/** The greeting pops up by the launcher after this many seconds (0: never). */
	nudge_after: z.number().int().min(0).max(300).optional(),
	/** Above the site's own popups. */
	z_index: z.number().int().min(1).max(2147483647).nullish(),
	/** The brand's own CSS, inside the widget only (the page can't be reached from it). */
	custom_css: z.string().max(10_000).nullish(),
	/** The widget's own words (buttons, notices, errors): English or Spanish. */
	language: z.enum(["en", "es"]).optional(),
});
export type ChatDesign = z.infer<typeof chatDesign>;

export const DESIGN_DEFAULTS: Required<{
	[K in keyof ChatDesign]: Exclude<ChatDesign[K], undefined | null> | null;
}> = {
	title: null,
	subtitle: "We usually reply in a few minutes",
	greeting: "Hi there! How can we help?",
	placeholder: "Write a message…",
	color: "#2563eb",
	position: "right",
	theme: "auto",
	launcher: "bubble",
	launcher_text: "Chat with us",
	show_logo: true,
	away: "Thanks! We'll reply here as soon as we can. Leave your email and we'll send it there too.",
	show_retention: false,
	ask_name: false,
	offset_x: 20,
	offset_y: 20,
	corners: "rounded",
	header: "solid",
	color2: null,
	background: "plain",
	bubbles: "filled",
	team_bubbles: "gray",
	font: "system",
	text_size: "medium",
	width: "regular",
	shadow: "soft",
	launcher_size: "medium",
	launcher_icon: "chat",
	hide_mobile: false,
	nudge_after: 0,
	z_index: null,
	custom_css: null,
	language: "en",
};

/** The default texts of a chat in Spanish (design.language "es"). */
export const DESIGN_DEFAULTS_ES = {
	subtitle: "Solemos responder en unos minutos",
	greeting: "¡Hola! ¿En qué le ayudamos?",
	placeholder: "Escriba un mensaje…",
	launcher_text: "Chatee con nosotros",
	away: "Gracias. Le respondemos aquí en cuanto podamos; déjenos su correo y se lo enviamos ahí también.",
} satisfies Partial<typeof DESIGN_DEFAULTS>;

export const designOf = (w: Pick<ChatWidget, "design">) => {
	const d = (w.design ?? {}) as ChatDesign;
	const out: Record<string, unknown> = {
		...DESIGN_DEFAULTS,
		...(d.language === "es" ? DESIGN_DEFAULTS_ES : {}),
	};
	for (const [k, v] of Object.entries(d)) if (v !== undefined) out[k] = v;
	return out as typeof DESIGN_DEFAULTS;
};

// ── Settings ───────────────────────────────────────────────────────────────

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const random = (n: number, alphabet = ALPHABET) =>
	[...crypto.getRandomValues(new Uint8Array(n))]
		.map((b) => alphabet[b % alphabet.length])
		.join("");

export const newPublicKey = () => `mrc_${random(24)}`;
const KEY_RE = /^mrc_[A-Za-z0-9]{24}$/;
/** Lowercase letters and digits only: it goes in an email address. */
const newChatKey = () => random(12, "abcdefghijkmnpqrstuvwxyz23456789");
const VISITOR_RE = /^mrv_[A-Za-z0-9]{40}$/;

/** "https://www.acme.com/x", "*.acme.com" or "acme.com:8080" → "www.acme.com" / "acme.com". */
export function originHost(entry: string): string | null {
	let s = entry.trim().toLowerCase();
	if (!s) return null;
	s = s.replace(/^\*\./, "");
	if (!/^[a-z]+:\/\//.test(s)) s = `https://${s}`;
	try {
		const host = new URL(s).hostname.replace(/\.$/, "");
		if (host === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host)) return host;
		return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
	} catch {
		return null;
	}
}

export const settingsInput = z.object({
	enabled: z.boolean().optional(),
	origins: z.array(z.string().max(300)).max(CHAT_LIMITS.origins).optional(),
	design: chatDesign.optional(),
	ask_email: z.enum(["off", "optional", "required"]).optional(),
	notify: z.array(z.string().trim().max(320)).max(10).optional(),
	daily_limit: z.number().int().min(1).max(10_000).optional(),
	/** Email the team (notify) about visitors' new lines nobody read, after this many minutes. */
	email_team: z.boolean().optional(),
	email_team_after: z.number().int().min(1).max(1440).optional(),
	/** Email a visitor who left their email the team's lines they didn't see, after this many minutes. */
	email_visitor: z.boolean().optional(),
	email_visitor_after: z.number().int().min(1).max(1440).optional(),
	/** The inbox's retention: days, 0 always, null the deployment's. */
	retention_days: z.number().int().min(0).max(3650).nullish(),
	/** Only visitors the website signed in may chat (needs the identity secret). */
	identity_required: z.boolean().optional(),
});

export async function getChatWidget(inboxId: string) {
	return (await db.select().from(cw).where(eq(cw.inbox_id, inboxId)).get()) ?? null;
}

const lower = (s: string) => s.trim().toLowerCase();
const lowerBare = (a: string) => bareAddress(a).trim().toLowerCase();
const EMAIL_RE = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Creates or updates the inbox's chat. Keeps the brand's Turnstile widget in step. */
export async function saveChatWidget(
	inbox: Inbox,
	raw: unknown,
	by: { userId?: string | null; email?: string | null } = {},
	now = Date.now(),
) {
	const v = settingsInput.parse(raw ?? {});
	const existing = await getChatWidget(inbox.id);
	const origins =
		v.origins !== undefined
			? [
					...new Set(
						v.origins.map((o) => {
							const h = originHost(o);
							if (!h) throw validation(`origins: "${o}" isn't a website address`);
							return h;
						}),
					),
				]
			: (existing?.origins ?? []);
	const notify =
		v.notify !== undefined
			? [
					...new Set(
						v.notify.filter(Boolean).map((a) => {
							const x = lowerBare(a);
							if (!EMAIL_RE.test(x))
								throw validation(`notify: "${a}" isn't an email address`);
							return x;
						}),
					),
				]
			: (existing?.notify ?? (by.email ? [lower(by.email)] : []));
	const design = v.design
		? Object.fromEntries(
				Object.entries({ ...(existing?.design ?? {}), ...v.design }).filter(
					([, x]) => x !== undefined,
				),
			)
		: (existing?.design ?? {});
	const row = {
		inbox_id: inbox.id,
		organization_id: inbox.organization_id,
		enabled: v.enabled ?? existing?.enabled ?? true,
		public_key: existing?.public_key ?? newPublicKey(),
		origins,
		design,
		ask_email: v.ask_email ?? existing?.ask_email ?? "optional",
		notify,
		daily_limit: v.daily_limit ?? existing?.daily_limit ?? 100,
		email_team: v.email_team ?? existing?.email_team ?? true,
		email_team_after: v.email_team_after ?? existing?.email_team_after ?? 1,
		email_visitor: v.email_visitor ?? existing?.email_visitor ?? true,
		email_visitor_after: v.email_visitor_after ?? existing?.email_visitor_after ?? 3,
		identity_secret: existing?.identity_secret ?? null,
		identity_required: v.identity_required ?? existing?.identity_required ?? false,
		created_by: existing?.created_by ?? by.userId ?? null,
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};
	if (row.identity_required && !row.identity_secret)
		throw validation(
			"identity_required: make the identity secret first (the chat's Identity verification)",
		);
	await db.insert(cw).values(row).onConflictDoUpdate({ target: cw.inbox_id, set: row });
	if (v.retention_days !== undefined)
		await db
			.update(schema.inboxes)
			.set({ retention_days: v.retention_days, updated_at: iso(now) })
			.where(eq(schema.inboxes.id, inbox.id));
	forgetWidgets();
	// Turnstile covers the chat's websites too (never blocks saving).
	let turnstile: string | null = null;
	const { syncTurnstile, turnstileConfigured } = await import("./turnstile");
	if (turnstileConfigured()) {
		const brand = await db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, inbox.organization_id))
			.get();
		turnstile = await syncTurnstile(inbox.organization_id, brand?.name ?? "Brand", now);
	}
	return { widget: row as ChatWidget, turnstile };
}

/** A new public key: the old one stops at once (sites must get the new snippet). */
export async function rotateChatKey(inbox: Inbox, now = Date.now()) {
	const w = await getChatWidget(inbox.id);
	if (!w) throw notFound("Chat");
	const [row] = await db
		.update(cw)
		.set({ public_key: newPublicKey(), updated_at: iso(now) })
		.where(eq(cw.inbox_id, inbox.id))
		.returning();
	forgetWidgets();
	return row as ChatWidget;
}

/**
 * A new identity secret (mrcs_…), returned this once: the website signs its visitors with it
 * (src/server/chat-identity.ts). The old one stops at once; null removes it (and the rule that
 * only signed-in visitors may chat).
 */
export async function setIdentitySecret(inbox: Inbox, make: boolean, now = Date.now()) {
	const w = await getChatWidget(inbox.id);
	if (!w) throw notFound("Chat");
	const { newIdentitySecret } = await import("./chat-identity");
	const secret = make ? newIdentitySecret() : null;
	const [row] = await db
		.update(cw)
		.set({
			identity_secret: secret,
			...(make ? {} : { identity_required: false }),
			updated_at: iso(now),
		})
		.where(eq(cw.inbox_id, inbox.id))
		.returning();
	forgetWidgets();
	return { widget: row as ChatWidget, secret };
}

export async function deleteChatWidget(inbox: Inbox) {
	await db.delete(cw).where(eq(cw.inbox_id, inbox.id));
	forgetWidgets();
}

export const snippetFor = (w: Pick<ChatWidget, "public_key">) =>
	`<script src="${baseUrl()}/chat/${w.public_key}.js" async></script>`;

export const chatWidgetView = (w: ChatWidget) => ({
	object: "chat_widget",
	inbox_id: w.inbox_id,
	brand_id: w.organization_id,
	enabled: w.enabled,
	public_key: w.public_key,
	origins: w.origins,
	design: designOf(w),
	ask_email: w.ask_email as "off" | "optional" | "required",
	notify: w.notify,
	daily_limit: w.daily_limit,
	/** Emails about the chat: the team about new visitor lines, the visitor about unseen answers. */
	email_team: w.email_team,
	email_team_after: w.email_team_after,
	email_visitor: w.email_visitor,
	email_visitor_after: w.email_visitor_after,
	/** Identity verification: whether the secret exists (never its value) and is required. */
	identity: { configured: !!w.identity_secret, required: w.identity_required },
	snippet: snippetFor(w),
	test_page: `${baseUrl()}/chat/${w.public_key}/try#mailroom-chat`,
	created_at: w.created_at,
	updated_at: w.updated_at,
});

// Public lookups are cached briefly per isolate (every widget request needs one).
const CACHE_MS = 15_000;
const widgetCache = new Map<
	string,
	{ value: { widget: ChatWidget; inbox: Inbox } | null; until: number }
>();
export const forgetWidgets = () => widgetCache.clear();

/** The chat a public key opens (enabled or not), with its inbox. */
export async function widgetByKey(key: string, now = Date.now()) {
	if (!KEY_RE.test(key)) return null;
	const hit = widgetCache.get(key);
	if (hit && hit.until > now) return hit.value;
	const row = await db
		.select({ widget: cw, inbox: schema.inboxes })
		.from(cw)
		.innerJoin(schema.inboxes, eq(schema.inboxes.id, cw.inbox_id))
		.where(eq(cw.public_key, key))
		.get();
	const value = row ? { widget: row.widget, inbox: row.inbox } : null;
	widgetCache.set(key, { value, until: now + CACHE_MS });
	return value;
}

/** Whether a page at `origin` may use the widget: one of its websites (or a subdomain of
 * one), or Mailroom itself (the dashboard's preview, the test page). */
export function originAllowed(w: Pick<ChatWidget, "origins">, origin: string | null) {
	if (!origin) return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const host = url.hostname.toLowerCase();
	const local = host === "localhost" || /^127\./.test(host);
	if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return false;
	const own = (() => {
		try {
			return new URL(baseUrl()).hostname;
		} catch {
			return "";
		}
	})();
	if (host === own) return true;
	return w.origins.some((o) => host === o || host.endsWith(`.${o}`));
}

// ── Visitors ───────────────────────────────────────────────────────────────

/** A keyed hash of the address: counts per IP without keeping it. */
async function ipHash(ip: string | null) {
	return ip ? sign(`chat-ip:${ip}`) : null;
}

export interface VisitorChat {
	conversation: Conversation;
	widget: ChatWidget;
	inbox: Inbox;
	tokenHash: string;
}

/** The chat a visitor token is, under this widget (null: unknown, or another widget's). */
export async function visitorChat(
	key: string,
	token: string | null | undefined,
): Promise<VisitorChat | null> {
	if (!token || !VISITOR_RE.test(token)) return null;
	const w = await widgetByKey(key);
	if (!w) return null;
	const tokenHash = await sha256Hex(token);
	const row = await db
		.select({ conversation: c, inbox: cv.inbox_id })
		.from(cv)
		.innerJoin(c, eq(c.id, cv.conversation_id))
		.where(eq(cv.token_hash, tokenHash))
		.get();
	if (!row || row.inbox !== w.inbox.id || row.conversation.channel !== "chat") return null;
	return { conversation: row.conversation, widget: w.widget, inbox: w.inbox, tokenHash };
}

const startInput = z.object({
	text: z.string().max(CHAT_LIMITS.text).optional(),
	name: z.string().trim().max(100).nullish(),
	email: z.string().trim().max(320).nullish(),
	page: z.string().trim().max(2000).nullish(),
	client_id: z.string().max(100).nullish(),
	/** The website's signed identity token (src/server/chat-identity.ts). */
	identity: z.string().max(8000).nullish(),
});

const cleanEmail = (raw: string | null | undefined) => {
	const s = lower(raw ?? "");
	if (!s) return null;
	if (!EMAIL_RE.test(s)) throw validation("email: that doesn't look like an email address");
	return s;
};

const cleanPage = (raw: string | null | undefined) => {
	if (!raw) return null;
	try {
		const u = new URL(raw);
		return /^https?:$/.test(u.protocol) ? u.toString().slice(0, 2000) : null;
	} catch {
		return null;
	}
};

const firstLine = (s: string, max = 80) => {
	const line = s.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const tooMany = (message: string) =>
	new ApiError(429, "rate_limit_exceeded", message, { "retry-after": "60" });

/**
 * A visitor's first message: a new conversation in the widget's inbox, its token (shown once) and
 * the first lines. Turnstile and the origin are the caller's to check.
 */
export async function startChat(
	w: { widget: ChatWidget; inbox: Inbox },
	raw: unknown,
	o: { ip?: string | null; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const v = startInput.parse(raw ?? {});
	const text = (v.text ?? "").trim();
	if (!text) throw validation("text: write a message");
	const who = await identityOf(w.widget, v.identity, now);
	const email = who?.email ?? cleanEmail(v.email);
	if (w.widget.ask_email === "required" && !email)
		throw validation("email: leave your email so we can reply");
	const hash = await ipHash(o.ip ?? null);
	if (hash) {
		const recent = await db
			.select({ n: sql<number>`count(*)` })
			.from(cv)
			.where(and(eq(cv.ip_hash, hash), gt(cv.created_at, iso(now - 3_600_000))))
			.get();
		if ((recent?.n ?? 0) >= CHAT_LIMITS.startsPerHour)
			throw tooMany("Too many new chats from here; try again in a while");
	}
	const today = await db
		.select({ n: sql<number>`count(*)` })
		.from(c)
		.where(
			and(
				eq(c.inbox_id, w.inbox.id),
				eq(c.channel, "chat"),
				gt(c.created_at, iso(now - 86_400_000)),
			),
		)
		.get();
	if ((today?.n ?? 0) >= w.widget.daily_limit)
		throw new ApiError(
			429,
			"chat_busy",
			`We can't take more chats right now. Write to ${w.inbox.address} instead.`,
		);
	const id = crypto.randomUUID();
	const token = `mrv_${random(40)}`;
	const name = who?.name ?? (v.name?.trim() || null);
	const page = cleanPage(v.page);
	const contact = email ?? name ?? "Website visitor";
	const at = iso(now);
	await db.batch([
		db.insert(c).values({
			id,
			organization_id: w.inbox.organization_id,
			inbox_id: w.inbox.id,
			subject: firstLine(text) || "Chat",
			contact,
			status: "open",
			messages: 0,
			snippet: null,
			last_message_at: at,
			last_inbound_at: null,
			created_at: at,
			updated_at: at,
			channel: "chat",
			visitor_name: name,
			visitor_email: email,
			page_url: page,
			chat_key: newChatKey(),
			visitor_seen_at: at,
			visitor_user_id: who?.userId ?? null,
			visitor_attributes: who && Object.keys(who.attributes).length ? who.attributes : null,
		}),
		db.insert(cv).values({
			token_hash: await sha256Hex(token),
			conversation_id: id,
			inbox_id: w.inbox.id,
			ip_hash: hash,
			created_at: at,
			last_seen_at: at,
		}),
	]);
	const conversation = (await db.select().from(c).where(eq(c.id, id)).get()) as Conversation;
	await logInbox("system", {
		brandId: w.inbox.organization_id,
		inboxId: w.inbox.id,
		conversationId: id,
		action: "chat.started",
		detail: { ...(page ? { page } : {}), ...(who ? { verified: true } : {}) },
		now,
	});
	const line = await postVisitorLine(
		{ conversation, inbox: w.inbox, widget: w.widget },
		{ text, client_id: v.client_id ?? null, via: "widget" },
		{ now, created: true },
	);
	return { token, conversation, line };
}

const messageInput = z.object({
	text: z.string().max(CHAT_LIMITS.text),
	client_id: z.string().max(100).nullish(),
});

/** A visitor's message in their chat (rate-limited). */
export async function visitorSays(chat: VisitorChat, raw: unknown, now = Date.now()) {
	const v = messageInput.parse(raw ?? {});
	const text = v.text.trim();
	if (!text) throw validation("text: write a message");
	await checkVisitorRate(chat.conversation.id, now);
	return postVisitorLine(chat, { text, client_id: v.client_id ?? null, via: "widget" }, { now });
}

async function checkVisitorRate(conversationId: string, now: number) {
	const [minute, total] = await Promise.all([
		db
			.select({ n: sql<number>`count(*)` })
			.from(cm)
			.where(
				and(
					eq(cm.conversation_id, conversationId),
					eq(cm.author, "visitor"),
					gt(cm.created_at, iso(now - 60_000)),
				),
			)
			.get(),
		db
			.select({ n: sql<number>`count(*)` })
			.from(cm)
			.where(and(eq(cm.conversation_id, conversationId), eq(cm.author, "visitor")))
			.get(),
	]);
	if ((minute?.n ?? 0) >= CHAT_LIMITS.perMinute)
		throw tooMany("You're sending messages very fast; wait a moment");
	if ((total?.n ?? 0) >= CHAT_LIMITS.perChat)
		throw tooMany("This chat is full; start a new one or email us");
}

/**
 * Records a visitor's line (from the widget or their email), reopens the conversation, tells the
 * room and the inbox's webhooks. The team's email comes from the cron (a minute's lines in one).
 */
async function postVisitorLine(
	chat: Pick<VisitorChat, "conversation" | "inbox"> & { widget?: ChatWidget | null },
	m: {
		text: string;
		client_id: string | null;
		via: "widget" | "email";
		attachments?: ChatAttachment[] | null;
	},
	o: { now?: number; created?: boolean } = {},
) {
	const now = o.now ?? Date.now();
	const x = chat.conversation;
	if (m.client_id) {
		const again = await db
			.select()
			.from(cm)
			.where(and(eq(cm.conversation_id, x.id), eq(cm.client_id, m.client_id)))
			.get();
		if (again) return again;
	}
	const at = iso(now);
	const line: ChatLine = {
		id: crypto.randomUUID(),
		organization_id: x.organization_id,
		conversation_id: x.id,
		inbox_id: x.inbox_id,
		author: "visitor",
		author_id: null,
		author_name: x.visitor_name,
		text: m.text.slice(0, CHAT_LIMITS.text),
		attachments: m.attachments?.length ? m.attachments : null,
		via: m.via,
		client_id: m.client_id,
		sent_by: null,
		notified_at: null,
		created_at: at,
	};
	const snippet = firstLine(m.text || (m.attachments?.length ? "Sent a file" : ""), 200);
	await db.batch([
		db.insert(cm).values(line).onConflictDoNothing(),
		db
			.update(c)
			.set({
				messages: sql`${c.messages} + 1`,
				status: "open",
				resolved_at: null,
				snippet,
				last_message_at: sql`max(${c.last_message_at}, ${at})`,
				last_inbound_at: sql`max(coalesce(${c.last_inbound_at}, ''), ${at})`,
				visitor_seen_at: m.via === "widget" ? at : sql`${c.visitor_seen_at}`,
				updated_at: at,
			})
			.where(eq(c.id, x.id)),
		...(m.via === "widget"
			? [db.update(cv).set({ last_seen_at: at }).where(eq(cv.conversation_id, x.id))]
			: []),
	]);
	const keyed = await linkKey(line, now);
	await pushToRoom(
		x.id,
		{ type: "message", message: visitorView(line, keyed) },
		{ type: "message", message: teamView(line, keyed) },
	);
	if (x.status === "resolved") await pushToRoom(x.id, { type: "conversation", status: "open" });
	const { inboxEvent } = await import("./conversations");
	const about = {
		id: x.id,
		organization_id: x.organization_id,
		inbox_id: x.inbox_id,
		subject: x.subject,
	};
	const summary = {
		message_id: line.id,
		channel: "chat",
		from: x.visitor_email ?? x.contact,
		received_at: at,
		snippet,
		attachments: line.attachments?.length ?? 0,
	};
	// The inbox's workflow (rules, round robin, the SLA): a chat is held to it like an email.
	const { onInbound } = await import("./inbox-workflow");
	await onInbound(
		x.id,
		{
			messageId: null,
			from: x.visitor_email ?? x.contact,
			to: [],
			subject: x.subject,
			text: m.text,
			attachments: line.attachments?.length ?? 0,
			channel: "chat",
			created: !!o.created,
			flags: null,
			at: now,
		},
		now,
	);
	if (o.created) await inboxEvent(about, "inbox.conversation.created", summary, now);
	await inboxEvent(about, "inbox.message.received", summary, now);
	return line;
}

const profileInput = z.object({
	name: z.string().trim().max(100).nullish(),
	email: z.string().trim().max(320).nullish(),
	identity: z.string().max(8000).nullish(),
});

/**
 * Who a start or identify call says the visitor is: verified when it carries a token the widget's
 * secret signed; null when it carries none. A chat that requires it refuses visitors without one.
 */
export async function identityOf(
	widget: Pick<ChatWidget, "identity_secret" | "identity_required">,
	token: string | null | undefined,
	now = Date.now(),
) {
	if (!token) {
		if (widget.identity_required)
			throw new ApiError(401, "identity_required", "Sign in to chat with us");
		return null;
	}
	const { verifyIdentity } = await import("./chat-identity");
	return verifyIdentity(widget.identity_secret, token, now);
}

/** The person's details on their chat, from a verified identity. */
const identitySet = (who: NonNullable<Awaited<ReturnType<typeof identityOf>>>) => ({
	visitor_user_id: who.userId,
	visitor_attributes: Object.keys(who.attributes).length ? who.attributes : null,
	...(who.email ? { visitor_email: who.email } : {}),
	...(who.name ? { visitor_name: who.name } : {}),
});

/**
 * The website says who its signed-in visitor is (MailroomChat.identify with a token). With the
 * visitor's chat: its details are updated, or, when the chat is someone else's (another person
 * signed in on the same browser), the widget must forget it. Without one: the person's latest
 * chat in this inbox, from any browser, with a new visitor token for this one.
 */
export async function identifyVisitor(
	w: { widget: ChatWidget; inbox: Inbox },
	chat: VisitorChat | null,
	raw: unknown,
	o: { ip?: string | null; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const v = z.object({ identity: z.string().max(8000) }).parse(raw ?? {});
	const who = await identityOf(w.widget, v.identity, now);
	if (!who) throw validation("identity: the website's signed token");
	if (chat) {
		const owner = chat.conversation.visitor_user_id;
		if (owner && owner !== who.userId) return { status: "other_person" as const };
		const fresh = await updateVisitor(chat.conversation, identitySet(who), now);
		return { status: "updated" as const, conversation: fresh };
	}
	const latest = await db
		.select()
		.from(c)
		.where(
			and(
				eq(c.inbox_id, w.inbox.id),
				eq(c.visitor_user_id, who.userId),
				eq(c.channel, "chat"),
			),
		)
		.orderBy(desc(c.last_message_at))
		.limit(1)
		.get();
	if (!latest) return { status: "none" as const };
	const token = `mrv_${random(40)}`;
	const at = iso(now);
	await db.insert(cv).values({
		token_hash: await sha256Hex(token),
		conversation_id: latest.id,
		inbox_id: w.inbox.id,
		ip_hash: await ipHash(o.ip ?? null),
		created_at: at,
		last_seen_at: at,
	});
	const fresh = await updateVisitor(latest, identitySet(who), now);
	return { status: "resumed" as const, token, conversation: fresh };
}

async function updateVisitor(x: Conversation, set: Partial<Conversation>, now: number) {
	const email = set.visitor_email !== undefined ? set.visitor_email : x.visitor_email;
	const name = set.visitor_name !== undefined ? set.visitor_name : x.visitor_name;
	await db
		.update(c)
		.set({ ...set, contact: email ?? name ?? "Website visitor", updated_at: iso(now) })
		.where(eq(c.id, x.id));
	const fresh = (await db.select().from(c).where(eq(c.id, x.id)).get()) as Conversation;
	await pushToRoom(x.id, { type: "visitor", visitor: visitorOf(fresh) });
	return fresh;
}

/** The visitor tells us their name or email (or changes it). */
export async function visitorProfile(chat: VisitorChat, raw: unknown, now = Date.now()) {
	const v = profileInput.parse(raw ?? {});
	if (v.identity) {
		const who = await identityOf(chat.widget, v.identity, now);
		if (
			who &&
			chat.conversation.visitor_user_id &&
			chat.conversation.visitor_user_id !== who.userId
		)
			throw new ApiError(409, "other_person", "This chat is someone else's");
		if (who) return updateVisitor(chat.conversation, identitySet(who), now);
	}
	// A verified person's name and email are the website's to say.
	if (chat.conversation.visitor_user_id) return chat.conversation;
	const set: Partial<Conversation> = {};
	if (v.email !== undefined) set.visitor_email = cleanEmail(v.email);
	if (v.name !== undefined) set.visitor_name = v.name?.trim() || null;
	return updateVisitor(chat.conversation, set, now);
}

export const visitorOf = (x: Conversation) => ({
	name: x.visitor_name,
	email: x.visitor_email,
	page_url: x.page_url,
	seen_at: x.visitor_seen_at,
	/** Signed by the website (identity verification): their id there and what it told us. */
	verified: !!x.visitor_user_id,
	user_id: x.visitor_user_id,
	attributes: x.visitor_attributes ?? null,
});

/** The visitor has the chat in front of them (the widget open, the page visible). */
export async function markVisitorSeen(conversationId: string, now = Date.now()) {
	const at = iso(now);
	await db.batch([
		db.update(c).set({ visitor_seen_at: at }).where(eq(c.id, conversationId)),
		db.update(cv).set({ last_seen_at: at }).where(eq(cv.conversation_id, conversationId)),
	]);
	return at;
}

// ── Files ──────────────────────────────────────────────────────────────────

const bucket = () => cfg().INBOUND ?? null;

/** Stores one file of a chat's in R2 (its type and size checked). */
export async function storeChatFile(
	x: Pick<Conversation, "id" | "organization_id">,
	f: { filename: string; content_type: string; bytes: Uint8Array | ArrayBuffer },
) {
	const store = bucket();
	if (!store) throw new ApiError(503, "files_unavailable", "Files can't be stored here");
	const type = lower(f.content_type.split(";")[0] ?? "");
	if (!FILE_TYPES[type]) throw validation("file: send an image, a PDF, or an office document");
	const size = f.bytes.byteLength;
	if (!size) throw validation("file: it's empty");
	if (size > CHAT_LIMITS.fileBytes) throw validation("file: up to 10 MB");
	const id = crypto.randomUUID();
	const key = `chat/${x.organization_id}/${x.id}/${id}`;
	await store.put(key, f.bytes, { httpMetadata: { contentType: type } });
	const filename =
		f.filename
			.replace(/[\\/\0\r\n"]/g, "_")
			.trim()
			.slice(0, 150) || `file.${FILE_TYPES[type]}`;
	return { id, filename, content_type: type, size, key } satisfies ChatAttachment;
}

/** A visitor's file: a line of its own. */
export async function visitorSendsFile(
	chat: VisitorChat,
	f: { filename: string; content_type: string; bytes: ArrayBuffer },
	o: { client_id?: string | null; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	await checkVisitorRate(chat.conversation.id, now);
	const files = await db
		.select({ n: sql<number>`coalesce(sum(json_array_length(${cm.attachments})), 0)` })
		.from(cm)
		.where(eq(cm.conversation_id, chat.conversation.id))
		.get();
	if ((files?.n ?? 0) >= CHAT_LIMITS.filesPerChat)
		throw tooMany("That's as many files as one chat takes; email us the rest");
	const a = await storeChatFile(chat.conversation, f);
	return postVisitorLine(
		chat,
		{ text: "", client_id: o.client_id ?? null, via: "widget", attachments: [a] },
		{ now },
	);
}

const FILE_TTL_S = 7 * 86_400;

/** A file's link (signed; a week): /chat/files/<line>/<file>/<expires>/<signature>. */
async function fileUrl(lineId: string, fileId: string, expires: number) {
	const signature = await sign(`chat:${lineId}:${fileId}:${expires}`);
	return `${baseUrl()}/chat/files/${lineId}/${fileId}/${expires}/${signature}`;
}

/** Links expire on a week boundary, so the same file has the same link all week (cached). */
const linkExpiry = (now: number) => (Math.floor(now / 1000 / FILE_TTL_S) + 2) * FILE_TTL_S;

async function linkKey(line: ChatLine, now: number) {
	const out = new Map<string, string>();
	const exp = linkExpiry(now);
	for (const a of line.attachments ?? []) out.set(a.id, await fileUrl(line.id, a.id, exp));
	return out;
}

/** GET /chat/files/…: the file's bytes, when the link is good. */
export async function serveChatFile(path: string, now = Date.now()): Promise<Response> {
	const [lineId, fileId, expires, signature] = path.split("/").slice(3);
	const gone = new Response("This link has expired or is not valid", { status: 404 });
	if (!lineId || !fileId || !expires || !signature) return gone;
	if (Number(expires) * 1000 < now) return gone;
	const expected = await sign(`chat:${lineId}:${fileId}:${expires}`);
	if (expected.length !== signature.length) return gone;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	if (diff) return gone;
	const line = await db.select().from(cm).where(eq(cm.id, lineId)).get();
	const meta = line?.attachments?.find((a) => a.id === fileId);
	const obj = meta ? await bucket()?.get(meta.key) : null;
	if (!meta || !obj) return gone;
	const inline = INLINE_IMAGES.has(meta.content_type) || meta.content_type === "application/pdf";
	return new Response(obj.body, {
		headers: {
			"content-type": meta.content_type,
			"content-length": String(meta.size),
			"content-disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename}"`,
			"cache-control": "private, max-age=86400",
			"content-security-policy":
				"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
			"cross-origin-resource-policy": "cross-origin",
		},
	});
}

// ── Views ──────────────────────────────────────────────────────────────────

const filesView = (line: ChatLine, links: Map<string, string>) =>
	(line.attachments ?? []).map((a) => ({
		id: a.id,
		filename: a.filename,
		content_type: a.content_type,
		size: a.size,
		image: INLINE_IMAGES.has(a.content_type),
		url: links.get(a.id) ?? null,
	}));

/** A team member's first name for the visitor; never an email address (someone with no name). */
const firstName = (name: string | null) => {
	const first = (name ?? "").trim().split(/\s+/)[0] || null;
	return first?.includes("@") ? null : first;
};

/** What the visitor sees of a line: the team's first names, never ids or how it was sent. */
export const visitorView = (line: ChatLine, links: Map<string, string>) => ({
	id: line.id,
	author: line.author === "visitor" ? "visitor" : line.author === "system" ? "system" : "team",
	name:
		line.author === "visitor"
			? null
			: line.author === "agent"
				? line.author_name
				: firstName(line.author_name),
	text: line.text,
	files: filesView(line, links),
	at: line.created_at,
	client_id: line.author === "visitor" ? line.client_id : null,
});

/** What the team sees (the dashboard, the API): who and how. */
export const teamView = (line: ChatLine, links: Map<string, string>) => ({
	type: "chat" as const,
	id: line.id,
	at: line.created_at,
	author: {
		type: line.author as "visitor" | "person" | "agent" | "api" | "system",
		id: line.author_id,
		name: line.author_name,
	},
	text: line.text,
	files: filesView(line, links),
	via: line.via as "widget" | "dashboard" | "email" | "api",
	sent_by: line.sent_by,
	// A line written when the visitor had no email is marked done at once: nothing was emailed.
	emailed_at:
		line.author !== "visitor" && line.notified_at && line.notified_at !== line.created_at
			? line.notified_at
			: null,
});

/** A chat's lines, oldest first (after a line, or the newest `limit`). */
export async function chatLines(
	conversationId: string,
	o: { after?: string | null; limit?: number } = {},
) {
	const limit = Math.min(o.limit ?? 200, 500);
	if (o.after) {
		const from = await db
			.select({ at: cm.created_at })
			.from(cm)
			.where(and(eq(cm.id, o.after), eq(cm.conversation_id, conversationId)))
			.get();
		if (from)
			return db
				.select()
				.from(cm)
				.where(
					and(
						eq(cm.conversation_id, conversationId),
						gte(cm.created_at, from.at),
						ne(cm.id, o.after),
					),
				)
				.orderBy(asc(cm.created_at), asc(cm.id))
				.limit(limit);
	}
	const rows = await db
		.select()
		.from(cm)
		.where(eq(cm.conversation_id, conversationId))
		.orderBy(desc(cm.created_at), desc(cm.id))
		.limit(limit);
	return rows.reverse();
}

/** Lines as the visitor sees them (the widget). */
export async function linesFor(_view: "visitor", lines: ChatLine[], now = Date.now()) {
	return Promise.all(lines.map(async (l) => visitorView(l, await linkKey(l, now))));
}

/** Lines as the team sees them (the dashboard, the API). */
export async function teamLines(lines: ChatLine[], now = Date.now()) {
	return Promise.all(lines.map(async (l) => teamView(l, await linkKey(l, now))));
}

/** The team's last line the visitor has seen, for "Seen" under it. */
export async function chatState(x: Conversation) {
	return {
		id: x.id,
		status: x.status as "open" | "resolved",
		visitor: visitorOf(x),
	};
}

// ── The team's lines ───────────────────────────────────────────────────────

/**
 * The team writes in a chat: a person in the dashboard, an agent through its credential, a draft
 * approved, or an email reply. Pushed to the visitor at once; emailed to them only if they don't
 * see it within a few minutes and left their email.
 */
export async function teamSays(
	actor: Pick<InboxActor, "type" | "id" | "name" | "organizationId" | "permissions" | "reader">,
	x: Conversation,
	m: {
		text: string;
		via: "dashboard" | "api" | "email";
		attachments?: ChatAttachment[] | null;
		client_id?: string | null;
		draft?: typeof schema.conversationReplies.$inferSelect | null;
	},
	now = Date.now(),
) {
	need(actor as InboxActor, "send");
	const text = m.text.trim().slice(0, CHAT_LIMITS.text);
	if (!text && !m.attachments?.length) throw validation("text: write the reply");
	if (m.client_id) {
		const again = await db
			.select()
			.from(cm)
			.where(and(eq(cm.conversation_id, x.id), eq(cm.client_id, m.client_id)))
			.get();
		if (again) return again;
	}
	const at = iso(now);
	const draft = m.draft ?? null;
	const author = draft
		? { type: draft.author_type, id: draft.author_id, name: draft.author_name }
		: { type: actor.type, id: actor.id, name: actor.name };
	const line: ChatLine = {
		id: crypto.randomUUID(),
		organization_id: x.organization_id,
		conversation_id: x.id,
		inbox_id: x.inbox_id,
		author: author.type,
		author_id: author.id,
		author_name: author.name,
		text,
		attachments: m.attachments?.length ? m.attachments : null,
		via: m.via,
		client_id: m.client_id ?? null,
		sent_by:
			draft && !(draft.author_id === actor.id && draft.author_type === actor.type)
				? actor.name
				: null,
		notified_at: x.visitor_email ? null : at,
		created_at: at,
	};
	await db.batch([
		db.insert(cm).values(line).onConflictDoNothing(),
		db
			.update(c)
			.set({
				messages: sql`${c.messages} + 1`,
				last_message_at: sql`max(${c.last_message_at}, ${at})`,
				last_reply_at: at,
				first_reply_at: sql`coalesce(${c.first_reply_at}, ${at})`,
				replied_by: actor.type,
				updated_at: at,
			})
			.where(eq(c.id, x.id)),
		...(draft
			? [
					db
						.delete(schema.conversationReplies)
						.where(eq(schema.conversationReplies.id, draft.id)),
				]
			: []),
	] as never);
	if (actor.reader) {
		const r = schema.conversationReads;
		await db
			.insert(r)
			.values({ conversation_id: x.id, reader: actor.reader, read_at: at })
			.onConflictDoUpdate({ target: [r.conversation_id, r.reader], set: { read_at: at } });
	}
	const { slaReplied } = await import("./inbox-workflow");
	await slaReplied(x as never, now);
	const links = await linkKey(line, now);
	await pushToRoom(
		x.id,
		{ type: "message", message: visitorView(line, links) },
		{ type: "message", message: teamView(line, links) },
	);
	await pushToRoom(x.id, { type: "typing", role: "team", on: false });
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "reply.sent",
		detail: {
			reply_id: line.id,
			channel: "chat",
			via: m.via,
			...(draft && draft.author_type === "agent" && actor.type !== "agent"
				? { approved_draft_of: draft.author_name }
				: {}),
		},
		now,
	});
	const { inboxEvent } = await import("./conversations");
	await inboxEvent(
		x,
		"inbox.reply.sent",
		{
			reply_id: line.id,
			channel: "chat",
			sent_by: { type: actor.type, id: actor.id, name: actor.name },
		},
		now,
	);
	return line;
}

/** The reply in the shape conversations' sendReply answers with. */
export const lineAsReply = (line: ChatLine, x: Conversation) => ({
	object: "reply",
	id: line.id,
	conversation_id: x.id,
	inbox_id: x.inbox_id,
	status: "sent",
	channel: "chat",
	from: null,
	to: x.visitor_email ? [x.visitor_email] : [],
	cc: [],
	subject: x.subject,
	text: line.text,
	html: null,
	author: { type: line.author, id: line.author_id, name: line.author_name },
	sent_by: line.sent_by,
	email_id: null,
	sent_at: line.created_at,
	created_at: line.created_at,
	updated_at: line.created_at,
});

/** Closing or reopening a chat: the widget shows it. */
export async function chatStatusChanged(x: Pick<Conversation, "id" | "channel">, status: string) {
	if (x.channel === "chat") await pushToRoom(x.id, { type: "conversation", status });
}

// ── Email ──────────────────────────────────────────────────────────────────

/** <local>+<tag>@<host>, for an inbox at local@host or slug+local@INBOUND_DOMAIN. */
export function taggedAddress(inboxAddress: string, tag: string) {
	const at = inboxAddress.lastIndexOf("@");
	return `${inboxAddress.slice(0, at)}+${tag}@${inboxAddress.slice(at + 1)}`;
}

const TAG_RE = /\+(chatv?)-([a-z0-9]{12})@/;

/** Of a received email's recipients, the chat tag it was sent to. */
export function chatTagOf(recipients: string[]) {
	for (const r of recipients) {
		const m = TAG_RE.exec(lowerBare(r));
		if (m?.[1] && m[2]) return { team: m[1] === "chat", key: m[2] };
	}
	return null;
}

const MARKER = "Write your reply above this line";

/**
 * What a reply by email says, without what it quotes: cut at our marker, at "On … wrote:" (and
 * its Spanish, Portuguese, French and German forms, as Gmail wraps them), at Outlook's headers,
 * and at a signature.
 */
export function replyText(raw: string | null | undefined) {
	if (!raw) return "";
	const lines = raw.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	const quoteHead =
		/^(On\b.+\bwrote:?|El\b.+\bescribi[oó]:?|Em\b.+\bescreveu:?|Le\b.+\ba écrit\s*:?|Am\b.+\bschrieb.*:?)\s*$/i;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const t = line.trim();
		if (t.includes(MARKER)) break;
		if (quoteHead.test(t)) break;
		// Gmail breaks a long "On …, Name <a@b.c> wrote:" over two lines.
		const next = (lines[i + 1] ?? "").trim();
		if (/^(On|El|Em|Le|Am)\b/i.test(t) && t.length > 10 && quoteHead.test(`${t} ${next}`))
			break;
		if (
			/^-{2,}\s*(Original Message|Mensaje original|Message d'origine|Ursprüngliche Nachricht)\s*-{2,}$/i.test(
				t,
			)
		)
			break;
		if (/^_{10,}$/.test(t)) break;
		if (
			/^(From|De|Von):\s/i.test(t) &&
			lines
				.slice(i + 1, i + 5)
				.some((x) => /^(Sent|Date|Enviado|Fecha|Gesendet|To|Para):\s/i.test(x.trim()))
		)
			break;
		if (line === "-- " || t === "--") break;
		out.push(line);
	}
	while (out.length && /^\s*>/.test(out[out.length - 1] ?? "")) out.pop();
	let text = out.filter((l) => !/^\s*>/.test(l)).join("\n");
	text = text
		.replace(
			/\n*(Sent from my (iPhone|iPad|Android|phone)|Enviado desde mi (iPhone|iPad|Android|teléfono)|Get Outlook for (iOS|Android))\s*$/i,
			"",
		)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text.slice(0, CHAT_LIMITS.text);
}

/** An HTML part as text, for replies without a plain-text part. */
function htmlText(html: string) {
	return html
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
		.replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
		.replace(/<div class="gmail_quote[\s\S]*$/i, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

/** The organization's people (their emails and names): who may answer a chat by email. */
async function teamMembers(brandId: string) {
	const org = await orgOf(brandId);
	return db
		.select({ id: schema.user.id, email: schema.user.email, name: schema.user.name })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(eq(schema.member.organizationId, org));
}

export interface ChatEmail {
	brandId: string;
	inboxId: string | null;
	recipients: string[];
	from: string;
	sesId: string;
	dkim: string | null;
	dmarc: string | null;
	spf: string | null;
	parsed: {
		text?: string | null;
		html?: string | null;
		attachments?: {
			filename?: string | null;
			mimeType?: string;
			content: ArrayBuffer | string;
		}[];
	} | null;
	now?: number;
}

/**
 * A received email to a chat's address: the team's reply (from a notified address or a member,
 * DKIM or DMARC passing) or the visitor's (from their email). True when it became a chat line,
 * false when it's for the usual path (any other sender: kept as an email, never in the chat).
 */
export async function chatEmailIn(e: ChatEmail): Promise<boolean> {
	if (!e.inboxId) return false;
	const tag = chatTagOf(e.recipients);
	if (!tag) return false;
	const x = await db
		.select()
		.from(c)
		.where(
			and(
				eq(c.chat_key, tag.key),
				eq(c.inbox_id, e.inboxId),
				eq(c.organization_id, e.brandId),
			),
		)
		.get();
	if (!x || x.channel !== "chat") return false;
	const from = lowerBare(e.from);
	// DMARC passing is what ties the From address to the domain that signed or sent it; a DKIM or
	// SPF pass alone may be for any domain. The team posts as the team, so only an aligned pass will
	// do; a visitor whose domain publishes no DMARC policy still gets a DKIM or SPF pass, but never
	// past a DMARC failure.
	const authentic = e.dmarc === "PASS";
	const visitorAuthentic =
		authentic || (e.dmarc !== "FAIL" && (e.dkim === "PASS" || e.spf === "PASS"));
	const now = e.now ?? Date.now();
	const content = e.parsed?.text?.trim() ? e.parsed.text : htmlText(e.parsed?.html ?? "");
	const text = replyText(content);
	const files: ChatAttachment[] = [];
	for (const a of (e.parsed?.attachments ?? []).slice(0, 5)) {
		const type = lower(a.mimeType ?? "");
		if (!FILE_TYPES[type]) continue;
		const bytes =
			typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
		if (bytes.byteLength > CHAT_LIMITS.fileBytes) continue;
		files.push(
			await storeChatFile(x, { filename: a.filename ?? "file", content_type: type, bytes }),
		);
	}
	const clientId = `ses:${e.sesId}`;
	if (tag.team) {
		const widget = await getChatWidget(e.inboxId);
		const members = await teamMembers(x.organization_id);
		const member = members.find((m) => lower(m.email) === from);
		const allowed = (widget?.notify ?? []).includes(from) || !!member;
		if (!allowed || !authentic) return false;
		if (!text && !files.length) return true;
		const name = member?.name || bareName(e.from) || from;
		await teamSays(
			{
				type: "person",
				id: member?.id ?? null,
				name,
				organizationId: x.organization_id,
				permissions: new Set(["read", "send"]),
				reader: member ? `user:${member.id}` : null,
			},
			x,
			{ text, via: "email", attachments: files, client_id: clientId },
			now,
		);
		return true;
	}
	if (!x.visitor_email || from !== x.visitor_email) return false;
	if (!visitorAuthentic) return false;
	if (!text && !files.length) return true;
	const inbox = await db
		.select()
		.from(schema.inboxes)
		.where(eq(schema.inboxes.id, e.inboxId))
		.get();
	if (!inbox) return false;
	await postVisitorLine(
		{ conversation: x, inbox },
		{ text, client_id: clientId, via: "email", attachments: files },
		{ now },
	);
	return true;
}

/** «Ana López <ana@…>» → «Ana López». */
const bareName = (from: string) => /^"?(.+?)"?\s*<[^>]+>$/.exec(from.trim())?.[1] ?? null;

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The inbox's address its emails go from (a sending domain's), or null. */
const fromOf = (inbox: Inbox) => inbox.reply_from ?? (inbox.domain_id ? inbox.address : null);

const hostOfUrl = (u: string | null) => {
	if (!u) return null;
	try {
		return new URL(u).hostname;
	} catch {
		return null;
	}
};

const timeOf = (at: string) =>
	new Date(at).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
		timeZone: cfg().TIMEZONE || "UTC",
	});

function emailLayout(o: {
	heading: string;
	intro: string;
	lines: { who: string; text: string; at: string; files: number }[];
	button?: { label: string; url: string } | null;
	footer: string;
	marker: boolean;
}) {
	const rows = o.lines
		.map(
			(l) => `<tr><td style="padding:10px 0;border-top:1px solid #eceef1">
<div style="font-size:12px;color:#6b7280;margin-bottom:4px"><strong style="color:#111827">${escapeHtml(l.who)}</strong> · ${escapeHtml(timeOf(l.at))}</div>
<div style="font-size:15px;line-height:1.5;color:#111827;white-space:pre-wrap">${escapeHtml(l.text || (l.files ? `Sent ${l.files === 1 ? "a file" : `${l.files} files`}` : ""))}${l.text && l.files ? `<div style="font-size:12px;color:#6b7280;margin-top:4px">+ ${l.files === 1 ? "1 file" : `${l.files} files`}</div>` : ""}</div>
</td></tr>`,
		)
		.join("");
	const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9">
${o.marker ? `<div style="color:#9ca3af;font-size:12px;padding:12px 24px 0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">##- ${MARKER} -##</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:16px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
<tr><td style="font-size:18px;font-weight:600;color:#111827;padding-bottom:4px">${escapeHtml(o.heading)}</td></tr>
<tr><td style="font-size:14px;color:#6b7280;padding-bottom:12px">${escapeHtml(o.intro)}</td></tr>
${rows}
${o.button ? `<tr><td style="padding-top:18px"><a href="${escapeHtml(o.button.url)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 16px;border-radius:8px">${escapeHtml(o.button.label)}</a></td></tr>` : ""}
<tr><td style="font-size:12px;color:#9ca3af;padding-top:18px">${escapeHtml(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
	const text = `${o.marker ? `##- ${MARKER} -##\n\n` : ""}${o.heading}\n${o.intro}\n\n${o.lines
		.map(
			(l) =>
				`${l.who} (${timeOf(l.at)}):\n${l.text || `[${l.files} file${l.files === 1 ? "" : "s"}]`}`,
		)
		.join("\n\n")}\n\n${o.button ? `${o.button.label}: ${o.button.url}\n\n` : ""}${o.footer}\n`;
	return { html, text };
}

export interface ChatSender {
	send: (brandId: string, input: Record<string, unknown>) => Promise<string>;
}

const defaultSender = async (): Promise<ChatSender> => {
	const { sender } = await import("./inbox-api");
	return sender({ source: "system" });
};

/** A stable id every email about one chat refers to, so mailboxes thread them as one. */
const threadRef = (x: Pick<Conversation, "id">, who: "team" | "visitor") =>
	`<chat-${who}.${x.id}@${hostOfUrl(baseUrl()) ?? "mailroom"}>`;

/**
 * Cron (every minute): the team's email about visitors' new lines, a minute's lines at once.
 * Not sent when someone of the team already read them in the dashboard.
 */
export async function notifyTeam(now = Date.now(), sender?: ChatSender) {
	const pending = await db
		.select()
		.from(cm)
		.where(
			and(
				isNull(cm.notified_at),
				eq(cm.author, "visitor"),
				lte(cm.created_at, iso(now - 30_000)),
			),
		)
		.orderBy(asc(cm.created_at))
		.limit(300);
	if (!pending.length) return 0;
	const byChat = new Map<string, ChatLine[]>();
	for (const l of pending)
		byChat.set(l.conversation_id, [...(byChat.get(l.conversation_id) ?? []), l]);
	let sent = 0;
	const send = sender ?? (await defaultSender());
	for (const [id, lines] of byChat) {
		const done = () =>
			db
				.update(cm)
				.set({ notified_at: iso(now) })
				.where(
					inArray(
						cm.id,
						lines.map((l) => l.id),
					),
				);
		const x = await db.select().from(c).where(eq(c.id, id)).get();
		const inbox = x?.inbox_id
			? await db.select().from(schema.inboxes).where(eq(schema.inboxes.id, x.inbox_id)).get()
			: null;
		const widget = inbox ? await getChatWidget(inbox.id) : null;
		if (!x || !inbox || !widget?.notify.length || !widget.email_team) {
			await done();
			continue;
		}
		// Each chat's own wait (a minute by default: the cron's minute plus half of one).
		const wait = Math.max(30_000, widget.email_team_after * 60_000 - 30_000);
		if ((lines[0]?.created_at ?? "") > iso(now - wait)) continue;
		const newest = lines.at(-1)?.created_at ?? "";
		const read = await db
			.select({ n: sql<number>`count(*)` })
			.from(schema.conversationReads)
			.where(
				and(
					eq(schema.conversationReads.conversation_id, id),
					sql`${schema.conversationReads.reader} LIKE 'user:%'`,
					gte(schema.conversationReads.read_at, newest),
				),
			)
			.get();
		if ((read?.n ?? 0) > 0) {
			await done();
			continue;
		}
		const who = x.visitor_name || x.visitor_email || "Visitor";
		const site = hostOfUrl(x.page_url);
		const url = `${baseUrl()}/received/${x.id}`;
		const from = fromOf(inbox);
		const first =
			(
				await db
					.select({ n: sql<number>`count(*)` })
					.from(cm)
					.where(
						and(
							eq(cm.conversation_id, id),
							lt(cm.created_at, lines[0]?.created_at ?? ""),
						),
					)
					.get()
			)?.n === 0;
		const { html, text } = emailLayout({
			heading: first ? `New chat from ${who}` : `${who} wrote in the chat`,
			intro: [
				site ? `On ${site}` : null,
				x.visitor_email && x.visitor_name ? x.visitor_email : null,
				from ? "Reply to this email to answer in the chat." : null,
			]
				.filter(Boolean)
				.join(" · "),
			lines: lines.map((l) => ({
				who,
				text: l.text,
				at: l.created_at,
				files: l.attachments?.length ?? 0,
			})),
			button: { label: "Open the chat", url },
			footer: `You get these as ${inbox.name}'s chat is set to notify you. Mailroom`,
			marker: !!from,
		});
		const subject = `Chat with ${who}${site ? ` on ${site}` : ""}`;
		try {
			if (from) {
				await send.send(x.organization_id, {
					from: `${who} via chat <${bareAddress(from)}>`,
					to: widget.notify,
					reply_to: [taggedAddress(inbox.address, `chat-${x.chat_key}`)],
					subject,
					text,
					html,
					headers: {
						References: threadRef(x, "team"),
						"In-Reply-To": threadRef(x, "team"),
					},
					tags: [
						{ name: "conversation", value: x.id },
						{ name: "chat", value: "team" },
					],
				});
			} else {
				const { sendSystemEmail } = await import("./system-email");
				for (const to of widget.notify) await sendSystemEmail({ to, subject, text, html });
			}
			await done();
			sent++;
		} catch (error) {
			console.error("chat: team not notified", id, error);
			// Kept for the next minute, for an hour; then let go.
			if (Date.parse(lines[0]?.created_at ?? "") < now - 3_600_000) await done();
		}
	}
	return sent;
}

/** The soonest a visitor's unseen lines can go by email; each chat sets its own wait
 * (email_visitor_after, 3 minutes by default). */
const VISITOR_AWAY_MS = 60_000;

/** Cron (every minute): the team's lines a visitor who left hasn't seen, to their email. */
export async function emailVisitors(now = Date.now(), sender?: ChatSender) {
	const pending = await db
		.select()
		.from(cm)
		.where(
			and(
				isNull(cm.notified_at),
				ne(cm.author, "visitor"),
				lte(cm.created_at, iso(now - VISITOR_AWAY_MS)),
			),
		)
		.orderBy(asc(cm.created_at))
		.limit(300);
	if (!pending.length) return 0;
	const byChat = new Map<string, ChatLine[]>();
	for (const l of pending)
		byChat.set(l.conversation_id, [...(byChat.get(l.conversation_id) ?? []), l]);
	let sent = 0;
	const send = sender ?? (await defaultSender());
	for (const [id, waiting] of byChat) {
		const mark = (ids: string[]) =>
			ids.length
				? db
						.update(cm)
						.set({ notified_at: iso(now) })
						.where(inArray(cm.id, ids))
				: Promise.resolve();
		const x = await db.select().from(c).where(eq(c.id, id)).get();
		const inbox = x?.inbox_id
			? await db.select().from(schema.inboxes).where(eq(schema.inboxes.id, x.inbox_id)).get()
			: null;
		const settings = inbox ? await getChatWidget(inbox.id) : null;
		// Turned off: these lines are never emailed.
		if (settings && !settings.email_visitor) {
			await mark(waiting.map((l) => l.id));
			continue;
		}
		const wait = (settings?.email_visitor_after ?? 3) * 60_000;
		const all = waiting.filter((l) => l.created_at <= iso(now - wait));
		if (!all.length) continue;
		const from = inbox ? fromOf(inbox) : null;
		// Seen in the widget since: nothing to email.
		const lines = all.filter((l) => !x?.visitor_seen_at || x.visitor_seen_at < l.created_at);
		if (
			!x ||
			!inbox ||
			!from ||
			!x.visitor_email ||
			!lines.length ||
			Date.parse(lines[0]?.created_at ?? "") < now - 2 * 86_400_000
		) {
			await mark(all.map((l) => l.id));
			continue;
		}
		try {
			checkSendLists(inbox, [x.visitor_email]);
		} catch {
			await mark(all.map((l) => l.id));
			continue;
		}
		const brand = await db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, x.organization_id))
			.get();
		const widget = await getChatWidget(inbox.id);
		const title = (widget ? designOf(widget).title : null) || brand?.name || inbox.name;
		const page = x.page_url ? `${x.page_url.split("#")[0]}#mailroom-chat` : null;
		const { html, text } = emailLayout({
			heading: `New reply from ${title}`,
			intro: "You can reply to this email, or continue in the chat.",
			lines: lines.map((l) => ({
				who:
					l.author === "agent"
						? (l.author_name ?? title)
						: (firstName(l.author_name) ?? title),
				text: l.text,
				at: l.created_at,
				files: l.attachments?.length ?? 0,
			})),
			button: page ? { label: "Continue the chat", url: page } : null,
			footer: `You wrote to ${title} in the chat on ${hostOfUrl(x.page_url) ?? "their website"}.`,
			marker: true,
		});
		try {
			await send.send(x.organization_id, {
				from: `${title} <${bareAddress(from)}>`,
				to: [x.visitor_email],
				reply_to: [taggedAddress(inbox.address, `chatv-${x.chat_key}`)],
				subject: `Your chat with ${title}`,
				text,
				html,
				headers: {
					References: threadRef(x, "visitor"),
					"In-Reply-To": threadRef(x, "visitor"),
				},
				tags: [
					{ name: "conversation", value: x.id },
					{ name: "chat", value: "visitor" },
				],
			});
			sent++;
		} catch (error) {
			console.error("chat: visitor not emailed", id, error);
		}
		await mark(all.map((l) => l.id));
	}
	return sent;
}

// ── Retention ──────────────────────────────────────────────────────────────

/** Deletes chats' files from R2 (before their conversations go). */
/** The settings page's numbers: chats in the last 30 days, open now, and today's. */
export async function chatStats(inboxId: string, now = Date.now()) {
	const month = iso(now - 30 * 86_400_000);
	const day = iso(now - 86_400_000);
	const row = await db
		.select({
			month: sql<number>`sum(case when ${c.created_at} >= ${month} then 1 else 0 end)`,
			open: sql<number>`sum(case when ${c.status} = 'open' then 1 else 0 end)`,
			today: sql<number>`sum(case when ${c.created_at} >= ${day} then 1 else 0 end)`,
		})
		.from(c)
		.where(and(eq(c.inbox_id, inboxId), eq(c.channel, "chat")))
		.get();
	return { month: row?.month ?? 0, open: row?.open ?? 0, today: row?.today ?? 0 };
}

export async function deleteChatFiles(conversationIds: string[]) {
	if (!conversationIds.length) return;
	const store = bucket();
	const rows = await db
		.select({ attachments: cm.attachments })
		.from(cm)
		.where(
			and(inArray(cm.conversation_id, conversationIds), sql`${cm.attachments} IS NOT NULL`),
		);
	const keys = rows.flatMap((r) => (r.attachments ?? []).map((a) => a.key));
	for (let i = 0; i < keys.length; i += 500) await store?.delete(keys.slice(i, i + 500));
}

/** A conversation deleted now ("Delete now" in the dashboard): its files, lines and all. */
export async function deleteConversationNow(actor: InboxActor, id: string) {
	need(actor, "triage");
	const { conversationFor } = await import("./conversations");
	const { c: x } = await conversationFor(actor, id);
	const received = await db
		.select({ key: schema.receivedEmails.object_key })
		.from(schema.receivedEmails)
		.where(eq(schema.receivedEmails.conversation_id, id));
	await deleteChatFiles([id]);
	if (received.length) await bucket()?.delete(received.map((r) => r.key));
	await pushToRoom(id, { type: "deleted" });
	await db.batch([
		db.delete(schema.receivedEmails).where(eq(schema.receivedEmails.conversation_id, id)),
		db.delete(c).where(eq(c.id, id)),
	]);
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		action: "conversation.deleted",
		detail: { conversation_id: id, subject: x.subject },
	});
}
