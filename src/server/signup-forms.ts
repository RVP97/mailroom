import { env } from "cloudflare:workers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
	embedHtml,
	embedScript,
	esc,
	hostedPage,
	parseDesign,
	type RenderInput,
	scriptTag,
} from "@/lib/signup-form-render";
import { bareAddress } from "./aws/mime";
import { db, schema } from "./db";
import { notFound, validation } from "./errors";
import { orgContext } from "./org";
import { publicUrl, shownHere } from "./public-host";
import { iso } from "./time";
import { brandWidget, verifyTurnstile } from "./turnstile";

/**
 * Public sign-up forms: a newsletter box on any website. The site's form posts to
 * POST /subscribe/<form>; Mailroom emails the address a confirmation link (from the brand's own
 * domain) and only the click adds the contact, to the form's segment and topic. So bots and typos
 * never reach a list, and every subscriber asked twice. Against abuse: a hidden field bots fill
 * (they're told it worked), a limit per IP (SIGNUP_LIMIT), and the brand's Cloudflare Turnstile
 * widget, which Mailroom makes and keeps in step with its forms' websites (src/server/turnstile.ts).
 * Someone already subscribed isn't emailed
 * again, and the answer is the same either way, so the form doesn't tell who's on a list.
 */

export type SignupForm = typeof schema.signupForms.$inferSelect;
const t = schema.signupForms;

/** Confirmation links work this long. */
const LINK_TTL_S = 7 * 86_400;

const url = z
	.string()
	.trim()
	.max(2000)
	.regex(/^https:\/\/[^\s]+$/, "an https:// address");

export const formInput = z.object({
	name: z.string().trim().min(1).max(200),
	title: z.string().trim().min(1).max(200).optional(),
	segment_id: z.string().max(100).nullish(),
	topic_id: z.string().max(100).nullish(),
	from: z.string().trim().min(3).max(320),
	ask_name: z.boolean().optional(),
	website: url.nullish().or(z.literal("")),
	redirect_url: url.nullish().or(z.literal("")),
	enabled: z.boolean().optional(),
	/** How it looks and what it says; see FormDesign. Keys left out keep their value. */
	design: z.record(z.string(), z.unknown()).optional(),
});

export const formView = (f: SignupForm) => ({
	object: "signup_form",
	id: f.id,
	brand_id: f.organization_id,
	name: f.name,
	title: f.title,
	segment_id: f.segment_id,
	topic_id: f.topic_id,
	from: f.from,
	ask_name: f.ask_name,
	website: f.website,
	redirect_url: f.redirect_url,
	enabled: f.enabled,
	design: parseDesign(f.design),
	signups: f.signups,
	confirmed: f.confirmed,
	url: formUrl(f.id),
	created_at: f.created_at,
	updated_at: f.updated_at,
});

export const formUrl = (id: string) => `${publicUrl()}/subscribe/${id}`;

async function checkRefs(
	brand: string,
	v: { from?: string; segment_id?: string | null; topic_id?: string | null },
) {
	if (v.from !== undefined) {
		const address = bareAddress(v.from).toLowerCase();
		const domain = address.split("@")[1] ?? "";
		const ctx = await orgContext(brand);
		if (!ctx.domains.some((d) => d.verified && d.name === domain))
			throw validation(
				"from: an address on one of this brand's verified domains (the confirmation email goes from it)",
			);
	}
	if (v.segment_id) {
		const s = await db
			.select({ id: schema.segments.id })
			.from(schema.segments)
			.where(
				and(
					eq(schema.segments.id, v.segment_id),
					eq(schema.segments.organization_id, brand),
				),
			)
			.get();
		if (!s) throw validation("segment_id: no such segment in this brand");
	}
	if (v.topic_id) {
		const x = await db
			.select({ id: schema.topics.id })
			.from(schema.topics)
			.where(and(eq(schema.topics.id, v.topic_id), eq(schema.topics.organization_id, brand)))
			.get();
		if (!x) throw validation("topic_id: no such topic in this brand");
	}
}

