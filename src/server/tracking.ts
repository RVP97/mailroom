import { env } from "cloudflare:workers";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { validZone } from "../lib/zoned";
import { bareAddress } from "./aws/mime";
import { db, schema } from "./db";
import { baseUrl, cfg } from "./env";
import { ApiError, validation } from "./errors";
import { applySesEvent } from "./events";
import { forgetOrg } from "./org";
import { getSetting } from "./settings";
import { iso } from "./time";

/**
 * Open and click tracking, done by Mailroom itself instead of SES. SES's own tracking sends
 * every link through its shared awstrack.me domain, which spam filters see on everyone's mail
 * and readers see in the status bar. Mailroom rewrites the HTML when it sends:
 * - each http(s) link becomes https://<tracking host>/c/<email id>/<url>/<signature>, which
 *   records the click and redirects;
 * - a 1×1 image https://<tracking host>/o/<email id>/<signature> records the open.
 * The tracking host is the domain's own links.<domain> once its CNAME and certificate are in
 * place (a Cloudflare for SaaS custom hostname on TRACKING_ZONE_ID), else Mailroom's address.
 * Clicks and opens go through applySesEvent as SES's did: counters, webhooks, timelines.
 *
 * It starts once the configuration sets no longer ask SES for opens and clicks (the setting
 * own_tracking_at, set by syncEventDestinations); until then SES tracks as before.
 */

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

let hmacKey: Promise<CryptoKey> | null = null;
const key = () => {
	hmacKey ??= crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(
			`tracking:${(env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? ""}`,
		),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hmacKey;
};

async function sign(value: string) {
	const mac = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(value));
	return b64url(new Uint8Array(mac).slice(0, 12));
}

const same = (a: string, b: string) => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

export async function clickUrl(base: string, emailId: string, url: string) {
	const u = b64url(new TextEncoder().encode(url));
	return `${base}/c/${emailId}/${u}/${await sign(`c:${emailId}:${url}`)}`;
}

export async function openUrl(base: string, emailId: string) {
	return `${base}/o/${emailId}/${await sign(`o:${emailId}`)}`;
}

/** The domain's tracking settings, as sending needs them. */
export interface Tracking {
	open: boolean;
	click: boolean;
	/** https://links.example.com, or Mailroom's own address. */
	base: string;
}

/** Whether Mailroom tracks opens and clicks itself yet (see the note at the top). */
export const ownTracking = async () => !!(await getSetting("own_tracking_at"));

export const trackingBase = (d: {
	tracking_host: string | null;
	tracking_status: string | null;
}) =>
	d.tracking_host && d.tracking_status === "active" ? `https://${d.tracking_host}` : baseUrl();

