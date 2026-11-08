import { and, eq, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { zonedInstant } from "../lib/zoned";
import { db, schema } from "./db";
import { timezone } from "./env";
import { validation } from "./errors";

/**
 * The content calendar: every broadcast and newsletter issue on the day it went out, goes out, or
 * is planned for (a draft's planned_on), and each campaign across the days it runs. Days are in the
 * deployment's time zone.
 */

const b = schema.broadcasts;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day and time (YYYY-MM-DD, HH:MM) an instant falls on in a zone. */
export function dayOf(at: string, tz: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		})
			.formatToParts(new Date(at))
			.map((x) => [x.type, x.value]),
	) as Record<string, string>;
	return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export type AutomationDay = {
	automation_id: string;
	name: string;
	brand: string | null;
	day: string;
	/** "sent": its emails that went out that day; "due": emails its waiting runs send then. */
	state: "sent" | "due";
	emails: number;
};

/**
 * Automations on the calendar: per day, how many emails each one sent, and how many it will
 * send (runs whose wait ends that day with an email step next).
 */
async function automationDays(
	brands: string[],
	brandName: (id: string) => string | null,
	start: string,
	end: string,
	tz: string,
): Promise<AutomationDay[]> {
	const em = schema.emails;
	const r = schema.automationRuns;
	const a = schema.automations;
	const now = new Date().toISOString();
	const [sent, runs, list] = await Promise.all([
		db
			.select({
				hour: sql<string>`substr(${em.created_at}, 1, 13)`,
				automation: sql<string>`json_extract(${em.tags}, '$[0].value')`,
				n: sql<number>`COUNT(*)`,
			})
			.from(em)
			.where(
				and(
					inArray(em.organization_id, brands),
					eq(em.source, "automation"),
					gte(em.created_at, start),
					lt(em.created_at, end),
					sql`json_extract(${em.tags}, '$[0].name') = 'automation'`,
				),
			)
			.groupBy(sql`1`, sql`2`),
		db
			.select({
				automation_id: r.automation_id,
				step: r.step,
				path: r.path,
				next_at: r.next_at,
			})
			.from(r)
			.where(
				and(
					inArray(r.organization_id, brands),
					eq(r.status, "active"),
					isNotNull(r.next_at),
					gte(r.next_at, start > now ? start : now),
					lt(r.next_at, end),
				),
			)
			.limit(20_000),
		db
			.select({ id: a.id, name: a.name, organization_id: a.organization_id, steps: a.steps })
			.from(a)
			.where(inArray(a.organization_id, brands)),
	]);
	const byId = new Map(list.map((x) => [x.id, x]));
	const { stepsAt } = await import("./automations");
	const out = new Map<string, AutomationDay>();
	const add = (id: string, day: string, state: AutomationDay["state"], n: number) => {
		const x = byId.get(id);
		if (!x) return;
		const key = `${state}:${id}:${day}`;
		const was = out.get(key);
		if (was) was.emails += n;
		else
			out.set(key, {
				automation_id: id,
				name: x.name,
				brand: brandName(x.organization_id),
				day,
				state,
				emails: n,
			});
	};
	for (const s of sent) add(s.automation, dayOf(`${s.hour}:30:00Z`, tz).day, "sent", Number(s.n));
	for (const run of runs) {
		const x = byId.get(run.automation_id);
		if (!x || !run.next_at) continue;
		const path = run.path?.length ? run.path : [run.step];
		const next = stepsAt(x.steps, path)?.[path.at(-1) ?? 0];
		if (next?.type === "send" || next?.type === "email")
			add(run.automation_id, dayOf(run.next_at, tz).day, "due", 1);
	}
	return [...out.values()].sort(
		(p, q) => p.day.localeCompare(q.day) || p.name.localeCompare(q.name),
	);
}

export type ExpectedIssue = {
	newsletter_id: string;
	name: string;
	brand: string | null;
	day: string;
	/** "send": the feed's new posts go out on their own; "draft": they become a draft issue. */
	mode: "send" | "draft";
	/** How often its feed has made an issue, in days (from its last ones). */
	every_days: number;
};

/**
 * When newsletters made from an RSS feed are likely to have their next issues: from how often
 * their feed made one lately (the median gap of the last few), from today on.
 */
async function expectedIssues(
	brands: string[],
	brandName: (id: string) => string | null,
	from: string,
	to: string,
	tz: string,
): Promise<ExpectedIssue[]> {
	const nl = schema.newsletters;
	const feeds = await db
		.select({
			id: nl.id,
			name: nl.name,
			organization_id: nl.organization_id,
			mode: nl.rss_mode,
		})
		.from(nl)
		.where(
			and(
				inArray(nl.organization_id, brands),
				isNotNull(nl.rss_url),
				sql`${nl.rss_url} <> ''`,
			),
		);
	if (!feeds.length) return [];
	const issues = await db
		.select({
			newsletter_id: b.newsletter_id,
			at: sql<string>`COALESCE(${b.started_at}, ${b.created_at})`,
		})
		.from(b)
		.where(
			and(
				inArray(
					b.newsletter_id,
					feeds.map((f) => f.id),
				),
				isNotNull(b.rss_items),
			),
		)
		.orderBy(sql`2 DESC`)
		.limit(feeds.length * 8);
	const today = dayOf(new Date().toISOString(), tz).day;
	const out: ExpectedIssue[] = [];
	for (const f of feeds) {
		const days = [
			...new Set(
				issues.filter((i) => i.newsletter_id === f.id).map((i) => dayOf(i.at, tz).day),
			),
		]
			.slice(0, 6)
			.sort();
		if (days.length < 2) continue;
		const gaps = days
			.slice(1)
			.map((d, i) => (Date.parse(d) - Date.parse(days[i] as string)) / 86_400_000)
			.sort((p, q) => p - q);
		const every = Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)] as number));
		let next = addDays(days.at(-1) as string, every);
		while (next < today) next = addDays(next, every);
		for (let n = 0; next <= to && n < 62; n++, next = addDays(next, every))
			if (next >= from)
				out.push({
					newsletter_id: f.id,
					name: f.name,
					brand: brandName(f.organization_id),
					day: next,
					mode: f.mode === "send" ? "send" : "draft",
					every_days: every,
				});
	}
	return out.sort((p, q) => p.day.localeCompare(q.day));
}

