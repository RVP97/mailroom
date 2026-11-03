import { and, gte, isNotNull, sql } from "drizzle-orm";
import { PROVIDERS, type Provider, providerOf } from "../lib/providers";
import { db, schema } from "./db";
import { health, inScope, rate, type Scope } from "./queries";
import { iso, lastDays } from "./time";

/**
 * Insights: how each kind of email does, beyond Overview's totals. Per template and per tag
 * (from the emails themselves), per stream (transactional and marketing domains, from the
 * per-domain counters) and how long emails take from SES to the recipient's server, per
 * mailbox provider (time to inbox).
 */

const e = schema.emails;
const DAY = 86_400_000;

/** One group's counts and rates (template, tag or stream). */
export interface GroupStats {
	sent: number;
	delivered: number;
	bounced: number;
	complained: number;
	opened: number;
	clicked: number;
	deliveryRate: number;
	bounceRate: number;
	complaintRate: number;
	openRate: number;
	clickRate: number;
	bounce: "ok" | "warning" | "danger";
	complaint: "ok" | "warning" | "danger";
}

export function groupStats(r: {
	sent: number;
	delivered: number;
	bounced: number;
	complained: number;
	opened: number;
	clicked: number;
}): GroupStats {
	const n = (v: unknown) => Number(v) || 0;
	const sent = n(r.sent);
	const delivered = n(r.delivered);
	const bounced = n(r.bounced);
	const complained = n(r.complained);
	const opened = n(r.opened);
	const clicked = n(r.clicked);
	const h = health({
		sent,
		delivered,
		bounced,
		complained,
		opened,
		clicked,
		soft_bounced: 0,
		failed: 0,
		delayed: 0,
		suppressed: 0,
	});
	return {
		sent,
		delivered,
		bounced,
		complained,
		opened,
		clicked,
		deliveryRate: rate(delivered, sent),
		openRate: rate(opened, delivered),
		clickRate: rate(clicked, delivered),
		bounceRate: h.bounceRate,
		complaintRate: h.complaintRate,
		bounce: h.bounce as GroupStats["bounce"],
		complaint: h.complaint as GroupStats["complaint"],
	};
}

/** What counts per email: only ones that went to SES (suppressed and failed ones never did). */
const COUNTS = {
	sent: sql<number>`COUNT(*)`,
	delivered: sql<number>`COUNT(${e.delivered_at})`,
	bounced: sql<number>`SUM(CASE WHEN ${e.status} = 'bounced' THEN 1 ELSE 0 END)`,
	complained: sql<number>`COUNT(${e.complained_at})`,
	opened: sql<number>`COUNT(${e.opened_at})`,
	clicked: sql<number>`COUNT(${e.clicked_at})`,
};
const wentOut = sql`${e.sent_at} IS NOT NULL`;

/** Each template's emails over the last n days, busiest first. */
export async function statsByTemplate(scope: Scope, days: number, now = Date.now()) {
	const t = schema.templates;
	const rows = await db
		.select({ id: e.template_id, ...COUNTS })
		.from(e)
		.where(
			and(
				inScope(e.organization_id, scope),
				gte(e.created_at, iso(now - days * DAY)),
				isNotNull(e.template_id),
				wentOut,
			),
		)
		.groupBy(e.template_id);
	if (!rows.length) return [];
	const names = new Map(
		(
			await db
				.select({ id: t.id, name: t.name, alias: t.alias })
				.from(t)
				.where(inScope(t.organization_id, scope))
		).map((r) => [r.id, r]),
	);
	return rows
		.map((r) => ({
			id: r.id as string,
			name: names.get(r.id as string)?.name ?? "Deleted template",
			alias: names.get(r.id as string)?.alias ?? null,
			...groupStats(r),
		}))
		.sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name));
}

/** Each tag (name and value) the emails carried over the last n days, busiest first. */
export async function statsByTag(scope: Scope, days: number, now = Date.now(), limit = 50) {
	const rows = await db
		.select({
			name: sql<string>`json_extract(t.value, '$.name')`,
			value: sql<string>`json_extract(t.value, '$.value')`,
			...COUNTS,
		})
		.from(sql`${e}, json_each(${e.tags}) t`)
		.where(
			and(
				inScope(e.organization_id, scope),
				gte(e.created_at, iso(now - days * DAY)),
				sql`${e.tags} IS NOT NULL`,
				wentOut,
			),
		)
		.groupBy(sql`1, 2`)
		.orderBy(sql`3 DESC`)
		.limit(limit + 20);
	return rows
		.filter((r) => r.name && !r.name.startsWith("mailroom_"))
		.slice(0, limit)
		.map((r) => ({ name: r.name, value: r.value ?? "", ...groupStats(r) }));
}

