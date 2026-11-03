import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { type Access, parsePermissions } from "@/lib/permissions";
import { AccessError } from "@/server/access";
import { listActivity, logActivity } from "@/server/activity";
import { db, schema } from "@/server/db";
import { can, orgMiddleware } from "@/server/middleware";
import { approvalRequired, setApprovalRequired } from "@/server/reviews";
import {
	cancelInvitation,
	changeMember,
	deleteRole,
	inviteMember,
	listRoles,
	removeMember,
	resetRole,
	saveRole,
} from "@/server/roles";
import { call } from "./call";

/** Settings › Members and Roles: who's in, with what access, and the roles to give. */

export const teamFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const id = context.organizationId;
		const [members, invitations, roles, needsApproval] = await Promise.all([
			db
				.select({
					id: schema.member.id,
					userId: schema.member.userId,
					role: schema.member.role,
					extra: schema.member.extraPermissions,
					revoked: schema.member.revokedPermissions,
					createdAt: schema.member.createdAt,
					name: schema.user.name,
					email: schema.user.email,
				})
				.from(schema.member)
				.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
				.where(eq(schema.member.organizationId, id))
				.orderBy(asc(schema.member.createdAt)),
			db
				.select({
					id: schema.invitation.id,
					email: schema.invitation.email,
					role: schema.invitation.role,
					expiresAt: schema.invitation.expiresAt,
				})
				.from(schema.invitation)
				.where(
					and(eq(schema.invitation.organizationId, id), eq(schema.invitation.status, "pending")),
				)
				.orderBy(asc(schema.invitation.createdAt)),
			listRoles(id),
			approvalRequired(id),
		]);
		const now = Date.now();
		return {
			members: members.map((m) => ({
				id: m.id,
				userId: m.userId,
				role: m.role,
				add: parsePermissions(m.extra),
				remove: parsePermissions(m.revoked),
				name: m.name,
				email: m.email,
				joined: m.createdAt.toISOString(),
			})),
			invitations: invitations
				.filter((i) => i.expiresAt.getTime() > now)
				.map((i) => ({
					id: i.id,
					email: i.email,
					role: i.role ?? "member",
					expiresAt: i.expiresAt.toISOString(),
				})),
			roles,
			needs_approval: needsApproval,
		};
	});

const actor = (context: { organizationId: string; access: Access; userId: string }) => ({
	organizationId: context.organizationId,
	actor: context.access,
	actorId: context.userId,
});

/** AccessError as the message the page shows. */
async function team<T>(fn: () => Promise<T>) {
	try {
		return await call(fn);
	} catch (error) {
		if (error instanceof AccessError) throw new Response(error.message, { status: 403 });
		throw error;
	}
}

export const saveRoleFn = createServerFn({ method: "POST" })
	.middleware([can("team:roles")])
	.validator(
		z.object({
			slug: z.string().optional(),
			name: z.string().max(60),
			description: z.string().max(200).nullish(),
			all: z.boolean(),
			permissions: z.array(z.string()).max(100),
		}),
	)
	.handler(({ data, context }) =>
		team(async () => ({
			slug: await saveRole({ ...actor(context), ...data }),
		})),
	);

export const deleteRoleFn = createServerFn({ method: "POST" })
	.middleware([can("team:roles")])
	.validator(z.object({ slug: z.string() }))
	.handler(({ data, context }) =>
		team(async () => {
			await deleteRole({ ...actor(context), slug: data.slug });
			return { ok: true };
		}),
	);

export const resetRoleFn = createServerFn({ method: "POST" })
	.middleware([can("team:roles")])
	.validator(z.object({ slug: z.string() }))
	.handler(({ data, context }) =>
		team(async () => {
			await resetRole({ ...actor(context), slug: data.slug });
			return { ok: true };
		}),
	);

export const inviteFn = createServerFn({ method: "POST" })
	.middleware([can("team:invite")])
	.validator(z.object({ email: z.string().max(320), role: z.string().max(40) }))
	.handler(({ data, context }) =>
		team(async () => ({ id: await inviteMember({ ...actor(context), ...data }) })),
	);

export const cancelInvitationFn = createServerFn({ method: "POST" })
	.middleware([can("team:invite")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		team(async () => {
			await cancelInvitation({ ...actor(context), id: data.id });
			return { ok: true };
		}),
	);

export const changeMemberFn = createServerFn({ method: "POST" })
	.middleware([can("team:manage")])
	.validator(
		z.object({
			member: z.string(),
			role: z.string().max(40),
			add: z.array(z.string()).max(100).default([]),
			remove: z.array(z.string()).max(100).default([]),
		}),
	)
	.handler(({ data, context }) =>
		team(async () => {
			await changeMember({
				...actor(context),
				memberId: data.member,
				role: data.role,
				add: data.add,
				remove: data.remove,
			});
			return { ok: true };
		}),
	);

/** Removes someone (anyone may leave; removing others needs "Change people's access"). */
export const removeMemberFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ member: z.string() }))
	.handler(({ data, context }) =>
		team(async () => {
			await removeMember({ ...actor(context), memberId: data.member });
			return { ok: true };
		}),
	);

export const renameOrganizationFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ name: z.string().trim().min(1).max(80) }))
	.handler(async ({ data, context }) => {
		await db
			.update(schema.organization)
			.set({ name: data.name })
			.where(eq(schema.organization.id, context.organizationId));
		await logActivity({
			organizationId: context.organizationId,
			userId: context.userId,
			action: "settings.renamed",
			subject: { type: "organization", id: context.organizationId, name: data.name },
		});
		return { ok: true };
	});

export const setApprovalFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ on: z.boolean() }))
	.handler(async ({ data, context }) => {
		await setApprovalRequired(context.organizationId, data.on);
		await logActivity({
			organizationId: context.organizationId,
			userId: context.userId,
			action: data.on ? "settings.approval_required" : "settings.approval_not_required",
			subject: { type: "organization", id: context.organizationId },
		});
		return { ok: true };
	});

/** Settings › Activity, or one broadcast's or template's history. */
export const activityFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			type: z.string().max(40).optional(),
			id: z.string().max(80).optional(),
			before: z.string().max(40).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			// The whole log is for those who may see it; one thing's history is for everyone.
			if (!data.id && !context.access.can("activity:view"))
				throw new Response("You can't see this organization's activity", { status: 403 });
			return listActivity(context.organizationId, {
				subject: data.type ? { type: data.type, id: data.id } : undefined,
				before: data.before,
				limit: 100,
			});
		}),
	);
