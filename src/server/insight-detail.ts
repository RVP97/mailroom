import { and, desc, eq, gte, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import { PROVIDER_LABEL, PROVIDERS, type Provider, providerOf } from "../lib/providers";
import { db, schema } from "./db";
import { groupStats, LATENCY_SAMPLE, percentile, SLOW_SECONDS } from "./insights";
import { inScope, providerCondition, rate, type Scope, tagCondition } from "./queries";
import { dayRange, iso, lastDays } from "./time";

/**
 * One row of Insights up close: a template, a tag or a mailbox provider. Its numbers against the
 * period before, day by day, how fast it arrives (with the spread), where it goes and comes from,
 * why some didn't arrive, when people open it, and its latest emails.
 */

const e = schema.emails;
const DAY = 86_400_000;

export type Subject =
	| { kind: "template"; id: string }
	| { kind: "tag"; name: string; value: string }
	| { kind: "provider"; provider: Provider };

export const KINDS = ["template", "tag", "provider"] as const;

/** A URL's kind and key as a subject: a template's id, a tag's "name:value", a provider. */
export function parseSubject(kind: string, key: string): Subject | null {
	if (kind === "template" && key) return { kind, id: key };
	if (kind === "tag") {
		const at = key.indexOf(":");
		if (at <= 0) return null;
		return { kind, name: key.slice(0, at), value: key.slice(at + 1) };
	}
	if (kind === "provider" && (PROVIDERS as string[]).includes(key))
		return { kind, provider: key as Provider };
	return null;
}

function subjectCondition(s: Subject): SQL {
	if (s.kind === "template") return eq(e.template_id, s.id);
	if (s.kind === "tag") return tagCondition(`${s.name}:${s.value}`);
	return providerCondition(s.provider);
}

/** Only what went to SES (suppressed and failed-before-sending emails never did). */
const wentOut = sql`${e.sent_at} IS NOT NULL`;

const COUNTS = {
	sent: sql<number>`COUNT(*)`,
	delivered: sql<number>`COUNT(${e.delivered_at})`,
	bounced: sql<number>`SUM(CASE WHEN ${e.status} = 'bounced' THEN 1 ELSE 0 END)`,
	soft_bounced: sql<number>`SUM(CASE WHEN ${e.status} = 'soft_bounced' THEN 1 ELSE 0 END)`,
	complained: sql<number>`COUNT(${e.complained_at})`,
	opened: sql<number>`COUNT(${e.opened_at})`,
	clicked: sql<number>`COUNT(${e.clicked_at})`,
};

/** How many minutes the time zone is ahead of UTC today (Mexico keeps one offset all year). */
function offsetMinutes(now: number) {
	const today = lastDays(1, now)[0] as string;
	return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(dayRange(today)[0])) / 60_000);
}

/** The first recipient's domain, without a display name's closing bracket. */
const firstTo = sql`lower(rtrim(substr(json_extract(${e.to}, '$[0]'), instr(json_extract(${e.to}, '$[0]'), '@') + 1), '> '))`;
const fromDomain = sql<string>`lower(rtrim(substr(${e.from}, instr(${e.from}, '@') + 1), '> '))`;

/** Time-to-inbox buckets, in seconds: what someone waiting for a code would feel. */
export const BUCKETS = [
	{ label: "Under 5 s", max: 5 },
	{ label: "5–15 s", max: 15 },
	{ label: "15–60 s", max: 60 },
	{ label: "1–5 min", max: 300 },
	{ label: "Over 5 min", max: Number.POSITIVE_INFINITY },
] as const;

