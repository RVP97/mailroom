import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export const db = drizzle(env.DB, { schema });
export type Db = typeof db;
export { schema };

type Statement = { toSQL(): { sql: string; params: unknown[] } } | D1PreparedStatement;

/** A raw statement for `batch` (raw SQL drizzle can't put in its own batch). */
export const raw = (query: string, ...params: unknown[]) =>
	(env.DB as D1Database).prepare(query).bind(...params);

/**
 * Drizzle queries and raw statements in one D1 batch: one transaction, and one query against the
 * per-request limit.
 */
export async function batch(statements: Statement[]) {
	if (!statements.length) return [];
	return (env.DB as D1Database).batch(
		statements.map((s) => {
			if ("toSQL" in s) {
				const q = s.toSQL();
				return raw(q.sql, ...q.params);
			}
			return s;
		}),
	);
}
