import { eq, or, sql } from "drizzle-orm";
import { providerOf } from "../lib/providers";
import { type SnsMessage, trustedSnsUrl, verifySns } from "./aws/sns";
import { bump } from "./counters";
import { batch, db, raw, schema } from "./db";
import type { EmailStatus } from "./db/schema";
import { markDelivered } from "./mailbox-checks";
import { brandsOfOrganization, ownAccountByTopic } from "./org-aws";
import { getSetting, setSetting } from "./settings";
import { advanceStatus } from "./status";
import { dayOf, iso } from "./time";
import { emitEvent, type WebhookEvent } from "./webhooks";

/**
 * SES's events, through SNS to /webhooks/ses. Each one moves its email's status (never back),
 * adds to the day's counters, suppresses hard-bounced and complaining addresses and goes out to
 * the organization's webhooks. An event SNS delivers twice is applied once (its MessageId is the
 * event's id). Emails sent over SMTP (not through the API) are recorded from their first event,
 * found by their configuration set.
 */

export interface SesEvent {
	eventType?: string;
	/** Notifications set on the identity instead of a configuration set. */
	notificationType?: string;
	mail?: {
		messageId?: string;
		timestamp?: string;
		source?: string;
		destination?: string[];
		commonHeaders?: { from?: string[]; to?: string[]; cc?: string[]; subject?: string };
		tags?: Record<string, string[]>;
	};
	bounce?: {
		bounceType?: string;
		bounceSubType?: string;
		timestamp?: string;
		bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string; status?: string }[];
	};
	complaint?: {
		timestamp?: string;
		complainedRecipients?: { emailAddress?: string }[];
		complaintFeedbackType?: string;
	};
	delivery?: { timestamp?: string; recipients?: string[]; smtpResponse?: string };
	open?: { timestamp?: string; ipAddress?: string; userAgent?: string };
	click?: { timestamp?: string; ipAddress?: string; userAgent?: string; link?: string };
	deliveryDelay?: {
		timestamp?: string;
		delayType?: string;
		delayedRecipients?: { emailAddress?: string; diagnosticCode?: string }[];
	};
	reject?: { reason?: string };
	failure?: { errorMessage?: string };
}

const TYPES: Record<string, WebhookEvent> = {
	Send: "email.sent",
	Delivery: "email.delivered",
	DeliveryDelay: "email.delivery_delayed",
	Open: "email.opened",
	Click: "email.clicked",
	Bounce: "email.bounced",
	Reject: "email.failed",
	RenderingFailure: "email.failed",
	Complaint: "email.complained",
};

const STATUS: Partial<Record<WebhookEvent, EmailStatus>> = {
	"email.sent": "sent",
	"email.delivered": "delivered",
	"email.delivery_delayed": "delivery_delayed",
	"email.bounced": "bounced",
	"email.complained": "complained",
	"email.failed": "failed",
	"email.suppressed": "suppressed",
};

export const eventKind = (e: SesEvent) => e.eventType ?? e.notificationType ?? "";

/** When the event happened (its own timestamp, else the email's). */
export function eventTime(e: SesEvent): string {
	return (
		e.bounce?.timestamp ??
		e.complaint?.timestamp ??
		e.delivery?.timestamp ??
		e.open?.timestamp ??
		e.click?.timestamp ??
		e.deliveryDelay?.timestamp ??
		e.mail?.timestamp ??
		iso()
	);
}

/** What the webhook carries beyond the email (Resend's fields). */
export function eventData(e: SesEvent): Record<string, unknown> {
	if (e.bounce) {
		const first = e.bounce.bouncedRecipients?.[0];
		return {
			bounce: {
				type: e.bounce.bounceType,
				subType: e.bounce.bounceSubType,
				message: first?.diagnosticCode ?? first?.status ?? "",
			},
			bounced_recipients: (e.bounce.bouncedRecipients ?? []).flatMap((r) =>
				r.emailAddress ? [r.emailAddress.toLowerCase()] : [],
			),
		};
	}
	if (e.click)
		return {
			click: {
				ipAddress: e.click.ipAddress,
				link: e.click.link,
				timestamp: e.click.timestamp,
				userAgent: e.click.userAgent,
			},
		};
	if (e.open)
		return {
			open: {
				ipAddress: e.open.ipAddress,
				timestamp: e.open.timestamp,
				userAgent: e.open.userAgent,
			},
		};
	if (e.reject) return { failed: { reason: e.reject.reason } };
	if (e.failure) return { failed: { reason: e.failure.errorMessage } };
	if (e.deliveryDelay)
		return {
			delay: {
				type: e.deliveryDelay.delayType,
				recipients: (e.deliveryDelay.delayedRecipients ?? []).map((r) => r.emailAddress),
			},
		};
	if (e.complaint) return { complaint: { type: e.complaint.complaintFeedbackType ?? null } };
	return {};
}

