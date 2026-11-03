import { inArray } from "drizzle-orm";
import { db, schema } from "./db";

/** People's names (or emails) by user id, for "Approved by…", "Last edited by…". */
export async function peopleNames(ids: (string | null | undefined)[]) {
	const list = [...new Set(ids.filter((x): x is string => !!x))];
	if (!list.length) return {} as Record<string, string>;
	const rows = await db
		.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
		.from(schema.user)
		.where(inArray(schema.user.id, list));
	return Object.fromEntries(rows.map((r) => [r.id, r.name || r.email])) as Record<string, string>;
}
