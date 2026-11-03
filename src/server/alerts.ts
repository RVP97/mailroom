import { and, eq, inArray, isNull } from "drizzle-orm";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { adminEmails, cfg } from "./env";
import { tenantSends } from "./org";
import { setDomainPaused } from "./provision";
import {
	DEFAULT_LIMITS,
	EMPTY_STATS,
	getSendingLimits,
	organizationActions,
	type SendingLimits,
	type StreamStats,
	streamStats,
	WINDOW_DAYS,
} from "./sending-limits";
import { sendSystemEmail, systemLayout } from "./system-email";
import { iso } from "./time";

/**
 * Emails an organization's owners and admins (and the deployment's admins) when a brand's
 * transactional or marketing domains cross the deployment's sending limits over the last 7 days
 * (src/server/sending-limits.ts), or SES pauses that tenant. One email per step up (ok → warning →
 * danger → paused); a step down only records the new level, so a rate hovering at a limit doesn't
 * send one every hour. At "danger" (the limits' act level), when the action is "pause", Mailroom
 * also pauses that brand's domains of that kind: only the deployment's admins can resume them.
 */

export type AlertLevel = "ok" | "warning" | "danger" | "paused";

const RANK: Record<AlertLevel, number> = { ok: 0, warning: 1, danger: 2, paused: 3 };

const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;

export function alertLevel(
	s: { sent: number; bounceRate: number; complaintRate: number; softBounceRate?: number },
	tenantStatus: string | null,
	limits: SendingLimits = DEFAULT_LIMITS,
): AlertLevel {
	if (!tenantSends(tenantStatus)) return "paused";
	if (s.sent < limits.min_sent) return "ok";
	const step = (v: number, l: { warning: number; danger: number }) =>
		v >= l.danger ? 2 : v >= l.warning ? 1 : 0;
	const worst = Math.max(
		step(s.bounceRate, limits.bounce),
		step(s.complaintRate, limits.complaint),
		(s.softBounceRate ?? 0) >= limits.soft_bounce_warning ? 1 : 0,
	);
	return (["ok", "warning", "danger"] as const)[worst] ?? "ok";
}

export async function checkAlerts(now = Date.now()) {
	const s = schema.orgSending;
	const brands = await db
		.select({
			id: s.organization_id,
			name: schema.organization.name,
			tenant_status: s.tenant_status,
			marketing_tenant_status: s.marketing_tenant_status,
			marketing_tenant_name: s.marketing_tenant_name,
			alert_level: s.alert_level,
			marketing_alert_level: s.marketing_alert_level,
		})
		.from(s)
		.innerJoin(schema.organization, eq(schema.organization.id, s.organization_id))
		.where(eq(s.status, "ready"));
	if (!brands.length) return;
	const limits = await getSendingLimits();
	const stats = await streamStats(now);
	const actions = new Map<string, Awaited<ReturnType<typeof organizationActions>>>();
	for (const brand of brands) {
		for (const stream of ["transactional", "marketing"] as const) {
			const numbers = stats.get(`${brand.id}:${stream}`) ?? EMPTY_STATS;
			const tenant =
				stream === "marketing" ? brand.marketing_tenant_status : brand.tenant_status;
			// A brand without a marketing tenant has nothing to judge there.
			if (stream === "marketing" && !brand.marketing_tenant_name && !numbers.sent) continue;
			const level = alertLevel(numbers, tenant, limits);
			const column = stream === "marketing" ? "marketing_alert_level" : "alert_level";
			const previous = (brand[column] ?? "ok") as AlertLevel;
			if (level === previous) continue;
			if (RANK[level] > RANK[previous]) {
				const org = await orgOf(brand.id);
				if (!actions.has(org)) actions.set(org, await organizationActions(org));
				const action = actions.get(org)?.[stream] ?? limits.actions[stream];
				const paused =
					level === "danger" && action === "pause"
						? await pauseStream(brand.id, stream, now)
						: [];
				try {
					await notify(brand, stream, level, numbers, limits, paused);
				} catch (error) {
					// Left at the old level, so the next run tries again.
					console.error("alerts: not sent", brand.id, error);
					continue;
				}
			}
			await db
				.update(s)
				.set({ [column]: level, alerted_at: iso(now) })
				.where(eq(s.organization_id, brand.id));
		}
	}
}

/** Pauses the brand's live sending domains of that kind; their names. */
async function pauseStream(brandId: string, stream: "transactional" | "marketing", now: number) {
	const d = schema.domains;
	const live = await db
		.select({ id: d.id, name: d.name })
		.from(d)
		.where(
			and(
				eq(d.organization_id, brandId),
				eq(d.purpose, stream),
				eq(d.sending, true),
				isNull(d.paused_at),
			),
		);
	for (const x of live) await setDomainPaused(brandId, x.id, true, "sending_limits", now);
	return live.map((x) => x.name);
}

/** The organization's owners and admins, and the deployment's admins. */
export async function recipients(organizationId: string) {
	const rows = await db
		.select({ email: schema.user.email })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(
			and(
				eq(schema.member.organizationId, organizationId),
				inArray(schema.member.role, ["owner", "admin"]),
			),
		);
	return [...new Set([...rows.map((r) => r.email.toLowerCase()), ...adminEmails()])];
}

async function notify(
	brand: { id: string; name: string },
	stream: "transactional" | "marketing",
	level: AlertLevel,
	n: StreamStats,
	limits: SendingLimits,
	paused: string[],
) {
	const what = stream === "marketing" ? `${brand.name}'s marketing emails` : brand.name;
	const subject =
		level === "paused"
			? `SES paused sending for ${what}`
			: paused.length
				? `Mailroom paused ${what}: bounces or complaints over the limit`
				: `${brand.name}: ${level === "danger" ? "over the sending limits" : "bounces or complaints are high"}${stream === "marketing" ? " (marketing)" : ""}`;
	const lines =
		level === "paused"
			? [
					`SES paused ${what} because of the tenant's reputation: those emails aren't going out. Other brands keep sending${stream === "marketing" ? ", and so do its transactional emails" : ""}.`,
					"Find out which addresses bounced or complained, stop sending to them, and ask AWS Support to review the tenant.",
				]
			: [
					`In the last ${WINDOW_DAYS} days ${what} sent ${n.sent} emails: ${n.bounced} bounced (${pct(n.bounceRate)}), ${n.softBounced} bounced softly (${pct(n.softBounceRate)}) and ${n.complained} were marked as spam (${pct(n.complaintRate)}).`,
					`This Mailroom warns at ${pct(limits.bounce.warning)} bounces or ${pct(limits.complaint.warning)} complaints and acts at ${pct(limits.bounce.danger)} or ${pct(limits.complaint.danger)}. SES reviews an account at 5% bounces or 0.1% complaints, and may pause it at 10% or 0.5%.`,
					paused.length
						? `Mailroom paused sending from ${paused.join(", ")} so SES doesn't pause the whole account. This deployment's admins can resume it in Domains once the list is cleaned.`
						: "",
					"Look at who bounced or complained, and stop sending to lists that weren't asked for.",
				].filter(Boolean);
	const body = systemLayout({
		title: subject,
		lines,
		button: { label: "Open Mailroom", url: cfg().BETTER_AUTH_URL ?? "" },
	});
	// A brand's alerts go to its organization's people.
	const to = await recipients(await orgOf(brand.id));
	const results = await Promise.allSettled(
		to.map((address) => sendSystemEmail({ to: address, subject, ...body })),
	);
	if (to.length && results.every((r) => r.status === "rejected"))
		throw (results[0] as PromiseRejectedResult).reason;
}
