import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AccessError } from "../access";
import { ApiError } from "../errors";
import { authenticateInbox, type InboxActor, listInboxes } from "../inboxes";
import { limitKey } from "../rate-limit";
import { AGENT_INSTRUCTIONS, INBOX_TOOLS } from "./inbox-tools";
import type { McpGrantProps } from "./oauth";
import { type McpContext, memberships, TOOLS } from "./tools";

/**
 * The MCP server at /mcp (streamable HTTP, stateless: one server per request, JSON responses).
 * The resource server (oauth.ts) has validated the token; here every call reads the person's
 * organizations and role again, and each tool checks what it needs (member, owner or admin, or
 * one of the deployment's admins).
 */

const INSTRUCTIONS = `Mailroom is a Resend-style email platform on Amazon SES. Each organization is one business; its brands (list_brands) are who its emails are from, each its own SES tenant with its own domains, contacts, suppressions and reputation. Tools that act on an organization take \`organization\` (its slug, id or name); call list_organizations first when the person belongs to several (it also lists your permissions there). Tools that act on one brand take \`brand\`; without it, the organization's own.

What's here, by area (everything the dashboard does):
- Sending: send_email (also scheduled, with attachments or as a sandbox check), list_emails, get_email, cancel_email, get_stats, get_insights, get_insight_detail, sending_status.
- Broadcasts and newsletters: save_broadcast (html, a block design or a template), send_broadcast (now, later, local time, A/B test), send_broadcast_test, review_broadcast (approval), list_versions / restore_version, comments, campaigns, newsletters (public archive, RSS, referrals), templates, saved sections, brand kits, upload_file for images.
- Audience: contacts, import_contacts, segments, topics, properties, sign-up forms, get_growth, get_engagement / clean_up_contacts, automations and send_event.
- Received mail and inboxes: list_received_emails, inbound rules, agent inboxes and their conversations (list_conversations, get_conversation, save_draft, send_reply…), website chat.
- Deliverability: domains (add, verify, DNS help, tracking, BIMI), check_deliverability, domain_health, dmarc_reports, suppressions, unsubscribes, the email firewall, lookup_recipient.
- Team and settings: list_team, invite_member, change_member, roles and permissions, get/update_organization_settings, list_activity, list_access_log, webhooks and their deliveries, API keys and API logs.

Lists page with \`after\`, \`before\` or \`offset\` as each tool says. Changes are checked against the person's role and recorded in the activity log as made by the assistant. Confirm with the person before anything that sends to many people or deletes. API key, SMTP password, webhook secret and inbox credential values are never shown here: an app's Worker gets them with the repo's scripts/connect-app.sh, and people make inbox credentials in the dashboard.`;

function text(value: unknown): CallToolResult {
	return {
		// A tool that returns nothing (set_up_sending) still answers with text, which MCP requires.
		content: [{ type: "text", text: JSON.stringify(value ?? null, null, 2) }],
		// Structured content is an object: a list goes under `data`.
		structuredContent: (Array.isArray(value) || value === null || typeof value !== "object"
			? { data: value ?? null }
			: value) as Record<string, unknown>,
	};
}

function failure(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

export function buildServer(ctx: McpContext) {
	const server = new McpServer(
		{ name: "Mailroom", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);
	for (const tool of TOOLS) {
		if (tool.adminOnly && !ctx.isAdmin) continue;
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.input,
				annotations: {
					title: tool.title,
					readOnlyHint: tool.readOnly ?? false,
					destructiveHint: tool.destructive ?? false,
					openWorldHint: tool.openWorld ?? false,
				},
			},
			async (args: Record<string, unknown>) => {
				try {
					return text(await tool.run(args as never, { ...ctx, tool: tool.name }));
				} catch (error) {
					if (error instanceof ApiError) return failure(error.message);
					if (error instanceof AccessError) return failure(error.message);
					if (error instanceof z.ZodError)
						return failure(
							`${error.issues[0]?.path.join(".") || "input"}: ${error.issues[0]?.message}`,
						);
					console.error("mcp: tool failed", tool.name, error);
					return failure(
						"Something went wrong on Mailroom's side. Try again in a moment.",
					);
				}
			},
		);
	}
	return server;
}

/** The MCP server an agent gets with its inbox's credential: the inbox tools its credential
 * allows, on its inbox only (every call is checked again server-side). */
export function buildAgentServer(actor: InboxActor, address: string | null) {
	const server = new McpServer(
		{ name: "Mailroom inbox", version: "1.0.0" },
		{ instructions: AGENT_INSTRUCTIONS(address) },
	);
	for (const tool of INBOX_TOOLS) {
		if (!actor.permissions.has(tool.needs)) continue;
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.input,
				annotations: {
					title: tool.title,
					readOnlyHint: tool.readOnly ?? false,
					destructiveHint: tool.destructive ?? false,
					openWorldHint: tool.openWorld ?? false,
				},
			},
			async (args: Record<string, unknown>) => {
				try {
					return text(await tool.run(args, actor));
				} catch (error) {
					if (error instanceof ApiError) return failure(error.message);
					if (error instanceof z.ZodError)
						return failure(
							`${error.issues[0]?.path.join(".") || "input"}: ${error.issues[0]?.message}`,
						);
					console.error("mcp: inbox tool failed", tool.name, error);
					return failure(
						"Something went wrong on Mailroom's side. Try again in a moment.",
					);
				}
			},
		);
	}
	return server;
}

/** /mcp with Authorization: Bearer mri_… (no OAuth: the credential is the grant). */
export async function agentMcpFetch(request: Request): Promise<Response> {
	const actor = await authenticateInbox(request.headers.get("authorization"));
	if (!actor)
		return Response.json(
			{
				error: "invalid_token",
				error_description: "Missing, revoked or invalid inbox credential",
			},
			{ status: 401 },
		);
	try {
		await limitKey(actor.id as string);
	} catch (error) {
		if (error instanceof ApiError) return error.toResponse();
		throw error;
	}
	const inboxes = await listInboxes(actor);
	const server = buildAgentServer(actor, inboxes.map((i) => i.address).join(", ") || null);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	transport.onerror = (error) => console.warn("mcp transport", error.message);
	await server.connect(transport);
	return transport.handleRequest(request);
}

export async function mcpFetch(request: Request, props: McpGrantProps): Promise<Response> {
	const { isAdminEmail } = await import("../env");
	const ctx: McpContext = {
		userId: props.userId,
		email: props.email,
		isAdmin: isAdminEmail(props.email),
		organizations: await memberships(props.userId),
	};
	const server = buildServer(ctx);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	});
	transport.onerror = (error) => console.warn("mcp transport", error.message);
	await server.connect(transport);
	return transport.handleRequest(request);
}
