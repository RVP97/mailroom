import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { initSentry, reactErrorHandlers } from "./lib/sentry";
import { getRouter } from "./router";

initSentry();

/**
 * The server's first paint has the page's own skeleton (FirstPaint, in routes/_app.tsx), whose code
 * comes with the page's. Loading that code before hydrating keeps it on screen: otherwise the
 * skeleton waits on it while the dashboard starts, and React drops it for an empty frame.
 */
async function loadPageCode() {
	try {
		const router = getRouter();
		const leaf = router.matchRoutes(router.parseLocation(router.history.location)).at(-1);
		const route = leaf && router.routesById[leaf.routeId as keyof typeof router.routesById];
		if (route) await router.loadRouteChunk(route);
	} catch {}
}

void loadPageCode().then(() =>
	startTransition(() => {
		hydrateRoot(
			document,
			<StrictMode>
				<StartClient />
			</StrictMode>,
			reactErrorHandlers,
		);
	}),
);
