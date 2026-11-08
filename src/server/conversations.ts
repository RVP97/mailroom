import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { maskDigits, maskedSearch, maskHeaders } from "../lib/permissions";
import { bareAddress } from "./aws/mime";
import { db, schema } from "./db";
import type { ReplyAttachment } from "./db/schema";
import { cfg } from "./env";
import { ApiError, notFound, validation } from "./errors";
import { attachmentsView, downloadUrl, parsedMessage, receivedView } from "./inbound";
import {
	afterSavedReply,
	assertFree,
	assign,
	claim,
	holderOf,
	listNotes,
	newText,
	noteView,
	PRIORITIES,
	planSla,
	release,
	releaseHeld,
	type SavedReply,
	savedReplyText,
	setPriority,
	setTags,
	settingsOf,
	signed,
	slaReplied,
	slaResolved,
	snooze,
} from "./inbox-workflow";
import { checkSendLists, type Inbox, type InboxActor, inboxFor, logInbox, need } from "./inboxes";
import { iso } from "./time";
import type { InboxEvent } from "./webhooks";

/**
 * Conversations: received emails and our replies, threaded by headers only. A message joins the
 * conversation that knows its Message-ID, its In-Reply-To or one of its References (in that
 * order), within its brand and inbox; nothing is joined by subject. Every message's own id and
 * the ids it references are remembered (conversation_refs), so a message that arrives after its
 * answer still joins it, and our replies are known as "email:<id>" (SES gives their
 * Message-ID only once sent; an answer to one names it, and inbound.ts's `answers` finds it).
 *
 * Read state is per reader; open or resolved is the conversation's. Agents (src/server/inboxes.ts)
 * see only their inbox's conversations; anyone else, the brands they may see.
 */

const c = schema.conversations;
const re = schema.receivedEmails;
const rp = schema.conversationReplies;

export type Conversation = typeof c.$inferSelect;
export type Reply = typeof rp.$inferSelect;

/** <Abc@Host> → abc@host. */
export const normalizeId = (id: string | null | undefined) =>
	id?.trim().replace(/^<|>$/g, "").trim().toLowerCase() || null;

/** "Ana <Ana@Example.com>" → ana@example.com; null when it isn't an address. */
export function addressOf(from: string | null | undefined) {
	const a = (/<([^>]+)>/.exec(from ?? "")?.[1] ?? from ?? "").trim().toLowerCase();
	return a.includes("@") ? a : null;
}

/** A References header's ids, oldest first. */
export const referenceIds = (header: string | string[] | null | undefined) =>
	[
		...new Set(
			((Array.isArray(header) ? header.join(" ") : header) ?? "").match(/<[^<>\s]+>/g) ?? [],
		),
	]
		.map(normalizeId)
		.filter((x): x is string => !!x)
		.slice(-50);

/** The first words of a message, without what it quotes. */
export function snippetOf(text: string | null | undefined) {
	if (!text) return null;
	const lines = [];
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*>/.test(line)) continue;
		if (/^On .+wrote:?\s*$/i.test(line.trim())) break;
		lines.push(line);
	}
	const s = lines.join(" ").replace(/\s+/g, " ").trim();
	return s ? s.slice(0, 200) : null;
}

// ── Threading ──────────────────────────────────────────────────────────────

export interface Threadable {
	id: string;
	organization_id: string;
	inbox_id: string | null;
	message_id: string | null;
	in_reply_to: string | null;
	references: string | null;
	answers_email_id: string | null;
	subject: string;
	from: string;
	created_at: string;
	/** Held as suspicious: its conversation is held from the start (agents never see it). */
	held?: boolean;
}

/**
 * Puts a received email in its conversation (a new one when no header names a known one).
 * Safe to run again for the same email: it's counted once.
 */
export async function threadReceived(
	row: Threadable,
	snippet: string | null,
	now = Date.now(),
): Promise<{ conversationId: string; created: boolean }> {
	const scope = row.inbox_id ?? "";
	const own = normalizeId(row.message_id);
	const parent = normalizeId(row.in_reply_to);
	const refs = (row.references ?? "").split(/\s+/).filter(Boolean);
	// Most telling first: our own id (a later message named it), what we answer, the newest
	// reference, then the email of ours it answers.
	const wanted = [
		...(own ? [own] : []),
		...(parent ? [parent] : []),
		...[...refs].reverse(),
		...(row.answers_email_id ? [`email:${row.answers_email_id}`] : []),
	];
	const known = wanted.length
		? await db
				.select()
				.from(schema.conversationRefs)
				.where(
					and(
						eq(schema.conversationRefs.organization_id, row.organization_id),
						eq(schema.conversationRefs.scope, scope),
						inArray(schema.conversationRefs.ref, [...new Set(wanted)].slice(0, 90)),
					),
				)
		: [];
	const hit = wanted.map((w) => known.find((k) => k.ref === w)).find(Boolean);
	let conversationId = hit?.conversation_id ?? null;
	// The row may already be threaded (the same notification again).
	const already = await db
		.select({ conversation_id: re.conversation_id })
		.from(re)
		.where(eq(re.id, row.id))
		.get();
	if (already?.conversation_id)
		return { conversationId: already.conversation_id, created: false };
	let created = false;
	if (!conversationId) {
		conversationId = crypto.randomUUID();
		created = true;
		await db.insert(c).values({
			id: conversationId,
			organization_id: row.organization_id,
			inbox_id: row.inbox_id,
			subject: row.subject.slice(0, 998),
			contact: row.from,
			contact_address: addressOf(row.from),
			status: "open",
			messages: 0,
			snippet,
			last_message_at: row.created_at,
			last_inbound_at: row.created_at,
			held_at: row.held ? iso(now) : null,
			created_at: iso(now),
			updated_at: iso(now),
		});
	}
	const ids = [...new Set([...(own ? [own] : []), ...(parent ? [parent] : []), ...refs])];
	// The message is threaded once: the same notification handled twice at the same moment
	// counts it once (the second finds it taken and leaves).
	const took = await db
		.update(re)
		.set({ conversation_id: conversationId })
		.where(and(eq(re.id, row.id), isNull(re.conversation_id)))
		.returning({ id: re.id });
	if (!took.length) {
		if (created) await dropIfEmpty(conversationId, row.id);
		const now2 = await db
			.select({ conversation_id: re.conversation_id })
			.from(re)
			.where(eq(re.id, row.id))
			.get();
		return { conversationId: now2?.conversation_id ?? conversationId, created: false };
	}
	// Two messages of one new thread at the same moment each started a conversation: the
	// younger one joins the older (both decide the same way, so they never swap).
	if (created && ids.length) {
		const mine = conversationId;
		await db.batch(
			chunk(ids, 20).map((part) =>
				db
					.insert(schema.conversationRefs)
					.values(
						part.map((ref) => ({
							organization_id: row.organization_id,
							scope,
							ref,
							conversation_id: mine,
						})),
					)
					.onConflictDoNothing(),
			) as never,
		);
		const owners = await db
			.selectDistinct({ id: schema.conversationRefs.conversation_id })
			.from(schema.conversationRefs)
			.where(
				and(
					eq(schema.conversationRefs.organization_id, row.organization_id),
					eq(schema.conversationRefs.scope, scope),
					inArray(schema.conversationRefs.ref, ids.slice(0, 90)),
				),
			);
		const others = owners.map((o) => o.id).filter((id) => id !== mine);
		if (others.length) {
			// Another conversation took one of its ids first: this message joins it (the oldest,
			// if several), and the one just made goes unless another message is already in it.
			const all = await db
				.select({ id: c.id, created_at: c.created_at })
				.from(c)
				.where(inArray(c.id, others));
			const target = all.sort((a, b) =>
				a.created_at === b.created_at
					? a.id.localeCompare(b.id)
					: a.created_at.localeCompare(b.created_at),
			)[0];
			if (target) {
				// Moved first, then the empty one removed: two that find each other never both vanish.
				await db.update(re).set({ conversation_id: target.id }).where(eq(re.id, row.id));
				await dropIfEmpty(mine, row.id);
				conversationId = target.id;
				created = false;
			}
		}
	}
	await db.batch([
		db
			.update(c)
			.set({
				messages: sql`${c.messages} + 1`,
				status: "open",
				resolved_at: null,
				// A new message brings a snoozed conversation back.
				snoozed_until: null,
				// Out of order: an older message doesn't take the newest's place.
				snippet: sql`CASE WHEN ${c.last_inbound_at} IS NULL OR ${c.last_inbound_at} <= ${row.created_at} THEN ${snippet} ELSE ${c.snippet} END`,
				last_message_at: sql`max(${c.last_message_at}, ${row.created_at})`,
				last_inbound_at: sql`max(coalesce(${c.last_inbound_at}, ''), ${row.created_at})`,
				...(row.held ? { held_at: sql`coalesce(${c.held_at}, ${iso(now)})` } : {}),
				updated_at: iso(now),
			})
			.where(eq(c.id, conversationId)),
		...chunk(ids, 20).map((part) =>
			db
				.insert(schema.conversationRefs)
				.values(
					part.map((ref) => ({
						organization_id: row.organization_id,
						scope,
						ref,
						conversation_id: conversationId as string,
					})),
				)
				.onConflictDoNothing(),
		),
	] as never);
	return { conversationId, created };
}

/**
 * Removes a conversation just made for `rowId` if nothing else is in it yet (its refs go with
 * it); true when it was removed. Another message already in it keeps it.
 */
