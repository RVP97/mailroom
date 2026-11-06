import { waitUntil } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Access } from "../lib/permissions";
import { membersWith } from "./access";
import { logActivity } from "./activity";
import { getBroadcast } from "./broadcasts";
import { addComment } from "./comments";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { ApiError } from "./errors";
import { sendSystemEmail, systemLayout } from "./system-email";
import { iso } from "./time";

/*
 * Approval before sending. Anyone who edits broadcasts can ask for a review; someone with
 * "Approve" (never the one who asked) approves it or asks for changes. With the organization's
 * "Every broadcast needs approval" on, a broadcast is sent or scheduled only once approved, and
 * an approval holds for the content it saw: changing what people get asks again.
 */

type Broadcast = typeof schema.broadcasts.$inferSelect;

/** What people get, as one string's SHA-256 (an approval holds for it). */
export async function contentHash(x: Broadcast) {
	const s = JSON.stringify([
		x.subject,
		x.preview_text,
		x.from,
		x.segment_id,
		x.html,
		x.text,
		x.ab_test?.subjects ?? null,
	]);
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function approvalRequired(organizationId: string) {
	const row = await db
		.select({ on: schema.organizationSettings.require_approval })
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organization_id, organizationId))
		.get();
	return row?.on ?? false;
}

export async function setApprovalRequired(organizationId: string, on: boolean, now = Date.now()) {
	await db
		.insert(schema.organizationSettings)
		.values({ organization_id: organizationId, require_approval: on, updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.organizationSettings.organization_id,
			set: { require_approval: on, updated_at: iso(now) },
		});
}

/** Refuses to send or schedule a broadcast the organization needs approved and isn't. */
export async function assertApproved(organizationId: string, x: Broadcast) {
	if (!(await approvalRequired(organizationId))) return;
	if (x.review === "approved" && x.review_hash === (await contentHash(x))) return;
	throw new ApiError(
		409,
		"needs_approval",
		x.review === "requested"
			? "It's waiting for approval"
			: "This organization sends only approved broadcasts: ask for a review first",
	);
}

const background = (p: Promise<unknown>) => {
	const caught = p.catch((error) => console.error("reviews: email not sent", error));
	try {
		waitUntil(caught);
	} catch {
		return caught;
	}
};

async function userOf(id: string | null) {
	if (!id) return null;
	return db
		.select({ name: schema.user.name, email: schema.user.email })
		.from(schema.user)
		.where(eq(schema.user.id, id))
		.get();
}

function tell(to: string[], subject: string, title: string, lines: string[], url: string) {
	if (!to.length) return;
	const { html, text } = systemLayout({
		title,
		lines,
		button: { label: "Open the broadcast", url },
	});
	for (const address of to.slice(0, 20))
		void background(sendSystemEmail({ to: address, subject, html, text }));
}

const link = (id: string) => `${baseUrl() || "http://localhost:3000"}/broadcasts/${id}`;

export async function requestReview(o: {
	organizationId: string;
	brand: string;
	id: string;
	userId: string;
	note?: string;
	now?: number;
}) {
	const x = await getBroadcast(o.brand, o.id);
	if (x.status !== "draft") throw new ApiError(409, "not_draft", "Only a draft is reviewed");
	await db
		.update(schema.broadcasts)
		.set({
			review: "requested",
			review_requested_by: o.userId,
			review_requested_at: iso(o.now),
			reviewed_by: null,
			reviewed_at: null,
			review_hash: null,
		})
		.where(eq(schema.broadcasts.id, x.id));
	await addComment({
		organizationId: o.organizationId,
		type: "broadcast",
		id: x.id,
		userId: o.userId,
		body: o.note ?? "",
		kind: "requested",
		now: o.now,
	});
	await logActivity({
		organizationId: o.organizationId,
		userId: o.userId,
		action: "broadcast.review_requested",
		subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
	});
	const who = await userOf(o.userId);
	const approvers = (await membersWith(o.organizationId, "broadcasts:approve")).filter(
		(m) => m.userId !== o.userId,
	);
	tell(
		approvers.map((m) => m.email),
		`Review: ${x.subject || x.name || "a broadcast"}`,
		`${who?.name || who?.email || "Someone"} asked you to review a broadcast`,
		[
			`"${x.subject || x.name || "Untitled"}" is ready for a look.`,
			...(o.note?.trim() ? [`They wrote: ${o.note.trim()}`] : []),
		],
		link(x.id),
	);
	return getBroadcast(o.brand, o.id);
}

