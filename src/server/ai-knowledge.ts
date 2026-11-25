import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { isPrivateWebhookHost } from "./automations";
import { db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { decryptSecret, encryptSecret, organizationOf } from "./org-aws";
import { iso } from "./time";

/**
 * AI Agent 2.0:
 *  - Knowledge Sources: crawl docs URLs, sitemap.xml feeds, or Markdown text into indexed chunks
 *    automatically grounded into AI Copilot drafts and the AI Auto-Responder.
 *  - Custom AI Actions: SSRF-guarded HTTP GET/POST tools the AI agent can invoke to fetch live
 *    customer/order/billing state before replying.
 */

export type KnowledgeSourceKind = "url" | "sitemap" | "markdown";

const sourceInput = z.object({
	kind: z.enum(["url", "sitemap", "markdown"]),
	title: z.string().trim().min(1).max(160),
	url: z
		.string()
		.trim()
		.url()
		.max(1000)
		.refine((u) => /^https?:\/\//i.test(u), "URL must use http(s)")
		.optional(),
	content: z.string().max(200_000).optional(),
});

const actionInput = z.object({
	id: z.string().optional(),
	name: z
		.string()
		.trim()
		.min(2)
		.max(48)
		.regex(/^[a-z][a-z0-9_]*$/, "name: lowercase letters, numbers, and underscores only"),
	description: z.string().trim().min(4).max(300),
	method: z.enum(["GET", "POST"]).default("GET"),
	url: z
		.string()
		.trim()
		.url()
		.max(1000)
		.refine((u) => u.startsWith("https://"), "Action URL must use https://"),
	headers: z.record(z.string().trim().min(1).max(64), z.string().max(1000)).optional(),
	body_template: z.string().max(8000).nullable().optional(),
	enabled: z.boolean().optional(),
});

/** Strip HTML markup to readable plain text for chunking. */
export function htmlToPlainText(html: string): { title: string | null; text: string } {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch?.[1]?.replace(/\s+/g, " ").trim() || null;
	const text = html
		.replace(/<(script|style|noscript|svg|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { title, text };
}

/** Split text into overlapping ~900-char chunks for grounded retrieval. */
export function chunkText(text: string, maxChars = 900, overlap = 120): string[] {
	const clean = text.trim();
	if (!clean) return [];
	if (clean.length <= maxChars) return [clean];
	const chunks: string[] = [];
	let start = 0;
	while (start < clean.length && chunks.length < 40) {
		let end = Math.min(start + maxChars, clean.length);
		if (end < clean.length) {
			const br = clean.lastIndexOf("\n", end);
			const sp = clean.lastIndexOf(" ", end);
			if (br > start + maxChars * 0.5) end = br;
			else if (sp > start + maxChars * 0.6) end = sp;
		}
		const slice = clean.slice(start, end).trim();
		if (slice) chunks.push(slice);
		if (end >= clean.length) break;
		start = Math.max(end - overlap, start + 1);
	}
	return chunks;
}

const MAX_CRAWL_BYTES = 300_000;
const MAX_REDIRECTS = 3;

async function readLimitedText(res: Response, maxBytes: number): Promise<string> {
	if (!res.body) return (await res.text()).slice(0, maxBytes);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < maxBytes) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				chunks.push(value.subarray(0, remaining));
				total += remaining;
				await reader.cancel().catch(() => {});
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(out);
}

async function fetchPublicPage(rawUrl: string): Promise<string> {
	let current = rawUrl;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (isPrivateWebhookHost(current)) {
			throw validation("Refused to crawl a private or localhost URL");
		}
		const res = await fetch(current, {
			headers: {
				"user-agent": "Mailroom-KnowledgeBot/1.0",
				accept: "text/html,text/plain,application/xml,*/*",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) throw new ApiError(502, "crawl_failed", "Redirect with no Location header");
			if (hop === MAX_REDIRECTS) {
				throw new ApiError(502, "crawl_failed", "Too many redirects while crawling URL");
			}
			current = new URL(loc, current).toString();
			continue;
		}
		if (!res.ok)
			throw new ApiError(502, "crawl_failed", `Upstream returned HTTP ${res.status}`);
		return readLimitedText(res, MAX_CRAWL_BYTES);
	}
	throw new ApiError(502, "crawl_failed", "Too many redirects while crawling URL");
}

export async function listKnowledgeSources(organizationId: string) {
	const org = await organizationOf(organizationId);
	return db
		.select()
		.from(schema.aiKnowledgeSources)
		.where(eq(schema.aiKnowledgeSources.organization_id, org))
		.orderBy(desc(schema.aiKnowledgeSources.updated_at));
}

export async function addKnowledgeSource(organizationId: string, raw: unknown, now = Date.now()) {
	const v = sourceInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const id = `ks_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	const at = iso(now);

	const extracted: { title: string; url: string | null; text: string }[] = [];
	if (v.kind === "markdown") {
		if (!v.content?.trim()) throw validation("content: paste Markdown or text knowledge");
		extracted.push({ title: v.title, url: v.url ?? null, text: v.content.trim() });
	} else if (v.kind === "url") {
		if (!v.url) throw validation("url: enter a page URL to crawl");
		const html = await fetchPublicPage(v.url);
		const parsed = htmlToPlainText(html);
		extracted.push({ title: parsed.title || v.title, url: v.url, text: parsed.text });
	} else {
		// sitemap.xml -> crawl up to 8 pages
		if (!v.url) throw validation("url: enter a sitemap.xml URL");
		const xml = await fetchPublicPage(v.url);
		const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
			.map((m) => m[1] ?? "")
			.filter((u) => /^https?:\/\//i.test(u) && !isPrivateWebhookHost(u))
			.slice(0, 8);
		if (!locs.length) throw validation("No <loc> URLs found in that sitemap");
		for (const pageUrl of locs) {
			try {
				const html = await fetchPublicPage(pageUrl);
				const parsed = htmlToPlainText(html);
				if (parsed.text)
					extracted.push({
						title: parsed.title || pageUrl,
						url: pageUrl,
						text: parsed.text,
					});
			} catch {
				// Skip individual unreachable pages in a sitemap.
			}
		}
	}

	const chunkRows: (typeof schema.aiKnowledgeChunks.$inferInsert)[] = [];
	for (const doc of extracted) {
		for (const piece of chunkText(doc.text)) {
			chunkRows.push({
				id: `kc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
				source_id: id,
				organization_id: org,
				title: doc.title.slice(0, 160),
				url: doc.url,
				content: piece,
				created_at: at,
			});
		}
	}

	await db.insert(schema.aiKnowledgeSources).values({
		id,
		organization_id: org,
		kind: v.kind,
		title: v.title,
		url: v.url ?? null,
		content: v.kind === "markdown" ? (v.content ?? null) : null,
		chunks_count: chunkRows.length,
		status: chunkRows.length ? "ready" : "error",
		last_error: chunkRows.length ? null : "No readable text found",
		last_synced_at: at,
		created_at: at,
		updated_at: at,
	});
	// Insert chunks in batches (D1 batch avoids N+1 roundtrips and partial counts).
	for (let i = 0; i < chunkRows.length; i += 50) {
		const slice = chunkRows.slice(i, i + 50);
		if (slice.length === 1 && slice[0]) {
			await db.insert(schema.aiKnowledgeChunks).values(slice[0]);
		} else if (slice.length > 1) {
			await db.batch(
				slice.map((chunk) => db.insert(schema.aiKnowledgeChunks).values(chunk)) as never,
			);
		}
	}
	return db
		.select()
		.from(schema.aiKnowledgeSources)
		.where(eq(schema.aiKnowledgeSources.id, id))
		.get();
}

