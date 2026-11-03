import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db, schema } from "./db";
import type { ActivityDetail } from "./db/schema";
import { iso } from "./time";

/*
 * The activity log: who changed what in an organization (Settings › Activity, and each broadcast's
 * and template's history). Repeated saves of one thing by one person within MERGE_MINUTES are one
 * row, so autosave doesn't drown the log.
 */

const MERGE_MINUTES = 10;

export type ActivitySubject = { type: string; id?: string | null; name?: string | null };

async function actorName(userId: string | null | undefined) {
	if (!userId) return "Mailroom";
	const u = await db
		.select({ name: schema.user.name, email: schema.user.email })
		.from(schema.user)
		.where(eq(schema.user.id, userId))
		.get();
	return u?.name || u?.email || "Someone";
}

export async function logActivity(e: {
	organizationId: string;
	userId?: string | null;
	/** Shown instead of the person's name (an API key's). */
	actor?: string;
	action: string;
	subject: ActivitySubject;
	detail?: ActivityDetail;
	now?: number;
}) {
	const now = e.now ?? Date.now();
	const a = schema.activity;
	try {
		if (e.action.endsWith(".edited") && e.subject.id) {
			const recent = await db
				.select({ id: a.id })
				.from(a)
				.where(
					and(
						eq(a.organization_id, e.organizationId),
						eq(a.action, e.action),
						eq(a.subject_id, e.subject.id),
						e.userId ? eq(a.user_id, e.userId) : undefined,
						gt(a.created_at, iso(now - MERGE_MINUTES * 60_000)),
					),
				)
				.get();
			if (recent) {
				await db
					.update(a)
					.set({ created_at: iso(now), subject_name: e.subject.name ?? null })
					.where(eq(a.id, recent.id));
				return;
			}
		}
		await db.insert(a).values({
			id: crypto.randomUUID(),
			organization_id: e.organizationId,
			user_id: e.userId ?? null,
			actor: e.actor ?? (await actorName(e.userId)),
			action: e.action,
			subject_type: e.subject.type,
			subject_id: e.subject.id ?? null,
			subject_name: e.subject.name?.slice(0, 200) ?? null,
			detail: e.detail ?? null,
			created_at: iso(now),
		});
	} catch (error) {
		// The log never stops the change it records.
		console.error("activity: not logged", error);
	}
}

export async function listActivity(
	organizationId: string,
	o: { subject?: ActivitySubject; before?: string; limit?: number } = {},
) {
	const a = schema.activity;
	return db
		.select({
			id: a.id,
			user_id: a.user_id,
			actor: a.actor,
			action: a.action,
			subject_type: a.subject_type,
			subject_id: a.subject_id,
			subject_name: a.subject_name,
			detail: a.detail,
			created_at: a.created_at,
		})
		.from(a)
		.where(
			and(
				eq(a.organization_id, organizationId),
				o.subject ? eq(a.subject_type, o.subject.type) : undefined,
				o.subject?.id ? eq(a.subject_id, o.subject.id) : undefined,
				o.before ? lt(a.created_at, o.before) : undefined,
			),
		)
		.orderBy(desc(a.created_at))
		.limit(Math.min(o.limit ?? 100, 200));
}