export async function decideReview(o: {
	organizationId: string;
	brand: string;
	id: string;
	userId: string;
	access: Access;
	approve: boolean;
	note?: string;
	/** The broadcast's updated_at as the reviewer saw it: an edit since then asks them to look again. */
	seen?: string | null;
	now?: number;
}) {
	if (!o.access.can("broadcasts:approve"))
		throw new ApiError(403, "forbidden", "You can't approve broadcasts here");
	const x = await getBroadcast(o.brand, o.id);
	if (x.status !== "draft") throw new ApiError(409, "not_draft", "Only a draft is reviewed");
	if (o.seen && o.seen !== x.updated_at)
		throw new ApiError(
			409,
			"broadcast_changed",
			"It was changed since you opened it: look at the new version first",
		);
	if (x.review_requested_by === o.userId && !o.access.owner)
		throw new ApiError(403, "forbidden", "Someone else approves what you asked for");
	if (!o.approve && !o.note?.trim())
		throw new ApiError(422, "validation_error", "Say what should change");
	const hash = o.approve ? await contentHash(x) : null;
	// The decision holds for the version read here: an edit or a send in between refuses it.
	const decided = await db
		.update(schema.broadcasts)
		.set({
			review: o.approve ? "approved" : "changes",
			reviewed_by: o.userId,
			reviewed_at: iso(o.now),
			review_hash: hash,
		})
		.where(
			and(
				eq(schema.broadcasts.id, x.id),
				eq(schema.broadcasts.status, "draft"),
				eq(schema.broadcasts.updated_at, x.updated_at),
			),
		)
		.returning({ id: schema.broadcasts.id });
	if (!decided.length)
		throw new ApiError(
			409,
			"broadcast_changed",
			"It was changed since you opened it: look at the new version first",
		);
	await addComment({
		organizationId: o.organizationId,
		type: "broadcast",
		id: x.id,
		userId: o.userId,
		body: o.note ?? "",
		kind: o.approve ? "approved" : "changes",
		now: o.now,
	});
	await logActivity({
		organizationId: o.organizationId,
		userId: o.userId,
		action: o.approve ? "broadcast.approved" : "broadcast.changes_requested",
		subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
	});
	const asker = await userOf(x.review_requested_by);
	const who = await userOf(o.userId);
	if (asker && x.review_requested_by !== o.userId)
		tell(
			[asker.email],
			`${o.approve ? "Approved" : "Changes asked"}: ${x.subject || x.name || "your broadcast"}`,
			o.approve
				? `${who?.name || who?.email || "Someone"} approved your broadcast`
				: `${who?.name || who?.email || "Someone"} asked for changes`,
			[
				`"${x.subject || x.name || "Untitled"}"`,
				...(o.note?.trim() ? [o.note.trim()] : []),
				...(o.approve ? ["Whoever can send may send or schedule it now."] : []),
			],
			link(x.id),
		);
	return getBroadcast(o.brand, o.id);
}

/** Takes a request back (who asked, or anyone who edits, before it's decided). */
export async function withdrawReview(o: {
	organizationId: string;
	brand: string;
	id: string;
	userId: string;
}) {
	const x = await getBroadcast(o.brand, o.id);
	if (x.review !== "requested") return x;
	await db
		.update(schema.broadcasts)
		.set({ review: null, review_requested_by: null, review_requested_at: null })
		.where(eq(schema.broadcasts.id, x.id));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.userId,
		action: "broadcast.review_withdrawn",
		subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
	});
	return getBroadcast(o.brand, o.id);
}
