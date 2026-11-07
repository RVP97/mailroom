import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { findBimi } from "../../lib/bimi";
import { explainBounce } from "../../lib/bounces";
import { findDmarc, txtRecords } from "../../lib/dmarc";
import { maskDigits } from "../../lib/roles";
import { archiveBucket, archiveLink, listArchive } from "../archive";
import { brandIds, brandIn, brandNames, getBrand, removeBrand, viewScope } from "../brands";
import { db, schema } from "../db";
import { domainHealth } from "../deliverability";
import { sendsReportsHere, withReportsAddress } from "../dmarc-address";
import { dnsHelp } from "../domain-connect";
import { baseUrl, requestLogRetentionDays } from "../env";
import { ApiError, notFound } from "../errors";
import { checkAddress } from "../firewall";
import {
	assignees,
	deleteRule,
	deleteSavedReply,
	listRules,
	listSavedReplies,
	orderRules,
	RULE_ACTIONS,
	RULE_FIELDS,
	RULE_OPS,
	ruleView,
	savedReplyFor,
	savedReplyView,
	saveRule,
	saveSavedReply,
	settingsOf,
	updateSettings,
	VARIABLES,
} from "../inbox-workflow";
import {
	activityView,
	credentialView,
	deleteInbox,
	getCredential,
	inboxActivity,
	inboxFor,
	inboxView,
	listCredentials,
	logInbox,
	revokeCredential,
	updateCredential,
	updateInbox,
} from "../inboxes";
import { insightDetail, KINDS, parseSubject, subjectTitle } from "../insight-detail";
import { dnsRecords, setDomainPaused, setDomainPurpose, setDomainSending } from "../provision";
import { dailyStats, emailEvents, getEmail, inScope, suppressionsOf } from "../queries";
import { getRequest, listRequests } from "../request-logs";
import { deleteSmtpCredentials, smtpCredentials } from "../smtp";
import { setTracking } from "../tracking";
import { replayDelivery } from "../webhooks";
import { personActor } from "./inbox-tools";
import {
	brand,
	brandOf,
	defined,
	domainOf,
	domainView,
	logged,
	oneBrand,
	orgAt,
	organization,
	scopeOf,
	type Tool,
} from "./kit";
import type { McpContext, Membership } from "./tools";

/** Brands, domains, developers, recipients, inboxes' setup, and the deployment's admin. */

/** An inbox the person may manage, with them as its actor. */
async function managedInbox(ctx: McpContext, org: Membership, ref: string) {
	const actor = await personActor(org, ctx);
	return { actor, inbox: await inboxFor(actor, ref) };
}

const ruleShape = {
	name: z.string().min(1).max(100),
	enabled: z.boolean().optional().describe("Default true."),
	match: z.enum(["all", "any"]).optional().describe("Every condition (default) or any one."),
	conditions: z
		.array(
			z.object({
				field: z.enum(RULE_FIELDS),
				op: z.enum(RULE_OPS).optional().describe("Default contains."),
				value: z
					.string()
					.max(500)
					.optional()
					.describe(
						'What to compare; for yes/no fields (has_attachments, new_conversation, suspicious, business_hours) "true" or "false".',
					),
			}),
		)
		.max(20)
		.describe("None: every new message matches."),
	actions: z
		.array(
			z.object({
				type: z.enum(RULE_ACTIONS),
				value: z
					.union([z.string().max(2000), z.number()])
					.nullish()
					.describe(
						"add_tag: the tag; set_priority: urgent|high|normal|low; assign: a reader (list_assignees); snooze_hours: hours; auto_reply and note: the text; notify: an email address.",
					),
			}),
		)
		.min(1)
		.max(20),
	stop: z.boolean().optional().describe("Later rules don't run after this one matches."),
};

