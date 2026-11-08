import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import { iso } from "./time";

/*
 * Notes on a contact, and follow-ups: a note with a due date for someone on the team ("call her
 * back Friday"). A contact's notes are shown with the notes left on the person's conversations,
 * so whoever opens the contact or the conversation sees everything the team wrote about them.
 */

const n = schema.contactNotes;
const cn = schema.conversationNotes;
const cv = schema.conversations;

export type ContactNote = typeof n.$inferSelect;

export const noteInput = z.object({
	text: z.string().trim().min(1, "Write the note").max(4000),
	/** A follow-up when set (an ISO time, or YYYY-MM-DD for that morning). */
	due_at: z.string().max(40).nullish(),
	/** A member's user id; without one, the follow-up is the author's. */
	assignee_id: z.string().max(100).nullish(),
	done: z.boolean().optional(),
});

export interface Author {
	type: "person" | "agent";
	id: string | null;
	name: string;
}

/** A due date as given: a day means 9:00 that morning (UTC); a time is kept. */
function dueOf(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T09:00:00.000Z` : raw;
	const t = Date.parse(day);
	if (Number.isNaN(t)) throw new ApiError(422, "validation_error", "That due date isn't a date");
	return new Date(t).toISOString();
}

/** A member of the organization, by user id (null when not one). */
async function memberOf(organizationId: string, userId: string) {
	const row = await db
		.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(
			and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)),
		)
		.get();
	return row ? { id: row.id, name: row.name || row.email } : null;
}

/** Who a follow-up can be for: the organization's members. */
export async function teamMembers(organizationId: string) {
	const rows = await db
		.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(eq(schema.member.organizationId, organizationId))
		.orderBy(asc(schema.user.name));
	return rows.map((r) => ({ id: r.id, name: r.name || r.email }));
}

export function noteView(x: ContactNote, now = Date.now()) {
	return {
		id: x.id,
		kind: x.due_at ? ("follow_up" as const) : ("note" as const),
		contact_id: x.contact_id,
		text: x.text,
		author: x.author_name,
		author_id: x.author_id,
		author_type: x.author_type,
		due_at: x.due_at,
		overdue: !!x.due_at && !x.done_at && Date.parse(x.due_at) < now,
		assignee_id: x.assignee_id,
		assignee: x.assignee_name,
		done_at: x.done_at,
		done_by: x.done_by,
		created_at: x.created_at,
		updated_at: x.updated_at,
	};
}

/**
 * Everything the team wrote about a contact: its own notes and follow-ups, and the notes on the
 * brand's conversations with the same address. Open follow-ups first (soonest due), then the
 * rest newest first.
 */
export async function contactNotes(
	brand: string,
	contact: { id: string; email: string },
	now = Date.now(),
) {
	const [own, fromInbox] = await Promise.all([
		db
			.select()
			.from(n)
			.where(and(eq(n.organization_id, brand), eq(n.contact_id, contact.id)))
			.orderBy(desc(n.created_at))
			.limit(200),
		db
			.select({
				id: cn.id,
				text: cn.text,
				author: cn.author_name,
				at: cn.created_at,
				conversation_id: cn.conversation_id,
				subject: cv.subject,
			})
			.from(cn)
			.innerJoin(cv, eq(cv.id, cn.conversation_id))
			.where(
				and(
					eq(cv.organization_id, brand),
					sql`lower(${cv.contact_address}) = ${contact.email.toLowerCase()}`,
				),
			)
			.orderBy(desc(cn.created_at))
			.limit(100),
	]);
	const views = own.map((x) => noteView(x, now));
	const open = views
		.filter((x) => x.kind === "follow_up" && !x.done_at)
		.sort((a, b) => (a.due_at as string).localeCompare(b.due_at as string));
	const rest = views.filter((x) => !(x.kind === "follow_up" && !x.done_at));
	return {
		follow_ups: open,
		notes: rest,
		conversation_notes: fromInbox.map((x) => ({
			id: x.id,
			text: x.text,
			author: x.author,
			created_at: x.at,
			conversation_id: x.conversation_id,
			subject: x.subject || "(no subject)",
		})),
	};
}

/** A contact of the brand (404 when it isn't one). */
async function contactIn(brand: string, contactId: string) {
	const row = await db
		.select({ id: schema.contacts.id, email: schema.contacts.email })
		.from(schema.contacts)
		.where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.organization_id, brand)))
		.get();
	if (!row) throw new ApiError(404, "not_found", "That contact is gone");
	return row;
}

export async function addContactNote(o: {
	organizationId: string;
	brand: string;
	contactId: string;
	author: Author;
	input: z.input<typeof noteInput>;
	now?: number;
}) {
	const input = noteInput.parse(o.input);
	await contactIn(o.brand, o.contactId);
	const due_at = dueOf(input.due_at);
	const assignee = due_at
		? await assigneeOf(o.organizationId, input.assignee_id, o.author)
		: null;
	const at = iso(o.now);
	const row: ContactNote = {
		id: crypto.randomUUID(),
		organization_id: o.brand,
		contact_id: o.contactId,
		text: input.text,
		author_type: o.author.type,
		author_id: o.author.id,
		author_name: o.author.name,
		due_at,
		assignee_id: assignee?.id ?? null,
		assignee_name: assignee?.name ?? null,
		done_at: due_at && input.done ? at : null,
		done_by: due_at && input.done ? o.author.name : null,
		created_at: at,
		updated_at: at,
	};
	await db.insert(n).values(row);
	return noteView(row, o.now);
}

/** Who a follow-up is for: the member picked, else the author (when a person). */
async function assigneeOf(organizationId: string, id: string | null | undefined, author: Author) {
	const want = id || (author.type === "person" ? author.id : null);
	if (!want) return null;
	const m = await memberOf(organizationId, want);
	if (!m) throw new ApiError(422, "validation_error", "That person isn't on the team");
	return m;
}

/** Changes a note: its words, its due date (null makes it a plain note), who has it, done. */
export async function updateContactNote(o: {
	organizationId: string;
	brand: string;
	id: string;
	author: Author;
	input: Partial<z.input<typeof noteInput>>;
	now?: number;
}) {
	const row = await db
		.select()
		.from(n)
		.where(and(eq(n.id, o.id), eq(n.organization_id, o.brand)))
		.get();
	if (!row) throw new ApiError(404, "not_found", "That note is gone");
	const input = noteInput.partial().parse(o.input);
	const at = iso(o.now);
	const set: Partial<ContactNote> = { updated_at: at };
	if (input.text !== undefined) set.text = input.text;
	if (input.due_at !== undefined) set.due_at = dueOf(input.due_at);
	const due = set.due_at !== undefined ? set.due_at : row.due_at;
	if (input.assignee_id !== undefined || (due && !row.due_at)) {
		const a = due ? await assigneeOf(o.organizationId, input.assignee_id, o.author) : null;
		set.assignee_id = a?.id ?? null;
		set.assignee_name = a?.name ?? null;
	}
	if (!due) {
		set.assignee_id = null;
		set.assignee_name = null;
	}
	if (input.done !== undefined) {
		set.done_at = input.done ? at : null;
		set.done_by = input.done ? o.author.name : null;
	}
	await db.update(n).set(set).where(eq(n.id, row.id));
	return noteView({ ...row, ...set }, o.now);
}

export async function deleteContactNote(brand: string, id: string) {
	const row = await db
		.select({ id: n.id, text: n.text, contact_id: n.contact_id })
		.from(n)
		.where(and(eq(n.id, id), eq(n.organization_id, brand)))
		.get();
	if (!row) throw new ApiError(404, "not_found", "That note is gone");
	await db.delete(n).where(eq(n.id, id));
	return row;
}

/** A contact's open follow-ups and how many notes it has (the inbox's person panel). */
export async function contactNoteSummary(brand: string, contactId: string, now = Date.now()) {
	const [open, count] = await Promise.all([
		db
			.select()
			.from(n)
			.where(
				and(
					eq(n.organization_id, brand),
					eq(n.contact_id, contactId),
					isNotNull(n.due_at),
					isNull(n.done_at),
				),
			)
			.orderBy(asc(n.due_at))
			.limit(5),
		db
			.select({ n: sql<number>`COUNT(*)` })
			.from(n)
			.where(and(eq(n.organization_id, brand), eq(n.contact_id, contactId)))
			.get(),
	]);
	const last = await db
		.select()
		.from(n)
		.where(and(eq(n.organization_id, brand), eq(n.contact_id, contactId), isNull(n.due_at)))
		.orderBy(desc(n.created_at))
		.limit(1)
		.get();
	return {
		count: Number(count?.n ?? 0),
		follow_ups: open.map((x) => noteView(x, now)),
		last_note: last ? noteView(last, now) : null,
	};
}

/**
 * Open follow-ups across brands: someone's (assignee), everyone's, or the ones due by a time.
 * With the contact each is about.
 */
export async function openFollowUps(o: {
	brands: string[];
	assignee?: string | null;
	dueBy?: string | null;
	limit?: number;
	now?: number;
}) {
	if (!o.brands.length) return [];
	const rows = await db
		.select({
			note: n,
			email: schema.contacts.email,
			first_name: schema.contacts.first_name,
			last_name: schema.contacts.last_name,
		})
		.from(n)
		.innerJoin(schema.contacts, eq(schema.contacts.id, n.contact_id))
		.where(
			and(
				inArray(n.organization_id, o.brands),
				isNotNull(n.due_at),
				isNull(n.done_at),
				o.assignee ? eq(n.assignee_id, o.assignee) : undefined,
				o.dueBy ? lte(n.due_at, o.dueBy) : undefined,
			),
		)
		.orderBy(asc(n.due_at))
		.limit(o.limit ?? 50);
	return rows.map((r) => ({
		...noteView(r.note, o.now),
		brand_id: r.note.organization_id,
		contact: {
			id: r.note.contact_id,
			email: r.email,
			name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
		},
	}));
}