const firstRecipient = (e: SesEvent) =>
	e.bounce?.bouncedRecipients?.[0]?.emailAddress ??
	e.complaint?.complainedRecipients?.[0]?.emailAddress ??
	e.delivery?.recipients?.[0] ??
	e.deliveryDelay?.delayedRecipients?.[0]?.emailAddress ??
	null;

/** The email an event is about (and its organization), recording an SMTP-sent one. */
async function emailOf(e: SesEvent, now: number, brands?: string[]) {
	const messageId = e.mail?.messageId;
	const ours = e.mail?.tags?.mailroom_id?.[0];
	const em = schema.emails;
	if (ours) {
		const row = await db.select().from(em).where(eq(em.id, ours)).get();
		if (row) return row;
	}
	if (!messageId) return null;
	const known = await db.select().from(em).where(eq(em.message_id, messageId)).get();
	if (known) return known;
	// Sent over SMTP with one of our configuration sets: recorded now.
	const configurationSet = e.mail?.tags?.["ses:configuration-set"]?.[0];
	if (!configurationSet) return null;
	const owner = await db
		.select({ organization_id: schema.orgSending.organization_id })
		.from(schema.orgSending)
		.where(
			or(
				eq(schema.orgSending.configuration_set, configurationSet),
				eq(schema.orgSending.marketing_configuration_set, configurationSet),
			),
		)
		.get();
	if (!owner || (brands && !brands.includes(owner.organization_id))) return null;
	const h = e.mail?.commonHeaders ?? {};
	await db
		.insert(em)
		.values({
			id: crypto.randomUUID(),
			organization_id: owner.organization_id,
			message_id: messageId,
			from: h.from?.[0] ?? e.mail?.source ?? "",
			to: h.to ?? e.mail?.destination ?? [],
			cc: h.cc?.length ? h.cc : null,
			subject: h.subject ?? "",
			status: "sent",
			source: "smtp",
			created_at: e.mail?.timestamp ?? iso(now),
			sent_at: e.mail?.timestamp ?? iso(now),
		})
		.onConflictDoNothing();
	return (await db.select().from(em).where(eq(em.message_id, messageId)).get()) ?? null;
}

type ProviderCounter = "sent" | "delivered" | "bounced" | "complained" | "opened";

function providerCounter(
	kind: string,
	validationBlock: boolean,
	softBounce: boolean,
): ProviderCounter | null {
	if (kind === "Send") return "sent";
	if (kind === "Delivery") return "delivered";
	if (kind === "Bounce") return validationBlock || softBounce ? null : "bounced";
	if (kind === "Complaint") return "complained";
	if (kind === "Open") return "opened";
	return null;
}

/** One more in the provider's counter for the day; opens only the first time per email. */
const bumpProvider = (
	organizationId: string,
	day: string,
	provider: string,
	counter: ProviderCounter,
	firstOpenOf: string | null,
) =>
	firstOpenOf
		? raw(
				`INSERT INTO provider_stats (organization_id, day, provider, ${counter})
				SELECT ?1, ?2, ?3, 1 WHERE (SELECT opened_at FROM emails WHERE id = ?4) IS NULL
				ON CONFLICT (organization_id, day, provider) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
				provider,
				firstOpenOf,
			)
		: raw(
				`INSERT INTO provider_stats (organization_id, day, provider, ${counter}) VALUES (?1, ?2, ?3, 1)
				ON CONFLICT (organization_id, day, provider) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
				provider,
			);

export type ApplyResult = "applied" | "duplicate" | "ignored";

/**
 * One SES event, applied once. `brands`: the only brands it may be about (an event from an
 * organization's own account, whose owner could publish anything to its topic).
 */