/** The inbox workflow (settings, rules, saved replies) and its report, for people. */
const WORKFLOW_TOOLS: Tool[] = [
	{
		name: "get_inbox_workflow",
		title: "Get an inbox's workflow",
		description:
			"An inbox's workflow: settings (signature, assignment and round robin, claim minutes, SLA targets per priority and business hours, CSAT survey, holding suspicious mail, undo seconds, tags), its rules in order, who can be assigned and the saved replies it can use.",
		input: { organization, inbox: z.string().describe("The inbox's id or address.") },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "member");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const [rules, people, saved] = await Promise.all([
				listRules(inbox.id),
				assignees(org.id, inbox),
				listSavedReplies(actor, { inbox: inbox.id }),
			]);
			return {
				inbox: inboxView(inbox),
				settings: settingsOf(inbox),
				rules: rules.map(ruleView),
				assignees: people.map(({ email: _e, ...p }) => p),
				saved_replies: saved.map(savedReplyView),
			};
		},
	},
	{
		name: "update_inbox_workflow",
		title: "Change an inbox's workflow",
		description:
			'Changes an inbox\'s workflow settings. Pass only what changes; objects merge into what is there (sla: {enabled: true} keeps its targets). Fields: signature (text added under replies; {{agent.name}} works), assignment {mode: manual|round_robin, members: readers from list_assignees like "user:<id>", max_open}, claim_minutes, sla {enabled, targets: {urgent|high|normal|low: {reply, resolve}} in minutes, business_hours {timezone (IANA), days 0=Sunday…6, start, end "HH:MM"} or null for around the clock, warn_minutes, notify: emails}, csat {enabled, question, thanks, delay_minutes}, hold_suspicious, undo_seconds (0–60), tags [{name, color}]. Returns all the settings.',
		input: {
			organization,
			inbox: z.string(),
			settings: z.record(z.string(), z.unknown()),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const settings = a.settings as Record<string, unknown>;
			const next = await updateSettings(inbox, settings);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.workflow_updated",
				detail: { changed: Object.keys(settings), via: "assistant" },
			});
			return next;
		},
	},
	{
		name: "save_inbox_rule",
		title: "Create or change an inbox rule",
		description:
			"Creates a rule that runs on each new message in an inbox (or changes one, with id): when its conditions match, it tags, sets priority, assigns, snoozes, resolves, auto-replies, leaves a note, holds the message or notifies someone. Rules run in order (order_inbox_rules). Changing a rule replaces it whole.",
		input: { organization, inbox: z.string(), id: z.string().optional(), ...ruleShape },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const { organization: _o, inbox: _i, id, ...rule } = a;
			const row = await saveRule(inbox, rule, { id: id as string | undefined });
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: id ? "rule.updated" : "rule.created",
				detail: { rule: row.name, via: "assistant" },
			});
			return ruleView(row);
		},
	},
	{
		name: "delete_inbox_rule",
		title: "Delete an inbox rule",
		description: "Deletes one of an inbox's rules.",
		input: { organization, inbox: z.string(), id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			await deleteRule(inbox, a.id as string);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "rule.deleted",
				detail: { via: "assistant" },
			});
			return { deleted: true };
		},
	},
	{
		name: "order_inbox_rules",
		title: "Reorder an inbox's rules",
		description:
			"Puts an inbox's rules in this order (rule ids; any left out keep their order after them). Returns the rules.",
		input: { organization, inbox: z.string(), ids: z.array(z.string()).max(200) },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { inbox } = await managedInbox(ctx, org, a.inbox as string);
			await orderRules(inbox, a.ids as string[]);
			return (await listRules(inbox.id)).map(ruleView);
		},
	},
	{
		name: "save_saved_reply",
		title: "Create or change a saved reply",
		description: `Creates a saved reply (an approved answer people and agents reuse), or changes one with id. text can use variables: ${VARIABLES.map((v) => `{{${v.key}}}`).join(", ")}. inbox_id limits it to one inbox; without it, every inbox of the brand. After it's sent it can add tags, resolve the conversation or snooze it.`,
		input: {
			organization,
			brand,
			id: z.string().optional(),
			name: z.string().min(1).max(100),
			text: z.string().min(1).max(20_000),
			inbox_id: z.string().nullish(),
			shortcut: z
				.string()
				.nullish()
				.describe("A short word to find it with (letters, digits, - or _)."),
			add_tags: z.array(z.string()).max(10).nullish(),
			set_status: z.enum(["resolved"]).nullish(),
			snooze_days: z.number().int().min(1).max(90).nullish(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:reply");
			const actor = await personActor(org, ctx);
			const { organization: _o, brand: b, id, ...reply } = a;
			const owner = id
				? (await savedReplyFor(actor, id as string)).organization_id
				: reply.inbox_id
					? (await inboxFor(actor, reply.inbox_id as string)).organization_id
					: b
						? await brandIn(org.id, b as string)
						: org.id;
			const row = await saveSavedReply(owner, defined(reply), {
				id: id as string | undefined,
				userId: ctx.userId,
			});
			await logged(ctx, org, id ? "saved_reply.updated" : "saved_reply.created", {
				type: "saved_reply",
				id: row.id,
				name: row.name,
			});
			return savedReplyView(row);
		},
	},
	{
		name: "delete_saved_reply",
		title: "Delete a saved reply",
		description: "Deletes a saved reply.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:reply");
			const actor = await personActor(org, ctx);
			await deleteSavedReply(actor.brands, a.id as string);
			await logged(ctx, org, "saved_reply.deleted", {
				type: "saved_reply",
				id: a.id as string,
			});
			return { deleted: true };
		},
	},
	{
		name: "inbox_report",
		title: "Inbox report",
		description:
			"The inboxes' report for a period (default the last 30 days): totals (conversations, replies, first-reply and resolve times, SLA hits and misses, CSAT) against the period before, what's open now (unassigned, overdue, snoozed, held, waiting), a daily series, an hour-of-week heatmap, and breakdowns by inbox, assignee, responder, tag, channel and priority. inbox narrows it to one inbox; brand to one brand.",
		input: {
			organization,
			brand,
			inbox: z.string().nullish(),
			from: z.string().nullish().describe("A date (YYYY-MM-DD) or ISO time."),
			to: z.string().nullish(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "member");
			const { scope } = await viewScope(org.id, a.brand as string | undefined);
			const person = await personActor(org, ctx);
			const actor = typeof scope === "string" ? { ...person, brands: [scope] } : person;
			const { inboxReport } = await import("../inbox-reports");
			return inboxReport(actor, {
				from: a.from as string | null | undefined,
				to: a.to as string | null | undefined,
				inbox: a.inbox as string | null | undefined,
			});
		},
	},
];

