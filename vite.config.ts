import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import ts from "typescript";
import { defineConfig } from "vite";

/** Sentry's DSN, from wrangler.jsonc's vars (it's public: it ships in the browser's code). */
const sentryDsn: string =
	process.env.SENTRY_DSN ??
	ts.parseConfigFileTextToJson("wrangler.jsonc", readFileSync("wrangler.jsonc", "utf8")).config
		?.vars?.SENTRY_DSN ??
	"";

/** Admin › Error tracking's "Open Sentry": https://<SENTRY_ORG>.sentry.io/issues/?project=<the
 * DSN's project id>. Empty without SENTRY_ORG (the build variable sentry-upload.mjs uses too). */
const sentryIssuesUrl = (() => {
	const org = process.env.SENTRY_ORG?.trim();
	const project = sentryDsn.match(/\/(\d+)\/?$/)?.[1];
	return org && project ? `https://${org}.sentry.io/issues/?project=${project}` : "";
})();

/** The release: the commit being built (Workers Builds sets WORKERS_CI_COMMIT_SHA). */
const release = (() => {
	if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
	try {
		return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return "";
	}
})();

export default defineConfig(({ command }) => ({
	resolve: { tsconfigPaths: true },
	define: {
		__SENTRY_DSN__: JSON.stringify(sentryDsn),
		__SENTRY_RELEASE__: JSON.stringify(release),
		__SENTRY_ISSUES_URL__: JSON.stringify(sentryIssuesUrl),
	},
	// The browser's source maps, for Sentry: hidden (no sourceMappingURL in the files),
	// set aside and uploaded by scripts/sentry-upload.mjs, never served.
	build: { sourcemap: "hidden" },
	// The preview pane picks the port (PORT); `bun run dev` keeps 3000.
	server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
	plugins: [
		cloudflare({
			viteEnvironment: { name: "ssr" },
			// Dev: auth runs on the local URL; builds keep wrangler.jsonc's.
			config:
				command === "serve"
					? { vars: { BETTER_AUTH_URL: `http://localhost:${process.env.PORT || 3000}` } }
					: undefined,
		}),
		tailwindcss(),
		tanstackStart({
			router: {
				// A page's skeleton is the page drawn with stand-in data (src/lib/sketch.tsx), so its
				// pendingComponent and component share their chunk. The dashboard's frame isn't split:
				// it's the first paint.
				codeSplittingOptions: {
					splitBehavior: ({ routeId }) =>
						routeId === "/_app"
							? []
							: [
									["component", "pendingComponent"],
									["errorComponent"],
									["notFoundComponent"],
								],
				},
			},
		}),
		viteReact(),
	],
	// Rolldown's chunks import each other in a cycle (drizzle-orm ↔ the app's), and without this the
	// Worker throws at startup reading `Table.Symbol` before pg-core's Table is defined.
	environments: {
		ssr: {
			build: {
				// The Worker's, for Sentry and for Cloudflare's own logs (wrangler uploads them); never
				// served, so always made.
				sourcemap: "hidden",
				rolldownOptions: { output: { strictExecutionOrder: true } },
			},
		},
	},
}));
