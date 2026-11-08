import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
	type Block,
	DEFAULT_THEME,
	type EmailDoc,
	type LeafBlock,
	newId,
	parseDoc,
	renderEmail,
} from "../lib/email-doc";
import {
	emailThemeOf,
	fontsHref,
	type Look,
	lookCss,
	lookOf,
	PAGE_FONTS,
	PAGE_WORDS,
	type PageFont,
	shapeVars,
	wordOf,
} from "../lib/newsletter-look";
import { type FeedItem, parseFeed } from "../lib/rss";
import { esc, parseDesign } from "../lib/signup-form-render";
import { fill } from "../lib/template-fill";
import { bareAddress } from "./aws/mime";
import type { Broadcast } from "./broadcasts";
import type { Contact } from "./contacts";
import { db, schema } from "./db";
import type { NewsletterLook, PageWord, ReferralReward } from "./db/schema";
import { ApiError, notFound, validation } from "./errors";
import { domainFor, type OrgContext, orgContext } from "./org";
import { ownHostBase, publicUrl, shownHere } from "./public-host";
import { iso } from "./time";

/**
 * Newsletters: what lasts across a brand's issues. An issue is a broadcast with the newsletter's
 * id; once it's sent it's on the newsletter's public archive (/n/<slug>/<issue>), unless it was
 * kept off the web. The archive's front page lists the issues beside the newsletter's sign-up
 * form, and has its own RSS feed. Every broadcast also has a web version (/view/<id>, or its
 * archive page), which {{{WEB_VERSION_URL}}} links to. A newsletter can also turn its blog's new
 * posts into issues (RSS to email), and run the brand's referral program (src/server/referrals.ts).
 */

export type Newsletter = typeof schema.newsletters.$inferSelect;
const nl = schema.newsletters;
const b = schema.broadcasts;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Paths under /n/ that aren't newsletters. */
const RESERVED = new Set(["feed", "new", "admin", "api", "www"]);

export function slugify(s: string, max = 60) {
	const out = s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
	return out || "issue";
}

const imageUrl = z
	.string()
	.trim()
	.max(2000)
	.regex(/^(https?:\/\/|\/media\/)\S+$/, "an image's https:// address");
const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "a color like #1f6feb");

const lookInput = z.object({
	logo: z.union([z.literal("brand"), z.literal("none"), imageUrl]).nullish(),
	cover: imageUrl.nullish().or(z.literal("")),
	font: z.enum(Object.keys(PAGE_FONTS) as [PageFont, ...PageFont[]]).nullish(),
	heading_font: z.enum(Object.keys(PAGE_FONTS) as [PageFont, ...PageFont[]]).nullish(),
	theme: z.enum(["auto", "light", "dark"]).nullish(),
	background: hex.nullish(),
	layout: z.enum(["list", "cards"]).nullish(),
	align: z.enum(["center", "left"]).nullish(),
	form_position: z.enum(["top", "bottom"]).nullish(),
	links: z
		.array(
			z.object({
				label: z.string().trim().min(1).max(40),
				url: z
					.string()
					.trim()
					.max(2000)
					.regex(/^https?:\/\/\S+$/, "a link's http(s):// address"),
			}),
		)
		.max(6)
		.nullish(),
	logo_shape: z.enum(["original", "rounded", "circle"]).nullish(),
	logo_size: z.enum(["small", "medium", "large"]).nullish(),
	corners: z.enum(["square", "soft", "round"]).nullish(),
	borders: z.boolean().nullish(),
	bar: z.enum(["glass", "solid", "none"]).nullish(),
	words: z
		.object(
			Object.fromEntries(
				PAGE_WORDS.map((k) => [k, z.string().trim().max(300).nullish()]),
			) as Record<PageWord, z.ZodOptional<z.ZodNullable<z.ZodString>>>,
		)
		.partial()
		.nullish(),
	show_count: z.boolean().nullish(),
	show_rss: z.boolean().nullish(),
});

const reward = z.object({
	count: z.number().int().min(1).max(10_000),
	reward: z.string().trim().min(1).max(200),
	template_id: z.string().max(100).nullish(),
});

export const newsletterInput = z.object({
	name: z.string().trim().min(1).max(200),
	slug: z
		.string()
		.trim()
		.toLowerCase()
		.regex(SLUG, "slug: lowercase letters, numbers and dashes")
		.optional(),
	description: z.string().trim().max(1000).nullish(),
	segment_id: z.string().max(100).nullish(),
	topic_id: z.string().max(100).nullish(),
	from: z.string().trim().max(320).nullish(),
	form_id: z.string().max(100).nullish(),
	public: z.boolean().optional(),
	accent: z
		.string()
		.regex(/^#[0-9a-f]{6}$/i)
		.nullish()
		.or(z.literal("")),
	rss_url: z
		.string()
		.trim()
		.max(2000)
		.regex(/^https?:\/\/\S+$/, "rss_url: an http(s):// address")
		.nullish()
		.or(z.literal("")),
	rss_mode: z.enum(["draft", "send"]).optional(),
	rss_style: z.enum(["full", "compact", "titles"]).optional(),
	rss_intro: z.string().trim().max(500).nullish(),
	referrals: z.boolean().optional(),
	referral_rewards: z.array(reward).max(20).nullish(),
	look: lookInput.nullish(),
});

export type RssStyle = "full" | "compact" | "titles";

export const newsletterUrl = (slug: string) => `${publicUrl()}/n/${slug}`;

/**
 * Its public address: on its From domain's own host when that's live (pass the brand's context
 * to know), else Mailroom's.
 */
function addressOf(x: Pick<Newsletter, "slug" | "from">, ctx?: OrgContext) {
	const d = ctx && x.from ? domainFor(ctx, bareAddress(x.from)) : null;
	const base = d ? ownHostBase(d) : null;
	return base ? `${base}/n/${x.slug}` : newsletterUrl(x.slug);
}

export const newsletterView = (x: Newsletter, ctx?: OrgContext) => ({
	object: "newsletter",
	id: x.id,
	brand_id: x.organization_id,
	name: x.name,
	slug: x.slug,
	url: addressOf(x, ctx),
	feed_url: `${addressOf(x, ctx)}/feed.xml`,
	description: x.description,
	segment_id: x.segment_id,
	topic_id: x.topic_id,
	from: x.from,
	form_id: x.form_id,
	public: x.public,
	accent: x.accent,
	rss_url: x.rss_url,
	rss_mode: x.rss_mode as "draft" | "send",
	rss_style: x.rss_style as RssStyle,
	rss_intro: x.rss_intro,
	look: lookOf(x.look),
	rss_checked_at: x.rss_checked_at,
	rss_error: x.rss_error,
	referrals: x.referrals,
	referral_rewards: (x.referral_rewards ?? []) as ReferralReward[],
	created_at: x.created_at,
	updated_at: x.updated_at,
});

export async function listNewsletters(brands: string[]) {
	if (!brands.length) return [];
	return db
		.select()
		.from(nl)
		.where(inArray(nl.organization_id, brands))
		.orderBy(asc(nl.created_at));
}

export async function getNewsletter(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(nl)
		.where(and(eq(nl.id, id), inArray(nl.organization_id, list)))
		.get();
	if (!row) throw notFound("Newsletter");
	return row;
}

async function checkRefs(brand: string, v: Partial<z.output<typeof newsletterInput>>) {
	const owned = async (
		table: typeof schema.segments | typeof schema.topics | typeof schema.signupForms,
		id: string,
	) =>
		!!(await db
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.id, id), eq(table.organization_id, brand)))
			.get());
	if (v.segment_id && !(await owned(schema.segments, v.segment_id)))
		throw validation("segment_id: no such segment in this brand");
	if (v.topic_id && !(await owned(schema.topics, v.topic_id)))
		throw validation("topic_id: no such topic in this brand");
	if (v.form_id && !(await owned(schema.signupForms, v.form_id)))
		throw validation("form_id: no such sign-up form in this brand");
	if (v.from) {
		const domain = bareAddress(v.from).toLowerCase().split("@")[1] ?? "";
		const ctx = await orgContext(brand);
		if (!ctx.domains.some((d) => d.name === domain))
			throw validation("from: an address on one of this brand's domains");
	}
	for (const r of v.referral_rewards ?? [])
		if (r.template_id) {
			const { orgOf } = await import("./brands");
			const { getTemplate } = await import("./templates");
			const t = await getTemplate(await orgOf(brand), r.template_id).catch(() => null);
			if (!t) throw validation(`referral_rewards: no template ${r.template_id}`);
		}
}

