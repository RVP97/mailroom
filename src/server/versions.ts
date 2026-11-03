import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "./db";
import type { VersionSnapshot } from "./db/schema";
import { ApiError } from "./errors";
import { iso } from "./time";

/*
 * Version history of a broadcast's or a template's content. Each save records what it saved: a
 * new version when someone else saves or 10 minutes after the last; otherwise the last version
 * takes the new content. The last KEEP stay.
 */

const MERGE_MS = 10 * 60_000;
const KEEP = 50;
const v = schema.contentVersions;

export type VersionSubject = "broadcast" | "template";

const same = (a: VersionSnapshot, b: VersionSnapshot) => JSON.stringify(a) === JSON.stringify(b);

export async function recordVersion(o: {
	organizationId: string;
	type: VersionSubject;
	id: string;
	userId: string | null;
	snapshot: VersionSnapshot;
	now?: number;
}) {
	const now = o.now ?? Date.now();
	try {
		const last = await db
			.select()
			.from(v)
			.where(and(eq(v.subject_type, o.type), eq(v.subject_id, o.id)))
			.orderBy(desc(v.created_at))
			.limit(1)
			.get();
		if (last && same(last.snapshot, o.snapshot)) return;
		if (
			last &&
			last.user_id === o.userId &&
			now - Date.parse(last.created_at) < MERGE_MS
		) {
			await db
				.update(v)
				.set({ snapshot: o.snapshot, updated_at: iso(now) })
				.where(eq(v.id, last.id));
			return;
		}
		await db.insert(v).values({
			id: crypto.randomUUID(),
			organization_id: o.organizationId,
			subject_type: o.type,
			subject_id: o.id,
			user_id: o.userId,
			snapshot: o.snapshot,
			created_at: iso(now),
			updated_at: iso(now),
		});
		const old = await db
			.select({ id: v.id })
			.from(v)
			.where(and(eq(v.subject_type, o.type), eq(v.subject_id, o.id)))
			.orderBy(desc(v.created_at))
			.limit(100)
			.offset(KEEP);
		if (old.length)
			await db.delete(v).where(
				inArray(
					v.id,
					old.map((r) => r.id),
				),
			);
	} catch (error) {
		console.error("versions: not recorded", error);
	}
}

export async function listVersions(organizationId: string, type: VersionSubject, id: string) {
	const rows = await db
		.select({
			id: v.id,
			user_id: v.user_id,
			snapshot: v.snapshot,
			created_at: v.created_at,
			updated_at: v.updated_at,
			name: schema.user.name,
			email: schema.user.email,
		})
		.from(v)
		.leftJoin(schema.user, eq(schema.user.id, v.user_id))
		.where(and(eq(v.organization_id, organizationId), eq(v.subject_type, type), eq(v.subject_id, id)))
		.orderBy(desc(v.created_at))
		.limit(KEEP);
	return rows.map(({ name, email, ...r }) => ({ ...r, who: name || email || "Mailroom" }));
}

export async function getVersion(organizationId: string, id: string) {
	const row = await db
		.select()
		.from(v)
		.where(and(eq(v.id, id), eq(v.organization_id, organizationId)))
		.get();
	if (!row) throw new ApiError(404, "not_found", "That version is gone");
	return row;
}

export const snapshotOf = (x: {
	subject?: string | null;
	preview_text?: string | null;
	html: string;
	text: string | null;
	design: VersionSnapshot["design"];
}): VersionSnapshot => ({
	subject: x.subject ?? "",
	preview_text: x.preview_text ?? null,
	html: x.html,
	text: x.text,
	design: x.design,
});
