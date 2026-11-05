import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { buildServer } from "@/server/mcp/server";
import { type McpContext, memberships } from "@/server/mcp/tools";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** The MCP covers what the dashboard does, each change checked against the person's role. */

async function seedUser(organizationId: string, role: string) {
	const userId = `user_${uid()}`;
	const email = `${userId}@cliente.test`;
	await db.insert(schema.user).values({ id: userId, name: "Person", email });
	await db.insert(schema.member).values({
		id: `mem_${uid()}`,
		organizationId,
		userId,
		role,
		createdAt: new Date(),
	});
	return { userId, email };
}

async function connect(userId: string, email: string, isAdmin = false) {
	const ctx: McpContext = { userId, email, isAdmin, organizations: await memberships(userId) };
	const server = buildServer(ctx);
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as {
			isError?: boolean;
			content: { text: string }[];
		};
		const text = r.content[0]?.text ?? "";
		// A refusal, apart from any `error` field a result has.
		if (r.isError) return { failed: text } as Record<string, unknown> & { failed: string };
		return JSON.parse(text);
	};
	return { client, call };
}

describe("MCP coverage", () => {
	it("lists every tool with a description and a valid input schema", async () => {
		const org = await seedOrg();
		const u = await seedUser(org.id, "owner");
		const { client } = await connect(u.userId, u.email, true);
		const tools = (await client.listTools()).tools;
		const names = tools.map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
		expect(names.length).toBeGreaterThan(150);
		for (const t of tools) {
			expect(t.description?.length, t.name).toBeGreaterThan(20);
			expect(t.inputSchema.type).toBe("object");
		}
		for (const n of [
			"list_team",
			"save_role",
			"invite_member",
			"update_organization_settings",
			"save_newsletter",
			"save_campaign",
			"save_signup_form",
			"import_contacts",
			"review_broadcast",
			"restore_version",
			"save_brand_kit",
			"get_inbox",
			"save_chat_widget",
			"list_api_logs",
			"connect_ses_account",
		])
			expect(names, n).toContain(n);
	});

	it("hides the deployment's admin tools from everyone else", async () => {
		const org = await seedOrg();
		const u = await seedUser(org.id, "owner");
		const { client } = await connect(u.userId, u.email);
		const names = (await client.listTools()).tools.map((t) => t.name);
		for (const n of [
			"connect_ses_account",
			"set_sending_limits",
			"gmail_postmaster",
			"aws_account",
		])
			expect(names).not.toContain(n);
	});

	it("keeps a Viewer to reading", async () => {
		const org = await seedOrg();
		const viewer = await seedUser(org.id, "member");
		const { call } = await connect(viewer.userId, viewer.email);
		expect((await call("list_team")).members).toHaveLength(1);
		expect((await call("get_organization_settings")).approval_required).toBe(false);
		for (const [name, args] of [
			["save_role", { name: "Helper", permissions: [] }],
			["invite_member", { email: "x@cliente.test", role: "member" }],
			["update_organization_settings", { name: "Renamed" }],
			["save_segment", { name: "VIPs" }],
			["import_contacts", { rows: [{ email: "a@cliente.test" }] }],
			["save_newsletter", { name: "Weekly" }],
			["save_campaign", { name: "Summer" }],
			["save_section", { name: "Footer", blocks: [{ type: "divider" }] }],
			["upload_file", { data: "data:image/png;base64,iVBORw0KGgo=" }],
		] as const) {
			const r = await call(name, args);
			expect(r.failed, name).toMatch(/don't have permission/);
		}
	});

	it("runs the audience: segments, topics, properties, import and membership", async () => {
		const org = await seedOrg();
		const u = await seedUser(org.id, "owner");
		const { call } = await connect(u.userId, u.email);
		const vip = await call("save_segment", { name: "VIPs" });
		expect(vip.name).toBe("VIPs");
		expect((await call("save_segment", { segment: vip.id, name: "Best" })).name).toBe("Best");
		const topic = await call("save_topic", { name: "Offers", visibility: "public" });
		expect(topic.name).toBe("Offers");
		expect((await call("save_property", { key: "plan", type: "string" })).key).toBe("plan");
		const imported = await call("import_contacts", {
			segment_id: vip.id,
			rows: [
				{ email: "ana@cliente.test", first_name: "Ana", properties: { plan: "pro" } },
				{ email: "luis@cliente.test" },
				{ email: "not an address" },
			],
		});
		expect(imported.failed).toBeUndefined();
		const changed = await call("update_contact_lists", {
			contact: "luis@cliente.test",
			remove_segments: [vip.id],
			topics: [{ id: topic.id, subscription: "opt_in" }],
		});
		expect(changed.segments).toEqual([]);
		const segs = await call("list_segments");
		expect(segs.segments[0]).toMatchObject({ id: vip.id });
		expect((await call("list_properties")).map((p: { key: string }) => p.key)).toContain(
			"plan",
		);
		expect((await call("get_engagement")).contacts).toBeTruthy();
		expect((await call("get_growth")).growth).toBeTruthy();
		expect((await call("delete_segment", { segment: vip.id })).deleted).toBe(vip.id);
	});

	it("makes newsletters, campaigns and sign-up forms", async () => {
		const org = await seedOrg();
		const u = await seedUser(org.id, "owner");
		const { call } = await connect(u.userId, u.email);
		const n = await call("save_newsletter", {
			name: "Weekly",
			from: `news@${org.domain}`,
			public: true,
		});
		expect(n.failed).toBeUndefined();
		expect((await call("list_newsletters"))[0].id).toBe(n.id);
		expect(
			(await call("save_newsletter", { newsletter: n.id, description: "Hi" })).description,
		).toBe("Hi");
		const c = await call("save_campaign", { name: "Summer sale" });
		expect(c.failed).toBeUndefined();
		const b = await call("save_broadcast", {
			name: "Issue 1",
			subject: "Hello",
			from: `news@${org.domain}`,
			newsletter_id: n.id,
			campaign_id: c.id,
			html: "<p>Hi</p>",
		});
		expect(b.failed).toBeUndefined();
		expect((await call("get_campaign", { campaign: c.id })).broadcasts).toHaveLength(1);
		// Issues show on the newsletter once sent; drafts are found by filtering broadcasts.
		expect(await call("list_broadcasts", { newsletter_id: n.id })).toHaveLength(1);
		expect(await call("list_broadcasts", { status: "sent" })).toHaveLength(0);
		const f = await call("save_signup_form", {
			name: "Footer form",
			from: `news@${org.domain}`,
		});
		expect(f.failed).toBeUndefined();
		expect(f.url ?? f.page_url ?? f.id).toBeTruthy();
		expect((await call("get_signup_form", { form: f.id })).id).toBe(f.id);
		expect((await call("delete_signup_form", { form: f.id })).deleted).toBe(f.id);
		expect((await call("delete_campaign", { campaign: c.id })).deleted).toBe(c.id);
		expect((await call("delete_newsletter", { newsletter: n.id })).deleted).toBe(n.id);
	});

	it("designs a broadcast in blocks, keeps versions, comments and asks for approval", async () => {
		const org = await seedOrg();
		const owner = await seedUser(org.id, "owner");
		const writer = await seedUser(org.id, "writer");
		const asOwner = await connect(owner.userId, owner.email);
		const asWriter = await connect(writer.userId, writer.email);
		await asOwner.call("update_organization_settings", { approval_required: true });
		const b = await asWriter.call("save_broadcast", {
			name: "Launch",
			subject: "It's here",
			from: `hello@${org.domain}`,
			design: {
				version: 1,
				theme: {},
				blocks: [
					{ id: "h1", type: "heading", html: "Big news", level: 1, align: "center" },
					{ id: "t1", type: "text", html: "<p>First version</p>", align: "left" },
				],
			},
		});
		expect(b.failed).toBeUndefined();
		expect(b.html).toMatch(/Big news/);
		// Someone else's edit is a version of its own (one person's edits in a row merge).
		await asOwner.call("save_broadcast", {
			broadcast: b.id,
			design: {
				version: 1,
				theme: {},
				blocks: [{ id: "t1", type: "text", html: "<p>Second version</p>", align: "left" }],
			},
		});
		const versions = await asWriter.call("list_versions", { type: "broadcast", id: b.id });
		expect(versions.length).toBeGreaterThanOrEqual(2);
		const first = versions.at(-1);
		expect((await asWriter.call("restore_version", { version: first.id })).restored).toBe(
			first.id,
		);
		expect((await asOwner.call("get_broadcast", { broadcast: b.id })).html).toMatch(/Big news/);

		const comment = await asWriter.call("add_comment", {
			type: "broadcast",
			id: b.id,
			body: "Is the heading right?",
		});
		expect(comment.failed).toBeUndefined();
		expect(await asOwner.call("list_comments", { type: "broadcast", id: b.id })).toHaveLength(
			1,
		);

		// A writer can't send or approve; an owner approves what they asked for.
		const segment = await asOwner.call("save_segment", { name: "All" });
		await asWriter.call("save_broadcast", { broadcast: b.id, segment_id: segment.id });
		expect((await asWriter.call("send_broadcast", { broadcast: b.id })).failed).toMatch(
			/permission/,
		);
		expect(
			(await asWriter.call("review_broadcast", { broadcast: b.id, action: "request" }))
				.review,
		).toBe("requested");
		expect(
			(await asWriter.call("review_broadcast", { broadcast: b.id, action: "approve" }))
				.failed,
		).toMatch(/permission/);
		expect(
			(await asOwner.call("review_broadcast", { broadcast: b.id, action: "approve" })).review,
		).toBe("approved");
		const got = await asOwner.call("get_broadcast", { broadcast: b.id });
		expect(got.approval).toMatchObject({ required: true, approved: true });

		const copy = await asWriter.call("duplicate_broadcast", { broadcast: b.id });
		expect(copy.id).not.toBe(b.id);
		expect((await asWriter.call("delete_broadcast", { broadcast: copy.id })).deleted).toBe(
			copy.id,
		);
		const log = await asOwner.call("list_activity");
		expect(
			log.data.some(
				(r: { action: string; detail: { via?: string } | null }) =>
					r.action === "broadcast.created" && r.detail?.via === "assistant",
			),
		).toBe(true);
	});

	it("manages the team and the organization's settings", async () => {
		fakeOutside();
		const org = await seedOrg();
		const owner = await seedUser(org.id, "owner");
		const other = await seedUser(org.id, "member");
		const { call } = await connect(owner.userId, owner.email);
		const role = await call("save_role", {
			name: "Helper",
			permissions: ["contacts:edit", "forms:edit"],
		});
		expect(role.failed).toBeUndefined();
		expect((await call("list_permissions")).all).toContain("contacts:edit");
		const team = await call("list_team");
		const m = team.members.find((x: { user_id: string }) => x.user_id === other.userId);
		expect((await call("change_member", { member: m.id, role: role.slug })).role).toBe(
			role.slug,
		);
		expect(
			(await memberships(other.userId))
				.find((x) => x.id === org.id)
				?.access.can("contacts:edit"),
		).toBe(true);
		const s = await call("update_organization_settings", {
			name: "Harbor Inn",
			weekly_digest: false,
		});
		expect(s).toMatchObject({ name: "Harbor Inn", weekly_digest: false });
		expect((await call("delete_role", { role: role.slug })).failed).toBeTruthy();
		expect((await call("remove_member", { member: m.id })).removed).toBe(m.id);
		expect((await call("delete_role", { role: role.slug })).deleted).toBe(role.slug);
	});

	it("saves sections and a brand kit, and limits turning automations on", async () => {
		const org = await seedOrg();
		const owner = await seedUser(org.id, "owner");
		const writer = await seedUser(org.id, "writer");
		const { call } = await connect(owner.userId, owner.email);
		const sec = await call("save_section", {
			name: "Footer",
			blocks: [{ id: "d1", type: "divider" }],
		});
		expect(sec.failed).toBeUndefined();
		expect((await call("list_sections"))[0].id).toBe(sec.id);
		const kit = await call("save_brand_kit", { kit: { accent: "#0d2b29", radius: 8 } });
		expect(kit.kit.accent).toBe("#0d2b29");
		expect((await call("get_brand_kit")).kit.radius).toBe(8);

		// Building automations, but not turning them on.
		const role = await call("save_role", {
			name: "Builder",
			permissions: ["automations:edit"],
		});
		const m = (await call("list_team")).members.find(
			(x: { user_id: string }) => x.user_id === writer.userId,
		);
		await call("change_member", { member: m.id, role: role.slug });
		const asBuilder = await connect(writer.userId, writer.email);
		const auto = await asBuilder.call("save_automation", { name: "Welcome" });
		expect(auto.failed).toBeUndefined();
		expect(
			(await asBuilder.call("save_automation", { automation: auto.id, status: "active" }))
				.failed,
		).toMatch(/permission/);
		expect((await call("duplicate_automation", { automation: auto.id })).id).not.toBe(auto.id);
		expect((await call("delete_automation", { automation: auto.id })).deleted).toBe(auto.id);
	});
});
