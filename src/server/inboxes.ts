import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { bareAddress } from "./aws/mime";
import { sha256Hex } from "./aws/sigv4";
import { db, schema } from "./db";
import type { ActivityDetail, InboxPermission } from "./db/schema";
import { inboundDomain } from "./env";
import { ApiError, notFound, validation } from "./errors";
import { iso } from "./time";

/**
 * Agent inboxes: an address of a brand's that an app or an AI agent reads and answers with
 * credentials of its own, through the brand's receiving (its domains' SES rule, or the
 * deployment's Mailroom address): nothing new in AWS per inbox.
 *
 * - An inbox is local@<a receiving host of the brand's> (support@reply.acme.com), or, with no
 *   domain, <brand slug>+local@INBOUND_DOMAIN.
 * - A credential (mri_…) is held to its inboxes (the one it was made on, a list of the brand's,
 *   or every inbox of the brand), read-only unless granted more; `send` also has a reach
 *   ("replies": only people already in the conversation, or "anyone"). Each inbox's send allow
 *   and block lists apply to everyone who sends from it.
 * - Everything an agent does is in the inbox's activity.
 */

export type Inbox = typeof schema.inboxes.$inferSelect;
export type InboxCredential = typeof schema.inboxCredentials.$inferSelect;

export const INBOX_PERMISSIONS = ["read", "attachments", "triage", "draft", "send"] as const;
export const PERMISSION_TEXT: Record<InboxPermission, string> = {
	read: "read messages",
	attachments: "download attachments",
	triage: "resolve or reopen conversations",
	draft: "write drafts",
	send: "send email",
};
export type SendScope = "replies" | "anyone";

/** Who acts on inboxes: an agent's credential (one inbox), a person, or a full API key. */
export interface InboxActor {
	/** The organization (its webhooks and logs). */
	organizationId: string;
	/** The brands it may see. */
	brands: string[];
	/** A credential: only these inboxes (nothing outside them, not the brand's other mail);
	 * null: every inbox and address of its brands. */
	inboxIds: string[] | null;
	permissions: ReadonlySet<InboxPermission>;
	sendScope: SendScope;
	type: "agent" | "person" | "api";
	/** The credential's, person's or API key's id. */
	id: string | null;
	name: string;
	/** Whose read marks it reads and writes: "cred:<id>", "user:<id>"; null: none (an API key
	 * reads the conversation's shared state only). */
	reader: string | null;
	/** Sees runs of 4+ digits as dots (a person without "see codes"). */
	masked?: boolean;
}

/** A member of the organization (the dashboard, or MCP with OAuth): every inbox of its brands;
 * replying, drafting and resolving with "Reply to received email". */
export function memberActor(o: {
	organizationId: string;
	brands: string[];
	userId: string;
	name: string;
	canReply: boolean;
	masked: boolean;
}): InboxActor {
	return {
		organizationId: o.organizationId,
		brands: o.brands,
		inboxIds: null,
		permissions: new Set<InboxPermission>(
			o.canReply
				? ["read", "attachments", "triage", "draft", "send"]
				: ["read", "attachments"],
		),
		sendScope: "anyone",
		type: "person",
		id: o.userId,
		name: o.name,
		reader: `user:${o.userId}`,
		masked: o.masked,
	};
}

/** The dashboard's signed-in member as an inbox actor. */
export async function personOf(context: {
	organizationId: string;
	userId: string;
	email: string;
	name: string;
	masked: boolean;
	access: { can: (p: "inbox:reply") => boolean };
}) {
	const { brandIds } = await import("./brands");
	return memberActor({
		organizationId: context.organizationId,
		brands: await brandIds(context.organizationId),
		userId: context.userId,
		name: context.name || context.email,
		canReply: context.access.can("inbox:reply"),
		masked: context.masked,
	});
}

/** Everything (a full API key, the app itself). */
export const ALL_INBOX_PERMISSIONS: ReadonlySet<InboxPermission> = new Set(INBOX_PERMISSIONS);

export function need(actor: InboxActor, p: InboxPermission) {
	if (actor.permissions.has(p)) return;
	throw new ApiError(
		403,
		"missing_permission",
		actor.type === "agent"
			? `This credential can't ${PERMISSION_TEXT[p]}: grant it "${p}" on the inbox's page`
			: `You don't have permission to ${PERMISSION_TEXT[p]} here`,
	);
}