async function dropIfEmpty(conversationId: string, rowId: string) {
	const gone = await db
		.delete(c)
		.where(
			and(
				eq(c.id, conversationId),
				eq(c.messages, 0),
				sql`NOT EXISTS (SELECT 1 FROM received_emails WHERE conversation_id = ${conversationId} AND id <> ${rowId})`,
			),
		)
		.returning({ id: c.id });
	if (!gone.length) return false;
	await db
		.delete(schema.conversationRefs)
		.where(eq(schema.conversationRefs.conversation_id, conversationId));
	return true;
}

const chunk = <T>(list: T[], n: number) =>
	Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// ── Reading ────────────────────────────────────────────────────────────────

/** What an actor may see: their brands, and an agent only its inboxes (and nothing held from
 * agents: suspicious mail waits for a person). */
function visible(actor: Pick<InboxActor, "brands" | "inboxIds"> & { type?: InboxActor["type"] }) {
	if (!actor.brands.length || actor.inboxIds?.length === 0) return sql`0`;
	return and(
		inArray(c.organization_id, actor.brands),
		actor.inboxIds ? inArray(c.inbox_id, actor.inboxIds) : undefined,
		actor.type === "agent" ? isNull(c.held_at) : undefined,
	);
}

// Spelled out: in a one-table select Drizzle leaves columns unqualified, and a subquery's own
// `id` would win.
const C_ID = sql.raw(`"conversations"."id"`);
const C_INBOUND = sql.raw(`"conversations"."last_inbound_at"`);

/**
 * Unread for this reader: a message came in after their conversation mark (conversation_reads,
 * everything up to read_at) that they haven't read on its own (message_reads). Backfilled
 * conversations (no last_inbound_at) are read for everyone.
 */
const unreadSql = (reader: string | null) =>
	reader
		? sql<number>`(${C_INBOUND} IS NOT NULL AND EXISTS (SELECT 1 FROM ${re} m WHERE m.conversation_id = ${C_ID} AND m.created_at > coalesce((SELECT r.read_at FROM ${schema.conversationReads} r WHERE r.conversation_id = ${C_ID} AND r.reader = ${reader}), '') AND NOT EXISTS (SELECT 1 FROM ${schema.messageReads} mr WHERE mr.message_id = m.id AND mr.reader = ${reader})))`
		: sql<number>`0`;

const draftsSql = sql<number>`(SELECT count(*) FROM ${rp} d WHERE d.conversation_id = ${C_ID} AND d.status IN ('draft', 'sending'))`;

export interface ConversationFilter {
	/** An inbox's id or address; "none": the brand's other addresses. */
	inbox?: string | null;
	/** "open" leaves out snoozed ones; "snoozed": only those. */
	status?: "open" | "snoozed" | "resolved" | "all" | null;
	unread?: boolean | null;
	/** "me", "none" (nobody has it), "anyone" (someone has it) or a reader ("user:…", "cred:…"). */
	assignee?: string | null;
	tag?: string | null;
	priority?: (typeof PRIORITIES)[number] | null;
	/** "due": a reply or resolution is due; "breached": it missed one. */
	sla?: "due" | "breached" | null;
	/** People only: conversations holding mail back from agents. */
	held?: boolean | null;
	/** In the subject or the contact. */
	search?: string | null;
	/** Cursor: the last id of the previous page. */
	after?: string | null;
	limit?: number;
	now?: number;
}

export async function listConversations(actor: InboxActor, f: ConversationFilter = {}) {
	need(actor, "read");
	const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
	const at = iso(f.now ?? Date.now());
	const conds = [visible(actor)];
	if (f.inbox === "none") {
		if (actor.inboxIds) return { has_more: false, data: [] };
		conds.push(isNull(c.inbox_id));
	} else if (f.inbox) conds.push(eq(c.inbox_id, (await inboxFor(actor, f.inbox)).id));
	const status = f.status ?? "open";
	const awake = or(isNull(c.snoozed_until), sql`${c.snoozed_until} <= ${at}`);
	if (status === "open") conds.push(eq(c.status, "open"), awake);
	else if (status === "snoozed") conds.push(sql`${c.snoozed_until} > ${at}`);
	else if (status !== "all") conds.push(eq(c.status, status));
	if (f.unread) conds.push(sql`${unreadSql(actor.reader)} = 1`);
	const held = or(isNull(c.claimed_until), sql`${c.claimed_until} > ${at}`);
	if (f.assignee === "none")
		conds.push(or(isNull(c.assignee), sql`${c.claimed_until} <= ${at}`) as never);
	else if (f.assignee === "anyone") conds.push(sql`${c.assignee} IS NOT NULL`, held as never);
	else if (f.assignee) {
		const who = f.assignee === "me" ? actor.reader : f.assignee;
		if (!who) return { has_more: false, data: [] };
		conds.push(eq(c.assignee, who), held as never);
	}
	if (f.tag?.trim())
		conds.push(
			sql`EXISTS (SELECT 1 FROM json_each(coalesce(${c.tags}, '[]')) t WHERE t.value = ${f.tag.trim().toLowerCase()})`,
		);
	if (f.priority) conds.push(eq(c.priority, f.priority));
	if (f.sla === "breached") conds.push(sql`${c.sla_breached} IS NOT NULL`);
	else if (f.sla === "due")
		conds.push(sql`(${c.sla_first_due_at} IS NOT NULL OR ${c.sla_resolve_due_at} IS NOT NULL)`);
	if (f.held && actor.type !== "agent") conds.push(sql`${c.held_at} IS NOT NULL`);
	const search = f.search?.trim().toLowerCase();
	if (search) {
		const p = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
		// Subjects hold the digits a masked member sees dotted: their search can't test for them.
		const inSubject = actor.masked ? maskedSearch(search) : search;
		const ps = inSubject ? `%${inSubject.replace(/[%_\\]/g, "\\$&")}%` : null;
		conds.push(
			or(
				eq(c.id, search),
				...(ps ? [sql`lower(${c.subject}) LIKE ${ps} ESCAPE '\\'`] : []),
				sql`lower(${c.contact}) LIKE ${p} ESCAPE '\\'`,
				ps
					? sql`EXISTS (SELECT 1 FROM ${re} m WHERE m.conversation_id = ${C_ID} AND (lower(m."from") LIKE ${p} ESCAPE '\\' OR lower(m.subject) LIKE ${ps} ESCAPE '\\'))`
					: sql`EXISTS (SELECT 1 FROM ${re} m WHERE m.conversation_id = ${C_ID} AND lower(m."from") LIKE ${p} ESCAPE '\\')`,
			) as never,
		);
	}
	if (f.after) {
		const cursor = await db
			.select({ at: c.last_message_at })
			.from(c)
			.where(and(eq(c.id, f.after), visible(actor)))
			.get();
		if (cursor)
			conds.push(
				or(
					lt(c.last_message_at, cursor.at),
					and(eq(c.last_message_at, cursor.at), lt(c.id, f.after)),
				) as never,
			);
	}
	const rows = await db
		.select({ c, unread: unreadSql(actor.reader), drafts: draftsSql })
		.from(c)
		.where(and(...conds))
		.orderBy(desc(c.last_message_at), desc(c.id))
		.limit(limit + 1);
	return {
		has_more: rows.length > limit,
		data: rows.slice(0, limit).map((r) => conversationView(r.c, r, actor, f.now)),
	};
}

export function conversationView(
	x: Conversation,
	extra: { unread: number | boolean; drafts: number },
	actor?: Pick<InboxActor, "masked"> & { type?: InboxActor["type"] },
	now = Date.now(),
) {
	const dots = (s: string | null) => (s && actor?.masked ? maskDigits(s) : s);
	const holder = holderOf(x, now);
	const snoozed = !!x.snoozed_until && x.snoozed_until > iso(now);
	return {
		object: "conversation",
		id: x.id,
		brand_id: x.organization_id,
		inbox_id: x.inbox_id,
		subject: dots(x.subject) ?? "",
		contact: x.contact,
		status: x.status as "open" | "resolved",
		unread: !!Number(extra.unread),
		messages: x.messages,
		drafts: Number(extra.drafts),
		snippet: dots(x.snippet),
		last_message_at: x.last_message_at,
		last_inbound_at: x.last_inbound_at,
		last_reply_at: x.last_reply_at,
		replied_by: x.replied_by,
		resolved_at: x.resolved_at,
		created_at: x.created_at,
		/** Who has it: an assignment, or an agent's claim until `until`. */
		assignee: holder
			? { reader: holder.reader, name: holder.name, type: holder.type, until: holder.until }
			: null,
		tags: x.tags ?? [],
		priority: (x.priority ?? "normal") as (typeof PRIORITIES)[number],
		snoozed_until: snoozed ? x.snoozed_until : null,
		first_reply_at: x.first_reply_at,
		sla: {
			reply_due_at: x.sla_first_due_at,
			resolve_due_at: x.sla_resolve_due_at,
			breached: (x.sla_breached ?? "").split(",").filter(Boolean) as ("reply" | "resolve")[],
		},
		csat: x.csat_rating
			? { rating: x.csat_rating, comment: x.csat_comment, at: x.csat_at }
			: x.csat_sent_at
				? { rating: null, comment: null, at: null, sent_at: x.csat_sent_at }
				: null,
		/** Mail in it waits for a person before agents see it (never true for an agent). */
		held: actor?.type === "agent" ? false : !!x.held_at,
		/** When mail was last held (people only): releasing passes it back, so later mail stays held. */
		held_at: actor?.type === "agent" ? null : x.held_at,
		channel: (x.channel === "chat" ? "chat" : "email") as "chat" | "email",
		...(x.channel === "chat"
			? {
					visitor: {
						name: x.visitor_name,
						email: x.visitor_email,
						page_url: x.page_url,
						seen_at: x.visitor_seen_at,
						/** Signed by the website: their id there and what it told us. */
						verified: !!x.visitor_user_id,
						user_id: x.visitor_user_id,
						attributes: x.visitor_attributes ?? null,
					},
				}
			: {}),
	};
}

