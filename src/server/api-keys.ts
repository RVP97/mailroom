import { and, eq } from "drizzle-orm";
import { sha256Hex } from "./aws/sigv4";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * API keys: «mr_» and 40 random characters, shown once and kept as a SHA-256. A "sending" key
 * can only send (and only from its domain, if it has one); a "full" one can use the whole API.
 */

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(40));
	return `mr_${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

export interface KeyAuth {
	id: string;
	organizationId: string;
	permission: "full" | "sending";
	domainId: string | null;
	/**
	 * The brand the request acts on (Mailroom-Brand header, or /api/brands/<id>/…); without one,
	 * the whole organization (sends: the From domain's brand).
	 */
	brandId?: string;
}

const cache = new Map<string, { value: KeyAuth | null; until: number }>();
const TTL_MS = 60_000;
/** last_used_at is written at most this often per key. */
const TOUCH_MS = 60 * 60_000;
const touched = new Map<string, number>();

export const forgetKey = (hash?: string) => (hash ? cache.delete(hash) : cache.clear());

/** The key a request carries (Authorization: Bearer mr_…), or null. */
export async function authenticate(
	header: string | null,
	now = Date.now(),
): Promise<KeyAuth | null> {
	const key = /^Bearer\s+(mr_[A-Za-z0-9]{20,})\s*$/.exec(header ?? "")?.[1];
	if (!key) return null;
	const hash = await sha256Hex(key);
	const hit = cache.get(hash);
	let auth: KeyAuth | null;
	if (hit && hit.until > now) auth = hit.value;
	else {
		const row = await db
			.select()
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.hash, hash))
			.get();
		auth = row
			? {
					id: row.id,
					organizationId: row.organization_id,
					permission: row.permission === "sending" ? "sending" : "full",
					domainId: row.domain_id,
				}
			: null;
		cache.set(hash, { value: auth, until: now + TTL_MS });
	}
	if (auth && (touched.get(auth.id) ?? 0) < now - TOUCH_MS) {
		touched.set(auth.id, now);
		await db
			.update(schema.apiKeys)
			.set({ last_used_at: iso(now) })
			.where(eq(schema.apiKeys.id, auth.id));
	}
	return auth;
}

export async function createKey(o: {
	organizationId: string;
	name: string;
	permission: "full" | "sending";
	domainId?: string | null;
	createdBy?: string | null;
}) {
	const token = newKey();
	const row = {
		id: crypto.randomUUID(),
		organization_id: o.organizationId,
		name: o.name.trim().slice(0, 100) || "API key",
		start: token.slice(0, 7),
		hash: await sha256Hex(token),
		permission: o.permission,
		domain_id: o.permission === "sending" ? (o.domainId ?? null) : null,
		created_by: o.createdBy ?? null,
		created_at: iso(),
	};
	await db.insert(schema.apiKeys).values(row);
	return { id: row.id, token };
}

export async function deleteKey(organizationId: string, id: string) {
	const [row] = await db
		.delete(schema.apiKeys)
		.where(and(eq(schema.apiKeys.id, id), eq(schema.apiKeys.organization_id, organizationId)))
		.returning({ hash: schema.apiKeys.hash });
	if (row) forgetKey(row.hash);
	return !!row;
}
