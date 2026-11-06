import { sql } from "drizzle-orm";
import {
	blob,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { BrandKit } from "../../lib/brand-kit";
import type { Block, EmailDoc } from "../../lib/email-doc";
import { organization } from "./auth-schema";

export * from "./auth-schema";

/**
 * Mailroom's own tables. Times are ISO strings (UTC).
 *
 * An organization (Better Auth's: Acme, Globex) is who signs in: its members, API keys,
 * webhooks and settings. A brand is who its emails are from (Harbor Inn, Seaside Hotel): one
 * SES tenant with its own configuration set, domains, suppressions and reputation. Every
 * organization is its own first brand (the default one, same id); its other brands are rows of
 * `organization` too, linked by `brands`. So on sending data (emails, domains, suppressions,
 * stats…) `organization_id` is the brand's id.
 */

const orgId = () =>
	text("organization_id")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" });

/** The deployment's own settings: the SNS topic, the AWS account id. */
export const appSettings = sqliteTable("app_settings", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	updated_at: text("updated_at").notNull(),
});

/**
 * An organization's own Amazon SES account (optional, src/server/org-aws.ts): its brands send,
 * verify domains and get their events through it instead of the deployment's account
 * (AWS_ACCESS_KEY_ID). The secret is encrypted with a key derived from BETTER_AUTH_SECRET.
 */
export const orgAws = sqliteTable("org_aws_accounts", {
	/** The organization (never a brand: its brands use the organization's account). */
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	access_key_id: text("access_key_id").notNull(),
	/** AES-GCM: "<iv base64>.<ciphertext base64>". */
	secret_encrypted: text("secret_encrypted").notNull(),
	region: text("region").notNull(),
	account_id: text("account_id").notNull(),
	/** Its own SNS topic (mailroom-ses-events in that account), subscribed to /webhooks/ses. */
	topic_arn: text("topic_arn"),
	subscription_confirmed_at: text("subscription_confirmed_at"),
	last_event_at: text("last_event_at"),
	/** AWS refused its keys while sending (emails wait meanwhile); cleared by the next send. */
	credentials_error: text("credentials_error"),
	credentials_error_at: text("credentials_error_at"),
	/** SES's sends a second for the account, as last read (the Dispatcher paces it apart). */
	max_send_rate: real("max_send_rate"),
	/** Its Cost Explorer answer (src/server/costs.ts), JSON. */
	costs: text("costs"),
	/** Receiving at its domains (src/server/inbound.ts): its own S3 drop box and rule set. */
	inbound_bucket: text("inbound_bucket"),
	inbound_rule_set: text("inbound_rule_set"),
	created_by: text("created_by"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

/**
 * An organization moving to another SES account while it has domains (org-aws-manage.ts, startMove):
 * its domains are verified in the new account first, and sending switches once all are. `to_*`
 * null: back to the deployment's account.
 */
export const orgAwsMoves = sqliteTable("org_aws_moves", {
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	to_access_key_id: text("to_access_key_id"),
	to_secret_encrypted: text("to_secret_encrypted"),
	to_region: text("to_region").notNull(),
	to_account_id: text("to_account_id").notNull(),
	to_topic_arn: text("to_topic_arn"),
	subscription_confirmed_at: text("subscription_confirmed_at"),
	max_send_rate: real("max_send_rate"),
	error: text("error"),
	started_by: text("started_by"),
	started_at: text("started_at").notNull(),
});

/** A brand's place in SES: its tenant and configuration set (and its marketing ones). */
export const orgSending = sqliteTable("org_sending", {
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** SES tenant and configuration set names (both "mailroom-<slug>"). */
	tenant_name: text("tenant_name"),
	tenant_arn: text("tenant_arn"),
	configuration_set: text("configuration_set"),
	/** "not_set_up" | "ready" | "error". */
	status: text("status").notNull().default("not_set_up"),
	last_error: text("last_error"),
	/** SES's own pause of the tenant (reputation), as last read. */
	tenant_status: text("tenant_status"),
	tenant_checked_at: text("tenant_checked_at"),
	/** The last level emailed about (src/server/alerts.ts): "ok" | "warning" | "danger" | "paused". */
	alert_level: text("alert_level"),
	alerted_at: text("alerted_at"),
	/** The same for its marketing domains (they have their own tenant and limits' action). */
	marketing_alert_level: text("marketing_alert_level"),
	/** When owners were last emailed that its emails take long to arrive (src/server/slow-delivery.ts). */
	slow_alerted_at: text("slow_alerted_at"),
	/**
	 * The second tenant and configuration set its Marketing domains send through
	 * ("mailroom-<slug>-mkt"), made with the first one: newsletter complaints never pause receipts.
	 */
	marketing_tenant_name: text("marketing_tenant_name"),
	marketing_tenant_arn: text("marketing_tenant_arn"),
	marketing_configuration_set: text("marketing_configuration_set"),
	marketing_tenant_status: text("marketing_tenant_status"),
	/** A pause of the whole brand: its sends are refused and its queue waits. */
	paused_at: text("paused_at"),
	/** "you" (the organization paused it) | "mailroom" (only the deployment's admins lift it). */
	paused_by: text("paused_by"),
	paused_reason: text("paused_reason"),
	updated_at: text("updated_at").notNull(),
});

/**
 * An organization's SES SMTP credentials (src/server/smtp.ts): an IAM user that can only send
 * from its domains, and its access key. The password is shown once and never kept.
 */
export const smtpCredentials = sqliteTable("smtp_credentials", {
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	iam_user: text("iam_user").notNull(),
	/** The SMTP username. */
	access_key_id: text("access_key_id").notNull(),
	/** SMTP passwords only work in the region they were made for. */
	region: text("region").notNull(),
	created_at: text("created_at").notNull(),
	created_by: text("created_by"),
});

export const domains = sqliteTable(
	"domains",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** An SES identity is account-wide: one domain belongs to one organization. */
		name: text("name").notNull().unique(),
		/** "pending" | "verified" | "failed" | "temporary_failure". */
		status: text("status").notNull().default("pending"),
		dkim_tokens: text("dkim_tokens", { mode: "json" }).$type<string[]>().notNull(),
		dkim_status: text("dkim_status"),
		mail_from: text("mail_from"),
		mail_from_status: text("mail_from_status"),
		region: text("region").notNull(),
		/** Mailroom created the SES identity, so removing the domain deletes it. An identity that
		 * was already in SES is only unlinked from the tenant. */
		ses_owned: integer("ses_owned", { mode: "boolean" }).notNull().default(false),
		/** For an identity SES already had: its brand proved the domain with the _mailroom TXT
		 * record (src/server/provision.ts), or it was verified before that check existed. */
		owner_proven: integer("owner_proven", { mode: "boolean" }).notNull().default(false),
		created_at: text("created_at").notNull(),
		checked_at: text("checked_at"),
		/** The brand logo inboxes show beside its emails (BIMI), as SVG Tiny PS; served at
		 * /bimi/<name>.svg. */
		bimi_logo: text("bimi_logo"),
		bimi_updated_at: text("bimi_updated_at"),
		/** Mailroom adds a 1×1 image to its HTML emails and records when it loads. */
		open_tracking: integer("open_tracking", { mode: "boolean" }).notNull().default(true),
		/** Mailroom sends its HTML emails' links through itself and records each click. */
		click_tracking: integer("click_tracking", { mode: "boolean" }).notNull().default(true),
		/** The domain's own host for tracked links and the open image (links.<name>), a custom
		 * hostname on Mailroom's Cloudflare zone; null: Mailroom's own address. */
		tracking_host: text("tracking_host"),
		/** "pending" (waiting for the CNAME and its certificate) | "active" | "failed". */
		tracking_status: text("tracking_status"),
		/** Cloudflare's custom hostname and Worker route ids, to remove them. */
		tracking_hostname_id: text("tracking_hostname_id"),
		tracking_route_id: text("tracking_route_id"),
		tracking_checked_at: text("tracking_checked_at"),
		/** "transactional" (receipts, bookings) | "marketing" (newsletters: its brand's second
		 * tenant, and a one-click unsubscribe on every email). */
		purpose: text("purpose").notNull().default("transactional"),
		/** Sends from a paused domain are refused. */
		paused_at: text("paused_at"),
		/** "you" | "unknown_recipients" (Mailroom: too many emails to addresses that don't exist) |
		 * "sending_limits" (Mailroom: over the brand's limits; only the deployment's admins lift it). */
		paused_reason: text("paused_reason"),
		/** When it was last resumed: Mailroom's auto-pause only counts bounces after it. */
		resumed_at: text("resumed_at"),
		/** Brands send from it (false: a domain only for receiving, without MAIL FROM, DMARC or
		 * tracking). */
		sending: integer("sending", { mode: "boolean" }).notNull().default(true),
		/** Mailroom receives the domain's email (an SES receipt rule; src/server/inbound.ts). */
		receiving: integer("receiving", { mode: "boolean" }).notNull().default(false),
		/** "pending" (the MX doesn't point at SES yet) | "active". */
		receiving_status: text("receiving_status"),
		/** Where it receives: a subdomain (reply.<domain>, the default) or the domain itself. */
		receiving_host: text("receiving_host"),
		/**
		 * While its organization moves to another SES account (orgAwsMoves): the identity's DKIM
		 * tokens there, its verification there ("pending" | "verified") and whether Mailroom made
		 * it. It keeps sending from the old account until the move completes.
		 */
		move_dkim_tokens: text("move_dkim_tokens", { mode: "json" }).$type<string[]>(),
		move_status: text("move_status"),
		move_ses_owned: integer("move_ses_owned", { mode: "boolean" }),
	},
	(t) => [index("domains_org_idx").on(t.organization_id)],
);

/**
 * An organization's brands besides its default one (whose id is the organization's own). A
 * platform (a hotel booking app, say) makes one per business it sends for (each hotel), so each has its own SES
 * tenant and reputation. The table keeps its first name from when brands were organizations.
 */
export const brands = sqliteTable(
	"managed_organizations",
	{
		/** The brand's id: its row in `organization` holds its name, slug and logo. */
		id: text("organization_id")
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The organization it belongs to. */
		parent_id: text("parent_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		/** The platform's own id for the business (a hotel's id), unique per organization. */
		external_id: text("external_id"),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		index("managed_organizations_parent_idx").on(t.parent_id),
		uniqueIndex("managed_organizations_external_uidx").on(t.parent_id, t.external_id),
	],
);

export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		/** The first characters, to tell keys apart («mr_ab12…»). */
		start: text("start").notNull(),
		/** SHA-256 (hex) of the whole key; the key itself is shown once. */
		hash: text("hash").notNull().unique(),
		/** "full" | "sending". */
		permission: text("permission").notNull().default("full"),
		/** A sending key may be held to one domain. */
		domain_id: text("domain_id"),
		created_by: text("created_by"),
		created_at: text("created_at").notNull(),
		last_used_at: text("last_used_at"),
	},
	(t) => [index("api_keys_org_idx").on(t.organization_id)],
);

export const EMAIL_STATUSES = [
	"scheduled",
	"queued",
	"sending",
	"sent",
	"delivery_delayed",
	"delivered",
	"soft_bounced",
	"bounced",
	"complained",
	"failed",
	"suppressed",
	"canceled",
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const emails = sqliteTable(
	"emails",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** SES's message id, once SES took it. */
		message_id: text("message_id"),
		from: text("from").notNull(),
		to: text("to", { mode: "json" }).$type<string[]>().notNull(),
		cc: text("cc", { mode: "json" }).$type<string[]>(),
		bcc: text("bcc", { mode: "json" }).$type<string[]>(),
		reply_to: text("reply_to", { mode: "json" }).$type<string[]>(),
		subject: text("subject").notNull(),
		tags: text("tags", { mode: "json" }).$type<{ name: string; value: string }[]>(),
		status: text("status").$type<EmailStatus>().notNull(),
		/** The latest event by its time (sent, delivered, opened…). */
		last_event: text("last_event"),
		last_event_at: text("last_event_at"),
		error: text("error"),
		/** Recipients left out (suppressed, a domain that takes no email), with why. */
		dropped: text("dropped", { mode: "json" }).$type<Record<string, string>>(),
		/** "api" | "smtp" | "dashboard" | "system". */
		source: text("source").notNull().default("api"),
		api_key_id: text("api_key_id"),
		idempotency_key: text("idempotency_key"),
		/** SHA-256 of the request, to refuse the same key with another body. */
		request_hash: text("request_hash"),
		send_at: text("send_at"),
		attempts: integer("attempts").notNull().default(0),
		/** A claim of the dispatcher on a queued email, so two runs never send it twice. */
		locked_until: text("locked_until"),
		created_at: text("created_at").notNull(),
		sent_at: text("sent_at"),
		delivered_at: text("delivered_at"),
		opened_at: text("opened_at"),
		clicked_at: text("clicked_at"),
		bounced_at: text("bounced_at"),
		bounce_type: text("bounce_type"),
		complained_at: text("complained_at"),
		open_count: integer("open_count").notNull().default(0),
		click_count: integer("click_count").notNull().default(0),
		/**
		 * The app's unsubscribe group (one of its customers, a list…): the email carries a
		 * one-click unsubscribe link, and whoever left the group isn't sent to (unsubscribes).
		 */
		unsubscribe_group: text("unsubscribe_group"),
		/** The template it was made from (src/server/templates.ts). */
		template_id: text("template_id"),
		/** The broadcast it's part of: its content is the broadcast's, filled in at send time. */
		broadcast_id: text("broadcast_id"),
		/** In a broadcast's A/B test: which version it got (0 is A). */
		variant: integer("variant"),
	},
	(t) => [
		index("emails_org_created_idx").on(t.organization_id, t.created_at),
		uniqueIndex("emails_message_uidx").on(t.message_id),
		uniqueIndex("emails_idempotency_uidx").on(t.organization_id, t.idempotency_key),
		// The dispatcher's queue: only waiting emails are in this index.
		index("emails_queue_idx").on(t.send_at).where(sql`status IN ('queued', 'scheduled')`),
		index("emails_broadcast_idx").on(t.broadcast_id).where(sql`broadcast_id IS NOT NULL`),
	],
);

export type ReceivedAttachment = {
	id: string;
	filename: string | null;
	content_type: string;
	content_disposition: string | null;
	content_id: string | null;
	size: number;
};

/**
 * Emails a brand received (src/server/inbound.ts): SES took them at one of its domains (or its
 * Mailroom address), and the whole message is in R2 (`object_key`), kept INBOUND_RETENTION_DAYS.
 */
export const receivedEmails = sqliteTable(
	"received_emails",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** The brand's domain it came to; null: the brand's Mailroom address. */
		domain_id: text("domain_id"),
		/** SES's id of the message (one message to two brands is a row for each). */
		ses_message_id: text("ses_message_id").notNull(),
		/** Its Message-ID header, and the one it answers (In-Reply-To). */
		message_id: text("message_id"),
		in_reply_to: text("in_reply_to"),
		from: text("from").notNull(),
		to: text("to", { mode: "json" }).$type<string[]>().notNull(),
		cc: text("cc", { mode: "json" }).$type<string[]>(),
		reply_to: text("reply_to", { mode: "json" }).$type<string[]>(),
		subject: text("subject").notNull(),
		/** The brand's addresses SES received it for (the envelope; Bcc shows only here). */
		recipients: text("recipients", { mode: "json" }).$type<string[]>().notNull(),
		size: integer("size").notNull().default(0),
		attachments: text("attachments", { mode: "json" }).$type<ReceivedAttachment[]>(),
		/** SES's verdicts: "PASS" | "FAIL" | "GRAY" | "PROCESSING_FAILED" | "DISABLED". */
		spam: text("spam"),
		virus: text("virus"),
		spf: text("spf"),
		dkim: text("dkim"),
		dmarc: text("dmarc"),
		object_key: text("object_key").notNull(),
		/** The email of ours it answers (its In-Reply-To or References is our Message-ID). */
		answers_email_id: text("answers_email_id"),
		/** What the brand's inbound rules did with it ("Forwarded to …"). */
		actions: text("actions", { mode: "json" }).$type<string[]>(),
		/** The agent inbox it came to (src/server/inboxes.ts); null: the brand's other addresses. A
		 * message to two inboxes is a row for each, so neither inbox sees the other's copy. */
		inbox_id: text("inbox_id"),
		/** Its conversation (src/server/conversations.ts), threaded by Message-ID headers. */
		conversation_id: text("conversation_id"),
		/** Its References header's ids, for threading (space separated, without <>). */
		references: text("references"),
		/** Why it looks suspicious (src/server/inbox-workflow.ts): reasons, worst first; null: none. */
		flags: text("flags", { mode: "json" }).$type<MessageFlags>(),
		/** Held from agents until a person releases it (the inbox holds suspicious mail). */
		held: integer("held", { mode: "boolean" }).notNull().default(false),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		index("received_emails_answers_idx")
			.on(t.answers_email_id)
			.where(sql`answers_email_id IS NOT NULL`),
		index("received_emails_org_created_idx").on(t.organization_id, t.created_at),
		uniqueIndex("received_emails_message_inbox_uidx").on(
			t.organization_id,
			t.ses_message_id,
			sql`coalesce(${t.inbox_id}, '')`,
		),
		index("received_emails_created_idx").on(t.created_at),
		index("received_emails_conversation_idx").on(t.conversation_id, t.created_at),
		index("received_emails_inbox_created_idx").on(t.inbox_id, t.created_at),
	],
);

