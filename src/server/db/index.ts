import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { withRetry } from "./retry";
import * as schema from "./schema";

const d1 = withRetry(() => env.DB as D1Database);

export const db = drizzle(d1, { schema });
export type Db = typeof db;
export { schema };

type Statement = { toSQL(): { sql: string; params: unknown[] } } | D1PreparedStatement;

/** A raw statement for `batch` (raw SQL drizzle can't put in its own batch). */
export const raw = (query: string, ...params: unknown[]) => d1.prepare(query).bind(...params);

/** Splits a list into D1-safe slices (default 90, leaving room for extra WHERE/LIMIT params under D1's 100 limit). */
export function chunk<T>(items: readonly T[], size = 90): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Drizzle queries and raw statements in one D1 batch: one transaction, and one query against the
 * per-request limit.
 */
export async function batch(statements: Statement[]) {
	if (!statements.length) return [];
	return d1.batch(
		statements.map((s) => {
			if ("toSQL" in s) {
				const q = s.toSQL();
				return raw(q.sql, ...q.params);
			}
			return s;
		}),
	);
}
