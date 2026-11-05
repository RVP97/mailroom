import { and, asc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { batch, db, schema } from "./db";
import { baseUrl, cfg } from "./env";
import { gunzipJson } from "./gzip";
import { iso } from "./time";

/**
 * The long-term archive. What retention would delete goes to R2 first, as gzip NDJSON per brand
 * and day, and the rows go only once it's stored:
 *
 *   archive/<brand>/emails/<day>/<first id>.ndjson.gz    each email with its events
 *   archive/<brand>/bodies/<day>/<first id>.ndjson.gz    what each said (html, text, headers…)
 *   archive/<brand>/received/<day>/<first id>.ndjson.gz  received emails' rows
 *   archive/<brand>/received/<day>/<id>.eml              and each whole message
 *
 * <day> is the day the email was created. R2 keeps it for a few cents a GB a month (and nothing to
 * read it back out), so D1 stays small and nothing is lost. It's off until an organization turns
 * it on in Settings (organization_settings.archive); the ARCHIVE bucket is used when it's bound,
 * else INBOUND, and ARCHIVE_EMAILS=false turns it off for the whole deployment.
 */

export type ArchiveKind = "emails" | "bodies" | "received" | "chats";
export const ARCHIVE_KINDS: ArchiveKind[] = ["emails", "bodies", "received", "chats"];

export const archiveBucket = (): R2Bucket | null => {
	const c = cfg();
	if (c.ARCHIVE_EMAILS?.trim().toLowerCase() === "false") return null;
	return c.ARCHIVE ?? c.INBOUND ?? null;
};

/** The brands whose organization turned the archive on, as a subquery (brands are few). */
export const ARCHIVED_BRANDS =
	"SELECT organization_id FROM organization_settings WHERE archive = 1 UNION SELECT m.organization_id FROM managed_organizations m JOIN organization_settings s ON s.organization_id = m.parent_id WHERE s.archive = 1";
export const archivedBrands = sql.raw(ARCHIVED_BRANDS);

const archived = (column: unknown) => sql`${column} IN (${archivedBrands})`;

export async function archiveEnabled(organizationId: string) {
	const row = await db
		.select({ archive: schema.organizationSettings.archive })
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organization_id, organizationId))
		.get();
	return row?.archive ?? false;
}

export async function setArchiveEnabled(organizationId: string, on: boolean, now = Date.now()) {
	const row = { organization_id: organizationId, archive: on, updated_at: iso(now) };
	await db
		.insert(schema.organizationSettings)
		.values(row)
		.onConflictDoUpdate({ target: schema.organizationSettings.organization_id, set: row });
}

/** Of these brands, the ones archiving. */
export async function archivingBrands(ids: string[]) {
	if (!ids.length) return new Set<string>();
	const rows = await db.all<{ id: string }>(
		sql`SELECT organization_id AS id FROM (${archivedBrands})`,
	);
	const on = new Set(rows.map((r) => r.id));
	return new Set(ids.filter((id) => on.has(id)));
}

const PAGE = 400;
/** IN (…) lists stay under D1's 100 bound parameters. */
const IN = 90;

const chunks = <T>(xs: T[], n = IN) =>
	Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function ndjsonGzip(rows: unknown[]) {
	const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readNdjson<T>(bytes: ArrayBuffer | Uint8Array): Promise<T[]> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"));
	return (await new Response(stream).text())
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l) as T);
}

/** Writes rows grouped by brand and day; throws when R2 refuses (and nothing gets deleted). */
async function store<T extends { id: string }>(
	bucket: R2Bucket,
	kind: ArchiveKind,
	rows: T[],
	brand: (r: T) => string,
	created: (r: T) => string,
) {
	const groups = new Map<string, T[]>();
	for (const r of rows) {
		const k = `${brand(r)}/${kind}/${created(r).slice(0, 10)}`;
		groups.set(k, [...(groups.get(k) ?? []), r]);
	}
	for (const [prefix, list] of groups)
		await bucket.put(`archive/${prefix}/${list[0]?.id}.ndjson.gz`, await ndjsonGzip(list), {
			httpMetadata: { contentType: "application/gzip" },
			customMetadata: { count: String(list.length) },
		});
}