/**
 * Agent inboxes (src/server/inboxes.ts): one address of a brand's that an app or an AI agent
 * reads and answers with its own credentials, through the brand's receiving (no AWS of its own).
 */
export const inboxes = sqliteTable(
	"inboxes",
	{
		id: text("id").primaryKey(),
		/** The brand's id. */
		organization_id: orgId(),
		name: text("name").notNull(),
		/** Lowercase: local@<a receiving host of the brand's>, or <slug>+local@INBOUND_DOMAIN. */
		address: text("address").notNull(),
		/** The domain it's on; null: the brand's Mailroom address. */
		domain_id: text("domain_id"),
		/** What replies are sent from (an address on one of the brand's sending domains); null:
		 * the inbox's own address. Replies always carry Reply-To: the inbox. */
		reply_from: text("reply_from"),
		/** Who its replies and emails may go to (addresses or whole domains, AgentMail-style):
		 * with an entry in `send_allow`, nobody else; nobody in `send_block`. Checked on every
		 * send, a person approving an agent's draft included. */
		send_allow: text("send_allow", { mode: "json" }).$type<string[]>(),
		send_block: text("send_block", { mode: "json" }).$type<string[]>(),
		description: text("description"),
		/** How long its conversations are kept after their last message: days; 0: always;
		 * null: the deployment's INBOUND_RETENTION_DAYS. */
		retention_days: integer("retention_days"),
		/** How it works (InboxSettings in src/server/inbox-workflow.ts): assignment, SLA, CSAT,
		 * signature, tags, holding suspicious mail, undo send. */
		settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>(),
		created_by: text("created_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("inboxes_address_uidx").on(t.address),
		index("inboxes_org_idx").on(t.organization_id),
	],
);

/** What an inbox credential may do: read is always on; the rest are granted one by one. */
export type InboxPermission = "read" | "attachments" | "triage" | "notes" | "draft" | "send";

/** Why a received message looks suspicious, for people and for holding it from agents. */
export interface MessageFlags {
	/** 0–100: past 50 it's held (when the inbox holds suspicious mail). */
	score: number;
	reasons: { code: string; text: string }[];
}

/**
 * An inbox's credentials (mri_…): shown once, kept as a SHA-256, held to the one inbox. Revoked
 * ones stay for the audit log; rotating gives a new secret to the same credential.
 */
export const inboxCredentials = sqliteTable(
	"inbox_credentials",
	{
		id: text("id").primaryKey(),
		inbox_id: text("inbox_id")
			.notNull()
			.references(() => inboxes.id, { onDelete: "cascade" }),
		/** The brand's id. */
		organization_id: orgId(),
		name: text("name").notNull(),
		/** The first characters, to recognize it. */
		start: text("start").notNull(),
		hash: text("hash").notNull(),
		permissions: text("permissions", { mode: "json" }).$type<InboxPermission[]>().notNull(),
		/** With `send`: "replies" (only people already in the conversation) | "anyone". */
		send_scope: text("send_scope").notNull().default("replies"),
		/** Which inboxes it reaches: "inbox" (only inbox_id, where it was made), "inboxes"
		 * (inbox_ids, all of the same brand) or "brand" (every inbox of the brand, new ones too). */
		scope: text("scope").notNull().default("inbox"),
		inbox_ids: text("inbox_ids", { mode: "json" }).$type<string[]>(),
		created_by: text("created_by"),
		created_at: text("created_at").notNull(),
		last_used_at: text("last_used_at"),
		rotated_at: text("rotated_at"),
		revoked_at: text("revoked_at"),
	},
	(t) => [
		uniqueIndex("inbox_credentials_hash_uidx").on(t.hash),
		index("inbox_credentials_inbox_idx").on(t.inbox_id),
	],
);

/**
 * A conversation: received emails and the replies to them, threaded by Message-ID, In-Reply-To
 * and References (never by subject alone), within one brand and one inbox.
 */
export const conversations = sqliteTable(
	"conversations",
	{
		id: text("id").primaryKey(),
		/** The brand's id. */
		organization_id: orgId(),
		/** Its inbox; null: the brand's other addresses. */
		inbox_id: text("inbox_id"),
		subject: text("subject").notNull(),
		/** Who wrote in (the first message's From). */
		contact: text("contact").notNull(),
		/** "open" | "resolved". */
		status: text("status").notNull().default("open"),
		messages: integer("messages").notNull().default(0),
		/** The last message's first words. */
		snippet: text("snippet"),
		last_message_at: text("last_message_at").notNull(),
		last_inbound_at: text("last_inbound_at"),
		last_reply_at: text("last_reply_at"),
		/** Who sent the last reply: "agent" | "person" | "api". */
		replied_by: text("replied_by"),
		resolved_at: text("resolved_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
		/** How it came in: "email" | "chat" (a website's chat widget, src/server/chat.ts). */
		channel: text("channel").notNull().default("email"),
		/** Chat only: what the visitor told us (unverified), and the page they wrote from. */
		visitor_name: text("visitor_name"),
		visitor_email: text("visitor_email"),
		page_url: text("page_url"),
		/** Chat only: the random tag of the addresses its emails are answered at
		 * (<inbox>+chat-<key>@…: the team; +chatv-<key>: the visitor). */
		chat_key: text("chat_key"),
		/** Chat only: when the visitor last had the chat in front of them, and last wrote. */
		visitor_seen_at: text("visitor_seen_at"),
		/** Who has it (src/server/inbox-workflow.ts): "user:<id>" | "cred:<id>"; null: nobody. */
		assignee: text("assignee"),
		assignee_name: text("assignee_name"),
		/** A claim's end (an agent working on it); past it, nobody has it. null: assigned for good. */
		claimed_until: text("claimed_until"),
		tags: text("tags", { mode: "json" }).$type<string[]>(),
		/** "urgent" | "high" | "normal" | "low". */
		priority: text("priority").notNull().default("normal"),
		/** Out of Open until then (a new message brings it back sooner). */
		snoozed_until: text("snoozed_until"),
		/** The first reply sent, for response times. */
		first_reply_at: text("first_reply_at"),
		/** The inbox's SLA: when the first reply and the resolution are due. */
		sla_first_due_at: text("sla_first_due_at"),
		sla_resolve_due_at: text("sla_resolve_due_at"),
		/** What it missed: "first", "resolve" (comma separated); and when it was warned. */
		sla_breached: text("sla_breached"),
		sla_warned_at: text("sla_warned_at"),
		/** Satisfaction: the survey sent on resolving, the answer (1–5) and its comment. */
		csat_sent_at: text("csat_sent_at"),
		csat_rating: integer("csat_rating"),
		csat_comment: text("csat_comment"),
		csat_at: text("csat_at"),
		/** A held message is in it: agents don't see it until a person releases it. */
		held_at: text("held_at"),
	},
	(t) => [
		index("conversations_org_last_idx").on(t.organization_id, t.last_message_at),
		index("conversations_assignee_idx").on(t.assignee, t.status),
		index("conversations_snoozed_idx").on(t.snoozed_until),
		index("conversations_sla_idx").on(t.sla_first_due_at),
		index("conversations_inbox_last_idx").on(t.inbox_id, t.last_message_at),
		index("conversations_last_idx").on(t.last_message_at),
		uniqueIndex("conversations_chat_key_uidx").on(t.chat_key),
	],
);

/**
 * An inbox's website chat (src/server/chat.ts): a widget on the brand's sites that opens a
 * conversation in the inbox. Visitors see a chat; the team answers in the dashboard or by
 * replying to the notification email.
 */
export const chatWidgets = sqliteTable(
	"chat_widgets",
	{
		inbox_id: text("inbox_id")
			.primaryKey()
			.references(() => inboxes.id, { onDelete: "cascade" }),
		/** The brand's id. */
		organization_id: orgId(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		/** Public (it's on the website): mrc_…; rotating it stops the old one at once. */
		public_key: text("public_key").notNull(),
		/** The websites it may run on: hostnames, each with its subdomains. */
		origins: text("origins", { mode: "json" }).$type<string[]>().notNull(),
		/** How it looks and what it says (ChatDesign in src/server/chat.ts). */
		design: text("design", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
		/** "off" | "optional" | "required": asking the visitor for their email. */
		ask_email: text("ask_email").notNull().default("optional"),
		/** Who is emailed about new messages (and may answer by replying). */
		notify: text("notify", { mode: "json" }).$type<string[]>().notNull(),
		/** New chats a day, at most (past it the widget offers the inbox's address). */
		daily_limit: integer("daily_limit").notNull().default(100),
		created_by: text("created_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [uniqueIndex("chat_widgets_key_uidx").on(t.public_key)],
);

export interface ChatAttachment {
	id: string;
	filename: string;
	content_type: string;
	size: number;
	/** In the INBOUND bucket: chat/<brand>/<conversation>/<id>. */
	key: string;
	width?: number | null;
	height?: number | null;
}

/** One line of a chat: the visitor's, the team's (a person or an agent), or Mailroom's own. */
export const chatMessages = sqliteTable(
	"chat_messages",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		inbox_id: text("inbox_id"),
		/** "visitor" | "person" | "agent" | "api" | "system". */
		author: text("author").notNull(),
		author_id: text("author_id"),
		author_name: text("author_name"),
		text: text("text").notNull(),
		attachments: text("attachments", { mode: "json" }).$type<ChatAttachment[]>(),
		/** Where it was written: "widget" | "dashboard" | "email" | "api". */
		via: text("via").notNull(),
		/** The sender's own id for it (a retried send, an email delivered twice): once each. */
		client_id: text("client_id"),
		/** Who approved it, when it was someone else's draft. */
		sent_by: text("sent_by"),
		/** A visitor's line: when the team was emailed about it. A team's line: when the
		 * visitor was emailed it (they had left). */
		notified_at: text("notified_at"),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		index("chat_messages_conversation_idx").on(t.conversation_id, t.created_at),
		uniqueIndex("chat_messages_client_uidx").on(t.conversation_id, t.client_id),
		index("chat_messages_pending_idx").on(t.notified_at, t.author, t.created_at),
	],
);

/** A chat's visitor token (mrv_…, in the website's storage): its SHA-256, and where from. */
export const chatVisitors = sqliteTable(
	"chat_visitors",
	{
		token_hash: text("token_hash").primaryKey(),
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		inbox_id: text("inbox_id").notNull(),
		/** A keyed hash of the IP, for the per-address limit (never the address). */
		ip_hash: text("ip_hash"),
		created_at: text("created_at").notNull(),
		last_seen_at: text("last_seen_at"),
	},
	(t) => [
		index("chat_visitors_conversation_idx").on(t.conversation_id),
		index("chat_visitors_ip_idx").on(t.ip_hash, t.created_at),
	],
);

/**
 * The Message-IDs a conversation is known by: its messages', the ones they reference (so a
 * message that arrives after its answer still joins), and "email:<id>" for our replies.
 */
export const conversationRefs = sqliteTable(
	"conversation_refs",
	{
		organization_id: text("organization_id").notNull(),
		/** The inbox's id, or "" for the brand's other addresses. */
		scope: text("scope").notNull(),
		ref: text("ref").notNull(),
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
	},
	(t) => [
		primaryKey({ columns: [t.organization_id, t.scope, t.ref] }),
		index("conversation_refs_conversation_idx").on(t.conversation_id),
	],
);

/**
 * Read state, per reader: a person ("user:<id>") or an agent credential ("cred:<id>"). A
 * conversation is unread for them when something arrived after `read_at` (or they never read it);
 * one reader's marks never change another's. Open or resolved is the conversation's, shared.
 */
export const conversationReads = sqliteTable(
	"conversation_reads",
	{
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		reader: text("reader").notNull(),
		read_at: text("read_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.conversation_id, t.reader] }),
		index("conversation_reads_reader_idx").on(t.reader),
	],
);

/** One received message read by one reader (marking a whole conversation read is its
 * conversation_reads row instead: everything up to its read_at). */
export const messageReads = sqliteTable(
	"message_reads",
	{
		message_id: text("message_id")
			.notNull()
			.references(() => receivedEmails.id, { onDelete: "cascade" }),
		reader: text("reader").notNull(),
		read_at: text("read_at").notNull(),
	},
	(t) => [primaryKey({ columns: [t.message_id, t.reader] })],
);

export interface ReplyAttachment {
	id: string;
	filename: string;
	content_type: string | null;
	size: number;
	/** Uploaded: where its bytes are, until it's sent. */
	key?: string | null;
	/** Or a received message's attachment, forwarded. */
	message_id?: string | null;
	attachment_id?: string | null;
}

/** A reply in a conversation: a draft (an agent's waits for a person when it can't send),
 * then sent (an email in `emails`), or discarded. */
export const conversationReplies = sqliteTable(
	"conversation_replies",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		inbox_id: text("inbox_id"),
		/** The received email it answers. */
		in_reply_to: text("in_reply_to"),
		/** "draft" | "sending" (one send has it; a draft again if that send fails) | "sent". */
		status: text("status").notNull().default("draft"),
		from: text("from"),
		to: text("to", { mode: "json" }).$type<string[]>().notNull(),
		cc: text("cc", { mode: "json" }).$type<string[]>(),
		subject: text("subject").notNull(),
		text: text("text").notNull(),
		html: text("html"),
		/** Its files: uploaded (kept in R2 under `key` while it's a draft) or a received
		 * message's attachment (message_id + attachment_id), read when it's sent. */
		attachments: text("attachments", { mode: "json" }).$type<ReplyAttachment[]>(),
		/** Who wrote it: "agent" | "person" | "api", with their id and name. */
		author_type: text("author_type").notNull(),
		author_id: text("author_id"),
		author_name: text("author_name").notNull(),
		/** Who sent it, when someone else did (a person approving an agent's draft). */
		sent_by: text("sent_by"),
		/** An agent's draft a person sent: "unchanged" or "edited" (how far agents are trusted). */
		review: text("review"),
		email_id: text("email_id"),
		sent_at: text("sent_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("conversation_replies_conversation_idx").on(t.conversation_id, t.created_at)],
);

/** An internal note on a conversation: never sent; people and agents leave them for each other. */
export const conversationNotes = sqliteTable(
	"conversation_notes",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		conversation_id: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		inbox_id: text("inbox_id"),
		/** "agent" | "person" | "api". */
		author_type: text("author_type").notNull(),
		author_id: text("author_id"),
		author_name: text("author_name").notNull(),
		text: text("text").notNull(),
		/** Members it @mentions (each was emailed). */
		mentions: text("mentions", { mode: "json" }).$type<{ id: string; name: string }[]>(),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("conversation_notes_conversation_idx").on(t.conversation_id, t.created_at)],
);

/** A reusable answer (a macro): text with variables, and what using it also does. */
export const savedReplies = sqliteTable(
	"saved_replies",
	{
		id: text("id").primaryKey(),
		/** The brand's id. */
		organization_id: orgId(),
		/** Only this inbox's; null: every inbox of the brand. */
		inbox_id: text("inbox_id").references(() => inboxes.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		/** Typed after / in the reply box. */
		shortcut: text("shortcut"),
		text: text("text").notNull(),
		/** Also: tags added, the status after sending ("resolved"), snoozed this many days. */
		add_tags: text("add_tags", { mode: "json" }).$type<string[]>(),
		set_status: text("set_status"),
		snooze_days: integer("snooze_days"),
		uses: integer("uses").notNull().default(0),
		created_by: text("created_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("saved_replies_org_idx").on(t.organization_id)],
);

/** A rule of an inbox's, run on each message that comes in (after threading), in order. */
export const inboxRules = sqliteTable(
	"inbox_rules",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		inbox_id: text("inbox_id")
			.notNull()
			.references(() => inboxes.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		position: integer("position").notNull().default(0),
		/** "all" | "any" of the conditions. */
		match: text("match").notNull().default("all"),
		conditions: text("conditions", { mode: "json" })
			.$type<{ field: string; op: string; value: string }[]>()
			.notNull(),
		actions: text("actions", { mode: "json" })
			.$type<{ type: string; value?: string | number | null }[]>()
			.notNull(),
		/** Rules after it don't run when it matched. */
		stop: integer("stop", { mode: "boolean" }).notNull().default(false),
		matched: integer("matched").notNull().default(0),
		last_matched_at: text("last_matched_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("inbox_rules_inbox_idx").on(t.inbox_id, t.position)],
);

/** An Idempotency-Key a caller sent: the same key again gets the first answer, not a second send. */
export const idempotencyKeys = sqliteTable(
	"idempotency_keys",
	{
		/** Who sent it: "cred:<id>", "key:<id>", "user:<id>". */
		actor: text("actor").notNull(),
		key: text("key").notNull(),
		/** The method and path, and a hash of the body: the same key for another request is refused. */
		request: text("request").notNull(),
		status: integer("status"),
		response: text("response"),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.actor, t.key] }),
		index("idempotency_keys_created_idx").on(t.created_at),
	],
);

/** What happened in an inbox, by whom: an agent reading, drafting, sending; people managing it. */
export const inboxActivity = sqliteTable(
	"inbox_activity",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		inbox_id: text("inbox_id"),
		conversation_id: text("conversation_id"),
		/** "agent" | "person" | "api" | "system". */
		actor_type: text("actor_type").notNull(),
		actor_id: text("actor_id"),
		actor_name: text("actor_name").notNull(),
		/** conversation.read, draft.saved, reply.sent, credential.created… */
		action: text("action").notNull(),
		detail: text("detail", { mode: "json" }).$type<ActivityDetail>(),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		index("inbox_activity_inbox_idx").on(t.inbox_id, t.created_at),
		index("inbox_activity_conversation_idx").on(t.conversation_id, t.created_at),
		index("inbox_activity_created_idx").on(t.created_at),
	],
);

/**
 * What an email said, gzip-compressed, kept BODY_RETENTION_DAYS. A queued or scheduled email
 * keeps here everything needed to send it later.
 */
export const emailBodies = sqliteTable("email_bodies", {
	email_id: text("email_id")
		.primaryKey()
		.references(() => emails.id, { onDelete: "cascade" }),
	/** gzip of JSON { html, text, headers, attachments? }. */
	content: blob("content", { mode: "buffer" }).notNull(),
	/** Attachments by name and size, for the dashboard; an inline image also by its cid and the
	 * `inline_images` hash its bytes are kept under. */
	attachments: text("attachments", { mode: "json" }).$type<AttachmentInfo[]>(),
	created_at: text("created_at").notNull(),
});

export type AttachmentInfo = {
	filename: string;
	size: number;
	content_id?: string;
	image?: string;
};

/**
 * Inline images (the cid: logo in an HTML body), kept once per organization and content so the
 * dashboard's preview can show them after the attachment bytes are dropped. Used again, an image
 * is only touched; one no email has used in BODY_RETENTION_DAYS goes with the bodies.
 */
export const inlineImages = sqliteTable(
	"inline_images",
	{
		organization_id: orgId(),
		/** SHA-256 of the bytes, hex. */
		hash: text("hash").notNull(),
		content_type: text("content_type").notNull(),
		bytes: blob("bytes", { mode: "buffer" }).notNull(),
		last_used_at: text("last_used_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organization_id, t.hash] }),
		index("inline_images_last_used").on(t.last_used_at),
	],
);

export const emailEvents = sqliteTable(
	"email_events",
	{
		/** SNS's message id: an event delivered twice is kept once. */
		id: text("id").primaryKey(),
		email_id: text("email_id").notNull(),
		organization_id: text("organization_id").notNull(),
		/** Mailroom's name: email.sent, email.delivered… */
		type: text("type").notNull(),
		at: text("at").notNull(),
		recipient: text("recipient"),
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
	},
	(t) => [index("email_events_email_idx").on(t.email_id, t.at)],
);

export const suppressions = sqliteTable(
	"suppressions",
	{
		organization_id: orgId(),
		address: text("address").notNull(),
		/** "bounce" | "complaint" | "manual". */
		reason: text("reason").notNull(),
		detail: text("detail"),
		email_id: text("email_id"),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organization_id, t.address] }),
		index("suppressions_org_created_idx").on(t.organization_id, t.created_at),
	],
);

/**
 * Who left an unsubscribe group, from an email's one-click link (src/server/unsubscribes.ts):
 * the organization's emails in that group skip them; its other emails still reach them.
 */
export const unsubscribes = sqliteTable(
	"unsubscribes",
	{
		organization_id: orgId(),
		group: text("group").notNull(),
		address: text("address").notNull(),
		/** The email whose link they used. */
		email_id: text("email_id"),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organization_id, t.group, t.address] }),
		index("unsubscribes_org_created_idx").on(t.organization_id, t.created_at),
	],
);

export const webhooks = sqliteTable(
	"webhooks",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		url: text("url").notNull(),
		/** whsec_… (Standard Webhooks). */
		secret: text("secret").notNull(),
		events: text("events", { mode: "json" }).$type<string[]>().notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		created_at: text("created_at").notNull(),
		/** Failed deliveries in a row; at DOWN_AFTER the endpoint is down. */
		failures: integer("failures").notNull().default(0),
		/** Down: new events wait (pending) and one is tried at a time until it answers again. */
		down_since: text("down_since"),
		/** Only this agent inbox's events (inbox.*); null: the whole organization's. */
		inbox_id: text("inbox_id").references(() => inboxes.id, { onDelete: "cascade" }),
	},
	(t) => [index("webhooks_org_idx").on(t.organization_id)],
);

export const webhookDeliveries = sqliteTable(
	"webhook_deliveries",
	{
		id: text("id").primaryKey(),
		webhook_id: text("webhook_id")
			.notNull()
			.references(() => webhooks.id, { onDelete: "cascade" }),
		organization_id: text("organization_id").notNull(),
		email_id: text("email_id"),
		event_type: text("event_type").notNull(),
		payload: text("payload").notNull(),
		/** "pending" | "delivered" | "failed" (gave up). */
		status: text("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		next_attempt_at: text("next_attempt_at"),
		response_status: integer("response_status"),
		response_body: text("response_body"),
		created_at: text("created_at").notNull(),
		delivered_at: text("delivered_at"),
	},
	(t) => [
		index("webhook_deliveries_hook_idx").on(t.webhook_id, t.created_at),
		index("webhook_deliveries_due_idx").on(t.next_attempt_at).where(sql`status = 'pending'`),
	],
);

/**
 * Every authenticated call to the public API (src/server/request-logs.ts), for the Logs page;
 * kept REQUEST_LOG_RETENTION_DAYS.
 */
export const apiRequests = sqliteTable(
	"api_requests",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		api_key_id: text("api_key_id"),
		method: text("method").notNull(),
		/** Without /api: /emails, /domains/{id}… */
		path: text("path").notNull(),
		query: text("query"),
		status: integer("status").notNull(),
		user_agent: text("user_agent"),
		/** Pretty-printed and trimmed, attachments' content left out. */
		request_body: text("request_body"),
		response_body: text("response_body"),
		/** The email it sent (the first, for a batch). */
		email_id: text("email_id"),
		duration_ms: integer("duration_ms"),
		created_at: text("created_at").notNull(),
	},
	(t) => [index("api_requests_org_created_idx").on(t.organization_id, t.created_at)],
);

/** Counters per organization and day (in TIMEZONE), from SES's events. */
export const dailyStats = sqliteTable(
	"daily_stats",
	{
		organization_id: text("organization_id").notNull(),
		day: text("day").notNull(),
		sent: integer("sent").notNull().default(0),
		delivered: integer("delivered").notNull().default(0),
		/** Permanent bounces: the ones SES's bounce rate counts. */
		bounced: integer("bounced").notNull().default(0),
		soft_bounced: integer("soft_bounced").notNull().default(0),
		complained: integer("complained").notNull().default(0),
		opened: integer("opened").notNull().default(0),
		clicked: integer("clicked").notNull().default(0),
		failed: integer("failed").notNull().default(0),
		delayed: integer("delayed").notNull().default(0),
		/** Never sent: every recipient was on the suppression list, unsubscribed or blocked. */
		suppressed: integer("suppressed").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.organization_id, t.day] })],
);

