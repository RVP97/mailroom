import type { Database } from "sql.js";

/** The repo's D1 migrations (drizzle/), in order, as `wrangler d1 migrations apply` runs them. */
const files = import.meta.glob("../drizzle/*.sql", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

export function migrate(sqlite: Database) {
	for (const name of Object.keys(files).sort()) {
		const sql = (files[name] as string).split("--> statement-breakpoint").join("\n");
		try {
			sqlite.exec(sql);
		} catch (error) {
			throw new Error(
				`Migration ${name.split("/").pop()} failed: ${(error as Error).message}`,
			);
		}
	}
}
