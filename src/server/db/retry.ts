/**
 * D1 now and then drops a query with a transient error ("Network connection lost", an object
 * reset while the database moves): Cloudflare's advice is to retry. Only reads are retried, since
 * a write that lost its connection may still have been applied.
 */

/** The messages Cloudflare lists as transient (https://developers.cloudflare.com/d1/observability/debug-d1/). */
const TRANSIENT =
	/Network connection lost|storage caused object to be reset|reset because its code was updated|transient issue|storage operation exceeded timeout|Internal error in D1/i;

export function isTransient(error: unknown): boolean {
	for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++)
		if (e instanceof Error && TRANSIENT.test(e.message)) return true;
	return false;
}

const WRITE = /\b(insert|update|delete|replace|create|drop|alter|pragma)\b/i;

/** A plain read: SELECT or WITH, with nothing in it that changes data. */
export function isRead(query: string): boolean {
	return /^\s*(select|with)\b/i.test(query) && !WRITE.test(query);
}

const DELAYS = [50, 250];

/**
 * Runs `run` again after a transient D1 error. Reads get this on their own; use it for a write only
 * when doing it twice is harmless (it sets fixed values, and nothing reads how many rows changed).
 */
export async function retrying<T>(run: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if (attempt >= DELAYS.length || !isTransient(error)) throw error;
			await new Promise((r) => setTimeout(r, DELAYS[attempt]));
		}
	}
}

/** The real statement behind each wrapped one (D1's own `batch` takes only real ones). */
const real = new WeakMap<object, D1PreparedStatement>();

const READS = new Set(["all", "raw", "first", "run"]);

function wrapStatement(stmt: D1PreparedStatement, query: string): D1PreparedStatement {
	const read = isRead(query);
	const wrapped = new Proxy(stmt, {
		get(target, prop) {
			if (prop === "bind")
				return (...values: unknown[]) => wrapStatement(target.bind(...values), query);
			const value = Reflect.get(target, prop, target);
			if (typeof value !== "function") return value;
			if (read && typeof prop === "string" && READS.has(prop))
				return (...args: unknown[]) => retrying(() => value.apply(target, args));
			return value.bind(target);
		},
	});
	real.set(wrapped, stmt);
	return wrapped;
}

/**
 * The D1 binding with reads retried on transient errors. Pass a function to read the binding on
 * first use: at startup (and when Cloudflare checks the Worker on deploy) `env.DB` may not be an
 * object yet, and a Proxy needs one.
 */
export function withRetry(d1: D1Database | (() => D1Database)): D1Database {
	const binding = typeof d1 === "function" ? d1 : () => d1;
	return new Proxy({} as D1Database, {
		get(_, prop) {
			const target = binding();
			if (!target) return undefined;
			if (prop === "prepare")
				return (query: string) => wrapStatement(target.prepare(query), query);
			if (prop === "batch")
				return (statements: D1PreparedStatement[]) =>
					target.batch(statements.map((s) => real.get(s) ?? s));
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