async function freeSlug(base: string, except?: string) {
	let slug = RESERVED.has(base) ? `${base}-news` : base;
	for (let i = 2; i < 50; i++) {
		const taken = await db.select({ id: nl.id }).from(nl).where(eq(nl.slug, slug)).get();
		if (!taken || taken.id === except) return slug;
		slug = `${base.slice(0, 56)}-${i}`;
	}
	return `${base.slice(0, 50)}-${crypto.randomUUID().slice(0, 6)}`;
}

const rewardsIn = (v: z.output<typeof newsletterInput>["referral_rewards"]) =>
	v
		? v
				.map((r) => ({ ...r, template_id: r.template_id || null }))
				.sort((x, y) => x.count - y.count)
		: null;

export async function createNewsletter(brand: string, raw: unknown, now = Date.now()) {
	const v = newsletterInput.parse(raw);
	await checkRefs(brand, v);
	if (v.slug) {
		const taken = await db.select({ id: nl.id }).from(nl).where(eq(nl.slug, v.slug)).get();
		if (taken || RESERVED.has(v.slug))
			throw new ApiError(409, "slug_taken", `/n/${v.slug} is taken; pick another slug`);
	}
	const [row] = await db
		.insert(nl)
		.values({
			id: `nl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: brand,
			name: v.name,
			slug: v.slug ?? (await freeSlug(slugify(v.name))),
			description: v.description || null,
			segment_id: v.segment_id || null,
			topic_id: v.topic_id || null,
			from: v.from || "",
			form_id: v.form_id || null,
			public: v.public ?? true,
			accent: v.accent || null,
			rss_url: v.rss_url || null,
			rss_mode: v.rss_mode ?? "draft",
			rss_style: v.rss_style ?? "full",
			rss_intro: v.rss_intro || null,
			look: v.look ?? null,
			referrals: v.referrals ?? false,
			referral_rewards: rewardsIn(v.referral_rewards),
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as Newsletter;
}

export async function updateNewsletter(brand: string, id: string, raw: unknown, now = Date.now()) {
	const x = await getNewsletter(brand, id);
	const v = newsletterInput.partial().parse(raw ?? {});
	await checkRefs(brand, v);
	if (v.slug && v.slug !== x.slug) {
		const taken = await db.select({ id: nl.id }).from(nl).where(eq(nl.slug, v.slug)).get();
		if ((taken && taken.id !== id) || RESERVED.has(v.slug))
			throw new ApiError(409, "slug_taken", `/n/${v.slug} is taken; pick another slug`);
	}
	const rssChanged = v.rss_url !== undefined && (v.rss_url || null) !== x.rss_url;
	const keep = <T>(next: T | undefined | null | "", was: T | null) =>
		next !== undefined ? (next === "" ? null : (next ?? null)) : was;
	const [row] = await db
		.update(nl)
		.set({
			name: v.name ?? x.name,
			slug: v.slug ?? x.slug,
			description: keep(v.description, x.description),
			segment_id: keep(v.segment_id, x.segment_id),
			topic_id: keep(v.topic_id, x.topic_id),
			from: v.from !== undefined ? v.from || "" : x.from,
			form_id: keep(v.form_id, x.form_id),
			public: v.public ?? x.public,
			accent: keep(v.accent, x.accent),
			rss_url: keep(v.rss_url, x.rss_url),
			rss_mode: v.rss_mode ?? x.rss_mode,
			rss_style: v.rss_style ?? x.rss_style,
			rss_intro: keep(v.rss_intro, x.rss_intro),
			look: v.look !== undefined ? (v.look ?? null) : x.look,
			// A new feed starts over: its posts so far are only noted, never sent.
			...(rssChanged ? { rss_seen: null, rss_checked_at: null, rss_error: null } : {}),
			referrals: v.referrals ?? x.referrals,
			referral_rewards:
				v.referral_rewards !== undefined
					? rewardsIn(v.referral_rewards)
					: x.referral_rewards,
			updated_at: iso(now),
		})
		.where(eq(nl.id, id))
		.returning();
	return row as Newsletter;
}

/** Its issues stay, as one-off broadcasts. */
export async function deleteNewsletter(brand: string, id: string) {
	const x = await getNewsletter(brand, id);
	await db.update(b).set({ newsletter_id: null }).where(eq(b.newsletter_id, id));
	await db.delete(nl).where(eq(nl.id, id));
	return x;
}

// ── Issues ───────────────────────────────────────────────────────────────────

const SENT = ["sending", "sent", "testing"] as const;

/** Its sent issues, newest first (only those on the web, for the public pages). */
export async function issuesOf(id: string, o: { web?: boolean; limit?: number } = {}) {
	return db
		.select()
		.from(b)
		.where(
			and(
				eq(b.newsletter_id, id),
				inArray(b.status, [...SENT]),
				isNotNull(b.started_at),
				o.web ? eq(b.web, true) : undefined,
			),
		)
		.orderBy(desc(b.started_at))
		.limit(o.limit ?? 100);
}

/** Its latest issue on the web (public newsletters only): its subject and address. */
export async function latestIssue(n: Newsletter) {
	if (!n.public) return null;
	const [x] = await issuesOf(n.id, { web: true, limit: 1 });
	if (!x) return null;
	return {
		title: subjectOf(x)
			.replace(/\{\{\{?[^}]*\}?\}\}/g, "")
			.replace(/\s+/g, " ")
			.trim(),
		url: webUrl(x, n),
		sent_at: x.started_at,
	};
}

/** Issue counts, for the dashboard's list. */
export async function issueCounts(ids: string[]) {
	if (!ids.length) return new Map<string, number>();
	const rows = await db
		.select({ id: b.newsletter_id, n: sql<number>`COUNT(*)` })
		.from(b)
		.where(and(inArray(b.newsletter_id, ids), inArray(b.status, [...SENT])))
		.groupBy(b.newsletter_id);
	return new Map(rows.map((r) => [r.id as string, Number(r.n)]));
}

/** Gives an issue its archive address (once, when it's first sent). */
export async function assignSlug(
	x: Pick<Broadcast, "id" | "newsletter_id" | "slug" | "subject" | "name">,
) {
	if (!x.newsletter_id || x.slug) return x.slug;
	const base = slugify(fill(x.subject || x.name, {}).replace(/\{\{\{[^}]*\}\}\}/g, ""));
	let slug = base;
	for (let i = 2; i < 100; i++) {
		const taken = await db
			.select({ id: b.id })
			.from(b)
			.where(and(eq(b.newsletter_id, x.newsletter_id), eq(b.slug, slug)))
			.get();
		if (!taken || taken.id === x.id) break;
		slug = `${base.slice(0, 54)}-${i}`;
	}
	await db.update(b).set({ slug }).where(eq(b.id, x.id));
	return slug;
}

/** The newsletter of an issue, cached for a Dispatcher run. */
const cache = new Map<string, { at: number; value: Newsletter | null }>();
async function newsletterOf(id: string | null) {
	if (!id) return null;
	const hit = cache.get(id);
	if (hit && hit.at > Date.now() - 30_000) return hit.value;
	const value = (await db.select().from(nl).where(eq(nl.id, id)).get()) ?? null;
	cache.set(id, { at: Date.now(), value });
	return value;
}

/** The web version's address: its archive page when it's an issue on the web, else /view/<id>. */
export function webUrl(
	x: Pick<Broadcast, "id" | "slug" | "web">,
	n: Pick<Newsletter, "slug" | "public"> | null,
) {
	return n?.public && x.web && x.slug
		? `${newsletterUrl(n.slug)}/${x.slug}`
		: `${publicUrl()}/view/${x.id}`;
}

/** The {{{…}}} tags Mailroom fills in broadcasts beyond the contact's own. */
export const BROADCAST_TAGS =
	/\{\{\{\s*(WEB_VERSION_URL|REFERRAL_URL|REFERRAL_PAGE_URL|REFERRAL_COUNT|POLL_URL)\b/;

/**
 * A broadcast email's own values for one contact: its web version, the contact's referral link and
 * count, and their poll link (signed, so nobody votes for someone else).
 */
export async function broadcastValues(x: Broadcast, contact: Contact | null, source: string) {
	if (!BROADCAST_TAGS.test(source)) return {};
	const n = await newsletterOf(x.newsletter_id);
	const out: Record<string, string | number> = { WEB_VERSION_URL: webUrl(x, n) };
	if (/REFERRAL_(URL|PAGE_URL|COUNT)/.test(source) && contact) {
		const { referralCode, referralPageUrl, referralUrl } = await import("./referrals");
		const code = await referralCode(contact);
		out.REFERRAL_URL = referralUrl(code);
		out.REFERRAL_PAGE_URL = await referralPageUrl(code);
		out.REFERRAL_COUNT = contact.referrals ?? 0;
	}
	if (/POLL_URL/.test(source) && contact) {
		const { pollBase } = await import("./polls");
		out.POLL_URL = await pollBase(x.id, contact.id);
	}
	return out;
}

/** The values a web version is filled with: no contact, so names read their fallbacks. */
async function webValues(x: Broadcast, n: Newsletter | null) {
	const props = await db
		.select()
		.from(schema.contactProperties)
		.where(eq(schema.contactProperties.organization_id, x.organization_id));
	const values: Record<string, string | number> = {
		FIRST_NAME: "",
		LAST_NAME: "",
		EMAIL: "",
		"contact.email": "",
		"contact.first_name": "",
		"contact.last_name": "",
		WEB_VERSION_URL: webUrl(x, n),
		REFERRAL_URL: n?.public ? newsletterUrl(n.slug) : "#",
		REFERRAL_PAGE_URL: n?.public ? newsletterUrl(n.slug) : "#",
		REFERRAL_COUNT: "",
		POLL_URL: `${publicUrl()}/poll/web/${x.id}`,
		UNSUBSCRIBE_URL: n?.public ? newsletterUrl(n.slug) : "#",
		MAILROOM_UNSUBSCRIBE_URL: "#",
		RESEND_UNSUBSCRIBE_URL: "#",
	};
	for (const p of props) values[`contact.${p.key}`] = p.fallback_value ?? "";
	return values;
}

/** The subject it went with: an A/B test's winner, else its own. */
const subjectOf = (x: Broadcast) => {
	const w = x.ab_test?.winner;
	return (w ? x.ab_test?.subjects[w - 1] : null) ?? x.subject;
};

// ── Public pages ─────────────────────────────────────────────────────────────

const CSP_ISSUE =
	"default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; form-action 'self'; base-uri 'none'";
const CSP_ARCHIVE =
	"default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; form-action 'self'; base-uri 'none'";

const html = (body: string, csp: string, status = 200, cache = "public, max-age=300") =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": cache,
			"content-security-policy": csp,
		},
	});

function missing() {
	return html(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not found</title><style>body{margin:0;padding:80px 16px;font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;text-align:center;color:#3f3f46;background:#fafafa}</style></head><body><h1 style="font-size:20px;color:#18181b">This page isn't here</h1><p>It may have moved, or it was never published.</p></body></html>`,
		CSP_ISSUE,
		404,
		"no-store",
	);
}

const dateOf = (s: string | null) =>
	s
		? new Date(s).toLocaleDateString("en-US", {
				year: "numeric",
				month: "long",
				day: "numeric",
				timeZone: "UTC",
			})
		: "";

async function brandLook(brand: string) {
	const { orgLogos } = await import("./org-logos");
	const [row, logos] = await Promise.all([
		db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, brand))
			.get(),
		orgLogos([brand]),
	]);
	const logo = logos.get(brand)?.url ?? null;
	return {
		name: row?.name ?? "",
		logo: logo?.startsWith("/") ? `${publicUrl()}${logo}` : logo,
	};
}

