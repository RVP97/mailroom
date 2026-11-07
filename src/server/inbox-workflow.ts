import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { displayName, fillVariables, VARIABLES } from "@/lib/reply-variables";
import { bareAddress } from "./aws/mime";

export { fillVariables, VARIABLES };

import { db, schema } from "./db";
import type { MessageFlags } from "./db/schema";
import { baseUrl } from "./env";
import { ApiError, notFound, validation } from "./errors";
import type { Inbox, InboxActor } from "./inboxes";
import { logInbox, need } from "./inboxes";
import { iso } from "./time";

/**
 * How an inbox's work is shared between people and agents, Front-style but for email
 * infrastructure: who has a conversation (an assignment, or an agent's claim that runs out),
 * tags and priority, snoozing, internal notes, saved replies, rules, an SLA, satisfaction
 * surveys, holding suspicious mail from agents, and the reply text without what it quotes.
 *
 * Conversations stay in src/server/conversations.ts; this is what's on top of them.
 */

type Conversation = typeof schema.conversations.$inferSelect;
const c = schema.conversations;

// ── Settings ───────────────────────────────────────────────────────────────

export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

const minutes = z
	.number()
	.int()
	.min(1)
	.max(60 * 24 * 60)
	.nullable();

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");

/** One inbox's settings (inboxes.settings), every field with its default. */
export const inboxSettings = z.object({
	/** Added under every reply sent from the inbox; {{agent.name}} and the rest work in it. */
	signature: z.string().max(2000).nullable().default(null),
	assignment: z
		.object({
			/** "manual", or new conversations go to `members` in turn. */
			mode: z.enum(["manual", "round_robin"]).default("manual"),
			/** Readers: "user:<id>" or "cred:<id>". */
			members: z.array(z.string().max(80)).max(50).default([]),
			/** Skip whoever already has this many open conversations; null: no limit. */
			max_open: z.number().int().min(1).max(1000).nullable().default(null),
			/** The last one given a conversation (the turn moves on from them). */
			last: z.string().nullable().default(null),
		})
		.default({ mode: "manual", members: [], max_open: null, last: null }),
	/** How long an agent's claim lasts (it can renew it). */
	claim_minutes: z.number().int().min(1).max(240).default(15),
	sla: z
		.object({
			enabled: z.boolean().default(false),
			/** Minutes to the first reply (and to each reply after a customer writes again), and
			 * to resolving, per priority. */
			targets: z
				.record(z.enum(PRIORITIES), z.object({ reply: minutes, resolve: minutes }))
				.default({
					urgent: { reply: 60, resolve: 8 * 60 },
					high: { reply: 4 * 60, resolve: 24 * 60 },
					normal: { reply: 8 * 60, resolve: 3 * 24 * 60 },
					low: { reply: 24 * 60, resolve: 7 * 24 * 60 },
				}),
			/** Only these hours count; null: around the clock. */
			business_hours: z
				.object({
					timezone: z.string().max(64).default("UTC"),
					/** 0 Sunday … 6 Saturday. */
					days: z.array(z.number().int().min(0).max(6)).max(7).default([1, 2, 3, 4, 5]),
					start: hhmm.default("09:00"),
					end: hhmm.default("18:00"),
				})
				.nullable()
				.default(null),
			/** Warned this long before a reply is due (a webhook, and these emails). */
			warn_minutes: z
				.number()
				.int()
				.min(0)
				.max(24 * 60)
				.default(30),
			notify: z.array(z.string().email()).max(20).default([]),
		})
		.default({
			enabled: false,
			targets: {
				urgent: { reply: 60, resolve: 8 * 60 },
				high: { reply: 4 * 60, resolve: 24 * 60 },
				normal: { reply: 8 * 60, resolve: 3 * 24 * 60 },
				low: { reply: 24 * 60, resolve: 7 * 24 * 60 },
			},
			business_hours: null,
			warn_minutes: 30,
			notify: [],
		}),
	csat: z
		.object({
			enabled: z.boolean().default(false),
			question: z.string().max(200).default("How did we do?"),
			thanks: z.string().max(400).default("Thanks for telling us."),
			/** Minutes after resolving (a quick reopen sends nothing). */
			delay_minutes: z
				.number()
				.int()
				.min(1)
				.max(7 * 24 * 60)
				.default(10),
		})
		.default({
			enabled: false,
			question: "How did we do?",
			thanks: "Thanks for telling us.",
			delay_minutes: 10,
		}),
	/** Messages that look like spam, phishing or prompt injection wait for a person. */
	hold_suspicious: z.boolean().default(true),
	/** People's replies wait this long before they go (Undo); 0: at once. */
	undo_seconds: z.number().int().min(0).max(60).default(5),
	/** The inbox's tags, with their colors (others can still be added). */
	tags: z
		.array(z.object({ name: z.string().max(40), color: z.string().max(20).default("gray") }))
		.max(100)
		.default([]),
});
export type InboxSettings = z.infer<typeof inboxSettings>;

export function settingsOf(i: Pick<Inbox, "settings"> | null | undefined): InboxSettings {
	const parsed = inboxSettings.safeParse(i?.settings ?? {});
	return parsed.success ? parsed.data : inboxSettings.parse({});
}

/** Saves a change to an inbox's settings: `patch` is merged one level deep. */
export async function updateSettings(inbox: Inbox, patch: unknown, now = Date.now()) {
	const current = settingsOf(inbox);
	const plain = (x: unknown): x is Record<string, unknown> =>
		!!x && typeof x === "object" && !Array.isArray(x);
	const merge = (was: unknown, v: unknown): unknown => {
		if (!plain(v) || !plain(was)) return v;
		const out: Record<string, unknown> = { ...was };
		for (const [k, x] of Object.entries(v)) out[k] = merge(was[k], x);
		return out;
	};
	const next = inboxSettings.parse(merge(current, patch ?? {}));
	if (next.sla.business_hours) {
		try {
			new Intl.DateTimeFormat("en", { timeZone: next.sla.business_hours.timezone });
		} catch {
			throw validation(
				"sla.business_hours.timezone: an IANA time zone, like America/Mexico_City",
			);
		}
		if (next.sla.business_hours.end <= next.sla.business_hours.start)
			throw validation("sla.business_hours: the day must end after it starts");
	}
	await db
		.update(schema.inboxes)
		.set({ settings: next as unknown as Record<string, unknown>, updated_at: iso(now) })
		.where(eq(schema.inboxes.id, inbox.id));
	return next;
}

export async function inboxOf(inboxId: string | null) {
	if (!inboxId) return null;
	return (
		(await db.select().from(schema.inboxes).where(eq(schema.inboxes.id, inboxId)).get()) ?? null
	);
}

// ── Who has it ─────────────────────────────────────────────────────────────

/** Its assignee now: an assignment, or a claim that hasn't run out. */
export function holderOf(
	x: Pick<Conversation, "assignee" | "assignee_name" | "claimed_until">,
	now = Date.now(),
) {
	if (!x.assignee) return null;
	if (x.claimed_until && x.claimed_until <= iso(now)) return null;
	return {
		reader: x.assignee,
		name: x.assignee_name ?? "Someone",
		type: x.assignee.startsWith("cred:") ? ("agent" as const) : ("person" as const),
		until: x.claimed_until,
	};
}

/**
 * An agent may not work on a conversation someone else has (a person it was assigned to, or
 * another agent's claim): 409, so two never answer the same customer. People and full keys
 * may (the page warns them).
 */
export function assertFree(actor: InboxActor, x: Conversation, now = Date.now()) {
	const h = holderOf(x, now);
	if (!h || actor.type !== "agent" || h.reader === actor.reader) return;
	throw new ApiError(
		409,
		"conversation_claimed",
		`${h.name} has this conversation${h.until ? ` until ${h.until}` : ""}: leave it, or ask them (add a note)`,
	);
}

const canWork = (a: InboxActor) =>
	a.permissions.has("draft") || a.permissions.has("send") || a.permissions.has("triage");

/**
 * Takes the conversation: an agent for `minutes` (its claim runs out unless renewed), a person
 * for good (an assignment to themselves). Someone else's claim or assignment: 409, unless a
 * person with triage takes it over (`force`).
 */
