/**
 * cloudflare:workers for the demo: the D1 database is SQLite in the browser (demo/d1.ts); the
 * other bindings keep what's put in them in memory, or do nothing.
 */
import { demoD1, demoSqlite } from "../d1";

type Stored = { body: Uint8Array; httpMetadata?: unknown; uploaded: Date };

/**
 * An R2 bucket kept in the demo's SQLite (table demo_objects), so the files the seed stored
 * (received emails, attachments, logos) are in the database the demo opens.
 */
function sqliteBucket(name: string) {
	let ready = false;
	const q = () => {
		const s = demoSqlite();
		if (!ready) {
			s.run(
				"CREATE TABLE IF NOT EXISTS demo_objects (bucket TEXT NOT NULL, key TEXT NOT NULL, body BLOB NOT NULL, meta BLOB, uploaded INTEGER NOT NULL, PRIMARY KEY (bucket, key))",
			);
			ready = true;
		}
		return s;
	};
	const read = (key: string): Stored | null => {
		const r = q().exec(
			"SELECT body, meta, uploaded FROM demo_objects WHERE bucket = ? AND key = ?",
			[name, key],
		)[0]?.values[0];
		if (!r) return null;
		return {
			body: r[0] as Uint8Array,
			httpMetadata: r[1]
				? JSON.parse(new TextDecoder().decode(r[1] as Uint8Array))
				: undefined,
			uploaded: new Date(Number(r[2])),
		};
	};
	return {
		...memoryBucket({
			set: (key, o) =>
				q().run(
					"INSERT OR REPLACE INTO demo_objects (bucket, key, body, meta, uploaded) VALUES (?, ?, ?, ?, ?)",
					[
						name,
						key,
						o.body,
						o.httpMetadata
							? new TextEncoder().encode(JSON.stringify(o.httpMetadata))
							: null,
						o.uploaded.getTime(),
					],
				),
			get: read,
			delete: (key) =>
				q().run("DELETE FROM demo_objects WHERE bucket = ? AND key = ?", [name, key]),
			keys: (prefix) =>
				(
					q().exec(
						"SELECT key FROM demo_objects WHERE bucket = ? AND key LIKE ? ORDER BY key",
						[name, `${prefix}%`],
					)[0]?.values ?? []
				).map((r) => String(r[0])),
		}),
	};
}

interface Store {
	set(key: string, o: Stored): void;
	get(key: string): Stored | null;
	delete(key: string): void;
	keys(prefix: string): string[];
}