const absolute = (u: string | null) => (u?.startsWith("/") ? `${publicUrl()}${u}` : u);

/** What a newsletter's public pages are dressed in: its look, color, logo and names. */
export type Dress = {
	look: Look;
	accent: string | null;
	logo: string | null;
	brand: string;
	name: string;
	/** Its archive, when it's on the web. */
	home: string | null;
	subscribe: boolean;
};

export async function dressOf(n: Newsletter | null, brand: string): Promise<Dress> {
	const look = lookOf(n?.look);
	const b = await brandLook(brand);
	return {
		look,
		accent: n?.accent ?? null,
		logo: look.logo === "none" ? null : look.logo === "brand" ? b.logo : absolute(look.logo),
		brand: b.name,
		name: n?.name ?? b.name,
		home: n?.public ? newsletterUrl(n.slug) : null,
		subscribe: !!(n?.public && n.form_id),
	};
}

/** The pages' shared CSS: variables from the look, and the bits every page has. */
export function dressCss(d: Dress) {
	return `${lookCss(d.look, d.accent)}
.mrw{font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased}
.mrw *{box-sizing:border-box}
.mrw h1,.mrw h2,.mrw h3{font-family:var(--heading-font)}
.mrw-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--accent);color:var(--on-accent);font:600 14px/1 var(--font);text-decoration:none;padding:11px 20px;border-radius:var(--r-btn);border:0;cursor:pointer;white-space:nowrap}
.mrw-btn:hover{filter:brightness(1.08)}
.mrw-btn.sm{font-size:13px;padding:8px 14px}
.mrw-ghost{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font:500 14px/1 var(--font);text-decoration:none;padding:9px 14px;border-radius:var(--r-btn);border:1px solid var(--line);background:var(--card)}
.mrw-ghost:hover{border-color:var(--mute)}
.mrw-bar{${
		d.look.bar === "solid"
			? "background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10"
			: d.look.bar === "none"
				? "background:transparent"
				: "background:color-mix(in srgb,var(--card) 88%,transparent);backdrop-filter:saturate(1.6) blur(10px);-webkit-backdrop-filter:saturate(1.6) blur(10px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10"
	}}
.mrw-bar>div{max-width:720px;margin:0 auto;padding:${d.look.bar === "none" ? "18px 16px 4px" : "10px 16px"};display:flex;align-items:center;gap:12px}
.mrw-home{flex:1;min-width:0;display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font-weight:600;font-size:15px}
.mrw-home img{height:var(--logo-h);width:var(--logo-w);max-width:160px;object-fit:var(--logo-fit);border-radius:var(--logo-r)}
.mrw-home span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mrw-date{color:var(--mute);font-size:13px;white-space:nowrap}
@media (max-width:520px){.mrw-date{display:none}.mrw-home img+span{display:none}}`;
}

