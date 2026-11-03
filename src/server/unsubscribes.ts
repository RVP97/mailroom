import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { bareAddress } from "./aws/mime";
import { unsubscribeSync } from "./contacts";
import { db, schema } from "./db";
import { validation } from "./errors";
import { publicUrl } from "./public-host";
import { inScope, type Scope } from "./queries";
import { iso } from "./time";
import { emitEvent } from "./webhooks";

/**
 * Unsubscribe groups: an app sends an email with `unsubscribe_group` (one of its customers, a
 * newsletter…) and Mailroom adds a one-click unsubscribe link to it: the List-Unsubscribe and
 * List-Unsubscribe-Post headers (RFC 8058, Gmail's and Outlook's button) and a line at the
 * bottom. Whoever uses it leaves that group only: the organization's emails in the group skip
 * them, its other emails still reach them, and its webhooks hear `email.unsubscribed`. Unlike a
 * suppression (a dead mailbox, a spam report: the whole organization), it's scoped.
 *
 * The link is `/unsubscribe?t=<email id>.<address>.<signature>`, an HMAC-SHA256 with
 * BETTER_AUTH_SECRET: nobody can unsubscribe someone else by making one up.
 */

export const GROUP = /^[A-Za-z0-9_.:-]{1,128}$/;

/** In html or text, replaced with the reader's link (Resend's names work too). */
export const PLACEHOLDERS = [
	"{{{MAILROOM_UNSUBSCRIBE_URL}}}",
	"{{{RESEND_UNSUBSCRIBE_URL}}}",
	"{{{UNSUBSCRIBE_URL}}}",
];

const b64url = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

function fromB64url(s: string): Uint8Array | null {
	try {
		return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
			c.charCodeAt(0),
		);
	} catch {
		return null;
	}
}

async function signature(emailId: string, address: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(
			`unsubscribe:${(env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? ""}`,
		),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`unsubscribe:${emailId}:${address}`),
	);
	return new Uint8Array(mac).slice(0, 16);
}

export async function unsubscribeToken(emailId: string, address: string) {
	const a = bareAddress(address).toLowerCase();
	return `${emailId}.${b64url(new TextEncoder().encode(a))}.${b64url(await signature(emailId, a))}`;
}

export async function unsubscribeUrl(emailId: string, address: string) {
	return `${publicUrl()}/unsubscribe?t=${await unsubscribeToken(emailId, address)}`;
}

/** The email and address a token names (and the email's organization and group), or null. */
export async function readUnsubscribeToken(token: string) {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const [emailId, encoded, sig] = parts as [string, string, string];
	if (!/^[0-9a-f-]{36}$/.test(emailId)) return null;
	const bytes = fromB64url(encoded);
	const given = fromB64url(sig);
	if (!bytes || !given || given.length !== 16) return null;
	const address = new TextDecoder().decode(bytes);
	if (!/^[^\s@]+@[^\s@]+$/.test(address)) return null;
	const expected = await signature(emailId, address);
	let diff = 0;
	for (let i = 0; i < 16; i++) diff |= (expected[i] as number) ^ (given[i] as number);
	if (diff !== 0) return null;
	const e = schema.emails;
	const row = await db
		.select({ organization_id: e.organization_id, group: e.unsubscribe_group, from: e.from })
		.from(e)
		.where(eq(e.id, emailId))
		.get();
	if (!row?.group) return null;
	return {
		emailId,
		address,
		organizationId: row.organization_id,
		group: row.group,
		from: row.from,
	};
}

const u = schema.unsubscribes;

/** Of these addresses (lowercase), those that left the group. */
export async function unsubscribedAmong(
	organizationId: string,
	group: string,
	addresses: string[],
): Promise<Set<string>> {
	const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
	const out = new Set<string>();
	// D1 takes up to 100 parameters a statement.
	for (let i = 0; i < list.length; i += 90) {
		const rows = await db
			.select({ address: u.address })
			.from(u)
			.where(
				and(
					eq(u.organization_id, organizationId),
					eq(u.group, group),
					inArray(u.address, list.slice(i, i + 90)),
				),
			);
		for (const r of rows) out.add(r.address);
	}
	return out;
}