const e = schema.emails;
const ev = schema.emailEvents;
const b = schema.emailBodies;

/** Emails (with their events) created before `before`: archived, then deleted. */
export async function archiveEmails(bucket: R2Bucket, before: string, rounds = 40) {
	let n = 0;
	for (let i = 0; i < rounds; i++) {
		const rows = await db
			.select()
			.from(e)
			.where(and(lt(e.created_at, before), archived(e.organization_id)))
			.orderBy(asc(e.created_at))
			.limit(PAGE);
		if (!rows.length) break;
		const ids = rows.map((r) => r.id);
		const events: (typeof ev.$inferSelect)[] = [];
		for (const part of chunks(ids))
			events.push(
				...(await db
					.select()
					.from(ev)
					.where(inArray(ev.email_id, part))
					.orderBy(asc(ev.at))),
			);
		const byEmail = new Map<string, typeof events>();
		for (const x of events) byEmail.set(x.email_id, [...(byEmail.get(x.email_id) ?? []), x]);
		await store(
			bucket,
			"emails",
			rows.map(({ locked_until: _l, request_hash: _h, ...r }) => ({
				...r,
				events: (byEmail.get(r.id) ?? []).map(
					({ email_id: _e, organization_id: _o, ...x }) => x,
				),
			})),
			(r) => r.organization_id,
			(r) => r.created_at,
		);
		await batch(
			chunks(ids).flatMap((part) => [
				db.delete(ev).where(inArray(ev.email_id, part)),
				db.delete(e).where(inArray(e.id, part)),
			]),
		);
		n += rows.length;
		if (rows.length < PAGE) break;
	}
	return n;
}

/** What emails said, past body retention (not of emails still waiting to go). */
export async function archiveBodies(bucket: R2Bucket, before: string, rounds = 40) {
	let n = 0;
	for (let i = 0; i < rounds; i++) {
		const rows = await db
			.select({
				id: b.email_id,
				brand: e.organization_id,
				email_created_at: e.created_at,
				content: b.content,
				attachments: b.attachments,
				created_at: b.created_at,
			})
			.from(b)
			.innerJoin(e, eq(e.id, b.email_id))
			.where(
				and(
					lt(b.created_at, before),
					archived(e.organization_id),
					notInArray(e.status, ["queued", "scheduled", "sending"]),
				),
			)
			.orderBy(asc(b.created_at))
			.limit(100);
		if (!rows.length) break;
		const out = [];
		for (const r of rows) {
			const content = await gunzipJson<Record<string, unknown>>(r.content).catch(() => ({
				unreadable: true,
			}));
			out.push({
				id: r.id,
				brand: r.brand,
				email_created_at: r.email_created_at,
				attachments: r.attachments,
				...content,
			});
		}
		await store(
			bucket,
			"bodies",
			out,
			(r) => r.brand,
			(r) => r.email_created_at,
		);
		await batch(
			chunks(rows.map((r) => r.id)).map((part) =>
				db.delete(b).where(inArray(b.email_id, part)),
			),
		);
		n += rows.length;
		if (rows.length < 100) break;
	}
	return n;
}

type Received = typeof schema.receivedEmails.$inferSelect;

/** Received emails past retention: each whole message, and the rows. Before they're deleted. */
export async function archiveReceived(
	bucket: R2Bucket,
	rows: Received[],
	inbound: R2Bucket | null,
) {
	for (const r of rows) {
		const obj = await inbound?.get(r.object_key);
		if (!obj) continue;
		await bucket.put(
			`archive/${r.organization_id}/received/${r.created_at.slice(0, 10)}/${r.id}.eml`,
			await obj.arrayBuffer(),
			{ httpMetadata: { contentType: "message/rfc822" } },
		);
	}
	await store(
		bucket,
		"received",
		rows,
		(r) => r.organization_id,
		(r) => r.created_at,
	);
}

/**
 * Website chats past retention, each with its lines (archive/<brand>/chats/<day>/…, by the day
 * it started). Their files stay out: they're deleted with the chat.
 */
