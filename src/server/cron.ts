import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { purgeMailDomains } from "./address-checks";
import { checkAlerts } from "./alerts";
import {
	ARCHIVED_BRANDS,
	archiveBodies,
	archiveBucket,
	archivedBrands,
	archiveEmails,
} from "./archive";
import { checkUnknownRecipients } from "./auto-pause";
import { runAutomations } from "./automations";
import { runBroadcasts } from "./broadcasts";
import { db, schema } from "./db";
import { runDeliverabilityWatch } from "./deliverability";
import { runWeeklyDigest } from "./digest";
import { kickDispatcher } from "./dispatcher";
import { awsConfigured, bodyRetentionDays, logRetentionDays, requestLogRetentionDays } from "./env";
import { refreshDisposableIfDue } from "./firewall";
import { checkPendingReceiving, purgeReceived } from "./inbound";
import { runFeeds } from "./newsletters";
import { syncPostmaster } from "./postmaster";
import { checkPendingDomains, refreshTenantStatus, syncEventDestinations } from "./provision";
import { checkSlowDelivery } from "./slow-delivery";
import { iso } from "./time";
import { checkPendingTrackingHosts } from "./tracking";
import { retryDueDeliveries } from "./webhooks";

/**
 * Every minute: wake the Dispatcher (scheduled emails), queue broadcasts' next contacts, move automations on, settle sends that died mid-way and retry
 * webhook deliveries. Every 5 minutes: domains still being verified and SES's status of the
 * tenants (the least recently checked first), tracking hosts waiting for their CNAME and, until
 * it's done once, moving open and click tracking from SES to Mailroom, and receiving domains
 * whose MX doesn't point at SES yet. Every hour (minute 7): bounce and complaint alerts, domains to pause
 * for mailing addresses that don't exist (auto-pause.ts), brands whose emails take long to
 * arrive (slow-delivery.ts), and the firewall's
 * list of throwaway domains (at 04:07 UTC, or whenever it's empty).
 * At 03:00 UTC: what's past its retention. At 04:17 UTC: each verified domain's DNS and
 * blocklists (src/server/deliverability.ts). Every 6 hours (05:27 UTC…): Gmail Postmaster Tools
 * (postmaster.ts). Mondays at 14:37 UTC: the weekly digest (digest.ts). Every hour (minute
 * 23): newsletters' RSS feeds, whose new posts become issues (newsletters.ts). Organizations' own
 * SES accounts (org-aws-manage.ts): moves every 5 minutes, send rates hourly (minute 7).
 */
export async function runCron(scheduledTime: number) {
	const at = new Date(scheduledTime);
	const minute = at.getUTCMinutes();
	const jobs: Promise<unknown>[] = [
		kickDispatcher(),
		settleInterrupted(scheduledTime),
		retryDueDeliveries(scheduledTime),
		runBroadcasts(scheduledTime),
		runAutomations(scheduledTime),
	];
	if (awsConfigured() && minute % 5 === 0)
		jobs.push(
			checkPendingDomains(scheduledTime),
			refreshTenants(),
			syncEventDestinations(),
			checkPendingTrackingHosts(),
			checkPendingReceiving(),
		);
	// Organizations' own SES accounts: moves waiting on their domains, and each account's rate.
	if (minute % 5 === 0)
		jobs.push(import("./org-aws-manage").then((m) => m.checkMoves(scheduledTime)));
	if (minute === 7) jobs.push(import("./org-aws-manage").then((m) => m.refreshOwnAccounts()));
	if (minute === 7)
		jobs.push(
			checkAlerts(scheduledTime),
			refreshDisposableIfDue(scheduledTime),
			checkUnknownRecipients(scheduledTime),
			checkSlowDelivery(scheduledTime),
		);
	if (minute === 23) jobs.push(runFeeds(scheduledTime));
	if (at.getUTCHours() === 3 && minute === 0) jobs.push(purge(scheduledTime));
	if (at.getUTCHours() === 4 && minute === 17) jobs.push(runDeliverabilityWatch(scheduledTime));
	if (at.getUTCHours() % 6 === 5 && minute === 27) jobs.push(syncPostmaster(scheduledTime));
	if (at.getUTCDay() === 1 && at.getUTCHours() === 14 && minute === 37)
		jobs.push(runWeeklyDigest(scheduledTime));
	const results = await Promise.allSettled(jobs);
	for (const r of results)
		if (r.status === "rejected") console.error("cron: job failed", r.reason);
}

