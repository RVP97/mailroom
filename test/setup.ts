import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";
import { settleRequestLogs } from "@/server/request-logs";

const testEnv = env as unknown as {
	DB: D1Database;
	TEST_MIGRATIONS: { name: string; queries: string[] }[];
};

// One batch for every migration (applyD1Migrations makes a round trip per migration).
await testEnv.DB.batch(
	testEnv.TEST_MIGRATIONS.flatMap((m) => m.queries.map((q) => testEnv.DB.prepare(q))),
);

// Nothing leaves the tests: each one fakes the outside calls it expects.
beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		throw new Error(`Unmocked outbound request in test: ${String(input)}`);
	});
});

// API calls write their log after answering: let them finish inside the test that made them.
afterEach(() => settleRequestLogs());
