import { eq } from "drizzle-orm";
import { recipients } from "./alerts";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { cfg } from "./env";
import { type Latency, SLOW_SECONDS, timeToInbox } from "./insights";
import { sendSystemEmail, systemLayout } from "./system-email";
import { iso } from "./time";

/**
 * Hourly: a brand whose emails of the last hour (broadcasts aside) took long to reach the
 * recipient's server, when there were at least MIN_EMAILS of them: half took over SLOW_SECONDS,
 * or a tenth over SLOW_P90_SECONDS. The owners and admins get one email, then none for a day.
 */

export const MIN_EMAILS = 20;
export const SLOW_P90_SECONDS = 300;
const HOUR = 3_600_000;
const QUIET_MS = 24 * HOUR;

export const isSlow = (l: Latency) =>
	l.count >= MIN_EMAILS && ((l.median ?? 0) > SLOW_SECONDS || (l.p90 ?? 0) > SLOW_P90_SECONDS);

const human = (s: number | null) =>
	s === null ? "—" : s < 90 ? `${Math.round(s)} seconds` : `${Math.round(s / 60)} minutes`;

export async function checkSlowDelivery(now = Date.now()) {
	const s = schema.orgSending;
	const brands = await db
		.select({
			id: s.organization_id,
			name: schema.organization.name,
			slow_alerted_at: s.slow_alerted_at,
		})
		.from(s)
		.innerJoin(schema.organization, eq(schema.organization.id, s.organization_id))
		.where(eq(s.status, "ready"));
	for (const brand of brands) {
		if (brand.slow_alerted_at && now - Date.parse(brand.slow_alerted_at) < QUIET_MS) continue;
		const t = await timeToInbox(brand.id, 1, now, { sinceMs: now - HOUR });
		if (!isSlow(t.all)) continue;
		const slowest = t.byProvider.filter(isSlow).map((p) => p.provider);
		const subject = `${brand.name}: emails are taking long to arrive`;
		const body = systemLayout({
			title: subject,
			lines: [
				`In the last hour ${brand.name} sent ${t.all.count} emails that were delivered. Half took over ${human(t.all.median)} from SES to the recipient's server, and one in ten over ${human(t.all.p90)}.`,
				slowest.length
					? `It's slowest at ${slowest.join(", ")}. A provider that slows one sender down is often deferring its email: look at Insights and at soft bounces.`
					: "It's slow at every provider, which usually means SES or the queue is behind: check the sending rate in the AWS account page.",
				"Login codes and password resets that take this long often get requested again.",
			],
			button: { label: "Open Insights", url: `${cfg().BETTER_AUTH_URL ?? ""}/insights` },
		});
		const to = await recipients(await orgOf(brand.id));
		const results = await Promise.allSettled(
			to.map((address) => sendSystemEmail({ to: address, subject, ...body })),
		);
		if (to.length && results.every((r) => r.status === "rejected")) {
			console.error("slow delivery: alert not sent", brand.id);
			continue;
		}
		await db
			.update(s)
			.set({ slow_alerted_at: iso(now) })
			.where(eq(s.organization_id, brand.id));
	}
}