export async function archiveChats(bucket: R2Bucket, conversationIds: string[]) {
	if (!conversationIds.length) return;
	const chats = await db
		.select()
		.from(schema.conversations)
		.where(inArray(schema.conversations.id, conversationIds));
	const lines = await db
		.select()
		.from(schema.chatMessages)
		.where(inArray(schema.chatMessages.conversation_id, conversationIds))
		.orderBy(asc(schema.chatMessages.created_at));
	await store(
		bucket,
		"chats",
		chats.map((x) => ({ ...x, lines: lines.filter((l) => l.conversation_id === x.id) })),
		(r) => r.organization_id,
		(r) => r.created_at,
	);
}

export interface ArchiveFile {
	key: string;
	brand_id: string;
	kind: ArchiveKind;
	day: string;
	size: number;
	count: number | null;
	uploaded_at: string;
}

const fileOf = (o: R2Object): ArchiveFile | null => {
	const [, brand, kind, day] = o.key.split("/");
	if (!brand || !kind || !day || !ARCHIVE_KINDS.includes(kind as ArchiveKind)) return null;
	const count = Number(o.customMetadata?.count);
	return {
		key: o.key,
		brand_id: brand,
		kind: kind as ArchiveKind,
		day,
		size: o.size,
		count: Number.isFinite(count) && count > 0 ? count : null,
		uploaded_at: iso(o.uploaded.getTime()),
	};
};

/** A brand's archive files, newest days first within the page R2 gives. */
export async function listArchive(
	brand: string,
	o: { kind?: ArchiveKind; cursor?: string; limit?: number } = {},
) {
	const bucket = archiveBucket();
	if (!bucket)
		return { data: [] as ArchiveFile[], cursor: null, has_more: false, enabled: false };
	const res = await bucket.list({
		prefix: `archive/${brand}/${o.kind ? `${o.kind}/` : ""}`,
		limit: Math.min(Math.max(o.limit ?? 100, 1), 1000),
		...(o.cursor ? { cursor: o.cursor } : {}),
		include: ["customMetadata"],
	} as R2ListOptions);
	const data = res.objects
		.map(fileOf)
		.filter((f): f is ArchiveFile => !!f)
		.sort((x, y) => y.day.localeCompare(x.day) || x.key.localeCompare(y.key));
	return {
		data,
		cursor: res.truncated ? res.cursor : null,
		has_more: res.truncated,
		enabled: true,
	};
}

const filename = (key: string) => key.split("/").slice(1).join("-");

/** One archive file's bytes, as a download (the caller checked the brand may read it). */
export async function archiveResponse(key: string): Promise<Response> {
	const gone = new Response("Not found", { status: 404 });
	const obj = /^archive\/[^/]+\/(emails|bodies|received)\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(key)
		? await archiveBucket()?.get(key)
		: null;
	if (!obj) return gone;
	return new Response(obj.body, {
		headers: {
			"content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
			"content-length": String(obj.size),
			"content-disposition": `attachment; filename="${filename(key).replace(/[^\w.-]/g, "_")}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

export const brandOfKey = (key: string) => key.split("/")[1] ?? "";

const LINK_TTL_S = 3600;

/** A signed download link for the dashboard (an hour). */
export async function archiveLink(key: string, now = Date.now()) {
	const { sign } = await import("./inbound");
	const expires = Math.floor(now / 1000) + LINK_TTL_S;
	const signature = await sign(`archive:${key}:${expires}`);
	return `${baseUrl()}/archive-file/${expires}/${signature}/${key}`;
}

/** GET /archive-file/<expires>/<signature>/<key>. */
export async function serveArchiveLink(path: string, now = Date.now()) {
	const [, , expires, signature, ...rest] = path.split("/");
	const key = decodeURIComponent(rest.join("/"));
	const gone = new Response("This link has expired or is not valid", { status: 404 });
	if (!expires || !signature || !key || Number(expires) * 1000 < now) return gone;
	const { sign } = await import("./inbound");
	const expected = await sign(`archive:${key}:${expires}`);
	if (expected.length !== signature.length) return gone;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	if (diff) return gone;
	return archiveResponse(key);
}
