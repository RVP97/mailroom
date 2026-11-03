import { waitUntil } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import {
	Access,
	isPermission,
	OWNER_DEFINITION,
	OWNER_ROLE,
	type Permission,
	parsePermissions,
	type RoleDefinition,
	roleDefinition,
	STARTER_ROLES,
	withRequirements,
} from "../lib/permissions";
import { AccessError, assertCovers, memberAccess } from "./access";
import { logActivity } from "./activity";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { sendSystemEmail, systemLayout } from "./system-email";

/*
 * An organization's roles (Settings › Roles) and its team: Owner (fixed), the starter roles
 * (editable; an edited one is a row of organization_role, "Reset" deletes it) and the
 * organization's own roles. Nobody hands out more than they have themselves.
 */

const R = schema.organizationRole;

export interface OrgRole extends RoleDefinition {
	/** A starter role edited in this organization (it can be reset). */
	edited: boolean;
	members: number;
	invitations: number;
}

/** A role's permissions as the organization defines it (null: no such role). */
export async function roleDefinitionFor(organizationId: string, slug: string) {
	if (slug === OWNER_ROLE) return OWNER_DEFINITION;
	const row = await db
		.select({ permission: R.permission, all: R.allPermissions })
		.from(R)
		.where(and(eq(R.organizationId, organizationId), eq(R.role, slug)))
		.get();
	return roleDefinition(
		slug,
		row ? { all: !!row.all, permissions: parsePermissions(row.permission) } : null,
	);
}

/** Every role of the organization: Owner, the starter ones (as edited here), then its own. */
export async function listRoles(organizationId: string): Promise<OrgRole[]> {
	const [rows, members, invitations] = await Promise.all([
		db.select().from(R).where(eq(R.organizationId, organizationId)).orderBy(R.createdAt),
		db
			.select({ role: schema.member.role, n: sql<number>`count(*)` })
			.from(schema.member)
			.where(eq(schema.member.organizationId, organizationId))
			.groupBy(schema.member.role),
		db
			.select({ role: schema.invitation.role, n: sql<number>`count(*)` })
			.from(schema.invitation)
			.where(
				and(
					eq(schema.invitation.organizationId, organizationId),
					eq(schema.invitation.status, "pending"),
				),
			)
			.groupBy(schema.invitation.role),
	]);
	const count = (list: { role: string | null; n: number }[], slug: string) =>
		list.find((x) => (x.role ?? "member") === slug)?.n ?? 0;
	const stored = new Map(rows.map((r) => [r.role, r]));
	const fromRow = (r: (typeof rows)[number], starter: boolean): RoleDefinition => ({
		slug: r.role,
		name: r.name,
		description: r.description ?? "",
		all: !!r.allPermissions,
		permissions: parsePermissions(r.permission),
		starter,
	});
	const out: OrgRole[] = [
		{ ...OWNER_DEFINITION, edited: false, members: 0, invitations: 0 },
		...STARTER_ROLES.map((s) => {
			const row = stored.get(s.slug);
			return { ...(row ? fromRow(row, true) : s), edited: !!row, members: 0, invitations: 0 };
		}),
		...rows
			.filter((r) => !STARTER_ROLES.some((s) => s.slug === r.role) && r.role !== OWNER_ROLE)
			.map((r) => ({ ...fromRow(r, false), edited: false, members: 0, invitations: 0 })),
	];
	for (const r of out) {
		r.members = count(members, r.slug);
		r.invitations = count(invitations, r.slug);
	}
	return out;
}

