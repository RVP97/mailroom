import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The live demo: the dashboard's own routes, pages and components, built as static files. Its
 * server functions (src/functions) run in the browser against SQLite (demo/d1.ts) filled with
 * demo data (demo/seed), so the demo is the app itself, with nothing behind it.
 *
 *   bun run demo:dev     # http://localhost:5174/
 *   bun run demo:build   # site/demo/, published with the website
 */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SRC = here("../src/");

/** Modules swapped for the demo's versions. */
const SWAP: Record<string, string> = {
	"cloudflare:workers": here("./shims/cloudflare-workers.ts"),
	"@tanstack/react-start": here("./shims/start.ts"),
	"@tanstack/react-start/server": here("./shims/start-server.ts"),
	"node:crypto": here("./shims/node.ts"),
	"node:async_hooks": here("./shims/node.ts"),
	// The Worker's entry (src/server.ts) runs in the page too, for its public pages.
	"@sentry/cloudflare": here("./shims/sentry-cloudflare.ts"),
	"@tanstack/react-start/server-entry": here("./shims/server-entry.ts"),
	"@resvg/resvg-wasm/index_bg.wasm": here("./shims/resvg-wasm.ts"),
};
const SWAP_FILES: Record<string, string> = {
	[`${SRC}server/auth.ts`]: here("./shims/auth.ts"),
	[`${SRC}lib/auth-client.ts`]: here("./shims/auth-client.ts"),
};

function demo(): Plugin {
	return {
		name: "mailroom-demo",
		enforce: "pre",
		async resolveId(source, importer, options) {
			if (SWAP[source]) return SWAP[source];
			if (!importer || importer.includes("/demo/shims/")) return null;
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			const swapped = resolved && SWAP_FILES[resolved.id.split("?")[0] as string];
			return swapped ?? null;
		},
		transform(code, id) {
			// Organization logos are at the Worker's /logos/: here, the demo's worker/ path
			// (demo/worker.ts answers it).
			if (id === `${SRC}server/org-logos.ts`)
				return code.replace(
					"`/logos/",
					"`${typeof location === 'undefined' ? '' : location.origin + import.meta.env.BASE_URL + 'worker'}/logos/",
				);
			// The chat's preview loads the widget from the Worker's address, which is under a path here.
			if (id === `${SRC}routes/_app/received.chat.$id.tsx`)
				return (
					code
						.replace(
							"${new URL(widget.test_page).origin}/chat/",
							'${widget.test_page.split("/chat/")[0]}/chat/',
						)
						// Same origin, so the demo's service worker answers the widget's calls too.
						.replace(
							'sandbox="allow-scripts allow-forms"',
							'sandbox="allow-scripts allow-forms allow-same-origin"',
						)
				);
			if (id === `${SRC}components/org-logo-card.tsx`)
				return code.replace(
					'shown.startsWith("/logos/")',
					'shown.includes("/worker/logos/")',
				);
			// Each server function learns its name, as TanStack's compiler gives it (the activity
			// log and the permission checks read it).
			if (!id.startsWith(`${SRC}functions/`)) return null;
			return code.replace(
				/export const (\w+) = createServerFn\(/g,
				(_m, name) => `export const ${name} = createServerFn(${JSON.stringify(name)}, `,
			);
		},
	};
}

export default defineConfig({
	root: here("./"),
	base: process.env.DEMO_BASE ?? "/",
	resolve: { tsconfigPaths: true, alias: { "@/": SRC } },
	define: {
		__SENTRY_DSN__: JSON.stringify(""),
		__SENTRY_RELEASE__: JSON.stringify(""),
		__SENTRY_ISSUES_URL__: JSON.stringify(""),
	},
	plugins: [demo(), tailwindcss(), viteReact()],
	server: { port: Number(process.env.PORT) || 5174 },
	build: {
		outDir: here("../site/demo"),
		emptyOutDir: true,
		chunkSizeWarningLimit: 8000,
		// One file: split, the server code's import cycles (Drizzle's tables among them) can run
		// a chunk before the one it needs.
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
