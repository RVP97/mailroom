import { createRouter } from "@tanstack/react-router";
import { PageError, PagePending } from "@/components/route-states";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	return createRouter({
		routeTree,
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
}

declare module "@tanstack/react-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
