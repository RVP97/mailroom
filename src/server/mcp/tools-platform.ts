import { z } from "zod";
import { AccessError } from "../access";
import { aiAssistEmailCopy, triageConversationWithAi } from "../ai";
import {
	addKnowledgeSource,
	deleteAiAction,
	deleteKnowledgeSource,
	listAiActions,
	listKnowledgeSources,
	saveAiAction,
} from "../ai-knowledge";
import { listBillingConnectors } from "../billing-connectors";
import { brandIds, brandIn } from "../brands";
import { deleteCompany, getCompany, listCompanies, upsertCompany } from "../companies";
import { importContactsBundle, importHelpArticlesBundle } from "../importers";
import {
	linkConversationIssue,
	listConversationIssues,
	unlinkConversationIssue,
} from "../issue-links";
import { listOmnichannelSettings } from "../omnichannel";
import {
	COMPONENT_STATUSES,
	createStatusIncident,
	deleteStatusComponent,
	getStatusPageData,
	INCIDENT_IMPACTS,
	INCIDENT_STATUSES,
	postIncidentUpdate,
	savePublicPagesSettings,
	saveStatusComponent,
} from "../status-page";
import { getBrandTransport, transportView } from "../transports";
import { saveDomainWarmup } from "../warmup";
import { personActor } from "./inbox-tools";
import { oneBrand, organization, type Tool } from "./kit";
import type { McpContext, Membership } from "./tools";

function orgFor(ctx: McpContext, ref: string | undefined, perm?: string): Membership {
	const found = ref
		? ctx.organizations.find(
				(o) => o.id === ref || o.slug === ref || o.handle === ref || o.name === ref,
			)
		: ctx.organizations[0];
	if (!found) throw new Error("Organization not found");
	if (perm && !found.access.can(perm as never))
		throw new AccessError("You don't have permission for that");
	return found;
}

async function resolveBrand(orgId: string, ref: string | undefined) {
	return ref ? brandIn(orgId, ref) : orgId;
}

/**
 * MCP tools for the expanded platform: B2B Companies, Billing Connectors, GitHub/Linear
 * Issue Links, Pluggable Sending Transports, Migration Importers, and AI Triage / Copywriter.
 */
