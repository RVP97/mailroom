import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { explainBounce } from "../lib/bounces";
import { bareAddress } from "./aws/mime";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { adminEmails, cfg } from "./env";
import { setDomainPaused } from "./provision";
import { sendSystemEmail, systemLayout } from "./system-email";
import { dayOf, iso } from "./time";

/**
 * Mailroom pauses a domain whose emails keep going to addresses that don't exist (an old or
 * bought list): left alone, those bounces get SES to pause the whole brand, receipts and codes
 * included. Hourly, over the last 24 hours (and only since the domain was last resumed): at least
 * MIN_UNKNOWN such bounces that are at least SHARE of what the brand sent.
 */

export const MIN_UNKNOWN = 25;
export const SHARE = 0.05;
const DAY = 86_400_000;
/** Bounced emails read per brand and run. */
const READ = 5000;

export async function checkUnknownRecipients(now = Date.now()) {
	const since = iso(now - DAY);
	// The counters' days are the deployment's time zone's (Mexico's evenings are UTC's next day).
	const days = [dayOf(now - DAY), dayOf(now)];
	const s = schema.dailyStats;
	// Cheap first pass: brands with enough hard bounces today and yesterday to matter.
	const brands = await db
		.select({
			id: s.organization_id,
			sent: sql<number>`SUM(${s.sent})`,
			bounced: sql<number>`SUM(${s.bounced})`,
		})
		.from(s)
		.where(inArray(s.day, days))
		.groupBy(s.organization_id)
		.having(sql`SUM(${s.bounced}) >= ${MIN_UNKNOWN}`);
	const paused: { brand: string; domain: string; count: number }[] = [];
	for (const b of brands) {
		const domains = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.organization_id, b.id));
		const live = domains.filter((d) => !d.paused_at);
		if (!live.length) continue;
		const e = schema.emails;
		const rows = await db
			.select({
				from: e.from,
				to: e.to,
				bounce_type: e.bounce_type,
				error: e.error,
				bounced_at: e.bounced_at,
			})
			.from(e)
			.where(
				and(
					eq(e.organization_id, b.id),
					gte(e.created_at, iso(now - 2 * DAY)),
					isNotNull(e.bounced_at),
				),
			)
			.limit(READ);
		const count = new Map<string, number>();
		for (const r of rows) {
			if (!r.bounced_at || r.bounced_at < since) continue;
			const host = bareAddress(r.from).split("@")[1]?.toLowerCase() ?? "";
			const d = live
				.filter((x) => host === x.name || host.endsWith(`.${x.name}`))
				.sort((x, y) => y.name.length - x.name.length)[0];
			if (!d || (d.resumed_at && r.bounced_at < d.resumed_at)) continue;
			const [type, subType] = (r.bounce_type ?? "").split("/");
			const why = explainBounce({ type, subType, message: r.error, recipient: r.to[0] });
			if (why.category === "unknown_recipient") count.set(d.id, (count.get(d.id) ?? 0) + 1);
		}
		const sent = Math.max(Number(b.sent) || 0, 1);
		for (const d of live) {
			const n = count.get(d.id) ?? 0;
			if (n < MIN_UNKNOWN || n / sent < SHARE) continue;
			await setDomainPaused(b.id, d.id, true, "unknown_recipients", now);
			paused.push({ brand: b.id, domain: d.name, count: n });
			await notify(b.id, d.name, n).catch((error) =>
				console.error("auto-pause: not emailed", d.name, error),
			);
		}
	}
	return paused;
}

async function notify(brandId: string, domain: string, count: number) {
	const org = await orgOf(brandId);
	const people = await db
		.select({ email: schema.user.email })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(
			and(
				eq(schema.member.organizationId, org),
				inArray(schema.member.role, ["owner", "admin"]),
			),
		);
	const to = [...new Set([...people.map((p) => p.email.toLowerCase()), ...adminEmails()])];
	const subject = `Mailroom paused ${domain}`;
	const body = systemLayout({
		title: subject,
		lines: [
			`In the last 24 hours ${count} emails from ${domain} went to addresses that don't exist. Left alone, that gets Amazon SES to pause the whole brand, receipts and codes included.`,
			"Clean the list it sends to (remove addresses that bounced), then resume the domain on its page. Emails sent meanwhile are refused with domain_paused.",
		],
		button: { label: "Open Mailroom", url: cfg().BETTER_AUTH_URL ?? "" },
	});
	await Promise.allSettled(
		to.map((address) => sendSystemEmail({ to: address, subject, ...body })),
	);
}
