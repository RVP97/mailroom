import { DurableObject, env } from "cloudflare:workers";
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { bareAddress } from "./aws/mime";
import { broadcastContent } from "./broadcasts";
import { db, schema } from "./db";
import { maxSendRate } from "./env";
import { domainFor, orgContext } from "./org";
import { paceFor } from "./org-aws";
import { deliver, markRefused, markSent, storedContents } from "./send";
import { iso } from "./time";

/**
 * One per deployment. It keeps the AWS account's send rate (MAX_SEND_RATE a second, across every
 * Worker) and drains the queue of batch, scheduled and retried emails with its alarm: each run
 * sends up to PER_RUN of what's due and sets the next run (at once if more is waiting, else at
 * the next scheduled email). The queue itself lives in D1 (emails with status queued/scheduled),
 * so nothing is lost if this object restarts; the cron kicks it every minute as a safety net.
 */

/**
 * Emails per alarm run. Each is one call to SES and one or two D1 queries (plus one per
 * organization), well inside Workers Paid's 1,000 of each per invocation; at the account's rate a
 * run takes a few seconds, and the next starts at once.
 */
const PER_RUN = 100;
/** A claimed email not settled in this time was left by a run that died: claimable again. */
const CLAIM_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Dispatcher extends DurableObject {
	/** When the next send may go, per SES account (each rate's token bucket, in memory). */
	private nextFree = new Map<string, number>();

	/**
	 * Milliseconds to wait before one more send at an account's rate: the deployment's
	 * ("default", MAX_SEND_RATE) or an organization's own (org-aws.ts, paceFor).
	 */
	async reserve(key = "default", perSecond = maxSendRate()): Promise<number> {
		const now = Date.now();
		const at = Math.max(now, this.nextFree.get(key) ?? 0);
		this.nextFree.set(key, at + 1000 / perSecond);
		return at - now;
	}

	/** Something is due now: run soon. */
	async kick(): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > Date.now() + 1000)
			await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const claimed = await claimDue(now, PER_RUN);
		const bodies = await storedContents(claimed.map((r) => r.id));
		for (const row of claimed) {
			try {
				const ctx = await orgContext(row.organization_id);
				// A paused brand or domain: its queue waits, looked at again every 15 minutes.
				if (ctx.paused || domainFor(ctx, bareAddress(row.from))?.paused) {
					await hold(row.id, now + HOLD_MS);
					continue;
				}
				// A broadcast's emails have no body of their own: it's the broadcast's, filled per contact.
				const fromBroadcast = bodies.has(row.id) ? null : await broadcastContent(row);
				const stored =
					bodies.get(row.id) ??
					(fromBroadcast && { content: fromBroadcast, attachments: [] });
				if (!stored) throw new Error("The email's content is gone (past its retention)");
				const messageId = await deliver(ctx, row, stored.content, {
					gate: async (brandId) => {
						const pace = await paceFor(brandId);
						const wait = await this.reserve(pace.key, pace.perSecond);
						if (wait > 0) await sleep(wait);
					},
				});
				await markSent(row.id, messageId);
				// Attachments were only kept to send: the dashboard needs the rest.
				if (stored.content.attachments?.length)
					await dropAttachments(row.id, stored.content);
			} catch (error) {
				console.error("dispatcher: send failed", row.id, error);
				await markRefused(row, error);
			}
		}
		const next = claimed.length === PER_RUN ? Date.now() : await nextDue();
		if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
	}
}

const HOLD_MS = 15 * 60_000;

/** Puts a claimed email back in the queue for later, unchanged. */
async function hold(emailId: string, until: number) {
	const e = schema.emails;
	await db
		.update(e)
		.set({ status: "queued", send_at: iso(until), locked_until: null })
		.where(eq(e.id, emailId));
}

/** Claims due emails (queued or scheduled, or left claimed by a dead run) in one statement. */
export async function claimDue(now: number, limit: number) {
	const e = schema.emails;
	const due = db
		.select({ id: e.id })
		.from(e)
		.where(
			and(
				or(
					sql`${e.status} IN ('queued', 'scheduled')`,
					sql`${e.status} = 'sending' AND ${e.locked_until} < ${iso(now)}`,
				),
				isNotNull(e.send_at),
				lte(e.send_at, iso(now)),
			),
		)
		.orderBy(asc(e.send_at))
		.limit(limit);
	return db
		.update(e)
		.set({ status: "sending", locked_until: iso(now + CLAIM_MS) })
		.where(inArray(e.id, due))
		.returning();
}

/** When the next scheduled email is due (null: nothing waiting). */
async function nextDue(): Promise<number | null> {
	const e = schema.emails;
	const row = await db
		.select({ at: sql<string | null>`MIN(${e.send_at})` })
		.from(e)
		.where(sql`${e.status} IN ('queued', 'scheduled')`)
		.get();
	return row?.at ? Date.parse(row.at) : null;
}

async function dropAttachments(emailId: string, content: { attachments?: unknown }) {
	const { gzipJson } = await import("./gzip");
	const { eq } = await import("drizzle-orm");
	const { attachments: _sent, ...rest } = content;
	await db
		.update(schema.emailBodies)
		.set({ content: Buffer.from(await gzipJson(rest)) })
		.where(eq(schema.emailBodies.email_id, emailId));
}

const stub = () => {
	const ns = (env as unknown as { DISPATCHER: DurableObjectNamespace<Dispatcher> }).DISPATCHER;
	return ns.get(ns.idFromName("dispatcher"));
};

/** Wakes the Dispatcher (after queueing emails, and from the cron). */
export const kickDispatcher = () => stub().kick();

/** Waits for one send's turn at the rate of the account the brand sends through. */
export async function rateGate(brandId?: string) {
	const pace = brandId ? await paceFor(brandId) : { key: "default", perSecond: maxSendRate() };
	const wait = await stub().reserve(pace.key, pace.perSecond);
	if (wait > 0) await sleep(wait);
}