const UNTRACKED = /^(mailto:|tel:|sms:|#|\{\{)/i;

/**
 * The HTML with its links sent through Mailroom and the open image added. Links Mailroom
 * itself put there (unsubscribe), placeholders and non-web links stay as they are, and so does
 * any `<a data-mailroom-track="false">`.
 */
export async function trackHtml(html: string, emailId: string, t: Tracking): Promise<string> {
	let out = html;
	if (t.click) {
		// The unsubscribe link, on Mailroom's address or the domain's own host.
		const owns = [`${baseUrl()}/unsubscribe`, `${t.base}/unsubscribe`];
		const parts: string[] = [];
		const re = /<a\b[^>]*>/gi;
		let last = 0;
		for (let m = re.exec(html); m; m = re.exec(html)) {
			const tag = m[0];
			parts.push(html.slice(last, m.index));
			last = m.index + tag.length;
			const href = /\shref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
			const raw = href?.[2] ?? href?.[3];
			const url = raw?.trim().replace(/&amp;/g, "&");
			if (
				!href ||
				!url ||
				UNTRACKED.test(url) ||
				!/^https?:\/\//i.test(url) ||
				owns.some((own) => url.startsWith(own)) ||
				/\sdata-mailroom-track\s*=\s*["']?false/i.test(tag)
			) {
				parts.push(tag);
				continue;
			}
			const tracked = (await clickUrl(t.base, emailId, url)).replace(/&/g, "&amp;");
			parts.push(tag.replace(href[0], ` href="${tracked}"`));
		}
		parts.push(html.slice(last));
		out = parts.join("");
	}
	if (t.open) {
		const img = `<img src="${await openUrl(t.base, emailId)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0" />`;
		out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${img}</body>`) : `${out}${img}`;
	}
	return out;
}

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) =>
	c.charCodeAt(0),
);

const UUID = /^[0-9a-f-]{36}$/;

/** /c/… and /o/…: on Mailroom's address and on every domain's tracking host. */
export async function handleTracking(request: Request, ctx?: ExecutionContext) {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter(Boolean);
	const record = (event: Parameters<typeof applySesEvent>[0]) => {
		const work = applySesEvent(event, `track:${crypto.randomUUID()}`).catch((error) =>
			console.error("tracking: not recorded", error),
		);
		// The redirect or image doesn't wait for the bookkeeping.
		if (ctx) ctx.waitUntil(work);
		else return work;
	};
	const who = {
		timestamp: iso(),
		ipAddress: request.headers.get("cf-connecting-ip") ?? undefined,
		userAgent: request.headers.get("user-agent") ?? undefined,
	};
	if (parts[0] === "c" && parts.length === 4) {
		const [, emailId, encoded, sig] = parts as [string, string, string, string];
		const bytes = fromB64url(encoded);
		const target = bytes ? new TextDecoder().decode(bytes) : "";
		if (
			!UUID.test(emailId) ||
			!/^https?:\/\//i.test(target) ||
			!same(sig, await sign(`c:${emailId}:${target}`))
		)
			return new Response("This link isn't valid.", { status: 404 });
		// Link checkers ask with HEAD: no click.
		if (request.method === "GET") {
			await record(click(emailId, target, who));
			await learn(emailId, request, ctx);
		}
		return new Response(null, {
			status: 302,
			headers: {
				location: target,
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}
	if (parts[0] === "o" && parts.length === 3) {
		const [, emailId, sig] = parts as [string, string, string];
		if (
			UUID.test(emailId) &&
			same(sig, await sign(`o:${emailId}`)) &&
			request.method === "GET"
		) {
			await record(open(emailId, who));
			// Gmail's and Yahoo's image proxies open from their own data centers, not the reader's.
			if (!/GoogleImageProxy|YahooMailProxy/i.test(who.userAgent ?? ""))
				await learn(emailId, request, ctx);
		}
		return new Response(request.method === "HEAD" ? null : GIF, {
			headers: {
				"content-type": "image/gif",
				"cache-control": "no-store, no-cache, must-revalidate, max-age=0",
			},
		});
	}
	return new Response("Not found", { status: 404 });
}

/** The reader's time zone, from where they opened or clicked, kept on their contact. */
async function learn(emailId: string, request: Request, ctx?: ExecutionContext) {
	const tz = (request as Request & { cf?: { timezone?: string } }).cf?.timezone;
	if (!validZone(tz)) return;
	const work = learnTimezone(emailId, tz).catch((error) =>
		console.error("tracking: time zone not kept", error),
	);
	if (ctx) ctx.waitUntil(work);
	else await work;
}

export async function learnTimezone(emailId: string, tz: string) {
	const e = await db
		.select({ org: schema.emails.organization_id, to: schema.emails.to })
		.from(schema.emails)
		.where(eq(schema.emails.id, emailId))
		.get();
	const to = e?.to[0];
	if (!e || !to) return;
	const c = schema.contacts;
	await db
		.update(c)
		.set({ timezone: tz })
		.where(
			and(
				eq(c.organization_id, e.org),
				eq(c.email, bareAddress(to).toLowerCase()),
				or(isNull(c.timezone), ne(c.timezone, tz)),
			),
		);
}

type Who = { timestamp: string; ipAddress?: string; userAgent?: string };
const mail = (emailId: string) => ({ tags: { mailroom_id: [emailId] } });
const click = (emailId: string, link: string, who: Who) => ({
	eventType: "Click",
	mail: mail(emailId),
	click: { ...who, link },
});
const open = (emailId: string, who: Who) => ({
	eventType: "Open",
	mail: mail(emailId),
	open: who,
});

// ── The domain's own tracking host (Cloudflare for SaaS) ───────────────────

/** Where links.<domain> points: the SaaS zone's fallback origin. */
export const trackingTarget = () => cfg().TRACKING_CNAME_TARGET ?? "";

export const customTrackingConfigured = () =>
	!!cfg().TRACKING_ZONE_ID && !!cfg().CLOUDFLARE_API_TOKEN && !!trackingTarget();

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/zones/${cfg().TRACKING_ZONE_ID}${path}`,
		{
			method,
			headers: {
				authorization: `Bearer ${cfg().CLOUDFLARE_API_TOKEN}`,
				"content-type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		},
	);
	const json = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		result?: T;
		errors?: { code?: number; message?: string }[];
	};
	if (!res.ok || json.success === false)
		throw new ApiError(
			502,
			"cloudflare_error",
			json.errors?.map((e) => e.message).join("; ") || `Cloudflare ${res.status}`,
		);
	return json.result as T;
}

interface CustomHostname {
	id: string;
	hostname: string;
	status?: string;
	ssl?: { status?: string };
	verification_errors?: string[];
}

async function domainRow(organizationId: string, id: string) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	return d;
}

/** Turns open and click tracking on or off for a domain. */
export async function setTracking(
	organizationId: string,
	id: string,
	change: { open?: boolean; click?: boolean },
) {
	await domainRow(organizationId, id);
	const set: Partial<typeof schema.domains.$inferInsert> = {};
	if (change.open !== undefined) set.open_tracking = change.open;
	if (change.click !== undefined) set.click_tracking = change.click;
	if (Object.keys(set).length)
		await db.update(schema.domains).set(set).where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	return domainRow(organizationId, id);
}

/**
 * Starts tracking on links.<domain>: a custom hostname (its certificate comes once the CNAME is
 * in place) and a Worker route that brings its requests here.
 */
/** A tracking subdomain's own label: links, track, go… (one DNS label). */
export const TRACKING_PREFIX = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

export async function addTrackingHost(organizationId: string, id: string, prefix = "links") {
	if (!TRACKING_PREFIX.test(prefix))
		throw validation("Use one word of letters, numbers or hyphens, like links or track");
	if (!customTrackingConfigured())
		throw new ApiError(
			409,
			"tracking_not_configured",
			"Tracking on your own domain isn't set up on this deployment yet",
		);
	const d = await domainRow(organizationId, id);
	if (d.tracking_host) return checkTrackingHost(organizationId, id);
	const hostname = `${prefix}.${d.name}`;
	if (hostname.length > 253) throw validation("This domain is too long for a tracking host");
	let ch: CustomHostname;
	try {
		ch = await cf<CustomHostname>("POST", "/custom_hostnames", {
			hostname,
			ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
		});
	} catch (error) {
		// Already there (added before, say): reuse it.
		const [existing] = await cf<CustomHostname[]>(
			"GET",
			`/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
		).catch(() => []);
		if (!existing) throw error;
		ch = existing;
	}
	let routeId: string | null = null;
	try {
		routeId = (
			await cf<{ id: string }>("POST", "/workers/routes", {
				pattern: `${hostname}/*`,
				script: "mailroom",
			})
		).id;
	} catch (error) {
		const routes = await cf<{ id: string; pattern: string }[]>("GET", "/workers/routes");
		routeId = routes.find((r) => r.pattern === `${hostname}/*`)?.id ?? null;
		if (!routeId) throw error;
	}
	await db
		.update(schema.domains)
		.set({
			tracking_host: hostname,
			tracking_status: "pending",
			tracking_hostname_id: ch.id,
			tracking_route_id: routeId,
			tracking_checked_at: iso(),
		})
		.where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	return checkTrackingHost(organizationId, id);
}

/** Asks Cloudflare whether links.<domain> is live (CNAME found, certificate issued). */
export async function checkTrackingHost(organizationId: string, id: string) {
	const d = await domainRow(organizationId, id);
	if (!d.tracking_hostname_id) return d;
	const ch = await cf<CustomHostname>("GET", `/custom_hostnames/${d.tracking_hostname_id}`);
	const status =
		ch.status === "active" && ch.ssl?.status === "active"
			? "active"
			: ch.status === "blocked" || ch.status === "moved" || ch.status === "deleted"
				? "failed"
				: "pending";
	await db
		.update(schema.domains)
		.set({ tracking_status: status, tracking_checked_at: iso() })
		.where(eq(schema.domains.id, id));
	if (status !== d.tracking_status) forgetOrg(organizationId);
	return { ...d, tracking_status: status, tracking_checked_at: iso() };
}

/** Back to Mailroom's own address: the custom hostname and its route go. */
export async function removeTrackingHost(organizationId: string, id: string) {
	const d = await domainRow(organizationId, id);
	await dropTrackingHost(d);
	await db
		.update(schema.domains)
		.set({
			tracking_host: null,
			tracking_status: null,
			tracking_hostname_id: null,
			tracking_route_id: null,
			tracking_checked_at: null,
		})
		.where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
}

/** Removes a domain's custom hostname and route at Cloudflare (gone already is fine). */
export async function dropTrackingHost(d: {
	tracking_hostname_id: string | null;
	tracking_route_id: string | null;
}) {
	if (!customTrackingConfigured()) return;
	if (d.tracking_route_id)
		await cf("DELETE", `/workers/routes/${d.tracking_route_id}`).catch((error) =>
			console.error("tracking: route not removed", error),
		);
	if (d.tracking_hostname_id)
		await cf("DELETE", `/custom_hostnames/${d.tracking_hostname_id}`).catch((error) =>
			console.error("tracking: hostname not removed", error),
		);
}

/** Cron: tracking hosts still waiting for their CNAME are checked again. */
export async function checkPendingTrackingHosts(limit = 10) {
	if (!customTrackingConfigured()) return;
	const rows = await db
		.select({ id: schema.domains.id, organization_id: schema.domains.organization_id })
		.from(schema.domains)
		.where(
			and(
				isNotNull(schema.domains.tracking_hostname_id),
				inArray(schema.domains.tracking_status, ["pending"]),
			),
		)
		.limit(limit);
	for (const r of rows)
		await checkTrackingHost(r.organization_id, r.id).catch((error) =>
			console.error("tracking: check failed", error),
		);
}
