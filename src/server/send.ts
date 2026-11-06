import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { suppressedAmong, undeliverable } from "./address-checks";
import { bareAddress, buildMime, encodeAddress, utf8Base64 } from "./aws/mime";
import { SesError, sendRaw } from "./aws/ses";
import { sha256Hex } from "./aws/sigv4";
import { credentialsRefused, credentialsWorked } from "./aws-health";
import { brandIds, brandIn } from "./brands";
import { bump } from "./counters";
import { batch, db, schema } from "./db";
import type { AttachmentInfo, EmailStatus } from "./db/schema";
import { ApiError, validation } from "./errors";
import { firewallBlocks, getFirewall, RULE_LABEL } from "./firewall";
import { gunzipJson, gzipJson } from "./gzip";
import { mailboxRejected } from "./mailbox-checks";
import { domainFor, type OrgContext, orgContext } from "./org";
import { awsFor } from "./org-aws";
import { onOwnHost, ownHostBase } from "./public-host";
import { inScope } from "./queries";
import { advanceStatus } from "./status";
import { dayOf, iso } from "./time";
import { ownTracking, trackHtml, trackingBase } from "./tracking";
import { GROUP, unsubscribedAmong, withUnsubscribe } from "./unsubscribes";
import { emitEvent } from "./webhooks";

const GROUP_MESSAGE = "takes 1 to 128 letters, numbers, _ . : and - (an id of yours)";

/** The unsubscribe group of a Marketing domain's emails sent without one. */
export const MARKETING_GROUP = "marketing";

/**
 * Sending, the same for the API, the dashboard and the platform's own emails: validate, drop
 * suppressed and undeliverable recipients, record the email (and its body, compressed), then
 * either send it now through SES (single sends) or leave it queued for the Dispatcher (batches
 * and scheduled ones).
 */

// ── Input (Resend's shape, so Resend's SDKs work against Mailroom) ─────────────

const address = z
	.string()
	.trim()
	.max(320)
	.refine(
		// No line breaks anywhere: "Name <a@b>\r\nBcc: …" would add a header to the message.
		(a) => !/[\r\n\0]/.test(a) && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(bareAddress(a)),
		"is not a valid email address",
	);
const addresses = z
	.union([address, z.array(address)])
	.transform((v) => (Array.isArray(v) ? v : [v]));

const TAG = /^[A-Za-z0-9_-]{1,256}$/;
const tag = z.object({
	name: z.string().regex(TAG, "tag names may only use letters, numbers, _ and -"),
	value: z.string().regex(TAG, "tag values may only use letters, numbers, _ and -"),
});

/** base64, or a Node Buffer as JSON ({ type: "Buffer", data: [...] }), or bytes. */
const content = z
	.union([
		z.string(),
		z.object({ type: z.literal("Buffer"), data: z.array(z.number()) }),
		z.array(z.number()),
	])
	.transform((v) =>
		typeof v === "string"
			? v.replace(/\s+/g, "")
			: utf8Base64(Uint8Array.from(Array.isArray(v) ? v : v.data)),
	);

const attachment = z
	.object({
		filename: z.string().min(1).max(255),
		content: content.optional(),
		path: z.string().url().optional(),
		content_type: z.string().optional(),
		contentType: z.string().optional(),
		content_id: z.string().optional(),
		contentId: z.string().optional(),
	})
	.refine((a) => a.content || a.path, "an attachment needs content or path");

export const sendSchema = z
	.object({
		from: address,
		to: addresses.refine((v) => v.length > 0 && v.length <= 50, "to takes 1 to 50 addresses"),
		cc: addresses.optional(),
		bcc: addresses.optional(),
		reply_to: addresses.optional(),
		replyTo: addresses.optional(),
		subject: z.string().max(998),
		html: z.string().optional(),
		text: z.string().optional(),
		headers: z.record(z.string(), z.string()).optional(),
		attachments: z.array(attachment).max(30).optional(),
		tags: z.array(tag).max(40).optional(),
		scheduled_at: z.string().optional(),
		scheduledAt: z.string().optional(),
		/** Adds a one-click unsubscribe from this group (src/server/unsubscribes.ts). */
		unsubscribe_group: z.string().regex(GROUP, GROUP_MESSAGE).optional(),
		unsubscribeGroup: z.string().regex(GROUP, GROUP_MESSAGE).optional(),
		/** The brand it's from (id, slug or external id); without it, the From domain's brand. */
		brand: z.string().trim().min(1).max(200).optional(),
		/** Runs every check and answers what would happen, without recording or sending. */
		sandbox: z.boolean().optional(),
		/** Set by applyTemplate (src/server/templates.ts): the template it was made from. */
		template_id: z.string().max(200).optional(),
	})
	.refine((v) => v.html !== undefined || v.text !== undefined, "html or text is required");