export async function claim(
	actor: InboxActor,
	x: Conversation,
	o: { minutes?: number | null; force?: boolean; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	if (!canWork(actor))
		throw new ApiError(
			403,
			"missing_permission",
			"Claiming needs the draft, send or triage permission",
		);
	if (!actor.reader) throw validation("Only an agent's credential or a person can claim");
	const h = holderOf(x, now);
	if (h && h.reader !== actor.reader && !(o.force && actor.type === "person")) {
		throw new ApiError(
			409,
			"conversation_claimed",
			`${h.name} already has this conversation${h.until ? ` until ${h.until}` : ""}`,
		);
	}
	const settings = settingsOf(await inboxOf(x.inbox_id));
	const mins = Math.min(Math.max(o.minutes ?? settings.claim_minutes, 1), 240);
	const until = actor.type === "agent" ? iso(now + mins * 60_000) : null;
	const taken = await db
		.update(c)
		.set({
			assignee: actor.reader,
			assignee_name: actor.name,
			claimed_until: until,
			updated_at: iso(now),
		})
		.where(
			and(
				eq(c.id, x.id),
				// Whoever had it when this was read still has it (or nobody does now): two agents
				// claiming at once can't both win. A person's takeover (force) needs no check.
				o.force && actor.type === "person"
					? undefined
					: or(
							isNull(c.assignee),
							eq(c.assignee, actor.reader),
							and(isNotNull(c.claimed_until), lte(c.claimed_until, iso(now))),
						),
			),
		)
		.returning({ id: c.id });
	if (!taken.length) {
		const fresh = await db.select().from(c).where(eq(c.id, x.id)).get();
		const holder = fresh ? holderOf(fresh, now) : null;
		throw new ApiError(
			409,
			"conversation_claimed",
			`${holder?.name ?? "Someone"} already has this conversation${holder?.until ? ` until ${holder.until}` : ""}`,
		);
	}
	if (h?.reader !== actor.reader) {
		await logInbox(actor, {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: x.id,
			action: h ? "conversation.taken_over" : "conversation.claimed",
			detail: { until, ...(h ? { from: h.name } : {}) },
			now,
		});
		await event(x, "inbox.conversation.assigned", {
			assignee: { reader: actor.reader, name: actor.name, type: actor.type },
			claimed_until: until,
		});
	}
	return { assignee: actor.reader, assignee_name: actor.name, claimed_until: until };
}

/** Lets it go: its holder, or a person with triage. */
export async function release(actor: InboxActor, x: Conversation, now = Date.now()) {
	const h = holderOf(x, now);
	if (!h) return;
	if (h.reader !== actor.reader) need(actor, "triage");
	if (h.reader !== actor.reader && actor.type === "agent")
		throw new ApiError(409, "conversation_claimed", `${h.name} has this conversation`);
	await db
		.update(c)
		.set({ assignee: null, assignee_name: null, claimed_until: null, updated_at: iso(now) })
		.where(eq(c.id, x.id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.released",
		now,
	});
}

/** Who someone may assign to: the organization's members and the credentials reaching the inbox. */
export async function assignees(organizationId: string, inbox: Inbox | null) {
	const people = await db
		.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(eq(schema.member.organizationId, organizationId));
	const { listCredentials } = await import("./inboxes");
	const creds = inbox ? (await listCredentials(inbox)).filter((x) => !x.revoked_at) : [];
	return [
		...people.map((p) => ({
			reader: `user:${p.id}`,
			name: p.name || p.email,
			email: p.email,
			type: "person" as const,
		})),
		...creds.map((x) => ({
			reader: `cred:${x.id}`,
			name: x.name,
			email: null,
			type: "agent" as const,
		})),
	];
}

/** Gives it to someone (a person or an agent's credential), or to nobody (null). */
export async function assign(
	actor: InboxActor,
	x: Conversation,
	to: string | null,
	now = Date.now(),
) {
	need(actor, "triage");
	const target = to === "me" ? actor.reader : to;
	if (!target) {
		await db
			.update(c)
			.set({ assignee: null, assignee_name: null, claimed_until: null, updated_at: iso(now) })
			.where(eq(c.id, x.id));
		await logInbox(actor, {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: x.id,
			action: "conversation.unassigned",
			now,
		});
		return null;
	}
	const inbox = await inboxOf(x.inbox_id);
	const who = (await assignees(actor.organizationId, inbox)).find((a) => a.reader === target);
	if (!who) throw notFound("Assignee");
	await db
		.update(c)
		.set({
			assignee: who.reader,
			assignee_name: who.name,
			claimed_until: null,
			updated_at: iso(now),
		})
		.where(eq(c.id, x.id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.assigned",
		detail: { to: who.name },
		now,
	});
	await event(x, "inbox.conversation.assigned", {
		assignee: { reader: who.reader, name: who.name, type: who.type },
		assigned_by: { type: actor.type, name: actor.name },
	});
	if (who.type === "person" && who.email && who.reader !== actor.reader)
		await mail(who.email, `${actor.name} assigned you a conversation`, x, [
			`${actor.name} assigned you "${x.subject || "(no subject)"}".`,
		]);
	return who;
}

/** Round robin: the next of the inbox's members (after the last one), skipping the full. */
export async function nextInTurn(inbox: Inbox, now = Date.now()) {
	const s = settingsOf(inbox);
	if (s.assignment.mode !== "round_robin" || !s.assignment.members.length) return null;
	const all = await assignees(await orgOfBrand(inbox.organization_id), inbox);
	const members = s.assignment.members.filter((m) => all.some((a) => a.reader === m));
	if (!members.length) return null;
	const counts = s.assignment.max_open
		? await db
				.select({ who: c.assignee, n: sql<number>`count(*)` })
				.from(c)
				.where(
					and(
						eq(c.inbox_id, inbox.id),
						eq(c.status, "open"),
						inArray(c.assignee, members),
					),
				)
				.groupBy(c.assignee)
		: [];
	const start = Math.max(members.indexOf(s.assignment.last ?? ""), -1);
	for (let i = 1; i <= members.length; i++) {
		const m = members[(start + i) % members.length] as string;
		const open = Number(counts.find((x) => x.who === m)?.n ?? 0);
		if (s.assignment.max_open && open >= s.assignment.max_open) continue;
		await db
			.update(schema.inboxes)
			.set({
				settings: {
					...s,
					assignment: { ...s.assignment, last: m },
				} as unknown as Record<string, unknown>,
			})
			.where(eq(schema.inboxes.id, inbox.id));
		void now;
		return all.find((a) => a.reader === m) ?? null;
	}
	return null;
}

// ── Tags, priority, snooze ─────────────────────────────────────────────────

const TAG = /^[\p{L}\p{N}][\p{L}\p{N} _./-]{0,39}$/u;

/** Tags as kept: trimmed, lowercase, at most 20, each a short word or two. */
export function cleanTags(list: unknown): string[] {
	const raw = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
	const out: string[] = [];
	for (const t of raw) {
		const s = String(t).trim().toLowerCase().replace(/\s+/g, " ");
		if (!s) continue;
		if (!TAG.test(s))
			throw validation(
				`tags: "${s.slice(0, 40)}" isn't a tag (letters, digits, spaces, - _ . /)`,
			);
		if (!out.includes(s)) out.push(s);
	}
	if (out.length > 20) throw validation("tags: up to 20 on a conversation");
	return out;
}

export async function setTags(
	actor: InboxActor,
	x: Conversation,
	o: { tags?: unknown; add?: unknown; remove?: unknown },
	now = Date.now(),
) {
	need(actor, "triage");
	const before = x.tags ?? [];
	let next = o.tags !== undefined ? cleanTags(o.tags) : [...before];
	for (const t of o.add !== undefined ? cleanTags(o.add) : [])
		if (!next.includes(t)) next.push(t);
	const drop = o.remove !== undefined ? cleanTags(o.remove) : [];
	next = cleanTags(next.filter((t) => !drop.includes(t)));
	const added = next.filter((t) => !before.includes(t));
	const removed = before.filter((t) => !next.includes(t));
	if (!added.length && !removed.length) return next;
	await db
		.update(c)
		.set({ tags: next.length ? next : null, updated_at: iso(now) })
		.where(eq(c.id, x.id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.tagged",
		detail: { added, removed },
		now,
	});
	await event(x, "inbox.conversation.tagged", { tags: next, added, removed });
	return next;
}

export async function setPriority(
	actor: InboxActor,
	x: Conversation,
	p: Priority,
	now = Date.now(),
) {
	need(actor, "triage");
	if (p === x.priority) return;
	await db
		.update(c)
		.set({ priority: p, updated_at: iso(now) })
		.where(eq(c.id, x.id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.prioritized",
		detail: { priority: p },
		now,
	});
	// What's due moves with the priority.
	await planSla({ ...x, priority: p }, now, { recompute: true });
}

/** Out of Open until `until` (a new message brings it back sooner); null wakes it now. */
export async function snooze(
	actor: InboxActor,
	x: Conversation,
	until: string | null,
	now = Date.now(),
) {
	need(actor, "triage");
	if (until !== null) {
		const at = Date.parse(until);
		if (Number.isNaN(at)) throw validation("snooze_until: an ISO 8601 date and time");
		if (at <= now) throw validation("snooze_until: a time in the future");
		if (at > now + 366 * 86_400_000) throw validation("snooze_until: up to a year ahead");
		until = iso(at);
	}
	await db
		.update(c)
		.set({
			snoozed_until: until,
			...(until ? { status: "open", resolved_at: null } : {}),
			updated_at: iso(now),
		})
		.where(eq(c.id, x.id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: until ? "conversation.snoozed" : "conversation.woke",
		detail: until ? { until } : {},
		now,
	});
	if (until) await event(x, "inbox.conversation.snoozed", { until });
}

/** Cron: snoozed conversations whose time came: Open again and unread for everyone. */
export async function wakeSnoozed(now = Date.now()) {
	const due = await db
		.select()
		.from(c)
		.where(and(isNotNull(c.snoozed_until), lte(c.snoozed_until, iso(now))))
		.limit(200);
	for (const x of due) {
		await db.batch([
			db
				.update(c)
				.set({
					snoozed_until: null,
					status: "open",
					resolved_at: null,
					updated_at: iso(now),
				})
				// Not if it was snoozed again (or woken) meanwhile.
				.where(and(eq(c.id, x.id), eq(c.snoozed_until, x.snoozed_until as string))),
			db
				.delete(schema.conversationReads)
				.where(eq(schema.conversationReads.conversation_id, x.id)),
		]);
		await logInbox("system", {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: x.id,
			action: "conversation.woke",
			detail: { snoozed_until: x.snoozed_until },
			now,
		});
		await event(x, "inbox.conversation.woke", {
			snoozed_until: x.snoozed_until,
			// Nobody answered since it was snoozed: time to follow up.
			no_reply_since: (x.last_inbound_at ?? "") < (x.last_reply_at ?? ""),
		});
	}
	return due.length;
}

// ── Notes ──────────────────────────────────────────────────────────────────

const n = schema.conversationNotes;
export type Note = typeof n.$inferSelect;

export const noteInput = z.object({
	text: z.string().trim().min(1, "text: write the note").max(10_000),
	/** Members to email: their user ids or email addresses. */
	mentions: z.array(z.string().max(320)).max(20).optional(),
});

export const noteView = (x: Note) => ({
	object: "note",
	id: x.id,
	conversation_id: x.conversation_id,
	text: x.text,
	author: { type: x.author_type, id: x.author_id, name: x.author_name },
	mentions: x.mentions ?? [],
	created_at: x.created_at,
	updated_at: x.updated_at,
});

export async function addNote(actor: InboxActor, x: Conversation, raw: unknown, now = Date.now()) {
	need(actor, "notes");
	const v = noteInput.parse(raw ?? {});
	const people = v.mentions?.length ? await assignees(actor.organizationId, null) : [];
	const mentioned = (v.mentions ?? []).flatMap((m) => {
		const key = m.trim().toLowerCase();
		const p = people.find(
			(a) => a.reader === `user:${m}` || a.reader === m || a.email?.toLowerCase() === key,
		);
		return p ? [p] : [];
	});
	const unique = [...new Map(mentioned.map((p) => [p.reader, p])).values()];
	const row = {
		id: crypto.randomUUID(),
		organization_id: x.organization_id,
		conversation_id: x.id,
		inbox_id: x.inbox_id,
		author_type: actor.type,
		author_id: actor.id,
		author_name: actor.name,
		text: v.text,
		mentions: unique.length
			? unique.map((p) => ({ id: p.reader.slice(5), name: p.name }))
			: null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(n).values(row);
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "note.created",
		detail: { note_id: row.id, mentions: unique.map((p) => p.name) },
		now,
	});
	await event(x, "inbox.note.created", {
		note_id: row.id,
		author: { type: actor.type, name: actor.name },
		mentions: unique.map((p) => p.reader),
	});
	for (const p of unique)
		if (p.email && p.reader !== actor.reader)
			await mail(p.email, `${actor.name} mentioned you`, x, [
				`${actor.name} mentioned you in a note on "${x.subject || "(no subject)"}":`,
				v.text.slice(0, 600),
			]);
	return noteView(row as Note);
}