/** One conversation the actor may see; not found otherwise. */
export async function conversationFor(actor: InboxActor, id: string) {
	const row = await db
		.select({ c, unread: unreadSql(actor.reader), drafts: draftsSql })
		.from(c)
		.where(and(eq(c.id, id), visible(actor)))
		.get();
	if (!row) throw notFound("Conversation");
	return row;
}

const TIMELINE_PAGE = 50;
const REPLY_AT = sql<string>`coalesce(${rp.sent_at}, ${rp.updated_at})`;

/** This reader's conversation mark and the messages they read on their own, among these. */
async function readState(reader: string | null, conversationId: string, ids: string[]) {
	if (!reader) return null;
	const [mark, rows] = await Promise.all([
		db
			.select({ at: schema.conversationReads.read_at })
			.from(schema.conversationReads)
			.where(
				and(
					eq(schema.conversationReads.conversation_id, conversationId),
					eq(schema.conversationReads.reader, reader),
				),
			)
			.get(),
		ids.length
			? db
					.select({ id: schema.messageReads.message_id })
					.from(schema.messageReads)
					.where(
						and(
							inArray(schema.messageReads.message_id, ids),
							eq(schema.messageReads.reader, reader),
						),
					)
			: [],
	]);
	return { mark: mark?.at ?? "", read: new Set(rows.map((r) => r.id)) };
}
const MAX_CHAT = 300;

/**
 * A conversation with its timeline, newest page first: what came in (with bodies unless
 * `bodies` is false; each read or unread for the caller), our replies and drafts, and the email
 * of ours it began as an answer to. `before` (the previous page's `before`) pages back.
 */
export async function getConversation(
	actor: InboxActor,
	id: string,
	o: {
		bodies?: boolean;
		html?: boolean;
		markRead?: boolean;
		before?: string | null;
		limit?: number;
		now?: number;
		/** An agent's `text` is each message's new part (without what it quotes) unless this. */
		full?: boolean;
	} = {},
) {
	need(actor, "read");
	const row = await conversationFor(actor, id);
	const limit = Math.min(Math.max(o.limit ?? TIMELINE_PAGE, 1), 100);
	const [allMessages, allReplies] = await Promise.all([
		db
			.select()
			.from(re)
			.where(
				and(eq(re.conversation_id, id), o.before ? lt(re.created_at, o.before) : undefined),
			)
			.orderBy(desc(re.created_at))
			.limit(limit + 1),
		db
			.select()
			.from(rp)
			.where(and(eq(rp.conversation_id, id), o.before ? lt(REPLY_AT, o.before) : undefined))
			.orderBy(desc(REPLY_AT))
			.limit(limit + 1),
	]);
	// The newest `limit` of both, together.
	const page = [
		...allMessages.map((m) => ({ at: m.created_at, m, r: null })),
		...allReplies.map((r) => ({ at: r.sent_at ?? r.updated_at, m: null, r })),
	]
		.sort((a, b) => b.at.localeCompare(a.at))
		.slice(0, limit);
	const hasMore = allMessages.length + allReplies.length > page.length;
	const messages = page.flatMap((p) => (p.m ? [p.m] : []));
	const replies = page.flatMap((p) => (p.r ? [p.r] : []));
	const state = await readState(
		actor.reader,
		id,
		messages.map((m) => m.id),
	);
	const unreadOf = (m: (typeof messages)[number]) =>
		!!state && !!row.c.last_inbound_at && m.created_at > state.mark && !state.read.has(m.id);
	const sentIds = replies.flatMap((r) => (r.email_id ? [r.email_id] : []));
	// The email it began as an answer to goes first, on the last page.
	const firstAnswers = hasMore
		? null
		: (messages.findLast((m) => m.answers_email_id)?.answers_email_id ?? null);
	const outbound = [...new Set([...sentIds, ...(firstAnswers ? [firstAnswers] : [])])];
	const emails = outbound.length
		? await db
				.select({
					id: schema.emails.id,
					status: schema.emails.status,
					last_event: schema.emails.last_event,
					sent_at: schema.emails.sent_at,
					from: schema.emails.from,
					to: schema.emails.to,
					subject: schema.emails.subject,
					created_at: schema.emails.created_at,
				})
				.from(schema.emails)
				.where(
					and(
						inArray(schema.emails.id, outbound),
						inArray(schema.emails.organization_id, actor.brands),
					),
				)
		: [];
	const dots = (s: string | null | undefined) =>
		s && actor.masked ? maskDigits(s) : (s ?? null);
	const bodies = o.bodies ?? true;
	const shortText = actor.type === "agent" && !o.full;
	const inbound = await Promise.all(
		messages.map(async (m) => {
			const v = await receivedView(m, bodies);
			const whole = (v as { text?: string | null }).text ?? null;
			const fresh = newText(whole);
			return {
				type: "inbound" as const,
				id: m.id,
				at: m.created_at,
				/** For the caller (each reader has their own). */
				unread: unreadOf(m),
				from: v.from,
				to: v.to,
				cc: v.cc,
				reply_to: v.reply_to,
				subject: dots(v.subject),
				message_id: v.message_id,
				...(bodies
					? {
							text: dots(shortText && fresh.trimmed ? fresh.text : whole),
							/** What it says new, without what it quotes or its signature. */
							new_text: dots(fresh.text),
							/** Whether `new_text` left something out (pass full=true for it all). */
							quoted: fresh.trimmed,
							// Masked readers get the text only (digits dotted), never the HTML.
							...(o.html
								? {
										html: actor.masked
											? null
											: ((v as { html?: string | null }).html ?? null),
									}
								: {}),
						}
					: {}),
				attachments: v.attachments,
				spam: v.spam,
				verdicts: v.verdicts,
				/** Why it looks suspicious (people only), and whether agents wait for a person. */
				flags: actor.type === "agent" ? null : (m.flags ?? null),
				held: actor.type === "agent" ? false : m.held,
			};
		}),
	);
	// Internal notes, on the newest page only (they're few).
	const notes = o.before
		? []
		: (await listNotes(id)).map((x) => ({
				type: "note" as const,
				at: x.created_at,
				...noteView(x),
				text: dots(x.text) ?? "",
			}));
	const out = replies.map((r) => {
		const found = emails.find((x) => x.id === r.email_id);
		// Held back in the queue (a paused brand) is still waiting, and can still be called back.
		const e =
			found?.status === "queued" && !found.sent_at
				? { ...found, status: "scheduled" as const }
				: found;
		return {
			type: r.status === "sent" ? ("reply" as const) : ("draft" as const),
			id: r.id,
			at: r.sent_at ?? r.updated_at,
			from: r.from,
			to: r.to,
			cc: r.cc ?? [],
			subject: dots(r.subject),
			text: dots(r.text),
			attachments: (r.attachments ?? []).map(({ key: _k, ...a }) => a),
			author: { type: r.author_type, id: r.author_id, name: r.author_name },
			sent_by: r.sent_by,
			review: r.review as "unchanged" | "edited" | null,
			email_id: r.email_id,
			delivery: e
				? e.status === "scheduled"
					? "scheduled"
					: (e.last_event ?? e.status)
				: null,
			/** Waiting to go (send later, or the undo window): it can still be called back. */
			scheduled_for: e?.status === "scheduled" ? (r.sent_at ?? null) : null,
		};
	});
	const origin = firstAnswers ? emails.find((e) => e.id === firstAnswers) : null;
	// A website chat's lines (src/server/chat.ts), the newest MAX_CHAT.
	const chat =
		row.c.channel === "chat"
			? await (async () => {
					const { chatLines, teamLines } = await import("./chat");
					const lines = await teamLines(await chatLines(id, { limit: MAX_CHAT }), o.now);
					return lines.map((l) => ({ ...l, text: dots(l.text) ?? "" }));
				})()
			: [];
	const timeline = [
		...(origin
			? [
					{
						type: "origin" as const,
						id: origin.id,
						at: origin.created_at,
						from: origin.from,
						to: origin.to,
						subject: dots(origin.subject),
						email_id: origin.id,
						delivery: origin.last_event ?? origin.status,
					},
				]
			: []),
		...inbound,
		...out,
		...chat,
		...notes,
	].sort((a, b) => a.at.localeCompare(b.at));
	if (o.markRead && actor.reader) await markRead(actor, row.c, true, o.now);
	// What an agent read is part of the inbox's audit trail.
	if (actor.type === "agent")
		await logInbox(actor, {
			brandId: row.c.organization_id,
			inboxId: row.c.inbox_id,
			conversationId: row.c.id,
			action: "conversation.read",
			detail: { messages: messages.length },
			now: o.now,
		});
	return {
		...conversationView(row.c, o.markRead ? { ...row, unread: 0 } : row, actor),
		timeline,
		/** Older items: pass this as `before`. */
		has_more: hasMore,
		before: hasMore ? (page.at(-1)?.at ?? null) : null,
	};
}

