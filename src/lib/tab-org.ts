import { isOrgHandle } from "./org-handle";
import { handleOfPath, isAppSectionPath, orgPath } from "./org-path";

/**
 * The organization a browser tab shows: the handle its address starts with
 * (mailroom.example.com/k7x2m9/…, src/lib/org-path.ts). The session only remembers the last one
 * used, which every tab shares; each tab acts on its own: it sends its handle with every server
 * function call (src/start.ts) and its live chat connection, and the server acts on that
 * organization after checking the person is a member of it (src/server/middleware.ts). So
 * switching organization in one tab never changes what another one reads or saves.
 *
 * The router puts this handle on every organization page's address (src/router.tsx); switching
 * organization in this tab (src/lib/switch-org.ts) changes it first.
 */
export const ORG_HEADER = "x-mailroom-org";

/** The same, as a query parameter, where a header can't go (the chat's WebSocket). */
export const ORG_PARAM = "org";

/** Why a call naming an organization was refused: it doesn't exist, or isn't the person's. */
export const ORG_UNAVAILABLE = "This organization doesn't exist or you don't have access to it.";

/** The header that marks that refusal (a 404 Response), so the browser tells it from others. */
export const ORG_UNAVAILABLE_HEADER = "x-mailroom-org-unavailable";

/** A server call's refusal of the organization the tab named (src/server/middleware.ts). */
export const isOrgUnavailable = (error: unknown) =>
	error instanceof Response &&
	error.status === 404 &&
	error.headers.get(ORG_UNAVAILABLE_HEADER) === "1";

// Browser only: this tab's own organization.
let pinned: string | undefined =
	typeof window === "undefined" ? undefined : handleOfPath(window.location.pathname);

/** The tab's organization handle. Undefined on the server. */
export function tabHandle(): string | undefined {
	return pinned;
}

/**
 * The tab's organization from the dashboard's data, when its address names none (a person's
 * page such as /account opened first): the organization its links and calls are about.
 */
export function adoptHandle(handle: string | null | undefined) {
	if (typeof window === "undefined") return;
	if (!pinned && isOrgHandle(handle)) pinned = handle;
	fixPlainLinks();
}

/** This tab now shows `handle`'s pages: from now on its calls and addresses are that one's. */
export function setTabHandle(handle: string) {
	if (typeof window === "undefined") return;
	pinned = handle;
	fixPlainLinks();
}

/**
 * The tab's organization refused by the server (ORG_UNAVAILABLE) while the address names another
 * one, or none: what's stale is what the tab remembered, not the address (the session changed
 * in another tab: someone else signed in). The tab takes the address's organization, or none,
 * and says whether that changed, so the caller asks once more instead of showing «no access» on
 * every page until a reload.
 */
export function repinFromAddress(pathname = currentPath()): boolean {
	if (typeof window === "undefined") return false;
	const address = handleOfPath(pathname);
	if (pinned === address) return false;
	pinned = address;
	return true;
}

const currentPath = () => (typeof window === "undefined" ? "/" : window.location.pathname);

/** A link's same-origin path with the tab's organization, if it's one of its pages without one. */
export function withTabHandle(href: string, handle = pinned): string {
	if (!handle || !href.startsWith("/") || href.startsWith("//")) return href;
	const pathname = href.split(/[?#]/)[0] || "/";
	if (handleOfPath(pathname) || !isAppSectionPath(pathname)) return href;
	return orgPath(handle, href);
}

let listening = false;

/**
 * A plain <a href="/emails"> (written in text or Markdown, not the router's Link) misses the
 * router's rewrite: its address gets the tab's organization just before it's used (click,
 * middle click, the context menu's «open in new tab», dragging it out), so a new tab opens this
 * tab's organization, not the one the person last used elsewhere.
 */
function fixPlainLinks() {
	if (listening || typeof document === "undefined") return;
	listening = true;
	const fix = (event: Event) => {
		const target = event.target instanceof Element ? event.target : null;
		const a = target?.closest("a[href]");
		if (!(a instanceof HTMLAnchorElement) || a.origin !== location.origin) return;
		const href = `${a.pathname}${a.search}${a.hash}`;
		const next = withTabHandle(href);
		if (next !== href) a.setAttribute("href", next);
	};
	for (const type of ["click", "auxclick", "contextmenu", "dragstart"])
		document.addEventListener(type, fix, { capture: true });
}