const newId = () => `frm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export async function listForms(brands: string[]) {
	return db.select().from(t).where(inArray(t.organization_id, brands)).orderBy(asc(t.created_at));
}

export async function getForm(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(t)
		.where(and(eq(t.id, id), inArray(t.organization_id, list)))
		.get();
	if (!row) throw notFound("Sign-up form");
	return row;
}

export async function createForm(brand: string, raw: unknown, now = Date.now()) {
	const v = formInput.parse(raw);
	await checkRefs(brand, v);
	const [row] = await db
		.insert(t)
		.values({
			id: newId(),
			organization_id: brand,
			name: v.name,
			title: v.title || v.name,
			segment_id: v.segment_id || null,
			topic_id: v.topic_id || null,
			from: v.from,
			ask_name: v.ask_name ?? true,
			website: v.website || null,
			redirect_url: v.redirect_url || null,
			enabled: v.enabled ?? true,
			design: parseDesign(v.design ?? {}),
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	await turnstileFor(brand);
	return row as SignupForm;
}

/** Brings the brand's Turnstile widget in step with its forms' websites; what's wrong, or null. */
export async function turnstileFor(brand: string) {
	const { syncTurnstile } = await import("./turnstile");
	return syncTurnstile(brand, await brandName(brand));
}

export async function updateForm(brand: string, id: string, raw: unknown, now = Date.now()) {
	const x = await getForm(brand, id);
	const v = formInput.partial().parse(raw ?? {});
	await checkRefs(brand, v);
	const [row] = await db
		.update(t)
		.set({
			name: v.name ?? x.name,
			title: v.title || x.title,
			segment_id: v.segment_id !== undefined ? v.segment_id || null : x.segment_id,
			topic_id: v.topic_id !== undefined ? v.topic_id || null : x.topic_id,
			from: v.from ?? x.from,
			ask_name: v.ask_name ?? x.ask_name,
			website: v.website !== undefined ? v.website || null : x.website,
			redirect_url: v.redirect_url !== undefined ? v.redirect_url || null : x.redirect_url,
			enabled: v.enabled ?? x.enabled,
			design: v.design ? parseDesign({ ...parseDesign(x.design), ...v.design }) : x.design,
			updated_at: iso(now),
		})
		.where(eq(t.id, id))
		.returning();
	if (v.website !== undefined && (v.website || null) !== x.website) await turnstileFor(brand);
	return row as SignupForm;
}

export async function deleteForm(brand: string, id: string) {
	const x = await getForm(brand, id);
	await db.delete(t).where(eq(t.id, id));
	if (x.website) await turnstileFor(brand);
	return x;
}

// ── The confirmation link ────────────────────────────────────────────────────

/** Form, email, names, the referral code (r) and where it came from (s); x: expiry. */
type Pending = {
	f: string;
	e: string;
	n?: string;
	l?: string;
	r?: string;
	s?: string;
	x: number;
};

const b64url = (s: string) =>
	btoa(unescape(encodeURIComponent(s)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const unb64url = (s: string) =>
	decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export async function confirmToken(p: Omit<Pending, "x">, now = Date.now()) {
	const { sign } = await import("./inbound");
	const payload = b64url(JSON.stringify({ ...p, x: Math.floor(now / 1000) + LINK_TTL_S }));
	return `${payload}.${await sign(`signup:${payload}`)}`;
}

export async function readToken(token: string, now = Date.now()): Promise<Pending | null> {
	const [payload, signature] = token.split(".");
	if (!payload || !signature) return null;
	const { sign } = await import("./inbound");
	const expected = await sign(`signup:${payload}`);
	if (expected.length !== signature.length) return null;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	if (diff) return null;
	try {
		const p = JSON.parse(unb64url(payload)) as Pending;
		return p.x * 1000 >= now ? p : null;
	} catch {
		return null;
	}
}

// ── Public endpoints ─────────────────────────────────────────────────────────

function page(title: string, body: string, status = 200) {
	return new Response(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;padding:48px 16px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1a}main{max-width:420px;margin:0 auto;background:#fff;border:1px solid #e7e6e1;border-radius:12px;padding:28px}h1{margin:0 0 8px;font-size:20px}p{margin:0 0 16px;font-size:14px;line-height:1.55;color:#4a4a46}label{display:block;font-size:13px;font-weight:500;margin:0 0 6px}input[type=email],input[type=text]{box-sizing:border-box;width:100%;padding:10px 12px;margin:0 0 14px;border:1px solid #d9d8d2;border-radius:8px;font:inherit}button{width:100%;padding:11px;border:0;border-radius:8px;background:#1c1c1a;color:#fff;font:500 14px inherit;cursor:pointer}.trap{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.cf-turnstile{margin:0 0 14px}@media (prefers-color-scheme:dark){body{background:#151513;color:#ededea}main{background:#1d1d1b;border-color:#2e2e2b}p{color:#b5b5b0}input[type=email],input[type=text]{background:#151513;color:#ededea;border-color:#3a3a36}button{background:#ededea;color:#151513}}</style></head>
<body><main>${body}</main></body></html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-frame-options": "DENY",
				"content-security-policy":
					"default-src 'none'; img-src * data:; style-src 'unsafe-inline'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			},
		},
	);
}

type Renderable = Pick<SignupForm, "id" | "ask_name" | "title" | "design" | "organization_id">;

/** What the renderer needs: the form, plus its brand's name and logo (absolute, for websites). */
export async function renderInput(
	f: Renderable,
	hidden?: Record<string, string>,
): Promise<RenderInput> {
	const { orgLogos } = await import("./org-logos");
	const [name, logos] = await Promise.all([
		brandName(f.organization_id),
		orgLogos([f.organization_id]),
	]);
	const logo = logos.get(f.organization_id)?.url ?? null;
	return {
		id: f.id,
		action: formUrl(f.id),
		title: f.title,
		ask_name: f.ask_name,
		brand: name,
		logo: logo?.startsWith("/") ? `${publicUrl()}${logo}` : logo,
		...(hidden && Object.keys(hidden).length ? { hidden } : {}),
	};
}

const CODE = /^[A-Za-z0-9]{4,16}$/;

/** A referral link's code and the utm_source from a page's address, to post with its form. */
export function carried(u: URL) {
	const out: Record<string, string> = {};
	const ref = u.searchParams.get("ref") ?? "";
	if (CODE.test(ref)) out.ref = ref;
	const utm = (u.searchParams.get("utm_source") ?? "").trim().slice(0, 100);
	if (utm && /^[\w .:/@-]+$/.test(utm)) out.utm_source = utm;
	return out;
}

/** The self-updating embed's URL. */
export const formScriptUrl = (id: string) => `${formUrl(id)}.js`;

/**
 * The form's code for a website: the one-line script that always shows the current design, and
 * the full HTML (which has to be pasted again after changes).
 */
export async function formEmbed(f: Renderable, o: { sitekey?: string | null } = {}) {
	return {
		script: scriptTag(formScriptUrl(f.id)),
		html: embedHtml(await renderInput(f), parseDesign(f.design), o),
	};
}

/** The brand's name and logo, for the dashboard's canvas. */
export async function brandLooks(brands: string[]) {
	const { orgLogos } = await import("./org-logos");
	const logos = await orgLogos(brands);
	return Object.fromEntries(
		brands.map((b) => {
			const url = logos.get(b)?.url ?? null;
			return [b, url?.startsWith("/") ? `${publicUrl()}${url}` : url];
		}),
	) as Record<string, string | null>;
}

/** The color each brand shows behind its logo (Settings › Logo), "#rrggbb", or null. */
export async function logoBackgrounds(brands: string[]) {
	const { orgLogos } = await import("./org-logos");
	const { backgroundColor } = await import("../lib/org-logo");
	const logos = await orgLogos(brands);
	return Object.fromEntries(
		brands.map((b) => [b, backgroundColor(logos.get(b)?.background ?? null)]),
	) as Record<string, string | null>;
}

async function brandName(brand: string) {
	const row = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, brand))
		.get();
	return row?.name ?? "";
}

async function liveForm(id: string) {
	const f = await db.select().from(t).where(eq(t.id, id)).get();
	return f?.enabled ? f : null;
}

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-allow-headers": "content-type",
	"access-control-max-age": "86400",
};

/** /subscribe/<form> (GET: the hosted page; POST: a sign-up) and /subscribe/confirm. */
export async function handleSubscribe(request: Request, now = Date.now()): Promise<Response> {
	const u = new URL(request.url);
	if (u.pathname === "/subscribe/confirm") {
		// Opening the link only asks: mail scanners open every link, and a sign-up is the person's.
		if (request.method !== "POST") return confirmPage(u.searchParams.get("t") ?? "", now);
		const form = await request.formData().catch(() => null);
		return confirm(String(form?.get("t") ?? ""), now);
	}
	const m = /^\/subscribe\/(frm_[A-Za-z0-9]{1,40})(\.js)?$/.exec(u.pathname);
	const id = m?.[1];
	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	const live = id ? await liveForm(id) : null;
	// On a domain's own host, only its organization's forms.
	const f = live && shownHere(live.organization_id) ? live : null;
	if (!f && m?.[2])
		// A website's embed of a form that's off (or gone) shows nothing.
		return new Response("", {
			status: 404,
			headers: {
				"content-type": "application/javascript",
				"cache-control": "public, max-age=60",
			},
		});
	if (!f) return page("Not found", "<h1>This form isn't available</h1>", 404);
	if (request.method === "GET") {
		const design = parseDesign(f.design);
		if (u.searchParams.get("sent"))
			return page(
				"Check your inbox",
				`<h1>Check your inbox</h1><p>${esc(design.success)}</p>`,
			);
		const sitekey = (await brandWidget(f.organization_id))?.sitekey;
		const input = await renderInput(f, m?.[2] ? undefined : carried(u));
		if (m?.[2])
			return new Response(embedScript(input, design, { sitekey }), {
				headers: {
					"content-type": "application/javascript; charset=utf-8",
					// Short, so a design change reaches websites within a minute.
					"cache-control": "public, max-age=60",
					"access-control-allow-origin": "*",
				},
			});
		const nonce = crypto.randomUUID().replace(/-/g, "");
		return new Response(hostedPage(input, design, { sitekey, nonce }), {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"x-frame-options": "DENY",
				// Served from Mailroom's own origin with a tenant's design in it: only the page's own
				// script (and Turnstile) may run.
				"content-security-policy": `default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
			},
		});
	}
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	return signUp(request, f, now);
}