const adminOnly = (ctx: McpContext) => {
	if (!ctx.isAdmin)
		throw new ApiError(403, "forbidden", "Only this deployment's admins can do this.");
};

export const SETTINGS_TOOLS: Tool[] = [
	// ── Brands ──
	{
		name: "get_brand",
		title: "Get a brand",
		description:
			"One brand: its setup (SES tenants, paused or not), its domains and its last 30 days of sending.",
		input: { organization, brand: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await getBrand(org.id, a.brand as string);
			const [stats, domains] = await Promise.all([
				dailyStats(b.id, 30),
				db.select().from(schema.domains).where(eq(schema.domains.organization_id, b.id)),
			]);
			return {
				...b,
				domains: domains.map((d) => ({
					id: d.id,
					name: d.name,
					status: d.status,
					purpose: d.purpose,
					paused: d.paused_at ? { at: d.paused_at, reason: d.paused_reason } : null,
				})),
				last_30_days: stats.totals,
				health: stats.health,
			};
		},
	},
	{
		name: "delete_brand",
		title: "Delete a brand",
		description:
			"Removes a brand (not the organization's own): its contacts, broadcasts and the rest move to another brand (move_to), its domains leave SES. Confirm with the person first.",
		input: {
			organization,
			brand: z.string(),
			move_to: z.string().describe("The brand that gets what it had"),
		},
		destructive: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "brands:edit");
			const r = await removeBrand(org.id, a.brand as string, a.move_to as string);
			await logged(ctx, org, "brand.removed", { type: "brand", id: a.brand as string });
			return r ?? { removed: a.brand };
		},
	},

	// ── Domains ──
	{
		name: "update_domain",
		title: "Change a domain's settings",
		description:
			"Changes a domain: purpose (transactional, or marketing: sends through the brand's second tenant with a one-click unsubscribe), paused (its sends are refused until resumed; a pause Mailroom made only an admin lifts), sending (brands send from it or not), open_tracking and click_tracking.",
		input: {
			organization,
			domain: z.string().describe("The domain's name or id"),
			purpose: z.enum(["transactional", "marketing"]).optional(),
			paused: z.boolean().optional(),
			sending: z.boolean().optional(),
			open_tracking: z.boolean().optional(),
			click_tracking: z.boolean().optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "domains:manage");
			const d = await domainOf(org.id, a.domain as string);
			const b = d.organization_id;
			if (a.purpose)
				await setDomainPurpose(b, d.id, a.purpose as "transactional" | "marketing");
			if (a.paused !== undefined)
				await setDomainPaused(b, d.id, a.paused as boolean, "you", Date.now(), {
					isAdmin: ctx.isAdmin,
				});
			if (a.sending !== undefined) await setDomainSending(b, d.id, a.sending as boolean);
			if (a.open_tracking !== undefined || a.click_tracking !== undefined)
				await setTracking(b, d.id, {
					open: a.open_tracking as boolean | undefined,
					click: a.click_tracking as boolean | undefined,
				});
			await logged(ctx, org, "domain.updated", { type: "domain", id: d.id, name: d.name });
			return domainView(await domainOf(org.id, d.id));
		},
	},
	{
		name: "domain_dns_help",
		title: "DNS help for a domain",
		description:
			"Where a domain's DNS is hosted (name and its DNS page) and, when the host supports Domain Connect, a link that adds every record Mailroom needs in one click; plus its DMARC record (whose reports come to Mailroom, and the record to set if not) and BIMI record as found in DNS now.",
		input: { organization, domain: z.string().describe("The domain's name or id") },
		readOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const d = await domainOf(org.id, a.domain as string);
			const [dmarc, bimi] = await Promise.all([
				findDmarc(d.name, txtRecords).catch(() => null),
				findBimi(d.name, txtRecords).catch(() => null),
			]);
			const bimiRecord = dnsRecords(d).find((r) => r.record === "BIMI");
			const host = await dnsHelp(
				d,
				{
					dmarc: dmarc?.found ?? true,
					bimi: !bimiRecord || !bimi || bimi.found,
				},
				`${baseUrl()}/domains/${d.id}?connected=1`,
			).catch(() => null);
			const own = dmarc?.found && !dmarc.inherited ? dmarc.record : null;
			return {
				domain: d.name,
				dns_host: host,
				dmarc: {
					found: dmarc,
					reports_come_here: sendsReportsHere(dmarc?.record),
					record_to_set: {
						name: `_dmarc.${d.name}`,
						value: withReportsAddress(own ?? `v=DMARC1; p=${dmarc?.policy ?? "none"};`),
					},
				},
				bimi,
			};
		},
	},
	{
		name: "domain_health",
		title: "A domain's deliverability watch",
		description:
			"What the daily deliverability watch last found for a domain: DNS problems (DKIM, MAIL FROM, MX, DMARC) and blocklist listings. check_deliverability checks now.",
		input: { organization, domain: z.string().describe("The domain's name or id") },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const d = await domainOf(org.id, a.domain as string);
			return { domain: d.name, ...(await domainHealth(d.id)) };
		},
	},
	// ── Developers ──
	{
		name: "list_webhook_deliveries",
		title: "Webhook deliveries",
		description:
			"The last 100 deliveries to a webhook endpoint: event, status, attempts, the endpoint's answer, and when it'll try again.",
		input: { organization, webhook: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "developers:webhooks");
			return db
				.select()
				.from(schema.webhookDeliveries)
				.where(
					and(
						eq(schema.webhookDeliveries.webhook_id, a.webhook as string),
						eq(schema.webhookDeliveries.organization_id, org.id),
					),
				)
				.orderBy(desc(schema.webhookDeliveries.created_at))
				.limit(100);
		},
	},
	{
		name: "replay_webhook_delivery",
		title: "Replay one webhook delivery",
		description: "Sends one delivery again (list_webhook_deliveries gives its id).",
		input: { organization, delivery: z.string() },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "developers:webhooks");
			return { replayed: await replayDelivery(org.id, a.delivery as string) };
		},
	},
	{
		name: "list_api_logs",
		title: "API request logs",
		description:
			"The organization's calls to the public API, newest first (50 a page; page with `before`, the previous page's cursor): method, path, status, the key that made it, how long it took. Filter by status class, API key, days or a search.",
		input: {
			organization,
			search: z.string().optional(),
			status: z.enum(["2xx", "4xx", "5xx"]).optional(),
			api_key_id: z.string().optional(),
			days: z.number().int().min(1).max(90).optional(),
			before: z.string().optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const page = await listRequests(org.id, {
				search: a.search as string | undefined,
				status: a.status as never,
				apiKeyId: a.api_key_id as string | undefined,
				days: a.days as number | undefined,
				before: a.before as string | undefined,
				limit: 50,
			});
			return { ...page, retention_days: requestLogRetentionDays() };
		},
	},
	{
		name: "get_api_log",
		title: "Get an API request",
		description:
			"One API call with its request and response bodies (as kept) and the email it made.",
		input: { organization, id: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const log = await getRequest(org.id, a.id as string);
			if (!log)
				throw new ApiError(
					404,
					"not_found",
					"This log doesn't exist, or is past its retention",
				);
			if (!org.masked) return log;
			return {
				...log,
				request_body:
					log.request_body == null ? log.request_body : maskDigits(log.request_body),
				response_body:
					log.response_body == null ? log.response_body : maskDigits(log.response_body),
			};
		},
	},
	{
		name: "get_smtp_credentials",
		title: "SMTP credentials",
		description:
			"A brand's SMTP username and region, if it has credentials (the password is never kept; new ones are made in the dashboard).",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const row = await smtpCredentials(await brandOf(org.id, a.brand));
			return row
				? {
						username: row.access_key_id,
						region: row.region,
						host: `email-smtp.${row.region}.amazonaws.com`,
						created_at: row.created_at,
					}
				: null;
		},
	},
	{
		name: "delete_smtp_credentials",
		title: "Delete SMTP credentials",
		description: "Revokes a brand's SMTP credentials at once: whatever uses them can't send.",
		input: { organization, brand: oneBrand },
		destructive: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "developers:keys");
			const b = await brandOf(org.id, a.brand);
			await deleteSmtpCredentials(b);
			await logged(ctx, org, "smtp.deleted", { type: "smtp", id: b });
			return { deleted: true };
		},
	},

	// ── Emails and recipients ──
	{
		name: "cancel_email",
		title: "Cancel a scheduled email",
		description: "Cancels an email scheduled for later (status scheduled) before it goes.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:send");
			const [row] = await db
				.update(schema.emails)
				.set({
					status: "canceled",
					send_at: null,
					last_event: "canceled",
					last_event_at: new Date().toISOString(),
				})
				.where(
					and(
						eq(schema.emails.id, a.id as string),
						inScope(schema.emails.organization_id, { org: org.id }),
						inArray(schema.emails.status, ["scheduled", "queued"]),
					),
				)
				.returning({ id: schema.emails.id });
			if (!row) throw new ApiError(409, "conflict", "Only a scheduled email can be canceled");
			return { id: row.id, status: "canceled" };
		},
	},
	{
		name: "get_suppression",
		title: "Why an address is suppressed",
		description:
			"One suppressed address: why (the bounce or complaint, SES's own words and what they mean), the email that caused it, the other brands that skip it too, and what was sent to it lately. Null when no brand suppresses it.",
		input: { organization, brand: oneBrand, address: z.string().max(320) },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const all = await suppressionsOf(await scopeOf(org.id, undefined), a.address as string);
			const want = a.brand ? await brandIn(org.id, a.brand as string) : null;
			const s = want ? all.find((r) => r.organization_id === want) : all[0];
			if (!s) return null;
			const [email, events] = await Promise.all([
				s.email_id ? getEmail(s.organization_id, s.email_id) : null,
				s.email_id ? emailEvents(s.email_id) : [],
			]);
			const event = events.find(
				(e) =>
					["email.bounced", "email.complained", "email.suppressed"].includes(e.type) &&
					(!e.recipient || e.recipient === s.address),
			);
			const names = await brandNames(all.map((r) => r.organization_id));
			return {
				suppression: { ...s, brand: names.get(s.organization_id) ?? null },
				also: all
					.filter((r) => r !== s)
					.map((r) => ({ ...r, brand: names.get(r.organization_id) ?? null })),
				email: email
					? {
							id: email.id,
							subject: org.masked ? maskDigits(email.subject) : email.subject,
							from: email.from,
							status: email.status,
							bounce_type: email.bounce_type,
							error: email.error,
							created_at: email.created_at,
						}
					: null,
				event: event ? { type: event.type, at: event.at, data: event.data } : null,
				explanation:
					s.reason === "bounce"
						? explainBounce({
								type: "Permanent",
								subType: email?.bounce_type?.split("/")[1] ?? null,
								message: s.detail,
								recipient: s.address,
							})
						: null,
			};
		},
	},
	{
		name: "test_firewall",
		title: "Test the email firewall",
		description:
			"What a brand's email firewall would do with an address (allowed, or which check or list blocks it), without sending.",
		input: { organization, brand: oneBrand, address: z.string().max(320) },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			return checkAddress(await brandOf(org.id, a.brand), a.address as string);
		},
	},
	{
		name: "list_archive",
		title: "Long-term archive files",
		description:
			"The organization's archived emails in R2 (when the archive is on: update_organization_settings), newest days first, each with a download link that works for a while.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			if (!archiveBucket()) return { available: false, files: [] };
			// The files are the emails as sent and received, digits and all.
			if (org.masked)
				throw new ApiError(
					403,
					"forbidden",
					"Archive files show codes and card numbers: that needs the «See codes and card numbers» permission",
				);
			const ids = a.brand
				? [await brandIn(org.id, a.brand as string)]
				: await brandIds(org.id);
			const names = await brandNames(ids);
			const lists = await Promise.all(
				ids.slice(0, 20).map((id) => listArchive(id, { limit: 60 })),
			);
			const files = lists
				.flatMap((l) => l.data)
				.sort((x, y) => y.day.localeCompare(x.day) || x.key.localeCompare(y.key))
				.slice(0, 100);
			return {
				available: true,
				files: await Promise.all(
					files.map(async (f) => ({
						...f,
						brand: names.get(f.brand_id) ?? f.brand_id,
						url: await archiveLink(f.key),
					})),
				),
			};
		},
	},
	{
		name: "get_insight_detail",
		title: "One template, tag or mailbox provider up close",
		description:
			"Insights for one thing (kind template: its id; tag: name:value; provider: gmail, outlook, yahoo, icloud or other) over `days`: sends, delivery, opens, clicks, bounces and complaints per day, time to inbox, and its worst bounces.",
		input: {
			organization,
			brand: z.string().optional(),
			kind: z.enum(KINDS),
			key: z.string().min(1).max(300),
			days: z.number().int().min(1).max(90).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const subject = parseSubject(a.kind as string, a.key as string);
			if (!subject) throw notFound("Insight");
			const scope = await scopeOf(org.id, a.brand);
			const [detail, title] = await Promise.all([
				insightDetail(scope, subject, (a.days as number | undefined) ?? 30),
				subjectTitle(scope, subject),
			]);
			return { ...detail, ...title, kind: a.kind, key: a.key };
		},
	},

	// ── Agent inboxes' setup ──
	{
		name: "get_inbox",
		title: "Get an agent inbox",
		description:
			"One agent inbox with its settings (reply from, send allow and block lists, retention), its credentials (name, permissions, reach, last use; never their tokens), its webhooks, its website chat and its recent activity.",
		input: { organization, inbox: z.string().describe("Its id or address") },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const { inbox } = await managedInbox(ctx, org, a.inbox as string);
			const [credentials, hooks, activity, chat] = await Promise.all([
				listCredentials(inbox),
				db.select().from(schema.webhooks).where(eq(schema.webhooks.inbox_id, inbox.id)),
				inboxActivity({ inboxId: inbox.id, limit: 50 }),
				import("../chat").then(async (m) => {
					const w = await m.getChatWidget(inbox.id);
					return w ? m.chatWidgetView(w) : null;
				}),
			]);
			return {
				...inboxView(inbox),
				retention_days: inbox.retention_days,
				credentials: credentials.map(credentialView),
				webhooks: hooks.map(({ secret: _s, ...h }) => h),
				chat,
				activity: activity.map(activityView),
			};
		},
	},
	{
		name: "update_inbox",
		title: "Change an agent inbox",
		description:
			"Changes an inbox's name, description, reply_from (what replies are sent from), send_allow / send_block (addresses or @domains replies may or may not go to; they apply to people approving drafts too) and retention_days (how long its conversations are kept; null: the deployment's default).",
		input: {
			organization,
			inbox: z.string(),
			name: z.string().min(1).max(100).optional(),
			description: z.string().max(1000).nullable().optional(),
			reply_from: z.string().nullable().optional(),
			send_allow: z.array(z.string()).nullable().optional(),
			send_block: z.array(z.string()).nullable().optional(),
			retention_days: z.number().int().min(1).max(3650).nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const { organization: _o, inbox: _i, ...fields } = a;
			const row = await updateInbox(
				inbox,
				Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
			);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.updated",
			});
			return inboxView(row);
		},
	},
	{
		name: "delete_inbox",
		title: "Delete an agent inbox",
		description:
			"Deletes an agent inbox: its credentials stop working and its address stops receiving. Confirm with the person first.",
		input: { organization, inbox: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			await deleteInbox(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.deleted",
				detail: { address: inbox.address },
			});
			return { deleted: inbox.id, address: inbox.address };
		},
	},
	{
		name: "update_inbox_credential",
		title: "Change or revoke an inbox credential",
		description:
			"Changes what an agent's credential may do: permissions (read, attachments, triage, draft, send), send_scope (replies: only people already in the conversation; anyone), scope (inbox, inboxes: inbox_ids, brand: every inbox of the brand). revoke: true stops it at once. New credentials and their tokens are made in the dashboard.",
		input: {
			organization,
			inbox: z.string(),
			credential: z.string(),
			permissions: z
				.array(z.enum(["read", "attachments", "triage", "draft", "send"]))
				.optional(),
			send_scope: z.enum(["replies", "anyone"]).optional(),
			scope: z.enum(["inbox", "inboxes", "brand"]).optional(),
			inbox_ids: z.array(z.string()).optional(),
			revoke: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const cred = await getCredential(inbox, a.credential as string);
			if (a.revoke) {
				const c = await revokeCredential(cred);
				await logInbox(actor, {
					brandId: inbox.organization_id,
					inboxId: inbox.id,
					action: "credential.revoked",
					detail: { credential_id: c.id },
				});
				return credentialView(c);
			}
			const { organization: _o, inbox: _i, credential: _c, revoke: _r, ...fields } = a;
			const c = await updateCredential(
				cred,
				Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
			);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.updated",
				detail: {
					credential_id: c.id,
					permissions: c.permissions,
					send_scope: c.send_scope,
				},
			});
			return credentialView(c);
		},
	},
	{
		name: "get_chat_widget",
		title: "An inbox's website chat",
		description:
			"The website chat widget of an inbox: on or off, the sites it may run on, its look and texts, the snippet to paste, and its stats. Null when the inbox has no chat.",
		input: { organization, inbox: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const { inbox } = await managedInbox(ctx, org, a.inbox as string);
			const chat = await import("../chat");
			const w = await chat.getChatWidget(inbox.id);
			if (!w) return null;
			return {
				...chat.chatWidgetView(w),
				stats: await chat.chatStats(inbox.id),
				design_defaults: chat.DESIGN_DEFAULTS,
			};
		},
	},
	{
		name: "save_chat_widget",
		title: "Turn on or change an inbox's website chat",
		description:
			'Turns on the website chat for an inbox (visitors chat on the site, the team answers from Mailroom or by email), or changes it. settings: enabled, origins (the sites it may run on), ask_email ("off" | "optional" | "required": asking visitors for their email), notify (who of the team gets the emails), email_team (true: email notify about visitor messages nobody read) with email_team_after (minutes, 1 by default, 0 right away), email_visitor (true: a visitor who left their email gets the team\'s answers they didn\'t see) with email_visitor_after (minutes, 3 by default, 0 right away), daily_limit, retention_days, identity_required (only visitors the site signed in; needs the identity secret, made in the dashboard or with scripts/connect-chat.sh, never shown here), and its design and texts (keys as get_chat_widget shows them, language "en" or "es" among them; allow_end: visitors may end the chat; ask_rating: a closed chat asks them for a 1-5 rating, kept as the conversation\'s CSAT; show_team: the header shows the last three people who answered; reply_time "text" (the subtitle) or "auto" (the usual reply time from the last 30 days); show_hours: outside the inbox workflow\'s business hours it says when you\'re back; topics: up to 8 buttons under the greeting, each { label, tag?, assignee? (a reader from list_assignees) }, that start the chat with their words, tag it and give it to someone; left out keep their value). Returns the snippet to paste.',
		input: {
			organization,
			inbox: z.string(),
			settings: z.record(z.string(), z.unknown()),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const chat = await import("../chat");
			const before = await chat.getChatWidget(inbox.id);
			const raw = a.settings as Record<string, unknown>;
			const settings =
				!before && raw.retention_days === undefined && inbox.retention_days == null
					? { ...raw, retention_days: 90 }
					: raw;
			const { widget, turnstile } = await chat.saveChatWidget(inbox, settings, {
				userId: ctx.userId,
				email: ctx.email,
			});
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: before ? "chat.updated" : "chat.created",
			});
			return { ...chat.chatWidgetView(widget), turnstile };
		},
	},
	{
		name: "delete_chat_widget",
		title: "Remove an inbox's website chat",
		description:
			"Removes the chat from an inbox (or with rotate_key: true, gives it a new public key instead: the old snippet stops working at once). Its conversations stay.",
		input: { organization, inbox: z.string(), rotate_key: z.boolean().optional() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:agents");
			const { actor, inbox } = await managedInbox(ctx, org, a.inbox as string);
			const chat = await import("../chat");
			if (a.rotate_key) {
				const row = await chat.rotateChatKey(inbox);
				await logInbox(actor, {
					brandId: inbox.organization_id,
					inboxId: inbox.id,
					action: "chat.key_rotated",
				});
				return chat.chatWidgetView(row);
			}
			await chat.deleteChatWidget(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "chat.deleted",
			});
			return { deleted: true };
		},
	},
	{
		name: "delete_conversation",
		title: "Delete a conversation now",
		description:
			"Deletes a conversation with its messages and files now, instead of when its retention ends. Confirm with the person first.",
		input: { organization, conversation: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:reply");
			const { deleteConversationNow } = await import("../chat");
			await deleteConversationNow(await personActor(org, ctx), a.conversation as string);
			return { deleted: a.conversation };
		},
	},

	// ── The organization's own SES account ──
	{
		name: "get_ses_account",
		title: "The organization's own SES account",
		description:
			"Whether the organization sends through its own Amazon SES account (optional) instead of the deployment's: account, region, status, a move between accounts in progress; for the deployment's admins, also its AWS costs.",
		input: {
			organization,
			check: z.boolean().optional().describe("Ask AWS now (default true)"),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const { ownAccountStatus, ownAccountCosts } = await import("../org-aws-manage");
			const status = await ownAccountStatus(org.id, { check: (a.check as boolean) ?? true });
			return {
				...status,
				costs: ctx.isAdmin ? await ownAccountCosts(org.id).catch(() => null) : undefined,
			};
		},
	},
	{
		name: "connect_ses_account",
		title: "Connect an organization's own SES account",
		description:
			"Deployment admins: connects (or replaces the keys of) an organization's own SES account, or with disconnect: true goes back to the deployment's, or with move check|cancel checks or cancels a move between accounts. Without domains it switches at once; with domains it starts a move that finishes once they verify there.",
		input: {
			organization,
			access_key_id: z.string().max(128).optional(),
			secret_access_key: z.string().max(256).optional(),
			region: z.string().max(32).optional(),
			disconnect: z.boolean().optional(),
			move: z.enum(["check", "cancel"]).optional(),
		},
		adminOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			adminOnly(ctx);
			const org = orgAt(ctx, a.organization);
			const m = await import("../org-aws-manage");
			if (a.disconnect) return m.disconnectOrgAws(org.id, ctx.userId);
			if (a.move === "cancel") return m.cancelMove(org.id);
			if (a.move === "check") {
				const move = await db
					.select()
					.from(schema.orgAwsMoves)
					.where(eq(schema.orgAwsMoves.organization_id, org.id))
					.get();
				if (move && (await m.checkMove(move))) await m.completeMove(org.id);
				return m.ownAccountStatus(org.id, { check: true });
			}
			if (!a.access_key_id || !a.secret_access_key || !a.region)
				throw new ApiError(
					422,
					"validation_error",
					"access_key_id, secret_access_key and region are required",
				);
			return m.connectOrgAws(
				org.id,
				{
					accessKeyId: a.access_key_id as string,
					secretAccessKey: a.secret_access_key as string,
					region: a.region as string,
				},
				ctx.userId,
			);
		},
	},

	// ── The deployment (admins) ──
	{
		name: "set_sending_limits",
		title: "Set the deployment's sending limits",
		description:
			"Deployment admins: the bounce and complaint rates (per stream: transactional, marketing) at which Mailroom alerts or pauses an organization, or with organization + transactional/marketing (alert|pause|null for the default) what they do to one organization. get_organization_settings shows them.",
		input: {
			limits: z.record(z.string(), z.unknown()).optional(),
			organization: z.string().optional(),
			transactional: z.enum(["alert", "pause"]).nullable().optional(),
			marketing: z.enum(["alert", "pause"]).nullable().optional(),
		},
		adminOnly: true,
		run: async (a, ctx) => {
			adminOnly(ctx);
			const m = await import("../sending-limits");
			const out: Record<string, unknown> = {};
			if (a.limits) out.limits = await m.setSendingLimits(a.limits);
			if (a.transactional !== undefined || a.marketing !== undefined) {
				const org = orgAt(ctx, a.organization);
				out.organization = await m.setOrganizationActions(org.id, {
					transactional: a.transactional as never,
					marketing: a.marketing as never,
				});
			}
			return out;
		},
	},
	{
		name: "gmail_postmaster",
		title: "Gmail Postmaster Tools",
		description:
			"Deployment admins: whether Google Postmaster Tools is connected (Gmail's reputation and spam rate per domain, shown in get_insights). action sync registers, verifies and reads every domain now; disconnect stops it; connect returns the Google page to open in a browser.",
		input: { action: z.enum(["status", "sync", "disconnect", "connect"]).optional() },
		adminOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			adminOnly(ctx);
			const p = await import("../postmaster");
			if (a.action === "connect") return { url: await p.connectUrl() };
			if (a.action === "sync") await p.syncPostmaster();
			if (a.action === "disconnect") await p.disconnect();
			return p.connection();
		},
	},
	{
		name: "aws_account",
		title: "The deployment's AWS account",
		description:
			"Deployment admins: action costs asks Cost Explorer again now (the month's SES, S3 and other AWS costs, split per organization); set_up creates or repairs what Mailroom needs in the AWS account (SNS topic, receiving rules, IAM). account_overview shows the rest.",
		input: { action: z.enum(["costs", "set_up"]) },
		adminOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			adminOnly(ctx);
			if (a.action === "set_up") {
				const { setUpAccount } = await import("../provision");
				return setUpAccount();
			}
			const { awsCosts } = await import("../costs");
			const costs = await awsCosts({ force: true });
			const { costByOrganization } = await import("../cost-split");
			return { costs, by_organization: await costByOrganization(costs).catch(() => null) };
		},
	},
	...WORKFLOW_TOOLS,
];
