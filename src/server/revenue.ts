import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * Revenue and who earned it. An event with a value (POST /api/events with `value` and
 * `currency`, or data.value / data.revenue / data.total and data.currency) is a purchase. When it
 * comes in, the credit goes to the last thing that reached the person within CREDIT_DAYS: a
 * broadcast or automation email they opened or clicked, or a website chat they wrote in. The
 * credit is kept on the event, so the reports are plain sums: per broadcast, automation and
 * campaign (through its broadcasts), and the Revenue page in Insights.
 */

export const CREDIT_DAYS = 7;
const DAY = 86_400_000;
const e = schema.contactEvents;

export type CreditType = "broadcast" | "automation" | "chat";
export interface Credit {
	type: CreditType;
	id: string;
	email_id: string | null;
	at: string;
}

const CURRENCY = /^[A-Za-z]{3}$/;

/** The amount and currency of an event, from its own fields or its data; null when it has none. */
export function purchaseOf(v: {
	value?: number | null;
	currency?: string | null;
	data?: Record<string, unknown> | null;
}): { value: number; currency: string | null } | null {
	const d = v.data ?? {};
	const pick = (x: unknown) => {
		const n = typeof x === "string" && x.trim() !== "" ? Number(x) : x;
		return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 1e10 ? n : null;
	};
	const value = pick(v.value) ?? pick(d.value) ?? pick(d.revenue) ?? pick(d.total);
	if (value === null) return null;
	const c = [v.currency, d.currency].find((x) => typeof x === "string" && CURRENCY.test(x));
	return {
		value: Math.round(value * 100) / 100,
		currency: typeof c === "string" ? c.toUpperCase() : null,
	};
}

/** The last broadcast, automation email or chat that reached this address within CREDIT_DAYS. */
export async function creditFor(
	brand: string,
	address: string,
	now = Date.now(),
): Promise<Credit | null> {
	const a = address.trim().toLowerCase();
	const since = iso(now - CREDIT_DAYS * DAY);
	const at = iso(now);
	const [email, chat] = await Promise.all([
		db.get<{
			id: string;
			broadcast_id: string | null;
			source: string;
			automation: string | null;
			touched: string;
		}>(sql`SELECT id, broadcast_id, source,
			(SELECT json_extract(j.value, '$.value') FROM json_each(emails.tags) AS j WHERE json_extract(j.value, '$.name') = 'automation') AS automation,
			max(coalesce(clicked_at, ''), coalesce(opened_at, '')) AS touched
			FROM emails
			WHERE organization_id = ${brand} AND recipient = ${a}
				AND created_at > ${iso(now - 45 * DAY)}
				AND source IN ('broadcast', 'automation')
				AND ((clicked_at > ${since} AND clicked_at <= ${at}) OR (opened_at > ${since} AND opened_at <= ${at}))
			ORDER BY touched DESC LIMIT 1`),
		db.get<{ id: string; touched: string }>(sql`SELECT id, last_inbound_at AS touched
			FROM conversations
			WHERE organization_id = ${brand} AND contact_address = ${a} AND channel = 'chat'
				AND last_inbound_at > ${since} AND last_inbound_at <= ${at}
			ORDER BY last_inbound_at DESC LIMIT 1`),
	]);
	const fromEmail: Credit | null = email
		? email.broadcast_id
			? { type: "broadcast", id: email.broadcast_id, email_id: email.id, at: email.touched }
			: email.automation
				? {
						type: "automation",
						id: email.automation,
						email_id: email.id,
						at: email.touched,
					}
				: null
		: null;
	const fromChat: Credit | null = chat
		? { type: "chat", id: chat.id, email_id: null, at: chat.touched }
		: null;
	if (fromEmail && fromChat) return fromEmail.at >= fromChat.at ? fromEmail : fromChat;
	return fromEmail ?? fromChat;
}

export interface Money {
	currency: string | null;
	total: number;
	purchases: number;
}

const money = (rows: { currency: string | null; total: number; n: number }[]): Money[] =>
	rows
		.map((r) => ({
			currency: r.currency,
			total: Math.round(Number(r.total) * 100) / 100,
			purchases: Number(r.n),
		}))
		.sort((x, y) => y.total - x.total);

