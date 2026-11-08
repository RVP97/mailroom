/*
 * What a member of an organization may do. Shared by the server (middleware.ts checks it on every
 * server function, and the assistant's tools) and the browser (which hides what the member can't
 * use), so it imports nothing from the server.
 *
 * A member's access is their role (Owner is fixed and has everything; every other role, the
 * starter ones included, is editable per organization and kept in `organization_role`), plus
 * permissions added to them alone, minus permissions taken away from them alone. A role can have
 * "every permission, including future ones": one added to this catalog later is theirs at once.
 * Everyone in an organization can look at everything in it; permissions are about changing things.
 */

/** Every resource and its actions. Ids are stored: never rename one. */
export const STATEMENTS = {
	broadcasts: ["edit", "send", "approve"],
	newsletters: ["edit"],
	templates: ["edit"],
	library: ["edit"],
	contacts: ["edit", "import", "delete"],
	forms: ["edit"],
	automations: ["edit", "activate"],
	inbox: ["reply", "rules", "agents"],
	help: ["edit"],
	surveys: ["edit"],
	emails: ["unmasked"],
	recipients: ["unblock", "block"],
	brands: ["edit"],
	domains: ["manage"],
	developers: ["keys", "webhooks"],
	settings: ["manage"],
	team: ["invite", "manage", "roles"],
	activity: ["view"],
} as const;

export type Resource = keyof typeof STATEMENTS;
/** "broadcasts:send", "team:roles"… */
export type Permission = { [R in Resource]: `${R}:${(typeof STATEMENTS)[R][number]}` }[Resource];

export const ALL_PERMISSIONS: Permission[] = (
	Object.entries(STATEMENTS) as [Resource, readonly string[]][]
).flatMap(([r, actions]) => actions.map((a) => `${r}:${a}` as Permission));

const KNOWN = new Set<string>(ALL_PERMISSIONS);
export const isPermission = (p: unknown): p is Permission => typeof p === "string" && KNOWN.has(p);

/** What a permission needs to make sense: granting it grants these too. */
export const REQUIRES: Partial<Record<Permission, Permission[]>> = {
	"broadcasts:send": ["broadcasts:edit"],
	"broadcasts:approve": ["broadcasts:edit"],
	"newsletters:edit": ["broadcasts:edit"],
	"contacts:import": ["contacts:edit"],
	"contacts:delete": ["contacts:edit"],
	"automations:activate": ["automations:edit"],
	"inbox:rules": ["inbox:reply"],
	"inbox:agents": ["inbox:reply"],
	"team:manage": ["team:invite"],
	"team:roles": ["team:manage"],
};

/** Permissions that hand out access or credentials. */
export const SENSITIVE: ReadonlySet<Permission> = new Set<Permission>([
	"team:invite",
	"team:manage",
	"team:roles",
	"developers:keys",
	"domains:manage",
	"inbox:agents",
]);

// ── The catalog as people read it (Settings › Roles, a member's access) ─────────────────

export interface CatalogAction {
	id: Permission;
	label: string;
	hint?: string;
}
export interface CatalogGroup {
	id: string;
	title: string;
	actions: CatalogAction[];
}

