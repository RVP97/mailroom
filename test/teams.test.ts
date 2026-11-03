import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Access, FULL_ACCESS, roleDefinition, withRequirements } from "@/lib/permissions";
import { assertCovers, memberAccess } from "@/server/access";
import { listActivity, logActivity } from "@/server/activity";
import { createBroadcast, getBroadcast, updateBroadcast } from "@/server/broadcasts";
import { addComment, listComments, openComments, resolveComment } from "@/server/comments";
import { db, schema } from "@/server/db";
import { listSections, saveSection } from "@/server/library";
import {
	approvalRequired,
	assertApproved,
	decideReview,
	requestReview,
	setApprovalRequired,
} from "@/server/reviews";
import { changeMember, inviteMember, listRoles, saveRole } from "@/server/roles";
import { listVersions, recordVersion } from "@/server/versions";
import { fakeOutside, seedOrg, uid } from "./helpers";

const access = (role: string, o: { add?: string[]; remove?: string[] } = {}) =>
	new Access({
		role,
		definition: roleDefinition(role, null),
		add: o.add as never,
		remove: o.remove as never,
	});

async function person(organizationId: string, role: string) {
	const userId = `user_${uid()}`;
	await db
		.insert(schema.user)
		.values({ id: userId, name: `P ${role}`, email: `${userId}@p.test` });
	const memberId = `mem_${uid()}`;
	await db
		.insert(schema.member)
		.values({ id: memberId, organizationId, userId, role, createdAt: new Date() });
	return { userId, memberId, access: await memberAccess(organizationId, userId) };
}

describe("permissions", () => {
	it("resolves roles, requirements, additions and removals", () => {
		expect(access("owner").can("team:roles")).toBe(true);
		expect(access("admin").can("broadcasts:send")).toBe(true);
		expect(access("member").can("broadcasts:edit")).toBe(false);
		const writer = access("writer");
		expect(writer.can("broadcasts:edit")).toBe(true);
		expect(writer.can("broadcasts:send")).toBe(false);
		// Sending needs editing; giving send brings edit along.
		expect(withRequirements(["broadcasts:send"]).has("broadcasts:edit")).toBe(true);
		expect(access("member", { add: ["broadcasts:send"] }).can("broadcasts:edit")).toBe(true);
		// Taking edit away takes send with it.
		const m = access("marketer", { remove: ["broadcasts:edit"] });
		expect(m.can("broadcasts:send")).toBe(false);
		expect(m.can("contacts:edit")).toBe(true);
		// Unknown roles give nothing.
		expect(new Access({ role: "r_gone", definition: null }).can("broadcasts:edit")).toBe(false);
	});

	it("never lets anyone grant more than they have", () => {
		const marketer = access("marketer");
		expect(() => assertCovers(marketer, access("writer"), "invite")).not.toThrow();
		expect(() => assertCovers(marketer, access("admin"), "invite")).toThrow();
		expect(() =>
			assertCovers(marketer, access("member", { add: ["domains:manage"] }), "change"),
		).toThrow();
		expect(() => assertCovers(FULL_ACCESS, access("admin"), "invite")).not.toThrow();
	});
});

describe("roles and members", () => {
	it("saves a custom role and uses it for a member, keeping within the actor's access", async () => {
		const org = await seedOrg();
		const owner = await person(org.id, "owner");
		const slug = await saveRole({
			organizationId: org.id,
			actor: owner.access,
			actorId: owner.userId,
			name: "Designer",
			all: false,
			permissions: ["library:edit", "templates:edit"],
		});
		const roles = await listRoles(org.id);
		expect(roles.find((r) => r.slug === slug)?.name).toBe("Designer");

		const someone = await person(org.id, "member");
		await changeMember({
			organizationId: org.id,
			actor: owner.access,
			actorId: owner.userId,
			memberId: someone.memberId,
			role: slug,
			add: ["broadcasts:edit"],
			remove: [],
		});
		const now = await memberAccess(org.id, someone.userId);
		expect(now.can("library:edit")).toBe(true);
		expect(now.can("broadcasts:edit")).toBe(true);
		expect(now.can("broadcasts:send")).toBe(false);

		// A marketer can't hand out domain access, nor change their own.
		const marketer = await person(org.id, "marketer");
		const withTeam = new Access({
			role: "marketer",
			definition: roleDefinition("marketer", null),
			add: ["team:manage"],
		});
		await expect(
			changeMember({
				organizationId: org.id,
				actor: withTeam,
				actorId: marketer.userId,
				memberId: someone.memberId,
				role: "member",
				add: ["domains:manage"],
				remove: [],
			}),
		).rejects.toThrow();
		await expect(
			changeMember({
				organizationId: org.id,
				actor: owner.access,
				actorId: owner.userId,
				memberId: owner.memberId,
				role: "member",
				add: [],
				remove: [],
			}),
		).rejects.toThrow(/own access/);
	});

	it("invites with a custom role, but not to more than the inviter has", async () => {
		fakeOutside();
		const org = await seedOrg();
		const owner = await person(org.id, "owner");
		const slug = await saveRole({
			organizationId: org.id,
			actor: owner.access,
			actorId: owner.userId,
			name: "Reviewer",
			all: false,
			permissions: ["broadcasts:approve"],
		});
		await inviteMember({
			organizationId: org.id,
			actor: owner.access,
			actorId: owner.userId,
			email: `new_${uid()}@p.test`,
			role: slug,
		});
		const invites = await db
			.select()
			.from(schema.invitation)
			.where(eq(schema.invitation.organizationId, org.id));
		expect(invites.map((i) => i.role)).toContain(slug);

		const writer = new Access({
			role: "writer",
			definition: roleDefinition("writer", null),
			add: ["team:invite"],
		});
		await expect(
			inviteMember({
				organizationId: org.id,
				actor: writer,
				actorId: owner.userId,
				email: `x_${uid()}@p.test`,
				role: "admin",
			}),
		).rejects.toThrow();
	});
});

