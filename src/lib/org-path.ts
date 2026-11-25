import { isOrgHandle } from "./org-handle";

/**
 * An organization's pages are at /<handle>/<page>… (mailroom.example.com/k7x2m9/emails). Inside
 * the app the router works with the path without the handle (/emails) and puts the tab's handle
 * back on the address (src/router.tsx, rewrite), so route files, links and path checks never see
 * it. These helpers read and build those addresses.
 */

/**
 * The dashboard's pages about the person or the whole deployment, not an organization: their
 * address has no handle (/account). src/routes/_app/ files whose first segment is one of these.
 */
export const PERSON_PAGES: ReadonlySet<string> = new Set(["account", "admin"]);

/**
 * The first path segment of every organization page: every file in src/routes/_app/ but
 * PERSON_PAGES (and index, which is "/"). scripts/check-org-urls.mjs (in the build) fails when it
 * and the folder differ, so a new page can't be forgotten.
 */
export const APP_SECTIONS: ReadonlySet<string> = new Set([
	"activity",
	"api-keys",
	"articles",
	"automations",
	"brands",
	"broadcasts",
	"calendar",
	"campaigns",
	"companies",
	"contacts",
	"docs",
	"domains",
	"emails",
	"insights",
	"logs",
	"newsletters",
	"received",
	"recipients",
	"settings",
	"suppressions",
	"surveys",
	"templates",
	"today",
	"webhooks",
]);

/** The organization handle a path starts with, if any. */
export function handleOfPath(pathname: string): string | undefined {
	const first = pathname.split("/")[1];
	return isOrgHandle(first) ? first : undefined;
}

/**
 * The path inside the organization, without its handle: "/k7x2m9/emails/x" → "/emails/x",
 * "/k7x2m9" → "/". Other paths come back as they are.
 */
export function sectionPath(pathname: string): string {
	const handle = handleOfPath(pathname);
	if (!handle) return pathname;
	return pathname.slice(handle.length + 1) || "/";
}

/** Whether `pathname` (without a handle) is an organization page: "/emails/x", "/". */
export function isAppSectionPath(pathname: string): boolean {
	if (pathname === "/" || pathname === "") return true;
	return APP_SECTIONS.has(pathname.split("/")[1] ?? "");
}

/** An organization page's path: ("k7x2m9", "/emails?x=1") → "/k7x2m9/emails?x=1". */
export function orgPath(handle: string, path: string): string {
	if (path === "/" || path === "") return `/${handle}`;
	if (path.startsWith("/?") || path.startsWith("/#")) return `/${handle}${path.slice(1)}`;
	return `/${handle}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * `path` among `handle`'s pages when it is an organization page ("/received/x?tab=1" →
 * "/k7x2m9/received/x?tab=1"), for links that leave the app (emails, the MCP's answers): they
 * open that organization, not whichever the person used last. Anything else comes back as it is:
 * a person's page, /api, a public page, a path that already names an organization, a full URL.
 */
export function inOrg(handle: string | null | undefined, path: string): string {
	if (!handle || !isOrgHandle(handle) || !path.startsWith("/") || path.startsWith("//"))
		return path;
	const pathname = path.split(/[?#]/)[0] || "/";
	if (handleOfPath(pathname) || !isAppSectionPath(pathname)) return path;
	return orgPath(handle, path);
}