async function readBody(request: Request): Promise<Record<string, string>> {
	const type = request.headers.get("content-type") ?? "";
	try {
		if (type.includes("application/json")) {
			const j = (await request.json()) as Record<string, unknown>;
			return Object.fromEntries(
				Object.entries(j ?? {}).map(([k, v]) => [k, typeof v === "string" ? v : ""]),
			);
		}
		const form = await request.formData();
		return Object.fromEntries(
			[...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]),
		);
	} catch {
		return {};
	}
}

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

async function signUp(request: Request, f: SignupForm, now: number) {
	const wantsJson =
		(request.headers.get("accept") ?? "").includes("application/json") ||
		(request.headers.get("content-type") ?? "").includes("application/json");
	const answer = (ok: boolean, message: string, status = ok ? 200 : 400) =>
		wantsJson
			? Response.json({ ok, message }, { status, headers: CORS })
			: ok
				? Response.redirect(`${formUrl(f.id)}?sent=1`, 303)
				: page(
						"Couldn't subscribe",
						`<h1>Couldn't subscribe</h1><p>${esc(message)}</p>`,
						status,
					);
	const done = () => answer(true, "Check your inbox to confirm.");
	const ip = request.headers.get("cf-connecting-ip");
	const limiter = (env as unknown as Record<string, Limiter | undefined>).SIGNUP_LIMIT;
	if (limiter && !(await limiter.limit({ key: ip ?? "unknown" })).success)
		return answer(false, "Too many sign-ups from here; try again in a minute.", 429);
	const body = await readBody(request);
	// Bots fill the hidden field: they're told it worked, and nothing happens.
	if (body.website) return done();
	if (!(await verifyTurnstile(f.organization_id, body["cf-turnstile-response"] ?? "", ip)))
		return answer(false, "The check that you're not a bot didn't pass; try again.", 403);
	const email = (body.email ?? "").trim().toLowerCase();
	if (email.length > 254 || !EMAIL.test(email))
		return answer(false, "That doesn't look like an email address.");
	const first = (body.first_name ?? body.name ?? "").trim().slice(0, 100);
	const last = (body.last_name ?? "").trim().slice(0, 100);
	if (await alreadySubscribed(f, email)) return done();
	const ref = CODE.test(body.ref ?? "") ? body.ref : "";
	const detail = sourceDetail(body.utm_source, request);
	const token = await confirmToken(
		{
			f: f.id,
			e: email,
			...(first ? { n: first } : {}),
			...(last ? { l: last } : {}),
			...(ref ? { r: ref } : {}),
			...(detail ? { s: detail } : {}),
		},
		now,
	);
	const link = `${publicUrl()}/subscribe/confirm?t=${token}`;
	const brand = await brandName(f.organization_id);
	const { createEmails, parseSend } = await import("./send");
	const { kickDispatcher } = await import("./dispatcher");
	const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1a"><table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e7e6e1;border-radius:12px"><tr><td style="padding:32px"><p style="margin:0 0 20px;font-size:15px;font-weight:600">${esc(brand)}</p><h1 style="margin:0 0 12px;font-size:20px;font-weight:600">Confirm your subscription</h1><p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#4a4a46">Someone, hopefully you, asked to subscribe ${esc(email)} to ${esc(f.title)}.</p><p style="margin:24px 0"><a href="${esc(link)}" style="display:inline-block;background:#1c1c1a;color:#fff;text-decoration:none;font-size:14px;font-weight:500;padding:10px 18px;border-radius:8px">Yes, subscribe me</a></p><p style="margin:0;font-size:13px;color:#77776f">If it wasn't you, ignore this email: you won't be subscribed.</p></td></tr></table></body></html>`;
	const text = `Confirm your subscription\n\nSomeone, hopefully you, asked to subscribe ${email} to ${f.title}.\n\nYes, subscribe me: ${link}\n\nIf it wasn't you, ignore this email: you won't be subscribed.`;
	try {
		const [r] = await createEmails(
			f.organization_id,
			[
				parseSend({
					from: brand
						? `"${brand.replace(/["\\]/g, "")}" <${bareAddress(f.from)}>`
						: f.from,
					to: email,
					subject: `Confirm your subscription to ${f.title}`,
					html,
					text,
					tags: [{ name: "signup_form", value: f.id }],
				}),
			],
			{ source: "system", queue: true, kick: kickDispatcher, onlyDomainId: null },
		);
		if (r?.error) console.error("signup: confirmation not sent", f.id, r.error.message);
	} catch (error) {
		console.error("signup: confirmation not sent", f.id, error);
		return answer(false, "We couldn't send the confirmation email; try again later.", 503);
	}
	await db
		.update(t)
		.set({ signups: sql`${t.signups} + 1` })
		.where(eq(t.id, f.id));
	return done();
}

