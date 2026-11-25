import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { fillVariables } from "@/lib/reply-variables";
import { db, schema } from "./db";
import type { InboxMacroActions, InboxViewFilters } from "./db/schema";
import { ApiError, notFound, validation } from "./errors";
import {
	addNote,
	assignees,
	giveTo,
	PRIORITIES,
	type Priority,
	setPriority,
	setTags,
	snooze,
} from "./inbox-workflow";
import type { InboxActor } from "./inboxes";
import { organizationOf } from "./org-aws";
import { iso } from "./time";

/**
 * Inbox power-user workflows:
 *  - Multi-action Macros (reply + internal note + tags + priority + assignee + status/snooze in one click)
 *  - Custom Saved Views (shared team or personal filter presets pinned in the Inbox sidebar)
 */

const macroActionsSchema = z.object({
	add_tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	remove_tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
	priority: z.enum(PRIORITIES).nullable().optional(),
	assignee: z.string().max(80).nullable().optional(),
	status: z.enum(["open", "resolved"]).nullable().optional(),
	snooze_hours: z
		.number()
		.min(0.5)
		.max(24 * 365)
		.nullable()
		.optional(),
});

const macroInput = z.object({
	id: z.string().optional(),
	inbox_id: z.string().nullable().optional(),
	name: z.string().trim().min(1, "name: give the macro a name").max(80),
	shortcut: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9_-]{1,32}$/, "shortcut: letters, numbers, dashes or underscores")
		.nullable()
		.optional(),
	reply_text: z.string().max(20_000).nullable().optional(),
	note_text: z.string().max(10_000).nullable().optional(),
	actions: macroActionsSchema.default({}),
});

export type InboxMacroRow = typeof schema.inboxMacros.$inferSelect;

export const macroView = (m: InboxMacroRow) => ({
	id: m.id,
	brand_id: m.organization_id,
	inbox_id: m.inbox_id,
	name: m.name,
	shortcut: m.shortcut,
	reply_text: m.reply_text,
	note_text: m.note_text,
	actions: (m.actions ?? {}) as InboxMacroActions,
	uses: m.uses,
	created_at: m.created_at,
	updated_at: m.updated_at,
});

export async function listMacros(brands: string[], inboxId?: string | null) {
	if (!brands.length) return [];
	const rows = await db
		.select()
		.from(schema.inboxMacros)
		.where(
			and(
				inArray(schema.inboxMacros.organization_id, brands),
				inboxId
					? or(
							eq(schema.inboxMacros.inbox_id, inboxId),
							sql`${schema.inboxMacros.inbox_id} IS NULL`,
						)
					: undefined,
			),
		)
		.orderBy(asc(schema.inboxMacros.name));
	return rows.map(macroView);
}

