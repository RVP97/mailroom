import {
	type AnyColumn,
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	like,
	lt,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { type EmailFilterValue, NOT_DELIVERED } from "../lib/email-status";
import { domainsOf, KNOWN_DOMAINS, type Provider } from "../lib/providers";
import { db, schema } from "./db";
import type { EmailStatus } from "./db/schema";
import { dayRange, iso, lastDays } from "./time";

/** Reads shared by the API and the dashboard. */

const e = schema.emails;

/**
 * Whose rows a read covers: one brand (its id; an organization's own brand has the
 * organization's id), or a whole organization, every brand of it (schema.brands).
 */
export type Scope = string | { org: string };

/** The scope's condition on an organization_id column. A subquery, so any number of brands binds one id. */
export function inScope(column: AnyColumn, scope: Scope): SQL {
	if (typeof scope === "string") return eq(column, scope);
	const b = schema.brands;
	return or(
		eq(column, scope.org),
		inArray(column, db.select({ id: b.id }).from(b).where(eq(b.parent_id, scope.org))),
	) as SQL;
}

export interface EmailFilter {
	/** A status, opened/clicked, or not_delivered (bounced, soft bounced, failed, suppressed). */
	status?: EmailFilterValue | EmailStatus | null;
	/** One day (YYYY-MM-DD in TIMEZONE), by when the status's event happened. */
	day?: string | null;
	/** Sent from this domain (the From address's). */
	domain?: string | null;
	/** To this mailbox provider (gmail, outlook, yahoo, icloud, other). */
	provider?: Provider | null;
	/** A recipient (or part of one), the subject's start, or an id. */
	search?: string | null;
	/** Sent with this API key. */
	apiKeyId?: string | null;
	/** Carries this tag: "name:value", or just "name" for any value. */
	tag?: string | null;
	/** Made from this template. */
	template?: string | null;
	/** Only the last this many days. */
	days?: number | null;
	/** Cursor: the last id of the previous page. */
	after?: string | null;
	limit?: number;
}

export async function listEmails(scope: Scope, f: EmailFilter = {}, max = 100) {
	const limit = Math.min(Math.max(f.limit ?? 50, 1), max);
	const conds = emailConditions(scope, f);
	if (f.after) {
		const cursor = await db
			.select({ created_at: e.created_at })
			.from(e)
			.where(eq(e.id, f.after))
			.get();
		if (cursor)
			conds.push(
				or(
					lt(e.created_at, cursor.created_at),
					and(eq(e.created_at, cursor.created_at), lt(e.id, f.after)),
				) as never,
			);
	}
	const rows = await db
		.select({
			id: e.id,
			organization_id: e.organization_id,
			from: e.from,
			to: e.to,
			cc: e.cc,
			bcc: e.bcc,
			reply_to: e.reply_to,
			subject: e.subject,
			status: e.status,
			last_event: e.last_event,
			dropped: e.dropped,
			error: e.error,
			bounce_type: e.bounce_type,
			created_at: e.created_at,
			send_at: e.send_at,
			source: e.source,
			api_key_id: e.api_key_id,
			tags: e.tags,
			open_count: e.open_count,
			click_count: e.click_count,
		})
		.from(e)
		.where(and(...conds))
		.orderBy(desc(e.created_at), desc(e.id))
		.limit(limit + 1);
	return { data: rows.slice(0, limit), has_more: rows.length > limit };
}

/** The conditions a filter puts on the emails (all but the page cursor). */
function emailConditions(scope: Scope, f: EmailFilter): SQL[] {
	const conds = [inScope(e.organization_id, scope)];
	if (f.status) conds.push(statusCondition(f.status));
	if (f.day && /^\d{4}-\d{2}-\d{2}$/.test(f.day)) {
		const [start, end] = dayRange(f.day);
		const at = dayColumn(f.status);
		conds.push(sql`${at} >= ${start} AND ${at} < ${end}`);
	}
	if (f.domain) {
		const d = f.domain.toLowerCase().replace(/[%_\s]/g, "");
		conds.push(or(like(e.from, `%@${d}`), like(e.from, `%@${d}>%`)) as SQL);
	}
	if (f.provider) conds.push(providerCondition(f.provider));
	if (f.apiKeyId) conds.push(eq(e.api_key_id, f.apiKeyId));
	if (f.tag) conds.push(tagCondition(f.tag));
	if (f.template) conds.push(eq(e.template_id, f.template));
	if (f.days) conds.push(gte(e.created_at, iso(Date.now() - f.days * 86_400_000)));
	const q = f.search?.trim();
	if (q) {
		if (/^[0-9a-f-]{36}$/i.test(q)) conds.push(or(eq(e.id, q), eq(e.message_id, q)) as never);
		else
			conds.push(
				or(
					like(e.to, `%${q.replace(/[%_"]/g, "")}%`),
					like(e.subject, `${q.replace(/[%_]/g, "")}%`),
				) as never,
			);
	}
	return conds;
}

/** What the Emails list shows above a drill-down (a day, domain or provider): how many there are of each. */
export const SUMMARY = [
	"delivered",
	"opened",
	"clicked",
	"not_delivered",
	...NOT_DELIVERED,
	"complained",
] as const;

export async function summarizeEmails(scope: Scope, f: EmailFilter) {
	const count = (status: EmailFilter["status"]) =>
		db
			.select({ n: sql<number>`COUNT(*)` })
			.from(e)
			.where(and(...emailConditions(scope, { ...f, status })))
			.get()
			.then((r) => Number(r?.n) || 0);
	const [all, ...counts] = await Promise.all([count(null), ...SUMMARY.map(count)]);
	return {
		all,
		...(Object.fromEntries(SUMMARY.map((s, i) => [s, counts[i] ?? 0])) as Record<
			(typeof SUMMARY)[number],
			number
		>),
	};
}

/** Emails carrying a tag: "name:value", or "name" with any value. */
export function tagCondition(tag: string): SQL {
	const at = tag.indexOf(":");
	const name = at < 0 ? tag : tag.slice(0, at);
	const value = at < 0 ? null : tag.slice(at + 1);
	return sql`EXISTS (SELECT 1 FROM json_each(${e.tags}) t WHERE json_extract(t.value, '$.name') = ${name}${
		value === null ? sql`` : sql` AND json_extract(t.value, '$.value') = ${value}`
	})`;
}

/**
 * The tags the scope's emails carried lately (name and value, most used first), for the
 * Emails list's «Sent by» filter.
 */
export async function recentTags(scope: Scope, days = 90, limit = 60) {
	const rows = await db
		.select({
			name: sql<string>`json_extract(t.value, '$.name')`,
			value: sql<string>`json_extract(t.value, '$.value')`,
			n: sql<number>`COUNT(*)`,
		})
		.from(sql`${e}, json_each(${e.tags}) t`)
		.where(
			and(
				inScope(e.organization_id, scope),
				gte(e.created_at, iso(Date.now() - days * 86_400_000)),
				sql`${e.tags} IS NOT NULL`,
			),
		)
		.groupBy(sql`1, 2`)
		.orderBy(sql`3 DESC`)
		.limit(limit);
	return rows
		.filter((r) => r.name && !r.name.startsWith("mailroom_"))
		.map((r) => ({ name: r.name, value: r.value ?? "", count: Number(r.n) || 0 }));
}

function statusCondition(status: EmailFilterValue | EmailStatus): SQL {
	if (status === "not_delivered") return inArray(e.status, [...NOT_DELIVERED]);
	if (status === "opened") return sql`${e.opened_at} IS NOT NULL`;
	if (status === "clicked") return sql`${e.clicked_at} IS NOT NULL`;
	if (status === "firewall") return like(e.dropped, '%"firewall: %');
	if (status === "unsubscribed") return like(e.dropped, '%"unsubscribed (%');
	return eq(e.status, status);
}

/** The moment a status happened, which a day filter reads (Overview counts events by their day). */
function dayColumn(status: EmailFilterValue | EmailStatus | null | undefined): SQL {
	switch (status) {
		case "sent":
			return sql`COALESCE(${e.sent_at}, ${e.created_at})`;
		case "delivered":
			return sql`COALESCE(${e.delivered_at}, ${e.created_at})`;
		case "opened":
			return sql`${e.opened_at}`;
		case "clicked":
			return sql`${e.clicked_at}`;
		case "bounced":
			return sql`COALESCE(${e.bounced_at}, ${e.last_event_at}, ${e.created_at})`;
		case "complained":
			return sql`COALESCE(${e.complained_at}, ${e.created_at})`;
		case "soft_bounced":
		case "failed":
		case "suppressed":
		case "not_delivered":
		case "delivery_delayed":
			return sql`COALESCE(${e.last_event_at}, ${e.created_at})`;
		default:
			return sql`${e.created_at}`;
	}
}

/** Recipients at a mailbox provider, by their address's domain in the JSON list. */
export function providerCondition(p: Provider): SQL {
	const at = (d: string) => or(like(e.to, `%@${d}"%`), like(e.to, `%@${d}>%`)) as SQL;
	if (p === "other") return sql`NOT (${or(...KNOWN_DOMAINS.map(at))})`;
	return or(...domainsOf(p).map(at)) as SQL;
}

export async function getEmail(scope: Scope, id: string) {
	return db
		.select()
		.from(e)
		.where(and(eq(e.id, id), inScope(e.organization_id, scope)))
		.get();
}

export async function emailEvents(emailId: string) {
	return db
		.select()
		.from(schema.emailEvents)
		.where(eq(schema.emailEvents.email_id, emailId))
		.orderBy(asc(schema.emailEvents.at));
}

export interface Totals {
	sent: number;
	delivered: number;
	bounced: number;
	soft_bounced: number;
	complained: number;
	opened: number;
	clicked: number;
	failed: number;
	delayed: number;
	suppressed: number;
}

const ZERO: Totals = {
	sent: 0,
	delivered: 0,
	bounced: 0,
	soft_bounced: 0,
	complained: 0,
	opened: 0,
	clicked: 0,
	failed: 0,
	delayed: 0,
	suppressed: 0,
};

/**
 * SES's limits, as its account review uses them: a bounce rate (hard bounces over sent) of 5%
 * gets the account under review and 10% may pause it; complaints, 0.1% and 0.5%.
 */
export const LIMITS = {
	bounce: { warning: 0.05, danger: 0.1 },
	complaint: { warning: 0.001, danger: 0.005 },
} as const;

export const rate = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

export function health(t: Totals) {
	const bounce = rate(t.bounced, t.sent);
	const complaint = rate(t.complained, t.sent);
	const level = (v: number, l: { warning: number; danger: number }) =>
		v >= l.danger ? "danger" : v >= l.warning ? "warning" : "ok";
	return {
		bounceRate: bounce,
		complaintRate: complaint,
		bounce: level(bounce, LIMITS.bounce),
		complaint: level(complaint, LIMITS.complaint),
	};
}

/**
 * The scope's (or every organization's) counters of the last n days, day by day; with `domain`,
 * only what that sending domain sent. `offset` days back moves the window (the previous period).
 */
export async function dailyStats(
	scope: Scope | null,
	days: number,
	now = Date.now(),
	o: { domain?: string | null; offset?: number } = {},
) {
	const list = lastDays(days + (o.offset ?? 0), now).slice(0, days);
	const s = o.domain ? schema.domainStats : schema.dailyStats;
	const rows = await db
		.select({
			day: s.day,
			sent: sql<number>`SUM(${s.sent})`,
			delivered: sql<number>`SUM(${s.delivered})`,
			bounced: sql<number>`SUM(${s.bounced})`,
			soft_bounced: sql<number>`SUM(${s.soft_bounced})`,
			complained: sql<number>`SUM(${s.complained})`,
			opened: sql<number>`SUM(${s.opened})`,
			clicked: sql<number>`SUM(${s.clicked})`,
			failed: sql<number>`SUM(${s.failed})`,
			delayed: sql<number>`SUM(${s.delayed})`,
			suppressed: sql<number>`SUM(${s.suppressed})`,
		})
		.from(s)
		.where(
			and(
				scope ? inScope(s.organization_id, scope) : undefined,
				gte(s.day, list[0] as string),
				lt(s.day, nextDay(list.at(-1) as string)),
				o.domain ? eq(schema.domainStats.domain, o.domain.toLowerCase()) : undefined,
			),
		)
		.groupBy(s.day);
	const byDay = new Map(rows.map((r) => [r.day, r]));
	const series = list.map((day) => {
		const r = byDay.get(day);
		const row = { ...ZERO, day };
		if (r) for (const k of Object.keys(ZERO) as (keyof Totals)[]) row[k] = Number(r[k]) || 0;
		return row;
	});
	const totals = series.reduce<Totals>(
		(acc, r) => {
			for (const k of Object.keys(ZERO) as (keyof Totals)[]) acc[k] += r[k];
			return acc;
		},
		{ ...ZERO },
	);
	return { series, totals, health: health(totals) };
}

const nextDay = (day: string) =>
	new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Per sending domain over the last n days, busiest first. */
export async function statsByDomain(scope: Scope, days: number, now = Date.now()) {
	const from = lastDays(days, now)[0] as string;
	const d = schema.domainStats;
	const rows = await db
		.select({
			domain: d.domain,
			sent: sql<number>`SUM(${d.sent})`,
			delivered: sql<number>`SUM(${d.delivered})`,
			bounced: sql<number>`SUM(${d.bounced})`,
			soft_bounced: sql<number>`SUM(${d.soft_bounced})`,
			complained: sql<number>`SUM(${d.complained})`,
			opened: sql<number>`SUM(${d.opened})`,
			clicked: sql<number>`SUM(${d.clicked})`,
			failed: sql<number>`SUM(${d.failed})`,
			suppressed: sql<number>`SUM(${d.suppressed})`,
		})
		.from(d)
		.where(and(inScope(d.organization_id, scope), gte(d.day, from)))
		.groupBy(d.domain);
	return rows
		.map((r) => {
			const t = { ...ZERO };
			for (const k of Object.keys(ZERO) as (keyof Totals)[])
				t[k] = Number((r as Record<string, unknown>)[k]) || 0;
			return { domain: r.domain, ...t, ...health(t) };
		})
		.filter((r) => r.sent + r.failed + r.suppressed > 0)
		.sort((a, b) => b.sent - a.sent || a.domain.localeCompare(b.domain));
}

/** Per brand over the last n days: the whole account (the admin's view), or one organization's. */
export async function statsByOrganization(days: number, now = Date.now(), scope?: Scope) {
	const from = lastDays(days, now)[0] as string;
	const s = schema.dailyStats;
	const rows = await db
		.select({
			organization_id: s.organization_id,
			name: schema.organization.name,
			sent: sql<number>`SUM(${s.sent})`,
			delivered: sql<number>`SUM(${s.delivered})`,
			bounced: sql<number>`SUM(${s.bounced})`,
			complained: sql<number>`SUM(${s.complained})`,
		})
		.from(s)
		.innerJoin(schema.organization, eq(schema.organization.id, s.organization_id))
		.where(and(gte(s.day, from), scope ? inScope(s.organization_id, scope) : undefined))
		.groupBy(s.organization_id);
	return rows.map((r) => ({ ...r, ...health({ ...ZERO, ...r }) }));
}

export const SUPPRESSION_REASONS = ["bounce", "complaint", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export async function listSuppressions(
	scope: Scope,
	o: {
		search?: string | null;
		reason?: SuppressionReason | null;
		limit?: number;
		offset?: number;
	} = {},
) {
	const sp = schema.suppressions;
	const q = o.search?.trim().toLowerCase();
	const rows = await db
		.select()
		.from(sp)
		.where(
			and(
				inScope(sp.organization_id, scope),
				o.reason ? eq(sp.reason, o.reason) : undefined,
				q ? like(sp.address, `%${q.replace(/[%_]/g, "")}%`) : undefined,
			),
		)
		.orderBy(desc(sp.created_at))
		.limit((o.limit ?? 100) + 1)
		.offset(o.offset ?? 0);
	return { data: rows.slice(0, o.limit ?? 100), has_more: rows.length > (o.limit ?? 100) };
}

/** An address's suppressions in the scope (one a brand), newest first. */
export async function suppressionsOf(scope: Scope, address: string) {
	const sp = schema.suppressions;
	return db
		.select()
		.from(sp)
		.where(
			and(inScope(sp.organization_id, scope), eq(sp.address, address.trim().toLowerCase())),
		)
		.orderBy(desc(sp.created_at));
}

/** How many addresses are suppressed, by reason. */
export async function suppressionCounts(scope: Scope) {
	const sp = schema.suppressions;
	const rows = await db
		.select({ reason: sp.reason, n: sql<number>`count(*)` })
		.from(sp)
		.where(inScope(sp.organization_id, scope))
		.groupBy(sp.reason);
	const counts: Record<SuppressionReason, number> = { bounce: 0, complaint: 0, manual: 0 };
	for (const r of rows)
		if (r.reason in counts) counts[r.reason as SuppressionReason] = Number(r.n);
	return counts;
}

/**
 * The scope's emails by mailbox provider (Gmail, Outlook, Yahoo, iCloud, other) over the last
 * n days, from the provider_stats counters: where a reputation problem sits.
 */
export async function statsByProvider(scope: Scope, days: number, now = Date.now()) {
	const from = lastDays(days, now)[0] as string;
	const p = schema.providerStats;
	const rows = await db
		.select({
			provider: p.provider,
			sent: sql<number>`SUM(${p.sent})`,
			delivered: sql<number>`SUM(${p.delivered})`,
			bounced: sql<number>`SUM(${p.bounced})`,
			complained: sql<number>`SUM(${p.complained})`,
			opened: sql<number>`SUM(${p.opened})`,
		})
		.from(p)
		.where(and(inScope(p.organization_id, scope), gte(p.day, from)))
		.groupBy(p.provider);
	return rows
		.map((r) => {
			const sent = Number(r.sent) || 0;
			const t = {
				...ZERO,
				sent,
				bounced: Number(r.bounced) || 0,
				complained: Number(r.complained) || 0,
			};
			return {
				provider: r.provider,
				sent,
				delivered: Number(r.delivered) || 0,
				opened: Number(r.opened) || 0,
				deliveryRate: rate(Number(r.delivered) || 0, sent),
				openRate: rate(Number(r.opened) || 0, Number(r.delivered) || 0),
				...health(t),
			};
		})
		.sort((a, b) => b.sent - a.sent);
}
