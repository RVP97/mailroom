import type { Database } from "sql.js";

/**
 * The seeded database was made when the site was built; this moves every date in it forward by
 * the whole days since, so the demo's charts always end today. ISO times, YYYY-MM-DD days and
 * millisecond timestamps (Better Auth's columns) all move by the same days.
 */
export function shiftDates(sqlite: Database, builtAt: number, now = Date.now()) {
	const days = Math.floor((now - builtAt) / 86_400_000);
	if (days <= 0) return 0;
	const tables =
		sqlite
			.exec(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
			)[0]
			?.values.map((r) => String(r[0])) ?? [];
	const isoGlob = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*'";
	const dayGlob = "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'";
	sqlite.run("PRAGMA foreign_keys = OFF");
	sqlite.run("BEGIN");
	for (const t of tables) {
		const columns = sqlite.exec(`PRAGMA table_info("${t}")`)[0]?.values ?? [];
		for (const col of columns) {
			const name = String(col[1]);
			const type = String(col[2]).toUpperCase();
			const c = `"${name}"`;
			if (type.includes("TEXT") || type === "") {
				sqlite.run(
					`UPDATE "${t}" SET ${c} = CASE
						WHEN ${c} GLOB ${isoGlob} THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${c}, '+${days} days')
						WHEN ${c} GLOB ${dayGlob} THEN date(${c}, '+${days} days')
						ELSE ${c} END
					WHERE ${c} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`,
				);
			} else if (type.includes("INT") && /(_at|At|expires|day)$/i.test(name)) {
				sqlite.run(
					`UPDATE "${t}" SET ${c} = ${c} + ${days * 86_400_000}
					WHERE ${c} BETWEEN 1000000000000 AND 9000000000000`,
				);
			}
		}
	}
	sqlite.run("COMMIT");
	sqlite.run("PRAGMA foreign_keys = ON");
	return days;
}
