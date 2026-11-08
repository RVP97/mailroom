import { eq, type SQL, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

/**
 * Who sits out promotional email for now. Two rules an organization can turn on (Settings):
 *
 *   Quiet mode: someone with an urgent conversation still open, or who rated their last
 *   conversation 2 or less in the past 14 days, gets no broadcasts or automation emails until
 *   that's behind them. Support first, marketing after.
 *
 *   Frequency cap: at most N broadcasts per person in D days. Automation emails count toward it
 *   but always go (a welcome or a receipt-like follow-up shouldn't wait).
 *
 * Neither ever touches transactional email (the API, SMTP, replies): only broadcasts and
 * automations' email steps look here.
 */

/** A rating this low, this recent, keeps someone quiet. */
export const QUIET_RATING = 2;
export const QUIET_DAYS = 14;

export interface MarketingRules {
	quiet_mode: boolean;
	cap: { count: number; days: number } | null;
}

const NONE: MarketingRules = { quiet_mode: false, cap: null };

/** The rules of an organization (a brand follows its organization's). */
export async function marketingRules(organizationId: string): Promise<MarketingRules> {
	const { orgOf } = await import("./brands");
	const id = await orgOf(organizationId);
	const row = await db
		.select({
			quiet: schema.organizationSettings.quiet_mode,
			count: schema.organizationSettings.cap_count,
			days: schema.organizationSettings.cap_days,
		})
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organization_id, id))
		.get();
	if (!row) return NONE;
	return {
		quiet_mode: row.quiet,
		cap: row.count && row.days ? { count: row.count, days: row.days } : null,
	};
}

export async function setMarketingRules(
	organizationId: string,
	v: { quiet_mode?: boolean; cap?: { count: number; days: number } | null },
	now = Date.now(),
) {
	if (v.cap) {
		if (!Number.isInteger(v.cap.count) || v.cap.count < 1 || v.cap.count > 100)
			throw validation("The cap is 1 to 100 emails");
		if (!Number.isInteger(v.cap.days) || v.cap.days < 1 || v.cap.days > 90)
			throw validation("The cap's window is 1 to 90 days");
	}
	const set = {
		...(v.quiet_mode !== undefined ? { quiet_mode: v.quiet_mode } : {}),
		...(v.cap !== undefined
			? { cap_count: v.cap?.count ?? null, cap_days: v.cap?.days ?? null }
			: {}),
		updated_at: iso(now),
	};
	await db
		.insert(schema.organizationSettings)
		.values({ organization_id: organizationId, ...set })
		.onConflictDoUpdate({ target: schema.organizationSettings.organization_id, set });
	return marketingRules(organizationId);
}

/** The conversation that keeps an address quiet, as SQL on its brand and address. */
function quietWhere(brand: string, address: SQL | string, now: number) {
	const since = iso(now - QUIET_DAYS * 86_400_000);
	return sql`SELECT 1 FROM conversations AS qc WHERE qc.organization_id = ${brand} AND qc.contact_address = ${address} AND ((qc.status <> 'resolved' AND qc.priority = 'urgent') OR (qc.csat_rating IS NOT NULL AND qc.csat_rating <= ${QUIET_RATING} AND qc.csat_at > ${since}))`;
}

function capCount(brand: string, address: SQL | string, days: number, now: number) {
	const since = iso(now - days * 86_400_000);
	return sql`(SELECT count(*) FROM emails AS fc WHERE fc.organization_id = ${brand} AND fc.recipient = ${address} AND fc.source = 'broadcast' AND fc.created_at > ${since} AND fc.status NOT IN ('canceled', 'failed', 'suppressed'))`;
}

/**
 * Conditions on the contacts table for a broadcast's recipients: who the rules leave out.
 * `email` is the contacts' email column.
 */
export function broadcastHolds(brand: string, rules: MarketingRules, email: SQL, now = Date.now()) {
	const out: SQL[] = [];
	if (rules.quiet_mode) out.push(sql`NOT EXISTS (${quietWhere(brand, email, now)})`);
	if (rules.cap)
		out.push(sql`${capCount(brand, email, rules.cap.days, now)} < ${rules.cap.count}`);
	return out;
}

/** Why one person sits out an automation email now ("quiet"), or null. Caps don't hold these. */
export async function automationHold(brand: string, email: string, now = Date.now()) {
	const rules = await marketingRules(brand);
	if (!rules.quiet_mode) return null;
	const row = await db.get<{ x: number }>(
		sql`${quietWhere(brand, email.toLowerCase(), now)} LIMIT 1`,
	);
	return row ? ("quiet" as const) : null;
}

/** For the person panel: whether quiet mode or the cap would hold them out of a broadcast now. */
export async function personHolds(brand: string, email: string, now = Date.now()) {
	const rules = await marketingRules(brand);
	const address = email.toLowerCase();
	const quiet = rules.quiet_mode
		? !!(await db.get<{ x: number }>(sql`${quietWhere(brand, address, now)} LIMIT 1`))
		: false;
	let sent = 0;
	if (rules.cap) {
		const row = await db.get<{ n: number }>(
			sql`SELECT ${capCount(brand, address, rules.cap.days, now)} AS n`,
		);
		sent = Number(row?.n ?? 0);
	}
	return {
		quiet,
		capped: !!rules.cap && sent >= rules.cap.count,
		cap: rules.cap ? { ...rules.cap, sent } : null,
	};
}

/** How many of a broadcast's audience the rules hold out (the send dialog's note). */
export async function heldOutCount(
	brand: string,
	segmentId: string,
	rules: MarketingRules,
	now = Date.now(),
) {
	const holds = broadcastHolds(brand, rules, sql`c.email`, now);
	if (!holds.length) return 0;
	const row = await db.get<{ n: number }>(
		sql`SELECT count(*) AS n FROM contacts AS c JOIN contact_segments AS cs ON cs.contact_id = c.id WHERE c.organization_id = ${brand} AND cs.segment_id = ${segmentId} AND c.unsubscribed = 0 AND NOT (${sql.join(holds, sql` AND `)})`,
	);
	return Number(row?.n ?? 0);
}