/** The same counters per brand, day and sending domain (the From address's domain). */
export const domainStats = sqliteTable(
	"domain_stats",
	{
		organization_id: text("organization_id").notNull(),
		day: text("day").notNull(),
		domain: text("domain").notNull(),
		sent: integer("sent").notNull().default(0),
		delivered: integer("delivered").notNull().default(0),
		bounced: integer("bounced").notNull().default(0),
		soft_bounced: integer("soft_bounced").notNull().default(0),
		complained: integer("complained").notNull().default(0),
		opened: integer("opened").notNull().default(0),
		clicked: integer("clicked").notNull().default(0),
		failed: integer("failed").notNull().default(0),
		delayed: integer("delayed").notNull().default(0),
		suppressed: integer("suppressed").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.organization_id, t.day, t.domain] })],
);

/** Counters per brand, day and mailbox provider (Gmail, Outlook…), from SES's events. */
export const providerStats = sqliteTable(
	"provider_stats",
	{
		organization_id: text("organization_id").notNull(),
		day: text("day").notNull(),
		/** "gmail" | "outlook" | "yahoo" | "icloud" | "other" (src/lib/providers.ts). */
		provider: text("provider").notNull(),
		sent: integer("sent").notNull().default(0),
		delivered: integer("delivered").notNull().default(0),
		bounced: integer("bounced").notNull().default(0),
		complained: integer("complained").notNull().default(0),
		opened: integer("opened").notNull().default(0),
	},
	(t) => [primaryKey({ columns: [t.organization_id, t.day, t.provider] })],
);