export async function listNotes(conversationId: string) {
	return db
		.select()
		.from(n)
		.where(eq(n.conversation_id, conversationId))
		.orderBy(n.created_at)
		.limit(200);
}

export async function deleteNote(actor: InboxActor, x: Conversation, id: string) {
	const row = await db
		.select()
		.from(n)
		.where(and(eq(n.id, id), eq(n.conversation_id, x.id)))
		.get();
	if (!row) throw notFound("Note");
	const own = row.author_type === actor.type && row.author_id === actor.id;
	if (!own) need(actor, "triage");
	if (!own && actor.type === "agent")
		throw new ApiError(403, "not_yours", "An agent can only delete its own notes");
	await db.delete(n).where(eq(n.id, id));
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "note.deleted",
		detail: { note_id: id },
	});
}

// ── Saved replies ──────────────────────────────────────────────────────────

const sr = schema.savedReplies;
export type SavedReply = typeof sr.$inferSelect;

export const savedReplyInput = z.object({
	name: z.string().trim().min(1).max(100),
	/** Only this inbox's (an id); null: every inbox of the brand. */
	inbox_id: z.string().nullish(),
	shortcut: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9_-]{1,30}$/, "shortcut: a short word (letters, digits, - or _)")
		.nullish(),
	text: z.string().min(1, "text: write the reply").max(20_000),
	add_tags: z.array(z.string()).max(10).nullish(),
	set_status: z.enum(["resolved"]).nullish(),
	snooze_days: z.number().int().min(1).max(90).nullish(),
});

export const savedReplyView = (x: SavedReply) => ({
	object: "saved_reply",
	id: x.id,
	brand_id: x.organization_id,
	inbox_id: x.inbox_id,
	name: x.name,
	shortcut: x.shortcut,
	text: x.text,
	add_tags: x.add_tags ?? [],
	set_status: x.set_status as "resolved" | null,
	snooze_days: x.snooze_days,
	uses: x.uses,
	created_at: x.created_at,
	updated_at: x.updated_at,
});

/** The saved replies an actor may use: their brands', for every inbox or one of theirs. */
export async function listSavedReplies(
	actor: Pick<InboxActor, "brands" | "inboxIds">,
	o: { inbox?: string | null } = {},
) {
	if (!actor.brands.length || actor.inboxIds?.length === 0) return [];
	const rows = await db
		.select()
		.from(sr)
		.where(inArray(sr.organization_id, actor.brands))
		.orderBy(sql`${sr.uses} DESC`, sr.name);
	return rows.filter(
		(r) =>
			(!r.inbox_id || !actor.inboxIds || actor.inboxIds.includes(r.inbox_id)) &&
			(!o.inbox || !r.inbox_id || r.inbox_id === o.inbox),
	);
}

export async function savedReplyFor(actor: Pick<InboxActor, "brands" | "inboxIds">, id: string) {
	const row = (await listSavedReplies(actor)).find((r) => r.id === id || r.shortcut === id);
	if (!row) throw notFound("Saved reply");
	return row;
}