/** The fonts link of a page. */
export function dressFonts(d: Dress) {
	const href = fontsHref(d.look);
	return href
		? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(href)}">`
		: "";
}

/** A page's top bar: its logo and name (to the archive), and a Subscribe button. */
export function dressBar(d: Dress, extra = "") {
	const inner = `${d.logo ? `<img src="${esc(d.logo)}" alt="">` : ""}<span>${esc(d.name)}</span>`;
	return `<header class="mrw mrw-bar"><div>${d.home ? `<a class="mrw-home" href="${esc(d.home)}">${inner}</a>` : `<span class="mrw-home">${inner}</span>`}${extra}${d.subscribe && d.home ? `<a class="mrw-btn sm" href="${esc(d.home)}#subscribe">${esc(wordOf(d.look, "subscribe", d.name))}</a>` : ""}</div></header>`;
}

/** A whole page in a newsletter's dress. */
export function dressPage(
	d: Dress,
	o: { title: string; head?: string; css?: string; body: string; lang?: string },
) {
	return `<!doctype html><html lang="${o.lang ?? "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>${o.head ?? ""}${dressFonts(d)}<style>${dressCss(d)}
html,body{margin:0}body{background:var(--bg)}
${o.css ?? ""}</style></head><body class="mrw">${o.body}</body></html>`;
}

/** An issue's first picture (not its logo), for the archive's cards and link previews. */
export function firstImage(x: Pick<Broadcast, "design" | "html">) {
	const doc = parseDoc(x.design);
	const walk = (blocks: Block[]): string | null => {
		for (const bl of blocks) {
			if (bl.type === "image" && bl.src) return bl.src;
			if (bl.type === "columns")
				for (const col of bl.columns) {
					const hit = walk(col);
					if (hit) return hit;
				}
		}
		return null;
	};
	if (doc) return absolute(walk(doc.blocks));
	const m = /<img\b[^>]*\ssrc\s*=\s*"(https?:\/\/[^"]+)"/i.exec(x.html ?? "");
	return m?.[1] ?? null;
}

