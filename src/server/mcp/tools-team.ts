import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
	ALL_PERMISSIONS,
	CATALOG,
	parsePermissions,
	REQUIRES,
	SENSITIVE,
} from "../../lib/permissions";
import { AccessError } from "../access";
import { listAccessLog } from "../access-log";
import { listActivity } from "../activity";
import { archiveBucket, archiveEnabled, setArchiveEnabled } from "../archive";
import { brandIds, brandIn } from "../brands";
import { getBroadcast, updateBroadcast } from "../broadcasts";
import {
	addComment,
	type CommentSubject,
	deleteComment,
	listComments,
	resolveComment,
} from "../comments";
import { db, schema } from "../db";
import { digestEnabled, sendDigest, setDigestEnabled } from "../digest";
import { bodyRetentionDays, inboundRetentionDays, logRetentionDays } from "../env";
import { ApiError } from "../errors";
import {
	deleteSection,
	getKit,
	listSections,
	removeKit,
	renameSection,
	saveKit,
	saveSection,
} from "../library";
import { marketingRules, setMarketingRules } from "../marketing-rules";
import { uploadMedia } from "../media";
import {
	approvalRequired,
	decideReview,
	requestReview,
	setApprovalRequired,
	withdrawReview,
} from "../reviews";
import {
	cancelInvitation,
	changeMember,
	deleteRole,
	inviteMember,
	listRoles,
	removeMember,
	resetRole,
	saveRole,
} from "../roles";
import { getSendingLimits, organizationActions } from "../sending-limits";
import { getTemplate, updateTemplate } from "../templates";
import { getVersion, listVersions, recordVersion, snapshotOf } from "../versions";
import { forbidden, logged, oneBrand, orgAt, organization, requires, type Tool } from "./kit";
import type { McpContext, Membership } from "./tools";

/** The team, the organization's own settings, and working together on emails. */

/** Team changes refuse with AccessError: the message the person reads. */
async function team<T>(fn: () => Promise<T>) {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof AccessError) throw new ApiError(403, "forbidden", error.message);
		throw error;
	}
}

const actor = (org: Membership, ctx: McpContext) => ({
	organizationId: org.id,
	actor: org.access,
	actorId: ctx.userId,
});

const subjectType = z.enum(["broadcast", "template"]);
const EDIT = { broadcast: "broadcasts:edit", template: "templates:edit" } as const;

/** The broadcast or template is the organization's. */
async function own(org: Membership, type: CommentSubject, id: string) {
	if (type === "broadcast") return getBroadcast(await brandIds(org.id), id);
	return getTemplate(org.id, id);
}