export async function saveSavedReply(
	brandId: string,
	raw: unknown,
	o: { id?: string; userId?: string | null; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const v = savedReplyInput.parse(raw ?? {});
	if (v.inbox_id) {
		const i = await inboxOf(v.inbox_id);
		if (!i || i.organization_id !== brandId) throw notFound("Inbox");
	}
	const values = {
		name: v.name,
		inbox_id: v.inbox_id ?? null,
		shortcut: v.shortcut ?? null,
		text: v.text,
		add_tags: v.add_tags?.length ? cleanTags(v.add_tags) : null,
		set_status: v.set_status ?? null,
		snooze_days: v.snooze_days ?? null,
		updated_at: iso(now),
	};
	if (v.shortcut) {
		const taken = await db
			.select({ id: sr.id })
			.from(sr)
			.where(and(eq(sr.organization_id, brandId), eq(sr.shortcut, v.shortcut)))
			.get();
		if (taken && taken.id !== o.id)
			throw new ApiError(409, "shortcut_taken", `/${v.shortcut} is another saved reply's`);
	}
	if (o.id) {
		const [row] = await db
			.update(sr)
			.set(values)
			.where(and(eq(sr.id, o.id), eq(sr.organization_id, brandId)))
			.returning();
		if (!row) throw notFound("Saved reply");
		return row;
	}
	const row = {
		id: crypto.randomUUID(),
		organization_id: brandId,
		...values,
		uses: 0,
		created_by: o.userId ?? null,
		created_at: iso(now),
	};
	await db.insert(sr).values(row);
	return row as SavedReply;
}

export async function deleteSavedReply(brands: string[], id: string) {
	const [row] = await db
		.delete(sr)
		.where(and(eq(sr.id, id), inArray(sr.organization_id, brands)))
		.returning({ id: sr.id });
	if (!row) throw notFound("Saved reply");
}

/** A saved reply's text for this conversation, and its use counted. */
export async function savedReplyText(
	actor: InboxActor,
	x: Conversation,
	id: string,
	o: { count?: boolean } = {},
) {
	const r = await savedReplyFor(actor, id);
	if (r.inbox_id && r.inbox_id !== x.inbox_id) throw notFound("Saved reply");
	const inbox = await inboxOf(x.inbox_id);
	const text = fillVariables(r.text, {
		contact: x.channel === "chat" ? (x.visitor_name ?? x.visitor_email ?? "") : x.contact,
		agent: actor.name,
		inbox: inbox?.name ?? null,
		subject: x.subject,
	});
	if (o.count !== false)
		await db
			.update(sr)
			.set({ uses: sql`${sr.uses} + 1` })
			.where(eq(sr.id, r.id));
	return { reply: r, text };
}

/** What sending a saved reply also does: its tags, its status, its snooze. */
export async function afterSavedReply(
	actor: InboxActor,
	x: Conversation,
	r: SavedReply,
	now = Date.now(),
) {
	if (!actor.permissions.has("triage")) return;
	if (r.add_tags?.length) await setTags(actor, x, { add: r.add_tags }, now);
	if (r.snooze_days) await snooze(actor, x, iso(now + r.snooze_days * 86_400_000), now);
	else if (r.set_status === "resolved") {
		const { updateConversation } = await import("./conversations");
		await updateConversation(actor, x.id, { status: "resolved" }, now);
	}
}

/** The inbox's signature under a reply (variables filled), unless it's already there. */
export function signed(text: string, inbox: Inbox | null, agent: string) {
	const sig = settingsOf(inbox).signature?.trim();
	if (!sig) return text;
	const filled = fillVariables(sig, { agent, inbox: inbox?.name ?? null }).trim();
	if (!filled || text.includes(filled)) return text;
	return `${text.trimEnd()}\n\n${filled}`;
}

// ── The new part of a reply ────────────────────────────────────────────────

/** Lines that start what a reply quotes ("On … wrote:", in the languages mail clients use). */
const QUOTE_HEADS = [
	/^On\b.{0,300}\bwrote:?\s*$/i,
	/^El\b.{0,300}\bescribi[oó]:?\s*$/i,
	/^Le\b.{0,300}\ba [ée]crit\s*:?\s*$/i,
	/^Am\b.{0,300}\bschrieb\b.{0,120}:?\s*$/i,
	/^Em\b.{0,300}\bescreveu:?\s*$/i,
	/^Il\b.{0,300}\bha scritto:?\s*$/i,
	/^Op\b.{0,300}\bschreef\b.{0,120}:?\s*$/i,
	/^-{2,}\s*(Original Message|Mensaje original|Message d'origine|Ursprüngliche Nachricht|Mensagem original)\s*-{2,}\s*$/i,
	/^-{2,}\s*(Forwarded message|Mensaje reenviado)\s*-{2,}\s*$/i,
	/^_{20,}\s*$/,
];
/** Where a signature or a phone's footer starts. */
const SIGNATURE_HEADS = [
	/^--\s*$/,
	/^(Sent|Enviado) (from|desde) (my|mi) .{1,40}$/i,
	/^Get Outlook for .{1,30}$/i,
	/^Obtener Outlook para .{1,30}$/i,
];
/** Outlook's quoted header: From: … then Sent:/Date: within a few lines. */
const FROM_LINE = /^\*?(From|De|Von|Da)\s*:\*?\s+\S/i;
const SENT_LINE = /^\*?(Sent|Date|Enviado|Fecha|Gesendet|Envoyé)\s*:\*?\s+\S/i;

/**
 * A received message's new text: without what it quotes (lines with >, "On … wrote:" and
 * everything after it, Outlook's quoted headers) and without the signature. What's left when
 * that would leave nothing is the whole text.
 */
export function newText(text: string | null | undefined): { text: string; trimmed: boolean } {
	if (!text) return { text: "", trimmed: false };
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let cut = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string;
		const t = line.trim();
		if (/^>/.test(t)) {
			cut = true;
			continue;
		}
		// Gmail wraps a long "On … wrote:" over two lines.
		const two = `${t} ${(lines[i + 1] ?? "").trim()}`;
		if (
			QUOTE_HEADS.some((r) => r.test(t)) ||
			(/^(On|El|Le|Am|Em|Il|Op)\b/.test(t) && QUOTE_HEADS.some((r) => r.test(two)))
		) {
			cut = true;
			break;
		}
		if (FROM_LINE.test(t) && lines.slice(i + 1, i + 5).some((l) => SENT_LINE.test(l.trim()))) {
			cut = true;
			break;
		}
		if (SIGNATURE_HEADS.some((r) => r.test(line.trimEnd()))) {
			cut = true;
			break;
		}
		out.push(line);
	}
	const kept = out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!kept) return { text: text.trim(), trimmed: false };
	return { text: kept, trimmed: cut || kept.length < text.trim().length };
}

// ── Suspicious mail ────────────────────────────────────────────────────────

const INJECTION = [
	/\bignore (all |any |the |your )?(previous|prior|above|earlier|preceding) (instructions|prompts|messages|rules)\b/i,
	/\bdisregard (all |any |the |your )?(previous|prior|above|earlier)? ?(instructions|prompts|rules)\b/i,
	/\b(forget|override) (all |your |the )?(previous |prior )?(instructions|rules|guidelines)\b/i,
	/\byou are (now|no longer) (an?|the) \w+/i,
	/\b(reveal|print|show|repeat) (your|the) (system prompt|instructions|api key|credentials?)\b/i,
	/\bsystem prompt\b/i,
	/<\|?(im_start|im_end|system)\|?>|\[\/?INST\]|<\/?system>/i,
	/\b(ignora|olvida) (todas |las )?(las )?instrucciones (anteriores|previas)\b/i,
	/\bnew instructions?:/i,
	/\b(send|forward|email) (all|every|the) (emails?|messages?|conversations?|contacts?|data) to\b/i,
];

