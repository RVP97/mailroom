import { and, eq } from "drizzle-orm";
import {
	Access,
	NO_ACCESS,
	OWNER_ROLE,
	PERMISSION_LABEL,
	type Permission,
	parsePermissions,
	roleDefinition,
} from "../lib/permissions";
import { db, schema } from "./db";

/*
 * A member's access in an organization (src/lib/permissions.ts), read from D1 with the
 * membership on every call (middleware.ts) and by the assistant's tools.
 */

export const accessColumns = {
	role: schema.member.role,
	extraPermissions: schema.member.extraPermissions,
	revokedPermissions: schema.member.revokedPermissions,
	rolePermission: schema.organizationRole.permission,
	roleAll: schema.organizationRole.allPermissions,
} as const;

export interface AccessRow {
	role: string;
	extraPermissions: string | null;
	revokedPermissions: string | null;
	rolePermission: string | null;
	roleAll: boolean | null;
}

/** The join that brings a member's role row (an organization's own or edited role) along. */
export const roleJoin = and(
	eq(schema.organizationRole.organizationId, schema.member.organizationId),
	eq(schema.organizationRole.role, schema.member.role),
);

export function accessFromRow(row: AccessRow): Access {
	const stored =
		row.rolePermission != null
			? { all: !!row.roleAll, permissions: parsePermissions(row.rolePermission) }
			: null;
	return new Access({
		role: row.role,
		definition: roleDefinition(row.role, stored),
		add: parsePermissions(row.extraPermissions),
		remove: parsePermissions(row.revokedPermissions),
	});
}

/** A member's access (NO_ACCESS: not a member). */
export async function memberAccess(organizationId: string, userId: string): Promise<Access> {
	const row = await db
		.select(accessColumns)
		.from(schema.member)
		.leftJoin(schema.organizationRole, roleJoin)
		.where(
			and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)),
		)
		.get();
	return row ? accessFromRow(row) : NO_ACCESS;
}

/** The members of an organization who have `permission` (to tell approvers, say). */
export async function membersWith(organizationId: string, permission: Permission) {
	const rows = await db
		.select({
			userId: schema.member.userId,
			email: schema.user.email,
			name: schema.user.name,
			...accessColumns,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.leftJoin(schema.organizationRole, roleJoin)
		.where(eq(schema.member.organizationId, organizationId));
	return rows
		.filter((r) => accessFromRow(r).can(permission))
		.map((r) => ({ userId: r.userId, email: r.email, name: r.name }));
}

export class AccessError extends Error {}

/** Refuses when `actor` lacks something `target` would have (handing out more than one has). */
export function assertCovers(actor: Access, target: Access, doing: string) {
	if (actor.owner) return;
	if (target.owner) throw new AccessError("Only an owner can make someone an owner.");
	if (target.all && !(actor.all && actor.removed.size === 0))
		throw new AccessError(
			`To ${doing} with every permission, including future ones, you need them yourself.`,
		);
	const missing = [...target.granted].filter((p) => !actor.can(p));
	if (missing.length)
		throw new AccessError(
			`That would give permissions you don't have (${missing
				.slice(0, 3)
				.map((p) => PERMISSION_LABEL[p].toLowerCase())
				.join(", ")}${missing.length > 3 ? "…" : ""}). Ask an owner.`,
		);
}

export const isOwnerRole = (role: string) => role === OWNER_ROLE;
