import { env } from "cloudflare:workers";
import {
	OAuthAuthorizationServer,
	type OAuthHelpers,
	OAuthResourceServer,
} from "@cloudflare/workers-oauth-provider";
import { eq } from "drizzle-orm";
import { db, schema } from "../db";
import { baseUrl } from "../env";
import { AUTHORIZE_PATH, MCP_PATH, REGISTER_PATH, TOKEN_PATH, WELL_KNOWN_RESOURCE } from "./paths";

/**
 * OAuth 2.1 for the MCP server (a Claude or ChatGPT connector), with Cloudflare's
 * workers-oauth-provider: this Worker is both the authorization server and the protected resource
 * `<origin>/mcp`. Clients register by CIMD or DCR, PKCE is required, tokens are bound to the
 * resource and stored hashed in OAUTH_KV. The authorization endpoint is the consent page
 * (/oauth/authorize, src/routes/oauth.authorize.tsx), which signs the person in first.
 */

export const MCP_SCOPES = ["mailroom"] as const;

/** What the consent page stores with the grant; every /mcp call gets it back. */
export interface McpGrantProps {
	userId: string;
	email: string;
	clientName: string;
}

export const issuer = () => new URL(baseUrl() || "http://localhost:3000").origin;

let servers: {
	as: OAuthAuthorizationServer<Env>;
	resource: OAuthResourceServer<Env, McpGrantProps>;
} | null = null;

function oauthServers() {
	if (servers) return servers;
	const iss = issuer();
	const resource = `${iss}${MCP_PATH}`;
	const as = new OAuthAuthorizationServer<Env>({
		issuer: iss,
		resources: [resource],
		authorizeEndpoint: AUTHORIZE_PATH,
		tokenEndpoint: TOKEN_PATH,
		clientRegistrationEndpoint: REGISTER_PATH,
		scopesSupported: [...MCP_SCOPES],
		clientIdMetadataDocumentEnabled: true,
		accessTokenTTL: 60 * 60,
		// A connection lives while it's used: 30 days from its last refresh.
		refreshTokenTTL: 30 * 24 * 60 * 60,
		refreshTokenIdleTTL: 30 * 24 * 60 * 60,
		onError: ({ code, description }) => console.warn("oauth", code, description),
	});
	const rs = new OAuthResourceServer<Env, McpGrantProps>({
		resourceMetadata: {
			resource,
			authorization_servers: [iss],
			bearer_methods_supported: ["header"],
			resource_name: "Mailroom",
		},
		validateToken: (e) => async (res, token) => {
			const v = await as.validateToken<McpGrantProps>(res, token, e);
			if (!v) return null;
			// A person removed from Mailroom loses the connection with their account.
			const user = await db
				.select({ id: schema.user.id, email: schema.user.email })
				.from(schema.user)
				.where(eq(schema.user.id, v.props.userId))
				.get();
			return user ? { ...v, props: { ...v.props, email: user.email } } : null;
		},
		handler: {
			fetch: async (request, _e, ctx) =>
				(await import("./server")).mcpFetch(request, ctx.props),
		},
	});
	servers = { as, resource: rs };
	return servers;
}

/** The consent page's helpers (parse and complete authorization requests). */
export function oauthApi(): OAuthHelpers {
	return oauthServers().as.getOAuthApi(env as unknown as Env);
}

/** /mcp and its metadata, the token, registration and metadata endpoints. */
export async function handleOAuth(request: Request, e: Env, ctx: ExecutionContext) {
	const url = new URL(request.url);
	// An agent inbox's credential is its own grant: no OAuth for it.
	if (
		(url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`)) &&
		/^Bearer\s+mri_/.test(request.headers.get("authorization") ?? "")
	)
		return (await import("./server")).agentMcpFetch(request);
	const { as, resource } = oauthServers();
	if (url.pathname === WELL_KNOWN_RESOURCE) {
		// Clients that ask at the root get the one resource's document.
		url.pathname = `${WELL_KNOWN_RESOURCE}${MCP_PATH}`;
		return resource.fetch(new Request(url, request), e, ctx);
	}
	if (url.pathname.startsWith(WELL_KNOWN_RESOURCE) || url.pathname.startsWith(MCP_PATH))
		return resource.fetch(request, e, ctx);
	return as.fetch(request, e, ctx);
}