export const CATALOG: CatalogGroup[] = [
	{
		id: "write",
		title: "Emails people get",
		actions: [
			{
				id: "broadcasts:edit",
				label: "Write and edit broadcasts and campaigns",
				hint: "Drafts, test emails, comments, asking for review",
			},
			{
				id: "broadcasts:send",
				label: "Send and schedule",
				hint: "When approval is required, only once it's approved",
			},
			{
				id: "broadcasts:approve",
				label: "Approve what others ask to send",
				hint: "Never their own",
			},
			{
				id: "newsletters:edit",
				label: "Set up newsletters",
				hint: "Public page, RSS, referrals",
			},
			{ id: "templates:edit", label: "Edit templates" },
			{
				id: "library:edit",
				label: "Edit saved sections and the brand kit",
				hint: "What everyone builds emails with",
			},
			{ id: "automations:edit", label: "Build automations" },
			{ id: "automations:activate", label: "Turn automations on and off" },
		],
	},
	{
		id: "audience",
		title: "Audience",
		actions: [
			{
				id: "contacts:edit",
				label: "Edit contacts, segments and topics",
			},
			{ id: "contacts:import", label: "Import contacts" },
			{ id: "contacts:delete", label: "Delete contacts", hint: "And clean up the list" },
			{ id: "forms:edit", label: "Edit sign-up forms" },
			{ id: "surveys:edit", label: "Edit surveys", hint: "NPS, satisfaction and questions" },
		],
	},
	{
		id: "inbox",
		title: "Inbox and recipients",
		actions: [
			{ id: "inbox:reply", label: "Reply to received email" },
			{ id: "inbox:rules", label: "Edit inbound rules" },
			{ id: "help:edit", label: "Write help center articles", hint: "And publish them" },
			{
				id: "inbox:agents",
				label: "Set up agent inboxes",
				hint: "Inboxes, their credentials and webhooks",
			},
			{
				id: "emails:unmasked",
				label: "See codes and card numbers in emails",
				hint: "Without it, runs of 4+ digits show as dots",
			},
			{
				id: "recipients:unblock",
				label: "Let a recipient get email again",
				hint: "Remove a suppression or an unsubscribe",
			},
			{
				id: "recipients:block",
				label: "Block recipients",
				hint: "Suppressions and firewall",
			},
		],
	},
	{
		id: "setup",
		title: "Setup",
		actions: [
			{ id: "brands:edit", label: "Add and edit brands" },
			{
				id: "domains:manage",
				label: "Domains and sending setup",
				hint: "DNS, tracking, receiving, BIMI",
			},
			{ id: "developers:keys", label: "API keys and SMTP" },
			{ id: "developers:webhooks", label: "Webhooks" },
			{
				id: "settings:manage",
				label: "Organization settings",
				hint: "Name, logo, limits, digest, archive, approval rules",
			},
		],
	},
	{
		id: "team",
		title: "Team",
		actions: [
			{ id: "team:invite", label: "Invite people" },
			{ id: "team:manage", label: "Change people's access and remove them" },
			{ id: "team:roles", label: "Create and edit roles" },
			{ id: "activity:view", label: "See the activity log", hint: "Who changed what" },
		],
	},
];

export const PERMISSION_LABEL = Object.fromEntries(
	CATALOG.flatMap((g) => g.actions.map((a) => [a.id, a.label])),
) as Record<Permission, string>;

// ── Roles ───────────────────────────────────────────────────────────────────────────────

export const OWNER_ROLE = "owner";

export interface RoleDefinition {
	/** Stored in member.role / invitation.role. */
	slug: string;
	name: string;
	description: string;
	/** Every permission, including future ones. */
	all: boolean;
	permissions: Permission[];
	/** One of STARTER_ROLES: it can be edited and reset, not deleted. */
	starter: boolean;
}

/**
 * The roles every organization starts with, editable there. admin, support and member keep the
 * slugs of the fixed roles Mailroom had before, so those people keep their access.
 */
export const STARTER_ROLES: RoleDefinition[] = [
	{
		slug: "admin",
		name: "Admin",
		description: "Everything, including future permissions. Can't change owners.",
		all: true,
		permissions: [],
		starter: true,
	},
	{
		slug: "marketer",
		name: "Marketer",
		description: "Writes, sends and approves email; runs the audience, forms and automations.",
		all: false,
		permissions: [
			"broadcasts:edit",
			"broadcasts:send",
			"broadcasts:approve",
			"newsletters:edit",
			"templates:edit",
			"library:edit",
			"automations:edit",
			"automations:activate",
			"contacts:edit",
			"contacts:import",
			"forms:edit",
			"help:edit",
			"surveys:edit",
			"activity:view",
		],
		starter: true,
	},
	{
		slug: "writer",
		name: "Writer",
		description: "Writes and designs email, then asks for review; doesn't send.",
		all: false,
		permissions: ["broadcasts:edit", "templates:edit", "help:edit"],
		starter: true,
	},
	{
		slug: "support",
		name: "Support",
		description: "Replies to received email and lets a recipient get email again.",
		all: false,
		permissions: ["inbox:reply", "recipients:unblock", "help:edit", "surveys:edit"],
		starter: true,
	},
	{
		slug: "member",
		name: "Viewer",
		description: "Looks at everything; changes nothing.",
		all: false,
		permissions: [],
		starter: true,
	},
];

export const OWNER_DEFINITION: RoleDefinition = {
	slug: OWNER_ROLE,
	name: "Owner",
	description: "Everything, always. Only an owner makes or removes owners.",
	all: true,
	permissions: [],
	starter: true,
};