/** Marks the conversation read (or unread) for this reader only. */
export async function markRead(
	actor: InboxActor,
	x: Pick<Conversation, "id"> & { channel?: string },
	read: boolean,
	now = Date.now(),
) {
	if (!actor.reader) return;
	const r = schema.conversationReads;
	if (read) {
		await db
			.insert(r)
			.values({ conversation_id: x.id, reader: actor.reader, read_at: iso(now) })
			.onConflictDoUpdate({
				target: [r.conversation_id, r.reader],
				set: { read_at: iso(now) },
			});
		// A chat's visitor sees "Seen" under their message.
		if (x.channel === "chat") {
			const { teamSaw } = await import("./chat");
			await teamSaw(x.id, iso(now));
		}
	} else {
		const mr = schema.messageReads;
		await db.batch([
			db.delete(r).where(and(eq(r.conversation_id, x.id), eq(r.reader, actor.reader))),
			db
				.delete(mr)
				.where(
					and(
						eq(mr.reader, actor.reader),
						inArray(
							mr.message_id,
							db.select({ id: re.id }).from(re).where(eq(re.conversation_id, x.id)),
						),
					),
				),
		]);
	}
}

/**
 * Marks one received message read or unread for this reader only. Unread under their
 * conversation mark moves the mark back to just before it, keeping later messages read.
 */
export async function markMessage(
	actor: InboxActor,
	messageId: string,
	read: boolean,
	now = Date.now(),
) {
	need(actor, "read");
	const m = await messageFor(actor, messageId);
	const reader = actor.reader;
	if (!reader) return { id: m.id, unread: false };
	const mr = schema.messageReads;
	if (read) {
		await db
			.insert(mr)
			.values({ message_id: m.id, reader, read_at: iso(now) })
			.onConflictDoUpdate({ target: [mr.message_id, mr.reader], set: { read_at: iso(now) } });
		if (actor.type === "agent")
			await logInbox(actor, {
				brandId: m.organization_id,
				inboxId: m.inbox_id,
				conversationId: m.conversation_id,
				action: "message.read",
				detail: { message_id: m.id },
				now,
			});
		return { id: m.id, unread: false };
	}
	await db.delete(mr).where(and(eq(mr.message_id, m.id), eq(mr.reader, reader)));
	const cr = schema.conversationReads;
	const mark = m.conversation_id
		? await db
				.select()
				.from(cr)
				.where(and(eq(cr.conversation_id, m.conversation_id), eq(cr.reader, reader)))
				.get()
		: null;
	if (m.conversation_id && mark && mark.read_at >= m.created_at) {
		const back = iso(new Date(m.created_at).getTime() - 1);
		const later = await db
			.select({ id: re.id })
			.from(re)
			.where(
				and(
					eq(re.conversation_id, m.conversation_id),
					lt(re.created_at, mark.read_at),
					sql`${re.created_at} > ${back}`,
					sql`${re.id} != ${m.id}`,
				),
			);
		await db.batch([
			db
				.update(cr)
				.set({ read_at: back })
				.where(and(eq(cr.conversation_id, m.conversation_id), eq(cr.reader, reader))),
			...later.map((l) =>
				db
					.insert(mr)
					.values({ message_id: l.id, reader, read_at: iso(now) })
					.onConflictDoNothing(),
			),
		]);
	}
	return { id: m.id, unread: true };
}

export const conversationUpdate = z.object({
	status: z.enum(["open", "resolved"]).optional(),
	/** For the caller only: read or unread. */
	read: z.boolean().optional(),
	/** Replaces its tags; or add_tags / remove_tags. */
	tags: z.array(z.string()).max(20).optional(),
	add_tags: z.union([z.string(), z.array(z.string())]).optional(),
	remove_tags: z.union([z.string(), z.array(z.string())]).optional(),
	priority: z.enum(PRIORITIES).optional(),
	/** ISO time: out of Open until then; null wakes it. */
	snooze_until: z.string().nullable().optional(),
	/** "me", a reader ("user:<id>", "cred:<id>"), or null for nobody. */
	assignee: z.string().nullable().optional(),
	/** People: let agents see the mail held in it. */
	release_held: z.literal(true).optional(),
	/** With release_held: the held_at the person saw (mail held after it stays held). */
	held_seen: z.string().optional(),
	/** A website chat an agent has: to a person (round robin's next, or anyone), and the
	 * visitor is told. The agent holding it may always; others need triage. */
	hand_off: z.literal(true).optional(),
});

export async function updateConversation(
	actor: InboxActor,
	id: string,
	raw: unknown,
	now = Date.now(),
) {
	need(actor, "read");
	const v = conversationUpdate.parse(raw ?? {});
	const { c: x } = await conversationFor(actor, id);
	if (v.hand_off) {
		if (x.channel !== "chat") throw validation("hand_off: only a website chat is handed off");
		if (!actor.reader || actor.reader !== x.assignee) need(actor, "triage");
		const { getChatWidget, handOff } = await import("./chat");
		const { inboxOf } = await import("./inbox-workflow");
		const [widget, inbox] = await Promise.all([
			getChatWidget(x.inbox_id ?? ""),
			inboxOf(x.inbox_id),
		]);
		if (widget && inbox)
			Object.assign(
				x,
				await handOff(
					{ conversation: x, widget, inbox },
					actor.type === "agent" ? "agent" : "person",
					now,
				),
			);
	}
	if (v.tags !== undefined || v.add_tags !== undefined || v.remove_tags !== undefined)
		x.tags = await setTags(
			actor,
			x,
			{ tags: v.tags, add: v.add_tags, remove: v.remove_tags },
			now,
		);
	if (v.priority) await setPriority(actor, x, v.priority, now);
	if (v.assignee !== undefined) await assign(actor, x, v.assignee, now);
	if (v.release_held) await releaseHeld(actor, x, now, v.held_seen);
	if (v.snooze_until !== undefined) await snooze(actor, x, v.snooze_until, now);
	if (v.status && v.status !== x.status) {
		need(actor, "triage");
		const changed = await db
			.update(c)
			.set({
				status: v.status,
				resolved_at: v.status === "resolved" ? iso(now) : null,
				...(v.status === "resolved" ? { snoozed_until: null } : {}),
				updated_at: iso(now),
			})
			.where(
				and(
					eq(c.id, id),
					eq(c.status, x.status),
					// Resolving: not if a message came in since this was read (it reopened it).
					v.status === "resolved"
						? sql`coalesce(${c.last_inbound_at}, '') = ${x.last_inbound_at ?? ""}`
						: undefined,
				),
			)
			.returning({ id: c.id });
		if (!changed.length)
			throw new ApiError(
				409,
				"conversation_changed",
				"A new message came in or it changed meanwhile: look at it again",
			);
		if (v.status === "resolved") await slaResolved(x, now);
		else await planSla({ ...x, status: "open", sla_resolve_due_at: null }, now);
		await logInbox(actor, {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: id,
			action: v.status === "resolved" ? "conversation.resolved" : "conversation.reopened",
			now,
		});
		if (v.status === "resolved")
			await inboxEvent(x, "inbox.conversation.resolved", { resolved_by: who(actor) }, now);
		const { chatStatusChanged } = await import("./chat");
		await chatStatusChanged(x, v.status);
	}
	if (v.read !== undefined) await markRead(actor, x, v.read, now);
	const fresh = await conversationFor(actor, id);
	return conversationView(fresh.c, fresh, actor, now);
}

/** Claims it (an agent, for a while) or takes it (a person); `release` lets it go. */
export async function claimConversation(
	actor: InboxActor,
	id: string,
	o: { minutes?: number | null; force?: boolean; release?: boolean; now?: number } = {},
) {
	need(actor, "read");
	const now = o.now ?? Date.now();
	const { c: x } = await conversationFor(actor, id);
	if (o.release) await release(actor, x, now);
	else await claim(actor, x, { minutes: o.minutes, force: o.force, now });
	const fresh = await conversationFor(actor, id);
	return conversationView(fresh.c, fresh, actor, now);
}

const who = (a: Pick<InboxActor, "type" | "id" | "name">) => ({
	type: a.type,
	id: a.id,
	name: a.name,
});

// ── Messages ───────────────────────────────────────────────────────────────

function visibleMessages(
	actor: Pick<InboxActor, "brands" | "inboxIds"> & { type?: InboxActor["type"] },
) {
	if (!actor.brands.length || actor.inboxIds?.length === 0) return sql`0`;
	return and(
		inArray(re.organization_id, actor.brands),
		actor.inboxIds ? inArray(re.inbox_id, actor.inboxIds) : undefined,
		actor.type === "agent" ? eq(re.held, false) : undefined,
	);
}

export interface MessageSearch {
	inbox?: string | null;
	/** In from, to or the subject. */
	query?: string | null;
	from?: string | null;
	/** ISO date: received since. */
	since?: string | null;
	/** ISO time: received strictly after it (waiting for new mail). */
	after_time?: string | null;
	has_attachments?: boolean | null;
	after?: string | null;
	limit?: number;
}

