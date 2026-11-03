import { createAccessControl } from "better-auth/plugins/access";
import {
	adminAc,
	defaultStatements,
	memberAc,
	ownerAc,
} from "better-auth/plugins/organization/access";
import { STARTER_ROLES } from "./permissions";

/**
 * Better Auth's own roles, for its organization plugin (accepting invitations, listing members).
 * What a member may do in Mailroom is src/lib/permissions.ts: the team is managed through
 * Mailroom's server functions, which check it. Organizations' own roles read as "member" here.
 */
export const ac = createAccessControl(defaultStatements);

export const roles = {
	owner: ac.newRole(ownerAc.statements),
	admin: ac.newRole(adminAc.statements),
	member: ac.newRole(memberAc.statements),
	...Object.fromEntries(
		STARTER_ROLES.filter((r) => !["admin", "member"].includes(r.slug)).map((r) => [
			r.slug,
			ac.newRole(memberAc.statements),
		]),
	),
};

export type Role = string;

/** A starter role's name (an organization's own roles come with their names). */
export const ROLE_LABEL: Record<string, string> = Object.fromEntries([
	["owner", "Owner"],
	...STARTER_ROLES.map((r) => [r.slug, r.name]),
]);

export { maskDigits } from "./permissions";
