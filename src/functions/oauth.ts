import {
	AuthorizationError,
	authorizationErrorRedirect,
	CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AUTHORIZE_PATH } from "@/server/mcp/paths";
import { sessionMiddleware } from "@/server/middleware";

/**
 * The consent page (/oauth/authorize) of the MCP server. The page posts back the authorization
 * request's query, which is parsed and validated again here (client, redirect URI, PKCE,
 * resource), never trusted from the form.
 */

async function authRequest(query: string) {
	const { issuer, oauthApi } = await import("@/server/mcp/oauth");
	const q = query.startsWith("?") ? query.slice(1) : query;
	try {
		return await oauthApi().parseAuthRequest(new Request(`${issuer()}${AUTHORIZE_PATH}?${q}`));
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo)
			return { redirectTo: error.redirectTo as string };
		if (error instanceof AuthorizationError || error instanceof CimdFetchError)
			throw new Response(
				"This connection request isn't valid. Go back to the app and connect Mailroom again.",
				{ status: 400 },
			);
		throw error;
	}
}

export const consentFn = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.validator(z.object({ query: z.string() }))
	.handler(async ({ data, context }) => {
		const request = await authRequest(data.query);
		if ("redirectTo" in request) return { redirectTo: request.redirectTo };
		const { oauthApi } = await import("@/server/mcp/oauth");
		const d = await oauthApi().describeConsent(request);
		return {
			client: {
				name: d.clientName,
				domain: d.clientDomain ?? null,
				redirectHost: d.redirectHost,
			},
			email: context.email,
		};
	});

export const approveFn = createServerFn({ method: "POST" })
	.middleware([sessionMiddleware])
	.validator(z.object({ query: z.string(), allow: z.boolean() }))
	.handler(async ({ data, context }) => {
		const request = await authRequest(data.query);
		if ("redirectTo" in request) return { redirectTo: request.redirectTo };
		if (!data.allow)
			return { redirectTo: authorizationErrorRedirect(request, "access_denied") };
		const { MCP_SCOPES, oauthApi } = await import("@/server/mcp/oauth");
		const d = await oauthApi().describeConsent(request);
		return oauthApi().completeAuthorization({
			request,
			userId: context.userId,
			scope: [...MCP_SCOPES],
			metadata: { clientName: d.clientName, email: context.email },
			props: { userId: context.userId, email: context.email, clientName: d.clientName },
		});
	});
