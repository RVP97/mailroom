import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => ({
	resolve: { tsconfigPaths: true },
	plugins: [
		cloudflareTest({
			// A minimal entry (no TanStack virtual modules) that still exports the Dispatcher.
			main: "./test/worker.ts",
			wrangler: { configPath: "./test/wrangler.jsonc" },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations("./drizzle"),
					// Fake keys: every AWS call in the tests goes to a fake fetch.
					AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
					AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
					// Encrypts organizations' own AWS keys (src/server/org-aws.ts).
					BETTER_AUTH_SECRET: "test-secret-for-mailroom",
					// Gmail Postmaster Tools: its calls go to a fake fetch too.
					GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
					GOOGLE_CLIENT_SECRET: "secret",
				},
			},
		}),
	],
	test: {
		setupFiles: ["./test/setup.ts"],
		testTimeout: 20_000,
	},
}));