export async function searchMessages(actor: InboxActor, f: MessageSearch = {}) {
	need(actor, "read");
	const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
	const conds = [visibleMessages(actor)];
	if (f.inbox === "none") conds.push(isNull(re.inbox_id));
	else if (f.inbox) conds.push(eq(re.inbox_id, (await inboxFor(actor, f.inbox)).id));
	const like = (s: string) =>
		`%${s
			.trim()
			.toLowerCase()
			.replace(/[%_\\]/g, "\\$&")}%`;
	if (f.query?.trim())
		conds.push(
			or(
				sql`lower(${re.from}) LIKE ${like(f.query)} ESCAPE '\\'`,
				sql`lower(${re.to}) LIKE ${like(f.query)} ESCAPE '\\'`,
				sql`lower(${re.subject}) LIKE ${like(f.query)} ESCAPE '\\'`,
			) as never,
		);
	if (f.from?.trim()) conds.push(sql`lower(${re.from}) LIKE ${like(f.from)} ESCAPE '\\'`);
	if (f.since) conds.push(sql`${re.created_at} >= ${f.since}`);
	if (f.after_time) conds.push(sql`${re.created_at} > ${f.after_time}`);
	if (f.has_attachments)
		conds.push(sql`json_array_length(coalesce(${re.attachments}, '[]')) > 0`);
	if (f.after) {
		const cursor = await db
			.select({ at: re.created_at })
			.from(re)
			.where(and(eq(re.id, f.after), visibleMessages(actor)))
			.get();
		if (cursor)
			conds.push(
				or(
					lt(re.created_at, cursor.at),
					and(eq(re.created_at, cursor.at), lt(re.id, f.after)),
				) as never,
			);
	}
	const rows = await db
		.select()
		.from(re)
		.where(and(...conds))
		.orderBy(desc(re.created_at), desc(re.id))
		.limit(limit + 1);
	return {
		has_more: rows.length > limit,
		data: await Promise.all(
			rows.slice(0, limit).map(async (r) => {
				const v = await receivedView(r, false);
				return {
					...v,
					inbox_id: r.inbox_id,
					conversation_id: r.conversation_id,
					subject: actor.masked ? maskDigits(v.subject) : v.subject,
				};
			}),
		),
	};
}

export async function messageFor(actor: InboxActor, id: string) {
	need(actor, "read");
	const row = await db
		.select()
		.from(re)
		.where(and(eq(re.id, id), visibleMessages(actor)))
		.get();
	if (!row) throw notFound("Message");
	return row;
}

/** One message with its content; attachment links only with "attachments". `markRead` marks
 * it read for the caller. */