/** utm_source when the page had one, else the website the form was on (not Mailroom's own). */
function sourceDetail(utm: string | undefined, request: Request) {
	const u = (utm ?? "").trim().slice(0, 100);
	if (u && /^[\w .:/@-]+$/.test(u)) return u;
	const from = request.headers.get("origin") || request.headers.get("referer") || "";
	try {
		const host = new URL(from).hostname.replace(/^www\./, "");
		return host && host !== new URL(publicUrl()).hostname ? host.slice(0, 100) : "";
	} catch {
		return "";
	}
}

/** Subscribed already, and where the form puts people (then there's nothing to confirm). */
async function alreadySubscribed(f: SignupForm, email: string) {
	const c = await db
		.select()
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, f.organization_id),
				eq(schema.contacts.email, email),
			),
		)
		.get();
	if (!c || c.unsubscribed) return false;
	if (f.segment_id) {
		const inIt = await db
			.select({ id: schema.contactSegments.contact_id })
			.from(schema.contactSegments)
			.where(
				and(
					eq(schema.contactSegments.contact_id, c.id),
					eq(schema.contactSegments.segment_id, f.segment_id),
				),
			)
			.get();
		if (!inIt) return false;
	}
	return !f.topic_id;
}

/** GET /subscribe/confirm: a button that confirms (POST), so only the person subscribes. */
async function confirmPage(token: string, now: number) {
	const p = await readToken(token, now);
	const f = p ? await liveForm(p.f) : null;
	if (!p || !f)
		return page(
			"Link expired",
			"<h1>This link has expired</h1><p>Sign up again and use the link in the new email.</p>",
			400,
		);
	return page(
		"Confirm your subscription",
		`<h1>Confirm your subscription</h1><p>Get ${esc(f.title)} at ${esc(p.e)}.</p><form method="post" action="/subscribe/confirm"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Confirm</button></form>`,
	);
}