/** The issue's email as a web page: the email itself, with a bar to the archive and a sign-up. */
async function issuePage(x: Broadcast, n: Newsletter | null) {
	const values = await webValues(x, n);
	// On the web the email's footer (why you got it, unsubscribe) has nothing to say.
	const design = parseDoc(x.design);
	const source = design
		? renderEmail({ ...design, blocks: design.blocks.filter((bl) => bl.type !== "footer") })
		: x.html || `<pre>${esc(x.text ?? "")}</pre>`;
	let doc = fill(source, values);
	const subject = fill(subjectOf(x), values);
	const d = await dressOf(n, x.organization_id);
	const description = x.preview_text ? fill(x.preview_text, values) : "";
	const url = webUrl(x, n);
	const image = firstImage(x);
	const meta = `<title>${esc(subject)}${n ? ` · ${esc(n.name)}` : ""}</title><meta name="viewport" content="width=device-width,initial-scale=1">${description ? `<meta name="description" content="${esc(description)}">` : ""}<meta property="og:title" content="${esc(subject)}"><meta property="og:type" content="article"><meta property="og:site_name" content="${esc(d.name)}">${description ? `<meta property="og:description" content="${esc(description)}">` : ""}${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : ""}<meta property="og:url" content="${esc(url)}"><link rel="canonical" href="${esc(url)}">${n?.public ? `<link rel="alternate" type="application/rss+xml" title="${esc(n.name)}" href="${esc(newsletterUrl(n.slug))}/feed.xml">` : ""}${x.web && n?.public ? "" : '<meta name="robots" content="noindex">'}${dressFonts(d)}<style>${dressCss(d)}
.mrw-after{max-width:600px;margin:8px auto 56px;padding:0 12px}
.mrw-cta{background:var(--card);border:var(--bw) solid var(--line);box-shadow:var(--shadow);border-radius:var(--r-card);padding:28px 24px;text-align:center}
.mrw-cta p{margin:0 0 16px;color:var(--soft);font-size:15px;line-height:1.55}
.mrw-cta h2{margin:0 0 6px;font-size:20px;line-height:1.3;color:var(--ink)}
.mrw-more{margin-top:28px}
.mrw-more h3{margin:0 0 8px;font:600 12px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--mute)}
.mrw-more a{display:block;padding:14px 2px;border-top:1px solid var(--line);color:var(--ink);text-decoration:none;font-weight:600;font-size:16px;line-height:1.4}
.mrw-more a:hover{color:var(--link)}
.mrw-more a span{display:block;font:400 13px/1.4 var(--font);color:var(--mute);margin-bottom:2px}
</style>`;
	const bar = d.home
		? dressBar(d, `<span class="mrw-date">${esc(dateOf(x.started_at))}</span>`)
		: "";
	let more = "";
	if (n?.public) {
		const others = (await issuesOf(n.id, { web: true, limit: 4 })).filter((o) => o.id !== x.id);
		const clean = (s: string) => fill(s, values).replace(/\{\{\{[^}]*\}\}\}/g, "");
		if (others.length)
			more = `<div class="mrw-more"><h3>${esc(wordOf(d.look, "more", n.name))}</h3>${others
				.slice(0, 3)
				.map(
					(o) =>
						`<a href="${esc(newsletterUrl(n.slug))}/${esc(o.slug ?? "")}"><span>${esc(dateOf(o.started_at))}</span>${esc(clean(subjectOf(o)))}</a>`,
				)
				.join("")}</div>`;
	}
	const cta =
		d.subscribe && d.home
			? `<div class="mrw-cta"><h2>${esc(wordOf(d.look, "cta_title", d.name))}</h2><p>${esc(wordOf(d.look, "cta_text", d.name) || n?.description || `Subscribe to ${d.name} and each new issue comes to you.`)}</p><a class="mrw-btn" href="${esc(d.home)}#subscribe">${esc(wordOf(d.look, "subscribe", d.name))}</a></div>`
			: "";
	const after = cta || more ? `<div class="mrw mrw-after">${cta}${more}</div>` : "";
	if (!/<html[\s>]/i.test(doc))
		doc = `<!doctype html><html><head></head><body>${doc}</body></html>`;
	if (!/<head[^>]*>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (m) => `${m}<head></head>`);
	doc = doc
		.replace(/<title>[\s\S]*?<\/title>/i, "")
		.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">${meta}`)
		.replace(/<body([^>]*)>/i, (m) => `${m}${bar}`)
		.replace(/<\/body>/i, `${after}</body>`);
	return doc;
}

/** Its front page with settings not saved yet (the dashboard's preview); bad values are left out. */
export async function previewArchive(n: Newsletter, raw: Record<string, unknown>) {
	const v = newsletterInput.partial().safeParse(raw);
	const f = v.success ? v.data : {};
	const next: Newsletter = {
		...n,
		name: f.name || n.name,
		description: f.description !== undefined ? f.description || null : n.description,
		accent: f.accent !== undefined ? f.accent || null : n.accent,
		form_id: f.form_id !== undefined ? f.form_id || null : n.form_id,
		look: (f.look !== undefined ? f.look : (raw.look as NewsletterLook | undefined)) ?? n.look,
	};
	return archivePage(next, new URL(newsletterUrl(n.slug)));
}