export async function getMessage(
	actor: InboxActor,
	id: string,
	o: { markRead?: boolean; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const row = await messageFor(actor, id);
	const v = await receivedView(row);
	const m = actor.masked;
	if (o.markRead) await markMessage(actor, row.id, true, now);
	return {
		...v,
		inbox_id: row.inbox_id,
		conversation_id: row.conversation_id,
		headers: m ? maskHeaders(v.headers) : v.headers,
		subject: m ? maskDigits(v.subject) : v.subject,
		text: m && v.text ? maskDigits(v.text) : v.text,
		html:
			m && v.html
				? v.html.replace(/>([^<]+)</g, (_, t: string) => `>${maskDigits(t)}<`)
				: v.html,
		attachments: actor.permissions.has("attachments")
			? await attachmentsView(row, now)
			: v.attachments,
	};
}

/** Up to this size an attachment's bytes come in the answer (MCP); larger ones, a link. */
const INLINE_MAX = 2_000_000;

export async function getAttachment(
	actor: InboxActor,
	messageId: string,
	attachmentId: string,
	o: { content?: boolean; inlineMax?: number; now?: number } = {},
) {
	need(actor, "attachments");
	const row = await messageFor(actor, messageId);
	const index = (row.attachments ?? []).findIndex((a) => a.id === attachmentId);
	const meta = row.attachments?.[index];
	if (!meta) throw notFound("Attachment");
	const link = await downloadUrl(row.id, meta.id, o.now);
	let content: string | null = null;
	if (o.content && meta.size <= (o.inlineMax ?? INLINE_MAX)) {
		const parsed = await parsedMessage(row).catch(() => null);
		const a = parsed?.attachments[index];
		if (a) {
			const bytes =
				typeof a.content === "string"
					? new TextEncoder().encode(a.content)
					: new Uint8Array(a.content);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
			content = btoa(bin);
		}
	}
	await logInbox(actor, {
		brandId: row.organization_id,
		inboxId: row.inbox_id,
		conversationId: row.conversation_id,
		action: "attachment.downloaded",
		detail: { message_id: row.id, attachment_id: meta.id, filename: meta.filename },
	});
	return {
		object: "attachment",
		...meta,
		...link,
		...(o.content ? { content_base64: content } : {}),
	};
}

// ── Drafts and replies ─────────────────────────────────────────────────────

const addresses = z
	.union([z.string(), z.array(z.string())])
	.transform((v) =>
		(Array.isArray(v) ? v : v.split(/[,;]+/)).map((a) => a.trim()).filter(Boolean),
	);

const replyFile = z.union([
	/** A file already on the draft, kept. */
	z.object({ id: z.string() }).strict(),
	/** A new file. */
	z.object({
		filename: z.string().trim().min(1).max(255),
		content: z
			.string()
			.transform((s) => s.replace(/\s+/g, ""))
			.refine((s) => /^[A-Za-z0-9+/]*={0,2}$/.test(s), "content: base64"),
		content_type: z.string().max(255).optional(),
	}),
	/** An attachment of a message in this conversation, sent on. */
	z.object({ message_id: z.string(), attachment_id: z.string() }),
]);

export const replyInput = z.object({
	/** Replaces the draft's files when given ([] removes them). */
	attachments: z.array(replyFile).max(20).optional(),
	text: z.string().max(100_000).optional(),
	html: z.string().max(500_000).nullish(),
	to: addresses.optional(),
	cc: addresses.optional(),
	subject: z.string().trim().max(998).optional(),
	/** A person may pick the From (an address on one of the brand's sending domains). */
	from: z.string().trim().max(320).optional(),
	/** The newest message the writer read: when another came in since, the send is refused
	 * (409 conversation_changed) instead of answering something stale. */
	after_message: z.string().max(80).optional(),
	/** ISO time: sends it then (up to 30 days ahead); until then it can be called back. */
	send_at: z.string().max(40).optional(),
	/** A saved reply's id or shortcut: its text (when `text` isn't given), and what it also does. */
	saved_reply_id: z.string().max(80).optional(),
	/** false: without the inbox's signature. */
	signature: z.boolean().optional(),
});

// ── Reply attachments ──────────────────────────────────────────────────────

const MAX_REPLY_FILES = 20;
/** All of a reply's files together (SES takes 40 MB a message, base64 included). */
const MAX_REPLY_BYTES = 20 * 1024 * 1024;
const files = () => cfg().INBOUND ?? null;

function toBase64(bytes: Uint8Array) {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

const base64Size = (s: string) =>
	Math.floor((s.length * 3) / 4) - (s.match(/=+$/)?.[0].length ?? 0);

/** The files a draft or reply is to have: new ones stored, received ones checked (the caller
 * needs "attachments" to send those on), kept ones found among `current`. */
async function prepareFiles(
	actor: InboxActor,
	x: Pick<Conversation, "id">,
	input: z.infer<typeof replyFile>[],
	current: ReplyAttachment[],
): Promise<ReplyAttachment[]> {
	if (input.length > MAX_REPLY_FILES) throw validation(`Up to ${MAX_REPLY_FILES} files`);
	const out: ReplyAttachment[] = [];
	const stored: string[] = [];
	try {
		for (const f of input) {
			if ("id" in f) {
				const kept = current.find((a) => a.id === f.id);
				if (!kept) throw notFound("Attachment");
				out.push(kept);
			} else if ("message_id" in f) {
				need(actor, "attachments");
				const m = await messageFor(actor, f.message_id);
				if (m.conversation_id !== x.id) throw notFound("Message");
				const meta = m.attachments?.find((a) => a.id === f.attachment_id);
				if (!meta) throw notFound("Attachment");
				out.push({
					id: crypto.randomUUID(),
					filename: meta.filename ?? "attachment",
					content_type: meta.content_type,
					size: meta.size,
					message_id: m.id,
					attachment_id: meta.id,
				});
			} else {
				const bucket = files();
				if (!bucket) throw validation("Attachments need the INBOUND R2 bucket");
				const id = crypto.randomUUID();
				const key = `reply-files/${x.id}/${id}`;
				const bytes = Uint8Array.from(atob(f.content), (ch) => ch.charCodeAt(0));
				await bucket.put(key, bytes, {
					httpMetadata: { contentType: f.content_type ?? "application/octet-stream" },
				});
				stored.push(key);
				out.push({
					id,
					filename: f.filename,
					content_type: f.content_type ?? null,
					size: base64Size(f.content),
					key,
				});
			}
		}
		const total = out.reduce((n, a) => n + a.size, 0);
		if (total > MAX_REPLY_BYTES)
			throw validation(
				`Attachments: up to ${MAX_REPLY_BYTES / 1024 / 1024} MB together (these are ${(total / 1024 / 1024).toFixed(1)} MB)`,
			);
		return out;
	} catch (error) {
		await files()?.delete(stored);
		throw error;
	}
}

/** The files' bytes, for sending. */
async function fileContents(list: ReplyAttachment[]) {
	return Promise.all(
		list.map(async (a) => {
			let content: string | null = null;
			if (a.key) {
				const obj = await files()?.get(a.key);
				if (obj) content = toBase64(new Uint8Array(await obj.arrayBuffer()));
			} else if (a.message_id) {
				const m = await db.select().from(re).where(eq(re.id, a.message_id)).get();
				const index = (m?.attachments ?? []).findIndex((x) => x.id === a.attachment_id);
				const parsed = m && index >= 0 ? await parsedMessage(m).catch(() => null) : null;
				const p = parsed?.attachments[index];
				if (p)
					content = toBase64(
						typeof p.content === "string"
							? new TextEncoder().encode(p.content)
							: new Uint8Array(p.content),
					);
			}
			if (content === null)
				throw validation(
					`${a.filename} is no longer available: remove it and add it again`,
				);
			return {
				filename: a.filename,
				content,
				...(a.content_type ? { content_type: a.content_type } : {}),
			};
		}),
	);
}

/** Drops uploaded files' bytes (a draft discarded, a reply sent: the email keeps its own copy). */
async function dropFiles(list: ReplyAttachment[] | null | undefined) {
	const keys = (list ?? []).flatMap((a) => (a.key ? [a.key] : []));
	if (keys.length) await files()?.delete(keys);
}

const sentFiles = (list: ReplyAttachment[]) => list.map(({ key: _k, ...a }) => a);

async function inboxOfConversation(x: Conversation): Promise<Inbox | null> {
	if (!x.inbox_id) return null;
	return (
		(await db.select().from(schema.inboxes).where(eq(schema.inboxes.id, x.inbox_id)).get()) ??
		null
	);
}

/** The newest message that came in, what a reply answers. */
async function lastInbound(conversationId: string) {
	return db
		.select()
		.from(re)
		.where(eq(re.conversation_id, conversationId))
		.orderBy(desc(re.created_at))
		.get();
}

const lowerBare = (a: string) => bareAddress(a).toLowerCase();

/** Everyone already in the conversation: who wrote in, and who they and we wrote to. */
async function participants(conversationId: string, own: string[]) {
	const [msgs, sent] = await Promise.all([
		db
			.select({ from: re.from, to: re.to, cc: re.cc, reply_to: re.reply_to })
			.from(re)
			.where(eq(re.conversation_id, conversationId)),
		db
			.select({ to: rp.to, cc: rp.cc })
			.from(rp)
			.where(and(eq(rp.conversation_id, conversationId), eq(rp.status, "sent"))),
	]);
	const all = new Set<string>();
	for (const m of msgs)
		for (const a of [m.from, ...m.to, ...(m.cc ?? []), ...(m.reply_to ?? [])])
			all.add(lowerBare(a));
	for (const s of sent) for (const a of [...s.to, ...(s.cc ?? [])]) all.add(lowerBare(a));
	for (const a of own) all.delete(a.toLowerCase());
	return all;
}

/** What a reply would be, filled in where the caller left it out. */
async function replyDefaults(x: Conversation, inbox: Inbox | null) {
	// A website chat's reply goes to the chat (and to the visitor's email only if they left).
	if (x.channel === "chat")
		return {
			last: undefined,
			to: x.visitor_email ? [x.visitor_email] : [],
			subject: x.subject,
			from: inbox ? (inbox.reply_from ?? (inbox.domain_id ? inbox.address : null)) : null,
		};
	const last = await lastInbound(x.id);
	const to = last ? (last.reply_to?.length ? last.reply_to : [last.from]) : [x.contact];
	const subject = /^re:/i.test(x.subject) ? x.subject : `Re: ${x.subject || "(no subject)"}`;
	const from = inbox
		? (inbox.reply_from ?? (inbox.domain_id ? inbox.address : null))
		: (last?.recipients[0] ?? last?.to[0] ?? null);
	return { last, to, subject, from };
}

/** What the reply box starts with: who it goes to, from where, and its subject. */
export async function composeDefaults(actor: InboxActor, conversationId: string) {
	const { c: x } = await conversationFor(actor, conversationId);
	const inbox = await inboxOfConversation(x);
	const d = await replyDefaults(x, inbox);
	return {
		from: d.from,
		to: d.to,
		subject: actor.masked ? maskDigits(d.subject) : d.subject,
		fixed_from: !!inbox,
	};
}

/** A subject as written: the dotted default a masked member was shown is the real one. */
const realSubject = (actor: InboxActor, given: string | null | undefined, real: string) =>
	given && actor.masked && given === maskDigits(real) ? real : given;

export async function saveDraft(
	actor: InboxActor,
	conversationId: string,
	raw: unknown,
	o: { draftId?: string; now?: number } = {},
) {
	need(actor, "draft");
	const now = o.now ?? Date.now();
	const v = replyInput.parse(raw ?? {});
	const { c: x } = await conversationFor(actor, conversationId);
	assertFree(actor, x, now);
	if (v.saved_reply_id && v.text === undefined)
		v.text = (await savedReplyText(actor, x, v.saved_reply_id)).text;
	const inbox = await inboxOfConversation(x);
	const d = await replyDefaults(x, inbox);
	const from = actor.type === "agent" ? d.from : (v.from ?? d.from);
	if (o.draftId) {
		const draft = await draftFor(actor, o.draftId);
		if (draft.conversation_id !== x.id) throw notFound("Draft");
		// A person changing an agent's draft: it went out edited, not as the agent wrote it.
		const edited =
			draft.author_type === "agent" &&
			actor.type !== "agent" &&
			v.text !== undefined &&
			v.text !== draft.text;
		const attachments = v.attachments
			? await prepareFiles(actor, x, v.attachments, draft.attachments ?? [])
			: undefined;
		if (attachments)
			await dropFiles(
				draft.attachments?.filter((a) => !attachments.some((n) => n.id === a.id)),
			);
		const [row] = await db
			.update(rp)
			.set({
				...(attachments ? { attachments: attachments.length ? attachments : null } : {}),
				...(v.text !== undefined ? { text: v.text } : {}),
				...(v.html !== undefined ? { html: v.html ?? null } : {}),
				...(v.to ? { to: v.to } : {}),
				...(v.cc ? { cc: v.cc.length ? v.cc : null } : {}),
				...(v.subject ? { subject: v.subject } : {}),
				...(actor.type !== "agent" && v.from ? { from: v.from } : {}),
				...(edited ? { review: "edited" } : {}),
				updated_at: iso(now),
			})
			.where(eq(rp.id, draft.id))
			.returning();
		await logInbox(actor, {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: x.id,
			action: "draft.updated",
			detail: { draft_id: draft.id },
			now,
		});
		return replyView(row as Reply);
	}
	if (!v.text?.trim()) throw validation("text: write the reply");
	const attachments = v.attachments?.length
		? await prepareFiles(actor, x, v.attachments, [])
		: null;
	const row = {
		attachments,
		id: crypto.randomUUID(),
		organization_id: x.organization_id,
		conversation_id: x.id,
		inbox_id: x.inbox_id,
		in_reply_to: d.last?.id ?? null,
		status: "draft",
		from,
		to: v.to?.length ? v.to : d.to,
		cc: v.cc?.length ? v.cc : null,
		subject: realSubject(actor, v.subject, d.subject) || d.subject,
		text: v.text,
		html: v.html ?? null,
		author_type: actor.type,
		author_id: actor.id,
		author_name: actor.name,
		sent_by: null,
		review: null,
		email_id: null,
		sent_at: null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(rp).values(row);
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "draft.created",
		detail: { draft_id: row.id, can_send: actor.permissions.has("send") },
		now,
	});
	await inboxEvent(
		x,
		"inbox.draft.created",
		{ draft_id: row.id, author: who(actor), needs_review: !actor.permissions.has("send") },
		now,
	);
	return replyView(row as Reply);
}

/** A stuck "sending" draft (its send's Worker died) is a draft again after this. */
const DRAFT_LOCK_MS = 2 * 60_000;

/** Takes a draft for one send: draft → sending, or 409 if another send has it. */
async function lockDraft(id: string, now: number) {
	const took = await db
		.update(rp)
		.set({ status: "sending", updated_at: iso(now) })
		.where(
			and(
				eq(rp.id, id),
				or(
					eq(rp.status, "draft"),
					and(eq(rp.status, "sending"), lt(rp.updated_at, iso(now - DRAFT_LOCK_MS))),
				),
			),
		)
		.returning({ id: rp.id });
	if (!took.length)
		throw new ApiError(409, "draft_being_sent", "This draft is already being sent");
}

/** A send that failed: its draft is a draft again. */
async function unlockDraft(id: string) {
	await db
		.update(rp)
		.set({ status: "draft" })
		.where(and(eq(rp.id, id), eq(rp.status, "sending")));
}

export async function draftFor(actor: InboxActor, id: string) {
	const row = await db
		.select({ r: rp })
		.from(rp)
		.innerJoin(c, eq(c.id, rp.conversation_id))
		.where(and(eq(rp.id, id), visible(actor)))
		.get();
	if (!row) throw notFound("Draft");
	// One left "sending" by a send that died is a draft again after a while.
	const stuck = row.r.status === "sending" && row.r.updated_at < iso(Date.now() - DRAFT_LOCK_MS);
	if (row.r.status === "sending" && !stuck)
		throw new ApiError(409, "draft_being_sent", "This draft is already being sent");
	if (row.r.status !== "draft" && !stuck) throw notFound("Draft");
	return row.r;
}

export async function deleteDraft(actor: InboxActor, id: string) {
	need(actor, "draft");
	const d = await draftFor(actor, id);
	await db.delete(rp).where(eq(rp.id, d.id));
	await dropFiles(d.attachments);
	await logInbox(actor, {
		brandId: d.organization_id,
		inboxId: d.inbox_id,
		conversationId: d.conversation_id,
		action: "draft.discarded",
		detail: { draft_id: d.id, author_type: d.author_type, author: d.author_name },
	});
}

export const replyView = (r: Reply) => ({
	object: r.status === "sent" ? "reply" : "draft",
	id: r.id,
	conversation_id: r.conversation_id,
	inbox_id: r.inbox_id,
	status: r.status,
	from: r.from,
	to: r.to,
	cc: r.cc ?? [],
	subject: r.subject,
	text: r.text,
	html: r.html,
	attachments: sentFiles(r.attachments ?? []),
	author: { type: r.author_type, id: r.author_id, name: r.author_name },
	sent_by: r.sent_by,
	review: r.review,
	email_id: r.email_id,
	sent_at: r.sent_at,
	created_at: r.created_at,
	updated_at: r.updated_at,
});

export interface Sender {
	/** Sends an email of the brand's (createEmails with the caller's options); its id. */
	send: (brandId: string, input: Record<string, unknown>) => Promise<string>;
	/** Sent from the dashboard (a chat line says so). */
	dashboard?: boolean;
}

/**
 * Sends a reply in the conversation: a draft (`draftId`, edits in `raw` applied first) or new
 * content. In the same thread in their mailbox (In-Reply-To, References), Reply-To the inbox.
 * An agent reaches only the people already in it unless its credential may write to anyone;
 * the inbox's send lists hold for everyone.
 */
export async function sendReply(
	actor: InboxActor,
	conversationId: string,
	raw: unknown,
	sender: Sender,
	o: {
		draftId?: string;
		now?: number;
		clientId?: string | null;
		/** A rule's automatic answer: it doesn't count as the team's reply (SLA, response times). */
		automatic?: boolean;
	} = {},
) {
	need(actor, "send");
	const now = o.now ?? Date.now();
	const v = replyInput.parse(raw ?? {});
	const { c: x } = await conversationFor(actor, conversationId);
	if (!o.automatic) assertFree(actor, x, now);
	const draft = o.draftId ? await draftFor(actor, o.draftId) : null;
	if (draft && draft.conversation_id !== x.id) throw notFound("Draft");
	let saved: SavedReply | null = null;
	if (v.saved_reply_id) {
		const used = await savedReplyText(actor, x, v.saved_reply_id);
		saved = used.reply;
		if (v.text === undefined && !draft) v.text = used.text;
	}
	// Something came in after what the writer read: they'd answer something stale.
	if (v.after_message) {
		const newest = await lastInbound(x.id);
		if (newest && newest.id !== v.after_message)
			throw new ApiError(
				409,
				"conversation_changed",
				`A new message came in (${newest.id}) since the one this reply answers: read it first`,
			);
	}
	// A website chat: the line goes to the chat (src/server/chat.ts).
	if (x.channel === "chat") {
		const { lineAsReply, teamSays } = await import("./chat");
		if (draft) await lockDraft(draft.id, now);
		try {
			const line = await teamSays(
				actor,
				x,
				{
					text: v.text ?? draft?.text ?? "",
					via: actor.type === "person" && sender.dashboard ? "dashboard" : "api",
					draft,
					client_id: o.clientId ?? null,
				},
				now,
			);
			return lineAsReply(line, x);
		} catch (error) {
			if (draft) await unlockDraft(draft.id);
			throw error;
		}
	}
	const inbox = await inboxOfConversation(x);
	const d = await replyDefaults(x, inbox);
	const written = v.text ?? draft?.text ?? "";
	if (!written.trim()) throw validation("text: write the reply");
	const text =
		v.signature === false || o.automatic ? written : signed(written, inbox, actor.name);
	// Send later (or the inbox's undo window for people in the dashboard).
	const undo = settingsOf(inbox).undo_seconds;
	let sendAt: number | null = null;
	if (v.send_at) {
		sendAt = Date.parse(v.send_at);
		if (Number.isNaN(sendAt)) throw validation("send_at: an ISO 8601 date and time");
		if (sendAt <= now + 5_000) sendAt = null;
		else if (sendAt > now + 30 * 86_400_000) throw validation("send_at: up to 30 days ahead");
	} else if (undo > 0 && actor.type === "person" && sender.dashboard && !o.automatic)
		sendAt = now + undo * 1000;
	const to = v.to?.length ? v.to : (draft?.to ?? d.to);
	const cc = v.cc ?? draft?.cc ?? [];
	const subject =
		realSubject(actor, v.subject, d.subject) ||
		realSubject(actor, draft?.subject, d.subject) ||
		d.subject;
	const html = v.html !== undefined ? v.html : (draft?.html ?? null);
	// An agent sends from the inbox's address; a person may pick another of the brand's.
	const from = actor.type === "agent" ? d.from : (v.from ?? draft?.from ?? d.from);
	if (!from)
		throw validation(
			inbox
				? "This inbox has no address to send replies from: set its reply-from address (on a sending domain of the brand)"
				: "from: an address on one of the brand's sending domains",
		);
	const recipients = [...to, ...cc];
	if (!to.length) throw validation("to: who the reply goes to");
	if (recipients.length > 50) throw validation("Up to 50 recipients");
	if (actor.type === "agent" && actor.sendScope !== "anyone") {
		const known = await participants(x.id, inbox ? [inbox.address] : []);
		const stranger = recipients.map(lowerBare).find((a) => !known.has(a));
		if (stranger)
			throw new ApiError(
				403,
				"recipient_not_in_conversation",
				`${stranger} isn't in this conversation: this credential only replies to the people in it`,
			);
	}
	if (inbox) checkSendLists(inbox, recipients);
	// New files given now are stored first (and dropped again if the send fails).
	const attachments = v.attachments
		? await prepareFiles(actor, x, v.attachments, draft?.attachments ?? [])
		: (draft?.attachments ?? []);
	const added = attachments.filter((a) => !draft?.attachments?.some((k) => k.id === a.id));
	const last = d.last;
	const parent = last?.message_id ? `<${normalizeId(last.message_id)}>` : null;
	const chain = [
		...(last?.references ?? "").split(/\s+/).filter(Boolean).slice(-10),
		...(parent ? [normalizeId(parent) as string] : []),
	];
	const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const quoted = last
		? `\n\nOn ${new Date(last.created_at).toUTCString()}, ${last.from} wrote: "${last.subject}"`
		: "";
	// The draft is this send's alone from here: a second Send on it (another person, a double
	// click) is refused instead of emailing it twice.
	if (draft) await lockDraft(draft.id, now);
	let emailId: string;
	try {
		emailId = await sender.send(x.organization_id, {
			brand: x.organization_id,
			...(attachments.length ? { attachments: await fileContents(attachments) } : {}),
			from,
			to,
			...(cc.length ? { cc } : {}),
			...(inbox && lowerBare(from) !== inbox.address ? { reply_to: [inbox.address] } : {}),
			subject,
			text: `${text}${quoted}`,
			html:
				html ??
				`<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${escaped}</div>`,
			...(sendAt ? { scheduled_at: iso(sendAt) } : {}),
			...(parent
				? {
						headers: {
							"In-Reply-To": parent,
							References: chain.map((r) => `<${r}>`).join(" "),
						},
					}
				: {}),
			tags: [
				{ name: "conversation", value: x.id },
				...(last ? [{ name: "reply_to_received", value: last.id }] : []),
			],
		});
	} catch (error) {
		await dropFiles(added);
		if (draft) await unlockDraft(draft.id);
		throw error;
	}
	// The email keeps its own copy of the files.
	await dropFiles(attachments);
	const values = {
		attachments: attachments.length ? sentFiles(attachments) : null,
		status: "sent",
		from,
		to,
		cc: cc.length ? cc : null,
		subject,
		text,
		html,
		email_id: emailId,
		sent_at: iso(sendAt ?? now),
		updated_at: iso(now),
	};
	let replyId: string;
	if (draft) {
		replyId = draft.id;
		const approving = draft.author_type === "agent" && actor.type !== "agent";
		await db
			.update(rp)
			.set({
				...values,
				sent_by:
					draft.author_id === actor.id && draft.author_type === actor.type
						? null
						: actor.name,
				// How agents' drafts fare: sent as written, or changed first.
				review: approving
					? draft.review === "edited" || (v.text !== undefined && v.text !== draft.text)
						? "edited"
						: "unchanged"
					: draft.review,
			})
			.where(eq(rp.id, draft.id));
	} else {
		replyId = crypto.randomUUID();
		await db.insert(rp).values({
			id: replyId,
			organization_id: x.organization_id,
			conversation_id: x.id,
			inbox_id: x.inbox_id,
			in_reply_to: last?.id ?? null,
			author_type: actor.type,
			author_id: actor.id,
			author_name: actor.name,
			sent_by: null,
			review: null,
			created_at: iso(now),
			...values,
		});
	}
	const at = iso(sendAt ?? now);
	await db.batch([
		db
			.insert(schema.conversationRefs)
			.values({
				organization_id: x.organization_id,
				scope: x.inbox_id ?? "",
				ref: `email:${emailId}`,
				conversation_id: x.id,
			})
			.onConflictDoNothing(),
		db
			.update(c)
			.set(
				o.automatic
					? {
							messages: sql`${c.messages} + 1`,
							last_message_at: sql`max(${c.last_message_at}, ${iso(now)})`,
							updated_at: iso(now),
						}
					: {
							messages: sql`${c.messages} + 1`,
							last_message_at: sql`max(${c.last_message_at}, ${iso(now)})`,
							last_reply_at: at,
							first_reply_at: sql`coalesce(${c.first_reply_at}, ${at})`,
							replied_by: actor.type,
							updated_at: iso(now),
						},
			)
			.where(eq(c.id, x.id)),
	] as never);
	if (!o.automatic) await slaReplied(x, sendAt ?? now);
	await markRead(actor, x, true, now);
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "reply.sent",
		detail: {
			reply_id: replyId,
			email_id: emailId,
			to: recipients.map(lowerBare),
			...(draft && draft.author_type === "agent" && actor.type !== "agent"
				? { approved_draft_of: draft.author_name }
				: {}),
		},
		now,
	});
	await inboxEvent(
		x,
		"inbox.reply.sent",
		{
			reply_id: replyId,
			email_id: emailId,
			to,
			subject,
			sent_by: who(actor),
			...(sendAt ? { send_at: iso(sendAt) } : {}),
		},
		now,
	);
	if (saved) {
		const fresh = await db.select().from(c).where(eq(c.id, x.id)).get();
		if (fresh) await afterSavedReply(actor, fresh, saved, now);
	}
	const row = await db.select().from(rp).where(eq(rp.id, replyId)).get();
	return { ...replyView(row as Reply), scheduled_for: sendAt ? iso(sendAt) : null };
}