export const PLATFORM_TOOLS: Tool[] = [
	{
		name: "list_companies",
		title: "List B2B companies",
		description:
			"List B2B companies / accounts (grouped by corporate email domain with plan, MRR, seats, renewal date and contact counts).",
		input: {
			organization,
			brand: oneBrand,
			search: z.string().optional(),
			plan: z.string().optional(),
			limit: z.number().int().min(1).max(200).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			const brands = a.brand
				? [await resolveBrand(org.id, a.brand as string)]
				: await brandIds(org.id);
			return listCompanies(brands, {
				search: a.search as string | undefined,
				plan: a.plan as string | undefined,
				limit: a.limit as number | undefined,
			});
		},
	},
	{
		name: "get_company",
		title: "Get a B2B company",
		description:
			"Read one company's account details, linked contacts and recent conversations.",
		input: {
			organization,
			id: z.string().describe("Company id (cmp_…)."),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return getCompany(await brandIds(org.id), a.id as string);
		},
	},
	{
		name: "save_company",
		title: "Create or update a B2B company",
		description:
			"Create or update a B2B company by id or corporate domain (name, domain, plan, mrr, seats, renewal_at, website, notes). Auto-links contacts with matching domains.",
		input: {
			organization,
			brand: oneBrand,
			id: z.string().optional(),
			name: z.string().min(1).max(120),
			domain: z.string().max(120).nullable().optional(),
			plan: z.string().max(60).nullable().optional(),
			mrr: z.number().min(0).nullable().optional(),
			seats: z.number().int().min(0).nullable().optional(),
			renewal_at: z.string().max(40).nullable().optional(),
			website: z.string().max(300).nullable().optional(),
			notes: z.string().max(10_000).nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "contacts:edit");
			const brandId = await resolveBrand(org.id, a.brand as string | undefined);
			const { organization: _o, brand: _b, id, ...rest } = a;
			return upsertCompany(brandId, rest, { id: id as string | undefined });
		},
	},
	{
		name: "delete_company",
		title: "Delete a B2B company",
		description: "Delete a B2B company record (its contacts remain intact).",
		input: {
			organization,
			id: z.string().describe("Company id (cmp_…)."),
		},
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "contacts:edit");
			return deleteCompany(await brandIds(org.id), a.id as string);
		},
	},
	{
		name: "list_billing_connectors",
		title: "List billing webhook connectors",
		description:
			"List Stripe, Polar and Lemon Squeezy webhook connectors with their webhook URLs, event counts and status (never reveals signing secrets).",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			const brands = a.brand
				? [await resolveBrand(org.id, a.brand as string)]
				: await brandIds(org.id);
			return listBillingConnectors(brands);
		},
	},
	{
		name: "list_conversation_issues",
		title: "List linked GitHub/Linear issues on a conversation",
		description:
			"List GitHub issues, Linear issues or ticket links attached to an inbox conversation.",
		input: {
			organization,
			conversation_id: z.string(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			orgFor(ctx, a.organization as string | undefined);
			return listConversationIssues(a.conversation_id as string);
		},
	},
	{
		name: "link_conversation_issue",
		title: "Link a GitHub or Linear issue to a conversation",
		description:
			"Attach a GitHub issue, Linear issue or external ticket URL to a conversation so closing the issue automatically posts an internal note and reopens the thread.",
		input: {
			organization,
			brand: oneBrand,
			conversation_id: z.string(),
			url: z.string().url(),
			title: z.string().max(200).optional(),
			reopen_on_close: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "inbox:reply");
			const brandId = await resolveBrand(org.id, a.brand as string | undefined);
			return linkConversationIssue(
				brandId,
				a.conversation_id as string,
				{
					url: a.url,
					title: a.title,
					reopen_on_close: a.reopen_on_close,
				},
				ctx.userId,
			);
		},
	},
	{
		name: "unlink_conversation_issue",
		title: "Unlink an issue from a conversation",
		description: "Remove a linked GitHub or Linear issue from a conversation.",
		input: {
			organization,
			conversation_id: z.string(),
			issue_link_id: z.string(),
		},
		destructive: true,
		run: async (a, ctx) => {
			orgFor(ctx, a.organization as string | undefined, "inbox:reply");
			return unlinkConversationIssue(a.conversation_id as string, a.issue_link_id as string);
		},
	},
	{
		name: "get_brand_transport",
		title: "Get a brand's sending transport",
		description:
			"Read whether a brand sends via Amazon SES (default) or an external transport (Resend or Postmark). Never returns API keys.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			const brandId = await resolveBrand(org.id, a.brand as string | undefined);
			return transportView(await getBrandTransport(brandId));
		},
	},
	{
		name: "import_contacts_bundle",
		title: "Import contacts & companies from CSV or JSON",
		description:
			"Bulk import contacts from a CSV or JSON export (Mailchimp, Beehiiv, Loops, Resend, Intercom), auto-creating custom properties and syncing B2B companies.",
		input: {
			organization,
			brand: oneBrand,
			source: z.enum(["csv", "json"]),
			content: z.string().min(1).max(200_000),
			segment_id: z.string().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "contacts:edit");
			const brandId = await resolveBrand(org.id, a.brand as string | undefined);
			return importContactsBundle(brandId, {
				source: a.source as "csv" | "json",
				content: a.content as string,
				segment_id: a.segment_id as string | undefined,
			});
		},
	},
	{
		name: "import_help_articles_bundle",
		title: "Import Help Center articles from JSON",
		description:
			"Bulk import Help Center articles from an Intercom, Zendesk or Crisp JSON export.",
		input: {
			organization,
			brand: oneBrand,
			content: z.string().min(1).max(500_000),
			publish: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "help:edit");
			const brandId = await resolveBrand(org.id, a.brand as string | undefined);
			return importHelpArticlesBundle(
				brandId,
				{
					content: a.content as string,
					publish: a.publish as boolean | undefined,
				},
				ctx.userId,
			);
		},
	},
	{
		name: "ai_triage_conversation",
		title: "AI auto-triage a conversation",
		description:
			"Use the organization's BYO AI key to classify priority, customer sentiment, and tags for a conversation, escalating frustrated customers automatically.",
		input: {
			organization,
			conversation_id: z.string(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "inbox:reply");
			const actor = await personActor(org, ctx);
			return triageConversationWithAi(actor, a.conversation_id as string);
		},
	},
	{
		name: "ai_email_copy",
		title: "AI email copywriter & subject brainstormer",
		description:
			"Use the organization's BYO AI key to suggest A/B subject lines + preview text ('subjects'), rewrite email copy preserving merge tags ('rewrite'), or review spam/CTA issues ('spam_check').",
		input: {
			organization,
			mode: z.enum(["subjects", "rewrite", "spam_check"]),
			subject: z.string().max(300).optional(),
			body: z.string().min(1).max(12_000),
			instruction: z.string().max(500).optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return aiAssistEmailCopy(org.id, {
				mode: a.mode as "subjects" | "rewrite" | "spam_check",
				subject: a.subject as string | undefined,
				body: a.body as string,
				instruction: a.instruction as string | undefined,
			});
		},
	},
	{
		name: "list_knowledge_sources",
		title: "List AI knowledge sources",
		description:
			"List crawled docs URLs, sitemaps, and Markdown knowledge sources indexed for AI Copilot and Auto-Responder.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return listKnowledgeSources(org.id);
		},
	},
	{
		name: "add_knowledge_source",
		title: "Add an AI knowledge source",
		description:
			"Crawl a docs URL, sitemap.xml, or index Markdown text for AI support grounding.",
		input: {
			organization,
			kind: z.enum(["url", "sitemap", "markdown"]),
			title: z.string().min(1).max(160),
			url: z.string().url().optional(),
			content: z.string().optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return addKnowledgeSource(org.id, rest);
		},
	},
	{
		name: "delete_knowledge_source",
		title: "Delete an AI knowledge source",
		description: "Remove an AI knowledge source and all of its indexed chunks.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			return deleteKnowledgeSource(org.id, a.id as string);
		},
	},
	{
		name: "list_ai_actions",
		title: "List custom AI HTTP actions",
		description: "List custom HTTPS tools configured for the AI support agent.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return listAiActions(org.id);
		},
	},
	{
		name: "save_ai_action",
		title: "Save a custom AI HTTP action",
		description: "Create or update an SSRF-guarded HTTPS tool for the AI support agent.",
		input: {
			organization,
			id: z.string().optional(),
			name: z.string().min(2).max(48),
			description: z.string().min(4).max(300),
			method: z.enum(["GET", "POST"]).default("GET"),
			url: z.string().url(),
			headers: z.record(z.string(), z.string()).optional(),
			body_template: z.string().nullable().optional(),
			enabled: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return saveAiAction(org.id, rest);
		},
	},
	{
		name: "delete_ai_action",
		title: "Delete a custom AI HTTP action",
		description: "Delete a custom AI HTTP action.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			return deleteAiAction(org.id, a.id as string);
		},
	},
	{
		name: "get_status_page",
		title: "Read public Status Page state",
		description: "List status page components, overall status, and active/recent incidents.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return getStatusPageData(org.id);
		},
	},
	{
		name: "save_public_pages_settings",
		title: "Enable or disable public Status Page & B2B Support Portal",
		description:
			"Opt in or out of hosting /status/<slug> and /portal/<slug> for this organization.",
		input: {
			organization,
			status_page_enabled: z.boolean().optional(),
			portal_enabled: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return savePublicPagesSettings(org.id, rest);
		},
	},
	{
		name: "save_status_component",
		title: "Create or update a Status Page component",
		description: "Add or update a Status Page component and its operational status.",
		input: {
			organization,
			id: z.string().optional(),
			name: z.string().min(1).max(80),
			description: z.string().max(240).nullable().optional(),
			status: z.enum(COMPONENT_STATUSES).default("operational"),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return saveStatusComponent(org.id, rest);
		},
	},
	{
		name: "delete_status_component",
		title: "Delete a Status Page component",
		description: "Remove a Status Page component from /status/<slug>.",
		input: { organization, id: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			return deleteStatusComponent(org.id, a.id as string);
		},
	},
	{
		name: "create_status_incident",
		title: "Post a Status Page incident",
		description:
			"Create an incident on /status/<slug> and activate the live outage banner in the chat widget.",
		input: {
			organization,
			title: z.string().min(2).max(160),
			impact: z.enum(INCIDENT_IMPACTS).default("minor"),
			status: z.enum(INCIDENT_STATUSES).default("investigating"),
			message: z.string().min(2).max(4000),
			component_ids: z.array(z.string()).max(20).optional(),
			component_status: z.enum(COMPONENT_STATUSES).optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return createStatusIncident(org.id, rest, ctx.userId);
		},
	},
	{
		name: "post_incident_update",
		title: "Post an update on a Status Page incident",
		description: "Add a timeline update or resolve an existing Status Page incident.",
		input: {
			organization,
			incident_id: z.string(),
			status: z.enum(INCIDENT_STATUSES),
			message: z.string().min(2).max(4000),
			component_status: z.enum(COMPONENT_STATUSES).optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return postIncidentUpdate(org.id, rest, ctx.userId);
		},
	},
	{
		name: "list_omnichannel_settings",
		title: "List WhatsApp & Telegram omnichannel bridge status",
		description:
			"Read webhook URLs and connection status for WhatsApp Cloud API and Telegram Bot bridges.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return listOmnichannelSettings(org.id);
		},
	},
	{
		name: "save_domain_warmup",
		title: "Configure automated domain warm-up ramp",
		description:
			"Enable or update a domain's automated daily send ramp (daily_start -> daily_max over ramp_days with automatic bounce-rate protection).",
		input: {
			organization,
			domain_id: z.string(),
			enabled: z.boolean(),
			start_date: z.string().optional(),
			daily_start: z.number().int().min(10).max(50_000).default(100),
			daily_max: z.number().int().min(50).max(5_000_000).default(25_000),
			ramp_days: z.number().int().min(3).max(90).default(14),
			pause_bounce_rate: z.number().min(0.005).max(0.2).optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "domains:manage");
			const { organization: _o, domain_id, ...rest } = a;
			return saveDomainWarmup(org.id, domain_id as string, rest);
		},
	},
];
