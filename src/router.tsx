import { createRouter } from "@tanstack/react-router";
import { PageError, PagePending } from "@/components/route-states";
import { handleOfPath, isAppSectionPath, orgPath } from "@/lib/org-path";
import { adoptHandle, tabHandle } from "@/lib/tab-org";
import { routeTree } from "./routeTree.gen";

/**
 * The organization whose pages this router's links open: the tab's (src/lib/tab-org.ts), or on
 * the server the one the requested address names (src/server.ts), so the first paint's links are
 * the same ones the browser renders.
 */
function linkHandle(): string | undefined {
	if (typeof window !== "undefined") return tabHandle();
	return (globalThis as { __requestHandle?: () => string | undefined }).__requestHandle?.();
}

/**
 * Addresses name their organization (mailroom.example.com/k7x2m9/emails, src/lib/org-path.ts);
 * the router doesn't: routes, links, navigate() and path checks work with /emails. The handle
 * comes off on the way in and the tab's goes back on on the way out, so every link a tab renders
 * opens its own organization, in a new tab too. Person pages (/account), the public pages and
 * /api never get one.
 */
const orgInAddress = {
	input: ({ url }: { url: URL }) => {
		const handle = handleOfPath(url.pathname);
		if (handle) url.pathname = url.pathname.slice(handle.length + 1) || "/";
		return url;
	},
	output: ({ url }: { url: URL }) => {
		const handle = linkHandle();
		if (handle && isAppSectionPath(url.pathname) && !handleOfPath(url.pathname))
			url.pathname = orgPath(handle, url.pathname);
		return url;
	},
};

export function getRouter() {
	const router = createRouter({
		routeTree,
		rewrite: orgInAddress,
		scrollRestoration: true,
		// Hovering (or touching) a link fetches its page, so the click itself opens it at once.
		defaultPreload: "intent",
		defaultPreloadDelay: 40,
		defaultPreloadStaleTime: 30_000,
		// A page seen before opens from the cache and refreshes in the background...
		defaultStaleTime: 0,
		// ...for half an hour after leaving it (the router forgets it after 5 minutes otherwise).
		defaultGcTime: 30 * 60_000,
		// A click to a page that still has to load shows its skeleton after 60 ms (the dashboard's
		// layout does that, useEnteringPage). This is the fallback for loads the layout doesn't
		// cover; pages with filters in the URL set pendingMs: Infinity and show their own.
		defaultPendingMs: 400,
		defaultPendingMinMs: 150,
		defaultPendingComponent: PagePending,
		defaultErrorComponent: PageError,
	});
	if (typeof window !== "undefined") {
		// Plain <a href> links get the tab's organization too (src/lib/tab-org.ts).
		adoptHandle(undefined);
		// Back or forward to another organization's page: a full page load of it, which can't
		// show anything this tab kept of the one it had (switching in the tab sets the handle
		// first, src/lib/switch-org.ts, so its own pushes never get here). Subscribed before the
		// router's own listener. `location` is where the history is moving to: on a push the
		// address bar still holds the old address for a moment, and reading window.location
		// here would send a switch straight back to the previous organization.
		router.history.subscribe(({ location, action }) => {
			if (action.type !== "BACK" && action.type !== "FORWARD" && action.type !== "GO") return;
			const handle = handleOfPath(location.pathname);
			const tab = tabHandle();
			if (handle && tab && handle !== tab) window.location.reload();
		});
	}
	return router;
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