/** Leaves the group; the first time, the organization's webhooks hear `email.unsubscribed`. */
export async function unsubscribe(
	ref: { organizationId: string; group: string; address: string; emailId: string },
	now = Date.now(),
) {
	const [row] = await db
		.insert(u)
		.values({
			organization_id: ref.organizationId,
			group: ref.group,
			address: ref.address,
			email_id: ref.emailId,
			created_at: iso(now),
		})
		.onConflictDoNothing()
		.returning({ address: u.address });
	await unsubscribeSync(ref.organizationId, ref.group, ref.address, true);
	if (row) {
		// On the email's timeline too.
		await db
			.insert(schema.emailEvents)
			.values({
				id: `unsubscribe:${ref.emailId}:${ref.address}`,
				email_id: ref.emailId,
				organization_id: ref.organizationId,
				type: "email.unsubscribed",
				at: iso(now),
				recipient: ref.address,
				data: { group: ref.group },
			})
			.onConflictDoNothing();
		await emitEvent(
			ref.organizationId,
			"email.unsubscribed",
			ref.emailId,
			{ unsubscribed: { email: ref.address, group: ref.group } },
			now,
		);
	}
	return !!row;
}

/** One the app heard of itself (no email behind it): no webhook, the app already knows. */
export async function addUnsubscribe(organizationId: string, group: string, address: string) {
	const a = address.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw validation("Enter an email address");
	await db
		.insert(u)
		.values({
			organization_id: organizationId,
			group: checkGroup(group),
			address: a,
			created_at: iso(),
		})
		.onConflictDoNothing();
	await unsubscribeSync(organizationId, group, a, true);
}

/** Back in the group: the person from their link, or the organization when they ask it. */
export async function resubscribe(organizationId: string, group: string, address: string) {
	const r = await db
		.delete(u)
		.where(
			and(
				eq(u.organization_id, organizationId),
				eq(u.group, group),
				eq(u.address, address.trim().toLowerCase()),
			),
		)
		.returning({ address: u.address });
	await unsubscribeSync(organizationId, group, address.trim().toLowerCase(), false);
	return r.length > 0;
}

export async function isUnsubscribed(organizationId: string, group: string, address: string) {
	return (await unsubscribedAmong(organizationId, group, [address])).has(address.toLowerCase());
}

export async function listUnsubscribes(
	scope: Scope,
	o: { group?: string | null; search?: string | null; limit?: number; offset?: number } = {},
) {
	const q = o.search?.trim().toLowerCase();
	const limit = o.limit ?? 100;
	const rows = await db
		.select()
		.from(u)
		.where(
			and(
				inScope(u.organization_id, scope),
				o.group ? eq(u.group, o.group) : undefined,
				q ? like(u.address, `%${q.replace(/[%_]/g, "")}%`) : undefined,
			),
		)
		.orderBy(desc(u.created_at))
		.limit(limit + 1)
		.offset(o.offset ?? 0);
	return { data: rows.slice(0, limit), has_more: rows.length > limit };
}

/** The organization's groups that someone left, with how many left each, the largest first. */
export async function unsubscribeGroups(scope: Scope) {
	const rows = await db
		.select({ group: u.group, n: sql<number>`count(*)` })
		.from(u)
		.where(inScope(u.organization_id, scope))
		.groupBy(u.group)
		.orderBy(sql`count(*) desc`)
		.limit(200);
	return rows.map((r) => ({ group: r.group, count: Number(r.n) }));
}

export function checkGroup(group: string) {
	if (!GROUP.test(group))
		throw validation(
			"unsubscribe_group takes 1 to 128 letters, numbers, _ . : and - (an id of yours)",
		);
	return group;
}

interface Content {
	html?: string;
	text?: string;
	headers?: Record<string, string>;
}

/**
 * The email as its reader gets it: the link in place of a placeholder, else a line at the bottom
 * (in Spanish when the HTML says lang="es"), and the one-click headers unless the app set its own.
 */