/**
 * Who looked up a recipient or let one receive again (src/server/access-log.ts), in the
 * dashboard, through the API or an assistant (MCP).
 */
export const accessLog = sqliteTable(
	"access_log",
	{
		id: text("id").primaryKey(),
		/** The organization (not the brand). */
		organization_id: orgId(),
		/** "recipient_lookup" | "suppression_removed" | "unsubscribe_removed". */
		action: text("action").notNull(),
		/** The address. */
		subject: text("subject").notNull(),
		/** "dashboard" | "api" | "assistant". */
		channel: text("channel").notNull(),
		user_id: text("user_id"),
		/** Who, as shown: a person's email, or the API key's name. */
		actor: text("actor"),
		created_at: text("created_at").notNull(),
	},
	(t) => [index("access_log_org_created_idx").on(t.organization_id, t.created_at)],
);

/**
 * A brand's email firewall (src/server/firewall.ts; `organization_id` is the brand's id, like
 * suppressions): checks every recipient before the brand's email is recorded. Everything is off until turned on.
 */
export const firewall = sqliteTable("firewall", {
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	block_disposable: integer("block_disposable", { mode: "boolean" }).notNull().default(false),
	block_free: integer("block_free", { mode: "boolean" }).notNull().default(false),
	block_plus: integer("block_plus", { mode: "boolean" }).notNull().default(false),
	/** Domains (and their subdomains), TLDs or addresses never sent to. */
	never: text("never", { mode: "json" }).$type<string[]>().notNull().default([]),
	/** Domains or addresses every check lets through. */
	always: text("always", { mode: "json" }).$type<string[]>().notNull().default([]),
	updated_at: text("updated_at").notNull(),
});

