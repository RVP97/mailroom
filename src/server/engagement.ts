import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Contact } from "./contacts";
import { db, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

/**
 * Contacts' engagement, like Mailchimp's contact rating and Kit's cold subscribers: from the
 * marketing emails (broadcasts and automations) each one got lately, how much they open and
 * click and how recently. Worked out when asked, from the emails table, so it's never stale.
 * Apple Mail opens emails by itself, so clicks and recency weigh as much as opens.
 */

export const LEVELS = ["champion", "engaged", "cooling", "cold", "new"] as const;
export type Level = (typeof LEVELS)[number];

export type Stats = {
	sent: number;
	opened: number;
	clicked: number;
	last_sent_at: string | null;
	last_engaged_at: string | null;
};

const DAY = 86_400_000;
export const WINDOW_DAYS = 90;

const em = schema.emails;
const recipient = sql<string>`lower(json_extract(${em.to}, '$[0]'))`;

/** Each recipient's marketing emails since `days` ago (all of them, or those addresses'). */
export async function engagementStats(
	brand: string,
	o: { addresses?: string[]; days?: number; now?: number } = {},
): Promise<Map<string, Stats>> {
	const since = iso((o.now ?? Date.now()) - (o.days ?? WINDOW_DAYS) * DAY);
	if (o.addresses && !o.addresses.length) return new Map();
	const rows = await db
		.select({
			address: recipient,
			sent: sql<number>`COUNT(*)`,
			opened: sql<number>`COUNT(${em.opened_at})`,
			clicked: sql<number>`COUNT(${em.clicked_at})`,
			last_sent_at: sql<string | null>`MAX(${em.created_at})`,
			last_engaged_at: sql<
				string | null
			>`MAX(MAX(COALESCE(${em.clicked_at}, '')), MAX(COALESCE(${em.opened_at}, '')))`,
		})
		.from(em)
		.where(
			and(
				eq(em.organization_id, brand),
				sql`${em.created_at} >= ${since}`,
				or(isNotNull(em.broadcast_id), eq(em.source, "automation")),
				sql`${em.status} NOT IN ('scheduled', 'queued', 'sending', 'failed', 'suppressed', 'canceled', 'bounced')`,
				o.addresses
					? inArray(
							recipient,
							o.addresses.map((a) => a.toLowerCase()),
						)
					: undefined,
			),
		)
		.groupBy(recipient);
	return new Map(
		rows.map((r) => [
			r.address,
			{
				sent: Number(r.sent),
				opened: Number(r.opened),
				clicked: Number(r.clicked),
				last_sent_at: r.last_sent_at,
				last_engaged_at: r.last_engaged_at || null,
			},
		]),
	);
}

/** A 0–100 score, its level and 1–5 stars. Fewer than three emails is too new to tell. */
export function scoreOf(s: Stats | undefined, now = Date.now()) {
	if (!s || (s.sent < 3 && !s.opened && !s.clicked))
		return { score: null, level: "new" as Level, stars: 0 };
	const openRate = Math.min(1, (s.opened / s.sent) * 1.25);
	const clickRate = Math.min(1, (s.clicked / s.sent) * 4);
	const days = s.last_engaged_at
		? (now - Date.parse(s.last_engaged_at)) / DAY
		: Number.POSITIVE_INFINITY;
	const recency = days <= 7 ? 1 : days <= 30 ? 0.75 : days <= 60 ? 0.45 : days <= 90 ? 0.2 : 0;
	const score = Math.round(100 * (0.35 * openRate + 0.3 * clickRate + 0.35 * recency));
	const level: Level =
		// Opens alone can be Apple Mail's own: the top level takes a click too.
		score >= 70 && s.clicked > 0
			? "champion"
			: score >= 40
				? "engaged"
				: score >= 15
					? "cooling"
					: "cold";
	return { score, level, stars: Math.max(1, Math.ceil(score / 20)) };
}

export type Engagement = ReturnType<typeof scoreOf> & Partial<Stats>;

/** Engagement of some contacts (a page of them). */
export async function engagementOf(brand: string, contacts: Pick<Contact, "id" | "email">[]) {
	const now = Date.now();
	const stats = await engagementStats(brand, {
		addresses: contacts.map((c) => c.email),
		now,
	});
	return new Map<string, Engagement>(
		contacts.map((c) => {
			const s = stats.get(c.email.toLowerCase());
			return [c.id, { ...scoreOf(s, now), ...s }];
		}),
	);
}

const ct = schema.contacts;

async function subscribed(brand: string) {
	return db
		.select({
			id: ct.id,
			email: ct.email,
			first_name: ct.first_name,
			last_name: ct.last_name,
			created_at: ct.created_at,
		})
		.from(ct)
		.where(and(eq(ct.organization_id, brand), eq(ct.unsubscribed, false)))
		.limit(50_000);
}

/** How the brand's subscribed contacts spread over the levels, and its averages. */
export async function engagementOverview(brand: string, now = Date.now()) {
	const [people, stats] = await Promise.all([subscribed(brand), engagementStats(brand, { now })]);
	const levels = Object.fromEntries(LEVELS.map((l) => [l, 0])) as Record<Level, number>;
	let sent = 0;
	let opened = 0;
	let clicked = 0;
	for (const c of people) {
		const s = stats.get(c.email.toLowerCase());
		levels[scoreOf(s, now).level]++;
		if (s) {
			sent += s.sent;
			opened += s.opened;
			clicked += s.clicked;
		}
	}
	return {
		total: people.length,
		levels,
		open_rate: sent ? opened / sent : null,
		click_rate: sent ? clicked / sent : null,
		window_days: WINDOW_DAYS,
	};
}

export const coldInput = z.object({
	/** Got at least this many of the brand's marketing emails… */
	min_emails: z.number().int().min(1).max(50).default(5),
	/** …in this many days, and opened and clicked none of them. */
	days: z.number().int().min(7).max(365).default(90),
});

/** Subscribed contacts who got emails lately and opened and clicked none (Kit's "cold"). */
export async function coldContacts(brand: string, raw: unknown, now = Date.now()) {
	const v = coldInput.parse(raw ?? {});
	const [people, stats] = await Promise.all([
		subscribed(brand),
		engagementStats(brand, { days: v.days, now }),
	]);
	// Joined before the window: a newer contact hasn't had the chance.
	const since = iso(now - v.days * DAY);
	return people
		.map((c) => ({ ...c, stats: stats.get(c.email.toLowerCase()) }))
		.filter(
			(c): c is typeof c & { stats: Stats } =>
				!!c.stats &&
				c.stats.sent >= v.min_emails &&
				!c.stats.opened &&
				!c.stats.clicked &&
				c.created_at <= since,
		)
		.sort((a, b) => b.stats.sent - a.stats.sent)
		.map((c) => ({
			id: c.id,
			email: c.email,
			first_name: c.first_name,
			last_name: c.last_name,
			created_at: c.created_at,
			sent: c.stats.sent,
			last_sent_at: c.stats.last_sent_at,
		}));
}

export const cleanUpInput = coldInput.extend({
	action: z.enum(["segment", "unsubscribe", "delete"]),
	segment_id: z.string().nullish(),
	/** Only these (of the cold ones); all of them when left out. */
	ids: z.array(z.string()).max(5000).optional(),
});

/** Does something with the cold contacts: groups them, unsubscribes them, or deletes them. */
export async function cleanUpCold(brand: string, raw: unknown, now = Date.now()) {
	const v = cleanUpInput.parse(raw);
	let cold = await coldContacts(brand, v, now);
	if (v.ids) {
		const only = new Set(v.ids);
		cold = cold.filter((c) => only.has(c.id));
	}
	const ids = cold.slice(0, 5000).map((c) => c.id);
	if (!ids.length) return { count: 0 };
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
	if (v.action === "segment") {
		if (!v.segment_id) throw validation("Pick a segment");
		const { addToSegment, segmentOf } = await import("./contacts");
		await segmentOf(brand, v.segment_id);
		for (const id of ids) await addToSegment(brand, id, v.segment_id, now);
	} else if (v.action === "unsubscribe") {
		const { syncGlobalUnsubscribe } = await import("./contacts");
		for (const chunk of chunks)
			await db
				.update(ct)
				.set({
					unsubscribed: true,
					unsubscribed_at: sql`COALESCE(${ct.unsubscribed_at}, ${iso(now)})`,
					updated_at: iso(now),
				})
				.where(and(eq(ct.organization_id, brand), inArray(ct.id, chunk)));
		// Their addresses leave every broadcast too (as when one unsubscribes).
		for (const c of cold.slice(0, 5000))
			await syncGlobalUnsubscribe({ organization_id: brand, email: c.email }, true);
	} else {
		for (const chunk of chunks)
			await db.delete(ct).where(and(eq(ct.organization_id, brand), inArray(ct.id, chunk)));
	}
	return { count: ids.length };
}
