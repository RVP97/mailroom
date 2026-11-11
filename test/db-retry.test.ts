import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";
import { batch, db, raw, schema } from "@/server/db";
import { isRead, isTransient, retrying, withRetry } from "@/server/db/retry";

const lost = () => new Error("D1_ERROR: Network connection lost.");

/** A D1 binding whose statements fail `times` times before reaching the real database. */
function flaky(times: number) {
	const real = env.DB as D1Database;
	let left = times;
	const calls = { count: 0 };
	const fake = {
		prepare(query: string) {
			const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
				({
					bind: (...v: unknown[]) => wrap(stmt.bind(...v)),
					all: async () => {
						calls.count++;
						if (left-- > 0) throw lost();
						return stmt.all();
					},
					raw: async (o?: { columnNames?: boolean }) => {
						calls.count++;
						if (left-- > 0) throw lost();
						return stmt.raw(o as { columnNames: true });
					},
					first: async () => {
						calls.count++;
						if (left-- > 0) throw lost();
						return stmt.first();
					},
					run: async () => {
						calls.count++;
						if (left-- > 0) throw lost();
						return stmt.run();
					},
				}) as unknown as D1PreparedStatement;
			return wrap(real.prepare(query));
		},
		batch: (s: D1PreparedStatement[]) => real.batch(s),
	} as unknown as D1Database;
	return { d1: withRetry(fake), calls };
}

describe("D1 retries", () => {
	it("tells reads from writes", () => {
		expect(isRead('select "parent_id" from "managed_organizations"')).toBe(true);
		expect(isRead("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
		expect(isRead('select "updated_at" from t')).toBe(true);
		expect(isRead("insert into t values (1)")).toBe(false);
		expect(isRead("WITH x AS (SELECT 1) DELETE FROM t")).toBe(false);
		expect(isRead("update t set a = 1")).toBe(false);
	});

	it("knows a dropped connection, also when drizzle wraps it", () => {
		expect(isTransient(lost())).toBe(true);
		expect(isTransient(new Error("Failed query: select 1", { cause: lost() }))).toBe(true);
		expect(isTransient(new Error("UNIQUE constraint failed"))).toBe(false);
		// D1's bare internal error (Sentry MAILROOM-H and -J).
		const internal = new Error(
			"D1_ERROR: internal error; reference = 5c4nltiggn00mq1615iscb6d",
			{
				cause: new Error("internal error; reference = 5c4nltiggn00mq1615iscb6d"),
			},
		);
		expect(isTransient(new Error("Failed query: select 1", { cause: internal }))).toBe(true);
	});

	it("retries a read that lost its connection", async () => {
		const { d1, calls } = flaky(1);
		const flakyDb = drizzle(d1, { schema });
		const row = await flakyDb
			.select({ id: schema.brands.id })
			.from(schema.brands)
			.limit(1)
			.get();
		expect(row === undefined || typeof row.id === "string").toBe(true);
		expect(calls.count).toBe(2);
	});

	it("gives up after a few tries", async () => {
		const { d1, calls } = flaky(10);
		await expect(d1.prepare("SELECT 1").first()).rejects.toThrow(/Network connection lost/);
		expect(calls.count).toBe(3);
	});

	it("never retries a write", async () => {
		const { d1, calls } = flaky(1);
		await expect(
			d1.prepare("DELETE FROM managed_organizations WHERE organization_id = 'none'").run(),
		).rejects.toThrow(/Network connection lost/);
		expect(calls.count).toBe(1);
	});

	it("retries a write the caller says is safe to repeat", async () => {
		const { d1, calls } = flaky(1);
		const flakyDb = drizzle(d1, { schema });
		await retrying(() =>
			flakyDb
				.update(schema.orgSending)
				.set({ tenant_status: "ENABLED" })
				.where(eq(schema.orgSending.organization_id, "none")),
		);
		expect(calls.count).toBe(2);
		expect(
			isTransient(new Error("Internal error in D1 DB storage caused object to be reset")),
		).toBe(true);
	});

	it("still batches through the wrapper", async () => {
		const [r] = await batch([raw("SELECT 1 AS one"), db.select().from(schema.brands).limit(1)]);
		expect((r as D1Result<{ one: number }>).results[0]?.one).toBe(1);
	});
});