export async function saveMacro(
	brandId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = macroInput.parse(raw ?? {});
	const existing = v.id
		? await db
				.select()
				.from(schema.inboxMacros)
				.where(
					and(
						eq(schema.inboxMacros.id, v.id),
						eq(schema.inboxMacros.organization_id, brandId),
					),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("Macro");
	const hasAnyEffect = Boolean(
		v.reply_text?.trim() ||
			v.note_text?.trim() ||
			v.actions.add_tags?.length ||
			v.actions.remove_tags?.length ||
			v.actions.priority ||
			v.actions.assignee !== undefined ||
			v.actions.status ||
			v.actions.snooze_hours,
	);
	if (!hasAnyEffect) throw validation("Pick at least one action, reply text, or internal note");

	const row = {
		id: existing?.id ?? `mac_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: brandId,
		inbox_id: v.inbox_id !== undefined ? v.inbox_id || null : (existing?.inbox_id ?? null),
		name: v.name,
		shortcut: v.shortcut !== undefined ? v.shortcut || null : (existing?.shortcut ?? null),
		reply_text:
			v.reply_text !== undefined
				? v.reply_text?.trim() || null
				: (existing?.reply_text ?? null),
		note_text:
			v.note_text !== undefined ? v.note_text?.trim() || null : (existing?.note_text ?? null),
		actions: v.actions,
		uses: existing?.uses ?? 0,
		created_by: existing?.created_by ?? userId,
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};
	if (existing) {
		await db.update(schema.inboxMacros).set(row).where(eq(schema.inboxMacros.id, existing.id));
	} else {
		await db.insert(schema.inboxMacros).values(row);
	}
	return macroView(row);
}

export async function deleteMacro(brands: string[], id: string) {
	if (!brands.length) throw notFound("Macro");
	const [removed] = await db
		.delete(schema.inboxMacros)
		.where(
			and(eq(schema.inboxMacros.id, id), inArray(schema.inboxMacros.organization_id, brands)),
		)
		.returning({ id: schema.inboxMacros.id });
	if (!removed) throw notFound("Macro");
	return { deleted: true, id: removed.id };
}

/**
 * Execute a macro against a conversation: applies triage actions (tags, priority, assignee,
 * note, snooze, status) and returns the variable-filled reply_text (if any) for the composer.
 */
export async function applyMacro(
	actor: InboxActor,
	conversationId: string,
	macroId: string,
	now = Date.now(),
) {
	const conv = await db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId))
		.get();
	if (!conv || !actor.brands.includes(conv.organization_id)) throw notFound("Conversation");
	const macro = await db
		.select()
		.from(schema.inboxMacros)
		.where(
			and(
				eq(schema.inboxMacros.id, macroId),
				eq(schema.inboxMacros.organization_id, conv.organization_id),
			),
		)
		.get();
	if (!macro) throw notFound("Macro");

	const actions = (macro.actions ?? {}) as InboxMacroActions;
	const applied: string[] = [];

	if (actions.add_tags?.length || actions.remove_tags?.length) {
		await setTags(actor, conv, { add: actions.add_tags, remove: actions.remove_tags }, now);
		if (actions.add_tags?.length) applied.push(`+${actions.add_tags.join(", +")}`);
		if (actions.remove_tags?.length) applied.push(`-${actions.remove_tags.join(", -")}`);
	}
	if (actions.priority) {
		await setPriority(actor, conv, actions.priority as Priority, now);
		applied.push(`priority:${actions.priority}`);
	}
	if (actions.assignee) {
		const people = await assignees(actor.organizationId, null);
		const target =
			actions.assignee === "me" && actor.reader
				? people.find((p) => p.reader === actor.reader)
				: people.find((p) => p.reader === actions.assignee);
		if (target) {
			await giveTo(conv, target, actor.name, now);
			applied.push(`assigned:${target.name}`);
		}
	}
	if (macro.note_text?.trim()) {
		await addNote(actor, conv, { text: macro.note_text.trim() }, now);
		applied.push("note");
	}
	if (actions.snooze_hours && actions.snooze_hours > 0) {
		await snooze(actor, conv, iso(now + actions.snooze_hours * 3_600_000), now);
		applied.push(`snoozed:${actions.snooze_hours}h`);
	} else if (actions.status) {
		const { updateConversation } = await import("./conversations");
		await updateConversation(actor, conv.id, { status: actions.status }, now);
		applied.push(`status:${actions.status}`);
	}

	await db
		.update(schema.inboxMacros)
		.set({ uses: sql`${schema.inboxMacros.uses} + 1` })
		.where(eq(schema.inboxMacros.id, macro.id));

	const reply_text = macro.reply_text
		? fillVariables(macro.reply_text, {
				contact: conv.contact,
				agent: actor.name,
				subject: conv.subject,
			})
		: null;

	return {
		macro: macroView({ ...macro, uses: macro.uses + 1 }),
		applied,
		reply_text,
	};
}

// ── Custom Saved Views ───────────────────────────────────────────────────────

const viewFiltersSchema = z.object({
	view: z.string().max(40).optional(),
	brand: z.string().max(80).optional(),
	inbox: z.string().max(80).optional(),
	tag: z.string().max(60).optional(),
	priority: z.string().max(20).optional(),
	assignee: z.string().max(80).optional(),
	unread: z.boolean().optional(),
	q: z.string().max(200).optional(),
});

const savedViewInput = z.object({
	id: z.string().optional(),
	name: z.string().trim().min(1, "name: give the view a name").max(60),
	color: z.string().trim().max(20).nullable().optional(),
	filters: viewFiltersSchema,
	shared: z.boolean().optional(),
});

export type InboxViewRow = typeof schema.inboxViews.$inferSelect;

export const savedViewView = (v: InboxViewRow) => ({
	id: v.id,
	name: v.name,
	color: v.color,
	filters: (v.filters ?? {}) as InboxViewFilters,
	shared: v.shared,
	created_by: v.created_by,
	created_at: v.created_at,
});

export async function listInboxViews(organizationId: string, userId: string | null) {
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.inboxViews)
		.where(
			and(
				eq(schema.inboxViews.organization_id, org),
				userId
					? or(
							eq(schema.inboxViews.shared, true),
							eq(schema.inboxViews.created_by, userId),
						)
					: eq(schema.inboxViews.shared, true),
			),
		)
		.orderBy(asc(schema.inboxViews.name));
	return rows.map(savedViewView);
}

export async function saveInboxView(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = savedViewInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const existing = v.id
		? await db
				.select()
				.from(schema.inboxViews)
				.where(
					and(eq(schema.inboxViews.id, v.id), eq(schema.inboxViews.organization_id, org)),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("Saved view");
	if (existing && !existing.shared && existing.created_by && existing.created_by !== userId)
		throw new ApiError(403, "forbidden", "You can only edit your own personal views");

	const row = {
		id: existing?.id ?? `ivw_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: org,
		name: v.name,
		color: v.color ?? existing?.color ?? "blue",
		filters: v.filters,
		shared: v.shared ?? existing?.shared ?? true,
		created_by: existing?.created_by ?? userId,
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};
	if (existing) {
		await db.update(schema.inboxViews).set(row).where(eq(schema.inboxViews.id, existing.id));
	} else {
		await db.insert(schema.inboxViews).values(row);
	}
	return savedViewView(row);
}

export async function deleteInboxView(
	organizationId: string,
	id: string,
	userId: string | null,
	canManageAll = false,
) {
	const org = await organizationOf(organizationId);
	const existing = await db
		.select()
		.from(schema.inboxViews)
		.where(and(eq(schema.inboxViews.id, id), eq(schema.inboxViews.organization_id, org)))
		.get();
	if (!existing) throw notFound("Saved view");
	if (!canManageAll && existing.created_by && existing.created_by !== userId)
		throw new ApiError(403, "forbidden", "Only the creator or an admin can delete this view");
	await db.delete(schema.inboxViews).where(eq(schema.inboxViews.id, existing.id));
	return { deleted: true, id: existing.id };
}