export async function insightDetail(
	scope: Scope,
	subject: Subject,
	days: number,
	now = Date.now(),
) {
	const since = iso(now - days * DAY);
	const before = iso(now - 2 * days * DAY);
	const base = [inScope(e.organization_id, scope), subjectCondition(subject), wentOut];
	const current = and(...base, gte(e.created_at, since));
	const offset = `${offsetMinutes(now) >= 0 ? "+" : ""}${offsetMinutes(now)} minutes`;
	const dayExpr = sql<string>`date(${e.created_at}, ${offset})`;

	const [totals, previous, daily, providers, senders, templates, reasons, hours, sample, recent] =
		await Promise.all([
			db.select(COUNTS).from(e).where(current).get(),
			db
				.select(COUNTS)
				.from(e)
				.where(and(...base, gte(e.created_at, before), lt(e.created_at, since)))
				.get(),
			db
				.select({ day: dayExpr, ...COUNTS })
				.from(e)
				.where(current)
				.groupBy(sql`1`),
			subject.kind === "provider"
				? Promise.resolve([])
				: db
						.select({ domain: sql<string>`${firstTo}`, ...COUNTS })
						.from(e)
						.where(current)
						.groupBy(sql`1`),
			db
				.select({ domain: fromDomain, ...COUNTS })
				.from(e)
				.where(current)
				.groupBy(sql`1`)
				.orderBy(sql`2 DESC`)
				.limit(8),
			subject.kind === "template"
				? Promise.resolve([])
				: db
						.select({ id: e.template_id, ...COUNTS })
						.from(e)
						.where(and(current, isNotNull(e.template_id)))
						.groupBy(e.template_id)
						.orderBy(sql`2 DESC`)
						.limit(8),
			db
				.select({
					status: e.status,
					bounce_type: e.bounce_type,
					n: sql<number>`COUNT(*)`,
				})
				.from(e)
				.where(
					and(
						current,
						sql`${e.status} IN ('bounced', 'soft_bounced', 'failed', 'delivery_delayed')`,
					),
				)
				.groupBy(sql`1, 2`)
				.orderBy(sql`3 DESC`)
				.limit(8),
			db
				.select({
					hour: sql<number>`CAST(strftime('%H', ${e.opened_at}, ${offset}) AS INTEGER)`,
					n: sql<number>`COUNT(*)`,
				})
				.from(e)
				.where(and(current, isNotNull(e.opened_at)))
				.groupBy(sql`1`),
			// Time to inbox (broadcasts aside: they go out at the sending rate) and to the first open.
			db
				.select({
					to: e.to,
					seconds: sql<number>`(julianday(${e.delivered_at}) - julianday(${e.sent_at})) * 86400.0`,
					toOpen: sql<
						number | null
					>`CASE WHEN ${e.opened_at} IS NULL THEN NULL ELSE (julianday(${e.opened_at}) - julianday(${e.delivered_at})) * 86400.0 END`,
				})
				.from(e)
				.where(and(current, isNotNull(e.delivered_at), sql`${e.broadcast_id} IS NULL`))
				.orderBy(desc(e.created_at))
				.limit(LATENCY_SAMPLE),
			db
				.select({
					id: e.id,
					to: e.to,
					subject: e.subject,
					status: e.status,
					created_at: e.created_at,
					opened_at: e.opened_at,
					clicked_at: e.clicked_at,
				})
				.from(e)
				.where(current)
				.orderBy(desc(e.created_at))
				.limit(6),
		]);

	const zero = { sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0 };
	const n = (v: unknown) => Number(v) || 0;
	const now_ = groupStats(totals ?? zero);
	const prev = groupStats(previous ?? zero);

	const byDay = new Map(daily.map((d) => [d.day, d]));
	const series = lastDays(days, now).map((day) => {
		const r = byDay.get(day);
		return {
			day,
			sent: n(r?.sent),
			delivered: n(r?.delivered),
			bounced: n(r?.bounced),
			soft_bounced: n(r?.soft_bounced),
			complained: n(r?.complained),
			opened: n(r?.opened),
			clicked: n(r?.clicked),
		};
	});

	// Per provider: the SQL groups by recipient domain; known domains fold into their provider.
	const perProvider = new Map<Provider, typeof zero>();
	for (const r of providers) {
		const p = providerOf(`x@${r.domain}`);
		const acc = perProvider.get(p) ?? { ...zero };
		for (const k of Object.keys(zero) as (keyof typeof zero)[]) acc[k] += n(r[k]);
		perProvider.set(p, acc);
	}

	const templateNames = templates.length
		? new Map(
				(
					await db
						.select({ id: schema.templates.id, name: schema.templates.name })
						.from(schema.templates)
						.where(inScope(schema.templates.organization_id, scope))
				).map((t) => [t.id, t.name]),
			)
		: new Map<string, string>();

	const seconds = sample.map((r) => Math.max(0, n(r.seconds))).sort((a, b) => a - b);
	const toOpen = sample
		.map((r) => r.toOpen)
		.filter((v): v is number => v !== null && v !== undefined)
		.map((v) => Math.max(0, Number(v)))
		.sort((a, b) => a - b);
	const latencyBy = new Map<Provider, number[]>();
	for (const r of sample) {
		const p = providerOf(r.to?.[0]);
		const list = latencyBy.get(p) ?? [];
		list.push(Math.max(0, n(r.seconds)));
		latencyBy.set(p, list);
	}
	const median = (list: number[]) =>
		percentile(
			[...list].sort((a, b) => a - b),
			0.5,
		);

	const hourCounts = Array.from({ length: 24 }, (_, hour) => ({
		hour,
		opened: n(hours.find((h) => n(h.hour) === hour)?.n),
	}));

	return {
		totals: { ...now_, soft_bounced: n(totals?.soft_bounced) },
		previous: { ...prev, soft_bounced: n(previous?.soft_bounced) },
		series,
		latency: {
			count: seconds.length,
			median: percentile(seconds, 0.5),
			p90: percentile(seconds, 0.9),
			p99: percentile(seconds, 0.99),
			slowShare: rate(seconds.filter((s) => s > SLOW_SECONDS).length, seconds.length),
			buckets: BUCKETS.map((b, i) => {
				const min = i === 0 ? -1 : (BUCKETS[i - 1]?.max ?? 0);
				const count = seconds.filter((s) => s > min && s <= b.max).length;
				return { label: b.label, count, share: rate(count, seconds.length) };
			}),
			/** From delivery to the first open, of those opened. */
			toOpen: { count: toOpen.length, median: percentile(toOpen, 0.5) },
		},
		byProvider: PROVIDERS.flatMap((p) => {
			const t = perProvider.get(p);
			if (!t?.sent) return [];
			return [
				{
					provider: p,
					label: PROVIDER_LABEL[p],
					...groupStats(t),
					median: median(latencyBy.get(p) ?? []),
				},
			];
		}).sort((a, b) => b.sent - a.sent),
		bySender: senders.map((r) => ({ domain: r.domain || "—", ...groupStats(r) })),
		byTemplate: templates.map((r) => ({
			id: r.id as string,
			name: templateNames.get(r.id as string) ?? "Deleted template",
			...groupStats(r),
		})),
		notDelivered: reasons.map((r) => ({
			status: r.status,
			bounceType: r.bounce_type,
			count: n(r.n),
		})),
		opensByHour: hourCounts,
		recent,
	};
}

export type InsightDetail = Awaited<ReturnType<typeof insightDetail>>;

/** What the page's title says: a template's name, a tag, a provider. */
export async function subjectTitle(scope: Scope, s: Subject) {
	if (s.kind === "tag") return { title: `${s.name}: ${s.value}`, alias: null, exists: true };
	if (s.kind === "provider")
		return { title: PROVIDER_LABEL[s.provider], alias: null, exists: true };
	const t = await db
		.select({ name: schema.templates.name, alias: schema.templates.alias })
		.from(schema.templates)
		.where(and(eq(schema.templates.id, s.id), inScope(schema.templates.organization_id, scope)))
		.get();
	return { title: t?.name ?? "Deleted template", alias: t?.alias ?? null, exists: !!t };
}
