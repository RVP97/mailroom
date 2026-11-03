import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { getSetting, setSetting } from "./settings";
import { lastDays } from "./time";

/**
 * The deployment's sending limits (Admin › Sending limits): the bounce, complaint and soft-bounce
 * rates at which Mailroom warns an organization, and the rates at which it acts, judged over the
 * last WINDOW_DAYS once a stream sent `min_sent` emails. Each brand's transactional and marketing
 * domains are judged apart (they're separate SES tenants), and each kind has a default action at
 * the "act" level: alert only, or alert and pause those domains. An organization can override the
 * action (organization_settings). Mailroom's defaults sit under SES's own review (5% bounces,
 * 0.1% complaints) and pause (10%, 0.5%) levels, so it acts before SES does.
 */

export const WINDOW_DAYS = 7;
export type Stream = "transactional" | "marketing";
export type LimitAction = "alert" | "pause";

const rate = z.number().min(0).max(1);
const pair = z
	.object({ warning: rate, danger: rate })
	.refine((p) => p.warning <= p.danger, "the warning level can't be above the act level");

export const limitsInput = z.object({
	min_sent: z.number().int().min(1).max(1_000_000),
	bounce: pair,
	complaint: pair,
	/** Soft bounces (full inboxes, a server down) only ever warn: SES doesn't count them. */
	soft_bounce_warning: rate,
	actions: z.object({
		transactional: z.enum(["alert", "pause"]),
		marketing: z.enum(["alert", "pause"]),
	}),
});
export type SendingLimits = z.infer<typeof limitsInput>;

export const DEFAULT_LIMITS: SendingLimits = {
	min_sent: 100,
	bounce: { warning: 0.03, danger: 0.08 },
	complaint: { warning: 0.0008, danger: 0.003 },
	soft_bounce_warning: 0.1,
	actions: { transactional: "alert", marketing: "alert" },
};

export async function getSendingLimits(): Promise<SendingLimits> {
	const raw = await getSetting("sending_limits");
	if (!raw) return DEFAULT_LIMITS;
	try {
		const parsed = limitsInput.safeParse({ ...DEFAULT_LIMITS, ...JSON.parse(raw) });
		return parsed.success ? parsed.data : DEFAULT_LIMITS;
	} catch {
		return DEFAULT_LIMITS;
	}
}

export async function setSendingLimits(raw: unknown) {
	const v = limitsInput.parse(raw);
	await setSetting("sending_limits", JSON.stringify(v));
	return v;
}

/** An organization's own actions (null: the deployment's default). */
export async function organizationActions(organizationId: string) {
	const row = await db
		.select({
			transactional: schema.organizationSettings.transactional_action,
			marketing: schema.organizationSettings.marketing_action,
		})
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organization_id, organizationId))
		.get();
	const ok = (v: string | null | undefined) => (v === "alert" || v === "pause" ? v : null);
	return { transactional: ok(row?.transactional), marketing: ok(row?.marketing) };
}

export async function setOrganizationActions(
	organizationId: string,
	actions: { transactional?: LimitAction | null; marketing?: LimitAction | null },
	now = new Date().toISOString(),
) {
	const t = schema.organizationSettings;
	const set = {
		...(actions.transactional !== undefined
			? { transactional_action: actions.transactional }
			: {}),
		...(actions.marketing !== undefined ? { marketing_action: actions.marketing } : {}),
		updated_at: now,
	};
	await db
		.insert(t)
		.values({ organization_id: organizationId, ...set })
		.onConflictDoUpdate({ target: t.organization_id, set });
	return organizationActions(organizationId);
}

export interface StreamStats {
	sent: number;
	bounced: number;
	softBounced: number;
	complained: number;
	bounceRate: number;
	softBounceRate: number;
	complaintRate: number;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/**
 * Each brand's last WINDOW_DAYS by kind of domain (from the per-domain counters; a domain that's
 * gone counts as transactional). Keyed `<brand>:<stream>`.
 */
export async function streamStats(now = Date.now()) {
	const from = lastDays(WINDOW_DAYS, now)[0] as string;
	const rows = await db.all<{
		organization_id: string;
		purpose: string | null;
		sent: number;
		bounced: number;
		soft_bounced: number;
		complained: number;
	}>(sql`
		SELECT ds.organization_id, COALESCE(d.purpose, 'transactional') AS purpose,
			SUM(ds.sent) AS sent, SUM(ds.bounced) AS bounced,
			SUM(ds.soft_bounced) AS soft_bounced, SUM(ds.complained) AS complained
		FROM domain_stats ds
		LEFT JOIN domains d ON d.organization_id = ds.organization_id AND d.name = ds.domain
		WHERE ds.day >= ${from}
		GROUP BY 1, 2`);
	const out = new Map<string, StreamStats>();
	for (const r of rows) {
		const stream: Stream = r.purpose === "marketing" ? "marketing" : "transactional";
		const sent = Number(r.sent) || 0;
		const bounced = Number(r.bounced) || 0;
		const softBounced = Number(r.soft_bounced) || 0;
		const complained = Number(r.complained) || 0;
		out.set(`${r.organization_id}:${stream}`, {
			sent,
			bounced,
			softBounced,
			complained,
			bounceRate: ratio(bounced, sent),
			softBounceRate: ratio(softBounced, sent),
			complaintRate: ratio(complained, sent),
		});
	}
	return out;
}

export const EMPTY_STATS: StreamStats = {
	sent: 0,
	bounced: 0,
	softBounced: 0,
	complained: 0,
	bounceRate: 0,
	softBounceRate: 0,
	complaintRate: 0,
};