export async function deleteKnowledgeSource(organizationId: string, id: string) {
	const org = await organizationOf(organizationId);
	const [removed] = await db
		.delete(schema.aiKnowledgeSources)
		.where(
			and(
				eq(schema.aiKnowledgeSources.id, id),
				eq(schema.aiKnowledgeSources.organization_id, org),
			),
		)
		.returning({ id: schema.aiKnowledgeSources.id });
	if (!removed) throw notFound("Knowledge source");
	return { deleted: true, id: removed.id };
}

function normalizeText(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "");
}

/** Retrieve top matching knowledge chunks for a customer question (Unicode & diacritic aware). */
export async function searchKnowledgeChunks(organizationId: string, query: string, limit = 4) {
	const terms = normalizeText(query)
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length >= 2);
	if (!terms.length) return [];
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.aiKnowledgeChunks)
		.where(eq(schema.aiKnowledgeChunks.organization_id, org))
		.orderBy(desc(schema.aiKnowledgeChunks.created_at))
		.limit(1000);
	if (!rows.length) return [];
	const scored = rows
		.map((r) => {
			const normTitle = normalizeText(r.title);
			const hay = `${normTitle} ${normalizeText(r.content)}`;
			let score = 0;
			for (const t of terms) {
				if (normTitle.includes(t)) score += 3;
				if (hay.includes(t)) score += 1;
			}
			return { row: r, score };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
	return scored.map((s) => s.row);
}

// ── Custom AI HTTP Actions (tool calling) ────────────────────────────────────

export async function listAiActions(organizationId: string) {
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.aiActions)
		.where(eq(schema.aiActions.organization_id, org))
		.orderBy(desc(schema.aiActions.updated_at));
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		description: r.description,
		method: r.method as "GET" | "POST",
		url: r.url,
		has_headers: Boolean(r.headers_encrypted),
		body_template: r.body_template,
		enabled: r.enabled,
		updated_at: r.updated_at,
	}));
}

