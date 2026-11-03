import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { notFound, validation } from "./errors";
import { slugify } from "./newsletters";
import { iso } from "./time";

/**
 * Campaigns: several broadcasts toward one goal ("Summer promotion 2026"), say a teaser to past
 * guests, one offer to locals and another to those abroad, and a last call. Each broadcast stays
 * its own email to its own segment; the campaign shows them on one timeline, adds up how they
 * did, tags their links with its utm_campaign (utm_source=mailroom, utm_medium=email) so the
 * website's analytics see it, and a broadcast can leave out whoever another of its emails already
 * reached (someone in two of its segments gets one version, not both).
 */

export type Campaign = typeof schema.campaigns.$inferSelect;
const c = schema.campaigns;
const b = schema.broadcasts;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const campaignInput = z.object({
	name: z.string().trim().min(1).max(200),
	description: z.string().trim().max(1000).nullish(),
	/** "" or null: leave links as written. Left out on create: made from the name. */
	utm_campaign: z
		.string()
		.trim()
		.max(100)
		.regex(/^[\w.-]*$/, "utm_campaign: letters, numbers, _ . and -")
		.nullish(),
	starts_on: z
		.string()
		.regex(DATE, "starts_on looks like 2026-06-01")
		.nullish()
		.or(z.literal("")),
	ends_on: z.string().regex(DATE, "ends_on looks like 2026-08-31").nullish().or(z.literal("")),
});

export const campaignView = (x: Campaign) => ({
	object: "campaign",
	id: x.id,
	brand_id: x.organization_id,
	name: x.name,
	description: x.description,
	utm_campaign: x.utm_campaign,
	starts_on: x.starts_on,
	ends_on: x.ends_on,
	created_at: x.created_at,
	updated_at: x.updated_at,
});

export async function listCampaigns(brands: string[]) {
	if (!brands.length) return [];
	return db
		.select()
		.from(c)
		.where(inArray(c.organization_id, brands))
		.orderBy(desc(c.created_at));
}

export async function getCampaign(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(c)
		.where(and(eq(c.id, id), inArray(c.organization_id, list)))
		.get();
	if (!row) throw notFound("Campaign");
	return row;
}

const dates = (v: { starts_on?: string | null; ends_on?: string | null }) => {
	if (v.starts_on && v.ends_on && v.ends_on < v.starts_on)
		throw validation("ends_on is before starts_on");
};