export type SendInput = z.input<typeof sendSchema>;
type Parsed = z.output<typeof sendSchema>;

export function parseSend(body: unknown, where = ""): Parsed {
	const r = sendSchema.safeParse(body);
	if (r.success) return r.data;
	const issue = r.error.issues[0];
	const path = issue?.path.length ? `${where}${issue.path.join(".")}: ` : where;
	throw validation(`${path}${issue?.message ?? "invalid email"}`);
}

/** Total recipients per email (SES takes 50). */
const MAX_RECIPIENTS = 50;
/** A queued email's stored payload (with its attachments) at most, compressed. */
const MAX_QUEUED_BYTES = 1_500_000;
/** Scheduling is up to 30 days ahead (as Resend). */
const MAX_SCHEDULE_MS = 30 * 86_400_000;

export interface StoredContent {
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	/** Only while queued: what will be attached. */
	attachments?: { filename: string; content: string; contentType?: string; contentId?: string }[];
}

export interface SendOptions {
	source?: "api" | "dashboard" | "system" | "mcp" | "automation" | "agent";
	apiKeyId?: string | null;
	/** A sending key held to one domain. */
	onlyDomainId?: string | null;
	idempotencyKey?: string | null;
	/** Batch: queue everything for the Dispatcher instead of sending now. */
	queue?: boolean;
	now?: number;
	/** Skip the DNS checks (tests, the platform's own emails). */
	skipDns?: boolean;
	/** Waits for the account's rate before each SES call (the Dispatcher's gate), given the
	 * brand (its organization may send through its own account, paced apart). */
	gate?: (brandId: string) => Promise<void>;
	/** Check only: nothing is recorded or sent (`sandbox: true`). */
	sandbox?: boolean;
}

export interface Prepared {
	row: typeof schema.emails.$inferInsert;
	content: StoredContent;
	attachments: AttachmentInfo[];
	/** Inline images to keep for the dashboard's preview, by hash. */
	images: { hash: string; content_type: string; bytes: Uint8Array }[];
	/** The attachments as sent (base64). */
	files: NonNullable<StoredContent["attachments"]>;
}

const b64Size = (b64: string) =>
	Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** SES takes messages up to 40 MB; an attachment fetched by its path can't be bigger. */
const MAX_FETCHED = 40 * 1024 * 1024;

async function fetchAttachment(path: string): Promise<string> {
	if (!/^https?:\/\//i.test(path)) throw validation("attachment path must be an http(s) URL");
	const res = await fetch(path, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw validation(`attachment ${path} answered ${res.status}`);
	const tooBig = () => validation(`attachment ${path} is over 40 MB`);
	if (Number(res.headers.get("content-length") ?? 0) > MAX_FETCHED) throw tooBig();
	const parts: Uint8Array[] = [];
	let total = 0;
	const reader = res.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_FETCHED) {
			await reader.cancel();
			throw tooBig();
		}
		parts.push(value);
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		bytes.set(p, at);
		at += p.length;
	}
	return utf8Base64(bytes);
}

function parseSchedule(value: string | undefined, now: number): number | null {
	if (!value) return null;
	const at = Date.parse(value);
	if (Number.isNaN(at)) throw validation("scheduled_at must be an ISO 8601 date");
	if (at > now + MAX_SCHEDULE_MS) throw validation("scheduled_at can be up to 30 days ahead");
	return at <= now ? null : at;
}

