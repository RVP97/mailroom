import { and, desc, eq, gte, like, lt, or, type SQL } from "drizzle-orm";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * Every authenticated call to the public API, as Resend's Logs show them: the method, the path,
 * the status, which key and which client made it, and both bodies (trimmed). Kept
 * REQUEST_LOG_RETENTION_DAYS (cron.ts). Calls without a valid key aren't kept: they belong to
 * no organization.
 */

const r = schema.apiRequests;

/** Bodies are cut at this many characters; an email's HTML doesn't need to be kept twice. */
const MAX_BODY = 16_000;

/** Attachments' base64 isn't kept, only how big it was. */
function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value))
		out[k] =
			k === "attachments" && Array.isArray(v)
				? v.map((a) =>
						a &&
						typeof a === "object" &&
						typeof (a as { content?: unknown }).content === "string"
							? {
									...(a as object),
									content: `[${Math.round(((a as { content: string }).content.length * 3) / 4)} bytes]`,
								}
							: a,
					)
				: redact(v);
	return out;
}

/** A body as it's kept: JSON pretty-printed and redacted, anything else as text; trimmed. */
export function keptBody(text: string | null): string | null {
	if (!text) return null;
	let kept = text;
	try {
		kept = JSON.stringify(redact(JSON.parse(text)), null, 2);
	} catch {}
	return kept.length > MAX_BODY ? `${kept.slice(0, MAX_BODY)}\n… (cut)` : kept;
}

/** The email (or first email of a batch) a response created, to link the log to it. */
function createdEmail(path: string, method: string, response: string | null) {
	if (method !== "POST" || !response || !/^\/emails(\/batch)?$/.test(path)) return null;
	try {
		const body = JSON.parse(response) as { id?: string; data?: { id?: string }[] };
		return body.id ?? body.data?.[0]?.id ?? null;
	} catch {
		return null;
	}
}

/** Logs still being written, so tests can wait for them. */
const writing = new Set<Promise<unknown>>();

export function track(work: () => Promise<unknown>) {
	const p = work().finally(() => writing.delete(p));
	writing.add(p);
	return p;
}

export const settleRequestLogs = () => Promise.allSettled([...writing]);

export async function recordRequest(o: {
	organizationId: string;
	apiKeyId: string;
	method: string;
	path: string;
	query: string;
	status: number;
	userAgent: string | null;
	requestBody: string | null;
	responseBody: string | null;
	durationMs: number;
	at: number;
}) {
	try {
		await db.insert(r).values({
			id: crypto.randomUUID(),
			organization_id: o.organizationId,
			api_key_id: o.apiKeyId,
			method: o.method,
			path: o.path,
			query: o.query || null,
			status: o.status,
			user_agent: o.userAgent?.slice(0, 300) ?? null,
			request_body: keptBody(o.requestBody),
			response_body: keptBody(o.responseBody),
			email_id: createdEmail(o.path, o.method, o.responseBody),
			duration_ms: Math.round(o.durationMs),
			created_at: iso(o.at),
		});
	} catch (error) {
		console.error("api: couldn't record the request", error);
	}
}

export type StatusClass = "2xx" | "4xx" | "5xx";

export interface RequestFilter {
	/** Part of the path, or a log's id. */
	search?: string | null;
	status?: StatusClass | null;
	apiKeyId?: string | null;
	/** Only the last this many days. */
	days?: number | null;
	/** Cursor: the created_at and id of the previous page's last row. */
	before?: string | null;
	limit?: number;
}

export async function listRequests(organizationId: string, f: RequestFilter = {}) {
	const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
	const q = f.search?.trim();
	const where: (SQL | undefined)[] = [eq(r.organization_id, organizationId)];
	if (q) where.push(or(like(r.path, `%${q.replace(/[%_]/g, "")}%`), eq(r.id, q)));
	if (f.status === "2xx") where.push(and(gte(r.status, 200), lt(r.status, 400)));
	if (f.status === "4xx") where.push(and(gte(r.status, 400), lt(r.status, 500)));
	if (f.status === "5xx") where.push(gte(r.status, 500));
	if (f.apiKeyId) where.push(eq(r.api_key_id, f.apiKeyId));
	if (f.days) where.push(gte(r.created_at, iso(Date.now() - f.days * 86_400_000)));
	if (f.before) {
		const [at, id] = f.before.split("|");
		if (at && id) where.push(or(lt(r.created_at, at), and(eq(r.created_at, at), lt(r.id, id))));
	}
	const rows = await db
		.select({
			id: r.id,
			method: r.method,
			path: r.path,
			status: r.status,
			user_agent: r.user_agent,
			api_key_id: r.api_key_id,
			duration_ms: r.duration_ms,
			created_at: r.created_at,
		})
		.from(r)
		.where(and(...where))
		.orderBy(desc(r.created_at), desc(r.id))
		.limit(limit + 1);
	const data = rows.slice(0, limit);
	const last = data.at(-1);
	return {
		data,
		has_more: rows.length > limit,
		next: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
	};
}

export async function getRequest(organizationId: string, id: string) {
	return db
		.select()
		.from(r)
		.where(and(eq(r.organization_id, organizationId), eq(r.id, id)))
		.get();
}

/**
 * The API call that created an email, for its page: the call's own link (email_id, the first of
 * a batch) or the batch whose response lists it. Looked for among the POSTs around the email's
 * creation, so it stays on the organization's created_at index.
 */
export async function requestOfEmail(organizationId: string, emailId: string, createdAt: string) {
	const at = Date.parse(createdAt);
	if (Number.isNaN(at)) return null;
	const row = await db
		.select({ id: r.id, method: r.method, path: r.path })
		.from(r)
		.where(
			and(
				eq(r.organization_id, organizationId),
				gte(r.created_at, iso(at - 120_000)),
				lt(r.created_at, iso(at + 60_000)),
				eq(r.method, "POST"),
				or(
					eq(r.email_id, emailId),
					like(r.response_body, `%"${emailId.replace(/[%_"]/g, "")}"%`),
				),
			),
		)
		.orderBy(desc(r.created_at))
		.get();
	return row ?? null;
}