/**
 * Calls back a reply that hasn't gone yet (send later, or the undo window): its email is
 * canceled and the reply is a draft again.
 */
export async function unsendReply(actor: InboxActor, replyId: string, now = Date.now()) {
	need(actor, "send");
	const row = await db
		.select({ r: rp })
		.from(rp)
		.innerJoin(c, eq(c.id, rp.conversation_id))
		.where(and(eq(rp.id, replyId), visible(actor)))
		.get();
	if (!row || row.r.status !== "sent" || !row.r.email_id) throw notFound("Reply");
	const r = row.r;
	const [canceled] = await db
		.update(schema.emails)
		.set({ status: "canceled", send_at: null, last_event: "canceled", last_event_at: iso(now) })
		.where(
			and(
				eq(schema.emails.id, r.email_id as string),
				// Queued: held back (a paused brand) but not gone yet.
				inArray(schema.emails.status, ["scheduled", "queued"]),
			),
		)
		.returning({ id: schema.emails.id });
	if (!canceled)
		throw new ApiError(409, "already_sent", "It has already gone: it can't be called back");
	await db
		.update(rp)
		.set({
			status: "draft",
			email_id: null,
			sent_at: null,
			sent_by: null,
			updated_at: iso(now),
		})
		.where(eq(rp.id, r.id));
	// The conversation as if it hadn't been sent.
	const others = await db
		.select({ at: rp.sent_at })
		.from(rp)
		.where(and(eq(rp.conversation_id, r.conversation_id), eq(rp.status, "sent")));
	const times = others.flatMap((o) => (o.at ? [o.at] : [])).sort();
	const x = await db.select().from(c).where(eq(c.id, r.conversation_id)).get();
	await db
		.update(c)
		.set({
			messages: sql`max(${c.messages} - 1, 0)`,
			last_reply_at: times.at(-1) ?? null,
			first_reply_at: times[0] ?? null,
			...(times.length ? {} : { replied_by: null }),
			updated_at: iso(now),
		})
		.where(eq(c.id, r.conversation_id));
	// What sending it also did (Send and resolve, a saved reply's resolve or snooze) is undone.
	if (x && actor.permissions.has("triage")) {
		if (x.status === "resolved" && x.resolved_at && x.resolved_at >= r.updated_at)
			await updateConversation(actor, x.id, { status: "open" }, now);
		else if (x.snoozed_until && x.updated_at >= r.updated_at && x.snoozed_until > iso(now))
			await updateConversation(actor, x.id, { snooze_until: null }, now);
	}
	// The reply is due again (its due time from when they wrote).
	const after = await db.select().from(c).where(eq(c.id, r.conversation_id)).get();
	if (after?.status === "open") await planSla(after, now, { recompute: true });
	await logInbox(actor, {
		brandId: r.organization_id,
		inboxId: r.inbox_id,
		conversationId: r.conversation_id,
		action: "reply.unsent",
		detail: { reply_id: r.id },
		now,
	});
	const fresh = await db.select().from(rp).where(eq(rp.id, r.id)).get();
	return replyView(fresh as Reply);
}