/** Checks one email against the organization and turns it into rows. */
export async function prepare(ctx: OrgContext, input: Parsed, o: SendOptions): Promise<Prepared> {
	const now = o.now ?? Date.now();
	const fromAddress = bareAddress(input.from).toLowerCase();
	const domain = domainFor(ctx, fromAddress);
	if (!domain)
		throw new ApiError(
			403,
			"invalid_from_address",
			`The ${fromAddress.split("@")[1]} domain is not added to this brand. Add and verify it in Domains.`,
		);
	if (!domain.verified)
		throw new ApiError(
			403,
			"invalid_from_address",
			`The ${domain.name} domain is not verified yet.`,
		);
	if (ctx.paused)
		throw new ApiError(
			403,
			"brand_paused",
			ctx.paused.by === "mailroom"
				? "Mailroom paused this brand's sending; this deployment's admins can resume it."
				: "This brand's sending is paused; resume it in Brands.",
		);
	if (domain.paused)
		throw new ApiError(
			403,
			"domain_paused",
			domain.paused_reason === "unknown_recipients"
				? `Sending from ${domain.name} is paused: too many of its emails went to addresses that don't exist. Clean the list, then resume it in Domains.`
				: domain.paused_reason === "sending_limits"
					? `Mailroom paused sending from ${domain.name}: its bounces or complaints went over the sending limits. This deployment's admins can resume it.`
					: `Sending from ${domain.name} is paused; resume it in Domains.`,
		);
	if (o.onlyDomainId && o.onlyDomainId !== domain.id)
		throw new ApiError(
			403,
			"invalid_api_key",
			"This API key can only send from another domain.",
		);
	const to = input.to;
	const cc = input.cc ?? [];
	const bcc = input.bcc ?? [];
	if (to.length + cc.length + bcc.length > MAX_RECIPIENTS)
		throw validation(`An email takes at most ${MAX_RECIPIENTS} recipients (to, cc and bcc)`);
	const sendAt = parseSchedule(input.scheduled_at ?? input.scheduledAt, now);
	const files: Prepared["files"] = [];
	for (const a of input.attachments ?? [])
		files.push({
			filename: a.filename,
			content: a.content ?? (await fetchAttachment(a.path as string)),
			contentType: a.content_type ?? a.contentType,
			contentId: a.content_id ?? a.contentId,
		});
	const id = crypto.randomUUID();
	const content: StoredContent = {
		html: input.html,
		text: input.text,
		headers: input.headers,
	};
	const queued = !!sendAt || !!o.queue;
	const status: EmailStatus = sendAt ? "scheduled" : queued ? "queued" : "sending";
	return {
		row: {
			id,
			organization_id: ctx.id,
			from: input.from,
			to,
			cc: cc.length ? cc : null,
			bcc: bcc.length ? bcc : null,
			reply_to: (input.reply_to ?? input.replyTo) || null,
			subject: input.subject,
			tags: input.tags?.length ? input.tags : null,
			status,
			source: o.source ?? "api",
			api_key_id: o.apiKeyId ?? null,
			send_at: queued ? iso(sendAt ?? now) : null,
			created_at: iso(now),
			// Marketing email always carries a one-click unsubscribe (Gmail and Yahoo require it).
			unsubscribe_group:
				input.unsubscribe_group ??
				input.unsubscribeGroup ??
				(domain.purpose === "marketing" ? MARKETING_GROUP : null),
			template_id: input.template_id ?? null,
		},
		content,
		...(await describeAttachments(files)),
		files,
	};
}

/** Inline images Mailroom keeps (bigger ones only show as a placeholder in the preview). */
const MAX_INLINE_IMAGE = 300_000;
const IMAGE_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
};