/** A role's name as people read it. */
export async function roleName(organizationId: string, slug: string) {
	if (slug === OWNER_ROLE) return OWNER_DEFINITION.name;
	const row = await db
		.select({ name: R.name })
		.from(R)
		.where(and(eq(R.organizationId, organizationId), eq(R.role, slug)))
		.get();
	return row?.name ?? STARTER_ROLES.find((r) => r.slug === slug)?.name ?? slug;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const roleAccess = (d: Pick<RoleDefinition, "all" | "permissions">, slug = "role") =>
	new Access({ role: slug, definition: d });

/** Creates (no slug) or edits a role. */
export async function saveRole(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	slug?: string;
	name: string;
	description?: string | null;
	all: boolean;
	permissions: string[];
}): Promise<string> {
	const name = o.name.trim();
	if (name.length < 2) throw new AccessError("Give the role a name.");
	if (o.slug === OWNER_ROLE) throw new AccessError("The owner role can't be changed.");
	const permissions = [...withRequirements(o.permissions.filter(isPermission))].sort();
	const next = { all: o.all, permissions };
	assertCovers(o.actor, roleAccess(next), "make a role");
	const roles = await listRoles(o.organizationId);
	const current = o.slug ? roles.find((r) => r.slug === o.slug) : undefined;
	if (o.slug && !current) throw new AccessError("That role no longer exists.");
	if (roles.some((r) => r.slug !== o.slug && norm(r.name) === norm(name)))
		throw new AccessError(`There's already a role called "${name}".`);
	if (current) assertCovers(o.actor, roleAccess(current), "edit a role");
	const slug = o.slug ?? `r_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
	const values = {
		name,
		description: o.description?.trim() || null,
		allPermissions: o.all,
		permission: JSON.stringify(o.all ? [] : permissions),
		updatedAt: new Date(),
	};
	await db
		.insert(R)
		.values({
			id: crypto.randomUUID(),
			organizationId: o.organizationId,
			role: slug,
			createdAt: new Date(),
			...values,
		})
		.onConflictDoUpdate({ target: [R.organizationId, R.role], set: values });
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: current ? "role.updated" : "role.created",
		subject: { type: "role", id: slug, name },
	});
	return slug;
}

/** Deletes one of the organization's own roles, once nobody has it. */
export async function deleteRole(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	slug: string;
}) {
	const roles = await listRoles(o.organizationId);
	const role = roles.find((r) => r.slug === o.slug);
	if (!role) return;
	if (role.starter)
		throw new AccessError("Starter roles aren't deleted: edit or reset them instead.");
	assertCovers(o.actor, roleAccess(role), "delete a role");
	if (role.members || role.invitations)
		throw new AccessError(
			`${role.members + role.invitations} ${role.members + role.invitations === 1 ? "person has" : "people have"} "${role.name}": give them another role first.`,
		);
	await db.delete(R).where(and(eq(R.organizationId, o.organizationId), eq(R.role, o.slug)));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "role.deleted",
		subject: { type: "role", id: o.slug, name: role.name },
	});
}

/** "Reset": a starter role goes back to how Mailroom defines it. */
export async function resetRole(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	slug: string;
}) {
	const starter = STARTER_ROLES.find((r) => r.slug === o.slug);
	if (!starter) throw new AccessError("Only starter roles can be reset.");
	const roles = await listRoles(o.organizationId);
	const current = roles.find((r) => r.slug === o.slug);
	if (current) assertCovers(o.actor, roleAccess(current), "reset a role");
	assertCovers(o.actor, roleAccess(starter), "reset a role");
	await db.delete(R).where(and(eq(R.organizationId, o.organizationId), eq(R.role, o.slug)));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "role.reset",
		subject: { type: "role", id: o.slug, name: starter.name },
	});
}

// ── The team ────────────────────────────────────────────────────────────────────────────

const INVITE_DAYS = 7;

const background = (p: Promise<unknown>) => {
	const caught = p.catch((error) => console.error("team: email not sent", error));
	try {
		waitUntil(caught);
	} catch {
		return caught;
	}
};

/** The access a role plus a member's own changes would give. */
async function accessOf(
	organizationId: string,
	role: string,
	add: Permission[] = [],
	remove: Permission[] = [],
) {
	const definition = await roleDefinitionFor(organizationId, role);
	if (!definition) throw new AccessError("That role no longer exists.");
	return new Access({ role, definition, add, remove });
}

export async function inviteMember(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	email: string;
	role: string;
}) {
	if (!o.actor.can("team:invite")) throw new AccessError("You can't invite people here.");
	if (o.role === OWNER_ROLE)
		throw new AccessError("Invite them as an admin, then make them an owner.");
	assertCovers(o.actor, await accessOf(o.organizationId, o.role), "invite someone");
	const email = o.email.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		throw new AccessError("That isn't an email address.");
	const existing = await db
		.select({ id: schema.member.id })
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(
			and(eq(schema.member.organizationId, o.organizationId), eq(schema.user.email, email)),
		)
		.get();
	if (existing) throw new AccessError("They're already in this organization.");
	// One live invitation per email: inviting again replaces it.
	await db
		.update(schema.invitation)
		.set({ status: "canceled" })
		.where(
			and(
				eq(schema.invitation.organizationId, o.organizationId),
				eq(schema.invitation.email, email),
				eq(schema.invitation.status, "pending"),
			),
		);
	const id = crypto.randomUUID();
	await db.insert(schema.invitation).values({
		id,
		organizationId: o.organizationId,
		email,
		role: o.role,
		status: "pending",
		expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
		inviterId: o.actorId,
	});
	const [org, inviter] = await Promise.all([
		db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, o.organizationId))
			.get(),
		db
			.select({ name: schema.user.name, email: schema.user.email })
			.from(schema.user)
			.where(eq(schema.user.id, o.actorId))
			.get(),
	]);
	const orgName = org?.name ?? "an organization";
	const url = baseUrl() || "http://localhost:3000";
	const { html, text } = systemLayout({
		title: `Join ${orgName} on Mailroom`,
		lines: [
			`${inviter?.name || inviter?.email || "Someone"} invited you to ${orgName} as ${STARTER_ROLES.some((r) => r.slug === o.role) ? (await roleName(o.organizationId, o.role)).toLowerCase() : await roleName(o.organizationId, o.role)}.`,
			"Sign in with this email address to accept.",
		],
		button: { label: "Accept invitation", url: `${url}/login?invitation=${id}` },
	});
	await background(
		sendSystemEmail({ to: email, subject: `Join ${orgName} on Mailroom`, html, text }),
	);
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "member.invited",
		subject: { type: "member", id, name: email },
		detail: { role: o.role },
	});
	return id;
}

export async function cancelInvitation(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	id: string;
}) {
	if (!o.actor.can("team:invite")) throw new AccessError("You can't change invitations here.");
	const row = await db
		.select({ email: schema.invitation.email })
		.from(schema.invitation)
		.where(
			and(
				eq(schema.invitation.id, o.id),
				eq(schema.invitation.organizationId, o.organizationId),
			),
		)
		.get();
	if (!row) return;
	await db
		.update(schema.invitation)
		.set({ status: "canceled" })
		.where(eq(schema.invitation.id, o.id));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "member.invitation_canceled",
		subject: { type: "member", id: o.id, name: row.email },
	});
}

async function memberRow(organizationId: string, memberId: string) {
	const row = await db
		.select({
			id: schema.member.id,
			userId: schema.member.userId,
			role: schema.member.role,
			email: schema.user.email,
			extra: schema.member.extraPermissions,
			revoked: schema.member.revokedPermissions,
		})
		.from(schema.member)
		.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
		.where(
			and(eq(schema.member.id, memberId), eq(schema.member.organizationId, organizationId)),
		)
		.get();
	if (!row) throw new AccessError("They're no longer in this organization.");
	return row;
}

async function owners(organizationId: string) {
	const rows = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.member)
		.where(
			and(
				eq(schema.member.organizationId, organizationId),
				eq(schema.member.role, OWNER_ROLE),
			),
		)
		.get();
	return rows?.n ?? 0;
}

/** A member's role, and permissions added to or taken from them alone. */
export async function changeMember(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	memberId: string;
	role: string;
	add: string[];
	remove: string[];
}) {
	if (!o.actor.can("team:manage"))
		throw new AccessError("You can't change people's access here.");
	const m = await memberRow(o.organizationId, o.memberId);
	if (m.userId === o.actorId) throw new AccessError("You can't change your own access.");
	const add = o.add.filter(isPermission);
	const remove = o.remove.filter(isPermission);
	const before = await accessOf(
		o.organizationId,
		m.role,
		parsePermissions(m.extra),
		parsePermissions(m.revoked),
	);
	const after = await accessOf(o.organizationId, o.role, add, remove);
	// Changing an owner, or making one, is an owner's call; and never leaving none.
	if ((m.role === OWNER_ROLE || o.role === OWNER_ROLE) && !o.actor.owner)
		throw new AccessError("Only an owner makes or changes owners.");
	if (m.role === OWNER_ROLE && o.role !== OWNER_ROLE && (await owners(o.organizationId)) < 2)
		throw new AccessError("An organization always keeps one owner.");
	assertCovers(o.actor, before, "change someone");
	assertCovers(o.actor, after, "give someone access");
	await db
		.update(schema.member)
		.set({
			role: o.role,
			extraPermissions: add.length && o.role !== OWNER_ROLE ? JSON.stringify(add) : null,
			revokedPermissions:
				remove.length && o.role !== OWNER_ROLE ? JSON.stringify(remove) : null,
		})
		.where(eq(schema.member.id, m.id));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "member.changed",
		subject: { type: "member", id: m.id, name: m.email },
		detail: { from: m.role, to: o.role, add, remove },
	});
}

export async function removeMember(o: {
	organizationId: string;
	actor: Access;
	actorId: string;
	memberId: string;
}) {
	const m = await memberRow(o.organizationId, o.memberId);
	const self = m.userId === o.actorId;
	if (!self && !o.actor.can("team:manage"))
		throw new AccessError("You can't remove people here.");
	if (m.role === OWNER_ROLE) {
		if (!o.actor.owner) throw new AccessError("Only an owner removes an owner.");
		if ((await owners(o.organizationId)) < 2)
			throw new AccessError("An organization always keeps one owner.");
	}
	if (!self)
		assertCovers(o.actor, await memberAccess(o.organizationId, m.userId), "remove someone");
	await db.delete(schema.member).where(eq(schema.member.id, m.id));
	await logActivity({
		organizationId: o.organizationId,
		userId: o.actorId,
		action: "member.removed",
		subject: { type: "member", id: m.id, name: m.email },
	});
}