/**
 * A reply's email failed for good (SES refused it): the conversation isn't answered by it. Its
 * reply times leave it out, a conversation resolved meanwhile is open again, and the SLA's
 * reply is due again. The reply stays (its timeline shows the failed delivery, to send again).
 */
export async function replyFailed(emailId: string, now = Date.now()) {
	const r = await db
		.select()
		.from(rp)
		.where(and(eq(rp.email_id, emailId), eq(rp.status, "sent")))
		.get();
	if (!r) return;
	const e = schema.emails;
	const others = await db
		.select({ at: rp.sent_at })
		.from(rp)
		.innerJoin(e, eq(e.id, rp.email_id))
		.where(
			and(
				eq(rp.conversation_id, r.conversation_id),
				eq(rp.status, "sent"),
				sql`${e.status} NOT IN ('failed', 'canceled')`,
			),
		);
	const times = others.flatMap((o) => (o.at ? [o.at] : [])).sort();
	await db
		.update(c)
		.set({
			last_reply_at: times.at(-1) ?? null,
			first_reply_at: times[0] ?? null,
			...(times.length ? {} : { replied_by: null }),
			status: "open",
			resolved_at: null,
			updated_at: iso(now),
		})
		.where(eq(c.id, r.conversation_id));
	const after = await db.select().from(c).where(eq(c.id, r.conversation_id)).get();
	if (after) await planSla(after, now, { recompute: true });
	await logInbox("system", {
		brandId: r.organization_id,
		inboxId: r.inbox_id,
		conversationId: r.conversation_id,
		action: "reply.failed",
		detail: { reply_id: r.id, email_id: emailId },
		now,
	});
}

// ── Events ─────────────────────────────────────────────────────────────────

/** An inbox event for the organization's webhooks and the inbox's own (metadata only: an agent
 * reads the content with its credential). */
export async function inboxEvent(
	x: Pick<Conversation, "id" | "organization_id" | "inbox_id" | "subject">,
	type: InboxEvent,
	data: Record<string, unknown>,
	now = Date.now(),
) {
	const { emitInboxEvent } = await import("./webhooks");
	await emitInboxEvent(
		x.organization_id,
		type,
		x.inbox_id,
		{ conversation_id: x.id, inbox_id: x.inbox_id, subject: x.subject, ...data },
		now,
	).catch((error) => console.error("conversations: event not sent", type, error));
	// Automations on conversations, for the brand's contact who wrote.
	const kind =
		type === "inbox.conversation.created"
			? "opened"
			: type === "inbox.conversation.resolved"
				? "resolved"
				: type === "inbox.csat.received"
					? "rated"
					: null;
	if (kind) {
		const { onConversation } = await import("./automations");
		await onConversation(x.id, kind, now).catch((error) =>
			console.error("conversations: automations not started", type, error),
		);
	}
}

// ── Retention ──────────────────────────────────────────────────────────────

/**
 * Cron (daily, after the received emails): conversations with nothing newer than `before`, or
 * than their inbox's own retention (`retention_days`; 0 keeps them). A chat's files go from R2
 * with it, and organizations that keep an archive get its transcript there first.
 */
export async function purgeConversations(before: string, rounds = 10, now = Date.now()) {
	const own = await db
		.select({ id: schema.inboxes.id, days: schema.inboxes.retention_days })
		.from(schema.inboxes)
		.where(sql`${schema.inboxes.retention_days} IS NOT NULL`);
	const others = own.length
		? sql`(${c.inbox_id} IS NULL OR ${c.inbox_id} NOT IN (SELECT id FROM inboxes WHERE retention_days IS NOT NULL))`
		: undefined;
	await purgeWhere(and(lt(c.last_message_at, before), others), rounds);
	for (const inbox of own)
		if (inbox.days && inbox.days > 0)
			await purgeWhere(
				and(
					eq(c.inbox_id, inbox.id),
					lt(c.last_message_at, iso(now - inbox.days * 86_400_000)),
				),
				rounds,
			);
}

async function purgeWhere(where: ReturnType<typeof and>, rounds: number) {
	const { archiveBucket, archiveChats, archivingBrands } = await import("./archive");
	const { deleteChatFiles } = await import("./chat");
	for (let i = 0; i < rounds; i++) {
		const rows = await db
			.select({ id: c.id, brand: c.organization_id, channel: c.channel })
			.from(c)
			.where(where)
			.orderBy(asc(c.last_message_at))
			.limit(90);
		if (!rows.length) return;
		// Drafts' uploaded files go with them.
		const drafts = await db
			.select({ a: rp.attachments })
			.from(rp)
			.where(
				and(
					inArray(
						rp.conversation_id,
						rows.map((r) => r.id),
					),
					inArray(rp.status, ["draft", "sending"]),
				),
			);
		await dropFiles(drafts.flatMap((d) => d.a ?? []));
		const chats = rows.filter((r) => r.channel === "chat");
		if (chats.length) {
			const bucket = archiveBucket();
			if (bucket) {
				const on = await archivingBrands([...new Set(chats.map((r) => r.brand))]);
				const keep = chats.filter((r) => on.has(r.brand)).map((r) => r.id);
				// When R2 refuses, they wait for the next run.
				if (keep.length) await archiveChats(bucket, keep);
			}
			await deleteChatFiles(chats.map((r) => r.id));
		}
		await db.delete(c).where(
			inArray(
				c.id,
				rows.map((r) => r.id),
			),
		);
		if (rows.length < 90) return;
	}
}