const addDays = (day: string, n: number) => {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export type CalendarItem = {
	id: string;
	name: string;
	brand: string | null;
	/** sent | sending | scheduled | planned (a draft on its planned day). */
	state: "sent" | "sending" | "scheduled" | "planned";
	status: string;
	day: string;
	/** When it went or goes (HH:MM in the zone); null for a planned draft. */
	time: string | null;
	newsletter: string | null;
	campaign: string | null;
	/** Waiting for an approval. */
	review: string | null;
	queued: number;
};

/** What's on the calendar from `from` to `to` (days, both included, at most 62 days apart). */
export async function contentCalendar(
	o: { brands: string[]; names: Map<string, string>; from: string; to: string },
	tz = timezone(),
) {
	if (!DAY.test(o.from) || !DAY.test(o.to)) throw validation("from and to: days, YYYY-MM-DD");
	if (o.to < o.from) throw validation("to: on or after from");
	if (addDays(o.from, 62) < o.to) throw validation("to: at most 62 days after from");
	const start = new Date(zonedInstant(`${o.from}T00:00`, tz)).toISOString();
	const end = new Date(zonedInstant(`${addDays(o.to, 1)}T00:00`, tz)).toISOString();
	const many = o.brands.length > 1;
	const brandName = (id: string) => (many ? (o.names.get(id) ?? null) : null);
	const [rows, newsletters, campaigns] = await Promise.all([
		db
			.select({
				id: b.id,
				organization_id: b.organization_id,
				name: b.name,
				subject: b.subject,
				status: b.status,
				planned_on: b.planned_on,
				scheduled_at: b.scheduled_at,
				started_at: b.started_at,
				newsletter_id: b.newsletter_id,
				campaign_id: b.campaign_id,
				review: b.review,
				queued: b.queued,
			})
			.from(b)
			.where(
				and(
					inArray(b.organization_id, o.brands),
					or(
						and(gte(b.started_at, start), lt(b.started_at, end)),
						and(
							eq(b.status, "scheduled"),
							gte(b.scheduled_at, start),
							lt(b.scheduled_at, end),
						),
						and(
							eq(b.status, "draft"),
							gte(b.planned_on, o.from),
							lte(b.planned_on, o.to),
						),
					),
				),
			)
			.orderBy(sql`COALESCE(${b.started_at}, ${b.scheduled_at}, ${b.planned_on}) ASC`)
			.limit(500),
		db
			.select({ id: schema.newsletters.id, name: schema.newsletters.name })
			.from(schema.newsletters)
			.where(inArray(schema.newsletters.organization_id, o.brands)),
		db
			.select({
				id: schema.campaigns.id,
				organization_id: schema.campaigns.organization_id,
				name: schema.campaigns.name,
				starts_on: schema.campaigns.starts_on,
				ends_on: schema.campaigns.ends_on,
			})
			.from(schema.campaigns)
			.where(
				and(
					inArray(schema.campaigns.organization_id, o.brands),
					isNotNull(schema.campaigns.starts_on),
					lte(schema.campaigns.starts_on, o.to),
					sql`COALESCE(${schema.campaigns.ends_on}, ${schema.campaigns.starts_on}) >= ${o.from}`,
				),
			),
	]);
	const newsletterName = new Map(newsletters.map((n) => [n.id, n.name]));
	const campaignName = new Map(campaigns.map((c) => [c.id, c.name]));
	const items: CalendarItem[] = rows.flatMap((x) => {
		const at = x.started_at ?? (x.status === "scheduled" ? x.scheduled_at : null) ?? null;
		const when = at ? dayOf(at, tz) : x.planned_on ? { day: x.planned_on, time: null } : null;
		if (!when) return [];
		const state: CalendarItem["state"] = x.started_at
			? x.status === "sending" || x.status === "testing"
				? "sending"
				: "sent"
			: x.status === "scheduled"
				? "scheduled"
				: "planned";
		return [
			{
				id: x.id,
				name: x.name || x.subject || "Untitled broadcast",
				brand: brandName(x.organization_id),
				state,
				status: x.status,
				day: when.day,
				time: when.time,
				newsletter: x.newsletter_id ? (newsletterName.get(x.newsletter_id) ?? null) : null,
				campaign: x.campaign_id ? (campaignName.get(x.campaign_id) ?? null) : null,
				review: x.review ?? null,
				queued: x.queued,
			},
		];
	});
	const [automations, expected] = await Promise.all([
		automationDays(o.brands, brandName, start, end, tz),
		expectedIssues(o.brands, brandName, o.from, o.to, tz),
	]);
	return {
		from: o.from,
		to: o.to,
		timezone: tz,
		items,
		automations,
		expected,
		campaigns: campaigns.map((c) => ({
			id: c.id,
			name: c.name,
			brand: brandName(c.organization_id),
			starts_on: c.starts_on as string,
			ends_on: c.ends_on ?? (c.starts_on as string),
		})),
	};
}