function assertSafeActionUrlTemplate(rawUrl: string): URL {
	// Placeholders are only permitted in path/query, never in scheme, userinfo, host, or port.
	const originPart = /^https:\/\/[^/?#]*/i.exec(rawUrl)?.[0] ?? "";
	if (
		!originPart ||
		originPart.includes("{{") ||
		originPart.includes("}}") ||
		originPart.includes("@")
	) {
		throw validation(
			"Action URL placeholders ({{param}}) are only allowed in the path or query string, never in the hostname",
		);
	}
	const sanitized = rawUrl.replace(/\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/g, "placeholder");
	const parsed = new URL(sanitized);
	if (parsed.protocol !== "https:") throw validation("Action URL must use https://");
	if (isPrivateWebhookHost(parsed.toString())) {
		throw validation("Refused to use a private or localhost action URL");
	}
	return parsed;
}

export async function saveAiAction(organizationId: string, raw: unknown, now = Date.now()) {
	const v = actionInput.parse(raw ?? {});
	assertSafeActionUrlTemplate(v.url);
	const org = await organizationOf(organizationId);
	const existing = v.id
		? await db
				.select()
				.from(schema.aiActions)
				.where(
					and(eq(schema.aiActions.id, v.id), eq(schema.aiActions.organization_id, org)),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("AI action");

	const headersEncrypted = v.headers
		? await encryptSecret(JSON.stringify(v.headers))
		: (existing?.headers_encrypted ?? null);
	const id = existing?.id ?? `act_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	const at = iso(now);
	const row = {
		id,
		organization_id: org,
		name: v.name,
		description: v.description,
		method: v.method,
		url: v.url,
		headers_encrypted: headersEncrypted,
		body_template:
			v.body_template !== undefined ? v.body_template : (existing?.body_template ?? null),
		enabled: v.enabled ?? existing?.enabled ?? true,
		created_at: existing?.created_at ?? at,
		updated_at: at,
	};
	if (existing) {
		await db.update(schema.aiActions).set(row).where(eq(schema.aiActions.id, existing.id));
	} else {
		await db.insert(schema.aiActions).values(row);
	}
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		method: row.method as "GET" | "POST",
		url: row.url,
		has_headers: Boolean(row.headers_encrypted),
		body_template: row.body_template,
		enabled: row.enabled,
		updated_at: row.updated_at,
	};
}

export async function deleteAiAction(organizationId: string, id: string) {
	const org = await organizationOf(organizationId);
	const [removed] = await db
		.delete(schema.aiActions)
		.where(and(eq(schema.aiActions.id, id), eq(schema.aiActions.organization_id, org)))
		.returning({ id: schema.aiActions.id });
	if (!removed) throw notFound("AI action");
	return { deleted: true, id: removed.id };
}

/** Execute one custom AI HTTP action with origin-pinned {{param}} substitution, JSON escaping, and SSRF protection. */
export async function executeAiAction(
	organizationId: string,
	actionName: string,
	params: Record<string, string>,
): Promise<{ status: number; body: string }> {
	const org = await organizationOf(organizationId);
	const action = await db
		.select()
		.from(schema.aiActions)
		.where(
			and(
				eq(schema.aiActions.organization_id, org),
				eq(schema.aiActions.name, actionName),
				eq(schema.aiActions.enabled, true),
			),
		)
		.get();
	if (!action) throw notFound("AI action");

	const templateUrl = assertSafeActionUrlTemplate(action.url);
	const originPrefix = action.url.slice(
		0,
		action.url.indexOf("/", 8) === -1 ? action.url.length : action.url.indexOf("/", 8),
	);
	const restTemplate = action.url.slice(originPrefix.length);

	const substitutedRest = restTemplate.replace(
		/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
		(_m, k: string) => encodeURIComponent(params[k] ?? ""),
	);
	const finalUrl = new URL(`${originPrefix}${substitutedRest}`);
	if (finalUrl.origin !== templateUrl.origin || isPrivateWebhookHost(finalUrl.toString())) {
		throw validation(
			"Refused to call an action URL whose origin changed or points to a private host",
		);
	}

	const headers: Record<string, string> = { "user-agent": "Mailroom-AI-Actions/1.0" };
	if (action.headers_encrypted) {
		const rawHeaders = JSON.parse(await decryptSecret(action.headers_encrypted)) as Record<
			string,
			string
		>;
		for (const [k, v] of Object.entries(rawHeaders)) headers[k] = v;
	}
	const init: RequestInit = {
		method: action.method,
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(8_000),
	};
	if (action.method === "POST" && action.body_template) {
		headers["content-type"] = headers["content-type"] ?? "application/json";
		// Escape substituted values so customer-controlled strings cannot inject JSON syntax.
		init.body = action.body_template.replace(
			/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
			(_m, k: string) => JSON.stringify(String(params[k] ?? "")).slice(1, -1),
		);
	}
	const res = await fetch(finalUrl.toString(), init);
	const body = await readLimitedText(res, 4000);
	return { status: res.status, body };
}

/** Run enabled GET custom AI actions whose {{param}} placeholders can be filled from conversation context. */
export async function gatherAiActionContext(
	organizationId: string,
	params: Record<string, string>,
): Promise<{ name: string; description: string; body: string }[]> {
	const actions = (await listAiActions(organizationId)).filter(
		(a) => a.enabled && a.method === "GET",
	);
	if (!actions.length) return [];
	const runnable = actions
		.filter((a) => {
			const keys = [...a.url.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map(
				(m) => m[1] ?? "",
			);
			return keys.every((k) => Boolean(params[k]?.trim()));
		})
		.slice(0, 3);
	const out: { name: string; description: string; body: string }[] = [];
	await Promise.all(
		runnable.map(async (a) => {
			try {
				const res = await executeAiAction(organizationId, a.name, params);
				if (res.status >= 200 && res.status < 300 && res.body.trim()) {
					out.push({
						name: a.name,
						description: a.description,
						body: res.body.slice(0, 1500),
					});
				}
			} catch {
				// Live action failures never block drafting a reply.
			}
		}),
	);
	return out;
}