// ── Resolving a member's access ─────────────────────────────────────────────────────────

/** `list` plus everything it requires, transitively. */
export function withRequirements(list: Iterable<Permission>): Set<Permission> {
	const out = new Set<Permission>();
	const visit = (p: Permission) => {
		if (out.has(p)) return;
		out.add(p);
		for (const r of REQUIRES[p] ?? []) visit(r);
	};
	for (const p of list) visit(p);
	return out;
}

/** True when `p`, or anything it requires, is in `removed`. */
export function blockedBy(p: Permission, removed: ReadonlySet<Permission>): boolean {
	if (removed.has(p)) return true;
	return (REQUIRES[p] ?? []).some((r) => blockedBy(r, removed));
}

export interface AccessInput {
	role: string;
	/** The role's definition (null: an unknown role, which gives nothing). */
	definition: Pick<RoleDefinition, "all" | "permissions"> | null;
	add?: Permission[];
	remove?: Permission[];
}

/** What the browser gets: every permission resolved. */
export interface AccessSummary {
	owner: boolean;
	all: boolean;
	permissions: Permission[];
}

export class Access {
	readonly owner: boolean;
	readonly all: boolean;
	readonly removed: ReadonlySet<Permission>;
	readonly granted: ReadonlySet<Permission>;

	constructor(input: AccessInput) {
		this.owner = input.role === OWNER_ROLE;
		this.all = this.owner || !!input.definition?.all;
		this.removed = new Set(this.owner ? [] : (input.remove ?? []).filter(isPermission));
		const base = this.all
			? ALL_PERMISSIONS
			: withRequirements([
					...(input.definition?.permissions ?? []),
					...(input.add ?? []).filter(isPermission),
				]);
		this.granted = new Set([...base].filter((p) => !blockedBy(p, this.removed)));
	}

	can(p: Permission): boolean {
		return this.granted.has(p);
	}

	summary(): AccessSummary {
		return {
			owner: this.owner,
			all: this.all && this.removed.size === 0,
			permissions: ALL_PERMISSIONS.filter((p) => this.granted.has(p)),
		};
	}
}

/** Everything (the app itself acting: cron, the API with a key, tests). */
export const FULL_ACCESS = new Access({ role: OWNER_ROLE, definition: null });
export const NO_ACCESS = new Access({ role: "", definition: null });

/** A role's definition: the organization's own row, else the starter role with that slug. */
export function roleDefinition(
	slug: string,
	stored: { all: boolean; permissions: Permission[] } | null | undefined,
): Pick<RoleDefinition, "all" | "permissions"> | null {
	if (slug === OWNER_ROLE) return OWNER_DEFINITION;
	if (stored) return stored;
	const starter = STARTER_ROLES.find((r) => r.slug === slug);
	return starter ? { all: starter.all, permissions: starter.permissions } : null;
}

/** A stored JSON list of permission ids, unknown ones dropped. */
export function parsePermissions(json: string | null | undefined): Permission[] {
	if (!json) return [];
	try {
		const v = JSON.parse(json);
		return Array.isArray(v) ? v.filter(isPermission) : [];
	} catch {
		return [];
	}
}

/** In the browser: whether the signed-in member may do `p` in the organization in use. */
export const allows = (access: AccessSummary | null | undefined, p: Permission): boolean =>
	!!access && (access.owner || access.permissions.includes(p));

export const NO_PERMISSION_MESSAGE = "You don't have permission for this in this organization";

/** Runs of 4 or more digits (codes, card and phone numbers) as dots. */
export const maskDigits = (s: string) => s.replace(/\d{4,}/g, (m) => "•".repeat(m.length));

/** An email's headers with digits dotted (Subject repeats the subject; others may hold codes). */
export const maskHeaders = <T extends Record<string, unknown> | null | undefined>(h: T): T =>
	(h
		? Object.fromEntries(
				Object.entries(h).map(([k, v]) => [k, typeof v === "string" ? maskDigits(v) : v]),
			)
		: h) as T;

/** A search term for someone who sees digits dotted: runs of 4+ digits can't be searched for
 * (hit or miss would tell the hidden digits one by one). */
export const maskedSearch = (q: string) =>
	q
		.replace(/\d{4,}/g, "")
		.replace(/\s+/g, " ")
		.trim();