describe("approval before sending", () => {
	it("holds an approval only while the content is the same", async () => {
		fakeOutside();
		const org = await seedOrg();
		const writer = await person(org.id, "writer");
		const marketer = await person(org.id, "marketer");
		const b = await createBroadcast(
			org.id,
			org.id,
			{ from: `News <news@${org.domain}>`, subject: "Hello", html: "<p>Hi</p>" },
			Date.now(),
			writer.userId,
		);
		expect(await approvalRequired(org.id)).toBe(false);
		await assertApproved(org.id, await getBroadcast(org.id, b.id));
		await setApprovalRequired(org.id, true);
		await expect(assertApproved(org.id, await getBroadcast(org.id, b.id))).rejects.toThrow(
			/approved/,
		);

		await requestReview({
			organizationId: org.id,
			brand: org.id,
			id: b.id,
			userId: writer.userId,
		});
		// Asking for changes needs a note; the writer can't approve their own.
		await expect(
			decideReview({
				organizationId: org.id,
				brand: org.id,
				id: b.id,
				userId: writer.userId,
				access: writer.access,
				approve: true,
			}),
		).rejects.toThrow();
		await decideReview({
			organizationId: org.id,
			brand: org.id,
			id: b.id,
			userId: marketer.userId,
			access: marketer.access,
			approve: true,
		});
		await assertApproved(org.id, await getBroadcast(org.id, b.id));

		await updateBroadcast(
			org.id,
			org.id,
			b.id,
			{ subject: "Hello again" },
			Date.now(),
			writer.userId,
		);
		const after = await getBroadcast(org.id, b.id);
		expect(after.review).toBeNull();
		await expect(assertApproved(org.id, after)).rejects.toThrow();

		const thread = await listComments(org.id, "broadcast", b.id);
		expect(thread.map((c) => c.kind)).toEqual(["requested", "approved"]);
	});
});

describe("comments, versions, activity and sections", () => {
	it("keeps comments open until resolved", async () => {
		const org = await seedOrg();
		const p = await person(org.id, "writer");
		const c = await addComment({
			organizationId: org.id,
			type: "template",
			id: "t1",
			userId: p.userId,
			body: "Shorter subject?",
		});
		expect((await openComments(org.id, "template", ["t1"])).get("t1")).toBe(1);
		await resolveComment({
			organizationId: org.id,
			id: c.id,
			userId: p.userId,
			resolved: true,
		});
		expect((await openComments(org.id, "template", ["t1"])).get("t1") ?? 0).toBe(0);
	});

	it("keeps one version per person per 10 minutes", async () => {
		const org = await seedOrg();
		const a = await person(org.id, "writer");
		const b = await person(org.id, "writer");
		const snap = (subject: string) => ({
			subject,
			preview_text: null,
			html: `<p>${subject}</p>`,
			text: null,
			design: null,
		});
		const t0 = Date.now();
		const o = { organizationId: org.id, type: "broadcast" as const, id: `b_${uid()}` };
		await recordVersion({ ...o, userId: a.userId, snapshot: snap("one"), now: t0 });
		await recordVersion({ ...o, userId: a.userId, snapshot: snap("two"), now: t0 + 60_000 });
		await recordVersion({ ...o, userId: b.userId, snapshot: snap("three"), now: t0 + 120_000 });
		await recordVersion({
			...o,
			userId: b.userId,
			snapshot: snap("four"),
			now: t0 + 20 * 60_000,
		});
		const rows = await listVersions(org.id, "broadcast", o.id);
		expect(rows.map((r) => r.snapshot.subject)).toEqual(["four", "three", "two"]);
	});

	it("merges repeated edits of one thing in the activity log", async () => {
		const org = await seedOrg();
		const p = await person(org.id, "writer");
		const subject = { type: "broadcast", id: `b_${uid()}`, name: "Nov" };
		const now = Date.now();
		await logActivity({
			organizationId: org.id,
			userId: p.userId,
			action: "broadcast.edited",
			subject,
			now,
		});
		await logActivity({
			organizationId: org.id,
			userId: p.userId,
			action: "broadcast.edited",
			subject,
			now: now + 60_000,
		});
		await logActivity({
			organizationId: org.id,
			userId: p.userId,
			action: "broadcast.sent",
			subject,
			now: now + 120_000,
		});
		const rows = await listActivity(org.id, { subject });
		expect(rows.map((r) => r.action)).toEqual(["broadcast.sent", "broadcast.edited"]);
	});

	it("saves sections for the whole team", async () => {
		const org = await seedOrg();
		const p = await person(org.id, "marketer");
		await saveSection({
			organizationId: org.id,
			userId: p.userId,
			name: "Header",
			blocks: [{ id: "x", type: "text", html: "<p>Hi</p>", align: "left" }],
		});
		const rows = await listSections(org.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.blocks[0]?.type).toBe("text");
		await expect(
			saveSection({ organizationId: org.id, userId: p.userId, name: "Empty", blocks: [] }),
		).rejects.toThrow(/at least one/);
	});
});
