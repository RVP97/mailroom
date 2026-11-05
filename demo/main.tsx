import "./shims/buffer";
import { createHashHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { PageError, PagePending } from "@/components/route-states";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keepTapsInScrollLocks } from "@/lib/tap-slop";
import { routeTree } from "@/routeTree.gen";
import { DemoBar } from "./bar";
import { installClock } from "./clock";
import { openDemoDb } from "./d1";
import { installOutside } from "./outside";
import { ORG } from "./seed/ids";
import { demoSession } from "./session";
import { shiftDates } from "./shift";
import { installWorker } from "./worker";
import "./demo.css";

/** The page around every route: what the app's RootDocument has, without <html> (the browser's). */
function Shell({ children }: { children: React.ReactNode }) {
	useEffect(() => keepTapsInScrollLocks(), []);
	return (
		<ThemeProvider>
			<TooltipProvider>
				<DemoBar />
				{children}
				<Toaster position="bottom-right" />
			</TooltipProvider>
		</ThemeProvider>
	);
}

async function start() {
	installClock();
	installOutside();
	// The database the build seeded (demo/build-db.mjs), its dates moved up to today.
	const res = await fetch(`${import.meta.env.BASE_URL}demo.db.gz`);
	if (!res.ok) throw new Error(`demo.db.gz: ${res.status}`);
	let data = new Uint8Array(await res.arrayBuffer());
	// Still gzipped unless the server already said Content-Encoding: gzip.
	if (data[0] === 0x1f && data[1] === 0x8b)
		data = new Uint8Array(
			await new Response(
				new Blob([data]).stream().pipeThrough(new DecompressionStream("gzip")),
			).arrayBuffer(),
		);
	const sqlite = await openDemoDb({ wasm: wasmUrl, data });
	const builtAt = Number(
		sqlite.exec("SELECT built_at FROM demo_meta")[0]?.values[0]?.[0] ?? Date.now(),
	);
	shiftDates(sqlite, builtAt);
	demoSession.activeOrganizationId ??= ORG;
	installWorker();

	(routeTree.options as { shellComponent?: unknown }).shellComponent = Shell;
	const router = createRouter({
		routeTree,
		history: createHashHistory(),
		scrollRestoration: true,
		defaultPreload: "intent",
		defaultPreloadDelay: 40,
		defaultPreloadStaleTime: 30_000,
		defaultStaleTime: 0,
		defaultGcTime: 30 * 60_000,
		defaultPendingMs: 400,
		defaultPendingMinMs: 150,
		defaultPendingComponent: PagePending,
		defaultErrorComponent: PageError,
	});
	document.getElementById("boot")?.remove();
	createRoot(document.getElementById("root") as HTMLElement).render(
		<StrictMode>
			<RouterProvider router={router} />
		</StrictMode>,
	);
}

void start().catch((error) => {
	console.error(error);
	const boot = document.getElementById("boot");
	if (boot) boot.textContent = `The demo didn't start: ${(error as Error).message}`;
});