function memoryBucket(store?: Store) {
	const map = new Map<string, Stored>();
	const objects: Store = store ?? {
		set: (k, o) => void map.set(k, o),
		get: (k) => map.get(k) ?? null,
		delete: (k) => void map.delete(k),
		keys: (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
	};
	const asObject = (
		key: string,
		o: { body: Uint8Array; httpMetadata?: unknown; uploaded: Date },
	) => ({
		key,
		size: o.body.byteLength,
		uploaded: o.uploaded,
		httpMetadata: o.httpMetadata ?? {},
		customMetadata: {},
		body: new Blob([o.body as BlobPart]).stream(),
		arrayBuffer: async () => o.body.slice().buffer,
		text: async () => new TextDecoder().decode(o.body),
	});
	return {
		async put(key: string, value: unknown, opts?: { httpMetadata?: unknown }) {
			const body =
				typeof value === "string"
					? new TextEncoder().encode(value)
					: value instanceof ArrayBuffer
						? new Uint8Array(value)
						: value instanceof Uint8Array
							? value
							: value instanceof Blob
								? new Uint8Array(await value.arrayBuffer())
								: new Uint8Array(
										await new Response(value as BodyInit).arrayBuffer(),
									);
			objects.set(key, { body, httpMetadata: opts?.httpMetadata, uploaded: new Date() });
			return { key };
		},
		async get(key: string) {
			const o = objects.get(key);
			return o ? asObject(key, o) : null;
		},
		async head(key: string) {
			const o = objects.get(key);
			return o ? asObject(key, o) : null;
		},
		async delete(keys: string | string[]) {
			for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
		},
		async list(opts?: { prefix?: string }) {
			const keys = objects.keys(opts?.prefix ?? "");
			return {
				objects: keys.map((k) => asObject(k, objects.get(k) as never)),
				truncated: false,
				delimitedPrefixes: [],
			};
		},
	};
}

function memoryKv() {
	const values = new Map<string, string>();
	return {
		get: async (k: string, type?: string) => {
			const v = values.get(k);
			return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
		},
		put: async (k: string, v: string) => void values.set(k, v),
		delete: async (k: string) => void values.delete(k),
		list: async () => ({
			keys: [...values.keys()].map((name) => ({ name })),
			list_complete: true,
		}),
	};
}

/** A Durable Object namespace whose objects accept any call and do nothing. */
function quietNamespace() {
	const stub = new Proxy(
		{},
		{
			get: (_t, key) =>
				key === "then"
					? undefined
					: key === "fetch"
						? async () => new Response(null, { status: 204 })
						: async () => undefined,
		},
	);
	return {
		idFromName: (name: string) => ({ name, toString: () => name }),
		idFromString: (id: string) => ({ name: id, toString: () => id }),
		newUniqueId: () => ({ name: crypto.randomUUID(), toString: () => "id" }),
		get: () => stub,
		getByName: () => stub,
	};
}

/**
 * The app's own Dispatcher (src/server/dispatcher.ts), one instance, with its alarm played by a
 * timer. While the seed runs it's run by hand instead (runDispatcher), at the seed's time.
 */
let dispatcher: {
	alarm(): Promise<void>;
	kick(): Promise<void>;
	reserve(): Promise<number>;
} | null = null;
let alarmAt: number | null = null;
let alarmTimer: ReturnType<typeof setTimeout> | null = null;
export const dispatcherHooks = { manual: false };

async function dispatcherInstance() {
	if (!dispatcher) {
		const { Dispatcher } = await import("@/server/dispatcher");
		const storage = {
			getAlarm: async () => alarmAt,
			setAlarm: async (t: number | Date) => {
				alarmAt = Number(t);
				if (dispatcherHooks.manual) return;
				if (alarmTimer) clearTimeout(alarmTimer);
				alarmTimer = setTimeout(
					() => {
						alarmAt = null;
						void dispatcher?.alarm().catch((e) => console.warn("[demo] dispatcher", e));
					},
					Math.max(0, (alarmAt ?? 0) - Date.now()),
				);
			},
			deleteAlarm: async () => {
				alarmAt = null;
			},
		};
		dispatcher = new Dispatcher({ storage } as never, env as never) as never;
		// Sends don't wait for a send rate in the demo.
		(dispatcher as unknown as { reserve: () => Promise<number> }).reserve = async () => 0;
	}
	return dispatcher as NonNullable<typeof dispatcher>;
}

/** Sends what's due now (the seed calls it after queueing emails). */
export async function runDispatcher() {
	const d = await dispatcherInstance();
	for (let i = 0; i < 1000 && alarmAt !== null && alarmAt <= Date.now(); i++) {
		alarmAt = null;
		await d.alarm();
	}
}

const dispatcherNamespace = {
	idFromName: (name: string) => ({ name, toString: () => name }),
	get: () => ({
		kick: async () => (await dispatcherInstance()).kick(),
		reserve: async () => 0,
	}),
};

const limiter = { limit: async () => ({ success: true }) };

export const env: Record<string, unknown> = {
	DB: demoD1,
	INBOUND: sqliteBucket("INBOUND"),
	OAUTH_KV: memoryKv(),
	DISPATCHER: dispatcherNamespace,
	CHAT_ROOM: quietNamespace(),
	API_KEY_LIMIT: limiter,
	API_IP_LIMIT: limiter,
	SIGNUP_LIMIT: limiter,
	SYSTEM_EMAIL: { send: async () => ({}) },
	// Demo values: fake AWS keys (every AWS call goes to demo/outside.ts), the demo's address.
	AWS_ACCESS_KEY_ID: "AKIDEXAMPLE",
	AWS_SECRET_ACCESS_KEY: "demo-secret",
	AWS_REGION: "us-east-1",
	TIMEZONE: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
	ADMIN_EMAILS: "alex@example.com",
	MAX_SEND_RATE: "14",
	BODY_RETENTION_DAYS: "14",
	// In the browser, the demo's own worker/ path (demo/worker.ts serves the Worker's pages there).
	BETTER_AUTH_URL:
		typeof location === "undefined"
			? "https://mailroom.example.com"
			: `${location.origin}${import.meta.env.BASE_URL}worker`,
	BETTER_AUTH_SECRET: "the-demo-secret-is-not-a-secret",
	INBOUND_DOMAIN: "in.mailroom.example.com",
	SYSTEM_FROM: "mailroom@mail.example.com",
	DMARC_REPORTS_ADDRESS: "dmarc@mailroom.example.com",
	GOOGLE_CLIENT_ID: "demo.apps.googleusercontent.com",
	GOOGLE_CLIENT_SECRET: "demo",
};

/** Work a request leaves running (logs, webhooks); the seed waits for it with settle(). */
const pending = new Set<Promise<unknown>>();
export const waitUntil = (p: Promise<unknown>) => {
	const tracked = p.catch((e) => console.warn("[demo] background work failed", e));
	pending.add(tracked);
	void tracked.finally(() => pending.delete(tracked));
};
export async function settle() {
	while (pending.size) await Promise.all([...pending]);
}

export class DurableObject {
	ctx: unknown;
	env: unknown;
	constructor(ctx?: unknown, e?: unknown) {
		this.ctx = ctx;
		this.env = e;
	}
}
export class WorkerEntrypoint extends DurableObject {}