// ── Inboxes ────────────────────────────────────────────────────────────────

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const lower = (s: string) => s.trim().toLowerCase();

/** An address or a whole domain (acme.com or @acme.com) for the send lists. */
const listEntry = z
	.string()
	.trim()
	.toLowerCase()
	.transform((s) => s.replace(/^@/, ""))
	.refine((s) => /^([^\s@<>]+@)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s), "an address or a domain");

const sendList = z.array(listEntry).max(200).nullish();

export const inboxInput = z.object({
	name: z.string().trim().min(1).max(100),
	/** The part before the @ (support, invoices…). */
	local_part: z.string().trim().toLowerCase().max(64),
	/** One of the brand's receiving domains (its name or id); without it, the Mailroom address. */
	domain: z.string().trim().nullish(),
	reply_from: z.string().trim().max(320).nullish(),
	send_allow: sendList,
	send_block: sendList,
	description: z.string().trim().max(500).nullish(),
});

export const inboxUpdate = inboxInput.omit({ local_part: true, domain: true }).partial();

export async function inboxAddress(brandId: string, local: string, domainRef?: string | null) {
	if (!LOCAL_PART.test(local) || local.includes(".."))
		throw validation(
			"local_part: letters, digits, dots, dashes or underscores (no +: it's for tags)",
		);
	if (domainRef) {
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.organization_id, brandId));
		const ref = lower(domainRef);
		const row = d.find((x) => x.id === domainRef || x.name === ref || x.receiving_host === ref);
		if (!row) throw notFound("Domain");
		if (!row.receiving || !row.receiving_host)
			throw validation(
				`${row.name} doesn't receive email: turn receiving on on its page (or use the Mailroom address)`,
			);
		return { address: `${local}@${row.receiving_host}`, domainId: row.id };
	}
	const domain = inboundDomain();
	if (!domain)
		throw validation(
			"domain: this deployment has no Mailroom address domain, so pick one of yours",
		);
	const org = await db
		.select({ slug: schema.organization.slug })
		.from(schema.organization)
		.where(eq(schema.organization.id, brandId))
		.get();
	if (!org?.slug) throw notFound("Brand");
	return { address: `${org.slug}+${local}@${domain}`, domainId: null };
}