/** The newsletter's front page: what it is, its sign-up form, and its issues. */
export async function archivePage(n: Newsletter, u: URL) {
	const [d, issues] = await Promise.all([
		dressOf({ ...n, public: true }, n.organization_id),
		issuesOf(n.id, { web: true }),
	]);
	const l = d.look;
	let form = "";
	if (n.form_id) {
		const f = await db
			.select()
			.from(schema.signupForms)
			.where(and(eq(schema.signupForms.id, n.form_id), eq(schema.signupForms.enabled, true)))
			.get();
		if (f) {
			const { renderInput, carried } = await import("./signup-forms");
			const { brandWidget } = await import("./turnstile");
			const { embedHtml } = await import("../lib/signup-form-render");
			const sitekey = (await brandWidget(f.organization_id))?.sitekey;
			// The form wears the page's look: its color and fonts, and no second title or logo (the
			// page has its own, or none when its logo is set to None).
			const own = parseDesign(f.design);
			const dark = l.theme === "dark";
			const design = {
				...own,
				display: "inline" as const,
				font: "inherit" as const,
				accent: n.accent ?? own.accent,
				eyebrow: "",
				show_title: false,
				show_logo: false,
				...(dark ? { background: "#18181b", text: "#f4f4f5" } : {}),
			};
			form = embedHtml(await renderInput(f, carried(u)), design, { sitekey });
		}
	}
	const values = { FIRST_NAME: "", LAST_NAME: "", EMAIL: "" };
	const clean = (s: string) => fill(s, values).replace(/\{\{\{[^}]*\}\}\}/g, "");
	const url = newsletterUrl(n.slug);
	const href = (x: Broadcast) => `${url}/${esc(x.slug ?? "")}`;
	const preview = (x: Broadcast) =>
		x.preview_text ? `<span class="p">${esc(clean(x.preview_text))}</span>` : "";
	let list: string;
	if (!issues.length) list = `<p class="empty">${esc(wordOf(l, "empty", n.name))}</p>`;
	else if (l.layout === "cards")
		list = `<div class="cards">${issues
			.map((x, i) => {
				const img = firstImage(x);
				const pic = img
					? `<img src="${esc(img)}" alt="" loading="${i < 3 ? "eager" : "lazy"}">`
					: `<span class="ph">${esc(clean(subjectOf(x)).slice(0, 1).toUpperCase())}</span>`;
				return `<a class="card${i === 0 && issues.length > 2 ? " wide" : ""}" href="${href(x)}"><span class="pic">${pic}</span><span class="txt"><span class="d">${esc(dateOf(x.started_at))}</span><span class="t">${esc(clean(subjectOf(x)))}</span>${preview(x)}</span></a>`;
			})
			.join("")}</div>`;
	else
		list = `<ul class="list">${issues
			.map((x) => {
				const img = firstImage(x);
				return `<li><a href="${href(x)}"><span class="txt"><span class="d">${esc(dateOf(x.started_at))}</span><span class="t">${esc(clean(subjectOf(x)))}</span>${preview(x)}</span>${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}</a></li>`;
			})
			.join("")}</ul>`;
	const links = l.links.length
		? `<nav class="links">${l.links.map((k) => `<a class="mrw-ghost" href="${esc(k.url)}" rel="noopener" target="_blank">${esc(k.label)}</a>`).join("")}</nav>`
		: "";
	const count =
		issues.length && l.show_count
			? `${issues.length.toLocaleString("en-US")} ${issues.length === 1 ? "issue" : "issues"}`
			: "";
	const subscribe = form
		? `<section id="subscribe" class="sub ${l.form_position}">${form}</section>`
		: "";
	const image = l.cover ?? (issues[0] ? firstImage(issues[0]) : null);
	const head = `${n.description ? `<meta name="description" content="${esc(n.description)}"><meta property="og:description" content="${esc(n.description)}">` : ""}<meta property="og:title" content="${esc(n.name)}"><meta property="og:type" content="website"><meta property="og:url" content="${esc(url)}">${image ? `<meta property="og:image" content="${esc(absolute(image) ?? "")}"><meta name="twitter:card" content="summary_large_image">` : ""}${d.logo ? `<link rel="icon" href="${esc(d.logo)}">` : ""}<link rel="canonical" href="${esc(url)}"><link rel="alternate" type="application/rss+xml" title="${esc(n.name)}" href="${esc(url)}/feed.xml">`;
	const left = l.align === "left";
	// "-" hides the heading; empty is the default.
	const heading =
		l.words.issues_heading?.trim() === "-" ? "" : wordOf(l, "issues_heading", n.name);
	const footer = l.words.footer
		? esc(wordOf(l, "footer", n.name))
		: `&copy; ${new Date().getUTCFullYear()} ${esc(d.brand || n.name)}`;
	const css = `
.cover{height:clamp(160px,30vw,320px);background:var(--line) center/cover no-repeat}
main{max-width:760px;margin:0 auto;padding:56px 20px 72px}
.has-cover main{padding-top:0}
.hero{text-align:${left ? "left" : "center"};margin-bottom:40px}
.logo{${shapeVars(l, 64)};display:block;height:var(--logo-h);width:var(--logo-w);max-width:240px;object-fit:var(--logo-fit);margin:${left ? "0 0 20px" : "0 auto 20px"};border-radius:${l.logo_shape === "original" ? "14px" : "var(--logo-r)"}}
.has-cover .logo{${shapeVars(l, 76)};position:relative;margin-top:-36px;background:#fff;padding:${l.logo_shape === "circle" ? "0" : "6px"};box-shadow:0 0 0 ${l.logo_shape === "circle" ? "4px #fff" : "1px var(--line)"},0 8px 24px rgba(0,0,0,.08)}
.has-cover .hero.no-logo{padding-top:36px}
h1{margin:0;font-size:clamp(30px,6vw,46px);line-height:1.1;letter-spacing:-.025em;font-weight:700}
.hero p{margin:14px ${left ? "0" : "auto"} 0;max-width:560px;color:var(--soft);font-size:18px;line-height:1.55}
.meta{margin-top:14px;font-size:13px;color:var(--mute)}
.links{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px;justify-content:${left ? "flex-start" : "center"}}
.sub{margin:0 auto 48px;max-width:520px}.sub.bottom{margin:48px auto 0}.sub .mr-box{margin-left:auto;margin-right:auto}
.mrw section>h2{margin:0 0 14px;font:600 12px/1 var(--font);text-transform:uppercase;letter-spacing:.08em;color:var(--mute)}
.d{font-size:13px;color:var(--mute)}.t{font-family:var(--heading-font);font-size:19px;font-weight:600;line-height:1.35;color:var(--ink)}
.p{color:var(--soft);font-size:15px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.txt{display:grid;gap:3px;min-width:0}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.list a{display:flex;gap:20px;align-items:center;padding:20px 4px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}
.list .txt{flex:1}
.list img{width:112px;height:76px;object-fit:cover;border-radius:var(--r-sm);flex-shrink:0;background:var(--line)}
.list a:hover .t,.card:hover .t{color:var(--link)}
.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.card{display:flex;flex-direction:column;background:var(--card);border:var(--bw) solid var(--line);box-shadow:var(--shadow);border-radius:var(--r-card);overflow:hidden;color:inherit;text-decoration:none;transition:transform .15s,box-shadow .15s}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 30px rgba(0,0,0,.08)}
.card .pic{display:block;aspect-ratio:16/9;background:color-mix(in srgb,var(--accent) 14%,var(--card));overflow:hidden}
.card .pic img{width:100%;height:100%;object-fit:cover;display:block}
.card .ph{display:flex;height:100%;align-items:center;justify-content:center;font:700 44px/1 var(--heading-font);color:color-mix(in srgb,var(--accent) 60%,var(--card))}
.card .txt{padding:16px 18px 20px}
.card.wide{grid-column:1/-1}.card.wide .pic{aspect-ratio:21/9}.card.wide .t{font-size:24px}
@media (max-width:600px){.cards{grid-template-columns:1fr}.card.wide .pic{aspect-ratio:16/9}.list img{width:84px;height:64px}}
.empty{padding:28px 4px;color:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:0}
footer{margin-top:56px;padding-top:24px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px 16px;justify-content:space-between;font-size:13px;color:var(--mute)}
footer a{color:inherit}`;
	const body = `${l.cover ? `<div class="cover" style="background-image:url('${esc(absolute(l.cover) ?? "").replace(/'/g, "%27")}')"></div>` : ""}<main><header class="hero${d.logo ? "" : " no-logo"}">${d.logo ? `<img class="logo" src="${esc(d.logo)}" alt="${esc(d.brand)}">` : ""}<h1>${esc(n.name)}</h1>${n.description ? `<p>${esc(n.description)}</p>` : ""}${links}${count ? `<div class="meta">${count}</div>` : ""}</header>${l.form_position === "top" ? subscribe : ""}<section>${heading ? `<h2>${esc(heading)}</h2>` : ""}${list}</section>${l.form_position === "bottom" ? subscribe : ""}<footer><span>${footer}</span>${l.show_rss ? `<a href="${esc(url)}/feed.xml">RSS feed</a>` : ""}</footer></main>`;
	return dressPage(d, {
		title: n.name,
		head,
		css,
		body: l.cover ? `<div class="has-cover">${body}</div>` : body,
	});
}