export async function applySesEvent(
	e: SesEvent,
	eventId: string,
	now = Date.now(),
	o: { brands?: string[] } = {},
): Promise<ApplyResult> {
	const kind = eventKind(e);
	// Two bounces that aren't the address's fault:
	// - SES's Auto Validation held the email back (never sent; left out of SES's bounce rate);
	// - a soft bounce: SES gave up on the receiving server (full, looping, down), not the address.
	const validationBlock =
		kind === "Bounce" && e.bounce?.bounceSubType === "EmailValidationSuppressed";
	const softBounce =
		kind === "Bounce" && !validationBlock && e.bounce?.bounceType === "Transient";
	const type: WebhookEvent | undefined = validationBlock ? "email.suppressed" : TYPES[kind];
	if (!type) return "ignored";
	const email = await emailOf(e, now, o.brands);
	if (!email) return "ignored";
	if (o.brands && !o.brands.includes(email.organization_id)) return "ignored";
	const at = eventTime(e);
	const data = eventData(e);
	const inserted = await db
		.insert(schema.emailEvents)
		.values({
			id: eventId,
			email_id: email.id,
			organization_id: email.organization_id,
			type,
			at,
			recipient: firstRecipient(e)?.toLowerCase() ?? null,
			data,
		})
		.onConflictDoNothing()
		.returning({ id: schema.emailEvents.id });
	if (!inserted.length) return "duplicate";

	const em = schema.emails;
	const org = email.organization_id;
	const day = dayOf(at);
	const from = email.from;
	// A soft bounce has its own status: never delivered, but the address isn't to blame.
	const status = softBounce ? "soft_bounced" : STATUS[type];
	const last = softBounce ? "soft_bounced" : type.slice(6);
	const set: Record<string, unknown> = {
		last_event: sql`CASE WHEN ${em.last_event_at} IS NULL OR ${at} >= ${em.last_event_at} THEN ${last} ELSE ${em.last_event} END`,
		last_event_at: sql`CASE WHEN ${em.last_event_at} IS NULL OR ${at} >= ${em.last_event_at} THEN ${at} ELSE ${em.last_event_at} END`,
	};
	if (status) set.status = advanceStatus(status);
	const queries: Parameters<typeof batch>[0] = [];
	switch (kind) {
		case "Send":
			set.sent_at = sql`COALESCE(${em.sent_at}, ${at})`;
			queries.push(...bump(org, day, from, "sent"));
			break;
		case "Delivery":
			set.delivered_at = sql`COALESCE(${em.delivered_at}, ${at})`;
			queries.push(...bump(org, day, from, "delivered"));
			queries.push(...markDelivered(e.delivery?.recipients ?? [], at));
			break;
		case "DeliveryDelay":
			queries.push(...bump(org, day, from, "delayed"));
			break;
		case "Bounce": {
			const hard = e.bounce?.bounceType === "Permanent";
			if (hard && !validationBlock) set.bounced_at = sql`COALESCE(${em.bounced_at}, ${at})`;
			set.bounce_type = `${e.bounce?.bounceType ?? ""}${e.bounce?.bounceSubType ? `/${e.bounce.bounceSubType}` : ""}`;
			set.error =
				((data.bounce as { message?: string }).message || null)?.slice(0, 500) ?? null;
			queries.push(
				...bump(
					org,
					day,
					from,
					validationBlock ? "suppressed" : hard ? "bounced" : "soft_bounced",
				),
			);
			if (hard)
				for (const r of e.bounce?.bouncedRecipients ?? [])
					if (r.emailAddress)
						queries.push(
							db
								.insert(schema.suppressions)
								.values({
									organization_id: org,
									address: r.emailAddress.toLowerCase(),
									reason: "bounce",
									detail: (
										r.diagnosticCode ??
										e.bounce?.bounceSubType ??
										""
									).slice(0, 300),
									email_id: email.id,
									created_at: at,
								})
								.onConflictDoNothing(),
						);
			break;
		}
		case "Complaint":
			set.complained_at = sql`COALESCE(${em.complained_at}, ${at})`;
			queries.push(...bump(org, day, from, "complained"));
			for (const r of e.complaint?.complainedRecipients ?? [])
				if (r.emailAddress)
					queries.push(
						db
							.insert(schema.suppressions)
							.values({
								organization_id: org,
								address: r.emailAddress.toLowerCase(),
								reason: "complaint",
								detail: e.complaint?.complaintFeedbackType ?? null,
								email_id: email.id,
								created_at: at,
							})
							.onConflictDoNothing(),
					);
			break;
		case "Open":
			queries.push(
				...bump(org, day, from, "opened", { emailId: email.id, column: "opened_at" }),
			);
			set.opened_at = sql`COALESCE(${em.opened_at}, ${at})`;
			set.open_count = sql`${em.open_count} + 1`;
			break;
		case "Click":
			queries.push(
				...bump(org, day, from, "clicked", { emailId: email.id, column: "clicked_at" }),
			);
			set.clicked_at = sql`COALESCE(${em.clicked_at}, ${at})`;
			set.click_count = sql`${em.click_count} + 1`;
			break;
		case "Reject":
		case "RenderingFailure":
			set.error = String((data.failed as { reason?: string }).reason ?? kind).slice(0, 500);
			queries.push(...bump(org, day, from, "failed"));
			break;
	}
	// By mailbox provider (Gmail, Outlook…), from the event's first recipient.
	const counter = providerCounter(kind, validationBlock, softBounce);
	if (counter) {
		const to =
			firstRecipient(e) ?? e.mail?.destination?.[0] ?? (email.to as string[])[0] ?? null;
		queries.push(
			bumpProvider(org, day, providerOf(to), counter, counter === "opened" ? email.id : null),
		);
	}
	// The counters go first: the first-open/click checks read the email before it changes.
	queries.push(db.update(em).set(set).where(eq(em.id, email.id)));
	await batch(queries);
	await emitEvent(org, type, email.id, data, now, email);
	// Automations that start when a broadcast is opened (the first time) or a link clicked.
	if (email.broadcast_id && ((kind === "Open" && !email.opened_at) || kind === "Click")) {
		const { onEngaged } = await import("./automations");
		await onEngaged(
			email as { organization_id: string; broadcast_id: string; to: string[] },
			kind === "Open" ? "opened" : "clicked",
			kind === "Click" ? (e.click?.link ?? null) : null,
			now,
		).catch((error) => console.error("automations: not started", error));
	}
	return "applied";
}

