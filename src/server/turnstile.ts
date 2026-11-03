import { and, eq, isNotNull } from "drizzle-orm";
import { db, schema } from "./db";
import { baseUrl, cfg } from "./env";
import { iso } from "./time";

/**
 * Cloudflare Turnstile on sign-up forms, set up by Mailroom itself: each brand with forms gets a
 * widget ("Mailroom · <brand>") through the API, allowed on Mailroom's own host (the hosted page)
 * and on every website its forms are on. Saving a form brings the widget's hostnames in step. It
 * needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with Account › Turnstile › Edit; without
 * them (or when Cloudflare refuses), forms work without Turnstile and say why. Free plan: 20
 * widgets, 10 hostnames each.
 */

const MAX_HOSTNAMES = 10;
const w = schema.turnstileWidgets;

export const turnstileConfigured = () =>
	!!cfg().CLOUDFLARE_ACCOUNT_ID?.trim() && !!cfg().CLOUDFLARE_API_TOKEN?.trim();

type Widget = { sitekey: string; secret: string; domains: string[] };

async function cf<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${cfg().CLOUDFLARE_ACCOUNT_ID}/challenges/widgets${path}`,
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
		errors?: { message?: string }[];
	};
	if (!res.ok || json.success === false || !json.result)
		throw new Error(
			json.errors?.map((e) => e.message).join("; ") || `Cloudflare answered ${res.status}`,
		);
	return json.result;
}

export const hostOf = (url: string | null | undefined) => {
	if (!url) return null;
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
};

/** The hostnames a brand's widget should allow: Mailroom's, then its forms' websites. */
async function wantedDomains(brand: string) {
	const rows = await db
		.select({ website: schema.signupForms.website })
		.from(schema.signupForms)
		.where(
			and(
				eq(schema.signupForms.organization_id, brand),
				isNotNull(schema.signupForms.website),
			),
		);
	const own = hostOf(baseUrl());
	const hosts = [own, ...rows.map((r) => hostOf(r.website))].filter((h): h is string => !!h);
	return [...new Set(hosts)];
}

/**
 * Makes or updates the brand's widget for its forms' websites. Returns what's wrong, or null.
 * Never throws: forms keep working without Turnstile.
 */
export async function syncTurnstile(brand: string, brandName: string, now = Date.now()) {
	if (!turnstileConfigured())
		return "Turnstile isn't set up (CLOUDFLARE_ACCOUNT_ID and an API token with Turnstile: Edit).";
	const domains = await wantedDomains(brand);
	const existing = await db.select().from(w).where(eq(w.organization_id, brand)).get();
	const over = domains.length > MAX_HOSTNAMES;
	const kept = domains.slice(0, MAX_HOSTNAMES);
	const name = `Mailroom · ${brandName}`.slice(0, 254);
	try {
		let widget: Widget;
		if (existing) {
			const same =
				existing.domains.length === kept.length &&
				existing.domains.every((d) => kept.includes(d));
			widget = same
				? existing
				: {
						...(await cf<Widget>("PUT", `/${existing.sitekey}`, {
							name,
							domains: kept,
							mode: "managed",
						})),
						secret: existing.secret,
					};
		} else {
			widget = await cf<Widget>("POST", "", { name, domains: kept, mode: "managed" });
		}
		const error = over
			? `Turnstile allows ${MAX_HOSTNAMES} websites per brand on the free plan; the others aren't covered.`
			: null;
		const row = {
			organization_id: brand,
			sitekey: widget.sitekey,
			secret: widget.secret ?? existing?.secret ?? "",
			domains: kept,
			error,
			updated_at: iso(now),
		};
		await db.insert(w).values(row).onConflictDoUpdate({ target: w.organization_id, set: row });
		return error;
	} catch (e) {
		const error = `Cloudflare didn't set up Turnstile: ${e instanceof Error ? e.message : String(e)}`;
		if (existing)
			await db
				.update(w)
				.set({ error, updated_at: iso(now) })
				.where(eq(w.organization_id, brand));
		console.error("turnstile:", brand, error);
		return error;
	}
}

/** The brand's widget, when it has a working one. */
export async function brandWidget(brand: string) {
	const row = await db.select().from(w).where(eq(w.organization_id, brand)).get();
	return row?.sitekey && row.secret ? row : null;
}

/** Whether a sign-up passed the brand's Turnstile (true when the brand has none). */
export async function verifyTurnstile(brand: string, token: string, ip: string | null) {
	const widget = await brandWidget(brand);
	if (!widget) return true;
	if (!token) return false;
	try {
		const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body: new URLSearchParams({
				secret: widget.secret,
				response: token,
				...(ip ? { remoteip: ip } : {}),
			}),
			signal: AbortSignal.timeout(5000),
		});
		const out = (await r.json()) as { success?: boolean; hostname?: string };
		return out.success === true && (!out.hostname || widget.domains.includes(out.hostname));
	} catch {
		return false;
	}
}
