import { waitUntil } from "cloudflare:workers";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { utf8Base64 } from "./aws/mime";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * Webhooks: each organization's endpoints get its emails' events, in Resend's shape and signed
 * the Standard Webhooks way (svix-* headers too, so Resend's and Svix's verifiers work). A
 * delivery is tried at once; failures are retried by the cron on Svix's schedule, then given up.
 */

export const WEBHOOK_EVENTS = [
	"email.sent",
	"email.delivered",
	"email.delivery_delayed",
	"email.bounced",
	"email.complained",
	"email.opened",
	"email.clicked",
	"email.failed",
	"email.suppressed",
	"email.scheduled",
	"email.unsubscribed",
	"email.received",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Seconds after the first try (Svix's schedule): then the delivery is given up. */
const RETRY_AFTER_S = [5, 5 * 60, 30 * 60, 2 * 3600, 5 * 3600, 10 * 3600, 10 * 3600];
export const MAX_DELIVERY_ATTEMPTS = RETRY_AFTER_S.length + 1;
/** Deliveries tried per cron run: each is one outside call and one D1 write. */
const PER_RUN = 200;
/** Failures in a row before an endpoint is Down: new events then wait for the retries. */
export const DOWN_AFTER = 8;
/** While Down, a new event's first try waits this long (the retries probe the endpoint). */
const DOWN_WAIT_MS = 5 * 60_000;

export function newSecret() {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return `whsec_${utf8Base64(bytes)}`;
}

/** Standard Webhooks' signature: base64 HMAC-SHA256 of «id.timestamp.body». */
export async function sign(secret: string, id: string, timestamp: number, body: string) {
	const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey(
		"raw",
		raw,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`${id}.${timestamp}.${body}`),
	);
	return `v1,${utf8Base64(new Uint8Array(mac))}`;
}

export async function signedHeaders(secret: string, id: string, body: string, now = Date.now()) {
	const ts = Math.floor(now / 1000);
	const signature = await sign(secret, id, ts, body);
	return {
		"content-type": "application/json",
		"user-agent": "Mailroom-Webhooks/1",
		"webhook-id": id,
		"webhook-timestamp": String(ts),
		"webhook-signature": signature,
		"svix-id": id,
		"svix-timestamp": String(ts),
		"svix-signature": signature,
	};
}

const hooksCache = new Map<
	string,
	{ value: (typeof schema.webhooks.$inferSelect)[]; until: number }
>();
export const forgetHooks = (organizationId: string) => hooksCache.delete(organizationId);

async function hooksOf(organizationId: string) {
	const hit = hooksCache.get(organizationId);
	if (hit && hit.until > Date.now()) return hit.value;
	const value = await db
		.select()
		.from(schema.webhooks)
		.where(
			and(
				eq(schema.webhooks.organization_id, organizationId),
				eq(schema.webhooks.enabled, true),
			),
		);
	hooksCache.set(organizationId, { value, until: Date.now() + 15_000 });
	return value;
}

type EmailSummary = Pick<
	typeof schema.emails.$inferSelect,
	"id" | "from" | "to" | "subject" | "created_at" | "tags"
>;

/** The event as Resend sends it. */
export function payloadOf(
	type: string,
	email: EmailSummary | null,
	emailId: string,
	data: Record<string, unknown>,
	now: number,
) {
	return {
		type,
		created_at: iso(now),
		data: {
			email_id: emailId,
			...(email
				? {
						created_at: email.created_at,
						from: email.from,
						to: email.to,
						subject: email.subject,
						tags: Object.fromEntries((email.tags ?? []).map((t) => [t.name, t.value])),
					}
				: {}),
			...data,
		},
	};
}

/**
 * An email's event (of a brand) for its organization's webhooks: recorded for each subscribed endpoint and
 * tried right away (in the background).
 */
export async function emitEvent(
	organizationId: string,
	type: WebhookEvent,
	emailId: string,
	data: Record<string, unknown>,
	now = Date.now(),
	email?: EmailSummary | null,
) {
	// A brand's events go to its organization's webhooks.
	const org = await orgOf(organizationId);
	const hooks = (await hooksOf(org)).filter((h) => h.events.includes(type));
	if (!hooks.length) return;
	const summary =
		email ??
		(await db
			.select({
				id: schema.emails.id,
				from: schema.emails.from,
				to: schema.emails.to,
				subject: schema.emails.subject,
				created_at: schema.emails.created_at,
				tags: schema.emails.tags,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get()) ??
		null;
	// Which brand it's about; organization_id is its first name, kept for apps that read it.
	const payload = JSON.stringify(
		payloadOf(
			type,
			summary,
			emailId,
			{
				...data,
				brand_id: organizationId,
				...(org !== organizationId ? { organization_id: organizationId } : {}),
			},
			now,
		),
	);
	const rows = hooks.map((h) => ({
		id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
		webhook_id: h.id,
		organization_id: h.organization_id,
		email_id: emailId,
		event_type: type,
		payload,
		status: "pending",
		// A Down endpoint isn't hammered: its events queue for the retries.
		next_attempt_at: iso(h.down_since ? now + DOWN_WAIT_MS : now),
		created_at: iso(now),
	}));
	await db.insert(schema.webhookDeliveries).values(rows);
	const attempt = Promise.all(
		rows.map((r) => {
			const hook = hooks.find((h) => h.id === r.webhook_id);
			return hook && !hook.down_since ? deliverOne({ ...r, attempts: 0 }, hook) : null;
		}),
	).catch((error) => console.error("webhooks: first try failed", error));
	try {
		waitUntil(attempt);
	} catch {
		await attempt;
	}
}

/** Tries one delivery and records how it went. */
export async function deliverOne(
	d: { id: string; payload: string; attempts: number },
	hook: { id?: string; url: string; secret: string },
	fetcher: typeof fetch = fetch,
	now = Date.now(),
) {
	let status = 0;
	let body = "";
	try {
		const res = await fetcher(hook.url, {
			method: "POST",
			headers: await signedHeaders(hook.secret, d.id, d.payload, now),
			body: d.payload,
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		status = res.status;
		body = (await res.text().catch(() => "")).slice(0, 500);
	} catch (error) {
		body = error instanceof Error ? error.message : String(error);
	}
	const attempts = d.attempts + 1;
	const ok = status >= 200 && status < 300;
	const wait = RETRY_AFTER_S[attempts - 1];
	await db
		.update(schema.webhookDeliveries)
		.set(
			ok
				? {
						status: "delivered",
						attempts,
						response_status: status,
						response_body: body,
						delivered_at: iso(now),
						next_attempt_at: null,
					}
				: wait === undefined
					? {
							status: "failed",
							attempts,
							response_status: status || null,
							response_body: body,
							next_attempt_at: null,
						}
					: {
							attempts,
							response_status: status || null,
							response_body: body,
							next_attempt_at: iso(now + wait * 1000),
						},
		)
		.where(eq(schema.webhookDeliveries.id, d.id));
	if (hook.id) await recordHealth(hook.id, ok, now);
	return ok;
}

/**
 * An endpoint's health: DOWN_AFTER failures in a row make it Down (its new events wait for the
 * retries instead of a first try); one success makes it healthy again.
 */
async function recordHealth(webhookId: string, ok: boolean, now: number) {
	const h = schema.webhooks;
	const [row] = await db
		.update(h)
		.set(
			ok
				? { failures: 0, down_since: null }
				: {
						failures: sql`${h.failures} + 1`,
						down_since: sql`CASE WHEN ${h.down_since} IS NULL AND ${h.failures} + 1 >= ${DOWN_AFTER} THEN ${iso(now)} ELSE ${h.down_since} END`,
					},
		)
		.where(eq(h.id, webhookId))
		.returning({ org: h.organization_id, down: h.down_since, failures: h.failures });
	if (row && (ok ? row.failures === 0 : row.failures === DOWN_AFTER)) forgetHooks(row.org);
}

/**
 * Sends again every delivery of an endpoint that was given up in the last `days` (up to 1,000):
 * after fixing it, nothing is lost. The cron sends them, oldest first.
 */
export async function replayFailed(
	organizationId: string,
	webhookId: string,
	o: { days?: number; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const w = schema.webhookDeliveries;
	const ids = await db
		.select({ id: w.id })
		.from(w)
		.where(
			and(
				eq(w.webhook_id, webhookId),
				eq(w.organization_id, organizationId),
				eq(w.status, "failed"),
				gte(w.created_at, iso(now - (o.days ?? 7) * 86_400_000)),
			),
		)
		.orderBy(asc(w.created_at))
		.limit(1000);
	for (let i = 0; i < ids.length; i += 90)
		await db
			.update(w)
			.set({
				status: "pending",
				// One more try each, then given up again if it still fails.
				attempts: MAX_DELIVERY_ATTEMPTS - 1,
				next_attempt_at: iso(now),
			})
			.where(
				inArray(
					w.id,
					ids.slice(i, i + 90).map((r) => r.id),
				),
			);
	return ids.length;
}

/** Cron: deliveries due for another try. */
export async function retryDueDeliveries(now = Date.now(), fetcher: typeof fetch = fetch) {
	const w = schema.webhookDeliveries;
	const due = await db
		.select({
			d: w,
			hookId: schema.webhooks.id,
			url: schema.webhooks.url,
			secret: schema.webhooks.secret,
			enabled: schema.webhooks.enabled,
		})
		.from(w)
		.innerJoin(schema.webhooks, eq(schema.webhooks.id, w.webhook_id))
		.where(and(eq(w.status, "pending"), lte(w.next_attempt_at, iso(now))))
		.orderBy(asc(w.next_attempt_at))
		.limit(PER_RUN);
	let delivered = 0;
	await Promise.all(
		due.map(async ({ d, hookId, url, secret, enabled }) => {
			if (!enabled) {
				await db
					.update(w)
					.set({
						status: "failed",
						response_body: "endpoint disabled",
						next_attempt_at: null,
					})
					.where(eq(w.id, d.id));
				return;
			}
			if (await deliverOne(d, { id: hookId, url, secret }, fetcher, now)) delivered++;
		}),
	);
	return { tried: due.length, delivered };
}

/** Sends again a delivery (any state), as a new try. */
export async function replayDelivery(organizationId: string, deliveryId: string) {
	const w = schema.webhookDeliveries;
	const row = await db
		.select({
			d: w,
			id: schema.webhooks.id,
			url: schema.webhooks.url,
			secret: schema.webhooks.secret,
		})
		.from(w)
		.innerJoin(schema.webhooks, eq(schema.webhooks.id, w.webhook_id))
		.where(and(eq(w.id, deliveryId), eq(w.organization_id, organizationId)))
		.get();
	if (!row) return null;
	await db.update(w).set({ status: "pending" }).where(eq(w.id, deliveryId));
	return deliverOne({ ...row.d, attempts: Math.max(0, row.d.attempts - 1) }, row);
}

/** A test event to one endpoint. */
export async function sendTestEvent(organizationId: string, webhookId: string) {
	const hook = await db
		.select()
		.from(schema.webhooks)
		.where(
			and(
				eq(schema.webhooks.id, webhookId),
				eq(schema.webhooks.organization_id, organizationId),
			),
		)
		.get();
	if (!hook) return null;
	const now = Date.now();
	const id = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
	const payload = JSON.stringify(
		payloadOf(
			"email.delivered",
			{
				id: "00000000-0000-0000-0000-000000000000",
				from: "Mailroom <test@example.com>",
				to: ["delivered@example.com"],
				subject: "Test event from Mailroom",
				created_at: iso(now),
				tags: [{ name: "test", value: "true" }],
			},
			"00000000-0000-0000-0000-000000000000",
			{},
			now,
		),
	);
	await db.insert(schema.webhookDeliveries).values({
		id,
		webhook_id: hook.id,
		organization_id: organizationId,
		event_type: "email.delivered",
		payload,
		status: "pending",
		created_at: iso(now),
	});
	return deliverOne({ id, payload, attempts: MAX_DELIVERY_ATTEMPTS - 1 }, hook);
}