/** What one broadcast, automation or campaign earned (each currency apart). */
export async function revenueOf(
	kind: "broadcast" | "automation" | "campaign",
	id: string,
): Promise<Money[]> {
	const where =
		kind === "campaign"
			? and(
					eq(e.credit_type, "broadcast"),
					inArray(
						e.credit_id,
						db
							.select({ id: schema.broadcasts.id })
							.from(schema.broadcasts)
							.where(eq(schema.broadcasts.campaign_id, id)),
					),
				)
			: and(eq(e.credit_type, kind), eq(e.credit_id, id));
	const rows = await db
		.select({
			currency: e.currency,
			total: sql<number>`sum(${e.value})`,
			n: sql<number>`count(*)`,
		})
		.from(e)
		.where(where)
		.groupBy(e.currency);
	return money(rows);
}

/** Revenue for many broadcasts or automations at once (their lists). */
export async function revenueByCredit(kind: "broadcast" | "automation", ids: string[]) {
	const out = new Map<string, Money[]>();
	if (!ids.length) return out;
	const rows = await db
		.select({
			id: e.credit_id,
			currency: e.currency,
			total: sql<number>`sum(${e.value})`,
			n: sql<number>`count(*)`,
		})
		.from(e)
		.where(and(eq(e.credit_type, kind), inArray(e.credit_id, ids.slice(0, 90))))
		.groupBy(e.credit_id, e.currency);
	for (const r of rows) {
		const list = out.get(r.id as string) ?? [];
		list.push(...money([r]));
		out.set(r.id as string, list);
	}
	return out;
}

/**
 * The Revenue page: what came in over `days` (each currency apart), how much of it email and
 * chat earned, per kind of credit, the top broadcasts, automations and campaigns, day by day, and
 * the latest purchases.
 */
