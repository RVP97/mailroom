import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import { getBroadcast, updateBroadcast } from "@/server/broadcasts";
import {
	addComment,
	type CommentSubject,
	deleteComment,
	listComments,
	resolveComment,
} from "@/server/comments";
import {
	deleteSection,
	getKit,
	listSections,
	removeKit,
	renameSection,
	saveKit,
	saveSection,
} from "@/server/library";
import { can, orgMiddleware } from "@/server/middleware";
import { decideReview, requestReview, withdrawReview } from "@/server/reviews";
import { getTemplate, updateTemplate } from "@/server/templates";
import { getVersion, listVersions, recordVersion, snapshotOf } from "@/server/versions";
import { logActivity } from "@/server/activity";
import type { Permission } from "@/lib/permissions";
import { call } from "./call";

/** Working together on emails: comments, reviews, versions, saved sections and brand kits. */

const subject = z.object({ type: z.enum(["broadcast", "template"]), id: z.string() });

const EDIT: Record<CommentSubject, Permission> = {
	broadcast: "broadcasts:edit",
	template: "templates:edit",
};

async function brandsOf(organizationId: string) {
	const { brands } = await viewScope(organizationId);
	return brands.length ? brands.map((b) => b.id) : [organizationId];
}

/** The broadcast or template is the organization's. */
async function own(organizationId: string, type: CommentSubject, id: string) {
	if (type === "broadcast") return getBroadcast(await brandsOf(organizationId), id);
	return getTemplate(organizationId, id);
}

export const commentsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(subject)
	.handler(({ data, context }) =>
		call(async () => {
			await own(context.organizationId, data.type, data.id);
			return listComments(context.organizationId, data.type, data.id);
		}),
	);

export const addCommentFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(subject.extend({ body: z.string().max(4000), block: z.string().max(40).nullish() }))
	.handler(({ data, context }) =>
		call(async () => {
			if (!context.access.can(EDIT[data.type]) && !context.access.can("broadcasts:approve"))
				throw new Response("You can't comment here", { status: 403 });
			const x = await own(context.organizationId, data.type, data.id);
			const row = await addComment({
				organizationId: context.organizationId,
				type: data.type,
				id: data.id,
				userId: context.userId,
				body: data.body,
				blockId: data.block,
			});
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: `${data.type}.commented`,
				subject: { type: data.type, id: data.id, name: x.name },
			});
			return row;
		}),
	);

export const resolveCommentFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string(), resolved: z.boolean() }))
	.handler(({ data, context }) =>
		call(async () => {
			await resolveComment({
				organizationId: context.organizationId,
				id: data.id,
				userId: context.userId,
				resolved: data.resolved,
			});
			return { ok: true };
		}),
	);

export const deleteCommentFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteComment({
				organizationId: context.organizationId,
				id: data.id,
				userId: context.userId,
			});
			return { ok: true };
		}),
	);

// ── Reviews ─────────────────────────────────────────────────────────────────────────────

const ownBroadcast = async (organizationId: string, id: string) =>
	getBroadcast(await brandsOf(organizationId), id);

export const requestReviewFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string(), note: z.string().max(2000).optional() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			await requestReview({
				organizationId: context.organizationId,
				brand: x.organization_id,
				id: x.id,
				userId: context.userId,
				note: data.note,
			});
			return { ok: true };
		}),
	);

export const decideReviewFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:approve")])
	.validator(
		z.object({ id: z.string(), approve: z.boolean(), note: z.string().max(2000).optional() }),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			await decideReview({
				organizationId: context.organizationId,
				brand: x.organization_id,
				id: x.id,
				userId: context.userId,
				access: context.access,
				approve: data.approve,
				note: data.note,
			});
			return { ok: true };
		}),
	);

export const withdrawReviewFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			await withdrawReview({
				organizationId: context.organizationId,
				brand: x.organization_id,
				id: x.id,
				userId: context.userId,
			});
			return { ok: true };
		}),
	);

// ── Versions ────────────────────────────────────────────────────────────────────────────

export const versionsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(subject)
	.handler(({ data, context }) =>
		call(async () => {
			await own(context.organizationId, data.type, data.id);
			return listVersions(context.organizationId, data.type, data.id);
		}),
	);

/** Puts an earlier version's content back (the current one stays in the history). */
export const restoreVersionFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ version: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const v = await getVersion(context.organizationId, data.version);
			const type = v.subject_type as CommentSubject;
			if (!context.access.can(EDIT[type]))
				throw new Response("You can't edit this", { status: 403 });
			const s = v.snapshot;
			const x = await own(context.organizationId, type, v.subject_id);
			// What it says now is kept first, so restoring can be undone.
			await recordVersion({
				organizationId: context.organizationId,
				type,
				id: v.subject_id,
				userId: context.userId,
				snapshot: snapshotOf(x as never),
				now: Date.now() - 1,
			});
			if (type === "broadcast") {
				const b = x as Awaited<ReturnType<typeof getBroadcast>>;
				await updateBroadcast(
					context.organizationId,
					b.organization_id,
					b.id,
					{
						subject: s.subject,
						preview_text: s.preview_text,
						...(s.design ? { design: s.design } : { html: s.html, design: null }),
						text: s.text,
					},
					Date.now(),
					context.userId,
				);
			} else {
				await updateTemplate(context.organizationId, v.subject_id, {
					subject: s.subject || null,
					...(s.design ? { design: s.design } : { html: s.html, design: null }),
					text: s.text,
				});
			}
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: `${type}.restored`,
				subject: { type, id: v.subject_id, name: x.name },
				detail: { version: v.created_at },
			});
			return { ok: true };
		}),
	);

// ── Saved sections ──────────────────────────────────────────────────────────────────────

export const sectionsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) => listSections(context.organizationId));

export const saveSectionFn = createServerFn({ method: "POST" })
	.middleware([can("library:edit")])
	.validator(
		z.object({
			id: z.string().optional(),
			name: z.string().max(80),
			blocks: z.array(z.unknown()),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			if (data.id && !data.blocks.length) {
				await renameSection(context.organizationId, data.id, data.name);
				return { id: data.id };
			}
			const row = await saveSection({
				organizationId: context.organizationId,
				userId: context.userId,
				id: data.id,
				name: data.name,
				blocks: data.blocks,
			});
			return { id: row.id };
		}),
	);

export const deleteSectionFn = createServerFn({ method: "POST" })
	.middleware([can("library:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteSection(context.organizationId, data.id);
			return { ok: true };
		}),
	);

// ── Brand kits ──────────────────────────────────────────────────────────────────────────

export const kitFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => getKit(await brandIn(context.organizationId, data.brand))),
	);

export const saveKitFn = createServerFn({ method: "POST" })
	.middleware([can("library:edit")])
	.validator(z.object({ brand: z.string(), kit: z.record(z.string(), z.unknown()) }))
	.handler(({ data, context }) =>
		call(async () =>
			saveKit(await brandIn(context.organizationId, data.brand), data.kit, context.userId),
		),
	);

export const removeKitFn = createServerFn({ method: "POST" })
	.middleware([can("library:edit")])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await removeKit(await brandIn(context.organizationId, data.brand));
			return { ok: true };
		}),
	);
