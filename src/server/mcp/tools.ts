import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { checkContent } from "../../lib/content-check";
import { EMAIL_FILTERS } from "../../lib/email-status";
import type { LogoChoice } from "../../lib/email-templates";
import type { Access, Permission } from "../../lib/permissions";
import { maskDigits, maskHeaders } from "../../lib/roles";
import { accessColumns, accessFromRow, roleJoin } from "../access";
import { logAccess } from "../access-log";
import { deleteKey } from "../api-keys";
import {
	automationRuns,
	automationView,
	createAutomation,
	getAutomation,
	listAutomations,
	recordEvent,
	updateAutomation,
} from "../automations";
import {
	brandIds,
	brandIn,
	createBrand,
	getBrand,
	listBrands,
	renameBrand,
	sendingStatus,
	setBrandPaused,
} from "../brands";
import { broadcastReport } from "../broadcast-report";
import {
	audienceSize,
	broadcastStats,
	broadcastView,
	cancelBroadcast,
	createBroadcast,
	getBroadcast,
	listBroadcasts,
	runBroadcasts,
	sendBroadcast,
	updateBroadcast,
	variantStats,
} from "../broadcasts";
import {
	contactView,
	createSegment,
	createTopic,
	deleteContact,
	getContact,
	listContacts,
	listSegments,
	listTopics,
	segmentView,
	topicsOfContact,
	topicView,
	upsertContact,
} from "../contacts";
import { db, schema } from "../db";
import { checkDomainHealth, healthView } from "../deliverability";
import { kickDispatcher, rateGate } from "../dispatcher";
import { dmarcSummary } from "../dmarc-reports";
import { baseUrl } from "../env";
import { ApiError, notFound, validation } from "../errors";
import { getFirewall, setFirewall } from "../firewall";
import {
	getReceived,
	inboundAddresses,
	listReceived,
	parsedMessage,
	RECEIVING_PREFIX_RE,
	receivedView,
	receivingStatus,
	setDomainReceiving,
	setInboundAddress,
	setUpReceiving,
} from "../inbound";
import { createRule, deleteRule, getRule, listRules, ruleView, updateRule } from "../inbound-rules";
import { createInbox, inboxView, logInbox } from "../inboxes";
import { statsByStream, statsByTag, statsByTemplate, timeToInbox } from "../insights";
import { lookupRecipient } from "../lookup";
import { getNewsletter, webUrl } from "../newsletters";
import { orgLogos, setOrgLogo, setOrgLogoBackground, svgDataUrl } from "../org-logos";
import { pollResults } from "../polls";
import { postmasterView } from "../postmaster";
import {
	accountStatus,
	addDomain,
	removeDomain,
	setBimiLogo,
	setUpOrganization,
	verifyDomain,
} from "../provision";
import {
	dailyStats,
	emailEvents,
	getEmail,
	inScope,
	listEmails,
	listSuppressions,
	SUPPRESSION_REASONS,
	statsByOrganization,
	suppressionCounts,
} from "../queries";
import { approvalRequired, contentHash } from "../reviews";
import { brandForSend, createEmails, parseSend, storedContent } from "../send";
import { starterFor, starterList } from "../starter-designs";
import { addSuppression, removeSuppression } from "../suppressions";
import {
	applyTemplate,
	createTemplate,
	deleteTemplate,
	getTemplate,
	listTemplates,
	publishTemplate,
	templateView,
	updateTemplate,
} from "../templates";
import { testReport } from "../test-report";
import {
	addTrackingHost,
	checkTrackingHost,
	customTrackingConfigured,
	removeTrackingHost,
	TRACKING_PREFIX,
} from "../tracking";
import { listUnsubscribes, resubscribe, unsubscribeGroups } from "../unsubscribes";
import { recordVersion, snapshotOf } from "../versions";
import { createWebhook, deleteWebhook, updateWebhook } from "../webhook-admin";
import { INBOX_EVENTS, replayFailed, sendTestEvent, WEBHOOK_EVENTS } from "../webhooks";
import { INBOX_TOOLS, personActor } from "./inbox-tools";
import {
	brand,
	brandOf,
	DESIGN_HELP,
	domainOf,
	domainView,
	logged,
	oneBrand,
	orgAt,
	organization,
	requires,
	scopeOf,
	type Tool,
} from "./kit";
import { AUDIENCE_TOOLS } from "./tools-audience";
import { CALENDAR_TOOLS } from "./tools-calendar";
import { CONTENT_TOOLS } from "./tools-content";
import { HELP_TOOLS } from "./tools-help";
import { LEAD_TOOLS } from "./tools-leads";
import { NOTE_TOOLS } from "./tools-notes";
import { PERSON_TOOLS } from "./tools-person";
import { SEARCH_TOOLS } from "./tools-search";
import { SETTINGS_TOOLS } from "./tools-settings";
import { SURVEY_TOOLS } from "./tools-surveys";
import { TEAM_TOOLS } from "./tools-team";
import { TODAY_TOOLS } from "./tools-today";

/** Who is calling: the person behind the connection, read again on every call. */
export interface McpContext {
	userId: string;
	email: string;
	/** One of the deployment's admins (ADMIN_EMAILS). */
	isAdmin: boolean;
	organizations: Membership[];
	/** The tool being run (what it needs is TOOL_NEEDS). */
	tool?: string;
}

export interface Membership {
	id: string;
	name: string;
	slug: string;
	role: string;
	access: Access;
	/** Sees runs of 4+ digits in emails as dots. */
	masked: boolean;
}

export async function memberships(userId: string): Promise<Membership[]> {
	const rows = await db
		.select({
			id: schema.organization.id,
			name: schema.organization.name,
			slug: schema.organization.slug,
			...accessColumns,
		})
		.from(schema.member)
		.innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
		.leftJoin(schema.organizationRole, roleJoin)
		.where(eq(schema.member.userId, userId))
		.orderBy(schema.organization.name);
	return rows.map((r) => {
		const access = accessFromRow(r);
		return {
			id: r.id,
			name: r.name,
			slug: r.slug,
			role: r.role,
			access,
			masked: !access.can("emails:unmasked"),
		};
	});
}

/** What each tool that changes something needs (src/lib/permissions.ts). */
const TOOL_NEEDS: Record<string, Permission> = {
	create_brand: "brands:edit",
	update_brand: "brands:edit",
	update_unsubscribe_page: "brands:edit",
	set_domain_receiving: "domains:manage",
	set_up_sending: "domains:manage",
	add_domain: "domains:manage",
	delete_domain: "domains:manage",
	set_tracking_domain: "domains:manage",
	set_bimi_logo: "domains:manage",
	set_organization_logo: "settings:manage",
	list_api_keys: "developers:keys",
	delete_api_key: "developers:keys",
	list_webhooks: "developers:webhooks",
	create_webhook: "developers:webhooks",
	update_webhook: "developers:webhooks",
	delete_webhook: "developers:webhooks",
	test_webhook: "developers:webhooks",
	replay_failed_webhooks: "developers:webhooks",
	add_suppression: "recipients:block",
	update_firewall: "recipients:block",
	remove_suppression: "recipients:unblock",
	remove_unsubscribe: "recipients:unblock",
	save_template: "templates:edit",
	publish_template: "templates:edit",
	delete_template: "templates:edit",
	save_contact: "contacts:edit",
	create_segment: "contacts:edit",
	delete_contact: "contacts:delete",
	save_broadcast: "broadcasts:edit",
	send_broadcast: "broadcasts:send",
	// One email to anyone, from the organization's domains: as much a send as a broadcast.
	send_email: "broadcasts:send",
	cancel_broadcast: "broadcasts:send",
	save_automation: "automations:edit",
	send_event: "automations:edit",
	save_inbound_rule: "inbox:rules",
	delete_inbound_rule: "inbox:rules",
	create_inbox: "inbox:agents",
};

/** The organization a call names, and whether the person may do what it needs there. */
function orgFor(ctx: McpContext, ref: unknown, need: "member" | "manage" | "support" = "member") {
	if (need === "member") return orgAt(ctx, ref);
	// A tool that changes something and isn't in TOOL_NEEDS is for owners only.
	const p = ctx.tool ? TOOL_NEEDS[ctx.tool] : undefined;
	return orgAt(ctx, ref, p ?? "owner");
}

const events = z.array(z.enum(WEBHOOK_EVENTS)).optional();

/** Starting an email's design from one of Mailroom's ready-made designs. */
const STARTER_INPUT = {
	starter: z
		.string()
		.optional()
		.describe(
			"A ready-made design's id (list_starter_designs), made for the brand: its logo, name and brand kit. Replaces `design`; change its words with a later save.",
		),
	starter_logo: z
		.enum(["off", "original", "rounded", "circle"])
		.optional()
		.describe("How the starter shows the brand's logo (default original: as it is)."),
	brand_colors: z
		.boolean()
		.optional()
		.describe("false: keep the starter's own colors instead of the brand kit's."),
};