const xmlEsc = (s: string) =>
	s.replace(
		/[<>&'"]/g,
		(c) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] as string,
	);

async function feed(n: Newsletter) {
	const issues = await issuesOf(n.id, { web: true, limit: 30 });
	const url = newsletterUrl(n.slug);
	const clean = (s: string) =>
		fill(s, { FIRST_NAME: "", LAST_NAME: "", EMAIL: "" }).replace(/\{\{\{[^}]*\}\}\}/g, "");
	const items = issues
		.map(
			(x) =>
				`<item><title>${xmlEsc(clean(subjectOf(x)))}</title><link>${xmlEsc(`${url}/${x.slug}`)}</link><guid isPermaLink="true">${xmlEsc(`${url}/${x.slug}`)}</guid>${x.started_at ? `<pubDate>${new Date(x.started_at).toUTCString()}</pubDate>` : ""}${x.preview_text ? `<description>${xmlEsc(clean(x.preview_text))}</description>` : ""}</item>`,
		)
		.join("");
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlEsc(n.name)}</title><link>${xmlEsc(url)}</link><description>${xmlEsc(n.description ?? n.name)}</description>${items}</channel></rss>`,
		{
			headers: {
				"content-type": "application/rss+xml; charset=utf-8",
				"cache-control": "public, max-age=600",
			},
		},
	);
}

/** /n/<newsletter>[/<issue>|/feed.xml] and /view/<broadcast>. */
export async function handleNewsletterPage(request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", { status: 405 });
	const u = new URL(request.url);
	const view = /^\/view\/([0-9a-f-]{36})$/.exec(u.pathname);
	if (view) {
		const x = await db
			.select()
			.from(b)
			.where(eq(b.id, view[1] as string))
			.get();
		if (!x || x.status === "draft" || x.status === "canceled" || !shownHere(x.organization_id))
			return missing();
		const n = await newsletterOf(x.newsletter_id);
		// An issue on the archive has one address.
		if (n?.public && x.web && x.slug)
			return Response.redirect(`${newsletterUrl(n.slug)}/${x.slug}`, 301);
		return html(await issuePage(x, n), CSP_ISSUE, 200, "private, max-age=300");
	}
	const m = /^\/n\/([a-z0-9-]{1,64})(?:\/([a-z0-9-]{1,64}|feed\.xml))?\/?$/.exec(u.pathname);
	if (!m) return missing();
	const n = await db
		.select()
		.from(nl)
		.where(eq(nl.slug, m[1] as string))
		.get();
	if (!n?.public || !shownHere(n.organization_id)) return missing();
	if (!m[2]) return html(await archivePage(n, u), CSP_ARCHIVE, 200, "no-store");
	if (m[2] === "feed.xml") return feed(n);
	const x = await db
		.select()
		.from(b)
		.where(
			and(
				eq(b.newsletter_id, n.id),
				eq(b.slug, m[2]),
				eq(b.web, true),
				inArray(b.status, [...SENT]),
			),
		)
		.get();
	if (!x) return missing();
	return html(await issuePage(x, n), CSP_ISSUE);
}

/**
 * The root of a domain's own host: its newsletter's archive (the one sent from the domain, else
 * the organization's only public one), or nothing.
 */
export async function hostHome(own: { organizationId: string; domain: string; base: string }) {
	const list = await db
		.select({ slug: nl.slug, from: nl.from })
		.from(nl)
		.where(and(eq(nl.organization_id, own.organizationId), eq(nl.public, true)))
		.orderBy(asc(nl.created_at));
	const host = (from: string) => bareAddress(from).split("@")[1]?.toLowerCase() ?? "";
	const pick =
		list.find((n) => host(n.from) === own.domain || host(n.from).endsWith(`.${own.domain}`)) ??
		(list.length === 1 ? list[0] : undefined);
	if (!pick) return missing();
	return new Response(null, {
		status: 302,
		headers: { location: `${own.base}/n/${pick.slug}`, "cache-control": "no-store" },
	});
}

// ── RSS to email ─────────────────────────────────────────────────────────────

/** Feeds are read once an hour; a run reads this many. */
const FEEDS_PER_RUN = 25;

/** The design of an issue made from new posts. */
export function digestDesign(
	n: Pick<Newsletter, "name" | "accent"> &
		Partial<Pick<Newsletter, "rss_style" | "rss_intro" | "look">>,
	items: FeedItem[],
	logo?: string | null,
): EmailDoc {
	const blocks: Block[] = [];
	const style = (n.rss_style ?? "full") as RssStyle;
	if (logo)
		blocks.push({
			id: newId(),
			type: "logo",
			src: logo,
			alt: n.name,
			width: 56,
			align: "left",
			href: "",
			shape: "original",
			background: null,
		});
	if (items.length > 1 || style !== "full")
		blocks.push({ id: newId(), type: "heading", html: esc(n.name), level: 1, align: "left" });
	if (n.rss_intro)
		blocks.push({
			id: newId(),
			type: "text",
			html: `<p>${esc(n.rss_intro)}</p>`,
			align: "left",
		});
	if (style === "titles") {
		// One list of links: each post's title, and a line of it.
		blocks.push({
			id: newId(),
			type: "text",
			html: items
				.map(
					(it) =>
						`<p><a href="${esc(it.link)}"><strong>${esc(it.title)}</strong></a>${it.summary ? `<br>${esc(it.summary.length > 160 ? `${it.summary.slice(0, 157).trimEnd()}…` : it.summary)}` : ""}</p>`,
				)
				.join(""),
			align: "left",
		});
	}
	for (const [i, it] of (style === "titles" ? [] : items).entries()) {
		if (style === "compact") {
			if (i) blocks.push({ id: newId(), type: "divider" });
			const cells: LeafBlock[] = [
				{
					id: newId(),
					type: "heading",
					html: `<a href="${esc(it.link)}">${esc(it.title)}</a>`,
					level: 3,
					align: "left",
				},
			];
			if (it.summary)
				cells.push({
					id: newId(),
					type: "text",
					html: `<p>${esc(it.summary)}</p>`,
					align: "left",
				});
			if (it.image)
				blocks.push({
					id: newId(),
					type: "columns",
					ratio: "1-2",
					columns: [
						[
							{
								id: newId(),
								type: "image",
								src: it.image,
								alt: it.title,
								href: it.link,
								width: 100,
								align: "center",
							},
						],
						cells,
					],
				});
			else blocks.push(...cells);
			continue;
		}
		if (i) blocks.push({ id: newId(), type: "divider" });
		if (it.image)
			blocks.push({
				id: newId(),
				type: "image",
				src: it.image,
				alt: it.title,
				href: it.link,
				width: 100,
				align: "center",
			});
		blocks.push({
			id: newId(),
			type: "heading",
			html: esc(it.title),
			level: items.length > 1 ? 2 : 1,
			align: "left",
		});
		if (it.summary)
			blocks.push({
				id: newId(),
				type: "text",
				html: `<p>${esc(it.summary)}</p>`,
				align: "left",
			});
		blocks.push({
			id: newId(),
			type: "button",
			label: "Read more",
			url: it.link,
			align: "left",
			full: false,
			color: null,
		});
	}
	blocks.push({
		id: newId(),
		type: "footer",
		html: `<p>You're getting this because you subscribed to ${esc(n.name)}. <a href="{{{WEB_VERSION_URL}}}">View it online</a>.</p>`,
		unsubscribe: "Unsubscribe",
	});
	// The email in the newsletter's color and nearest email-safe fonts.
	return {
		version: 1,
		theme: { ...DEFAULT_THEME, ...emailThemeOf(lookOf(n.look), n.accent) },
		blocks,
	};
}