export const TEAM_TOOLS: Tool[] = [
	// ── Team ──
	{
		name: "list_team",
		title: "List the team",
		description:
			"Who is in the organization (members with their role and the permissions added to or taken from them alone), pending invitations, the roles to give (starter and custom, with their permissions), and whether broadcasts need approval before they go.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const [members, invitations, roles, needsApproval] = await Promise.all([
				db
					.select({
						id: schema.member.id,
						user_id: schema.member.userId,
						role: schema.member.role,
						extra: schema.member.extraPermissions,
						revoked: schema.member.revokedPermissions,
						created_at: schema.member.createdAt,
						name: schema.user.name,
						email: schema.user.email,
					})
					.from(schema.member)
					.innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
					.where(eq(schema.member.organizationId, org.id))
					.orderBy(asc(schema.member.createdAt)),
				db
					.select({
						id: schema.invitation.id,
						email: schema.invitation.email,
						role: schema.invitation.role,
						expires_at: schema.invitation.expiresAt,
					})
					.from(schema.invitation)
					.where(
						and(
							eq(schema.invitation.organizationId, org.id),
							eq(schema.invitation.status, "pending"),
						),
					),
				listRoles(org.id),
				approvalRequired(org.id),
			]);
			const now = Date.now();
			return {
				members: members.map(({ extra, revoked, created_at, ...m }) => ({
					...m,
					you: m.user_id === ctx.userId,
					added_permissions: parsePermissions(extra),
					removed_permissions: parsePermissions(revoked),
					joined_at: created_at.toISOString(),
				})),
				invitations: invitations
					.filter((i) => i.expires_at.getTime() > now)
					.map((i) => ({
						...i,
						role: i.role ?? "member",
						expires_at: i.expires_at.toISOString(),
					})),
				roles,
				needs_approval: needsApproval,
			};
		},
	},
	{
		name: "list_permissions",
		title: "List the permissions",
		description:
			"Every permission a role can hold, grouped as Settings › Roles shows them (id, label, hint), what each one needs (granting it grants those too) and which hand out access or credentials. Use the ids in save_role and change_member.",
		input: {},
		readOnly: true,
		run: async () => ({
			groups: CATALOG,
			all: ALL_PERMISSIONS,
			requires: REQUIRES,
			sensitive: [...SENSITIVE],
		}),
	},
	{
		name: "save_role",
		title: "Create or edit a role",
		description:
			"Creates a custom role (no `role`) or edits one, starter roles included (Owner is fixed). all: true gives every permission, including ones added to Mailroom later; otherwise `permissions` (ids from list_permissions). Nobody gives a role more than they have themselves. Returns the role's slug.",
		input: {
			organization,
			role: z.string().optional().describe("The slug of the role to edit"),
			name: z.string().max(60),
			description: z.string().max(200).nullable().optional(),
			all: z.boolean().optional(),
			permissions: z.array(z.string()).max(100).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:roles");
			const slug = await team(() =>
				saveRole({
					...actor(org, ctx),
					slug: a.role as string | undefined,
					name: a.name as string,
					description: (a.description as string | null | undefined) ?? null,
					all: (a.all as boolean | undefined) ?? false,
					permissions: (a.permissions as string[] | undefined) ?? [],
				}),
			);
			return (await listRoles(org.id)).find((r) => r.slug === slug) ?? { slug };
		},
	},
	{
		name: "delete_role",
		title: "Delete a role",
		description:
			"Deletes a custom role. Refused while someone has it: give them another role first (change_member).",
		input: { organization, role: z.string().describe("Its slug") },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:roles");
			await team(() => deleteRole({ ...actor(org, ctx), slug: a.role as string }));
			return { deleted: a.role };
		},
	},
	{
		name: "reset_role",
		title: "Reset a starter role",
		description:
			"Puts a starter role (admin, marketer, writer, support, member) back to Mailroom's permissions for it.",
		input: { organization, role: z.string().describe("Its slug") },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:roles");
			await team(() => resetRole({ ...actor(org, ctx), slug: a.role as string }));
			return (await listRoles(org.id)).find((r) => r.slug === a.role) ?? { reset: a.role };
		},
	},
	{
		name: "invite_member",
		title: "Invite someone",
		description:
			"Emails an invitation to join the organization with a role (its slug; see list_team). Signups are closed on this deployment, so this is how people get in. Nobody invites with more access than they have.",
		input: { organization, email: z.string().max(320), role: z.string().max(40) },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:invite");
			const id = await team(() =>
				inviteMember({
					...actor(org, ctx),
					email: a.email as string,
					role: a.role as string,
				}),
			);
			return { invitation_id: id, email: a.email, role: a.role };
		},
	},
	{
		name: "cancel_invitation",
		title: "Cancel an invitation",
		description: "Withdraws a pending invitation (its link stops working).",
		input: { organization, invitation: z.string().describe("Its id (list_team)") },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:invite");
			await team(() => cancelInvitation({ ...actor(org, ctx), id: a.invitation as string }));
			return { canceled: a.invitation };
		},
	},
	{
		name: "change_member",
		title: "Change someone's access",
		description:
			"Gives a member another role, and/or permissions added to them alone (`add`) or taken from their role for them alone (`remove`); the lists replace what they had. Only an owner makes an owner.",
		input: {
			organization,
			member: z.string().describe("The member's id (list_team), not the user id"),
			role: z.string().max(40),
			add: z.array(z.string()).max(100).optional(),
			remove: z.array(z.string()).max(100).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "team:manage");
			await team(() =>
				changeMember({
					...actor(org, ctx),
					memberId: a.member as string,
					role: a.role as string,
					add: (a.add as string[] | undefined) ?? [],
					remove: (a.remove as string[] | undefined) ?? [],
				}),
			);
			return { changed: a.member, role: a.role };
		},
	},
	{
		name: "remove_member",
		title: "Remove someone",
		description:
			"Takes a member out of the organization (anyone can leave; removing others needs «Change people's access», and an owner only by an owner while another remains).",
		input: { organization, member: z.string().describe("The member's id (list_team)") },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			await team(() => removeMember({ ...actor(org, ctx), memberId: a.member as string }));
			return { removed: a.member };
		},
	},

	// ── The organization's settings ──
	{
		name: "get_organization_settings",
		title: "Organization settings",
		description:
			"The organization's own settings: name, whether broadcasts need approval, the weekly digest, the long-term archive (and how long Mailroom keeps emails, bodies and received mail), quiet mode and the frequency cap for broadcasts, and what the deployment's sending limits do to it (alert or pause per stream).",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const [approval, digest, archive, limits, actions, rules] = await Promise.all([
				approvalRequired(org.id),
				digestEnabled(org.id),
				archiveEnabled(org.id),
				getSendingLimits(),
				organizationActions(org.id),
				marketingRules(org.id),
			]);
			return {
				id: org.id,
				name: org.name,
				slug: org.slug,
				approval_required: approval,
				weekly_digest: digest,
				archive: { available: !!archiveBucket(), on: archive },
				quiet_mode: rules.quiet_mode,
				frequency_cap: rules.cap,
				retention_days: {
					email_bodies: bodyRetentionDays(),
					emails: logRetentionDays(),
					received: inboundRetentionDays(),
				},
				sending_limits: { deployment: limits, this_organization: actions },
			};
		},
	},
	{
		name: "update_organization_settings",
		title: "Change organization settings",
		description:
			"Renames the organization, or turns on or off: approval before broadcasts send (approval_required; API sends aren't gated), the weekly digest to owners and admins (weekly_digest), and keeping emails in the long-term R2 archive (archive). Also quiet_mode (people with an urgent open conversation or a rating of 2 or less in 14 days get no broadcasts or automation emails) and frequency_cap ({count, days}: at most that many broadcasts per person; null turns it off; automation emails count but always go). Transactional email is never held. Only what's given changes.",
		input: {
			organization,
			name: z.string().trim().min(1).max(80).optional(),
			approval_required: z.boolean().optional(),
			weekly_digest: z.boolean().optional(),
			archive: z.boolean().optional(),
			quiet_mode: z.boolean().optional(),
			frequency_cap: z
				.object({
					count: z.number().int().min(1).max(100),
					days: z.number().int().min(1).max(90),
				})
				.nullable()
				.optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "settings:manage");
			if (a.name !== undefined) {
				await db
					.update(schema.organization)
					.set({ name: a.name as string })
					.where(eq(schema.organization.id, org.id));
				await logged(ctx, org, "settings.renamed", {
					type: "organization",
					id: org.id,
					name: a.name as string,
				});
			}
			if (a.approval_required !== undefined) {
				await setApprovalRequired(org.id, a.approval_required as boolean);
				await logged(
					ctx,
					org,
					a.approval_required
						? "settings.approval_required"
						: "settings.approval_not_required",
					{ type: "organization", id: org.id },
				);
			}
			if (a.weekly_digest !== undefined) {
				await setDigestEnabled(org.id, a.weekly_digest as boolean);
				await logged(ctx, org, "settings.digest_changed", {
					type: "organization",
					id: org.id,
				});
			}
			if (a.archive !== undefined) {
				await setArchiveEnabled(org.id, a.archive as boolean);
				await logged(ctx, org, "settings.archive_changed", {
					type: "organization",
					id: org.id,
				});
			}
			if (a.quiet_mode !== undefined || a.frequency_cap !== undefined) {
				await setMarketingRules(org.id, {
					quiet_mode: a.quiet_mode as boolean | undefined,
					cap: a.frequency_cap as { count: number; days: number } | null | undefined,
				});
				await logged(ctx, org, "settings.marketing_rules_changed", {
					type: "organization",
					id: org.id,
				});
			}
			const rules = await marketingRules(org.id);
			return {
				name: a.name ?? org.name,
				approval_required: await approvalRequired(org.id),
				weekly_digest: await digestEnabled(org.id),
				archive: await archiveEnabled(org.id),
				quiet_mode: rules.quiet_mode,
				frequency_cap: rules.cap,
			};
		},
	},
	{
		name: "send_digest_now",
		title: "Send me the weekly digest",
		description: "Emails last week's digest of the organization now, only to you.",
		input: { organization },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const lines = await sendDigest({ id: org.id, name: org.name }, Date.now(), {
				to: ctx.email,
			});
			return { sent: !!lines, to: ctx.email };
		},
	},
	{
		name: "list_activity",
		title: "Activity log",
		description:
			"Who changed what in the organization, newest first (100 at a time; page with `before`, the last row's created_at). With type and id, one broadcast's or template's history (anyone may read that); the whole log needs «See the activity log».",
		input: {
			organization,
			type: z
				.string()
				.max(40)
				.optional()
				.describe("What it's about: broadcast, template, domain…"),
			id: z.string().max(80).optional(),
			before: z.string().max(40).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			if (!a.id) requires(org, "activity:view");
			const rows = await listActivity(org.id, {
				subject: a.type
					? { type: a.type as string, id: a.id as string | undefined }
					: undefined,
				before: a.before as string | undefined,
				limit: 100,
			});
			return { data: rows, before: rows.length === 100 ? rows.at(-1)?.created_at : null };
		},
	},
	{
		name: "list_access_log",
		title: "Access log",
		description:
			"Who looked up recipients or let them receive again (removed a suppression or unsubscribe), from the dashboard, the API or the assistant, newest first (200).",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const rows = await listAccessLog(org.id, 200);
			const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
			const people = ids.length
				? await db
						.select({ id: schema.user.id, name: schema.user.name })
						.from(schema.user)
						.where(inArray(schema.user.id, ids.slice(0, 90)))
				: [];
			const byId = new Map(people.map((p) => [p.id, p.name]));
			return rows.map((r) => ({
				...r,
				who: (r.user_id && byId.get(r.user_id)) || r.actor || "Someone",
			}));
		},
	},

	// ── Comments, reviews and versions ──
	{
		name: "list_comments",
		title: "List comments",
		description:
			"The comment thread of a broadcast or template (review requests and decisions show in it too), with who wrote each, the block it's on and whether it's resolved.",
		input: { organization, type: subjectType, id: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			await own(org, a.type as CommentSubject, a.id as string);
			return listComments(org.id, a.type as CommentSubject, a.id as string);
		},
	},
	{
		name: "add_comment",
		title: "Comment",
		description:
			"Adds a comment to a broadcast or template, optionally on one of its design's blocks (block: the block's id). Needs edit access to it, or «Approve».",
		input: {
			organization,
			type: subjectType,
			id: z.string(),
			body: z.string().min(1).max(4000),
			block: z.string().max(40).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const type = a.type as CommentSubject;
			if (!org.access.can(EDIT[type]) && !org.access.can("broadcasts:approve"))
				throw forbidden(org, EDIT[type]);
			const x = await own(org, type, a.id as string);
			const row = await addComment({
				organizationId: org.id,
				type,
				id: a.id as string,
				userId: ctx.userId,
				body: a.body as string,
				blockId: (a.block as string | undefined) ?? null,
			});
			await logged(ctx, org, `${type}.commented`, { type, id: a.id as string, name: x.name });
			return row;
		},
	},
	{
		name: "resolve_comment",
		title: "Resolve or reopen a comment",
		description: "Marks a comment resolved (resolved: true) or open again.",
		input: { organization, comment: z.string(), resolved: z.boolean() },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			await resolveComment({
				organizationId: org.id,
				id: a.comment as string,
				userId: ctx.userId,
				resolved: a.resolved as boolean,
			});
			return { comment: a.comment, resolved: a.resolved };
		},
	},
	{
		name: "delete_comment",
		title: "Delete a comment",
		description: "Deletes one of your own comments (review steps stay in the thread).",
		input: { organization, comment: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			await deleteComment({
				organizationId: org.id,
				id: a.comment as string,
				userId: ctx.userId,
			});
			return { deleted: a.comment };
		},
	},
	{
		name: "review_broadcast",
		title: "Ask for, give or withdraw approval",
		description:
			"Approval before sending (when the organization requires it; see get_organization_settings). action request: asks the approvers to review a draft (note optional); approve or reject: decides on someone else's request (needs «Approve», never your own); withdraw: takes your request back. A change to the content after approval asks again.",
		input: {
			organization,
			broadcast: z.string(),
			action: z.enum(["request", "approve", "reject", "withdraw"]),
			note: z.string().max(2000).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const x = await getBroadcast(await brandIds(org.id), a.broadcast as string);
			const o = {
				organizationId: org.id,
				brand: x.organization_id,
				id: x.id,
				userId: ctx.userId,
			};
			if (a.action === "request") {
				requires(org, "broadcasts:edit");
				await requestReview({ ...o, note: a.note as string | undefined });
			} else if (a.action === "withdraw") {
				requires(org, "broadcasts:edit");
				await withdrawReview(o);
			} else {
				requires(org, "broadcasts:approve");
				await decideReview({
					...o,
					access: org.access,
					approve: a.action === "approve",
					note: a.note as string | undefined,
				});
			}
			const after = await getBroadcast(x.organization_id, x.id);
			return { broadcast: x.id, review: after.review };
		},
	},
	{
		name: "list_versions",
		title: "Version history",
		description:
			"Earlier versions of a broadcast's or template's content (saved as it's edited), newest first. restore_version puts one back.",
		input: { organization, type: subjectType, id: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			await own(org, a.type as CommentSubject, a.id as string);
			return listVersions(org.id, a.type as CommentSubject, a.id as string);
		},
	},
	{
		name: "restore_version",
		title: "Restore a version",
		description:
			"Puts an earlier version's content (subject, preview text, design or HTML, text) back into a draft broadcast or a template's draft. What it says now is kept as a version first, so it can be undone.",
		input: { organization, version: z.string().describe("Its id (list_versions)") },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const v = await getVersion(org.id, a.version as string);
			const type = v.subject_type as CommentSubject;
			requires(org, EDIT[type]);
			const s = v.snapshot;
			const x = await own(org, type, v.subject_id);
			await recordVersion({
				organizationId: org.id,
				type,
				id: v.subject_id,
				userId: ctx.userId,
				snapshot: snapshotOf(x as never),
				now: Date.now() - 1,
			});
			if (type === "broadcast") {
				const b = x as Awaited<ReturnType<typeof getBroadcast>>;
				await updateBroadcast(
					org.id,
					b.organization_id,
					b.id,
					{
						subject: s.subject,
						preview_text: s.preview_text,
						...(s.design ? { design: s.design } : { html: s.html, design: null }),
						text: s.text,
					},
					Date.now(),
					ctx.userId,
				);
			} else {
				await updateTemplate(org.id, v.subject_id, {
					subject: s.subject || null,
					...(s.design ? { design: s.design } : { html: s.html, design: null }),
					text: s.text,
				});
			}
			await logged(
				ctx,
				org,
				`${type}.restored`,
				{ type, id: v.subject_id, name: x.name },
				{
					version: v.created_at,
				},
			);
			return { restored: v.id, type, id: v.subject_id };
		},
	},

	// ── Saved sections and brand kits ──
	{
		name: "list_sections",
		title: "List saved sections",
		description:
			"Blocks saved from one email to drop into others (a header, a footer…), with their blocks in the design format.",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => listSections(orgAt(ctx, a.organization).id),
	},
	{
		name: "save_section",
		title: "Save a section",
		description:
			"Saves blocks (the design format: see save_broadcast's `design`) as a section everyone can reuse, or with `section` replaces one's blocks, or only renames it when blocks is left out. Up to 30 blocks.",
		input: {
			organization,
			section: z.string().optional().describe("Its id, to change it"),
			name: z.string().max(80),
			blocks: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "library:edit");
			const blocks = (a.blocks as unknown[] | undefined) ?? [];
			let id = a.section as string | undefined;
			if (id && !blocks.length) await renameSection(org.id, id, a.name as string);
			else
				id = (
					await saveSection({
						organizationId: org.id,
						userId: ctx.userId,
						id,
						name: a.name as string,
						blocks,
					})
				).id;
			await logged(ctx, org, "section.saved", {
				type: "section",
				id,
				name: a.name as string,
			});
			return (await listSections(org.id)).find((s) => s.id === id) ?? { id };
		},
	},
	{
		name: "delete_section",
		title: "Delete a saved section",
		description: "Deletes a saved section (emails that used it keep their copy).",
		input: { organization, section: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "library:edit");
			await deleteSection(org.id, a.section as string);
			await logged(ctx, org, "section.deleted", { type: "section", id: a.section as string });
			return { deleted: a.section };
		},
	},
	{
		name: "get_brand_kit",
		title: "Get a brand kit",
		description:
			"A brand's kit (what the email editor starts from): named colors, background, surface, text, heading, accent and button text colors, body and heading fonts, its own web fonts, corner radius, and whether it's locked (emails can only use it). Null when it has none.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const id = a.brand ? await brandIn(org.id, a.brand as string) : org.id;
			return { brand_id: id, kit: await getKit(id) };
		},
	},
	{
		name: "save_brand_kit",
		title: "Save a brand kit",
		description:
			'Sets a brand\'s kit. kit: { colors: [{ name, value: "#rrggbb" }], background, surface, text, heading, accent, button_text (all "#rrggbb"), font, heading_font (modern, inter, helvetica, georgia, book, mono, or the family of one of `fonts`), fonts: [{ family, url (a WOFF2 from upload_file), fallback, weight }], radius (px), locked }. What\'s missing takes the default. remove: true deletes the kit.',
		input: {
			organization,
			brand: oneBrand,
			kit: z.record(z.string(), z.unknown()).optional(),
			remove: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "library:edit");
			const id = a.brand ? await brandIn(org.id, a.brand as string) : org.id;
			if (a.remove) {
				await removeKit(id);
				return { brand_id: id, kit: null };
			}
			if (!a.kit)
				throw new ApiError(422, "validation_error", "kit: give the kit, or remove: true");
			const kit = await saveKit(id, a.kit, ctx.userId);
			await logged(ctx, org, "brand_kit.edited", { type: "brand", id });
			return { brand_id: id, kit };
		},
	},
	{
		name: "upload_file",
		title: "Upload an image or font",
		description:
			"Stores an image (PNG, JPEG, GIF or WebP) or a font (WOFF2, WOFF) for emails, brand kits, newsletters and forms, up to 3 MB, and returns its public URL to use in a design, HTML or a kit. data: a data: URL (data:image/png;base64,…).",
		input: { organization, data: z.string().max(4_500_000) },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const uploaders = [
				"broadcasts:edit",
				"templates:edit",
				"library:edit",
				"newsletters:edit",
				"brands:edit",
				"forms:edit",
				"settings:manage",
			] as const;
			if (!uploaders.some((p) => org.access.can(p))) throw forbidden(org);
			return uploadMedia(org.id, a.data as string);
		},
	},
];