/**
 * Transactional and marketing domains apart (each brand's marketing domains send through their
 * own SES tenant, so their bounces and complaints don't touch receipts and codes).
 */
export async function statsByStream(scope: Scope, days: number, now = Date.now()) {
	const from = lastDays(days, now)[0] as string;
	const ds = schema.domainStats;
	const d = schema.domains;
	const rows = await db
		.select({
			stream: sql<string>`CASE WHEN ${d.purpose} = 'marketing' THEN 'marketing' ELSE 'transactional' END`,
			sent: sql<number>`SUM(${ds.sent})`,
			delivered: sql<number>`SUM(${ds.delivered})`,
			bounced: sql<number>`SUM(${ds.bounced})`,
			complained: sql<number>`SUM(${ds.complained})`,
			opened: sql<number>`SUM(${ds.opened})`,
			clicked: sql<number>`SUM(${ds.clicked})`,
		})
		.from(ds)
		.leftJoin(d, sql`${d.organization_id} = ${ds.organization_id} AND ${d.name} = ${ds.domain}`)
		.where(and(inScope(ds.organization_id, scope), gte(ds.day, from)))
		.groupBy(sql`1`);
	const by = new Map(rows.map((r) => [r.stream, r]));
	const zero = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0 };
	return (["transactional", "marketing"] as const).map((stream) => ({
		stream,
		...groupStats(by.get(stream) ?? zero),
	}));
}

/** The emails time to inbox looks at, newest first. */
export const LATENCY_SAMPLE = 5000;

export interface Latency {
	provider: Provider | "all";
	count: number;
	/** Seconds from SES taking the email to the recipient's server accepting it. */
	median: number | null;
	p90: number | null;
	p99: number | null;
	/** Share that took over SLOW_SECONDS. */
	slowShare: number;
}

/** Over this, an email was slow to arrive (a login code people would give up on). */
export const SLOW_SECONDS = 60;

export function percentile(sorted: number[], p: number): number | null {
	if (!sorted.length) return null;
	const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[i] ?? null;
}

export function summarizeLatency(provider: Latency["provider"], seconds: number[]): Latency {
	const sorted = [...seconds].sort((a, b) => a - b);
	return {
		provider,
		count: sorted.length,
		median: percentile(sorted, 0.5),
		p90: percentile(sorted, 0.9),
		p99: percentile(sorted, 0.99),
		slowShare: rate(sorted.filter((s) => s > SLOW_SECONDS).length, sorted.length),
	};
}

/**
 * Time to inbox: the latest delivered emails of the last n days (up to LATENCY_SAMPLE), all
 * together and per mailbox provider (by the first recipient). With `marketing: false`, only
 * what wasn't part of a broadcast (broadcasts go out at the sending rate, which isn't delivery).
 */
export async function timeToInbox(
	scope: Scope,
	days: number,
	now = Date.now(),
	o: { broadcasts?: boolean; sinceMs?: number } = {},
) {
	const rows = await db
		.select({
			to: e.to,
			seconds: sql<number>`(julianday(${e.delivered_at}) - julianday(${e.sent_at})) * 86400.0`,
		})
		.from(e)
		.where(
			and(
				inScope(e.organization_id, scope),
				gte(e.created_at, iso(o.sinceMs ?? now - days * DAY)),
				isNotNull(e.delivered_at),
				isNotNull(e.sent_at),
				o.broadcasts ? undefined : sql`${e.broadcast_id} IS NULL`,
			),
		)
		.orderBy(sql`${e.created_at} DESC`)
		.limit(LATENCY_SAMPLE);
	const all: number[] = [];
	const by = new Map<Provider, number[]>();
	for (const r of rows) {
		const s = Math.max(0, Number(r.seconds) || 0);
		all.push(s);
		const p = providerOf(r.to?.[0]);
		const list = by.get(p) ?? [];
		list.push(s);
		by.set(p, list);
	}
	return {
		all: summarizeLatency("all", all),
		byProvider: PROVIDERS.map((p) => summarizeLatency(p, by.get(p) ?? [])).filter(
			(l) => l.count > 0,
		),
	};
}