export async function withUnsubscribe<T extends Content>(
	content: T,
	emailId: string,
	address: string,
): Promise<T> {
	const url = await unsubscribeUrl(emailId, address);
	const es = /<html[^>]*\blang="es/i.test(content.html ?? "");
	const word = es ? "Darse de baja" : "Unsubscribe";
	const fill = (s: string) => PLACEHOLDERS.reduce((acc, p) => acc.split(p).join(url), s);
	let html = content.html;
	if (html !== undefined) {
		const placed = PLACEHOLDERS.some((p) => html?.includes(p));
		const line = `<p style="margin:16px 0 0;font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#8a8f98;text-align:center"><a href="${url}" style="color:#8a8f98">${word}</a></p>`;
		html = placed
			? fill(html)
			: html.includes("</body>")
				? html.replace("</body>", `${line}</body>`)
				: `${html}${line}`;
	}
	let text = content.text;
	if (text !== undefined)
		text = PLACEHOLDERS.some((p) => text?.includes(p))
			? fill(text)
			: `${text}\n\n${word}: ${url}`;
	const has = Object.keys(content.headers ?? {}).some(
		(k) => k.toLowerCase() === "list-unsubscribe",
	);
	return {
		...content,
		html,
		text,
		headers: has
			? content.headers
			: {
					...content.headers,
					"List-Unsubscribe": `<${url}>`,
					"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
				},
	};
}

// ── The page behind the link ──

const WORDS = {
	en: {
		title: "Unsubscribe",
		ask: (n: string) => `Stop getting these emails from ${n}?`,
		who: (a: string) => `${a} won't get this sender's emails of this kind any more.`,
		out: "Unsubscribe",
		done: (n: string) => `Done: you won't get these emails from ${n} any more.`,
		back: "Subscribe again",
		backDone: (n: string) => `Done: you'll get these emails from ${n} again.`,
		invalid: "This link isn't valid. Use the unsubscribe link of a recent email.",
		someone: "this sender",
		prefs: "Or choose what you get",
		save: "Save preferences",
		saved: "Preferences saved.",
	},
	es: {
		title: "Darse de baja",
		ask: (n: string) => `¿Dejar de recibir estos correos de ${n}?`,
		who: (a: string) => `A ${a} ya no le llegarán estos correos de este remitente.`,
		out: "Darme de baja",
		done: (n: string) => `Listo: ya no recibirá estos correos de ${n}.`,
		back: "Volver a recibirlos",
		backDone: (n: string) => `Listo: volverá a recibir estos correos de ${n}.`,
		invalid:
			"Este enlace no es válido. Use el enlace para darse de baja de un correo reciente.",
		someone: "este remitente",
		prefs: "O elija qué recibir",
		save: "Guardar preferencias",
		saved: "Preferencias guardadas.",
	},
};

const esc = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
	);