/** Throwaway email domains, refreshed daily from the disposable-email-domains list. */
export const disposableDomains = sqliteTable("disposable_domains", {
	domain: text("domain").primaryKey(),
});

/** What DNS said of a recipient's domain (cache of the free address checks). */
export const mailDomains = sqliteTable("mail_domains", {
	domain: text("domain").primaryKey(),
	/** "ok" | "nxdomain" | "no_mail". */
	state: text("state").notNull(),
	checked_at: text("checked_at").notNull(),
});

/**
 * Recipients whose mailbox is known (src/server/mailbox-checks.ts), across all organizations:
 * "delivered" once SES delivered to them, else what Emailable said of a first-time address
 * ("deliverable" | "undeliverable" | "risky" | "unknown"), so each address is paid for once.
 */
export const mailboxChecks = sqliteTable(
	"mailbox_checks",
	{
		address: text("address").primaryKey(),
		state: text("state").notNull(),
		/** Emailable's reason (rejected_email, invalid_domain…); null for "delivered". */
		reason: text("reason"),
		checked_at: text("checked_at").notNull(),
	},
	(t) => [index("mailbox_checks_checked_idx").on(t.checked_at)],
);

/**
 * DMARC aggregate reports (src/server/dmarc-reports.ts): mailbox providers email them daily to
 * the address in a domain's rua=, one per provider and day. Kept by the policy domain's name,
 * not a brand, so a domain moved between brands keeps its history.
 */
export const dmarcReports = sqliteTable(
	"dmarc_reports",
	{
		id: text("id").primaryKey(),
		/** Who sent it: "google.com", "Yahoo", "Enterprise Outlook". */
		reporter: text("reporter").notNull(),
		report_id: text("report_id").notNull(),
		/** The policy's domain (policy_published). */
		domain: text("domain").notNull(),
		/** The published policy the provider saw: none, quarantine or reject. */
		policy: text("policy"),
		begin_at: text("begin_at").notNull(),
		end_at: text("end_at").notNull(),
		received_at: text("received_at").notNull(),
	},
	(t) => [
		uniqueIndex("dmarc_reports_reporter_id_uidx").on(t.reporter, t.report_id),
		index("dmarc_reports_domain_idx").on(t.domain, t.begin_at),
	],
);

/** One row of a report: mail from one IP with one result, `count` messages of it. */
export const dmarcRows = sqliteTable(
	"dmarc_rows",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		report_id: text("report_id")
			.notNull()
			.references(() => dmarcReports.id, { onDelete: "cascade" }),
		/** The From domain (header_from), what the domain page reads by. */
		header_from: text("header_from").notNull(),
		begin_at: text("begin_at").notNull(),
		source_ip: text("source_ip").notNull(),
		count: integer("count").notNull(),
		/** What the provider did: none, quarantine or reject. */
		disposition: text("disposition"),
		/** DMARC's own verdicts: pass when aligned. */
		dkim: text("dkim"),
		spf: text("spf"),
		/** The domains that signed (DKIM) and that the envelope came from (SPF). */
		dkim_domain: text("dkim_domain"),
		spf_domain: text("spf_domain"),
	},
	(t) => [
		index("dmarc_rows_from_idx").on(t.header_from, t.begin_at),
		index("dmarc_rows_report_idx").on(t.report_id),
	],
);

/**
 * An organization's own logo, shown in the switcher and wherever the organization is named. The
 * dashboard makes it a 256 px square image before uploading; served at /logos/<organization id>.
 * Without one, the organization shows a brand logo (BIMI) one of its domains has, else its initial.
 */