const HIDDEN =
	/<[^>]+style\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt|em|%)?\s*[;"']|opacity\s*:\s*0\s*[;"']|color\s*:\s*(#fff(fff)?|white|transparent)\b)[^"']*["'][^>]*>([^<]{20,})/i;

/** How many single-character edits turn a into b (small inputs only). */
function distance(a: string, b: string) {
	if (Math.abs(a.length - b.length) > 2) return 3;
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++)
			row[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(row[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		prev = row;
	}
	return prev[b.length] ?? 0;
}

/**
 * Why a message looks suspicious, from SES's verdicts and what it says: viruses, spam, failed
 * authentication, text that tries to instruct an AI (prompt injection), hidden text, a sender
 * domain that looks like the brand's own, a display name that names another address. No AI:
 * fixed checks, so it's cheap and the same every time.
 */
export function assess(m: {
	from: string;
	spam?: string | null;
	virus?: string | null;
	spf?: string | null;
	dkim?: string | null;
	dmarc?: string | null;
	text?: string | null;
	html?: string | null;
	/** The brand's own domains, for lookalikes. */
	own?: string[];
}): MessageFlags | null {
	const reasons: { code: string; text: string; points: number }[] = [];
	if (m.virus === "FAIL") reasons.push({ code: "virus", text: "SES found a virus", points: 100 });
	if (m.spam === "FAIL") reasons.push({ code: "spam", text: "SES says it's spam", points: 55 });
	if (m.dmarc === "FAIL")
		reasons.push({
			code: "dmarc",
			text: "It failed DMARC: the sender may not be who it says",
			points: 40,
		});
	else if (m.spf === "FAIL" && m.dkim === "FAIL")
		reasons.push({ code: "auth", text: "It failed both SPF and DKIM", points: 30 });
	const body = `${m.text ?? ""}\n${(m.html ?? "").replace(/<[^>]+>/g, " ")}`.slice(0, 200_000);
	const injection = INJECTION.find((r) => r.test(body));
	if (injection)
		reasons.push({
			code: "prompt_injection",
			text: "It has text that tries to give an AI instructions",
			points: 60,
		});
	if (m.html && HIDDEN.test(m.html.slice(0, 500_000)))
		reasons.push({ code: "hidden_text", text: "It has text hidden from people", points: 25 });
	const address = bareAddress(m.from).toLowerCase();
	const host = address.split("@")[1] ?? "";
	if (host.includes("xn--"))
		reasons.push({
			code: "punycode",
			text: "The sender's domain uses look-alike letters",
			points: 35,
		});
	for (const d of m.own ?? []) {
		const own = d.toLowerCase();
		const base = host.split(".").slice(-2).join(".");
		const ownBase = own.split(".").slice(-2).join(".");
		if (base && ownBase && base !== ownBase && distance(base, ownBase) <= 2) {
			reasons.push({
				code: "lookalike",
				text: `The sender's domain looks like ${ownBase} but isn't`,
				points: 50,
			});
			break;
		}
	}
	const name = displayName(m.from);
	const named = /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/i.exec(name)?.[0]?.toLowerCase();
	if (named && named !== address)
		reasons.push({
			code: "display_name",
			text: `Its name shows ${named}, but it's from ${address}`,
			points: 30,
		});
	if (!reasons.length) return null;
	reasons.sort((a, b) => b.points - a.points);
	return {
		score: Math.min(
			100,
			reasons.reduce((s, r) => s + r.points, 0),
		),
		reasons: reasons.map(({ code, text }) => ({ code, text })),
	};
}

export const HOLD_SCORE = 50;

/** Lets agents see a held conversation (and its held messages). */
export async function releaseHeld(
	actor: InboxActor,
	x: Conversation,
	now = Date.now(),
	/** The conversation's held_at as the person saw it: mail held after that isn't released. */
	seen?: string | null,
) {
	if (actor.type === "agent")
		throw new ApiError(403, "people_only", "Only a person can release held mail");
	need(actor, "triage");
	if (!x.held_at) return;
	if (seen && seen !== x.held_at)
		throw new ApiError(
			409,
			"conversation_changed",
			"More mail was held since you looked: read it before releasing",
		);
	const re = schema.receivedEmails;
	// Only what was held by then; a message held while this runs stays held, and so does the conversation.
	await db.batch([
		db
			.update(re)
			.set({ held: false })
			.where(
				and(eq(re.conversation_id, x.id), eq(re.held, true), lte(re.created_at, x.held_at)),
			),
		db
			.update(c)
			.set({ held_at: null, updated_at: iso(now) })
			.where(and(eq(c.id, x.id), eq(c.held_at, x.held_at))),
	]);
	await logInbox(actor, {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.released_to_agents",
		now,
	});
}

// ── Rules ──────────────────────────────────────────────────────────────────

const ir = schema.inboxRules;
export type InboxRule = typeof ir.$inferSelect;

export const RULE_FIELDS = [
	"from",
	"from_domain",
	"to",
	"subject",
	"body",
	"has_attachments",
	"channel",
	"new_conversation",
	"suspicious",
	"business_hours",
] as const;
export const RULE_OPS = [
	"contains",
	"not_contains",
	"is",
	"is_not",
	"starts_with",
	"ends_with",
	"matches",
] as const;
export const RULE_ACTIONS = [
	"add_tag",
	"set_priority",
	"assign",
	"round_robin",
	"snooze_hours",
	"resolve",
	"auto_reply",
	"note",
	"hold",
	"notify",
] as const;

export const ruleInput = z.object({
	name: z.string().trim().min(1).max(100),
	enabled: z.boolean().optional(),
	match: z.enum(["all", "any"]).optional(),
	conditions: z
		.array(
			z.object({
				field: z.enum(RULE_FIELDS),
				op: z.enum(RULE_OPS).default("contains"),
				value: z.string().max(500).default(""),
			}),
		)
		.max(20),
	actions: z
		.array(
			z.object({
				type: z.enum(RULE_ACTIONS),
				value: z.union([z.string().max(2000), z.number()]).nullish(),
			}),
		)
		.min(1, "actions: what the rule does")
		.max(20),
	stop: z.boolean().optional(),
});

export const ruleView = (r: InboxRule) => ({
	object: "inbox_rule",
	id: r.id,
	inbox_id: r.inbox_id,
	name: r.name,
	enabled: r.enabled,
	position: r.position,
	match: r.match as "all" | "any",
	conditions: r.conditions,
	actions: r.actions,
	stop: r.stop,
	matched: r.matched,
	last_matched_at: r.last_matched_at,
	created_at: r.created_at,
	updated_at: r.updated_at,
});

export async function listRules(inboxId: string) {
	return db.select().from(ir).where(eq(ir.inbox_id, inboxId)).orderBy(ir.position, ir.created_at);
}

export async function saveRule(inbox: Inbox, raw: unknown, o: { id?: string; now?: number } = {}) {
	const now = o.now ?? Date.now();
	const v = ruleInput.parse(raw ?? {});
	for (const cond of v.conditions)
		if (cond.op === "matches") {
			if (cond.value.length > 200) throw validation("A pattern: up to 200 characters");
			try {
				new RegExp(cond.value, "i");
			} catch {
				throw validation(`"${cond.value}" isn't a valid pattern`);
			}
		}
	for (const a of v.actions)
		if (
			["add_tag", "assign", "auto_reply", "note", "notify", "set_priority"].includes(
				a.type,
			) &&
			!String(a.value ?? "").trim()
		)
			throw validation(`${a.type}: give it a value`);
	const values = {
		name: v.name,
		enabled: v.enabled ?? true,
		match: v.match ?? "all",
		conditions: v.conditions,
		actions: v.actions.map((a) => ({ type: a.type, value: a.value ?? null })),
		stop: v.stop ?? false,
		updated_at: iso(now),
	};
	if (o.id) {
		const [row] = await db
			.update(ir)
			.set(values)
			.where(and(eq(ir.id, o.id), eq(ir.inbox_id, inbox.id)))
			.returning();
		if (!row) throw notFound("Rule");
		return row;
	}
	const last = await db
		.select({ p: sql<number>`coalesce(max(${ir.position}), -1)` })
		.from(ir)
		.where(eq(ir.inbox_id, inbox.id))
		.get();
	const row = {
		id: crypto.randomUUID(),
		organization_id: inbox.organization_id,
		inbox_id: inbox.id,
		position: Number(last?.p ?? -1) + 1,
		matched: 0,
		last_matched_at: null,
		created_at: iso(now),
		...values,
	};
	await db.insert(ir).values(row);
	return row as InboxRule;
}

export async function deleteRule(inbox: Inbox, id: string) {
	const [row] = await db
		.delete(ir)
		.where(and(eq(ir.id, id), eq(ir.inbox_id, inbox.id)))
		.returning({ id: ir.id });
	if (!row) throw notFound("Rule");
}

/** Puts the inbox's rules in this order (ids; the rest after them). */
export async function orderRules(inbox: Inbox, ids: string[]) {
	const rules = await listRules(inbox.id);
	const order = [
		...ids.filter((id) => rules.some((r) => r.id === id)),
		...rules.map((r) => r.id).filter((id) => !ids.includes(id)),
	];
	await db.batch(
		order.map((id, i) => db.update(ir).set({ position: i }).where(eq(ir.id, id))) as never,
	);
}

export interface RuleMessage {
	from: string;
	to: string[];
	subject: string;
	text: string | null;
	attachments: number;
	channel: string;
	created: boolean;
	flags: MessageFlags | null;
	at: number;
	/** A website chat started from one of its topics: tagged, and given to someone. */
	topic?: { tag?: string | null; assignee?: string | null } | null;
}

function test(
	cond: { field: string; op: string; value: string },
	m: RuleMessage,
	s: InboxSettings,
) {
	const address = bareAddress(m.from).toLowerCase();
	const subject = (v: string | boolean) => v;
	const value = cond.value.trim().toLowerCase();
	const bool = (b: boolean) => (value === "false" || value === "no" ? !b : b);
	switch (cond.field) {
		case "has_attachments":
			return bool(m.attachments > 0);
		case "new_conversation":
			return bool(m.created);
		case "suspicious":
			return bool((m.flags?.score ?? 0) >= HOLD_SCORE);
		case "business_hours":
			return bool(inBusinessHours(m.at, s.sla.business_hours));
	}
	const field = String(
		subject(
			cond.field === "from"
				? m.from
				: cond.field === "from_domain"
					? (address.split("@")[1] ?? "")
					: cond.field === "to"
						? m.to.join(", ")
						: cond.field === "subject"
							? m.subject
							: cond.field === "channel"
								? m.channel
								: (m.text ?? "").slice(0, 100_000),
		),
	).toLowerCase();
	switch (cond.op) {
		case "contains":
			return field.includes(value);
		case "not_contains":
			return !field.includes(value);
		case "is":
			return field === value || (cond.field === "from" && address === value);
		case "is_not":
			return field !== value && !(cond.field === "from" && address === value);
		case "starts_with":
			return field.startsWith(value);
		case "ends_with":
			return field.endsWith(value) || (cond.field === "from" && address.endsWith(value));
		case "matches":
			try {
				return new RegExp(cond.value, "i").test(field.slice(0, 20_000));
			} catch {
				return false;
			}
	}
	return false;
}

export function ruleMatches(
	r: Pick<InboxRule, "match" | "conditions">,
	m: RuleMessage,
	s: InboxSettings,
) {
	if (!r.conditions.length) return true;
	return r.match === "any"
		? r.conditions.some((x) => test(x, m, s))
		: r.conditions.every((x) => test(x, m, s));
}

/** The system as an actor for rules: everything on the inbox, nothing outside it. */
const systemActor = async (x: Conversation, inbox: Inbox): Promise<InboxActor> => ({
	organizationId: await orgOfBrand(x.organization_id),
	brands: [x.organization_id],
	inboxIds: [inbox.id],
	permissions: new Set(["read", "attachments", "triage", "notes", "draft", "send"]),
	sendScope: "replies",
	type: "api",
	id: null,
	name: "Rules",
	reader: null,
});

// ── What happens when a message comes in ───────────────────────────────────

/**
 * After a message joined its conversation: holding it when it's suspicious, the inbox's
 * rules, round robin for a new conversation, the SLA. Never fails the caller.
 */
export async function onInbound(
	conversationId: string,
	m: RuleMessage & { messageId: string | null },
	now = Date.now(),
) {
	try {
		const x = await db.select().from(c).where(eq(c.id, conversationId)).get();
		if (!x) return;
		const inbox = await inboxOf(x.inbox_id);
		if (!inbox) return;
		const s = settingsOf(inbox);
		if (m.messageId && s.hold_suspicious && (m.flags?.score ?? 0) >= HOLD_SCORE) {
			await hold(x, m.messageId, m.flags?.reasons[0]?.text ?? "suspicious", now);
			x.held_at = iso(now);
		}
		const rules = (await listRules(inbox.id)).filter((r) => r.enabled);
		const actor = await systemActor(x, inbox);
		let assigned = false;
		if (m.created && m.topic) {
			if (m.topic.tag)
				await runAction(actor, x, inbox, { type: "add_tag", value: m.topic.tag }, m, now);
			if (m.topic.assignee)
				assigned = await runAction(
					actor,
					x,
					inbox,
					{ type: "assign", value: m.topic.assignee },
					m,
					now,
				);
		}
		for (const r of rules) {
			if (!ruleMatches(r, m, s)) continue;
			await db
				.update(ir)
				.set({ matched: sql`${ir.matched} + 1`, last_matched_at: iso(now) })
				.where(eq(ir.id, r.id));
			const fresh = (await db.select().from(c).where(eq(c.id, x.id)).get()) ?? x;
			for (const a of r.actions) {
				try {
					assigned = (await runAction(actor, fresh, inbox, a, m, now)) || assigned;
				} catch (error) {
					console.error("inbox rules: action failed", r.id, a.type, error);
				}
			}
			await logInbox("system", {
				brandId: x.organization_id,
				inboxId: inbox.id,
				conversationId: x.id,
				action: "rule.matched",
				detail: { rule: r.name, actions: r.actions.map((a) => a.type) },
				now,
			});
			if (r.stop) break;
		}
		const now2 = (await db.select().from(c).where(eq(c.id, x.id)).get()) ?? x;
		if (m.created && !assigned && !holderOf(now2, now)) {
			const next = await nextInTurn(inbox, now);
			if (next) {
				await giveTo(now2, next, "Round robin", now);
			}
		}
		await planSla(now2, now, { inbound: true });
	} catch (error) {
		console.error("inbox workflow: not applied", error);
	}
}

export async function giveTo(
	x: Conversation,
	who: { reader: string; name: string; type: "person" | "agent"; email: string | null },
	by: string,
	now: number,
) {
	await db
		.update(c)
		.set({
			assignee: who.reader,
			assignee_name: who.name,
			claimed_until: null,
			updated_at: iso(now),
		})
		.where(eq(c.id, x.id));
	await logInbox("system", {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "conversation.assigned",
		detail: { to: who.name, by },
		now,
	});
	await event(x, "inbox.conversation.assigned", {
		assignee: { reader: who.reader, name: who.name, type: who.type },
		assigned_by: { type: "system", name: by },
	});
	if (who.type === "person" && who.email)
		await mail(who.email, "A new conversation for you", x, [
			`${by} gave you "${x.subject || "(no subject)"}" from ${x.contact}.`,
		]);
}

async function hold(x: Conversation, messageId: string, why: string, now: number) {
	await db.batch([
		db
			.update(schema.receivedEmails)
			.set({ held: true })
			.where(eq(schema.receivedEmails.id, messageId)),
		db
			.update(c)
			.set({ held_at: iso(now) })
			.where(eq(c.id, x.id)),
	]);
	await logInbox("system", {
		brandId: x.organization_id,
		inboxId: x.inbox_id,
		conversationId: x.id,
		action: "message.held",
		detail: { message_id: messageId, reason: why },
		now,
	});
	await event(x, "inbox.message.held", { message_id: messageId, reason: why });
}

/** One rule action; true when it gave the conversation to someone. */
async function runAction(
	actor: InboxActor,
	x: Conversation,
	inbox: Inbox,
	a: { type: string; value?: string | number | null },
	m: RuleMessage & { messageId: string | null },
	now: number,
): Promise<boolean> {
	const value = a.value === null || a.value === undefined ? "" : String(a.value).trim();
	switch (a.type) {
		case "add_tag":
			await setTags(actor, x, { add: value.split(",") }, now);
			return false;
		case "set_priority":
			if ((PRIORITIES as readonly string[]).includes(value))
				await setPriority(actor, x, value as Priority, now);
			return false;
		case "assign": {
			const who = (await assignees(await orgOfBrand(inbox.organization_id), inbox)).find(
				(p) => p.reader === value,
			);
			if (who) await giveTo(x, who, "A rule", now);
			return !!who;
		}
		case "round_robin": {
			const next = await nextInTurn(inbox, now);
			if (next) await giveTo(x, next, "Round robin", now);
			return !!next;
		}
		case "snooze_hours": {
			const h = Number(value);
			if (h > 0 && h <= 24 * 366) await snooze(actor, x, iso(now + h * 3_600_000), now);
			return false;
		}
		case "resolve": {
			const { updateConversation } = await import("./conversations");
			await updateConversation(actor, x.id, { status: "resolved" }, now);
			return false;
		}
		case "note":
			await addNote(actor, x, { text: value }, now);
			return false;
		case "hold":
			if (m.messageId) await hold(x, m.messageId, "A rule holds it", now);
			return false;
		case "notify":
			for (const to of value
				.split(/[\s,;]+/)
				.filter((s) => /@/.test(s))
				.slice(0, 10))
				await mail(to, `New in ${inbox.name}: ${x.subject || "(no subject)"}`, x, [
					`${m.from} wrote to ${inbox.name}:`,
					(m.text ?? "").slice(0, 600),
				]);
			return false;
		case "auto_reply": {
			// Only to a person writing for the first time, never to automatic mail (no loops).
			if (!m.created || x.channel !== "email" || automatic(m.from)) return false;
			const { text } = await savedReplyText(actor, x, value);
			const { sendReply } = await import("./conversations");
			const { sender } = await import("./inbox-api");
			await sendReply(actor, x.id, { text }, sender({ source: "api", apiKeyId: null }), {
				now,
				automatic: true,
			});
			return false;
		}
	}
	return false;
}

async function orgOfBrand(brandId: string) {
	const row = await db
		.select({ parent: schema.brands.parent_id })
		.from(schema.brands)
		.where(eq(schema.brands.id, brandId))
		.get();
	return row?.parent ?? brandId;
}

/** Addresses that never get an automatic reply. */
const automatic = (from: string) =>
	/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?|alerts?)[@+.-]/i.test(
		bareAddress(from),
	);

// ── SLA ────────────────────────────────────────────────────────────────────

type Hours = InboxSettings["sla"]["business_hours"];

/** The wall clock in a time zone: weekday (0 Sunday) and minutes since midnight. */
function local(at: number, tz: string) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(at));
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
	return { day, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

const toMinutes = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

export function inBusinessHours(at: number, h: Hours) {
	if (!h) return true;
	const l = local(at, h.timezone);
	return (
		h.days.includes(l.day) && l.minutes >= toMinutes(h.start) && l.minutes < toMinutes(h.end)
	);
}

/** `start` plus `mins` minutes of business hours (all minutes count without them). */
export function addBusinessMinutes(start: number, mins: number, h: Hours) {
	if (!h?.days.length) return start + mins * 60_000;
	const open = toMinutes(h.start);
	const close = toMinutes(h.end);
	let t = start - (start % 60_000);
	let left = mins;
	for (let i = 0; i < 800 && left > 0; i++) {
		const l = local(t, h.timezone);
		if (!h.days.includes(l.day) || l.minutes >= close) {
			// To the next day's opening.
			t += (24 * 60 - l.minutes + open) * 60_000;
			continue;
		}
		if (l.minutes < open) {
			t += (open - l.minutes) * 60_000;
			continue;
		}
		const today = close - l.minutes;
		if (left <= today) return t + left * 60_000;
		left -= today;
		t += (24 * 60 - l.minutes + open) * 60_000;
	}
	return t;
}

/**
 * Sets what's due in the inbox's SLA: a reply when a customer wrote and nobody answered yet
 * (from that message), resolving from when it opened. `recompute`: the priority changed.
 */
export async function planSla(
	x: Conversation,
	now = Date.now(),
	o: { inbound?: boolean; recompute?: boolean } = {},
) {
	const inbox = await inboxOf(x.inbox_id);
	const s = settingsOf(inbox).sla;
	if (!s.enabled) return;
	const target = s.targets[(x.priority as Priority) ?? "normal"] ?? s.targets.normal;
	const set: Partial<Conversation> = {};
	const waiting = (x.last_inbound_at ?? "") > (x.last_reply_at ?? "");
	if (target?.reply && waiting && (o.recompute || (o.inbound && !x.sla_first_due_at))) {
		const from = Date.parse(
			o.recompute ? (x.last_inbound_at ?? iso(now)) : (x.last_inbound_at ?? iso(now)),
		);
		set.sla_first_due_at = iso(addBusinessMinutes(from, target.reply, s.business_hours));
		set.sla_warned_at = null;
	}
	if (target?.resolve && x.status === "open" && (o.recompute || !x.sla_resolve_due_at))
		set.sla_resolve_due_at = iso(
			addBusinessMinutes(Date.parse(x.created_at), target.resolve, s.business_hours),
		);
	if (Object.keys(set).length) await db.update(c).set(set).where(eq(c.id, x.id));
}

/** A reply went: the reply is no longer due (missed if it was past due). */
export async function slaReplied(x: Conversation, now = Date.now()) {
	if (!x.sla_first_due_at) return;
	const missed = x.sla_first_due_at < iso(now);
	await db
		.update(c)
		.set({
			sla_first_due_at: null,
			sla_warned_at: null,
			...(missed ? { sla_breached: addBreach(x.sla_breached, "reply") } : {}),
		})
		.where(eq(c.id, x.id));
}

/** Resolved: nothing is due any more. */
export async function slaResolved(x: Conversation, now = Date.now()) {
	const missed = !!x.sla_resolve_due_at && x.sla_resolve_due_at < iso(now);
	await db
		.update(c)
		.set({
			sla_first_due_at: null,
			sla_resolve_due_at: null,
			sla_warned_at: null,
			...(missed ? { sla_breached: addBreach(x.sla_breached, "resolve") } : {}),
		})
		.where(eq(c.id, x.id));
}

const addBreach = (was: string | null, what: "reply" | "resolve") =>
	[...new Set([...(was ?? "").split(",").filter(Boolean), what])].join(",");

/** Cron: replies coming due (a warning) and past due (a breach), each told once. */
export async function checkSla(now = Date.now()) {
	const at = iso(now);
	const open = and(eq(c.status, "open"), isNull(c.snoozed_until));
	const late = await db
		.select()
		.from(c)
		.where(
			and(
				open,
				sql`((${c.sla_first_due_at} IS NOT NULL AND ${c.sla_first_due_at} < ${at} AND coalesce(${c.sla_breached}, '') NOT LIKE '%reply%') OR (${c.sla_resolve_due_at} IS NOT NULL AND ${c.sla_resolve_due_at} < ${at} AND coalesce(${c.sla_breached}, '') NOT LIKE '%resolve%'))`,
			),
		)
		.limit(200);
	for (const x of late) {
		const what: ("reply" | "resolve")[] = [];
		if (
			x.sla_first_due_at &&
			x.sla_first_due_at < at &&
			!(x.sla_breached ?? "").includes("reply")
		)
			what.push("reply");
		if (
			x.sla_resolve_due_at &&
			x.sla_resolve_due_at < at &&
			!(x.sla_breached ?? "").includes("resolve")
		)
			what.push("resolve");
		let b = x.sla_breached;
		for (const w of what) b = addBreach(b, w);
		await db.update(c).set({ sla_breached: b }).where(eq(c.id, x.id));
		for (const w of what) {
			await logInbox("system", {
				brandId: x.organization_id,
				inboxId: x.inbox_id,
				conversationId: x.id,
				action: "sla.breached",
				detail: {
					what: w,
					due: (w === "reply" ? x.sla_first_due_at : x.sla_resolve_due_at) ?? "",
				},
				now,
			});
			await event(x, "inbox.sla.breached", {
				what: w,
				due_at: w === "reply" ? x.sla_first_due_at : x.sla_resolve_due_at,
				assignee: holderOf(x, now)?.name ?? null,
			});
			await notifySla(x, `Overdue: ${x.subject || "(no subject)"}`, [
				w === "reply"
					? `Nobody has replied to ${x.contact} and the reply was due ${x.sla_first_due_at}.`
					: `It should have been resolved by ${x.sla_resolve_due_at}.`,
			]);
		}
	}
	// Warnings: due within the inbox's warn_minutes, not warned yet.
	const soon = await db
		.select()
		.from(c)
		.where(
			and(
				open,
				isNotNull(c.sla_first_due_at),
				isNull(c.sla_warned_at),
				sql`${c.sla_first_due_at} >= ${at}`,
				lt(c.sla_first_due_at, iso(now + 24 * 3_600_000)),
			),
		)
		.limit(200);
	const settings = new Map<string, InboxSettings>();
	for (const x of soon) {
		if (!x.inbox_id) continue;
		if (!settings.has(x.inbox_id))
			settings.set(x.inbox_id, settingsOf(await inboxOf(x.inbox_id)));
		const s = settings.get(x.inbox_id) as InboxSettings;
		if (
			!s.sla.warn_minutes ||
			(x.sla_first_due_at as string) > iso(now + s.sla.warn_minutes * 60_000)
		)
			continue;
		await db.update(c).set({ sla_warned_at: at }).where(eq(c.id, x.id));
		await event(x, "inbox.sla.warning", {
			due_at: x.sla_first_due_at,
			assignee: holderOf(x, now)?.name ?? null,
		});
		await notifySla(x, `Due soon: ${x.subject || "(no subject)"}`, [
			`A reply to ${x.contact} is due ${x.sla_first_due_at}.`,
		]);
	}
	return { breached: late.length, warned: soon.length };
}

/** The SLA's emails: the inbox's notify list, and whoever has the conversation. */
async function notifySla(x: Conversation, subject: string, lines: string[]) {
	const s = settingsOf(await inboxOf(x.inbox_id)).sla;
	const to = new Set(s.notify.map((e) => e.toLowerCase()));
	if (x.assignee?.startsWith("user:")) {
		const u = await db
			.select({ email: schema.user.email })
			.from(schema.user)
			.where(eq(schema.user.id, x.assignee.slice(5)))
			.get();
		if (u?.email) to.add(u.email.toLowerCase());
	}
	for (const e of to) await mail(e, subject, x, lines);
}

// ── Satisfaction (CSAT) ────────────────────────────────────────────────────

const csatPath = async (id: string) => {
	const { sign } = await import("./inbound");
	return `${baseUrl()}/rate/${id}/${await sign(`csat:${id}`)}`;
};

const FACES = ["😞", "🙁", "😐", "🙂", "😍"];

/** The survey email: five links, one per answer. */
export async function surveyEmail(x: Conversation, s: InboxSettings["csat"]) {
	const base = await csatPath(x.id);
	const cells = FACES.map(
		(f, i) =>
			`<td style="padding:4px"><a href="${base}/${i + 1}" style="display:block;width:52px;height:52px;line-height:52px;text-align:center;font-size:28px;text-decoration:none;border:1px solid #e5e4df;border-radius:12px">${f}</a></td>`,
	).join("");
	const q = s.question.replace(/[<>&"]/g, "");
	return {
		subject: `${q} · ${x.subject || "your conversation"}`.slice(0, 200),
		text: `${s.question}\n\n${FACES.map((_, i) => `${i + 1} of 5: ${base}/${i + 1}`).join("\n")}`,
		html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1a"><p style="margin:0 0 16px">${q}</p><table role="presentation" cellspacing="0" cellpadding="0"><tr>${cells}</tr></table><p style="margin:16px 0 0;font-size:13px;color:#77756f">One click is enough; you can add a comment after.</p></div>`,
	};
}

/** Cron: surveys for conversations resolved a while ago (the inbox's delay), once each. */
export async function sendSurveys(now = Date.now()) {
	const inboxes = (await db.select().from(schema.inboxes)).filter(
		(i) => settingsOf(i).csat.enabled,
	);
	let sent = 0;
	for (const inbox of inboxes) {
		const s = settingsOf(inbox).csat;
		const rows = await db
			.select()
			.from(c)
			.where(
				and(
					eq(c.inbox_id, inbox.id),
					eq(c.status, "resolved"),
					eq(c.channel, "email"),
					isNull(c.csat_sent_at),
					lt(c.resolved_at, iso(now - s.delay_minutes * 60_000)),
					sql`${c.resolved_at} > ${iso(now - 3 * 86_400_000)}`,
					isNotNull(c.first_reply_at),
				),
			)
			.limit(50);
		for (const x of rows) {
			// Taken first, so two runs never send it twice.
			const [took] = await db
				.update(c)
				.set({ csat_sent_at: iso(now) })
				.where(and(eq(c.id, x.id), isNull(c.csat_sent_at)))
				.returning({ id: c.id });
			if (!took) continue;
			if (automatic(x.contact)) continue;
			try {
				const mailOut = await surveyEmail(x, s);
				const { sender } = await import("./inbox-api");
				const from = inbox.reply_from ?? (inbox.domain_id ? inbox.address : null);
				if (!from) continue;
				await sender({ source: "api", apiKeyId: null }).send(x.organization_id, {
					brand: x.organization_id,
					from,
					to: [x.contact],
					reply_to: [inbox.address],
					subject: mailOut.subject,
					text: mailOut.text,
					html: mailOut.html,
					tags: [
						{ name: "conversation", value: x.id },
						{ name: "kind", value: "csat" },
					],
				});
				sent++;
				await logInbox("system", {
					brandId: x.organization_id,
					inboxId: x.inbox_id,
					conversationId: x.id,
					action: "csat.sent",
					now,
				});
			} catch (error) {
				console.error("csat: survey not sent", x.id, error);
			}
		}
	}
	return sent;
}

/** An answer to a survey (and later its comment). */
export async function rate(
	id: string,
	signature: string,
	rating: number,
	comment: string | null,
	now = Date.now(),
	o: { record?: boolean } = {},
) {
	const { sign } = await import("./inbound");
	const expected = await sign(`csat:${id}`);
	let diff = expected.length ^ signature.length;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
	if (diff || !(rating >= 1 && rating <= 5)) return null;
	const x = await db.select().from(c).where(eq(c.id, id)).get();
	if (!x) return null;
	if (o.record === false) return { conversation: x, inbox: await inboxOf(x.inbox_id) };
	await recordCsat(x, rating, comment, now);
	return { conversation: x, inbox: await inboxOf(x.inbox_id) };
}

/**
 * A rating (1-5) and maybe a comment, from the survey email or the chat widget: on the
 * conversation, in the activity, to webhooks (the first time, or with a comment).
 */
export async function recordCsat(
	x: Conversation,
	rating: number,
	comment: string | null,
	now = Date.now(),
) {
	const first = x.csat_rating === null;
	await db
		.update(c)
		.set({
			csat_rating: rating,
			csat_at: iso(now),
			...(comment !== null ? { csat_comment: comment.slice(0, 2000) || null } : {}),
		})
		.where(eq(c.id, x.id));
	if (first || comment) {
		await logInbox("system", {
			brandId: x.organization_id,
			inboxId: x.inbox_id,
			conversationId: x.id,
			action: "csat.received",
			detail: { rating, ...(comment ? { comment: comment.slice(0, 200) } : {}) },
			now,
		});
		await event(x, "inbox.csat.received", { rating, comment: !!comment });
	}
}

/** /rate/<conversation>/<signature>/<1-5>: a GET shows the page, a POST records the rating (and a comment). */
export async function handleRate(request: Request, now = Date.now()) {
	const m = /^\/rate\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{10,40})\/([1-5])$/.exec(
		new URL(request.url).pathname,
	);
	const { dressOf, dressPage } = await import("./newsletters");
	const { esc } = await import("../lib/signup-form-render");
	const page = async (
		brand: string | null,
		title: string,
		body: string,
		status = 200,
		nonce?: string,
	) => {
		const d = brand
			? await dressOf(null, brand)
			: ({
					look: (await import("../lib/newsletter-look")).lookOf(null),
					accent: null,
					logo: null,
					brand: "",
					name: "",
					home: null,
					subscribe: false,
				} as Awaited<ReturnType<typeof dressOf>>);
		return new Response(
			dressPage(d, {
				title,
				head: '<meta name="robots" content="noindex">',
				css: RATE_CSS,
				body: `<main><div class="box">${body}</div></main>`,
			}),
			{
				status,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": "no-store",
					"content-security-policy": `default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; form-action 'self'${nonce ? `; script-src 'nonce-${nonce}'; connect-src 'self'` : ""}`,
				},
			},
		);
	};
	if (!m) return page(null, "Not found", "<h1>This link isn't complete</h1>", 404);
	const [, id, sig, raw] = m as unknown as [string, string, string, string];
	// Opening the link only shows the page: mail scanners open every link in an email, so the
	// rating is recorded by a POST (the page's script sends it, or its button without one).
	const post = request.method === "POST";
	let comment: string | null = null;
	if (post) {
		const form = await request.formData().catch(() => null);
		comment = String(form?.get("comment") ?? "").trim() || null;
	}
	const done = await rate(id, sig, Number(raw), comment, now, { record: post });
	if (!done)
		return page(
			null,
			"Not found",
			"<h1>This link isn't valid</h1><p>It may be incomplete.</p>",
			404,
		);
	if (post && request.headers.get("x-mailroom-rate") === "auto")
		return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
	const s = settingsOf(done.inbox).csat;
	const brand = done.conversation.organization_id;
	if (post)
		return page(
			brand,
			"Thank you",
			`<h1>${esc(s.thanks)}</h1><p>${comment ? "Your comment is with the team." : "Your rating is recorded."}</p>`,
		);
	const faces = FACES.map(
		(f, i) =>
			`<a class="${i + 1 === Number(raw) ? "on" : ""}" href="./${i + 1}" aria-label="${i + 1} of 5">${f}</a>`,
	).join("");
	const nonce = crypto.randomUUID().replace(/-/g, "");
	return page(
		brand,
		"Thank you",
		`<h1>${esc(s.thanks)}</h1><p>${esc(s.question)}</p><div class="faces">${faces}</div><p id="n" class="note">Press Send to record your rating.</p><form method="post"><label for="c">Anything to add? (optional)</label><textarea id="c" name="comment" rows="4" maxlength="2000"></textarea><button type="submit">Send</button></form><script nonce="${nonce}">fetch(location.href,{method:"POST",headers:{"x-mailroom-rate":"auto"}}).then(function(r){if(r.ok)document.getElementById("n").hidden=true})</script>`,
		200,
		nonce,
	);
}

const RATE_CSS = `main{max-width:520px;margin:0 auto;padding:48px 20px}
.box{background:var(--card,#fff);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 6px;font-size:22px;line-height:1.3}
p{margin:0 0 18px;color:var(--soft);font-size:15px;line-height:1.55}
.faces{display:flex;gap:8px;margin:0 0 22px}.faces a{flex:1;text-align:center;font-size:30px;line-height:56px;border:1px solid var(--line);border-radius:12px;text-decoration:none}
.faces a.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 12%,transparent)}
label{display:block;font-size:14px;margin:0 0 6px;color:var(--soft)}
textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:transparent;color:inherit}
button{margin-top:12px;border:0;border-radius:10px;padding:10px 18px;font:500 15px/1 var(--font);background:var(--accent);color:var(--on-accent);cursor:pointer}`;

// ── Idempotency ────────────────────────────────────────────────────────────

const ik = schema.idempotencyKeys;

/**
 * Runs `fn` once per (actor, key): the same key again gets the first answer (a retried send
 * never sends twice); the same key for a different request is refused. A failure frees the key.
 */
export async function once<T>(
	actor: string,
	key: string | null | undefined,
	request: string,
	fn: () => Promise<{ status: number; body: T }>,
	now = Date.now(),
): Promise<{ status: number; body: T; replayed?: boolean }> {
	if (!key) return fn();
	if (key.length > 200) throw validation("Idempotency-Key: up to 200 characters");
	const { sha256Hex } = await import("./aws/sigv4");
	const req = await sha256Hex(request);
	const [took] = await db
		.insert(ik)
		.values({ actor, key, request: req, created_at: iso(now) })
		.onConflictDoNothing()
		.returning({ key: ik.key });
	if (!took) {
		const seen = await db
			.select()
			.from(ik)
			.where(and(eq(ik.actor, actor), eq(ik.key, key)))
			.get();
		if (seen && seen.request !== req)
			throw new ApiError(
				422,
				"idempotency_key_reused",
				"This Idempotency-Key was used for another request",
			);
		// One left "running" by a request that died (no answer in 5 minutes) is taken over.
		if (!seen?.status && seen && seen.created_at < iso(now - 5 * 60_000)) {
			const taken = await db
				.update(ik)
				.set({ created_at: iso(now) })
				.where(
					and(
						eq(ik.actor, actor),
						eq(ik.key, key),
						isNull(ik.status),
						eq(ik.created_at, seen.created_at),
					),
				)
				.returning({ key: ik.key });
			if (taken.length) return run();
		}
		if (!seen?.status)
			throw new ApiError(
				409,
				"request_in_progress",
				"A request with this Idempotency-Key is still running",
			);
		return {
			status: seen.status,
			body: JSON.parse(seen.response ?? "null") as T,
			replayed: true,
		};
	}
	return run();
	async function run() {
		const k = key as string;
		try {
			const out = await fn();
			await db
				.update(ik)
				.set({ status: out.status, response: JSON.stringify(out.body) })
				.where(and(eq(ik.actor, actor), eq(ik.key, k)));
			return out;
		} catch (error) {
			await db.delete(ik).where(and(eq(ik.actor, actor), eq(ik.key, k)));
			throw error;
		}
	}
}

/** Cron (daily): keys older than a day. */
export async function purgeIdempotency(now = Date.now()) {
	await db.delete(ik).where(lt(ik.created_at, iso(now - 86_400_000)));
}

// ── Waiting for mail ───────────────────────────────────────────────────────

/**
 * Long polling for an agent without a public URL: received messages after `since` (ISO; now
 * when left out), waiting up to `seconds` for the first one.
 */
export async function waitForMessages(
	actor: InboxActor,
	o: { inbox?: string | null; since?: string | null; seconds?: number },
) {
	need(actor, "read");
	const since = o.since && !Number.isNaN(Date.parse(o.since)) ? iso(Date.parse(o.since)) : iso();
	const until = Date.now() + Math.min(Math.max(o.seconds ?? 20, 0), 25) * 1000;
	const { searchMessages } = await import("./conversations");
	for (;;) {
		const page = await searchMessages(actor, { inbox: o.inbox, after_time: since, limit: 50 });
		if (page.data.length || Date.now() >= until) {
			const newest = page.data
				.map((m) => m.created_at)
				.sort()
				.at(-1);
			return { object: "list", data: page.data, since, next_since: newest ?? since };
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
}

// ── Little helpers ─────────────────────────────────────────────────────────

async function event(
	x: Pick<Conversation, "id" | "organization_id" | "inbox_id" | "subject">,
	type: Parameters<typeof import("./conversations").inboxEvent>[1],
	data: Record<string, unknown>,
) {
	const { inboxEvent } = await import("./conversations");
	await inboxEvent(x, type, data);
}

/** An email to a team member about a conversation, with the link to it. */
async function mail(to: string, subject: string, x: Pick<Conversation, "id">, lines: string[]) {
	try {
		const { sendSystemEmail, systemLayout } = await import("./system-email");
		const body = systemLayout({
			title: subject,
			lines,
			button: { label: "Open the conversation", url: `${baseUrl()}/received/${x.id}` },
		});
		await sendSystemEmail({ to, subject, ...body });
	} catch (error) {
		console.error("inbox workflow: email not sent", to, error);
	}
}
