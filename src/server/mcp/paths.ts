/**
 * The MCP server's and its OAuth endpoints' paths. Their own module: src/server.ts checks every
 * request against them, and the OAuth library loads only for those requests.
 */

export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/oauth/token";
export const REGISTER_PATH = "/oauth/register";
export const MCP_PATH = "/mcp";

export const WELL_KNOWN_RESOURCE = "/.well-known/oauth-protected-resource";
export const WELL_KNOWN_AS = "/.well-known/oauth-authorization-server";

/** Whether src/server.ts hands the request to handleOAuth instead of the app. */
export function isOAuthPath(pathname: string): boolean {
	return (
		pathname === MCP_PATH ||
		pathname.startsWith(`${MCP_PATH}/`) ||
		pathname === TOKEN_PATH ||
		pathname === REGISTER_PATH ||
		pathname === WELL_KNOWN_RESOURCE ||
		pathname.startsWith(`${WELL_KNOWN_RESOURCE}/`) ||
		pathname === WELL_KNOWN_AS ||
		pathname.startsWith(`${WELL_KNOWN_AS}/`)
	);
}