export const orgLogos = sqliteTable("org_logos", {
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	/** image/png, image/webp or image/jpeg; null: no upload (only a background chosen). */
	content_type: text("content_type"),
	/** The image, base64. */
	data: text("data"),
	/** What's behind the logo, for transparent ones: "white", "black" or "#rrggbb"; null: nothing. */
	background: text("background"),
	updated_at: text("updated_at").notNull(),
});

export type TemplateVariable = {
	key: string;
	type: "string" | "number";
	/** Used when a send leaves the variable out; without one, the send is refused. */
	fallback_value?: string | number | null;
};

/** What a template sends: the draft being edited, and the copy sends use once it's published. */
export type TemplateContent = {
	from: string | null;
	subject: string | null;
	reply_to: string[] | null;
	html: string;
	text: string | null;
	variables: TemplateVariable[];
	/** Built in the visual editor: its blocks (html is made from them). */
	design?: EmailDoc | null;
};

/**
 * An organization's email templates (Resend's Templates): HTML with {{{VARIABLES}}}, sent with
 * `template: { id, variables }`. Edits go to the draft; sends use what was last published.
 */
export const templates = sqliteTable(
	"templates",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		/** A name of the app's to send it by instead of its id (welcome-email). */
		alias: text("alias"),
		draft: text("draft", { mode: "json" }).$type<TemplateContent>().notNull(),
		published: text("published", { mode: "json" }).$type<TemplateContent>(),
		published_at: text("published_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		index("templates_org_idx").on(t.organization_id, t.updated_at),
		uniqueIndex("templates_alias_uidx").on(t.organization_id, t.alias),
	],
);

/**
 * A brand's contacts (Resend's Contacts): the people its broadcasts and automations go to. One
 * row per brand and address. `unsubscribed` leaves every broadcast; topics are finer.
 */
export const contacts = sqliteTable(
	"contacts",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** Lowercase. */
		email: text("email").notNull(),
		first_name: text("first_name"),
		last_name: text("last_name"),
		unsubscribed: integer("unsubscribed", { mode: "boolean" }).notNull().default(false),
		/** Values of the brand's contact properties, by key. */
		properties: text("properties", { mode: "json" }).$type<Record<string, string | number>>(),
		/** Their time zone (IANA), learned from where they click; for sends at their local time. */
		timezone: text("timezone"),
		/**
		 * Where they came from (src/server/growth.ts): "form:<id>", "referral", "import", "api",
		 * "dashboard", "automation"; null for contacts from before it was kept.
		 */
		source: text("source"),
		/** The utm_source, or the website, a sign-up came from. */
		source_detail: text("source_detail"),
		/** When they last unsubscribed from every broadcast (null while subscribed). */
		unsubscribed_at: text("unsubscribed_at"),
		/** Their share link's code (/r/<code>), made the first time an email needs it. */
		referral_code: text("referral_code"),
		/** The contact whose link brought them. */
		referred_by: text("referred_by"),
		/** Sign-ups confirmed through their link. */
		referrals: integer("referrals").notNull().default(0),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("contacts_email_uidx").on(t.organization_id, t.email),
		index("contacts_org_created_idx").on(t.organization_id, t.created_at),
		uniqueIndex("contacts_referral_uidx")
			.on(t.referral_code)
			.where(sql`referral_code IS NOT NULL`),
		index("contacts_org_unsubscribed_idx")
			.on(t.organization_id, t.unsubscribed_at)
			.where(sql`unsubscribed_at IS NOT NULL`),
	],
);

/** Groups of a brand's contacts that broadcasts go to (Resend's Segments, once Audiences). */
export const segments = sqliteTable(
	"segments",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		created_at: text("created_at").notNull(),
	},
	(t) => [index("segments_org_idx").on(t.organization_id)],
);

export const contactSegments = sqliteTable(
	"contact_segments",
	{
		contact_id: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		segment_id: text("segment_id")
			.notNull()
			.references(() => segments.id, { onDelete: "cascade" }),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.segment_id, t.contact_id] }),
		index("contact_segments_contact_idx").on(t.contact_id),
	],
);

/**
 * What a contact can choose to get (Resend's Topics: the newsletter, product news). A broadcast
 * names one; its unsubscribe link leaves only that topic. opt_in topics reach only those who
 * opted in; opt_out ones everyone who didn't opt out.
 */
export const topics = sqliteTable(
	"topics",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		description: text("description"),
		/** "opt_in" | "opt_out". */
		default_subscription: text("default_subscription").notNull().default("opt_out"),
		/** "public" (on the preferences page) | "private". */
		visibility: text("visibility").notNull().default("public"),
		created_at: text("created_at").notNull(),
	},
	(t) => [index("topics_org_idx").on(t.organization_id)],
);

export const contactTopics = sqliteTable(
	"contact_topics",
	{
		contact_id: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		topic_id: text("topic_id")
			.notNull()
			.references(() => topics.id, { onDelete: "cascade" }),
		/** "opt_in" | "opt_out". */
		subscription: text("subscription").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.topic_id, t.contact_id] }),
		index("contact_topics_contact_idx").on(t.contact_id),
	],
);

/** A brand's custom contact fields (Resend's Contact Properties): {{{contact.<key>}}}. */
export const contactProperties = sqliteTable(
	"contact_properties",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		key: text("key").notNull(),
		/** "string" | "number". */
		type: text("type").notNull().default("string"),
		fallback_value: text("fallback_value"),
		created_at: text("created_at").notNull(),
	},
	(t) => [uniqueIndex("contact_properties_key_uidx").on(t.organization_id, t.key)],
);

export const BROADCAST_STATUSES = [
	"draft",
	"scheduled",
	"sending",
	/** Its A/B test went out; the winner goes to the rest when the test ends. */
	"testing",
	"sent",
	"canceled",
	"failed",
] as const;

/** A broadcast's A/B test of subject lines. */
export type AbTest = {
	/** The other subjects (A is the broadcast's own). */
	subjects: string[];
	/** What makes a winner. */
	metric: "opens" | "clicks";
	/** The share of contacts in the test, in percent (split between the versions). */
	size: number;
	/** How long the test runs before the winner goes to the rest. */
	wait_minutes: number;
	/** The winning version (0 is A), once picked. */
	winner: number | null;
};
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];
export type ReviewStatus = "requested" | "approved" | "changes";

/**
 * One email to a segment (Resend's Broadcasts). Sending turns it into one queued email per
 * contact, a chunk a minute (src/server/broadcasts.ts); their content is filled in from here
 * when the Dispatcher sends them.
 */
export const broadcasts = sqliteTable(
	"broadcasts",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		segment_id: text("segment_id"),
		/** Its unsubscribe link leaves this topic only; without one, every broadcast. */
		topic_id: text("topic_id"),
		from: text("from").notNull().default(""),
		subject: text("subject").notNull().default(""),
		reply_to: text("reply_to", { mode: "json" }).$type<string[]>(),
		preview_text: text("preview_text"),
		html: text("html").notNull().default(""),
		text: text("text"),
		/** Built in the visual editor: its blocks (html is made from them); null: HTML only. */
		design: text("design", { mode: "json" }).$type<EmailDoc>(),
		/** Subject lines tested on part of the segment before the rest get the winner. */
		ab_test: text("ab_test", { mode: "json" }).$type<AbTest>(),
		/** When the A/B test's winner is picked. */
		test_ends_at: text("test_ends_at"),
		/** Sent at this wall-clock time (2026-11-10T09:00) in each contact's own time zone. */
		local_time: text("local_time"),
		/** Goes to those who didn't open this other broadcast. */
		resend_of: text("resend_of"),
		/** Made from a template: which (its content was copied in). */
		template_id: text("template_id"),
		/** An issue of this newsletter (src/server/newsletters.ts); null: a one-off campaign. */
		newsletter_id: text("newsletter_id"),
		/** Shown on the newsletter's public archive once sent. */
		web: integer("web", { mode: "boolean" }).notNull().default(true),
		/** Its address on the archive (/n/<newsletter>/<slug>), set when it's first sent. */
		slug: text("slug"),
		/** Made by the newsletter's RSS feed: the items' links. */
		rss_items: text("rss_items", { mode: "json" }).$type<string[]>(),
		/** One of this campaign's emails (src/server/campaigns.ts). */
		campaign_id: text("campaign_id"),
		/** Leaves out contacts another email of its campaign already went to. */
		campaign_dedupe: integer("campaign_dedupe", { mode: "boolean" }).notNull().default(false),
		status: text("status").$type<BroadcastStatus>().notNull().default("draft"),
		scheduled_at: text("scheduled_at"),
		/** Contacts are queued in id order; the last one queued. */
		cursor: text("cursor"),
		/** Emails queued so far. */
		queued: integer("queued").notNull().default(0),
		started_at: text("started_at"),
		completed_at: text("completed_at"),
		error: text("error"),
		/**
		 * Its review (src/server/reviews.ts): "requested" | "approved" | "changes"; null: none.
		 * An approval holds for the content it saw (review_hash): editing it after asks again.
		 */
		review: text("review").$type<ReviewStatus>(),
		review_requested_by: text("review_requested_by"),
		review_requested_at: text("review_requested_at"),
		reviewed_by: text("reviewed_by"),
		reviewed_at: text("reviewed_at"),
		review_hash: text("review_hash"),
		/** Who made it, and who last changed it (user ids). */
		created_by: text("created_by"),
		updated_by: text("updated_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		index("broadcasts_org_created_idx").on(t.organization_id, t.created_at),
		index("broadcasts_due_idx")
			.on(t.scheduled_at)
			.where(sql`status IN ('scheduled', 'sending')`),
		index("broadcasts_newsletter_idx")
			.on(t.newsletter_id, t.started_at)
			.where(sql`newsletter_id IS NOT NULL`),
		index("broadcasts_campaign_idx").on(t.campaign_id).where(sql`campaign_id IS NOT NULL`),
	],
);