async function readFeed(url: string) {
	const res = await fetch(url, {
		headers: {
			"user-agent": "Mailroom RSS (+https://github.com/RVP97/mailroom)",
			accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5",
		},
		signal: AbortSignal.timeout(10_000),
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`The feed answered ${res.status}`);
	const text = await res.text();
	if (text.length > 5_000_000) throw new Error("The feed is too big");
	const parsed = parseFeed(text);
	if (!parsed.items.length && !/<(rss|feed)\b/i.test(text))
		throw new Error("That address isn't an RSS or Atom feed");
	return parsed;
}

/**
 * One newsletter's feed: posts it hasn't seen become one issue (a draft, or sent right away).
 * The first read only notes what's there, so turning it on never sends old posts.
 */
export async function checkFeed(n: Newsletter, now = Date.now(), fetchFeed = readFeed) {
	if (!n.rss_url) return null;
	let items: FeedItem[];
	try {
		items = (await fetchFeed(n.rss_url)).items;
	} catch (error) {
		await db
			.update(nl)
			.set({
				rss_checked_at: iso(now),
				rss_error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
			})
			.where(eq(nl.id, n.id));
		return null;
	}
	const seen = new Set(n.rss_seen ?? []);
	const first = n.rss_seen === null;
	// Posts older than a week aren't news (a feed that reorders or republishes old ones).
	const fresh = items.filter(
		(i) =>
			!seen.has(i.link) && (!i.published || Date.parse(i.published) > now - 7 * 86_400_000),
	);
	const next = [...new Set([...items.map((i) => i.link), ...(n.rss_seen ?? [])])].slice(0, 200);
	await db
		.update(nl)
		.set({ rss_seen: next, rss_checked_at: iso(now), rss_error: null })
		.where(eq(nl.id, n.id));
	if (first || !fresh.length) return null;
	const posts = fresh.slice(0, 10);
	const { createBroadcast, sendBroadcast } = await import("./broadcasts");
	const { orgOf } = await import("./brands");
	const lead = posts[0] as FeedItem;
	const subject =
		posts.length === 1 ? lead.title : `${lead.title} (and ${posts.length - 1} more)`;
	const x = await createBroadcast(
		await orgOf(n.organization_id),
		n.organization_id,
		{
			name: `${n.name}: ${subject}`.slice(0, 200),
			subject: subject.slice(0, 998),
			preview_text: lead.summary.slice(0, 280) || null,
			from: n.from || null,
			segment_id: n.segment_id,
			topic_id: n.topic_id,
			design: digestDesign(n, posts, (await dressOf(n, n.organization_id)).logo),
			newsletter_id: n.id,
		},
		now,
	);
	await db
		.update(b)
		.set({ rss_items: posts.map((p) => p.link) })
		.where(eq(b.id, x.id));
	if (n.rss_mode === "send")
		try {
			await sendBroadcast(n.organization_id, x.id, null, now);
		} catch (error) {
			// It stays a draft to fix and send by hand.
			await db
				.update(nl)
				.set({
					rss_error:
						`New posts are a draft, not sent: ${error instanceof Error ? error.message : error}`.slice(
							0,
							300,
						),
				})
				.where(eq(nl.id, n.id));
		}
	return x.id;
}

/** The cron's turn (hourly): feeds not read for the last 55 minutes. */
export async function runFeeds(now = Date.now()) {
	const due = await db
		.select()
		.from(nl)
		.where(
			and(
				isNotNull(nl.rss_url),
				or(isNull(nl.rss_checked_at), lt(nl.rss_checked_at, iso(now - 55 * 60_000))),
			),
		)
		.orderBy(sql`${nl.rss_checked_at} IS NOT NULL, ${nl.rss_checked_at}`)
		.limit(FEEDS_PER_RUN);
	let made = 0;
	for (const n of due)
		if (await checkFeed(n, now).catch((e) => console.error("rss: failed", n.id, e))) made++;
	return made;
}