export async function revenueReport(brands: string[], days: number, now = Date.now()) {
	const empty = {
		days,
		credit_days: CREDIT_DAYS,
		currency: null as string | null,
		totals: [] as (Money & { credited: number; credited_purchases: number })[],
		by_type: [] as { type: CreditType | "none"; total: number; purchases: number }[],
		broadcasts: [] as { id: string; name: string; total: number; purchases: number }[],
		automations: [] as { id: string; name: string; total: number; purchases: number }[],
		campaigns: [] as { id: string; name: string; total: number; purchases: number }[],
		daily: [] as { day: string; total: number; credited: number }[],
		latest: [] as {
			id: string;
			event: string;
			email: string;
			contact_id: string;
			value: number;
			currency: string | null;
			credit_type: string | null;
			credit_id: string | null;
			credit_name: string | null;
			created_at: string;
		}[],
	};
	if (!brands.length) return empty;
	const since = iso(now - days * DAY);
	const scope = and(
		inArray(e.organization_id, brands),
		isNotNull(e.value),
		sql`${e.created_at} > ${since}`,
	);
	const totals = await db
		.select({
			currency: e.currency,
			total: sql<number>`sum(${e.value})`,
			n: sql<number>`count(*)`,
			credited: sql<number>`coalesce(sum(CASE WHEN ${e.credit_id} IS NOT NULL THEN ${e.value} END), 0)`,
			credited_n: sql<number>`count(${e.credit_id})`,
		})
		.from(e)
		.where(scope)
		.groupBy(e.currency);
	if (!totals.length) return empty;
	const list = totals
		.map((t) => ({
			currency: t.currency,
			total: Math.round(Number(t.total) * 100) / 100,
			purchases: Number(t.n),
			credited: Math.round(Number(t.credited) * 100) / 100,
			credited_purchases: Number(t.credited_n),
		}))
		.sort((x, y) => y.total - x.total);
	// The breakdowns are in the main currency (the one with the most revenue).
	const main = list[0]?.currency ?? null;
	const inMain = and(scope, main === null ? sql`${e.currency} IS NULL` : eq(e.currency, main));
	const sum = sql<number>`sum(${e.value})`;
	const count = sql<number>`count(*)`;
	const [byType, byBroadcast, byAutomation, byCampaign, daily, latest] = await Promise.all([
		db
			.select({ type: e.credit_type, total: sum, n: count })
			.from(e)
			.where(inMain)
			.groupBy(e.credit_type),
		db
			.select({ id: e.credit_id, name: schema.broadcasts.name, total: sum, n: count })
			.from(e)
			.innerJoin(schema.broadcasts, eq(schema.broadcasts.id, e.credit_id))
			.where(and(inMain, eq(e.credit_type, "broadcast")))
			.groupBy(e.credit_id)
			.orderBy(desc(sum))
			.limit(10),
		db
			.select({ id: e.credit_id, name: schema.automations.name, total: sum, n: count })
			.from(e)
			.innerJoin(schema.automations, eq(schema.automations.id, e.credit_id))
			.where(and(inMain, eq(e.credit_type, "automation")))
			.groupBy(e.credit_id)
			.orderBy(desc(sum))
			.limit(10),
		db
			.select({ id: schema.campaigns.id, name: schema.campaigns.name, total: sum, n: count })
			.from(e)
			.innerJoin(schema.broadcasts, eq(schema.broadcasts.id, e.credit_id))
			.innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.broadcasts.campaign_id))
			.where(and(inMain, eq(e.credit_type, "broadcast")))
			.groupBy(schema.campaigns.id)
			.orderBy(desc(sum))
			.limit(10),
		db
			.select({
				day: sql<string>`substr(${e.created_at}, 1, 10)`,
				total: sum,
				credited: sql<number>`coalesce(sum(CASE WHEN ${e.credit_id} IS NOT NULL THEN ${e.value} END), 0)`,
			})
			.from(e)
			.where(inMain)
			.groupBy(sql`substr(${e.created_at}, 1, 10)`)
			.orderBy(sql`substr(${e.created_at}, 1, 10)`),
		db
			.select({
				id: e.id,
				event: e.name,
				email: schema.contacts.email,
				contact_id: e.contact_id,
				value: e.value,
				currency: e.currency,
				credit_type: e.credit_type,
				credit_id: e.credit_id,
				created_at: e.created_at,
			})
			.from(e)
			.innerJoin(schema.contacts, eq(schema.contacts.id, e.contact_id))
			.where(scope)
			.orderBy(desc(e.created_at))
			.limit(20),
	]);
	const round = (v: number) => Math.round(Number(v) * 100) / 100;
	const rows = (r: { id: string | null; name: string; total: number; n: number }[]) =>
		r.map((x) => ({
			id: x.id as string,
			name: x.name,
			total: round(x.total),
			purchases: Number(x.n),
		}));
	const broadcasts = rows(byBroadcast);
	const automations = rows(byAutomation);
	const names = new Map([...broadcasts, ...automations].map((x) => [x.id, x.name]));
	// Names of credits outside the top ten (the latest purchases name theirs too).
	const missing = latest
		.filter((l) => l.credit_id && l.credit_type !== "chat" && !names.has(l.credit_id))
		.map((l) => l.credit_id as string);
	if (missing.length) {
		const [bs, as] = await Promise.all([
			db
				.select({ id: schema.broadcasts.id, name: schema.broadcasts.name })
				.from(schema.broadcasts)
				.where(inArray(schema.broadcasts.id, missing)),
			db
				.select({ id: schema.automations.id, name: schema.automations.name })
				.from(schema.automations)
				.where(inArray(schema.automations.id, missing)),
		]);
		for (const x of [...bs, ...as]) names.set(x.id, x.name);
	}
	return {
		...empty,
		currency: main,
		totals: list,
		by_type: byType
			.map((t) => ({
				type: (t.type ?? "none") as CreditType | "none",
				total: round(t.total),
				purchases: Number(t.n),
			}))
			.sort((x, y) => y.total - x.total),
		broadcasts,
		automations,
		campaigns: rows(byCampaign),
		daily: daily.map((d) => ({
			day: d.day,
			total: round(d.total),
			credited: round(d.credited),
		})),
		latest: latest.map((l) => ({
			...l,
			value: Number(l.value),
			credit_name:
				l.credit_type === "chat"
					? "Website chat"
					: l.credit_id
						? (names.get(l.credit_id) ?? null)
						: null,
		})),
	};
}
