import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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

const INSTRUCTIONS = `Mailroom is a Resend-style email platform on Amazon SES. Each organization is one business (its own SES tenant): its domains, API keys, webhooks, emails and suppressions. Tools that act on an organization take \`organization\` (its slug, id or name); call list_organizations first when the person belongs to several. API key and webhook secret values are never shown here: an app's Worker gets them with the repo's scripts/connect-app.sh.`;

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
	const inbox = (await listInboxes(actor))[0] ?? null;
	const server = buildAgentServer(actor, inbox?.address ?? null);
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