async function confirm(token: string, now: number) {
	const p = await readToken(token, now);
	const bad = page(
		"Link expired",
		"<h1>This link has expired</h1><p>Sign up again and use the link in the new email.</p>",
		400,
	);
	if (!p) return bad;
	const f = await liveForm(p.f);
	if (!f) return bad;
	const { getContact, upsertContact } = await import("./contacts");
	// The names typed on the form are for a new contact; a known one keeps theirs.
	const known = await getContact(f.organization_id, p.e).catch(() => null);
	const { created, contact } = await upsertContact(
		f.organization_id,
		{
			email: p.e,
			...(p.n && !known ? { first_name: p.n } : {}),
			...(p.l && !known ? { last_name: p.l } : {}),
			unsubscribed: false,
			...(f.segment_id ? { segments: [f.segment_id] } : {}),
			...(f.topic_id ? { topics: [{ id: f.topic_id, subscription: "opt_in" }] } : {}),
			source: p.r ? "referral" : `form:${f.id}`,
			...(p.s ? { source_detail: p.s } : {}),
		},
		now,
	);
	if (created) {
		await db
			.update(t)
			.set({ confirmed: sql`${t.confirmed} + 1` })
			.where(eq(t.id, f.id));
		if (p.r) {
			const { creditReferral } = await import("./referrals");
			await creditReferral(f.organization_id, p.r, contact, now).catch((e) =>
				console.error("signup: referral not credited", e),
			);
		}
	}
	if (f.redirect_url) return Response.redirect(f.redirect_url, 303);
	return page(
		"You're subscribed",
		`<h1>You're subscribed</h1><p>Thanks for confirming: you'll get ${esc(f.title)} at ${esc(p.e)}. Every email has a link to unsubscribe.</p>`,
	);
}
