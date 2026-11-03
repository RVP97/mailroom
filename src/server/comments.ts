import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import { iso } from "./time";

/*
 * Comments on a broadcast or a template: a thread beside its editor, optionally about one block of
 * its design. Review steps (asked for review, approved, changes asked) show in the same thread.
 */

export type CommentSubject = "broadcast" | "template";
export type CommentKind = "comment" | "requested" | "approved" | "changes";

const c = schema.comments;

export async function listComments(organizationId: string, type: CommentSubject, id: string) {
	const rows = await db
		.select({
			id: c.id,
			user_id: c.user_id,
			body: c.body,
			block_id: c.block_id,
			kind: c.kind,
			resolved_at: c.resolved_at,
			created_at: c.created_at,
			updated_at: c.updated_at,
			name: schema.user.name,
			email: schema.user.email,
		})
		.from(c)
		.leftJoin(schema.user, eq(schema.user.id, c.user_id))
		.where(and(eq(c.organization_id, organizationId), eq(c.subject_type, type), eq(c.subject_id, id)))
		.orderBy(asc(c.created_at))
		.limit(500);
	return rows.map((r) => ({
		...r,
		kind: r.kind as CommentKind,
		who: r.name || r.email || "Someone",
	}));
}

export async function addComment(o: {
	organizationId: string;
	type: CommentSubject;
	id: string;
	userId: string;
	body: string;
	blockId?: string | null;
	kind?: CommentKind;
	now?: number;
}) {
	const body = o.body.trim().slice(0, 4000);
	if (!body && (o.kind ?? "comment") === "comment")
		throw new ApiError(422, "validation_error", "Write something first");
	const row = {
		id: crypto.randomUUID(),
		organization_id: o.organizationId,
		subject_type: o.type,
		subject_id: o.id,
		user_id: o.userId,
		body,
		block_id: o.blockId?.slice(0, 40) || null,
		kind: o.kind ?? "comment",
		resolved_at: null,
		resolved_by: null,
		created_at: iso(o.now),
		updated_at: null,
	};
	await db.insert(c).values(row);
	return row;
}

async function own(organizationId: string, id: string) {
	const row = await db
		.select()
		.from(c)
		.where(and(eq(c.id, id), eq(c.organization_id, organizationId)))
		.get();
	if (!row) throw new ApiError(404, "not_found", "That comment is gone");
	return row;
}

export async function resolveComment(o: {
	organizationId: string;
	id: string;
	userId: string;
	resolved: boolean;
	now?: number;
}) {
	await own(o.organizationId, o.id);
	await db
		.update(c)
		.set(
			o.resolved
				? { resolved_at: iso(o.now), resolved_by: o.userId }
				: { resolved_at: null, resolved_by: null },
		)
		.where(eq(c.id, o.id));
}

/** Only who wrote it deletes a comment (review steps stay). */
export async function deleteComment(o: { organizationId: string; id: string; userId: string }) {
	const row = await own(o.organizationId, o.id);
	if (row.user_id !== o.userId) throw new ApiError(403, "forbidden", "Only who wrote it can delete it");
	if (row.kind !== "comment") throw new ApiError(409, "conflict", "Review steps stay in the thread");
	await db.delete(c).where(eq(c.id, o.id));
}

/** How many open comments each of these has (lists show them). */
export async function openComments(organizationId: string, type: CommentSubject, ids: string[]) {
	if (!ids.length) return new Map<string, number>();
	const rows = await db
		.select({ id: c.subject_id, resolved: c.resolved_at, kind: c.kind })
		.from(c)
		.where(
			and(
				eq(c.organization_id, organizationId),
				eq(c.subject_type, type),
				inArray(c.subject_id, ids.slice(0, 100)),
			),
		);
	const out = new Map<string, number>();
	for (const r of rows)
		if (!r.resolved && r.kind === "comment") out.set(r.id, (out.get(r.id) ?? 0) + 1);
	return out;
}