export type SnsResult = "applied" | "duplicate" | "ignored" | "confirmed" | "invalid" | "retry";

/**
 * One SNS post: its subscription's confirmation (only for our topic) or an SES event. The topic
 * is the one set up in AWS setup (app_settings.sns_topic_arn).
 */
export async function handleSns(
	m: SnsMessage,
	o: { fetcher?: typeof fetch; now?: number } = {},
): Promise<SnsResult> {
	const fetcher = o.fetcher ?? fetch;
	const now = o.now ?? Date.now();
	const topic = await getSetting("sns_topic_arn");
	// Or the topic of an organization's own SES account (src/server/org-aws.ts).
	const own =
		topic && m.TopicArn === topic
			? null
			: m.TopicArn
				? ((await ownAccountByTopic(m.TopicArn)) ?? null)
				: null;
	// Or the topic of the account an organization is moving to (only its subscription, until then).
	const moving =
		!own && m.TopicArn && m.TopicArn !== topic
			? ((await db
					.select()
					.from(schema.orgAwsMoves)
					.where(eq(schema.orgAwsMoves.to_topic_arn, m.TopicArn))
					.get()) ?? null)
			: null;
	if ((!topic || m.TopicArn !== topic) && !own && !moving) return "invalid";
	if (!(await verifySns(m, fetcher))) return "invalid";
	if (m.Type === "SubscriptionConfirmation") {
		const url = trustedSnsUrl(m.SubscribeURL);
		if (!url) return "invalid";
		const res = await fetcher(url, { signal: AbortSignal.timeout(10_000) });
		if (!res.ok) return "retry";
		if (moving)
			await db
				.update(schema.orgAwsMoves)
				.set({ subscription_confirmed_at: iso(now) })
				.where(eq(schema.orgAwsMoves.organization_id, moving.organization_id));
		else if (own)
			await db
				.update(schema.orgAws)
				.set({ subscription_confirmed_at: iso(now) })
				.where(eq(schema.orgAws.organization_id, own.organization_id));
		else await setSetting("sns_subscription_confirmed_at", iso(now));
		return "confirmed";
	}
	if (m.Type !== "Notification" || moving) return "ignored";
	let event: SesEvent & { receipt?: unknown };
	try {
		event = JSON.parse(m.Message) as SesEvent;
	} catch {
		return "ignored";
	}
	// An organization's own account: sending events about its own brands' emails, nothing else.
	if (own) {
		if (event.notificationType === "Received") {
			const { receiveSes } = await import("./inbound");
			return receiveSes(event as never, now, { own });
		}
		if (!own.last_event_at || Date.parse(own.last_event_at) < now - 10 * 60_000)
			await db
				.update(schema.orgAws)
				.set({ last_event_at: iso(now) })
				.where(eq(schema.orgAws.organization_id, own.organization_id));
		return applySesEvent(event, `sns:${m.MessageId}`, now, {
			brands: await brandsOfOrganization(own.organization_id),
		});
	}
	// A message SES received for one of our domains (src/server/inbound.ts).
	if (event.notificationType === "Received") {
		const { receiveSes } = await import("./inbound");
		return receiveSes(event as never, now);
	}
	const last = await getSetting("sns_last_event_at");
	if (!last || Date.parse(last) < now - 10 * 60_000)
		await setSetting("sns_last_event_at", iso(now));
	return applySesEvent(event, `sns:${m.MessageId}`, now);
}