export const TOOLS: Tool[] = [
	{
		name: "list_organizations",
		title: "List organizations",
		description:
			"The organizations (businesses) you belong to, with your role and whether each is set up to send.",
		input: {},
		readOnly: true,
		run: async (_args, ctx) => ({
			you: { email: ctx.email, deployment_admin: ctx.isAdmin },
			organizations: await Promise.all(
				ctx.organizations.map(async ({ access, masked: _, ...o }) => {
					const brands = await listBrands(o.id);
					return {
						...o,
						permissions: access.summary().permissions,
						// Its own brand's: whether it can send without naming another.
						sending: brands[0]?.sending ?? "not_set_up",
						brands: brands.map((b) => ({
							id: b.id,
							name: b.name,
							default: b.default,
							sending: b.sending,
							paused: b.paused,
						})),
					};
				}),
			),
		}),
	},
	{
		name: "list_brands",
		title: "List brands",
		description:
			"The organization's brands: who its emails are from (Harbor Inn, Seaside Hotel…), each its own SES tenant with its own domains, suppressions and reputation. The first is the organization's own.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => listBrands(orgFor(ctx, a.organization).id),
	},
	{
		name: "create_brand",
		title: "Create a brand",
		description:
			"Adds a brand to the organization (its own SES tenant is set up at once). With external_id an existing one is returned instead of a second.",
		input: {
			organization,
			name: z.string().trim().min(1).max(80),
			external_id: z.string().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return (
				await createBrand(org.id, {
					name: a.name as string,
					externalId: a.external_id as string | undefined,
				})
			).brand;
		},
	},
	{
		name: "update_brand",
		title: "Rename, pause or resume a brand",
		description:
			"Renames a brand, or pauses it (its sends are refused, its queue waits) or resumes it.",
		input: {
			organization,
			brand: z.string(),
			name: z.string().optional(),
			paused: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const id = await brandIn(org.id, a.brand as string);
			if (a.name) await renameBrand(org.id, id, a.name as string);
			if (a.paused !== undefined)
				await setBrandPaused(org.id, id, a.paused as boolean, { isAdmin: ctx.isAdmin });
			return getBrand(org.id, id);
		},
	},
	{
		name: "get_unsubscribe_page",
		title: "A brand's unsubscribe page",
		description:
			"How a brand's unsubscribe and preferences page looks and what it says (what people see after an email's unsubscribe link): logo, colors, fonts, shape, its lines and the link under it. saved: false means it still has the defaults.",
		input: { organization, brand: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const id = await brandIn(org.id, a.brand as string);
			const { getSubscriberPage } = await import("../subscriber-pages");
			const { PAGE_TEXTS } = await import("../../lib/subscriber-page");
			const r = await getSubscriberPage(id);
			return {
				...r,
				default_texts: Object.fromEntries(
					Object.entries(PAGE_TEXTS).map(([k, v]) => [k, { en: v.en, es: v.es }]),
				),
			};
		},
	},
	{
		name: "update_unsubscribe_page",
		title: "Customize a brand's unsubscribe page",
		description:
			'Changes a brand\'s unsubscribe and preferences page; only the fields given change (texts merge, an empty text goes back to the default). reset: true goes back to the defaults. Fields: logo ("brand", "none" or an https:// image), logo_shape (original|rounded|circle), logo_size (small|medium|large), align (center|left), theme (auto|light|dark), background, card, text, accent (#rrggbb; accent null = the brand kit\'s), font and heading_font (system, inter, dm-sans, space-grotesk, fraunces, playfair, lora, georgia, mono, geist, instrument-sans, bricolage, jost, instrument-serif, newsreader, cormorant), corners (square|soft|round), borders (true: thin line, false: shadow), layout (card|plain|banner|split), mark above the heading (eyebrow: a small title, icon, none), heading_size (md|lg), language (auto|en|es), texts { eyebrow, ask, who, out, done, sorry, back, backDone, backBody, prefs, save, saved, tagline, taglineBody (on the side of the split layout) } where {name} is the brand and {email} the reader, resubscribe (offer "Subscribe again"), link { label, url } or null, footer.',
		input: {
			organization,
			brand: z.string(),
			reset: z.boolean().optional(),
			template: z
				.enum(["classic", "editorial", "studio", "bold", "boutique", "minimal", "midnight"])
				.optional()
				.describe(
					"A ready-made look to put on first (keeps the logo, accent, words and links): classic (calm, crisp card), editorial (masthead and big serif type), studio (brand color down one side with a big line), bold (big band in the brand color), boutique (sand and fine serif, quiet luxury), minimal (just the words), midnight (dark with a soft glow)",
				),
			page: z
				.record(z.string(), z.unknown())
				.optional()
				.describe("The fields to change (see the description)"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const id = await brandIn(org.id, a.brand as string);
			const { getSubscriberPage, resetSubscriberPage, saveSubscriberPage } = await import(
				"../subscriber-pages"
			);
			if (a.reset) {
				await resetSubscriberPage(id);
				return getSubscriberPage(id);
			}
			const { withTemplate } = await import("../../lib/subscriber-page");
			const current = (await getSubscriberPage(id)).page;
			const page = a.template ? withTemplate(current, a.template as string) : current;
			const patch = (a.page ?? {}) as Record<string, unknown>;
			const texts =
				patch.texts && typeof patch.texts === "object"
					? { ...page.texts, ...(patch.texts as Record<string, unknown>) }
					: page.texts;
			const saved = await saveSubscriberPage(
				id,
				{ ...page, ...patch, texts },
				ctx.userId ?? null,
			);
			return { page: saved, saved: true };
		},
	},
	{
		name: "get_stats",
		title: "Sending stats",
		description:
			"An organization's daily counters (sent, delivered, bounced, complained, opened, clicked) and its bounce and complaint rates against SES's limits (review at 5% / 0.1%, pause at 10% / 0.5%).",
		input: { organization, brand, days: z.number().int().min(1).max(90).optional() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const days = (a.days as number | undefined) ?? 7;
			const scope = await scopeOf(org.id, a.brand);
			const s = await dailyStats(scope, days);
			return {
				organization: org.slug,
				totals: s.totals,
				health: s.health,
				days: s.series,
				...(typeof scope === "string"
					? {}
					: { by_brand: await statsByOrganization(days, Date.now(), scope) }),
			};
		},
	},
	{
		name: "get_insights",
		title: "Insights",
		description:
			"How each kind of email does over the last days: transactional and marketing domains apart, each template and each tag (sent, delivered, bounce, complaint, open and click rates), and time to inbox (seconds from SES to the recipient's server: typical, 1 in 10, 1 in 100) per mailbox provider, and Gmail Postmaster Tools per sending domain (Gmail's spam rate, DMARC/TLS rates, bulk-sender compliance) when connected.",
		input: { organization, brand, days: z.number().int().min(1).max(90).optional() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const days = (a.days as number | undefined) ?? 30;
			const scope = await scopeOf(org.id, a.brand);
			const now = Date.now();
			const ids = typeof scope === "string" ? [scope] : await brandIds(org.id);
			const [by_stream, by_template, by_tag, time_to_inbox, gmail] = await Promise.all([
				statsByStream(scope, days, now),
				statsByTemplate(scope, days, now),
				statsByTag(scope, days, now),
				timeToInbox(scope, days, now),
				postmasterView(ids, days, now),
			]);
			return {
				organization: org.slug,
				days,
				by_stream,
				by_template,
				by_tag,
				time_to_inbox,
				gmail_postmaster: gmail.map(({ series, ...g }) => g),
			};
		},
	},
	{
		name: "get_revenue",
		title: "Revenue and what earned it",
		description:
			"Purchases (events sent with a value) over the last days: totals per currency and how much was credited to email and chat (the last broadcast or automation email the person opened or clicked, or website chat they wrote in, within 7 days), then in the main currency: by kind of credit, the top broadcasts, automations and campaigns, day by day, and the latest 20 purchases.",
		input: { organization, brand, days: z.number().int().min(1).max(365).optional() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const scope = await scopeOf(org.id, a.brand);
			const ids = typeof scope === "string" ? [scope] : await brandIds(org.id);
			const { revenueReport } = await import("../revenue");
			const r = await revenueReport(ids, (a.days as number | undefined) ?? 30);
			return org.masked
				? { ...r, latest: r.latest.map((l) => ({ ...l, email: maskDigits(l.email) })) }
				: r;
		},
	},
	{
		name: "account_overview",
		title: "AWS account overview",
		description:
			"The whole SES account: its quota and use, sending status, the SNS events setup, and each organization's last 7 days.",
		input: {},
		readOnly: true,
		adminOnly: true,
		run: async () => {
			const [status, byOrg] = await Promise.all([accountStatus(), statsByOrganization(7)]);
			return { account: status, organizations_last_7_days: byOrg };
		},
	},
	{
		name: "receiving_status",
		title: "Receiving setup",
		description:
			"Whether the account is set up to receive email: the S3 drop box, the receipt rule set, the R2 storage binding, and the Mailroom address domain with the DNS records it still needs.",
		input: {},
		readOnly: true,
		adminOnly: true,
		run: () => receivingStatus(),
	},
	{
		name: "set_up_receiving",
		title: "Set up receiving",
		description:
			"Sets the AWS account up to receive email (Admin › Receiving › Set up receiving): the S3 drop box, SNS permission, the receipt rule set and the Mailroom address domain. Safe to run again; returns the DNS records to add.",
		input: {},
		adminOnly: true,
		run: async () => {
			await setUpReceiving();
			return receivingStatus();
		},
	},
	{
		name: "create_organization",
		title: "Create an organization",
		description:
			"Creates an organization (one business) with you as its owner. Then run set_up_sending for it and add its domains.",
		input: {
			name: z.string().trim().min(1).max(80),
			slug: z
				.string()
				.regex(/^[a-z0-9-]+$/)
				.max(48)
				.describe("Lowercase letters, digits and dashes, e.g. harbor-inn"),
		},
		adminOnly: true,
		run: async (a, ctx) => {
			const { auth } = await import("../auth");
			const org = await auth().api.createOrganization({
				body: { name: a.name as string, slug: a.slug as string, userId: ctx.userId },
			});
			if (!org) throw new ApiError(422, "validation_error", "Not created");
			return { id: org.id, name: org.name, slug: org.slug, role: "owner" };
		},
	},
	{
		name: "list_emails",
		title: "List emails",
		description:
			"An organization's emails, newest first (each with its brand's id as organization_id). Filter by brand, status (failed = never reached a mail server; soft_bounced = the receiving server gave up for now, address fine; bounced = hard bounce, suppressed; suppressed = not sent; not_delivered = all four; firewall / unsubscribed = recipients left out by those), day (YYYY-MM-DD), sending domain or mailbox provider, the API key that sent it (api_key_id, from list_api_keys) or a tag (`name:value`, or `name` for any value), or search a recipient, the subject's start or an id. Page with `after` (the last id).",
		input: {
			organization,
			brand,
			status: z.enum(EMAIL_FILTERS).optional(),
			day: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),
			domain: z.string().optional(),
			provider: z.enum(["gmail", "outlook", "yahoo", "icloud", "other"]).optional(),
			search: z.string().optional(),
			api_key_id: z.string().optional(),
			tag: z.string().optional(),
			after: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const page = await listEmails(await scopeOf(org.id, a.brand), {
				masked: org.masked,
				status: a.status as never,
				day: a.day as string | undefined,
				domain: a.domain as string | undefined,
				provider: a.provider as never,
				search: a.search as string | undefined,
				apiKeyId: a.api_key_id as string | undefined,
				tag: a.tag as string | undefined,
				after: a.after as string | undefined,
				limit: (a.limit as number | undefined) ?? 25,
			});
			// As the dashboard shows them: digits as dots without "see emails unmasked".
			return org.masked
				? {
						...page,
						data: page.data.map((e) => ({ ...e, subject: maskDigits(e.subject) })),
					}
				: page;
		},
	},
	{
		name: "get_email",
		title: "Get an email",
		description:
			"One email with its timeline (sent, delivered, opened, bounced…). content: true adds its text, HTML, headers and attachments' names while Mailroom still keeps its body.",
		input: { organization, id: z.string(), content: z.boolean().optional() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const row = await getEmail({ org: org.id }, a.id as string);
			if (!row) throw notFound("Email");
			const evs = await emailEvents(row.id);
			const { idempotency_key: _k, request_hash: _h, locked_until: _l, ...rest } = row;
			let content: Record<string, unknown> | undefined;
			if (a.content) {
				const stored = await storedContent(row.id);
				const html = stored?.content.html ?? null;
				const text = stored?.content.text ?? null;
				content = {
					kept: !!stored,
					text: org.masked && text ? maskDigits(text) : text,
					html:
						org.masked && html
							? html.replace(/>([^<]+)</g, (_, t: string) => `>${maskDigits(t)}<`)
							: html,
					headers: stored?.content.headers ?? null,
					attachments: (stored?.attachments ?? []).map((x) => ({
						filename: x.filename,
						size: x.size,
					})),
				};
			}
			return {
				...rest,
				...(org.masked ? { subject: maskDigits(row.subject) } : {}),
				...(content ? { content } : {}),
				events: evs.map((e) => ({
					type: e.type,
					at: e.at,
					recipient: e.recipient,
					data: e.data,
				})),
			};
		},
	},
	{
		name: "list_received_emails",
		title: "List received emails",
		description:
			"Emails an organization's brands received (at a domain with receiving on, or a brand's Mailroom address), newest first: from, to, subject, attachments and SES's spam, virus, SPF, DKIM and DMARC verdicts. Filter by brand or domain (its name, or `mailroom` for the Mailroom addresses), or search an address, the subject's start or an id. Page with `after` (the last id).",
		input: {
			organization,
			brand,
			domain: z.string().optional(),
			search: z.string().optional(),
			after: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const page = await listReceived(await scopeOf(org.id, a.brand), {
				masked: org.masked,
				domain: a.domain as string | undefined,
				search: a.search as string | undefined,
				after: a.after as string | undefined,
				limit: (a.limit as number | undefined) ?? 25,
			});
			const dots = org.masked;
			return {
				has_more: page.has_more,
				data: await Promise.all(
					page.data.map(async (r) => {
						const v = await receivedView(r, false);
						return dots ? { ...v, subject: maskDigits(v.subject) } : v;
					}),
				),
			};
		},
	},
	{
		name: "get_received_email",
		title: "Get a received email",
		description:
			"One received email with its text, HTML and headers, its attachments (names, types, sizes) and SES's verdicts.",
		input: { organization, id: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const row = await getReceived({ org: org.id }, a.id as string);
			if (!row) throw notFound("Email");
			const v = await receivedView(row);
			if (!org.masked) return v;
			return {
				...v,
				headers: maskHeaders(v.headers),
				subject: maskDigits(v.subject),
				text: v.text ? maskDigits(v.text) : v.text,
				html: v.html
					? v.html.replace(/>([^<]+)</g, (_, t: string) => `>${maskDigits(t)}<`)
					: v.html,
			};
		},
	},
	{
		name: "received_email_report",
		title: "Deliverability report of a received email",
		description:
			"How mailbox providers see a received email, mail-tester style, scored out of 10: SPF, DKIM and DMARC (and their alignment with From), the DMARC policy, spam and virus verdicts, one-click unsubscribe, Message-ID, plain-text part, links, images and content checks. Send an email to a brand's Mailroom address (get_mailroom_address) to test it.",
		input: { organization, id: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const row = await getReceived({ org: org.id }, a.id as string);
			if (!row) throw notFound("Email");
			return testReport({
				from: row.from,
				subject: row.subject,
				verdicts: {
					spam: row.spam,
					virus: row.virus,
					spf: row.spf,
					dkim: row.dkim,
					dmarc: row.dmarc,
				},
				parsed: await parsedMessage(row).catch(() => null),
			});
		},
	},
	{
		name: "set_domain_receiving",
		title: "Turn receiving on or off for a domain",
		description:
			"Mailroom receives every email to <prefix>.<domain> (reply.<domain> unless `prefix` says otherwise; \"\" for the domain itself), through SES: its emails show in list_received_emails and go to webhooks as email.received. Returns the domain with the MX record to create (the Receiving record). Refused when that host's MX already sends its mail to a mailbox (Google Workspace, Outlook…), since SES's MX would take that mail: keep a prefix, or pass replace_mx: true after the person confirms. A brand also always has its Mailroom address (see get_mailroom_address).",
		input: {
			organization,
			domain: z.string().describe("The domain's name or id"),
			on: z.boolean(),
			prefix: z
				.union([z.string().regex(RECEIVING_PREFIX_RE), z.literal("")])
				.optional()
				.describe('One word, like reply (the default) or inbox; "" for the domain itself'),
			replace_mx: z.boolean().optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const d = await domainOf(org.id, a.domain as string);
			await setDomainReceiving(d.organization_id, d.id, a.on as boolean, {
				replaceMx: a.replace_mx as boolean | undefined,
				prefix: a.prefix as string | undefined,
			});
			const fresh = await domainOf(org.id, d.id);
			return domainView(fresh);
		},
	},
	{
		name: "get_mailroom_address",
		title: "A brand's Mailroom address",
		description:
			"The address a brand receives email at: its own on one of its receiving domains when set_inbound_address picked one, otherwise <brand slug>@<the deployment's inbound domain> (which always works; anything after a + also reaches it), or null when there's neither.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const x = await inboundAddresses(await brandOf(org.id, a.brand));
			return { address: x.own ?? x.fallback, own: x.own, default: x.fallback };
		},
	},
	{
		name: "set_inbound_address",
		title: "Set a brand's own inbound address",
		description:
			"Makes an address on one of the brand's receiving domains (see set_domain_receiving) its inbound address, shown instead of <brand slug>@<the deployment's inbound domain>, which keeps working. `address` null goes back to the default.",
		input: {
			organization,
			brand: oneBrand,
			address: z
				.string()
				.max(254)
				.nullable()
				.describe("Like inbox@reply.example.com, or null"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return setInboundAddress(
				await brandOf(org.id, a.brand),
				(a.address as string | null) ?? null,
			);
		},
	},
	{
		name: "send_email",
		title: "Send an email",
		description:
			"Sends one email from an organization (from an address on one of its brands' verified domains; the domain picks the brand). For tests and one-off messages; apps use the API.",
		input: {
			organization,
			brand,
			from: z
				.string()
				.optional()
				.describe(
					'e.g. "Acme <hello@mail.acme.com>" (optional with a template that has one)',
				),
			to: z.array(z.string()).min(1).max(50),
			cc: z.array(z.string()).max(50).optional(),
			bcc: z.array(z.string()).max(50).optional(),
			subject: z.string().optional(),
			text: z.string().optional(),
			html: z.string().optional(),
			scheduled_at: z
				.string()
				.optional()
				.describe("ISO 8601, up to 30 days ahead; cancel_email cancels it before then"),
			tags: z
				.array(z.object({ name: z.string(), value: z.string() }))
				.max(40)
				.optional()
				.describe("Labels to filter by later (letters, numbers, _ and -)"),
			headers: z.record(z.string(), z.string()).optional(),
			attachments: z
				.array(
					z.object({
						filename: z.string(),
						content: z.string().optional().describe("base64"),
						path: z.string().optional().describe("A public URL to fetch it from"),
						content_type: z.string().optional(),
					}),
				)
				.max(30)
				.optional(),
			sandbox: z
				.boolean()
				.optional()
				.describe("Run every check and answer what would happen, without sending"),
			template: z
				.string()
				.optional()
				.describe("A published template's id or alias, instead of html and text"),
			variables: z
				.record(z.string(), z.union([z.string(), z.number()]))
				.optional()
				.describe('The template\'s variables, e.g. { NAME: "Ana" }'),
			reply_to: z.string().optional(),
			unsubscribe_group: z
				.string()
				.optional()
				.describe(
					"An id of yours (e.g. a customer's id): adds a one-click unsubscribe link and skips addresses that left this group",
				),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const input = parseSend(
				await applyTemplate(org.id, {
					from: a.from,
					to: a.to,
					cc: a.cc,
					bcc: a.bcc,
					subject: a.subject,
					text: a.text,
					html: a.html,
					scheduled_at: a.scheduled_at,
					tags: a.tags,
					headers: a.headers,
					attachments: a.attachments,
					sandbox: a.sandbox,
					reply_to: a.reply_to,
					unsubscribe_group: a.unsubscribe_group,
					brand: a.brand,
					...(a.template ? { template: { id: a.template, variables: a.variables } } : {}),
				}),
			);
			const [r] = await createEmails(await brandForSend(org.id, [input]), [input], {
				source: "mcp",
				kick: kickDispatcher,
				gate: rateGate,
				sandbox: input.sandbox,
			});
			if (r?.error) throw r.error;
			if (r && "sandbox" in r && r.sandbox) return { sandbox: true, would_send: r.sandbox };
			return { id: r?.id ?? null, status: r?.status ?? null };
		},
	},
	{
		name: "set_up_sending",
		title: "Set up sending",
		description:
			"Creates (or repairs) a brand's SES tenants and configuration sets (the organization's own brand without `brand`). Safe to run again.",
		input: { organization, brand },
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return setUpOrganization(await brandOf(org.id, a.brand));
		},
	},
	{
		name: "list_domains",
		title: "List domains",
		description:
			"The organization's sending domains (each with its brand_id and purpose), their status and the DNS records each needs.",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const rows = await db
				.select()
				.from(schema.domains)
				.where(inScope(schema.domains.organization_id, await scopeOf(org.id, a.brand)))
				.orderBy(desc(schema.domains.created_at));
			return rows.map(domainView);
		},
	},
	{
		name: "add_domain",
		title: "Add a domain",
		description:
			"Adds a domain to a brand, to send from (the default), receive at, or both (a subdomain like mail.example.com is best) and returns the DNS records to create: DKIM, and for sending the bounce MAIL FROM (MX and SPF) and DMARC; for receiving its MX. purpose marketing (newsletters) sends through the brand's second tenant with a one-click unsubscribe. Receiving is refused when the domain's MX already goes to a mailbox, unless replace_mx after the person confirms.",
		input: {
			organization,
			brand,
			name: z.string(),
			purpose: z.enum(["transactional", "marketing"]).optional(),
			sending: z.boolean().optional().describe("Brands send from it (default true)"),
			receiving: z.boolean().optional().describe("Mailroom receives its email"),
			replace_mx: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const { id } = await addDomain(
				await brandOf(org.id, a.brand),
				a.name as string,
				a.purpose as "transactional" | "marketing" | undefined,
				{
					sending: a.sending as boolean | undefined,
					receiving: a.receiving as boolean | undefined,
					replaceMx: a.replace_mx as boolean | undefined,
				},
			);
			return domainView(await domainOf(org.id, id));
		},
	},
	{
		name: "verify_domain",
		title: "Check a domain",
		description:
			"Asks SES again whether the domain's DNS records are in place (and Cloudflare whether its tracking domain is live).",
		input: { organization, domain: z.string().describe("The domain's name or id") },
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const d = await domainOf(org.id, a.domain as string);
			const v = await verifyDomain(d.organization_id, d.id);
			if (
				v.tracking_hostname_id &&
				v.tracking_status !== "active" &&
				customTrackingConfigured()
			)
				await checkTrackingHost(d.organization_id, d.id).catch(() => null);
			return domainView(await domainOf(org.id, d.id));
		},
	},
	{
		name: "delete_domain",
		title: "Delete a domain",
		description:
			"Removes a sending domain, as the dashboard does: it leaves its brand's SES tenant (its SES identity is deleted when Mailroom created it), its tracking domain stops, and nothing can send from it any more. Its DNS records stay where they are.",
		input: { organization, domain: z.string().describe("The domain's name or id") },
		destructive: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const d = await domainOf(org.id, a.domain as string);
			await removeDomain(d.organization_id, d.id);
			return { deleted: d.id, name: d.name };
		},
	},
	{
		name: "set_tracking_domain",
		title: "Set a domain's tracking domain",
		description:
			"Serves the domain's open and click tracking from <prefix>.<domain> (links.<domain> unless `prefix` says otherwise) instead of Mailroom's own address, and returns the CNAME to create (the Tracking record). remove: true goes back to Mailroom's address.",
		input: {
			organization,
			domain: z.string().describe("The domain's name or id"),
			prefix: z
				.string()
				.regex(TRACKING_PREFIX)
				.optional()
				.describe("One word, like links (the default), track or go"),
			remove: z.boolean().optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const d = await domainOf(org.id, a.domain as string);
			const host = `${(a.prefix as string | undefined) ?? "links"}.${d.name}`;
			// Another prefix than the one it has: the old host goes first.
			if (a.remove || (d.tracking_host && d.tracking_host !== host))
				await removeTrackingHost(d.organization_id, d.id);
			if (!a.remove) await addTrackingHost(d.organization_id, d.id, a.prefix as string);
			return domainView(await domainOf(org.id, d.id));
		},
	},
	{
		name: "set_bimi_logo",
		title: "Set a domain's brand logo (BIMI)",
		description:
			"Sets the logo mailboxes that support BIMI show next to the domain's emails, from an SVG's text (square; Mailroom makes it SVG Tiny PS and titles it with the brand's name), or removes it with svg: null. Returns the domain with its BIMI record and the stricter DMARC record (p=quarantine) BIMI needs, to create in DNS.",
		input: {
			organization,
			domain: z.string().describe("The domain's name or id"),
			svg: z
				.string()
				.max(512 * 1024)
				.nullable()
				.describe("The SVG file's text, or null to remove the logo"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const d = await domainOf(org.id, a.domain as string);
			await setBimiLogo(d.organization_id, d.id, a.svg as string | null);
			return domainView(await domainOf(org.id, d.id));
		},
	},
	{
		name: "set_organization_logo",
		title: "Set an organization's logo",
		description:
			'Sets the logo the dashboard shows for the organization (its switcher and sidebar), and what shows behind it. Give svg (an SVG\'s text, kept sharp) or image (a data: URL of a PNG, JPEG or WebP, at most 200 KB; square looks best), or remove: true to go back to a domain\'s BIMI logo or the initial. background: "white", "black", a hex color like #0d2b29, or null for none (the logo as it is); it also applies to the BIMI logo. Returns the organization\'s logo as the dashboard shows it.',
		input: {
			organization,
			svg: z
				.string()
				.max(200 * 1024)
				.optional()
				.describe("The logo as an SVG's text"),
			image: z
				.string()
				.max(300 * 1024)
				.optional()
				.describe("The logo as a data: URL (image/png, image/jpeg or image/webp)"),
			remove: z.boolean().optional().describe("true: remove the uploaded logo"),
			background: z
				.string()
				.max(20)
				.nullable()
				.optional()
				.describe('"white", "black", "#rrggbb", or null for none. Left out: unchanged.'),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const given = [a.svg, a.image, a.remove ? true : undefined].filter(
				(x) => x !== undefined,
			);
			if (given.length > 1)
				throw new ApiError(422, "validation_error", "Give one of svg, image or remove");
			if (a.svg !== undefined) await setOrgLogo(org.id, svgDataUrl(a.svg as string));
			else if (a.image !== undefined) await setOrgLogo(org.id, a.image as string);
			else if (a.remove) await setOrgLogo(org.id, null);
			if (a.background !== undefined)
				await setOrgLogoBackground(org.id, a.background as string | null);
			const logo = (await orgLogos([org.id])).get(org.id) ?? null;
			return {
				organization: org.id,
				logo: logo && { ...logo, url: `${baseUrl()}${logo.url}` },
			};
		},
	},
	{
		name: "dmarc_reports",
		title: "DMARC reports",
		description:
			"What Gmail, Yahoo, Outlook and others reported about mail From a domain in the last days (DMARC aggregate reports): messages, how many passed, per provider and per sending IP, failing sources first. Apple sends none.",
		input: {
			organization,
			domain: z.string().describe("The domain's name or id"),
			days: z.number().int().min(1).max(90).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const d = await domainOf(org.id, a.domain as string);
			return dmarcSummary(d.name, (a.days as number | undefined) ?? 30);
		},
	},
	{
		name: "list_api_keys",
		title: "List API keys",
		description:
			"The organization's API keys (names, permission, last use). Never their values.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const k = schema.apiKeys;
			return db
				.select({
					id: k.id,
					name: k.name,
					start: k.start,
					permission: k.permission,
					domain_id: k.domain_id,
					created_at: k.created_at,
					last_used_at: k.last_used_at,
				})
				.from(k)
				.where(eq(k.organization_id, org.id))
				.orderBy(desc(k.created_at));
		},
	},
	{
		name: "delete_api_key",
		title: "Delete an API key",
		description: "Revokes an API key at once: whatever uses it can't send any more.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			if (!(await deleteKey(org.id, a.id as string))) throw notFound("API key");
			return { deleted: a.id };
		},
	},
	{
		name: "list_webhooks",
		title: "List webhooks",
		description: "The organization's webhook endpoints and their events. Never their secrets.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const w = schema.webhooks;
			return db
				.select({
					id: w.id,
					url: w.url,
					events: w.events,
					enabled: w.enabled,
					created_at: w.created_at,
				})
				.from(w)
				.where(eq(w.organization_id, org.id));
		},
	},
	{
		name: "create_webhook",
		title: "Create a webhook",
		description:
			"Adds an endpoint for the organization's email events (all of them unless `events` says otherwise). With inbox_id, only that agent inbox's conversation events (inbox.*). Its signing secret isn't returned: an app gets it through scripts/connect-app.sh, or a person copies it from the dashboard.",
		input: {
			organization,
			url: z.string(),
			events,
			inbox_id: z.string().optional().describe("An agent inbox's id (list_inboxes)."),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const { secret: _secret, ...hook } = await createWebhook(org.id, {
				url: a.url,
				events:
					(a.events as string[] | undefined) ??
					(a.inbox_id ? [...INBOX_EVENTS] : [...WEBHOOK_EVENTS]),
				inbox_id: a.inbox_id ?? null,
			});
			return hook;
		},
	},
	{
		name: "update_webhook",
		title: "Update a webhook",
		description:
			"Changes a webhook endpoint's events, URL or on/off switch. Its signing secret stays the same (and isn't returned).",
		input: {
			organization,
			id: z.string(),
			url: z.string().optional(),
			events,
			enabled: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return updateWebhook(org.id, a.id as string, {
				...(a.url !== undefined ? { url: a.url } : {}),
				...(a.events !== undefined ? { events: a.events } : {}),
				...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
			});
		},
	},
	{
		name: "delete_webhook",
		title: "Delete a webhook",
		description: "Removes a webhook endpoint.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			await deleteWebhook(org.id, a.id as string);
			return { deleted: a.id };
		},
	},
	{
		name: "test_webhook",
		title: "Send a test event",
		description:
			"Posts a test email.delivered event to a webhook endpoint and returns how it answered.",
		input: { organization, id: z.string() },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const r = await sendTestEvent(org.id, a.id as string);
			if (!r) throw notFound("Webhook");
			return r;
		},
	},
	{
		name: "list_suppressions",
		title: "List suppressions",
		description:
			"Addresses the organization's brands won't send to (hard bounces, complaints, added by hand), each with its brand, 100 at a time (page with offset), and how many there are by reason. get_suppression explains one.",
		input: {
			organization,
			brand,
			search: z.string().optional(),
			reason: z.enum(SUPPRESSION_REASONS).optional(),
			offset: z.number().int().min(0).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const scope = await scopeOf(org.id, a.brand);
			const [page, counts] = await Promise.all([
				listSuppressions(scope, {
					search: a.search as string | undefined,
					reason: a.reason as never,
					offset: (a.offset as number | undefined) ?? 0,
					limit: 100,
				}),
				suppressionCounts(scope),
			]);
			return { ...page, counts };
		},
	},
	{
		name: "add_suppression",
		title: "Suppress an address",
		description:
			"Stops sending to an address from a brand (the organization's own without `brand`).",
		input: { organization, brand, address: z.string(), detail: z.string().optional() },
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return addSuppression(
				await brandOf(org.id, a.brand),
				a.address as string,
				a.detail as string | undefined,
			);
		},
	},
	{
		name: "remove_suppression",
		title: "Remove a suppression",
		description:
			"Lets the organization send to an address again (from every brand, or only `brand`). Only when the person fixed what bounced or asked to get email again. Logged.",
		input: { organization, brand, address: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "support");
			const ids = a.brand ? [await brandOf(org.id, a.brand)] : await brandIds(org.id);
			for (const id of ids) await removeSuppression(id, a.address as string);
			await logAccess({
				organizationId: org.id,
				action: "suppression_removed",
				subject: a.address as string,
				channel: "assistant",
				userId: ctx.userId,
				actor: ctx.email,
			});
			return { removed: true };
		},
	},
	{
		name: "list_unsubscribes",
		title: "List unsubscribes",
		description:
			"People who unsubscribed from one of the organization's unsubscribe groups (emails sent with unsubscribe_group), 100 at a time (page with offset), and the groups there are. They still get that organization's emails without a group or in other groups.",
		input: {
			organization,
			brand,
			group: z.string().optional(),
			search: z.string().optional(),
			offset: z.number().int().min(0).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const scope = await scopeOf(org.id, a.brand);
			const [page, groups] = await Promise.all([
				listUnsubscribes(scope, {
					group: a.group as string | undefined,
					search: a.search as string | undefined,
					offset: (a.offset as number | undefined) ?? 0,
					limit: 100,
				}),
				unsubscribeGroups(scope),
			]);
			return { ...page, groups };
		},
	},
	{
		name: "remove_unsubscribe",
		title: "Subscribe someone again",
		description:
			"Puts an address back in an unsubscribe group. Only when the person asked to get these emails again.",
		input: { organization, brand, group: z.string(), address: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "support");
			const ids = a.brand ? [await brandOf(org.id, a.brand)] : await brandIds(org.id);
			let removed = false;
			for (const id of ids)
				removed =
					(await resubscribe(id, a.group as string, a.address as string)) || removed;
			await logAccess({
				organizationId: org.id,
				action: "unsubscribe_removed",
				subject: a.address as string,
				channel: "assistant",
				userId: ctx.userId,
				actor: ctx.email,
			});
			return { removed };
		},
	},
	{
		name: "lookup_recipient",
		title: "Look up a recipient",
		description:
			"Whether an address can get the organization's emails and why not (suppressed, firewall, a domain that takes no email), its unsubscribes, and the last 50 emails sent to it. For support questions like «did my code arrive?». Logged in the access log.",
		input: { organization, address: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			return lookupRecipient(
				org.id,
				a.address as string,
				{ channel: "assistant", userId: ctx.userId, actor: ctx.email },
				{ maskDigits: org.masked },
			);
		},
	},
	{
		name: "sending_status",
		title: "Can it send?",
		description:
			"Whether each brand can send right now and, if not, why (paused by the team or Mailroom, paused by SES, not set up), paused domains and webhooks that are down.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => sendingStatus(orgFor(ctx, a.organization).id),
	},
	{
		name: "get_firewall",
		title: "Email firewall",
		description:
			"A brand's email firewall (each brand has its own; the organization's own brand without `brand`): which checks are on (disposable addresses, free inboxes, plus addresses) and its «Never send to» and «Always allow» lists.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const id = await brandOf(org.id, a.brand);
			return { brand_id: id, ...(await getFirewall(id)) };
		},
	},
	{
		name: "update_firewall",
		title: "Change the email firewall",
		description:
			"Turns each check of a brand's firewall on or off (the organization's own brand without `brand`), or replaces its lists. Lists take domains (their subdomains too), endings like .ru, or addresses; «Always allow» wins over every check.",
		input: {
			organization,
			brand: oneBrand,
			block_disposable: z.boolean().optional(),
			block_free: z.boolean().optional(),
			block_plus: z.boolean().optional(),
			never: z.array(z.string()).optional(),
			always: z.array(z.string()).optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return setFirewall(await brandOf(org.id, a.brand), {
				block_disposable: a.block_disposable as boolean | undefined,
				block_free: a.block_free as boolean | undefined,
				block_plus: a.block_plus as boolean | undefined,
				never: a.never as string[] | undefined,
				always: a.always as string[] | undefined,
			});
		},
	},
	{
		name: "replay_failed_webhooks",
		title: "Replay failed webhook deliveries",
		description:
			"Sends again every delivery an endpoint gave up on in the last 7 days (after it was fixed).",
		input: { organization, id: z.string() },
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return { replayed: await replayFailed(org.id, a.id as string) };
		},
	},
	{
		name: "list_starter_designs",
		title: "List ready-made designs",
		description:
			"Mailroom's ready-made email designs (newsletters, announcements, promotions, events, welcome, feedback, transactional, plain), the same the dashboard offers. Start a broadcast or template from one with `starter` on save_broadcast or save_template.",
		input: {},
		readOnly: true,
		run: async () => ({ designs: starterList() }),
	},
	{
		name: "list_templates",
		title: "List templates",
		description:
			"The organization's email templates: name, alias, whether published, and whether the draft has changes not published yet.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			return (await listTemplates(org.id)).map((t) => {
				const { html: _h, text: _t, ...rest } = templateView(t);
				return rest;
			});
		},
	},
	{
		name: "get_template",
		title: "Get a template",
		description:
			"One template (by id or alias) with its draft's HTML, text, subject, From and variables.",
		input: { organization, template: z.string().describe("Its id or alias") },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			return templateView(await getTemplate(org.id, a.template as string));
		},
	},
	{
		name: "save_template",
		title: "Create or edit a template",
		description:
			"Creates a template, or with `template` changes one's draft. Use {{{KEY}}} in html, text and subject for variables, declared in `variables` (key, type string|number, optional fallback_value); FIRST_NAME, LAST_NAME, EMAIL and UNSUBSCRIBE_URL are filled by Mailroom in broadcasts. Sends use the published version: pass publish true (or call publish_template) after the person approves.",
		input: {
			organization,
			template: z.string().optional().describe("Id or alias of the template to edit"),
			name: z.string().optional(),
			alias: z.string().optional(),
			from: z.string().optional(),
			subject: z.string().optional(),
			reply_to: z.string().optional(),
			html: z.string().optional(),
			text: z.string().optional(),
			design: z.record(z.string(), z.unknown()).nullable().optional().describe(DESIGN_HELP),
			...STARTER_INPUT,
			variables: z
				.array(
					z.object({
						key: z.string(),
						type: z.enum(["string", "number"]).optional(),
						fallback_value: z.union([z.string(), z.number()]).optional(),
					}),
				)
				.optional(),
			publish: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const {
				organization: _o,
				template,
				publish,
				starter,
				starter_logo,
				brand_colors,
				...fields
			} = a;
			const defined = Object.fromEntries(
				Object.entries(fields).filter(([, v]) => v !== undefined),
			);
			if (starter)
				defined.design = await starterFor(org.id, starter as string, {
					logo: starter_logo as LogoChoice | undefined,
					brandColors: brand_colors as boolean | undefined,
				});
			// A design makes the HTML, so a new template from one needs none of its own.
			if (!template && defined.design && defined.html === undefined) defined.html = "";
			let t = template
				? await updateTemplate(org.id, template as string, defined)
				: await createTemplate(org.id, defined);
			await recordVersion({
				organizationId: org.id,
				type: "template",
				id: t.id,
				userId: ctx.userId,
				snapshot: snapshotOf({ ...t.draft, design: t.draft.design ?? null }),
			});
			if (publish) t = await publishTemplate(org.id, t.id);
			await logged(
				ctx,
				org,
				publish ? "template.published" : template ? "template.edited" : "template.created",
				{ type: "template", id: t.id, name: t.name },
			);
			return templateView(t);
		},
	},
	{
		name: "publish_template",
		title: "Publish a template",
		description: "Makes a template's draft what sends use from now on.",
		input: { organization, template: z.string().describe("Its id or alias") },
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return templateView(await publishTemplate(org.id, a.template as string));
		},
	},
	{
		name: "delete_template",
		title: "Delete a template",
		description: "Deletes a template; sends that name it are refused afterwards.",
		input: { organization, template: z.string().describe("Its id or alias") },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const t = await deleteTemplate(org.id, a.template as string);
			return { id: t.id, deleted: true };
		},
	},
	{
		name: "list_contacts",
		title: "List contacts",
		description:
			"A brand's contacts (the people its broadcasts go to), newest first: search by address or name, or only one segment's. Pass `after` (the previous page's next) for more.",
		input: {
			organization,
			brand: oneBrand,
			search: z.string().optional(),
			segment_id: z.string().optional(),
			after: z.string().optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const page = await listContacts(await brandOf(org.id, a.brand), {
				search: a.search as string | undefined,
				segment: a.segment_id as string | undefined,
				after: a.after as string | undefined,
				limit: 50,
			});
			return { ...page, data: page.data.map(contactView) };
		},
	},
	{
		name: "get_contact",
		title: "Get a contact",
		description: "One contact (by id or address) with its properties and topic choices.",
		input: { organization, brand: oneBrand, contact: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const brand = await brandOf(org.id, a.brand);
			const c = await getContact(brand, a.contact as string);
			return { ...contactView(c), topics: await topicsOfContact(brand, c.id) };
		},
	},
	{
		name: "save_contact",
		title: "Add or update a contact",
		description:
			"Adds a contact to a brand, or updates the one with that address: names, unsubscribed, how often they want broadcasts (pace: weekly|monthly, null for every one), a pause on broadcasts and automation emails (paused_until: an ISO time, null to resume), properties (declared ones), segments (ids to add it to) and topics ([{ id, subscription: opt_in|opt_out }]). People set pace and pauses themselves on the preferences page too.",
		input: {
			organization,
			brand: oneBrand,
			email: z.string(),
			first_name: z.string().optional(),
			last_name: z.string().optional(),
			unsubscribed: z.boolean().optional(),
			pace: z.enum(["weekly", "monthly"]).nullable().optional(),
			paused_until: z.string().nullable().optional(),
			properties: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
			segments: z.array(z.string()).optional(),
			topics: z
				.array(z.object({ id: z.string(), subscription: z.enum(["opt_in", "opt_out"]) }))
				.optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const { organization: _o, brand: b, ...fields } = a;
			const { contact, created } = await upsertContact(await brandOf(org.id, b), {
				source: "mcp",
				...fields,
			});
			return { ...contactView(contact), created };
		},
	},
	{
		name: "delete_contact",
		title: "Delete a contact",
		description: "Removes a contact (by id or address) from a brand's contacts.",
		input: { organization, brand: oneBrand, contact: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const c = await deleteContact(await brandOf(org.id, a.brand), a.contact as string);
			return { id: c.id, deleted: true };
		},
	},
	{
		name: "list_segments",
		title: "List segments and topics",
		description:
			"A brand's segments (with how many contacts each has) and topics (what contacts can opt in or out of).",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const brand = await brandOf(org.id, a.brand);
			const [segments, topics] = await Promise.all([listSegments(brand), listTopics(brand)]);
			return {
				segments: segments.map((s) => segmentView(s, s.contacts)),
				topics: topics.map(topicView),
			};
		},
	},
	{
		name: "create_segment",
		title: "Create a segment or topic",
		description:
			"Creates a segment (a group of contacts broadcasts go to), or with kind topic a topic (default_subscription opt_out: everyone gets it until they leave; opt_in: only who joins).",
		input: {
			organization,
			brand: oneBrand,
			kind: z.enum(["segment", "topic"]).optional(),
			name: z.string(),
			description: z.string().optional(),
			default_subscription: z.enum(["opt_in", "opt_out"]).optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const brand = await brandOf(org.id, a.brand);
			if (a.kind === "topic") return topicView(await createTopic(brand, a));
			return segmentView(await createSegment(brand, a));
		},
	},
	{
		name: "list_broadcasts",
		title: "List broadcasts",
		description:
			"The organization's broadcasts (or one brand's), newest first: status (draft, scheduled, sending, sent, canceled), segment, newsletter, campaign and how many emails were queued. Filter by status, newsletter_id or campaign_id.",
		input: {
			organization,
			brand: oneBrand,
			status: z.enum(["draft", "scheduled", "sending", "sent", "canceled"]).optional(),
			newsletter_id: z.string().optional(),
			campaign_id: z.string().optional(),
			limit: z.number().int().min(1).max(500).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const ids = a.brand ? [await brandOf(org.id, a.brand)] : await brandIds(org.id);
			const filtered = a.status || a.newsletter_id || a.campaign_id;
			const limit = (a.limit as number | undefined) ?? 100;
			const rows = (await listBroadcasts(ids, { limit: filtered ? 1000 : limit }))
				.filter(
					(x) =>
						(!a.status || x.status === a.status) &&
						(!a.newsletter_id || x.newsletter_id === a.newsletter_id) &&
						(!a.campaign_id || x.campaign_id === a.campaign_id),
				)
				.slice(0, limit);
			return rows.map((x) => {
				const {
					html: _h,
					text: _t,
					design: _d,
					...v
				} = broadcastView(x) as Record<string, unknown>;
				return v;
			});
		},
	},
	{
		name: "get_broadcast",
		title: "Get a broadcast",
		description:
			"One broadcast with its content (html, text and its block design when made in the editor) and what happened to its emails (sent, delivered, opened, clicked, bounced, unsubscribed); before it goes, its audience size (and held_out: about how many quiet mode and the frequency cap leave out); once sent, its report (clicks per link, by provider), A/B variants, poll results, how many didn't open (a resend's audience), the replies it got (each a conversation tagged \"broadcast reply\"), the revenue credited to it and its web version; and whether it needs and has approval.",
		input: { organization, broadcast: z.string().describe("Its id") },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const x = await getBroadcast(await brandIds(org.id), a.broadcast as string);
			const went = !["draft", "scheduled"].includes(x.status);
			const [stats, audience, variants, report, polls, nonOpeners, needsApproval, hash] =
				await Promise.all([
					broadcastStats(x.id),
					went ? undefined : audienceSize(x),
					x.ab_test ? variantStats(x.id) : undefined,
					went ? broadcastReport(x.id, x.started_at) : undefined,
					went ? pollResults(x.id, x.design) : undefined,
					x.status === "sent" ? audienceSize({ ...x, resend_of: x.id }) : undefined,
					approvalRequired(org.id),
					contentHash(x),
				]);
			const newsletter = x.newsletter_id
				? await getNewsletter(x.organization_id, x.newsletter_id).catch(() => null)
				: null;
			return {
				...broadcastView(x),
				stats,
				audience,
				held_out:
					!went && x.segment_id
						? await import("../marketing-rules").then(async (m) =>
								m.heldOutCount(
									x.organization_id,
									x.segment_id as string,
									await m.marketingRules(x.organization_id),
								),
							)
						: undefined,
				variants,
				report,
				polls,
				did_not_open: nonOpeners,
				replies: went
					? await import("../conversations").then((m) => m.broadcastReplies(x.id))
					: undefined,
				revenue: went
					? await import("../revenue").then((m) => m.revenueOf("broadcast", x.id))
					: undefined,
				web_url: went ? webUrl(x, newsletter) : null,
				approval: {
					required: needsApproval,
					review: x.review,
					approved: x.review === "approved" && x.review_hash === hash,
				},
			};
		},
	},
	{
		name: "save_broadcast",
		title: "Create or change a broadcast",
		description:
			"Creates a draft broadcast (no `broadcast`) or changes a draft: segment_id, topic_id, from, subject, preview_text, reply_to, the content (html/text, a block `design` like the dashboard's editor makes, or template { id, variables } to copy a published template's content in), newsletter_id (an issue of that newsletter; web: on its public archive), campaign_id (part of that campaign; campaign_dedupe: skip who got another of its broadcasts), planned_on (its day on the content calendar, get_calendar). {{{FIRST_NAME}}}, {{{contact.<key>}}}, {{{UNSUBSCRIBE_URL}}} and {{{WEB_VERSION_URL}}} are filled per contact. Each save keeps a version (list_versions). It isn't sent: use send_broadcast.",
		input: {
			organization,
			brand: oneBrand,
			broadcast: z.string().optional().describe("A draft's id to change"),
			name: z.string().optional(),
			segment_id: z.string().nullable().optional(),
			topic_id: z.string().nullable().optional(),
			from: z.string().optional(),
			subject: z.string().optional(),
			reply_to: z.array(z.string()).optional(),
			preview_text: z.string().optional(),
			html: z.string().optional(),
			text: z.string().nullable().optional(),
			design: z.record(z.string(), z.unknown()).nullable().optional().describe(DESIGN_HELP),
			...STARTER_INPUT,
			template: z
				.object({ id: z.string(), variables: z.record(z.string(), z.unknown()).optional() })
				.optional(),
			newsletter_id: z.string().nullable().optional(),
			web: z.boolean().optional(),
			campaign_id: z.string().nullable().optional(),
			campaign_dedupe: z.boolean().optional(),
			planned_on: z
				.string()
				.nullable()
				.optional()
				.describe("A draft's day on the content calendar (YYYY-MM-DD); null takes it off"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const {
				organization: _o,
				brand: b,
				broadcast: id,
				starter,
				starter_logo,
				brand_colors,
				...fields
			} = a;
			let row: Awaited<ReturnType<typeof getBroadcast>>;
			if (starter) {
				const brand = id
					? (await getBroadcast(await brandIds(org.id), id as string)).organization_id
					: await brandOf(org.id, b);
				fields.design = await starterFor(brand, starter as string, {
					logo: starter_logo as LogoChoice | undefined,
					brandColors: brand_colors as boolean | undefined,
				});
			}
			if (id) {
				const x = await getBroadcast(await brandIds(org.id), id as string);
				row = await updateBroadcast(
					org.id,
					x.organization_id,
					x.id,
					fields,
					Date.now(),
					ctx.userId,
				);
			} else {
				row = await createBroadcast(
					org.id,
					await brandOf(org.id, b),
					{ name: "Untitled broadcast", html: "", ...fields },
					Date.now(),
					ctx.userId,
				);
				await logged(ctx, org, "broadcast.created", {
					type: "broadcast",
					id: row.id,
					name: row.name,
				});
			}
			await recordVersion({
				organizationId: org.id,
				type: "broadcast",
				id: row.id,
				userId: ctx.userId,
				snapshot: snapshotOf(row),
			});
			if (id)
				await logged(ctx, org, "broadcast.edited", {
					type: "broadcast",
					id: row.id,
					name: row.name || row.subject,
				});
			return broadcastView(row);
		},
	},
	{
		name: "send_broadcast",
		title: "Send a broadcast",
		description:
			"Sends a draft broadcast to its segment now, or at scheduled_at (ISO 8601, up to 30 days ahead), or at local_time (2026-11-10T09:00) in each contact's own time zone. ab_test: { subjects (1 or 2 other subject lines to test against the broadcast's own), metric opens|clicks, size (10–50: percent of the audience in the test), wait_minutes (30–2880) } sends the winning subject to the rest. When the organization requires approval, the broadcast must be approved first (review_broadcast). Confirm the audience with the person first: get_broadcast gives its size.",
		input: {
			organization,
			broadcast: z.string(),
			scheduled_at: z.string().optional(),
			local_time: z.string().optional(),
			ab_test: z
				.object({
					subjects: z.array(z.string()).min(1).max(2),
					metric: z.enum(["opens", "clicks"]).optional(),
					size: z.number().int().min(10).max(50).optional(),
					wait_minutes: z.number().int().min(30).max(2880).optional(),
				})
				.optional(),
		},
		destructive: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const x = await getBroadcast(await brandIds(org.id), a.broadcast as string);
			const row = await sendBroadcast(
				x.organization_id,
				x.id,
				a.scheduled_at as string | undefined,
				Date.now(),
				{
					ab_test: a.ab_test as never,
					local_time: a.local_time as string | undefined,
				},
			);
			await logged(
				ctx,
				org,
				row.status === "scheduled" && (a.scheduled_at || a.local_time)
					? "broadcast.scheduled"
					: "broadcast.sent",
				{ type: "broadcast", id: x.id, name: x.name || x.subject },
				row.scheduled_at ? { at: row.scheduled_at } : undefined,
			);
			if (!a.scheduled_at && !a.local_time) await runBroadcasts(Date.now(), row.id);
			const after = await getBroadcast(x.organization_id, x.id);
			return { id: row.id, status: after.status, scheduled_at: after.scheduled_at };
		},
	},
	{
		name: "cancel_broadcast",
		title: "Unschedule or stop a broadcast",
		description:
			"A scheduled broadcast goes back to draft; one sending stops and its emails not sent yet are canceled.",
		input: { organization, broadcast: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const x = await getBroadcast(await brandIds(org.id), a.broadcast as string);
			const row = await cancelBroadcast(x.organization_id, x.id);
			await logged(ctx, org, "broadcast.canceled", {
				type: "broadcast",
				id: x.id,
				name: x.name || x.subject,
			});
			return { id: row.id, status: row.status };
		},
	},
	{
		name: "list_automations",
		title: "List automations",
		description:
			"The organization's automations (or one brand's): trigger (contact.created, segment.joined, an event, a broadcast opened or clicked), steps (wait, send a template, add to or take out of a segment, set a property, a condition with yes and no paths) and status.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const ids = a.brand ? [await brandOf(org.id, a.brand)] : await brandIds(org.id);
			return (await listAutomations(ids)).map(automationView);
		},
	},
	{
		name: "get_automation",
		title: "Get an automation",
		description:
			"One automation with how many runs are active, done, exited or failed, the latest runs, and the revenue credited to its emails (each currency apart).",
		input: { organization, automation: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const x = await getAutomation(await brandIds(org.id), a.automation as string);
			const { revenueOf } = await import("../revenue");
			return {
				...automationView(x),
				...(await automationRuns(x.id, 20)),
				revenue: await revenueOf("automation", x.id),
			};
		},
	},
	{
		name: "save_automation",
		title: "Create or change an automation",
		description:
			"Creates an automation (no `automation`) or changes one. trigger: { type: contact.created, segment_id? } | { type: segment.joined, segment_id } | { type: event, event } (Mailroom's own: poll.answered, referral.milestone…) | { type: email.opened, broadcast_id? } | { type: email.clicked, broadcast_id?, link? } | { type: form.submitted, form_id? } | { type: unsubscribed } | { type: topic.changed, topic_id, value: opt_in|opt_out } | { type: property.changed, key, equals? } | { type: date, key (a date property), offset_days (-365..365: before or after), yearly } | { type: inactive, days (no open or click for that long) } | { type: conversation.opened, inbox_id?, channel?: email|chat } | { type: conversation.resolved, inbox_id? } | { type: conversation.rated, op: at_most|at_least, rating 1-5 }. steps, in order: { type: wait, minutes|hours|days } | { type: send, template_id, from?, subject?, variables? } | { type: email, from, subject, body } (written here, no template) | { type: segment, action: add|remove, segment_id } | { type: property, key, value } | { type: score, key, add } | { type: topic, topic_id, value } | { type: newsletter, newsletter_id, action: subscribe|remove } | { type: notify, to: team members' emails, message } | { type: conversation, action: tag|priority|assign|resolve, value? (a tag; urgent|high|normal|low; a user id) } on their latest open conversation | { type: webhook, url (https) } | { type: condition, segment_id? | property + equals? | engaged: opened|clicked, no?: steps } | { type: wait_event, event, minutes|hours|days (at most), no?: steps } (goes on when they do it; on time out the `no` steps) | { type: split, percent, no?: steps } (percent go on, the rest take `no`). Without `no` steps, a step that doesn't hold ends the run. goal_event: when the contact does it, their run ends as reached (counted as a conversion). status: draft, active or paused. Emails use the contact's values and {{{event.<key>}}} from the event's data.",
		input: {
			organization,
			brand: oneBrand,
			automation: z.string().optional(),
			name: z.string().optional(),
			status: z.enum(["draft", "active", "paused"]).optional(),
			trigger: z.record(z.string(), z.unknown()).optional(),
			steps: z.array(z.record(z.string(), z.unknown())).optional(),
			reentry: z.boolean().optional(),
			goal_event: z.string().nullish(),
			/** New ones only: start from a recipe (welcome, welcome_ab, abandoned, nurture,
			 * birthday, winback, review, unhappy, followup); other fields given override it. */
			recipe: z.string().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const { organization: _o, brand: b, automation: id, recipe, ...fields } = a;
			// Turning one on or off is its own permission.
			if (fields.status === "active" || fields.status === "paused")
				requires(org, "automations:activate");
			if (id) {
				const x = await getAutomation(await brandIds(org.id), id as string);
				const row = await updateAutomation(x.organization_id, x.id, fields);
				await logged(ctx, org, "automation.edited", {
					type: "automation",
					id: row.id,
					name: row.name,
				});
				return automationView(row);
			}
			const brandId = await brandOf(org.id, b);
			let base: Record<string, unknown> = {
				name: "Untitled automation",
				trigger: { type: "contact.created" },
				steps: [],
			};
			if (recipe) {
				const { RECIPES } = await import("../../lib/automation-recipes");
				const r = RECIPES.find((x) => x.id === recipe);
				if (!r) throw validation(`recipe: one of ${RECIPES.map((x) => x.id).join(", ")}`);
				const { orgContext } = await import("../org");
				const domain = (await orgContext(brandId)).domains.find((d) => d.verified)?.name;
				base = r.build({
					from: domain ? `hello@${domain}` : "hello@example.com",
					team: [],
				});
			}
			const row = await createAutomation(brandId, { ...base, ...fields });
			await logged(ctx, org, "automation.created", {
				type: "automation",
				id: row.id,
				name: row.name,
			});
			return automationView(row);
		},
	},
	{
		name: "send_event",
		title: "Send an event about a contact",
		description:
			"Records an event (like booking.created) for a contact by email (added if new): it's kept on their timeline, and active automations triggered by it start. data becomes {{{event.<key>}}} in their emails. With a value (and currency) it's a purchase: the last broadcast or automation email they opened or clicked, or website chat they wrote in, within 7 days gets the credit (get_revenue).",
		input: {
			organization,
			brand: oneBrand,
			event: z.string(),
			email: z.string(),
			data: z.record(z.string(), z.unknown()).optional(),
			value: z.number().min(0).optional().describe("A purchase's amount"),
			currency: z.string().length(3).optional().describe("ISO code, like USD or MXN"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			return recordEvent(
				await brandOf(org.id, a.brand),
				{
					event: a.event,
					email: a.email,
					data: a.data,
					value: a.value,
					currency: a.currency,
				},
				Date.now(),
				"assistant",
			);
		},
	},
	{
		name: "list_inbound_rules",
		title: "List inbound rules",
		description:
			"What each brand does with email it receives, in order: forward a copy to other addresses, or drop it.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const ids = a.brand ? [await brandOf(org.id, a.brand)] : await brandIds(org.id);
			return (await listRules(ids)).map(ruleView);
		},
	},
	{
		name: "save_inbound_rule",
		title: "Create or change an inbound rule",
		description:
			"Creates a rule (no `rule`) or changes one. match_to: an address, *@domain, name@* or * (default); match_from and match_subject: text they contain. action: forward (with forward_to, up to 10 addresses) or drop. continue: look at the next rules too.",
		input: {
			organization,
			brand: oneBrand,
			rule: z.string().optional(),
			name: z.string().optional(),
			match_to: z.string().optional(),
			match_from: z.string().nullable().optional(),
			match_subject: z.string().nullable().optional(),
			action: z.enum(["forward", "drop"]).optional(),
			forward_to: z.array(z.string()).optional(),
			continue: z.boolean().optional(),
			enabled: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const { organization: _o, brand: b, rule: id, ...fields } = a;
			if (id) {
				const x = await getRule(await brandIds(org.id), id as string);
				return ruleView(await updateRule(x.organization_id, x.id, fields));
			}
			return ruleView(await createRule(await brandOf(org.id, b), fields));
		},
	},
	{
		name: "delete_inbound_rule",
		title: "Delete an inbound rule",
		description: "Removes an inbound rule.",
		input: { organization, rule: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const x = await getRule(await brandIds(org.id), a.rule as string);
			await deleteRule(x.organization_id, x.id);
			return { id: x.id, deleted: true };
		},
	},
	{
		name: "check_deliverability",
		title: "Check deliverability",
		description:
			"Checks a domain's DNS against what SES needs (DKIM, MAIL FROM, receiving MX, DMARC) and the domain blocklists, now; and/or an email's content (subject, html, text, marketing) for what inboxes hold against it (Gmail clipping, all-caps subject, image-only, URL shorteners…).",
		input: {
			organization,
			domain: z.string().optional().describe("A domain's name or id"),
			subject: z.string().optional(),
			html: z.string().optional(),
			text: z.string().optional(),
			marketing: z.boolean().optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization);
			const out: Record<string, unknown> = {};
			if (a.domain) {
				const ids = await brandIds(org.id);
				const d = (
					await db
						.select()
						.from(schema.domains)
						.where(inArray(schema.domains.organization_id, ids))
				).find((x) => x.id === a.domain || x.name === String(a.domain).toLowerCase());
				if (!d) throw notFound("Domain");
				out.domain = {
					name: d.name,
					...healthView(await checkDomainHealth(d, { notify: false })),
				};
			}
			if (a.subject !== undefined || a.html !== undefined || a.text !== undefined)
				out.content = checkContent({
					subject: (a.subject as string) ?? "",
					html: a.html as string | undefined,
					text: a.text as string | undefined,
					marketing: a.marketing as boolean | undefined,
				});
			return out;
		},
	},
	{
		name: "create_inbox",
		title: "Create an agent inbox",
		description:
			"Adds an agent inbox to a brand: local_part@<one of its receiving domains> (domain), or, without a domain, <brand slug>+local_part at the deployment's Mailroom address domain. Its credentials (for the agent's own connection) are made on the inbox's page in the dashboard or with the API; they're never shown here.",
		input: {
			organization,
			brand: oneBrand,
			name: z.string().min(1).max(100),
			local_part: z.string().describe("Before the @: support, invoices…"),
			domain: z
				.string()
				.optional()
				.describe("A receiving domain of the brand (list_domains)."),
			reply_from: z
				.string()
				.optional()
				.describe("What replies are sent from, when not the inbox's own address."),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization, "manage");
			const brandId = await brandOf(org.id, a.brand);
			const inbox = await createInbox(brandId, a, { userId: ctx.userId });
			await logInbox(
				{ organizationId: org.id, type: "person", id: ctx.userId, name: ctx.email },
				{
					brandId,
					inboxId: inbox.id,
					action: "inbox.created",
					detail: { address: inbox.address },
				},
			);
			return inboxView(inbox);
		},
	},
	// The inbox tools (inbox-tools.ts), for people: in one of their organizations, as their role
	// allows (replying needs "Reply to received email").
	...INBOX_TOOLS.map(
		(t): Tool => ({
			name: t.name,
			title: t.title,
			description: t.description,
			input: { organization, ...t.input },
			readOnly: t.readOnly,
			destructive: t.destructive,
			openWorld: t.openWorld,
			run: async (a, ctx) => t.run(a, await personActor(orgFor(ctx, a.organization), ctx)),
		}),
	),
	// Everything else the dashboard does, by area (each tool checks its own permission).
	...TEAM_TOOLS,
	...AUDIENCE_TOOLS,
	...CONTENT_TOOLS,
	...SETTINGS_TOOLS,
	...HELP_TOOLS,
	...SURVEY_TOOLS,
	...TODAY_TOOLS,
	...CALENDAR_TOOLS,
	...SEARCH_TOOLS,
	...LEAD_TOOLS,
	...NOTE_TOOLS,
	...PERSON_TOOLS,
];