/** Each attachment's name and size; an inline image (cid:) also hashed, to keep its bytes once. */
async function describeAttachments(files: Prepared["files"]) {
	const attachments: AttachmentInfo[] = [];
	const images = new Map<string, Prepared["images"][number]>();
	for (const f of files) {
		const size = b64Size(f.content);
		const type =
			(f.contentType?.split(";")[0]?.trim().toLowerCase() ||
				IMAGE_TYPES[f.filename.split(".").pop()?.toLowerCase() ?? ""]) ??
			"";
		if (!f.contentId || !type.startsWith("image/") || size > MAX_INLINE_IMAGE) {
			attachments.push({
				filename: f.filename,
				size,
				...(f.contentId ? { content_id: f.contentId } : {}),
			});
			continue;
		}
		const bytes = Uint8Array.from(atob(f.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
		const hash = await sha256Hex(bytes);
		images.set(hash, { hash, content_type: type, bytes });
		attachments.push({ filename: f.filename, size, content_id: f.contentId, image: hash });
	}
	return { attachments, images: [...images.values()] };
}

/**
 * Leaves out recipients that are suppressed, whose domain takes no email, or whose mailbox
 * Emailable says doesn't exist (first-time addresses only; they'd bounce). An
 * email left with nobody to send to is recorded as suppressed (or failed) and never sent.
 */
async function dropRecipients(ctx: OrgContext, prepared: Prepared[], o: SendOptions) {
	const all = prepared.flatMap((p) => [...p.row.to, ...(p.row.cc ?? []), ...(p.row.bcc ?? [])]);
	const bare = [...new Set(all.map((a) => bareAddress(a).toLowerCase()))];
	const [suppressed, dead, blocked] = await Promise.all([
		suppressedAmong(ctx.id, bare),
		o.skipDns
			? Promise.resolve({} as Record<string, string>)
			: undeliverable(bare, { now: o.now }),
		getFirewall(ctx.id).then((fw) => firewallBlocks(fw, bare)),
	]);
	const walled = Object.fromEntries(
		Object.entries(blocked).map(([a, rule]) => [a, `firewall: ${RULE_LABEL[rule]}`]),
	);
	// Emailable only for those still in, so a suppressed or dead-domain address is never paid for.
	const still = bare.filter((a) => !dead[a] && !walled[a] && !suppressed[a]);
	const rejected = o.skipDns
		? {}
		: await mailboxRejected(still, { now: o.now, cachedOnly: o.sandbox });
	const why = { ...rejected, ...dead, ...walled, ...suppressed };
	// Who left each email's unsubscribe group (only that group's emails skip them).
	const left = new Map<string, Set<string>>();
	for (const g of new Set(prepared.map((p) => p.row.unsubscribe_group).filter(Boolean)))
		left.set(g as string, await unsubscribedAmong(ctx.id, g as string, bare));
	if (!Object.keys(why).length && ![...left.values()].some((l) => l.size)) return;
	for (const p of prepared) {
		const gone = left.get(p.row.unsubscribe_group ?? "") ?? new Set<string>();
		const reasonOf = (a: string) =>
			why[a] ?? (gone.has(a) ? `unsubscribed (${p.row.unsubscribe_group})` : undefined);
		const keep = (list: string[] | null | undefined) =>
			(list ?? []).filter((a) => !reasonOf(bareAddress(a).toLowerCase()));
		const dropped: Record<string, string> = {};
		for (const a of [...p.row.to, ...(p.row.cc ?? []), ...(p.row.bcc ?? [])]) {
			const reason = reasonOf(bareAddress(a).toLowerCase());
			if (reason) dropped[bareAddress(a).toLowerCase()] = reason;
		}
		if (!Object.keys(dropped).length) continue;
		p.row.dropped = dropped;
		const to = keep(p.row.to);
		const cc = keep(p.row.cc);
		const bcc = keep(p.row.bcc);
		if (!to.length && !cc.length && !bcc.length) {
			const onlySuppressed = Object.values(dropped).every(
				(r) =>
					r.startsWith("suppressed") ||
					r.startsWith("unsubscribed") ||
					r.startsWith("firewall"),
			);
			p.row.status = onlySuppressed ? "suppressed" : "failed";
			p.row.error = Object.entries(dropped)
				.map(([a, r]) => `${a}: ${r}`)
				.join("; ");
			p.row.send_at = null;
		}
		// The original recipients stay on the record; who it really goes to is decided at send time.
	}
}

/** The recipients an email really goes to (its own minus the dropped ones). */
export function recipientsOf(
	row: Pick<typeof schema.emails.$inferSelect, "to" | "cc" | "bcc" | "dropped">,
) {
	const dropped = row.dropped ?? {};
	const keep = (list: string[] | null | undefined) =>
		(list ?? []).filter((a) => !dropped[bareAddress(a).toLowerCase()]);
	return { to: keep(row.to), cc: keep(row.cc), bcc: keep(row.bcc) };
}

/** Records the emails (and bodies) in one batch. */
async function record(prepared: Prepared[]) {
	const queries = [];
	for (const p of prepared) {
		const queued = p.row.status === "queued" || p.row.status === "scheduled";
		const stored: StoredContent =
			queued && p.files.length ? { ...p.content, attachments: p.files } : p.content;
		const bytes = await gzipJson(stored);
		if (queued && bytes.byteLength > MAX_QUEUED_BYTES)
			throw validation(
				"Attachments are too large to schedule or batch; send this email on its own",
			);
		queries.push(db.insert(schema.emails).values(p.row));
		for (const img of p.images)
			queries.push(
				db
					.insert(schema.inlineImages)
					.values({
						organization_id: p.row.organization_id,
						hash: img.hash,
						content_type: img.content_type,
						bytes: Buffer.from(img.bytes),
						last_used_at: p.row.created_at,
					})
					.onConflictDoUpdate({
						target: [schema.inlineImages.organization_id, schema.inlineImages.hash],
						set: { last_used_at: p.row.created_at },
					}),
			);
		queries.push(
			db.insert(schema.emailBodies).values({
				email_id: p.row.id as string,
				content: Buffer.from(bytes),
				attachments: p.attachments.length ? p.attachments : null,
				created_at: p.row.created_at,
			}),
		);
	}
	// One batch: one transaction (all or nothing) and one query against the per-request limit.
	await batch(queries);
}

/** Idempotency: the email already recorded under this key, if the request is the same. */
async function replay(organizationId: string, key: string, hash: string, now: number) {
	const e = schema.emails;
	const row = await db
		.select({ id: e.id, request_hash: e.request_hash, created_at: e.created_at })
		.from(e)
		.where(and(eq(e.organization_id, organizationId), eq(e.idempotency_key, key)))
		.get();
	if (!row) return null;
	// Keys last a day, as Resend's: after that the key is free again.
	if (Date.parse(row.created_at) < now - 86_400_000) {
		await db.update(e).set({ idempotency_key: null }).where(eq(e.id, row.id));
		return null;
	}
	if (row.request_hash !== hash)
		throw new ApiError(
			409,
			"invalid_idempotent_request",
			"This Idempotency-Key was used with another request",
		);
	return row.id;
}

/** A value SES accepts as a tag (letters, numbers, _ and -). */
const tagValue = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "_";

/** Sends one recorded email through SES now; its SES message id. */
export async function deliver(
	ctx: OrgContext,
	row: typeof schema.emails.$inferSelect,
	content: StoredContent,
	o: { gate?: (brandId: string) => Promise<void> } = {},
): Promise<string> {
	const { to, cc, bcc } = recipientsOf(row);
	// The one-click link is the first recipient's: send one email per address with a group.
	const first = to[0] ?? cc[0] ?? bcc[0];
	let body =
		row.unsubscribe_group && first
			? await withUnsubscribe(content, row.id, bareAddress(first))
			: content;
	const domain = domainFor(ctx, bareAddress(row.from));
	// Its links to Mailroom's public pages (unsubscribe, web version, polls…), on the domain's
	// own host once it has one (src/server/public-host.ts).
	if (domain) body = onOwnHost(body, ownHostBase(domain));
	// Opens and clicks, on the domain's own tracking host (src/server/tracking.ts).
	if (
		body.html &&
		domain &&
		(domain.open_tracking || domain.click_tracking) &&
		(await ownTracking())
	)
		body = {
			...body,
			html: await trackHtml(body.html, row.id, {
				open: domain.open_tracking,
				click: domain.click_tracking,
				base: trackingBase(domain),
			}),
		};
	const raw = buildMime({
		from: row.from,
		to,
		cc,
		replyTo: row.reply_to ?? undefined,
		subject: row.subject,
		html: body.html,
		text: body.text,
		headers: body.headers,
		attachments: body.attachments?.map((a) => ({
			filename: a.filename,
			content: a.content,
			contentType: a.contentType,
			contentId: a.contentId,
		})),
	});
	await o.gate?.(ctx.id);
	const messageId = await sendRaw(await awsFor(ctx.id), {
		raw: utf8Base64(raw),
		from: encodeAddress(row.from),
		to: to.map(bareAddress),
		cc: cc.map(bareAddress),
		bcc: bcc.map(bareAddress),
		...(domain?.purpose === "marketing" && ctx.marketing
			? { configurationSet: ctx.marketing.configurationSet, tenant: ctx.marketing.tenant }
			: { configurationSet: ctx.configurationSet, tenant: ctx.tenant }),
		tags: [
			{ name: "mailroom_id", value: row.id },
			{ name: "mailroom_org", value: tagValue(ctx.id) },
			...(row.tags ?? []).filter((t) => !t.name.startsWith("mailroom_")),
		],
	});
	await credentialsWorked(ctx.id).catch((error) =>
		console.error("send: credentials error not cleared", error),
	);
	return messageId;
}

/** After SES took an email. */
export async function markSent(emailId: string, messageId: string, now = Date.now()) {
	const e = schema.emails;
	await db
		.update(e)
		.set({
			message_id: messageId,
			status: advanceStatus("sent") as unknown as EmailStatus,
			sent_at: sql`COALESCE(${e.sent_at}, ${iso(now)})`,
			last_event: sql`COALESCE(${e.last_event}, 'sent')`,
			last_event_at: sql`COALESCE(${e.last_event_at}, ${iso(now)})`,
			locked_until: null,
		})
		.where(eq(e.id, emailId));
}

/** Transient SES failures are retried by the Dispatcher this many times (backing off). */
export const MAX_ATTEMPTS = 6;
export const retryDelayMs = (attempt: number) => Math.min(60 * 60_000, 30_000 * 2 ** attempt);

/** How long emails wait for an account's keys to work again, and how often they try. */
export const CREDENTIALS_WAIT_MS = 3 * 86_400_000;
export const CREDENTIALS_RETRY_MS = 10 * 60_000;

/** After SES refused an email: retry later (transient) or failed for good. */
export async function markRefused(
	row: Pick<typeof schema.emails.$inferSelect, "id" | "organization_id" | "attempts"> & {
		created_at?: string;
	},
	error: unknown,
	now = Date.now(),
): Promise<"retry" | "failed"> {
	const e = schema.emails;
	const transient = !(error instanceof SesError) || error.transient;
	const message = error instanceof Error ? error.message : String(error);
	// The account's keys don't work: the email waits (attempts untouched) until they do, up to
	// CREDENTIALS_WAIT_MS, and the admins hear of it once (aws-health.ts).
	if (
		error instanceof SesError &&
		error.credentials &&
		now - Date.parse(row.created_at ?? iso(now)) < CREDENTIALS_WAIT_MS
	) {
		await credentialsRefused(row.organization_id, message, now).catch((x) =>
			console.error("send: credentials error not kept", x),
		);
		await db
			.update(e)
			.set({
				status: "queued",
				error: message.slice(0, 500),
				send_at: iso(now + CREDENTIALS_RETRY_MS),
				locked_until: null,
			})
			// Only from sending: a run that took it over meanwhile (and sent it) keeps its word.
			.where(and(eq(e.id, row.id), eq(e.status, "sending")));
		return "retry";
	}
	const attempts = row.attempts + 1;
	if (transient && attempts < MAX_ATTEMPTS) {
		await db
			.update(e)
			.set({
				status: "queued",
				attempts,
				error: message.slice(0, 500),
				send_at: iso(now + retryDelayMs(attempts)),
				locked_until: null,
			})
			.where(and(eq(e.id, row.id), eq(e.status, "sending")));
		return "retry";
	}
	const [failed] = await db
		.update(e)
		.set({
			status: "failed",
			attempts,
			error: message.slice(0, 500),
			locked_until: null,
			send_at: null,
			last_event: "failed",
			last_event_at: iso(now),
		})
		.where(and(eq(e.id, row.id), eq(e.status, "sending")))
		.returning({ from: e.from });
	if (!failed) return "failed";
	await batch(bump(row.organization_id, dayOf(now), failed.from, "failed"));
	await emitEvent(
		row.organization_id,
		"email.failed",
		row.id,
		{ failed: { reason: message } },
		now,
	);
	return "failed";
}

export interface SendResult {
	id: string;
	status: EmailStatus | "sandbox";
	error?: ApiError;
	/** Sandbox: who it would go to, and who'd be left out and why. */
	sandbox?: { to: string[]; cc: string[]; bcc: string[]; dropped: Record<string, string> };
}

/**
 * The brand an organization's emails are from: the one `brand` names (id, slug or external id),
 * else the brand whose domain the From address uses, else the organization's own. Every email of
 * one request must be from the same brand.
 */
export async function brandForSend(organizationId: string, inputs: Parsed[]): Promise<string> {
	const named = [...new Set(inputs.map((i) => i.brand).filter(Boolean))] as string[];
	if (named.length > 1) throw validation("Every email of a batch must be from the same brand");
	const explicit = named[0] ? await brandIn(organizationId, named[0]) : null;
	const ids = await brandIds(organizationId);
	if (ids.length === 1) return explicit ?? organizationId;
	// The From hosts and their parents (news.hotel.com → news.hotel.com, hotel.com): the only
	// domain names that can match.
	const names = [
		...new Set(
			inputs.flatMap((i) => {
				const parts = (bareAddress(i.from).split("@")[1]?.toLowerCase() ?? "").split(".");
				return parts.slice(0, -1).map((_, n) => parts.slice(n).join("."));
			}),
		),
	].slice(0, 90);
	const rows = names.length
		? await db
				.select({ name: schema.domains.name, brand: schema.domains.organization_id })
				.from(schema.domains)
				.where(
					and(
						inScope(schema.domains.organization_id, { org: organizationId }),
						inArray(schema.domains.name, names),
					),
				)
		: [];
	const found = new Set<string>();
	for (const input of inputs) {
		const host = bareAddress(input.from).split("@")[1]?.toLowerCase() ?? "";
		const match = rows
			.filter((d) => host === d.name || host.endsWith(`.${d.name}`))
			.sort((a, b) => b.name.length - a.name.length)[0];
		if (match) found.add(match.brand);
	}
	if (found.size > 1) throw validation("Every email of a batch must be from the same brand");
	const fromDomain = [...found][0];
	if (explicit && fromDomain && fromDomain !== explicit)
		throw new ApiError(
			403,
			"invalid_from_address",
			"The From domain belongs to another brand than the one named in `brand`",
		);
	return explicit ?? fromDomain ?? organizationId;
}

/**
 * The API's and dashboard's send: one email (sent now or scheduled) or a batch (queued). Returns
 * the ids in order.
 */
export async function createEmails(
	organizationId: string,
	inputs: Parsed[],
	o: SendOptions & { kick?: () => Promise<void> } = {},
): Promise<SendResult[]> {
	const now = o.now ?? Date.now();
	const ctx = await orgContext(organizationId);
	if (!ctx.ready)
		throw new ApiError(
			403,
			"brand_not_ready",
			"This brand isn't set up for sending yet (Brands › Set up sending).",
		);
	const hash = o.idempotencyKey ? await sha256Hex(JSON.stringify(inputs)) : null;
	if (o.idempotencyKey && hash) {
		const first = await replay(organizationId, o.idempotencyKey, hash, now);
		if (first) {
			const keys = inputs.map((_, i) =>
				i === 0 ? (o.idempotencyKey as string) : `${o.idempotencyKey}#${i}`,
			);
			const rows: { id: string; status: EmailStatus; key: string | null }[] = [];
			// D1 takes up to 100 parameters a statement.
			for (let i = 0; i < keys.length; i += 90)
				rows.push(
					...(await db
						.select({
							id: schema.emails.id,
							status: schema.emails.status,
							key: schema.emails.idempotency_key,
						})
						.from(schema.emails)
						.where(
							and(
								eq(schema.emails.organization_id, organizationId),
								inArray(schema.emails.idempotency_key, keys.slice(i, i + 90)),
							),
						)),
				);
			const byKey = new Map(rows.map((r) => [r.key, r]));
			return inputs.map((_, i) => {
				const r = byKey.get(
					i === 0 ? (o.idempotencyKey as string) : `${o.idempotencyKey}#${i}`,
				);
				return { id: r?.id ?? first, status: r?.status ?? "queued" };
			});
		}
	}
	const prepared: Prepared[] = [];
	for (const [i, input] of inputs.entries()) {
		const p = await prepare(ctx, input, { ...o, now, queue: o.queue || inputs.length > 1 });
		if (o.idempotencyKey) {
			p.row.idempotency_key = i === 0 ? o.idempotencyKey : `${o.idempotencyKey}#${i}`;
			p.row.request_hash = hash;
		}
		prepared.push(p);
	}
	await dropRecipients(ctx, prepared, o);
	if (o.sandbox)
		return prepared.map((p) => {
			const r = recipientsOf({
				...p.row,
				cc: p.row.cc ?? null,
				bcc: p.row.bcc ?? null,
				dropped: p.row.dropped ?? null,
			});
			return {
				id: p.row.id as string,
				status: "sandbox" as const,
				sandbox: { ...r, dropped: p.row.dropped ?? {} },
			};
		});
	try {
		await record(prepared);
	} catch (error) {
		// Two requests with the same key at once: the other one recorded it.
		if (o.idempotencyKey && /UNIQUE/.test(String(error)) && hash) {
			const first = await replay(organizationId, o.idempotencyKey, hash, now);
			if (first) return [{ id: first, status: "queued" }];
		}
		throw error;
	}
	const results: SendResult[] = [];
	let queued = false;
	for (const p of prepared) {
		const row = p.row as typeof schema.emails.$inferSelect;
		if (row.status === "suppressed" || row.status === "failed") {
			await batch(bump(row.organization_id, dayOf(now), row.from, row.status));
			await emitEvent(
				organizationId,
				row.status === "suppressed" ? "email.suppressed" : "email.failed",
				row.id,
				{ reason: row.error },
				now,
			);
			results.push({ id: row.id, status: row.status });
			continue;
		}
		if (row.status !== "sending") {
			queued = true;
			if (row.status === "scheduled")
				await emitEvent(organizationId, "email.scheduled", row.id, {}, now);
			results.push({ id: row.id, status: row.status });
			continue;
		}
		try {
			const messageId = await deliver(
				ctx,
				{ ...row, attempts: 0 } as typeof row,
				{ ...p.content, attachments: p.files },
				o,
			);
			await markSent(row.id, messageId, Date.now());
			results.push({ id: row.id, status: "sent" });
		} catch (error) {
			console.error("send: SES refused", row.id, error);
			const outcome = await markRefused(
				{ id: row.id, organization_id: organizationId, attempts: 0 },
				error,
				now,
			);
			if (outcome === "retry") {
				queued = true;
				results.push({ id: row.id, status: "queued" });
			} else {
				const message = error instanceof Error ? error.message : String(error);
				results.push({
					id: row.id,
					status: "failed",
					error:
						error instanceof SesError && error.type === "MessageRejected"
							? new ApiError(422, "message_rejected", message)
							: new ApiError(422, "send_failed", message),
				});
			}
		}
	}
	if (queued) await o.kick?.();
	return results;
}

/** The stored content of an email (for a queued send or the dashboard's preview). */
export async function storedContent(emailId: string) {
	const row = await db
		.select()
		.from(schema.emailBodies)
		.where(eq(schema.emailBodies.email_id, emailId))
		.get();
	if (!row) {
		// A broadcast's email: its content is the broadcast's, for this contact.
		const email = await db
			.select({
				broadcast_id: schema.emails.broadcast_id,
				organization_id: schema.emails.organization_id,
				to: schema.emails.to,
			})
			.from(schema.emails)
			.where(eq(schema.emails.id, emailId))
			.get();
		if (!email?.broadcast_id) return null;
		const { broadcastContent } = await import("./broadcasts");
		const content = await broadcastContent(email);
		return content ? { content, attachments: [] as AttachmentInfo[] } : null;
	}
	return {
		content: await gunzipJson<StoredContent>(row.content as unknown as ArrayBuffer),
		attachments: row.attachments ?? [],
	};
}

/** An email's kept inline images as data: URLs by cid, for the dashboard's preview. */
export async function inlineImagesOf(
	organizationId: string,
	attachments: AttachmentInfo[],
): Promise<Record<string, string>> {
	const wanted = attachments.filter((a) => a.content_id && a.image);
	if (!wanted.length) return {};
	const rows = await db
		.select()
		.from(schema.inlineImages)
		.where(
			and(
				eq(schema.inlineImages.organization_id, organizationId),
				inArray(
					schema.inlineImages.hash,
					wanted.map((a) => a.image as string),
				),
			),
		);
	const byHash = new Map(
		rows.map((r) => [
			r.hash,
			`data:${r.content_type};base64,${Buffer.from(r.bytes as unknown as ArrayBuffer).toString("base64")}`,
		]),
	);
	const out: Record<string, string> = {};
	for (const a of wanted) {
		const url = byHash.get(a.image as string);
		if (url) out[(a.content_id as string).replace(/^<|>$/g, "")] = url;
	}
	return out;
}

/** The stored content of several emails in one query (the Dispatcher's run). */
export async function storedContents(emailIds: string[]) {
	const out = new Map<string, NonNullable<Awaited<ReturnType<typeof storedContent>>>>();
	if (!emailIds.length) return out;
	const rows = await db
		.select()
		.from(schema.emailBodies)
		.where(inArray(schema.emailBodies.email_id, emailIds));
	for (const row of rows)
		out.set(row.email_id, {
			content: await gunzipJson<StoredContent>(row.content as unknown as ArrayBuffer),
			attachments: row.attachments ?? [],
		});
	return out;
}