/**
 * A campaign (src/server/campaigns.ts): several broadcasts toward one goal ("Summer promotion"),
 * each its own email to its own segment, reported together, their links tagged with its
 * utm_campaign.
 */
export const campaigns = sqliteTable(
	"campaigns",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		description: text("description"),
		/** Added to its emails' links as utm_campaign (with utm_medium=email); null: links as written. */
		utm_campaign: text("utm_campaign"),
		/** When it runs (dates, YYYY-MM-DD), for the timeline. */
		starts_on: text("starts_on"),
		ends_on: text("ends_on"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("campaigns_org_idx").on(t.organization_id, t.created_at)],
);

/** A milestone of a newsletter's referral program: at `count` confirmed referrals, `reward`. */
export type ReferralReward = {
	count: number;
	/** What they get, as subscribers see it ("A free night", "10% off"). */
	reward: string;
	/** Emailed to them when they reach it (a published template); else only the event goes. */
	template_id?: string | null;
};

/** How a newsletter's public pages look; every field optional (defaults in newsletter-look.ts). */
export type NewsletterLook = {
	/** "brand" (the brand's logo), "none", or an image URL. */
	logo?: string | null;
	/** A wide image across the top of the archive page. */
	cover?: string | null;
	/** Keys of FONTS in src/lib/email-doc.ts. */
	font?: string | null;
	heading_font?: string | null;
	/** "auto" follows the reader's device. */
	theme?: "auto" | "light" | "dark" | null;
	/** The page's background in light mode. */
	background?: string | null;
	/** "list" (titles and previews) or "cards" (with each issue's first image). */
	layout?: "list" | "cards" | null;
	/** "center" or "left" header. */
	align?: "center" | "left" | null;
	/** The sign-up form above the issues, or after them. */
	form_position?: "top" | "bottom" | null;
	/** Links in the header (their website, Instagram…). */
	links?: { label: string; url: string }[] | null;
	/** "original" | "rounded" | "circle". */
	logo_shape?: string | null;
	/** "small" | "medium" | "large". */
	logo_size?: string | null;
	/** "square" | "soft" | "round": cards, pictures and buttons. */
	corners?: string | null;
	/** Lines around cards (else a soft shadow). On by default. */
	borders?: boolean | null;
	/** The top bar: "glass" (default), "solid" or "none". */
	bar?: "glass" | "solid" | "none" | null;
};

/**
 * A brand's newsletter (src/server/newsletters.ts): what lasts across its issues. Its issues are
 * broadcasts with its id; once sent they're on its public archive (/n/<slug>), with its sign-up
 * form. It can post its blog's new RSS items as issues, and run a referral program.
 */
export const newsletters = sqliteTable(
	"newsletters",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		/** Its public address: /n/<slug>. Unique across the deployment. */
		slug: text("slug").notNull(),
		description: text("description"),
		/** Who its issues go to, their topic and From (an issue's own fields start from these). */
		segment_id: text("segment_id"),
		topic_id: text("topic_id"),
		from: text("from").notNull().default(""),
		/** The sign-up form on its archive page and that referral links open. */
		form_id: text("form_id"),
		/** Its archive is on the web. */
		public: integer("public", { mode: "boolean" }).notNull().default(true),
		/** Its brand's color on the archive page. */
		accent: text("accent"),
		/** How its public pages look (src/server/newsletter-look.ts). */
		look: text("look", { mode: "json" }).$type<NewsletterLook>(),
		rss_url: text("rss_url"),
		/** How an issue made from new posts lays them out: "full" | "compact" | "titles". */
		rss_style: text("rss_style").notNull().default("full"),
		/** A line at the top of an issue made from new posts. */
		rss_intro: text("rss_intro"),
		/** "draft" (each new post becomes a draft issue) | "send" (it's sent right away). */
		rss_mode: text("rss_mode").notNull().default("draft"),
		/** The feed's items already seen (their links, newest first, up to 200). */
		rss_seen: text("rss_seen", { mode: "json" }).$type<string[]>(),
		rss_checked_at: text("rss_checked_at"),
		rss_error: text("rss_error"),
		referrals: integer("referrals", { mode: "boolean" }).notNull().default(false),
		referral_rewards: text("referral_rewards", { mode: "json" }).$type<ReferralReward[]>(),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		uniqueIndex("newsletters_slug_uidx").on(t.slug),
		index("newsletters_org_idx").on(t.organization_id),
	],
);

/** Answers to the polls in broadcasts (src/server/polls.ts): one per contact and poll, the last kept. */
export const pollVotes = sqliteTable(
	"poll_votes",
	{
		broadcast_id: text("broadcast_id")
			.notNull()
			.references(() => broadcasts.id, { onDelete: "cascade" }),
		/** The poll block's id. */
		poll_id: text("poll_id").notNull(),
		contact_id: text("contact_id")
			.notNull()
			.references(() => contacts.id, { onDelete: "cascade" }),
		/** The option's index. */
		answer: integer("answer").notNull(),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.broadcast_id, t.poll_id, t.contact_id] }),
		index("poll_votes_contact_idx").on(t.contact_id),
	],
);

export const AUTOMATION_STATUSES = ["draft", "active", "paused"] as const;
export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** What starts an automation for a contact. */
export type AutomationTrigger =
	| { type: "contact.created"; segment_id?: string | null }
	| { type: "segment.joined"; segment_id: string }
	| { type: "event"; event: string }
	/** The contact opened (or clicked a link in) a broadcast: any, or one; for clicks, maybe one link. */
	| { type: "email.opened"; broadcast_id?: string | null }
	| { type: "email.clicked"; broadcast_id?: string | null; link?: string | null };

/** One step of an automation, done in order for each contact. */
export type AutomationStep =
	| { type: "wait"; minutes: number }
	| {
			type: "send";
			template_id: string;
			from?: string | null;
			subject?: string | null;
			variables?: Record<string, string | number>;
	  }
	| {
			/**
			 * Goes on (the steps after it are its "yes" path) when it holds; otherwise the run
			 * takes the "no" steps, or ends here when there are none.
			 */
			type: "condition";
			segment_id?: string | null;
			property?: string | null;
			equals?: string | number | null;
			/** The contact opened (or clicked) the run's last email. */
			engaged?: "opened" | "clicked" | null;
			no?: AutomationStep[] | null;
	  }
	/** Adds the contact to a segment, or takes them out of it. */
	| { type: "segment"; action: "add" | "remove"; segment_id: string }
	/** Sets one of the contact's properties. */
	| { type: "property"; key: string; value: string | number };

/**
 * Automations, like Resend's: a trigger (a contact added, a segment joined, or an event an app
 * sends to POST /events) and steps (wait, send a template, a condition). Each contact it starts for
 * gets a run (automation_runs) the cron moves on a minute at a time (src/server/automations.ts).
 */
export const automations = sqliteTable(
	"automations",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		status: text("status").$type<AutomationStatus>().notNull().default("draft"),
		trigger: text("trigger", { mode: "json" }).$type<AutomationTrigger>().notNull(),
		steps: text("steps", { mode: "json" }).$type<AutomationStep[]>().notNull(),
		/** Start again for a contact who already went through it (events only). */
		reentry: integer("reentry", { mode: "boolean" }).notNull().default(false),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("automations_org_idx").on(t.organization_id, t.status)],
);

export const AUTOMATION_RUN_STATUSES = ["active", "done", "exited", "failed", "canceled"] as const;
export type AutomationRunStatus = (typeof AUTOMATION_RUN_STATUSES)[number];

