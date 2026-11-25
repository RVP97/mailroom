import { and, eq, gte, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { brandIds } from "./brands";
import { db, schema } from "./db";
import type { DomainWarmupConfig } from "./db/schema";
import { notFound } from "./errors";
import { forgetOrg } from "./org";
import { dayOf, dayRange } from "./time";

/**
 * Automated Domain Warm-Up Ramp:
 * Gradually scales daily sending volume for newly-onboarded SES domains (e.g. 100 -> 25,000/day
 * over 14 days) and auto-holds excess queued emails until the next day (or if bounce rate exceeds
 * the safety ceiling) so fresh domains build sender reputation cleanly.
 */

const warmupInput = z.object({
	enabled: z.boolean(),
	start_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/, "start_date: YYYY-MM-DD")
		.optional(),
	daily_start: z.number().int().min(10).max(50_000).default(100),
	daily_max: z.number().int().min(50).max(5_000_000).default(25_000),
	ramp_days: z.number().int().min(3).max(90).default(14),
	pause_bounce_rate: z.number().min(0.005).max(0.2).default(0.03),
});

function parseYmdUtc(ymd: string): number {
	const [y, m, d] = ymd.split("-").map(Number);
	if (!y || !m || !d) return Number.NaN;
	return Date.UTC(y, m - 1, d);
}

/** Exponential warm-up limit for a given day number (1-indexed, using deployment TIMEZONE). */
export function warmupDayLimit(
	cfg: DomainWarmupConfig,
	now = Date.now(),
): {
	day: number;
	limit: number;
	completed: boolean;
} {
	const startUtc = parseYmdUtc(cfg.start_date);
	const todayUtc = parseYmdUtc(dayOf(now));
	const elapsedDays =
		Number.isFinite(startUtc) && Number.isFinite(todayUtc)
			? Math.max(0, Math.floor((todayUtc - startUtc) / 86_400_000))
			: 0;
	const day = elapsedDays + 1;
	if (day >= cfg.ramp_days) {
		return { day, limit: cfg.daily_max, completed: true };
	}
	const ratio = cfg.daily_max / Math.max(cfg.daily_start, 1);
	const progress = (day - 1) / Math.max(cfg.ramp_days - 1, 1);
	const raw = cfg.daily_start * ratio ** progress;
	const limit = Math.min(cfg.daily_max, Math.max(cfg.daily_start, Math.round(raw / 10) * 10));
	return { day, limit, completed: false };
}

/** Preview the full day-by-day ramp schedule for the UI. */
export function warmupSchedulePreview(cfg: DomainWarmupConfig) {
	const startUtc = parseYmdUtc(cfg.start_date) || parseYmdUtc(dayOf(Date.now()));
	return Array.from({ length: Math.min(cfg.ramp_days, 30) }, (_, i) => {
		// Use noon UTC so dayOf(ts) lands on the exact calendar day across timezones.
		const ts = startUtc + i * 86_400_000 + 12 * 3_600_000;
		return { day: i + 1, date: dayOf(ts), limit: warmupDayLimit(cfg, ts).limit };
	});
}

export type WarmupDailyCounts = { sent: number; bounced: number };

/** Count emails actually sent today (by `sent_at`) for an exact sender domain. */
export async function countDomainSentToday(
	organizationId: string,
	domainName: string,
	now = Date.now(),
): Promise<WarmupDailyCounts> {
	const [dayStart] = dayRange(dayOf(now));
	const dom = domainName.trim().toLowerCase();
	const row = await db
		.select({
			sent: sql<number>`count(*)`,
			bounced: sql<number>`sum(CASE WHEN ${schema.emails.status} = 'bounced' THEN 1 ELSE 0 END)`,
		})
		.from(schema.emails)
		.where(
			and(
				eq(schema.emails.organization_id, organizationId),
				isNotNull(schema.emails.sent_at),
				gte(schema.emails.sent_at, dayStart),
				or(
					sql`lower(${schema.emails.from}) LIKE ${`%@${dom}`}`,
					sql`lower(${schema.emails.from}) LIKE ${`%@${dom}>`}`,
				),
			),
		)
		.get();
	return { sent: Number(row?.sent ?? 0), bounced: Number(row?.bounced ?? 0) };
}

/** Check if a domain can send another email right now under its warm-up schedule. */
export async function checkDomainWarmup(
	organizationId: string,
	domainName: string,
	cfg: DomainWarmupConfig | null | undefined,
	now = Date.now(),
	counts?: WarmupDailyCounts,
) {
	if (!cfg?.enabled) {
		return {
			allowed: true,
			limited: false,
			sent_today: 0,
			daily_limit: null,
			day: 0,
			reason: null,
		};
	}
	const { day, limit, completed } = warmupDayLimit(cfg, now);
	if (completed) {
		return {
			allowed: true,
			limited: false,
			sent_today: 0,
			daily_limit: limit,
			day,
			reason: null,
		};
	}
	const { sent: sentToday, bounced: bouncedToday } =
		counts ?? (await countDomainSentToday(organizationId, domainName, now));
	const ceiling = cfg.pause_bounce_rate ?? 0.03;
	if (sentToday >= 20 && bouncedToday / sentToday > ceiling) {
		return {
			allowed: false,
			limited: true,
			sent_today: sentToday,
			daily_limit: limit,
			day,
			reason: `Warm-up paused: today's bounce rate (${Math.round((bouncedToday / sentToday) * 100)}%) exceeded ${Math.round(ceiling * 100)}%`,
		};
	}
	if (sentToday >= limit) {
		return {
			allowed: false,
			limited: true,
			sent_today: sentToday,
			daily_limit: limit,
			day,
			reason: `Warm-up day ${day}/${cfg.ramp_days} cap reached (${sentToday}/${limit} sent today)`,
		};
	}
	return {
		allowed: true,
		limited: false,
		sent_today: sentToday,
		daily_limit: limit,
		day,
		reason: null,
	};
}

export async function saveDomainWarmup(
	organizationId: string,
	domainId: string,
	raw: unknown,
	now = Date.now(),
) {
	const v = warmupInput.parse(raw ?? {});
	const dom = await db.select().from(schema.domains).where(eq(schema.domains.id, domainId)).get();
	if (!dom || !(await brandIds(organizationId)).includes(dom.organization_id))
		throw notFound("Domain");

	const cfg: DomainWarmupConfig = {
		enabled: v.enabled,
		start_date: v.start_date ?? dom.warmup?.start_date ?? dayOf(now),
		daily_start: v.daily_start,
		daily_max: Math.max(v.daily_max, v.daily_start),
		ramp_days: v.ramp_days,
		pause_bounce_rate: v.pause_bounce_rate,
	};
	await db.update(schema.domains).set({ warmup: cfg }).where(eq(schema.domains.id, dom.id));
	forgetOrg(dom.organization_id);
	return { domain_id: dom.id, warmup: cfg, schedule: warmupSchedulePreview(cfg) };
}
