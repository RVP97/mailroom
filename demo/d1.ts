/**
 * A D1 database in the browser: Cloudflare's D1 API (prepare, bind, all, raw, first, run, batch,
 * exec) over SQLite compiled to WebAssembly (sql.js). D1 is SQLite too, so the app's queries and
 * the repo's migrations run on it unchanged.
 */
import initSqlJs, { type Database, type SqlValue } from "sql.js";

let sqlite: Database | null = null;

/**
 * Opens the database: `data` is a saved one (the seeded file the build makes), else it starts
 * empty. `wasm` is SQLite's WebAssembly: its URL in the browser, its bytes in Node.
 */
export async function openDemoDb(o: { wasm: string | ArrayBuffer; data?: Uint8Array }) {
	const SQL = await initSqlJs(
		typeof o.wasm === "string"
			? { locateFile: () => o.wasm as string }
			: { wasmBinary: o.wasm },
	);
	sqlite = new SQL.Database(o.data);
	sqlite.run("PRAGMA foreign_keys = ON");
	return sqlite;
}

/** The open database, for the demo's own tables (stored files). */
export const demoSqlite = () => {
	if (!sqlite) throw new Error("The demo database isn't open yet");
	return sqlite;
};

const db = () => {
	if (!sqlite) throw new Error("The demo database isn't open yet");
	return sqlite;
};

const toSql = (v: unknown): SqlValue => {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "bigint") return Number(v);
	if (v instanceof Date) return v.toISOString();
	if (v instanceof ArrayBuffer) return new Uint8Array(v);
	if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	if (typeof v === "object") return JSON.stringify(v);
	return v as SqlValue;
};

interface Result {
	columns: string[];
	rows: SqlValue[][];
	changes: number;
	lastRowId: number;
}

function execute(query: string, params: unknown[]): Result {
	const d = db();
	const stmt = d.prepare(query);
	try {
		stmt.bind(params.map(toSql));
		const rows: SqlValue[][] = [];
		while (stmt.step()) rows.push(stmt.get());
		const columns = stmt.getColumnNames();
		const changes = d.getRowsModified();
		const lastRowId = Number(d.exec("SELECT last_insert_rowid()")[0]?.values[0]?.[0] ?? 0);
		return { columns, rows, changes, lastRowId };
	} finally {
		stmt.free();
	}
}

const objects = (r: Result) =>
	r.rows.map((row) => {
		const o: Record<string, SqlValue> = {};
		r.columns.forEach((c, i) => {
			o[c] = row[i] ?? null;
		});
		return o;
	});

const meta = (r: Result) => ({
	duration: 0,
	changes: r.changes,
	last_row_id: r.lastRowId,
	rows_read: r.rows.length,
	rows_written: r.changes,
	changed_db: r.changes > 0,
	size_after: 0,
	served_by: "demo",
});

class Statement {
	constructor(
		readonly query: string,
		readonly params: unknown[] = [],
	) {}
	bind(...values: unknown[]) {
		return new Statement(this.query, values);
	}
	run_() {
		try {
			return execute(this.query, this.params);
		} catch (error) {
			const e = new Error(`D1_ERROR: ${(error as Error).message}`);
			(e as Error & { cause?: unknown }).cause = error;
			console.warn("[demo] query failed", this.query, this.params, error);
			throw e;
		}
	}
	async all() {
		const r = this.run_();
		return { results: objects(r), success: true, meta: meta(r) };
	}
	async raw(opts?: { columnNames?: boolean }) {
		const r = this.run_();
		return opts?.columnNames ? [r.columns, ...r.rows] : r.rows;
	}
	async first(column?: string) {
		const r = this.run_();
		const row = objects(r)[0];
		if (!row) return null;
		return column ? (row[column] ?? null) : row;
	}
	async run() {
		const r = this.run_();
		return { results: objects(r), success: true, meta: meta(r) };
	}
}

export const demoD1 = {
	prepare: (query: string) => new Statement(query),
	async batch(statements: Statement[]) {
		const d = db();
		d.run("SAVEPOINT demo_batch");
		try {
			const out = [];
			for (const s of statements) {
				const r = s.run_();
				out.push({ results: objects(r), success: true, meta: meta(r) });
			}
			d.run("RELEASE demo_batch");
			return out;
		} catch (error) {
			d.run("ROLLBACK TO demo_batch");
			d.run("RELEASE demo_batch");
			throw error;
		}
	},
	async exec(query: string) {
		db().exec(query);
		return { count: 1, duration: 0 };
	},
	withSession() {
		return demoD1;
	},
};
