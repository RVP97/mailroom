import { z } from "zod";
import { AccessError } from "../access";
import { aiAssistEmailCopy, triageConversationWithAi } from "../ai";
import { listBillingConnectors } from "../billing-connectors";
import { brandIds, brandIn } from "../brands";
import { deleteCompany, getCompany, listCompanies, upsertCompany } from "../companies";
import { importContactsBundle, importHelpArticlesBundle } from "../importers";
import {
	linkConversationIssue,
	listConversationIssues,
	unlinkConversationIssue,
} from "../issue-links";
import { getBrandTransport, transportView } from "../transports";
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
];