export const automationRuns = sqliteTable(
	"automation_runs",
	{
		id: text("id").primaryKey(),
		automation_id: text("automation_id")
			.notNull()
			.references(() => automations.id, { onDelete: "cascade" }),
		organization_id: orgId(),
		contact_id: text("contact_id").notNull(),
		/** The next step to do (its index in the top-level steps). */
		step: integer("step").notNull().default(0),
		/**
		 * Where it is when inside a condition's "no" steps: indexes, each but the last one a
		 * condition whose "no" steps the next one is in. Null: at `step` of the top level.
		 */
		path: text("path", { mode: "json" }).$type<number[]>(),
		status: text("status").$type<AutomationRunStatus>().notNull().default("active"),
		/** When the next step is due. */
		next_at: text("next_at"),
		/** A claimed run not moved on by then was left by a cron that died. */
		locked_until: text("locked_until"),
		/** The event's data, as {{{event.<key>}}} in its emails. */
		data: text("data", { mode: "json" }).$type<Record<string, unknown>>(),
		/** The last email it sent (for an "engaged" condition). */
		last_email_id: text("last_email_id"),
		error: text("error"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [
		index("automation_runs_due_idx").on(t.next_at).where(sql`status = 'active'`),
		index("automation_runs_automation_idx").on(t.automation_id, t.contact_id),
	],
);

/**
 * A brand's inbound rules: what to do with an email it receives, the first match first. `to`
 * matches the address it came to (`support@hotel.com`, `*@hotel.com`, `support@*`, `*`); `from`
 * and `subject` (optional) are contained in its From and subject, ignoring case.
 */
export const inboundRules = sqliteTable(
	"inbound_rules",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		match_to: text("match_to").notNull().default("*"),
		match_from: text("match_from"),
		match_subject: text("match_subject"),
		/** forward: send a copy to forward_to; drop: not kept nor sent to webhooks. */
		action: text("action").$type<"forward" | "drop">().notNull(),
		forward_to: text("forward_to", { mode: "json" }).$type<string[]>(),
		/** Look at the next rules too (forward to several places). */
		continue: integer("continue", { mode: "boolean" }).notNull().default(false),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		position: integer("position").notNull().default(0),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("inbound_rules_org_idx").on(t.organization_id, t.position)],
);

/** The deliverability watch's last look at a domain (src/server/deliverability.ts). */
export const domainHealth = sqliteTable("domain_health", {
	domain_id: text("domain_id")
		.primaryKey()
		.references(() => domains.id, { onDelete: "cascade" }),
	organization_id: orgId(),
	problems: text("problems", { mode: "json" })
		.$type<
			{
				record: string;
				name: string;
				expected: string;
				found: string[];
				level: "error" | "warning";
			}[]
		>()
		.notNull(),
	listings: text("listings", { mode: "json" })
		.$type<{ list: string; status: "listed" | "clean" | "unknown"; detail?: string }[]>()
		.notNull(),
	checked_at: text("checked_at").notNull(),
	/** The problems last emailed about, so each is emailed once. */
	alerted: text("alerted"),
});

/** An organization's choices that aren't anyone's sending setup (src/server/archive.ts). */
export const organizationSettings = sqliteTable("organization_settings", {
	organization_id: text("organization_id").primaryKey(),
	/** Past retention, its brands' emails go to R2 instead of only being deleted. Off by default. */
	archive: integer("archive", { mode: "boolean" }).notNull().default(false),
	/**
	 * What Mailroom does when a stream crosses the sending limits' "act" level (src/server/alerts.ts):
	 * "alert" | "pause" (its domains of that kind), or null for the deployment's default.
	 */
	transactional_action: text("transactional_action"),
	marketing_action: text("marketing_action"),
	/** Owners and admins get the weekly digest (src/server/digest.ts). On by default. */
	digest: integer("digest", { mode: "boolean" }).notNull().default(true),
	digest_sent_at: text("digest_sent_at"),
	/** Every broadcast needs someone else's approval before it's sent or scheduled. */
	require_approval: integer("require_approval", { mode: "boolean" }).notNull().default(false),
	/**
	 * The brand's own inbound address on one of its receiving domains (inbox@reply.example.com),
	 * shown instead of <slug>@INBOUND_DOMAIN, which keeps working. Ignored while that domain
	 * doesn't receive (src/server/inbound.ts, mailroomAddress).
	 */
	inbound_address: text("inbound_address"),
	updated_at: text("updated_at").notNull(),
});

/**
 * A brand's public sign-up form (src/server/signup-forms.ts): a website posts an address to it,
 * Mailroom emails a confirmation link, and the click adds the contact (to a segment and topic).
 */
export const signupForms = sqliteTable(
	"signup_forms",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		/** What the hosted page and the confirmation email say it's for ("The Harbor Inn newsletter"). */
		title: text("title").notNull(),
		segment_id: text("segment_id"),
		topic_id: text("topic_id"),
		/** The confirmation email's From: an address on one of the brand's verified domains. */
		from: text("from").notNull(),
		ask_name: integer("ask_name", { mode: "boolean" }).notNull().default(true),
		/** The website it's on (https://harborinn.com): its host is added to the brand's
		 * Turnstile widget. */
		website: text("website"),
		/** Where the confirmation link sends people (else Mailroom's "You're subscribed" page). */
		redirect_url: text("redirect_url"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		/** How it looks and what it says (src/lib/signup-form-render.ts FormDesign); missing keys
		 * take the defaults. */
		design: text("design", { mode: "json" })
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		/** Confirmation emails sent, and addresses confirmed. */
		signups: integer("signups").notNull().default(0),
		confirmed: integer("confirmed").notNull().default(0),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("signup_forms_org_idx").on(t.organization_id)],
);

/**
 * Each brand's Cloudflare Turnstile widget for its sign-up forms (src/server/turnstile.ts), made
 * and kept in step with its forms' websites through the API. The free plan allows 20 widgets of
 * 10 hostnames each.
 */
export const turnstileWidgets = sqliteTable("turnstile_widgets", {
	organization_id: text("organization_id").primaryKey(),
	sitekey: text("sitekey").notNull(),
	secret: text("secret").notNull(),
	domains: text("domains", { mode: "json" }).$type<string[]>().notNull(),
	/** The last error syncing it (null: in step). */
	error: text("error"),
	updated_at: text("updated_at").notNull(),
});

/**
 * Gmail Postmaster Tools' view of each verified sending domain (src/server/postmaster.ts): where
 * its registration with the connected Google account stands, and Gmail's compliance verdicts.
 */
export const postmasterDomains = sqliteTable("postmaster_domains", {
	domain_id: text("domain_id")
		.primaryKey()
		.references(() => domains.id, { onDelete: "cascade" }),
	organization_id: orgId(),
	/** "pending" (waiting for its TXT record) | "verified". */
	status: text("status"),
	/** The TXT record's value Google verifies the domain with. */
	token: text("token"),
	compliance: text("compliance", { mode: "json" }).$type<{
		requirements: { requirement: string; status: string }[];
		deliverability: { state: string | null; reason: string | null } | null;
		oneClickUnsubscribe: { status: string | null; reason: string | null } | null;
	}>(),
	error: text("error"),
	checked_at: text("checked_at"),
});

/** Gmail's daily statistics of a sending domain (rates 0–1; null when Gmail had too little). */
export const postmasterStats = sqliteTable(
	"postmaster_stats",
	{
		domain: text("domain").notNull(),
		organization_id: text("organization_id").notNull(),
		day: text("day").notNull(),
		spam_rate: real("spam_rate"),
		spf_rate: real("spf_rate"),
		dkim_rate: real("dkim_rate"),
		dmarc_rate: real("dmarc_rate"),
		tls_rate: real("tls_rate"),
		delivery_error_rate: real("delivery_error_rate"),
	},
	(t) => [primaryKey({ columns: [t.domain, t.day] })],
);

/**
 * Who changed what in an organization (src/server/activity.ts): the dashboard's and the
 * assistant's changes, newest first. Repeated saves of one thing by one person within a few
 * minutes are one row.
 */
export const activity = sqliteTable(
	"activity",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		user_id: text("user_id"),
		/** Who, as shown then: a person's name or email, or "Mailroom". */
		actor: text("actor").notNull(),
		/** "broadcast.sent", "member.invited"… */
		action: text("action").notNull(),
		subject_type: text("subject_type").notNull(),
		subject_id: text("subject_id"),
		subject_name: text("subject_name"),
		detail: text("detail", { mode: "json" }).$type<ActivityDetail>(),
		created_at: text("created_at").notNull(),
	},
	(t) => [
		index("activity_org_created_idx").on(t.organization_id, t.created_at),
		index("activity_subject_idx").on(t.subject_type, t.subject_id),
	],
);

export type ActivityDetail = Record<string, string | number | boolean | null | string[]>;

/** A comment on a broadcast or a template (src/server/comments.ts). */
export const comments = sqliteTable(
	"comments",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** "broadcast" | "template". */
		subject_type: text("subject_type").notNull(),
		subject_id: text("subject_id").notNull(),
		user_id: text("user_id").notNull(),
		body: text("body").notNull(),
		/** A block of its design the comment is about. */
		block_id: text("block_id"),
		/** "comment" | "approved" | "changes" | "requested": review steps show in the thread. */
		kind: text("kind").notNull().default("comment"),
		resolved_at: text("resolved_at"),
		resolved_by: text("resolved_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at"),
	},
	(t) => [index("comments_subject_idx").on(t.subject_type, t.subject_id, t.created_at)],
);

/**
 * Earlier versions of a broadcast's or a template's content (src/server/versions.ts), kept on
 * save: a new one when someone else saves, or 10 minutes after the last. The last 50 stay.
 */
export const contentVersions = sqliteTable(
	"content_versions",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		/** "broadcast" | "template". */
		subject_type: text("subject_type").notNull(),
		subject_id: text("subject_id").notNull(),
		user_id: text("user_id"),
		snapshot: text("snapshot", { mode: "json" }).$type<VersionSnapshot>().notNull(),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("content_versions_subject_idx").on(t.subject_type, t.subject_id, t.created_at)],
);

export type VersionSnapshot = {
	subject: string;
	preview_text: string | null;
	html: string;
	text: string | null;
	design: EmailDoc | null;
};

/** A section of an email (one block or several) saved for anyone in the organization to reuse. */
export const savedSections = sqliteTable(
	"saved_sections",
	{
		id: text("id").primaryKey(),
		organization_id: orgId(),
		name: text("name").notNull(),
		blocks: text("blocks", { mode: "json" }).$type<Block[]>().notNull(),
		created_by: text("created_by"),
		updated_by: text("updated_by"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(t) => [index("saved_sections_org_idx").on(t.organization_id, t.updated_at)],
);

/**
 * How a brand's unsubscribe and preferences page looks and what it says (src/lib/subscriber-page.ts
 * SubscriberPage); missing keys take the defaults (the brand's logo and kit colors).
 */
export const subscriberPages = sqliteTable("subscriber_pages", {
	/** The brand's id. */
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	look: text("look", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
	updated_by: text("updated_by"),
	updated_at: text("updated_at").notNull(),
});

/** A brand's kit (src/lib/brand-kit.ts): its colors, fonts and buttons, for every email. */
export const brandKits = sqliteTable("brand_kits", {
	/** The brand's id. */
	organization_id: text("organization_id")
		.primaryKey()
		.references(() => organization.id, { onDelete: "cascade" }),
	kit: text("kit", { mode: "json" }).$type<BrandKit>().notNull(),
	updated_by: text("updated_by"),
	updated_at: text("updated_at").notNull(),
});
