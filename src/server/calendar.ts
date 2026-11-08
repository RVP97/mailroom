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
	return {
		from: o.from,
		to: o.to,
		timezone: tz,
		items,
		campaigns: campaigns.map((c) => ({
			id: c.id,
			name: c.name,
			brand: brandName(c.organization_id),
			starts_on: c.starts_on as string,
			ends_on: c.ends_on ?? (c.starts_on as string),
		})),
	};
}