export async function createCampaign(brand: string, raw: unknown, now = Date.now()) {
	const v = campaignInput.parse(raw);
	dates(v);
	const [row] = await db
		.insert(c)
		.values({
			id: `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: brand,
			name: v.name,
			description: v.description || null,
			utm_campaign: v.utm_campaign === undefined ? slugify(v.name) : v.utm_campaign || null,
			starts_on: v.starts_on || null,
			ends_on: v.ends_on || null,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as Campaign;
}

export async function updateCampaign(brand: string, id: string, raw: unknown, now = Date.now()) {
	const x = await getCampaign(brand, id);
	const v = campaignInput.partial().parse(raw ?? {});
	const next = {
		name: v.name ?? x.name,
		description: v.description !== undefined ? v.description || null : x.description,
		utm_campaign: v.utm_campaign !== undefined ? v.utm_campaign || null : x.utm_campaign,
		starts_on: v.starts_on !== undefined ? v.starts_on || null : x.starts_on,
		ends_on: v.ends_on !== undefined ? v.ends_on || null : x.ends_on,
	};
	dates(next);
	const [row] = await db
		.update(c)
		.set({ ...next, updated_at: iso(now) })
		.where(eq(c.id, id))
		.returning();
	return row as Campaign;
}

/** Its broadcasts stay, on their own. */
export async function deleteCampaign(brand: string, id: string) {
	const x = await getCampaign(brand, id);
	await db
		.update(b)
		.set({ campaign_id: null, campaign_dedupe: false })
		.where(eq(b.campaign_id, id));
	await db.delete(c).where(eq(c.id, id));
	return x;
}

/** Its broadcasts, in the order they go (drafts last). */
export async function campaignBroadcasts(id: string) {
	return db
		.select()
		.from(b)
		.where(eq(b.campaign_id, id))
		.orderBy(sql`COALESCE(${b.started_at}, ${b.scheduled_at}, '9999')`, asc(b.created_at));
}

/** How each of its broadcasts did, and all of them together (each contact counted once). */
export async function campaignReport(id: string) {
	const e = schema.emails;
	const per = await db
		.select({
			id: e.broadcast_id,
			sent: sql<number>`SUM(CASE WHEN ${e.sent_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			delivered: sql<number>`SUM(CASE WHEN ${e.delivered_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			opened: sql<number>`SUM(CASE WHEN ${e.opened_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			clicked: sql<number>`SUM(CASE WHEN ${e.clicked_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			bounced: sql<number>`SUM(CASE WHEN ${e.status} = 'bounced' THEN 1 ELSE 0 END)`,
			complained: sql<number>`SUM(CASE WHEN ${e.complained_at} IS NOT NULL THEN 1 ELSE 0 END)`,
		})
		.from(e)
		.where(
			inArray(e.broadcast_id, db.select({ id: b.id }).from(b).where(eq(b.campaign_id, id))),
		)
		.groupBy(e.broadcast_id);
	const people = await db
		.select({
			reached: sql<number>`COUNT(DISTINCT CASE WHEN ${e.sent_at} IS NOT NULL THEN lower(json_extract(${e.to}, '$[0]')) END)`,
			opened: sql<number>`COUNT(DISTINCT CASE WHEN ${e.opened_at} IS NOT NULL THEN lower(json_extract(${e.to}, '$[0]')) END)`,
			clicked: sql<number>`COUNT(DISTINCT CASE WHEN ${e.clicked_at} IS NOT NULL THEN lower(json_extract(${e.to}, '$[0]')) END)`,
		})
		.from(e)
		.where(
			inArray(e.broadcast_id, db.select({ id: b.id }).from(b).where(eq(b.campaign_id, id))),
		)
		.get();
	const unsub = await db
		.select({ n: sql<number>`COUNT(*)` })
		.from(schema.emailEvents)
		.where(
			and(
				eq(schema.emailEvents.type, "email.unsubscribed"),
				inArray(
					schema.emailEvents.email_id,
					db
						.select({ id: e.id })
						.from(e)
						.where(
							inArray(
								e.broadcast_id,
								db.select({ id: b.id }).from(b).where(eq(b.campaign_id, id)),
							),
						),
				),
			),
		)
		.get();
	const n = (v: unknown) => Number(v ?? 0);
	const byBroadcast = Object.fromEntries(
		per.map((r) => [
			r.id as string,
			{
				sent: n(r.sent),
				delivered: n(r.delivered),
				opened: n(r.opened),
				clicked: n(r.clicked),
				bounced: n(r.bounced),
				complained: n(r.complained),
			},
		]),
	);
	const sum = (k: keyof (typeof byBroadcast)[string]) =>
		Object.values(byBroadcast).reduce((a, r) => a + r[k], 0);
	return {
		by_broadcast: byBroadcast,
		totals: {
			emails: sum("sent"),
			delivered: sum("delivered"),
			opened: sum("opened"),
			clicked: sum("clicked"),
			bounced: sum("bounced"),
			complained: sum("complained"),
			unsubscribed: n(unsub?.n),
			people: n(people?.reached),
			people_opened: n(people?.opened),
			people_clicked: n(people?.clicked),
		},
	};
}

/** Campaigns' broadcast counts and how far each got, for the list. */
export async function campaignCounts(ids: string[]) {
	if (!ids.length) return new Map<string, { total: number; sent: number }>();
	const rows = await db
		.select({
			id: b.campaign_id,
			total: sql<number>`COUNT(*)`,
			sent: sql<number>`SUM(CASE WHEN ${b.status} IN ('sending','sent','testing') THEN 1 ELSE 0 END)`,
		})
		.from(b)
		.where(inArray(b.campaign_id, ids))
		.groupBy(b.campaign_id);
	return new Map(
		rows.map((r) => [r.id as string, { total: Number(r.total), sent: Number(r.sent) }]),
	);
}

/**
 * Adds utm_source=mailroom, utm_medium=email and utm_campaign to each web link that has no
 * utm_campaign of its own. Mailroom's own links (unsubscribe, polls, the web version) and
 * placeholders are left alone.
 */
export function tagLinks(html: string, campaign: string) {
	const own = baseUrl();
	return html.replace(
		/(<a\b[^>]*?\shref\s*=\s*)("([^"]*)"|'([^']*)')/gi,
		(whole, pre: string, _q, dq?: string, sq?: string) => {
			const href = dq ?? sq ?? "";
			if (!/^https?:\/\//i.test(href) || /\{\{\{/.test(href) || (own && href.startsWith(own)))
				return whole;
			let u: URL;
			try {
				u = new URL(href.replace(/&amp;/g, "&"));
			} catch {
				return whole;
			}
			if (u.searchParams.has("utm_campaign")) return whole;
			if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", "mailroom");
			if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "email");
			u.searchParams.set("utm_campaign", campaign);
			const out = u.toString().replace(/&/g, "&amp;").replace(/"/g, "%22");
			return `${pre}"${out}"`;
		},
	);
}

/** A broadcast's campaign's utm_campaign, cached for a Dispatcher run. */
const cache = new Map<string, { at: number; value: string | null }>();
export async function utmOf(campaignId: string | null) {
	if (!campaignId) return null;
	const hit = cache.get(campaignId);
	if (hit && hit.at > Date.now() - 30_000) return hit.value;
	const row = await db.select({ utm: c.utm_campaign }).from(c).where(eq(c.id, campaignId)).get();
	const value = row?.utm ?? null;
	cache.set(campaignId, { at: Date.now(), value });
	return value;
}
