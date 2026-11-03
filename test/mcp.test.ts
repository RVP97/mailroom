import { env } from "cloudflare:workers";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { handleOAuth } from "@/server/mcp/oauth";
import { buildServer } from "@/server/mcp/server";
import { type McpContext, memberships } from "@/server/mcp/tools";
import { clearSettingsCache, setSetting } from "@/server/settings";
import { fakeOutside, seedOrg, uid } from "./helpers";

const vars = env as unknown as {
	TRACKING_ZONE_ID?: string;
	TRACKING_CNAME_TARGET?: string;
	CLOUDFLARE_API_TOKEN?: string;
};

afterEach(() => {
	vars.TRACKING_ZONE_ID = undefined;
	vars.TRACKING_CNAME_TARGET = undefined;
	vars.CLOUDFLARE_API_TOKEN = undefined;
});

const domainRow = (id: string) =>
	db.select().from(schema.domains).where(eq(schema.domains.id, id)).get();

async function seedUser(organizationId: string, role: "owner" | "admin" | "member") {
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

async function connect(ctx: McpContext) {
	const server = buildServer(ctx);
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return client;
}

async function contextFor(userId: string, email: string, isAdmin = false): Promise<McpContext> {
	return { userId, email, isAdmin, organizations: await memberships(userId) };
}

const json = (r: unknown) =>
	JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("MCP server", () => {
	it("lists only the person's organizations and hides admin tools from non-admins", async () => {
		const org = await seedOrg();
		await seedOrg();
		const u = await seedUser(org.id, "owner");
		const client = await connect(await contextFor(u.userId, u.email));
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain("list_emails");
		expect(names).not.toContain("account_overview");
		const r = json(await client.callTool({ name: "list_organizations", arguments: {} }));
		expect(r.organizations.map((o: { id: string }) => o.id)).toEqual([org.id]);
		expect(r.organizations[0]).toMatchObject({ role: "owner", sending: "ready" });

		const admin = await connect(await contextFor(u.userId, u.email, true));
		expect((await admin.listTools()).tools.map((t) => t.name)).toContain("account_overview");
	});

	it("keeps members to reading, and never returns a webhook's secret", async () => {
		const org = await seedOrg();
		const member = await seedUser(org.id, "member");
		const owner = await seedUser(org.id, "owner");
		const asMember = await connect(await contextFor(member.userId, member.email));
		const refused = await asMember.callTool({
			name: "create_webhook",
			arguments: { url: "https://app.test/hook" },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toMatch(/don't have permission/);

		const asOwner = await connect(await contextFor(owner.userId, owner.email));
		const created = await asOwner.callTool({
			name: "create_webhook",
			arguments: { organization: org.slug, url: "https://app.test/hook" },
		});
		expect(created.isError).toBeFalsy();
		expect(JSON.stringify(created)).not.toMatch(/whsec_/);
		const hooks = json(await asOwner.callTool({ name: "list_webhooks", arguments: {} }));
		expect(hooks).toHaveLength(1);
		expect(JSON.stringify(hooks)).not.toMatch(/whsec_/);

		const id = (hooks as { id: string }[])[0]?.id;
		const updated = await asOwner.callTool({
			name: "update_webhook",
			arguments: { id, events: ["email.delivered", "email.bounced"] },
		});
		expect(updated.isError).toBeFalsy();
		expect(JSON.stringify(updated)).not.toMatch(/whsec_/);
		const after = json(await asOwner.callTool({ name: "list_webhooks", arguments: {} })) as {
			events: string[];
		}[];
		expect(after[0]?.events).toEqual(["email.delivered", "email.bounced"]);
		const memberUpdate = await asMember.callTool({
			name: "update_webhook",
			arguments: { id, enabled: false },
		});
		expect(memberUpdate.isError).toBe(true);
	});

	it("lets the deployment's admins create an organization they own", async () => {
		const org = await seedOrg();
		const u = await seedUser(org.id, "member");
		const member = await connect(await contextFor(u.userId, u.email));
		expect((await member.listTools()).tools.map((t) => t.name)).not.toContain(
			"create_organization",
		);
		const userId = `user_${uid()}`;
		await db
			.insert(schema.user)
			.values({ id: userId, name: "Admin", email: "admin@mailroom.test" });
		const admin = await connect(await contextFor(userId, "admin@mailroom.test", true));
		const slug = `new-${uid().toLowerCase()}`;
		const created = await admin.callTool({
			name: "create_organization",
			arguments: { name: "New Business", slug },
		});
		expect(created.isError).toBeFalsy();
		expect(json(created)).toMatchObject({ name: "New Business", slug, role: "owner" });
		expect((await memberships(userId)).find((m) => m.slug === slug)?.role).toBe("owner");
	});

	it("refuses an organization the person isn't in", async () => {
		const mine = await seedOrg();
		const other = await seedOrg();
		const u = await seedUser(mine.id, "admin");
		const client = await connect(await contextFor(u.userId, u.email));
		const r = await client.callTool({
			name: "list_emails",
			arguments: { organization: other.slug },
		});
		expect(r.isError).toBe(true);
	});

	it("sets a domain's tracking domain and logo, and deletes it, for owners and admins only", async () => {
		vars.TRACKING_ZONE_ID = "zone1";
		vars.TRACKING_CNAME_TARGET = "track.mailroom.test";
		vars.CLOUDFLARE_API_TOKEN = "token";
		clearSettingsCache();
		await setSetting("aws_account_id", "123456789012");
		const outside: string[] = [];
		let hostnames = 0;
		fakeOutside({
			extra: async (url, init) => {
				const method = init?.method ?? "GET";
				outside.push(`${method} ${url.host}${url.pathname}`);
				if (url.host === "api.cloudflare.com") {
					const body = init?.body ? JSON.parse(String(init.body)) : {};
					if (method === "POST" && url.pathname.endsWith("/custom_hostnames"))
						return Response.json({
							success: true,
							result: {
								id: `ch${++hostnames}`,
								hostname: body.hostname,
								status: "pending",
							},
						});
					if (method === "POST" && url.pathname.endsWith("/workers/routes"))
						return Response.json({ success: true, result: { id: `r${hostnames}` } });
					if (method === "GET" && /\/custom_hostnames\/ch\d$/.test(url.pathname))
						return Response.json({
							success: true,
							result: { status: "pending", ssl: { status: "pending_validation" } },
						});
					return Response.json({ success: true, result: {} });
				}
				if (url.host === "email.us-east-1.amazonaws.com") return Response.json({});
				return undefined;
			},
		});
		const org = await seedOrg();
		const member = await seedUser(org.id, "member");
		const admin = await seedUser(org.id, "admin");
		const asMember = await connect(await contextFor(member.userId, member.email));
		for (const [name, args] of [
			["set_tracking_domain", { domain: org.domain }],
			["set_bimi_logo", { domain: org.domain, svg: null }],
			["delete_domain", { domain: org.domain }],
		] as const) {
			const r = await asMember.callTool({ name, arguments: args });
			expect(r.isError).toBe(true);
			expect(JSON.stringify(r.content)).toMatch(/don't have permission/);
		}

		const client = await connect(await contextFor(admin.userId, admin.email));
		const tracked = json(
			await client.callTool({
				name: "set_tracking_domain",
				arguments: { domain: org.domain },
			}),
		);
		expect(tracked.tracking_domain).toEqual({ name: `links.${org.domain}`, status: "pending" });
		expect(tracked.records).toContainEqual(
			expect.objectContaining({ record: "Tracking", name: `links.${org.domain}` }),
		);
		// Another prefix: the old host goes, the new one comes.
		const moved = json(
			await client.callTool({
				name: "set_tracking_domain",
				arguments: { domain: org.domainId, prefix: "track" },
			}),
		);
		expect(moved.tracking_domain.name).toBe(`track.${org.domain}`);
		expect(outside).toContain(
			"DELETE api.cloudflare.com/client/v4/zones/zone1/custom_hostnames/ch1",
		);
		const untracked = json(
			await client.callTool({
				name: "set_tracking_domain",
				arguments: { domain: org.domain, remove: true },
			}),
		);
		expect(untracked.tracking_domain).toBeNull();

		const orgLogo = json(
			await client.callTool({
				name: "set_organization_logo",
				arguments: {
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 30"><style>.a{fill:#c90}</style><circle class="a" cx="15" cy="15" r="12"/></svg>',
					background: "#0D2B29",
				},
			}),
		);
		expect(orgLogo.logo).toMatchObject({ source: "own", background: "#0d2b29" });
		expect(orgLogo.logo.url).toMatch(new RegExp(`/logos/${org.id}\\?v=`));
		const unsafe = await client.callTool({
			name: "set_organization_logo",
			arguments: { svg: '<svg viewBox="0 0 9 9"><script>x()</script></svg>' },
		});
		expect(unsafe.isError).toBe(true);
		const backToNone = json(
			await client.callTool({
				name: "set_organization_logo",
				arguments: { remove: true, background: null },
			}),
		);
		expect(backToNone.logo).toBeNull();

		const bad = await client.callTool({
			name: "set_bimi_logo",
			arguments: { domain: org.domain, svg: "<svg><rect/></svg>" },
		});
		expect(bad.isError).toBe(true);
		const logo = json(
			await client.callTool({
				name: "set_bimi_logo",
				arguments: {
					domain: org.domain,
					svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64"/></svg>',
				},
			}),
		);
		expect(logo.bimi_logo.url).toMatch(new RegExp(`/bimi/${org.domain}\\.svg$`));
		expect(JSON.stringify(logo.records)).toMatch(/v=BIMI1/);
		expect((await domainRow(org.domainId))?.bimi_logo).toMatch(/baseProfile="tiny-ps"/);
		const cleared = json(
			await client.callTool({
				name: "set_bimi_logo",
				arguments: { domain: org.domain, svg: null },
			}),
		);
		expect(cleared.bimi_logo).toBeNull();

		const deleted = await client.callTool({
			name: "delete_domain",
			arguments: { domain: org.domain },
		});
		expect(deleted.isError).toBeFalsy();
		expect(json(deleted)).toEqual({ deleted: org.domainId, name: org.domain });
		expect(await domainRow(org.domainId)).toBeUndefined();
		expect(outside).toContain(
			"POST email.us-east-1.amazonaws.com/v2/email/tenants/resources/delete",
		);
		const again = await client.callTool({
			name: "delete_domain",
			arguments: { domain: org.domain },
		});
		expect(again.isError).toBe(true);
	});

	it("answers /mcp without a token with a 401 that points at the OAuth metadata", async () => {
		const res = await handleOAuth(
			new Request("https://mailroom.test/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			env as unknown as Env,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toMatch(/oauth-protected-resource/);
		const meta = await handleOAuth(
			new Request("https://mailroom.test/.well-known/oauth-authorization-server"),
			env as unknown as Env,
			{
				waitUntil: () => {},
				passThroughOnException: () => {},
			} as unknown as ExecutionContext,
		);
		expect(await meta.json()).toMatchObject({
			issuer: "https://mailroom.test",
			authorization_endpoint: "https://mailroom.test/oauth/authorize",
		});
	});
});