function page(lang: "en" | "es", body: string, status = 200) {
	return new Response(
		`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${WORDS[lang].title}</title><style>:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--ink:#14161a;--mut:#5f6672;--line:#e3e6ea;--btn:#14161a;--btnInk:#fff}@media (prefers-color-scheme:dark){:root{--bg:#0d0f12;--card:#16191e;--ink:#eceef1;--mut:#9aa1ac;--line:#262a31;--btn:#eceef1;--btnInk:#14161a}}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}main{max-width:30rem;margin:12vh auto 2rem;padding:28px 32px;background:var(--card);border:1px solid var(--line);border-radius:14px}@media (max-width:520px){main{margin:16px;padding:24px 20px}}h1{margin:0 0 8px;font-size:20px;font-weight:600;line-height:1.3;text-wrap:balance}p{margin:0 0 16px;color:var(--mut)}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:8px;border:1px solid var(--btn);background:var(--btn);color:var(--btnInk);cursor:pointer}button.quiet{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500}form{margin:0}section{margin-top:24px;padding-top:20px;border-top:1px solid var(--line)}h2{margin:0 0 12px;font-size:15px;font-weight:600}label.topic{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;cursor:pointer}label.topic input{margin-top:5px;width:16px;height:16px;flex:none}label.topic small{display:block;color:var(--mut);font-size:13px}.ok{color:var(--ink);font-weight:500}</style></head><body><main>${body}</main></body></html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-robots-tag": "noindex",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
			},
		},
	);
}

/** The sender's name from its From ("Acme" <hola@…> → Acme). */
const senderName = (from: string) =>
	/^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim() || bareAddress(from);

/** The brand's public topics with this contact's choices (none: they aren't a contact). */
async function preferencesOf(ref: { organizationId: string; address: string }) {
	const { getContact, topicsOfContact } = await import("./contacts");
	const contact = await getContact(ref.organizationId, ref.address).catch(() => null);
	if (!contact) return null;
	const topics = (await topicsOfContact(ref.organizationId, contact.id)).filter(
		(t) => t.visibility === "public",
	);
	return topics.length ? { contact, topics } : null;
}

async function preferencesForm(
	ref: { organizationId: string; address: string },
	t: string,
	w: (typeof WORDS)["en"],
	saved = false,
) {
	const prefs = await preferencesOf(ref);
	if (!prefs) return "";
	const boxes = prefs.topics
		.map(
			(x) =>
				`<label class="topic"><input type="checkbox" name="topic" value="${esc(x.id)}"${x.subscription === "opt_in" ? " checked" : ""}><span>${esc(x.name)}${x.description ? `<small>${esc(x.description)}</small>` : ""}</span></label>`,
		)
		.join("");
	return `<section><h2>${w.prefs}</h2><form method="post" action="?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="action" value="preferences">${boxes}${saved ? `<p class="ok">${w.saved}</p>` : ""}<button type="submit" class="quiet">${w.save}</button></form></section>`;
}

/**
 * /unsubscribe: GET asks (mail scanners open links), POST unsubscribes (the page's button or a
 * mail client's one-click, body `List-Unsubscribe=One-Click`) or, with `action=resubscribe`,
 * brings them back.
 */
export async function handleUnsubscribePage(request: Request) {
	const url = new URL(request.url);
	const t = url.searchParams.get("t") ?? "";
	const lang: "en" | "es" = /^es\b/i.test(request.headers.get("accept-language") ?? "")
		? "es"
		: "en";
	const w = WORDS[lang];
	const ref = await readUnsubscribeToken(t);
	const form = (action: "unsubscribe" | "resubscribe", label: string, quiet = false) =>
		`<form method="post" action="?t=${esc(encodeURIComponent(t))}"><input type="hidden" name="action" value="${action}"><button type="submit"${quiet ? ' class="quiet"' : ""}>${label}</button></form>`;
	if (request.method === "POST") {
		const fields = await request.formData().catch(() => null);
		const oneClick = fields?.get("List-Unsubscribe") === "One-Click";
		if (!ref)
			return oneClick
				? new Response(null, { status: 404 })
				: page(lang, `<h1>${w.title}</h1><p>${w.invalid}</p>`, 404);
		const name = esc(senderName(ref.from) || w.someone);
		if (fields?.get("action") === "preferences") {
			const prefs = await preferencesOf(ref);
			if (prefs) {
				const picked = new Set(fields.getAll("topic").map(String));
				const { setTopics } = await import("./contacts");
				await setTopics(
					ref.organizationId,
					prefs.contact.id,
					prefs.topics.map((x) => ({
						id: x.id,
						subscription: picked.has(x.id) ? "opt_in" : "opt_out",
					})),
				);
			}
			const out = await isUnsubscribed(ref.organizationId, ref.group, ref.address);
			return page(
				lang,
				`<h1>${out ? w.done(name) : w.ask(name)}</h1>${out ? form("resubscribe", w.back, true) : form("unsubscribe", w.out)}${await preferencesForm(ref, t, w, true)}`,
			);
		}
		if (fields?.get("action") === "resubscribe") {
			await resubscribe(ref.organizationId, ref.group, ref.address);
			return page(
				lang,
				`<h1>${w.backDone(name)}</h1>${form("unsubscribe", w.out, true)}${await preferencesForm(ref, t, w)}`,
			);
		}
		await unsubscribe(ref);
		if (oneClick) return new Response(null, { status: 200 });
		return page(
			lang,
			`<h1>${w.done(name)}</h1>${form("resubscribe", w.back, true)}${await preferencesForm(ref, t, w)}`,
		);
	}
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", { status: 405 });
	if (!ref) return page(lang, `<h1>${w.title}</h1><p>${w.invalid}</p>`, 404);
	const name = esc(senderName(ref.from) || w.someone);
	const prefs = await preferencesForm(ref, t, w);
	return (await isUnsubscribed(ref.organizationId, ref.group, ref.address))
		? page(lang, `<h1>${w.done(name)}</h1>${form("resubscribe", w.back, true)}${prefs}`)
		: page(
				lang,
				`<h1>${w.ask(name)}</h1><p>${w.who(esc(ref.address))}</p>${form("unsubscribe", w.out)}${prefs}`,
			);
}