/**
 * A send (not queued) whose Worker died between recording it and hearing back from SES: it can't
 * be known whether SES took it, so it's marked failed rather than sent twice; SES's Send event,
 * if it comes, still moves it on.
 */
async function settleInterrupted(now: number) {
	const e = schema.emails;
	await db
		.update(e)
		.set({ status: "failed", error: "Interrupted before SES answered; check the events" })
		.where(
			and(
				eq(e.status, "sending"),
				isNull(e.send_at),
				isNull(e.message_id),
				lt(e.created_at, iso(now - 10 * 60_000)),
			),
		);
}

/** Tenants per run: each is one call to SES and one write. */
const TENANTS_PER_RUN = 100;

async function refreshTenants() {
	const s = schema.orgSending;
	const rows = await db
		.select({ id: s.organization_id })
		.from(s)
		.where(eq(s.status, "ready"))
		.orderBy(sql`${s.tenant_checked_at} IS NOT NULL, ${s.tenant_checked_at}`)
		.limit(TENANTS_PER_RUN);
	for (const r of rows) await refreshTenantStatus(r.id);
}

/** Deletes in chunks (a statement touching a huge number of rows goes over D1's limits). */
async function deleteInChunks(table: string, where: string, value: string, rounds = 8, also = "") {
	for (let i = 0; i < rounds; i++) {
		const res = await db.run(
			sql.raw(
				`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} < '${value.replace(/'/g, "")}'${also} LIMIT 2000)`,
			),
		);
		if (!res.meta.changes || res.meta.changes < 2000) return;
	}
}

export async function purge(now: number) {
	const bodiesBefore = iso(now - bodyRetentionDays() * 86_400_000);
	const logsBefore = iso(now - logRetentionDays() * 86_400_000);
	// Organizations that turned the archive on: their rows go to R2 first (and stay when R2
	// fails); everyone else's are only deleted.
	const bucket = archiveBucket();
	const notArchived = bucket ? sql`AND e.organization_id NOT IN (${archivedBrands})` : sql``;
	const notArchivedRaw = bucket ? ` AND organization_id NOT IN (${ARCHIVED_BRANDS})` : "";
	if (bucket)
		await archiveBodies(bucket, bodiesBefore).catch((error) =>
			console.error("archive: bodies not archived (kept for now)", error),
		);
	// Bodies of emails still waiting to go are kept whatever their age.
	for (let i = 0; i < 25; i++) {
		const res = await db.run(
			sql`DELETE FROM email_bodies WHERE rowid IN (SELECT b.rowid FROM email_bodies b JOIN emails e ON e.id = b.email_id WHERE b.created_at < ${bodiesBefore} AND e.status NOT IN ('queued', 'scheduled', 'sending') ${notArchived} LIMIT 2000)`,
		);
		if (!res.meta.changes || res.meta.changes < 2000) break;
	}
	// Inline images no email has used since the oldest body still kept.
	await deleteInChunks("inline_images", "last_used_at", bodiesBefore);
	await deleteInChunks("webhook_deliveries", "created_at", logsBefore);
	if (bucket)
		await archiveEmails(bucket, logsBefore).catch((error) =>
			console.error("archive: emails not archived (kept for now)", error),
		);
	await deleteInChunks("email_events", "at", logsBefore, 8, notArchivedRaw);
	await deleteInChunks("emails", "created_at", logsBefore, 8, notArchivedRaw);
	await deleteInChunks("dmarc_rows", "begin_at", logsBefore);
	await deleteInChunks("dmarc_reports", "begin_at", logsBefore);
	await deleteInChunks(
		"api_requests",
		"created_at",
		iso(now - requestLogRetentionDays() * 86_400_000),
	);
	await purgeMailDomains(now);
	await purgeReceived(now);
}