export async function createInbox(
	brandId: string,
	raw: unknown,
	by: { userId?: string | null } = {},
	now = Date.now(),
) {
	const v = inboxInput.parse(raw);
	const { address, domainId } = await inboxAddress(brandId, v.local_part, v.domain);
	const taken = await db
		.select({ id: schema.inboxes.id })
		.from(schema.inboxes)
		.where(eq(schema.inboxes.address, address))
		.get();
	if (taken) throw new ApiError(409, "inbox_exists", `${address} is already an inbox`);
	const row = {
		id: crypto.randomUUID(),
		organization_id: brandId,
		name: v.name,
		address,
		domain_id: domainId,
		reply_from: v.reply_from ? lower(v.reply_from) : null,
		send_allow: v.send_allow?.length ? v.send_allow : null,
		send_block: v.send_block?.length ? v.send_block : null,
		description: v.description || null,
		created_by: by.userId ?? null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(schema.inboxes).values(row);
	return row as Inbox;
}

export async function updateInbox(inbox: Inbox, raw: unknown, now = Date.now()) {
	const v = inboxUpdate.parse(raw ?? {});
	const set = {
		...(v.name !== undefined ? { name: v.name } : {}),
		...(v.reply_from !== undefined
			? { reply_from: v.reply_from ? lower(v.reply_from) : null }
			: {}),
		...(v.send_allow !== undefined
			? { send_allow: v.send_allow?.length ? v.send_allow : null }
			: {}),
		...(v.send_block !== undefined
			? { send_block: v.send_block?.length ? v.send_block : null }
			: {}),
		...(v.description !== undefined ? { description: v.description || null } : {}),
		updated_at: iso(now),
	};
	const [row] = await db
		.update(schema.inboxes)
		.set(set)
		.where(eq(schema.inboxes.id, inbox.id))
		.returning();
	return row as Inbox;
}

/** Removes the inbox and its credentials and webhooks; its conversations stay, in the brand's
 * Received (no longer any agent's). */
export async function deleteInbox(inbox: Inbox) {
	// Credentials made here that reach other inboxes too move to one of those (the rest go
	// with the inbox).
	const others = (await listCredentials(inbox)).filter(
		(c) => c.inbox_id === inbox.id && c.scope !== "inbox",
	);
	if (others.length) {
		const rest = await db
			.select({ id: schema.inboxes.id })
			.from(schema.inboxes)
			.where(eq(schema.inboxes.organization_id, inbox.organization_id));
		for (const c of others) {
			const home = rest.find(
				(i) =>
					i.id !== inbox.id &&
					(c.scope === "brand" || (c.inbox_ids ?? []).includes(i.id)),
			);
			if (home)
				await db
					.update(schema.inboxCredentials)
					.set({
						inbox_id: home.id,
						...(c.inbox_ids
							? { inbox_ids: c.inbox_ids.filter((x) => x !== inbox.id) }
							: {}),
					})
					.where(eq(schema.inboxCredentials.id, c.id));
		}
	}
	await db.batch([
		db
			.update(schema.conversations)
			.set({ inbox_id: null })
			.where(eq(schema.conversations.inbox_id, inbox.id)),
		db
			.update(schema.receivedEmails)
			.set({ inbox_id: null })
			.where(eq(schema.receivedEmails.inbox_id, inbox.id)),
		db.delete(schema.inboxes).where(eq(schema.inboxes.id, inbox.id)),
	]);
	forgetCredentials();
}

/** The inboxes an actor may see (a credential: its own). */
export async function listInboxes(actor: Pick<InboxActor, "brands" | "inboxIds">) {
	if (!actor.brands.length || actor.inboxIds?.length === 0) return [];
	return db
		.select()
		.from(schema.inboxes)
		.where(
			and(
				inArray(schema.inboxes.organization_id, actor.brands),
				actor.inboxIds ? inArray(schema.inboxes.id, actor.inboxIds) : undefined,
			),
		)
		.orderBy(schema.inboxes.name);
}

/** One inbox the actor may see, by id or address; not found otherwise (never "forbidden", so
 * another inbox's existence isn't told). */
export async function inboxFor(actor: Pick<InboxActor, "brands" | "inboxIds">, ref: string) {
	const r = lower(ref);
	const row = (await listInboxes(actor)).find((i) => i.id === ref || i.address === r);
	if (!row) throw notFound("Inbox");
	return row;
}

export const inboxView = (i: Inbox) => ({
	object: "inbox",
	id: i.id,
	brand_id: i.organization_id,
	name: i.name,
	address: i.address,
	domain_id: i.domain_id,
	reply_from: i.reply_from ?? (i.domain_id ? i.address : null),
	send_allow: i.send_allow ?? [],
	send_block: i.send_block ?? [],
	description: i.description,
	created_at: i.created_at,
	updated_at: i.updated_at,
});

/** The inbox a message to `to` is for, among the brand's: support+tag@ is support@'s. */
export function inboxOf(list: Pick<Inbox, "id" | "address">[], to: string) {
	const a = lower(to);
	const [local = "", host = ""] = [
		a.slice(0, a.lastIndexOf("@")),
		a.slice(a.lastIndexOf("@") + 1),
	];
	const mailroom = host === inboundDomain();
	// slug+local(+tag)@INBOUND_DOMAIN, or local(+tag)@host.
	const parts = local.split("+");
	const base = mailroom ? parts.slice(0, 2).join("+") : parts[0];
	return list.find((i) => i.address === `${base}@${host}`) ?? null;
}

export async function brandInboxes(brandId: string) {
	return db
		.select({ id: schema.inboxes.id, address: schema.inboxes.address })
		.from(schema.inboxes)
		.where(eq(schema.inboxes.organization_id, brandId));
}

// ── Who may be written to ──────────────────────────────────────────────────

const matchesEntry = (entry: string, address: string) =>
	entry.includes("@")
		? entry === address
		: address.endsWith(`@${entry}`) || address.endsWith(`.${entry}`);

/** Refuses recipients the inbox's lists don't allow (every send from it, by anyone). */
export function checkSendLists(
	inbox: Pick<Inbox, "send_allow" | "send_block">,
	recipients: string[],
) {
	for (const raw of recipients) {
		const a = lower(bareAddress(raw));
		if (inbox.send_block?.some((e) => matchesEntry(e, a)))
			throw new ApiError(403, "recipient_blocked", `${a} is on this inbox's send block list`);
		if (inbox.send_allow?.length && !inbox.send_allow.some((e) => matchesEntry(e, a)))
			throw new ApiError(
				403,
				"recipient_not_allowed",
				`${a} isn't on this inbox's send allow list`,
			);
	}
}

// ── Credentials ────────────────────────────────────────────────────────────

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const TOKEN_RE = /^mri_[A-Za-z0-9]{40}$/;

function newToken() {
	const bytes = crypto.getRandomValues(new Uint8Array(40));
	return `mri_${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("")}`;
}

export const credentialInput = z.object({
	name: z.string().trim().min(1).max(100),
	/** read is always included; the default is read-only. */
	permissions: z.array(z.enum(INBOX_PERMISSIONS)).max(5).optional(),
	send_scope: z.enum(["replies", "anyone"]).optional(),
	/** "inbox" (the one it's made on; the default), "inboxes" (inbox_ids) or "brand" (all). */
	scope: z.enum(["inbox", "inboxes", "brand"]).optional(),
	inbox_ids: z.array(z.string()).max(100).optional(),
});

export type CredentialScope = "inbox" | "inboxes" | "brand";

/** The scope and list a credential is saved with: other inboxes must be the same brand's. */
async function scopeOf(
	home: Pick<Inbox, "id" | "organization_id">,
	scope: CredentialScope | undefined,
	ids: string[] | undefined,
): Promise<{ scope: CredentialScope; inbox_ids: string[] | null }> {
	if (scope === "brand") return { scope, inbox_ids: null };
	if (scope !== "inboxes" && !(scope === undefined && ids?.length))
		return { scope: "inbox", inbox_ids: null };
	const wanted = [...new Set([home.id, ...(ids ?? [])])];
	const found = await db
		.select({ id: schema.inboxes.id })
		.from(schema.inboxes)
		.where(
			and(
				inArray(schema.inboxes.id, wanted),
				eq(schema.inboxes.organization_id, home.organization_id),
			),
		);
	const missing = wanted.find((id) => !found.some((f) => f.id === id));
	if (missing) throw notFound("Inbox");
	return { scope: "inboxes", inbox_ids: wanted };
}

/** Whether a credential reaches this inbox. */
export const reaches = (
	c: Pick<InboxCredential, "inbox_id" | "organization_id" | "scope" | "inbox_ids">,
	inbox: Pick<Inbox, "id" | "organization_id">,
) =>
	c.inbox_id === inbox.id ||
	(c.organization_id === inbox.organization_id &&
		(c.scope === "brand" || (c.scope === "inboxes" && !!c.inbox_ids?.includes(inbox.id))));

const normalize = (list: readonly InboxPermission[] | undefined): InboxPermission[] => {
	const set = new Set<InboxPermission>(["read", ...(list ?? [])]);
	return INBOX_PERMISSIONS.filter((p) => set.has(p));
};

export async function createCredential(
	inbox: Inbox,
	raw: unknown,
	by: { userId?: string | null } = {},
	now = Date.now(),
) {
	const v = credentialInput.parse(raw);
	const reach = await scopeOf(inbox, v.scope, v.inbox_ids);
	const token = newToken();
	const row = {
		id: crypto.randomUUID(),
		inbox_id: inbox.id,
		organization_id: inbox.organization_id,
		name: v.name,
		start: token.slice(0, 9),
		hash: await sha256Hex(token),
		permissions: normalize(v.permissions),
		send_scope: v.send_scope ?? "replies",
		...reach,
		created_by: by.userId ?? null,
		created_at: iso(now),
		last_used_at: null,
		rotated_at: null,
		revoked_at: null,
	};
	await db.insert(schema.inboxCredentials).values(row);
	return { credential: row as InboxCredential, token };
}

/** A credential that reaches this inbox (made on it, or on another inbox of the brand's with a
 * wider reach). */
export async function getCredential(inbox: Inbox, id: string) {
	const row = await db
		.select()
		.from(schema.inboxCredentials)
		.where(
			and(
				eq(schema.inboxCredentials.id, id),
				eq(schema.inboxCredentials.organization_id, inbox.organization_id),
			),
		)
		.get();
	if (!row || !reaches(row, inbox)) throw notFound("Credential");
	return row;
}

/** The credentials that reach this inbox. */
export async function listCredentials(inbox: Inbox) {
	const rows = await db
		.select()
		.from(schema.inboxCredentials)
		.where(eq(schema.inboxCredentials.organization_id, inbox.organization_id))
		.orderBy(desc(schema.inboxCredentials.created_at));
	return rows.filter((c) => reaches(c, inbox));
}

export async function updateCredential(c: InboxCredential, raw: unknown) {
	const v = credentialInput.partial().parse(raw ?? {});
	if (c.revoked_at) throw validation("This credential is revoked");
	const reach =
		v.scope !== undefined || v.inbox_ids !== undefined
			? await scopeOf(
					{ id: c.inbox_id, organization_id: c.organization_id },
					v.scope ?? (c.scope as CredentialScope),
					v.inbox_ids ?? c.inbox_ids ?? undefined,
				)
			: {};
	const [row] = await db
		.update(schema.inboxCredentials)
		.set({
			...(v.name ? { name: v.name } : {}),
			...(v.permissions ? { permissions: normalize(v.permissions) } : {}),
			...(v.send_scope ? { send_scope: v.send_scope } : {}),
			...reach,
		})
		.where(eq(schema.inboxCredentials.id, c.id))
		.returning();
	forgetCredentials();
	return row as InboxCredential;
}

/** A new secret for the credential; the old one stops working at once. */
export async function rotateCredential(c: InboxCredential, now = Date.now()) {
	if (c.revoked_at) throw validation("This credential is revoked: make a new one");
	const token = newToken();
	const [row] = await db
		.update(schema.inboxCredentials)
		.set({ hash: await sha256Hex(token), start: token.slice(0, 9), rotated_at: iso(now) })
		.where(eq(schema.inboxCredentials.id, c.id))
		.returning();
	forgetCredentials();
	return { credential: row as InboxCredential, token };
}

export async function revokeCredential(c: InboxCredential, now = Date.now()) {
	if (c.revoked_at) return c;
	const [row] = await db
		.update(schema.inboxCredentials)
		.set({ revoked_at: iso(now) })
		.where(eq(schema.inboxCredentials.id, c.id))
		.returning();
	forgetCredentials();
	return row as InboxCredential;
}

export const credentialView = (c: InboxCredential) => ({
	object: "inbox_credential",
	id: c.id,
	inbox_id: c.inbox_id,
	name: c.name,
	start: c.start,
	permissions: c.permissions,
	send_scope: c.send_scope,
	/** Which inboxes it reaches: "inbox" (inbox_id), "inboxes" (inbox_ids) or "brand" (all). */
	scope: c.scope as CredentialScope,
	inbox_ids: c.scope === "inboxes" ? (c.inbox_ids ?? [c.inbox_id]) : [c.inbox_id],
	status: c.revoked_at ? "revoked" : "active",
	created_at: c.created_at,
	last_used_at: c.last_used_at,
	rotated_at: c.rotated_at,
	revoked_at: c.revoked_at,
});

/** last_used_at is written at most every TOUCH_MS per credential (per isolate). */
const TOUCH_MS = 5 * 60_000;
const touched = new Map<string, number>();
/** Kept for callers: credentials aren't cached (a revoke or rotation holds at once everywhere). */
export const forgetCredentials = () => {};

/** The actor a Bearer mri_… token is, or null (unknown, revoked, or its inbox gone). Looked up
 * on every request, so revoking or rotating takes effect at once in every isolate. */
export async function authenticateInbox(
	header: string | null,
	now = Date.now(),
): Promise<InboxActor | null> {
	const token = /^Bearer\s+(mri_[A-Za-z0-9]+)\s*$/.exec(header ?? "")?.[1];
	if (!token || !TOKEN_RE.test(token)) return null;
	const hash = await sha256Hex(token);
	const row = await db
		.select({
			c: schema.inboxCredentials,
			brand: schema.inboxes.organization_id,
			parent: schema.brands.parent_id,
		})
		.from(schema.inboxCredentials)
		.innerJoin(schema.inboxes, eq(schema.inboxes.id, schema.inboxCredentials.inbox_id))
		.leftJoin(schema.brands, eq(schema.brands.id, schema.inboxes.organization_id))
		.where(
			and(eq(schema.inboxCredentials.hash, hash), isNull(schema.inboxCredentials.revoked_at)),
		)
		.get();
	if (!row) return null;
	// Its inboxes, as they are now (a brand-wide credential reaches inboxes made after it).
	const inboxIds =
		row.c.scope === "inbox"
			? [row.c.inbox_id]
			: (
					await db
						.select({ id: schema.inboxes.id })
						.from(schema.inboxes)
						.where(
							and(
								eq(schema.inboxes.organization_id, row.brand),
								row.c.scope === "inboxes"
									? inArray(
											schema.inboxes.id,
											row.c.inbox_ids ?? [row.c.inbox_id],
										)
									: undefined,
							),
						)
				).map((i) => i.id);
	if ((touched.get(row.c.id) ?? 0) < now - TOUCH_MS) {
		touched.set(row.c.id, now);
		await db
			.update(schema.inboxCredentials)
			.set({ last_used_at: iso(now) })
			.where(eq(schema.inboxCredentials.id, row.c.id));
	}
	return {
		organizationId: row.parent ?? row.brand,
		brands: [row.brand],
		inboxIds,
		permissions: new Set(row.c.permissions),
		sendScope: row.c.send_scope === "anyone" ? "anyone" : "replies",
		type: "agent",
		id: row.c.id,
		name: row.c.name,
		reader: `cred:${row.c.id}`,
	};
}

// ── Activity ───────────────────────────────────────────────────────────────

export async function logInbox(
	actor: Pick<InboxActor, "organizationId" | "type" | "id" | "name"> | "system",
	e: {
		brandId?: string;
		inboxId: string | null;
		conversationId?: string | null;
		action: string;
		detail?: ActivityDetail;
		now?: number;
	},
) {
	const who =
		actor === "system"
			? { type: "system", id: null, name: "Mailroom" }
			: { type: actor.type, id: actor.id, name: actor.name };
	try {
		await db.insert(schema.inboxActivity).values({
			id: crypto.randomUUID(),
			organization_id: e.brandId ?? (actor === "system" ? "" : actor.organizationId),
			inbox_id: e.inboxId,
			conversation_id: e.conversationId ?? null,
			actor_type: who.type,
			actor_id: who.id,
			actor_name: who.name,
			action: e.action,
			detail: e.detail ?? null,
			created_at: iso(e.now ?? Date.now()),
		});
	} catch (error) {
		console.error("inboxes: activity not logged", error);
	}
}

export async function inboxActivity(o: {
	inboxId?: string;
	conversationId?: string;
	before?: string;
	limit?: number;
}) {
	const a = schema.inboxActivity;
	return db
		.select()
		.from(a)
		.where(
			and(
				o.inboxId ? eq(a.inbox_id, o.inboxId) : undefined,
				o.conversationId ? eq(a.conversation_id, o.conversationId) : undefined,
				o.before ? lt(a.created_at, o.before) : undefined,
			),
		)
		.orderBy(desc(a.created_at))
		.limit(Math.min(o.limit ?? 50, 200));
}

export const activityView = (r: typeof schema.inboxActivity.$inferSelect) => ({
	object: "inbox_activity",
	id: r.id,
	inbox_id: r.inbox_id,
	conversation_id: r.conversation_id,
	actor: { type: r.actor_type, id: r.actor_id, name: r.actor_name },
	action: r.action,
	detail: r.detail ?? {},
	created_at: r.created_at,
});

/** Cron (daily): activity older than the retention of what it's about. */
export async function purgeInboxActivity(before: string) {
	await db.delete(schema.inboxActivity).where(lt(schema.inboxActivity.created_at, before));
}
