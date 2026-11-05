import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { getConversation, sendReply } from "@/server/conversations";
import { db, schema } from "@/server/db";
import { receiveSes } from "@/server/inbound";
import { sender } from "@/server/inbox-api";
import {
	authenticateInbox,
	createCredential,
	createInbox,
	forgetCredentials,
	type Inbox,
	type InboxActor,
} from "@/server/inboxes";
import { buildAgentServer } from "@/server/mcp/server";
import { setSetting } from "@/server/settings";
import { createWebhook } from "@/server/webhook-admin";
import { fakeOutside, seedOrg, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const BUCKET = "mailroom-inbound-123456789012-us-east-1";

beforeAll(async () => {
	await useTopic();
	await setSetting("aws_account_id", "123456789012");
	await setSetting("inbound_bucket", BUCKET);
	await setSetting("inbound_rule_set", "mailroom");
	await setSetting("inbound_set_up_at", new Date().toISOString());
});

/** SES's drop box (S3) and SendEmail, faked; `objects` is what's in the drop box. */
function fakeAws(objects = new Map<string, string>()) {
	const fake = fakeOutside({
		extra: async (url, init) => {
			if (url.host === "app.test") return new Response("ok");
			if (url.host === `${BUCKET}.s3.us-east-1.amazonaws.com`) {
				const key = url.pathname.slice(1);
				if ((init?.method ?? "GET") === "GET") {
					const raw = objects.get(key);
					return raw === undefined
						? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
						: new Response(raw);
				}
				objects.delete(key);
				return new Response("");
			}
			return undefined;
		},
	});
	return { ...fake, objects };
}

function mail(o: {
	to: string[];
	id: string;
	subject?: string;
	inReplyTo?: string;
	references?: string[];
	from?: string;
	text?: string;
}) {
	return [
		`From: ${o.from ?? "Ana Guest <ana@guest.test>"}`,
		`To: ${o.to.join(", ")}`,
		`Subject: ${o.subject ?? "Invoice question"}`,
		`Message-ID: <${o.id}>`,
		...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`] : []),
		...(o.references ? [`References: ${o.references.map((r) => `<${r}>`).join(" ")}`] : []),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		o.text ?? "Can you resend invoice 1042?",
		"",
	].join("\r\n");
}

let clock = Date.parse("2026-11-04T10:00:00Z");

/** One message arriving (SES's notification for what it put in the drop box). */
async function arrive(
	fake: ReturnType<typeof fakeAws>,
	raw: string,
	to: string[],
	sesId = `ses-${uid()}`,
) {
	const key = `inbound/${uid()}`;
	fake.objects.set(key, raw);
	clock += 60_000;
	const at = new Date(clock).toISOString();
	const result = await receiveSes(
		{
			notificationType: "Received",
			mail: { messageId: sesId, timestamp: at, destination: to },
			receipt: {
				timestamp: at,
				recipients: to,
				spamVerdict: { status: "PASS" },
				virusVerdict: { status: "PASS" },
				action: { type: "S3", bucketName: BUCKET, objectKey: key },
			},
		},
		clock,
	);
	return { result, sesId, key };
}

/** A brand that receives at its domain, with two agent inboxes on it. */
async function setUp() {
	const org = await seedOrg();
	await db
		.update(schema.domains)
		.set({ receiving: true, receiving_status: "active", receiving_host: org.domain })
		.where(eq(schema.domains.id, org.domainId));
	const support = await createInbox(org.id, {
		name: "Support",
		local_part: "support",
		domain: org.domain,
	});
	const invoices = await createInbox(org.id, {
		name: "Invoices",
		local_part: "invoices",
		domain: org.domain,
	});
	return { org, support, invoices };
}

async function credential(inbox: Inbox, permissions?: string[], sendScope?: string) {
	const { token, credential: c } = await createCredential(inbox, {
		name: "Agent",
		permissions,
		send_scope: sendScope,
	});
	return { token, id: c.id };
}

// biome-ignore lint/suspicious/noExplicitAny: the API's answers, read loosely in tests
type Json = any;

/** An API call; its answer's json() is loosely typed. */
async function api(token: string, path: string, init: RequestInit = {}) {
	const res = await handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			...init,
			headers: {
				authorization: `Bearer ${token}`,
				...(init.body ? { "content-type": "application/json" } : {}),
			},
		}),
	);
	return res as Omit<Response, "json"> & { json: () => Promise<Json> };
}

const conversationsOf = (inboxId: string) =>
	db.select().from(schema.conversations).where(eq(schema.conversations.inbox_id, inboxId));

async function person(organizationId: string): Promise<InboxActor> {
	return {
		organizationId,
		brands: [organizationId],
		inboxIds: null,
		permissions: new Set(["read", "attachments", "triage", "draft", "send"]),
		sendScope: "anyone",
		type: "person",
		id: `user_${uid()}`,
		name: "Pat",
		reader: `user:${uid()}`,
	};
}

describe("agent inboxes", () => {
	it("gives an inbox an address on a receiving domain, or the Mailroom address", async () => {
		const { org, support } = await setUp();
		expect(support.address).toBe(`support@${org.domain}`);
		const own = await createInbox(org.id, { name: "Bot", local_part: "bot" });
		expect(own.address).toBe(`${org.slug}+bot@in.mailroom.test`);
		await expect(
			createInbox(org.id, { name: "Again", local_part: "support", domain: org.domain }),
		).rejects.toMatchObject({ status: 409 });
		await expect(createInbox(org.id, { name: "Tag", local_part: "a+b" })).rejects.toMatchObject(
			{
				status: 422,
			},
		);
	});

	it("keeps a copy per inbox, so one inbox never sees the other's", async () => {
		const { org, support, invoices } = await setUp();
		const fake = fakeAws();
		const to = [`support@${org.domain}`, `invoices+urgent@${org.domain}`, `hola@${org.domain}`];
		expect((await arrive(fake, mail({ to, id: `a-${uid()}@guest.test` }), to)).result).toBe(
			"applied",
		);
		const rows = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(rows.map((r) => r.inbox_id).sort()).toEqual([support.id, invoices.id, null].sort());
		expect(rows.find((r) => r.inbox_id === support.id)?.recipients).toEqual([
			`support@${org.domain}`,
		]);
		expect(await conversationsOf(support.id)).toHaveLength(1);
		expect(await conversationsOf(invoices.id)).toHaveLength(1);
	});
});

describe("credentials", () => {
	it("are read-only by default and reach only their inbox", async () => {
		const { support, invoices } = await setUp();
		const other = await setUp();
		const fake = fakeAws();
		for (const inbox of [support, invoices, other.support]) {
			const to = [inbox.address];
			await arrive(fake, mail({ to, id: `m-${uid()}@guest.test` }), to);
		}
		const { token } = await credential(support);
		const list = await (await api(token, "/conversations?status=all")).json();
		expect(list.data).toHaveLength(1);
		expect(list.data[0].inbox_id).toBe(support.id);
		// The other inbox of the same brand, and another organization's: not found.
		const [mine] = await conversationsOf(support.id);
		const [theirs] = await conversationsOf(invoices.id);
		const [foreign] = await conversationsOf(other.support.id);
		expect((await api(token, `/conversations/${mine?.id}`)).status).toBe(200);
		expect((await api(token, `/conversations/${theirs?.id}`)).status).toBe(404);
		expect((await api(token, `/conversations/${foreign?.id}`)).status).toBe(404);
		expect((await api(token, `/inboxes/${invoices.id}/conversations`)).status).toBe(404);
		const theirMessage = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.inbox_id, invoices.id))
			.get();
		expect((await api(token, `/messages/${theirMessage?.id}`)).status).toBe(404);
		// Nothing else of the API.
		for (const path of ["/emails", "/domains", "/emails/receiving", "/webhooks", "/api-keys"])
			expect((await api(token, path)).status).toBe(403);
		expect(
			(
				await api(token, "/emails", {
					method: "POST",
					body: JSON.stringify({ to: "x@y.test" }),
				})
			).status,
		).toBe(403);
		// Read-only: no drafts, no replies, no resolving.
		const draft = await api(token, `/conversations/${mine?.id}/drafts`, {
			method: "POST",
			body: JSON.stringify({ text: "Here it is" }),
		});
		expect(draft.status).toBe(403);
		const reply = await api(token, `/conversations/${mine?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Here it is" }),
		});
		expect(reply.status).toBe(403);
		expect(fake.sends).toHaveLength(0);
		const resolve = await api(token, `/conversations/${mine?.id}`, {
			method: "PATCH",
			body: JSON.stringify({ status: "resolved" }),
		});
		expect(resolve.status).toBe(403);
		// Making inboxes or credentials takes a full API key.
		expect(
			(
				await api(token, `/inboxes/${support.id}/credentials`, {
					method: "POST",
					body: JSON.stringify({ name: "More", permissions: ["send"] }),
				})
			).status,
		).toBe(403);
	});

	it("stop working once revoked or rotated", async () => {
		const { org, support } = await setUp();
		fakeAws();
		const { token: full } = await createKey({
			organizationId: org.id,
			name: "Full",
			permission: "full",
		});
		const made = await (
			await api(full, `/inboxes/${support.id}/credentials`, {
				method: "POST",
				body: JSON.stringify({ name: "Bot" }),
			})
		).json();
		expect(made.token).toMatch(/^mri_/);
		expect(made.permissions).toEqual(["read"]);
		expect((await api(made.token, "/inboxes")).status).toBe(200);
		const rotated = await (
			await api(full, `/inboxes/${support.id}/credentials/${made.id}/rotate`, {
				method: "POST",
			})
		).json();
		expect((await api(made.token, "/inboxes")).status).toBe(401);
		expect((await api(rotated.token, "/inboxes")).status).toBe(200);
		await api(full, `/inboxes/${support.id}/credentials/${made.id}`, { method: "DELETE" });
		expect((await api(rotated.token, "/inboxes")).status).toBe(401);
		forgetCredentials();
		expect(await authenticateInbox(`Bearer ${rotated.token}`)).toBeNull();
		const activity = await db
			.select({ action: schema.inboxActivity.action })
			.from(schema.inboxActivity)
			.where(eq(schema.inboxActivity.inbox_id, support.id));
		expect(activity.map((a) => a.action)).toEqual(
			expect.arrayContaining([
				"credential.created",
				"credential.rotated",
				"credential.revoked",
			]),
		);
	});
});

describe("threading", () => {
	it("joins replies by headers, never by subject, and handles out-of-order arrival", async () => {
		const { support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		const first = `first-${uid()}@guest.test`;
		const second = `second-${uid()}@guest.test`;
		const third = `third-${uid()}@guest.test`;
		// The answer to `second` arrives before `second` itself.
		await arrive(fake, mail({ to, id: first }), to);
		await arrive(
			fake,
			mail({ to, id: third, inReplyTo: second, references: [first, second] }),
			to,
		);
		await arrive(fake, mail({ to, id: second, inReplyTo: first }), to);
		// Same subject, no headers: its own conversation.
		await arrive(fake, mail({ to, id: `other-${uid()}@guest.test` }), to);
		const list = await conversationsOf(support.id);
		expect(list).toHaveLength(2);
		const thread = list.find((c) => c.messages === 3);
		expect(thread).toBeTruthy();
	});

	it("is idempotent when SES's notification comes twice", async () => {
		const { support } = await setUp();
		const fake = fakeAws();
		const hook = await createWebhook(support.organization_id, {
			url: "https://app.test/inbox",
			events: ["inbox.message.received", "inbox.conversation.created"],
			inbox_id: support.id,
		});
		const to = [support.address];
		const raw = mail({ to, id: `dup-${uid()}@guest.test` });
		const once = await arrive(fake, raw, to);
		expect(once.result).toBe("applied");
		const again = await arrive(fake, raw, to, once.sesId);
		expect(again.result).toBe("duplicate");
		const [conversation] = await conversationsOf(support.id);
		expect(conversation?.messages).toBe(1);
		const deliveries = await db
			.select()
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.webhook_id, hook.id));
		expect(deliveries.map((d) => d.event_type).sort()).toEqual([
			"inbox.conversation.created",
			"inbox.message.received",
		]);
		const payload = JSON.parse(deliveries[0]?.payload ?? "{}");
		expect(payload.data).toMatchObject({
			inbox_id: support.id,
			conversation_id: conversation?.id,
		});
		expect(payload.data.text).toBeUndefined();
	});

	it("sends an inbox's events only to its own webhooks and the organization's", async () => {
		const { org, support, invoices } = await setUp();
		const fake = fakeAws();
		const mine = await createWebhook(org.id, {
			url: "https://app.test/support",
			events: ["inbox.message.received"],
			inbox_id: support.id,
		});
		const theirs = await createWebhook(org.id, {
			url: "https://app.test/invoices",
			events: ["inbox.message.received"],
			inbox_id: invoices.id,
		});
		const everyone = await createWebhook(org.id, {
			url: "https://app.test/all",
			events: ["inbox.message.received"],
		});
		await expect(
			createWebhook(org.id, {
				url: "https://app.test/bad",
				events: ["email.sent"],
				inbox_id: support.id,
			}),
		).rejects.toMatchObject({ status: 422 });
		const other = await setUp();
		await expect(
			createWebhook(other.org.id, {
				url: "https://app.test/steal",
				events: ["inbox.message.received"],
				inbox_id: support.id,
			}),
		).rejects.toMatchObject({ status: 404 });
		await arrive(fake, mail({ to: [support.address], id: `w-${uid()}@guest.test` }), [
			support.address,
		]);
		const count = async (id: string) =>
			(
				await db
					.select()
					.from(schema.webhookDeliveries)
					.where(eq(schema.webhookDeliveries.webhook_id, id))
			).length;
		expect(await count(mine.id)).toBe(1);
		expect(await count(theirs.id)).toBe(0);
		expect(await count(everyone.id)).toBe(1);
	});
});

describe("replies", () => {
	it("lets an agent reply only to people in the conversation, within the inbox's lists", async () => {
		const { org, support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		await arrive(fake, mail({ to, id: `r-${uid()}@guest.test` }), to);
		const [conversation] = await conversationsOf(support.id);
		const { token } = await credential(support, ["send"]);
		const stranger = await api(token, `/conversations/${conversation?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Hi", to: "someone@else.test" }),
		});
		expect(stranger.status).toBe(403);
		expect((await stranger.json()).name).toBe("recipient_not_in_conversation");
		const ok = await api(token, `/conversations/${conversation?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Attached is invoice 1042." }),
		});
		expect(ok.status).toBe(201);
		const reply = await ok.json();
		expect(reply).toMatchObject({ status: "sent", to: ["Ana Guest <ana@guest.test>"] });
		expect(fake.sends).toHaveLength(1);
		const sent = JSON.stringify(fake.sends[0]?.body);
		expect(sent).toContain(`support@${org.domain}`);
		const stored = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, conversation?.id as string))
			.get();
		expect(stored).toMatchObject({ replied_by: "agent", messages: 2 });
		// The inbox's block list holds for everyone, even a credential that writes to anyone.
		await db
			.update(schema.inboxes)
			.set({ send_block: ["guest.test"] })
			.where(eq(schema.inboxes.id, support.id));
		const blocked = await api(token, `/conversations/${conversation?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Again" }),
		});
		expect(blocked.status).toBe(403);
		expect((await blocked.json()).name).toBe("recipient_blocked");
		const anyone = await credential(support, ["send"], "anyone");
		const free = await api(anyone.token, `/conversations/${conversation?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Hi", to: "new@person.test" }),
		});
		expect(free.status).toBe(201);
		await db
			.update(schema.inboxes)
			.set({ send_block: null, send_allow: ["partner.test"] })
			.where(eq(schema.inboxes.id, support.id));
		const notAllowed = await api(anyone.token, `/conversations/${conversation?.id}/reply`, {
			method: "POST",
			body: JSON.stringify({ text: "Hi", to: "new@person.test" }),
		});
		expect((await notAllowed.json()).name).toBe("recipient_not_allowed");
	});

	it("threads an answer to our reply into the same conversation", async () => {
		const { support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		const first = `t-${uid()}@guest.test`;
		await arrive(fake, mail({ to, id: first }), to);
		const [conversation] = await conversationsOf(support.id);
		const { token } = await credential(support, ["send"]);
		const reply = await (
			await api(token, `/conversations/${conversation?.id}/reply`, {
				method: "POST",
				body: JSON.stringify({ text: "Done" }),
			})
		).json();
		const sent = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, reply.email_id))
			.get();
		expect(sent?.message_id).toBeTruthy();
		// Their answer names our Message-ID (SES's) and not theirs.
		await arrive(
			fake,
			mail({
				to,
				id: `t2-${uid()}@guest.test`,
				inReplyTo: `${sent?.message_id}@email.amazonses.com`,
			}),
			to,
		);
		const list = await conversationsOf(support.id);
		expect(list).toHaveLength(1);
		expect(list[0]?.messages).toBe(3);
	});

	it("keeps an agent's draft for a person to approve, and read state per reader", async () => {
		const { org, support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		await arrive(fake, mail({ to, id: `d-${uid()}@guest.test` }), to);
		const [conversation] = await conversationsOf(support.id);
		const { token } = await credential(support, ["draft", "triage"]);
		const draft = await (
			await api(token, `/conversations/${conversation?.id}/drafts`, {
				method: "POST",
				body: JSON.stringify({ text: "Proposed answer" }),
			})
		).json();
		expect(draft).toMatchObject({ status: "draft", author: { type: "agent" } });
		expect((await api(token, `/drafts/${draft.id}/send`, { method: "POST" })).status).toBe(403);
		// The agent read it; for a person it's still unread.
		await api(token, `/conversations/${conversation?.id}?mark_read=true`);
		const agentView = await (await api(token, "/conversations")).json();
		expect(agentView.data[0].unread).toBe(false);
		const pat = await person(org.id);
		const before = await getConversation(pat, conversation?.id as string);
		expect(before.unread).toBe(true);
		expect(before.drafts).toBe(1);
		const sent = await sendReply(
			pat,
			conversation?.id as string,
			{},
			sender({ source: "dashboard" }),
			{
				draftId: draft.id,
			},
		);
		expect(sent).toMatchObject({ status: "sent", text: "Proposed answer", sent_by: "Pat" });
		expect(fake.sends).toHaveLength(1);
		const log = await db
			.select()
			.from(schema.inboxActivity)
			.where(
				and(
					eq(schema.inboxActivity.conversation_id, conversation?.id as string),
					eq(schema.inboxActivity.action, "reply.sent"),
				),
			)
			.get();
		expect(log?.detail).toMatchObject({ approved_draft_of: "Agent" });
	});
});

describe("MCP for agents", () => {
	it("shows only the tools the credential allows, on its inbox", async () => {
		const { support, invoices } = await setUp();
		const fake = fakeAws();
		await arrive(fake, mail({ to: [support.address], id: `p-${uid()}@guest.test` }), [
			support.address,
		]);
		await arrive(fake, mail({ to: [invoices.address], id: `q-${uid()}@guest.test` }), [
			invoices.address,
		]);
		const { token } = await credential(support);
		const actor = (await authenticateInbox(`Bearer ${token}`)) as InboxActor;
		const server = buildAgentServer(actor, support.address);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "agent", version: "1.0.0" });
		await Promise.all([server.connect(a), client.connect(b)]);
		const names = (await client.listTools()).tools.map((t) => t.name);
		expect(names).toContain("list_conversations");
		expect(names).not.toContain("send_reply");
		expect(names).not.toContain("save_draft");
		const r = await client.callTool({ name: "list_conversations", arguments: {} });
		const page = JSON.parse((r.content as { text: string }[])[0]?.text ?? "{}");
		expect(page.data).toHaveLength(1);
		expect(page.data[0].inbox_id).toBe(support.id);
		const [theirs] = await conversationsOf(invoices.id);
		const denied = await client.callTool({
			name: "get_conversation",
			arguments: { id: theirs?.id },
		});
		expect(denied.isError).toBe(true);
	});

	it("serves /mcp with a credential and no OAuth", async () => {
		const { support } = await setUp();
		fakeAws();
		const { token } = await credential(support);
		const { handleOAuth } = await import("@/server/mcp/oauth");
		const res = await handleOAuth(
			new Request("https://mailroom.test/mcp", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			}),
			{} as Env,
			{} as ExecutionContext,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Json;
		expect(body.result.tools.map((t: { name: string }) => t.name)).toContain(
			"get_conversation",
		);
		const bad = await handleOAuth(
			new Request("https://mailroom.test/mcp", {
				method: "POST",
				headers: { authorization: `Bearer mri_${"x".repeat(40)}` },
			}),
			{} as Env,
			{} as ExecutionContext,
		);
		expect(bad.status).toBe(401);
	});
});

describe("credentials for several inboxes", () => {
	it("reach the inboxes they name, or every inbox of the brand (new ones too), and no other brand's", async () => {
		const { org, support, invoices } = await setUp();
		const sales = await createInbox(org.id, {
			name: "Sales",
			local_part: "sales",
			domain: org.domain,
		});
		const fake = fakeAws();
		for (const inbox of [support, invoices, sales])
			await arrive(fake, mail({ to: [inbox.address], id: `m-${uid()}@guest.test` }), [
				inbox.address,
			]);
		const two = await createCredential(support, {
			name: "Two",
			scope: "inboxes",
			inbox_ids: [invoices.id],
		});
		const seen = await (await api(two.token, "/conversations")).json();
		expect(new Set(seen.data.map((c: Json) => c.inbox_id))).toEqual(
			new Set([support.id, invoices.id]),
		);
		expect((await api(two.token, `/inboxes/${sales.id}`)).status).toBe(404);
		const all = await createCredential(support, { name: "All", scope: "brand" });
		const later = await createInbox(org.id, {
			name: "Later",
			local_part: "later",
			domain: org.domain,
		});
		const inboxes = await (await api(all.token, "/inboxes")).json();
		expect(inboxes.data.map((i: Json) => i.id)).toContain(later.id);
		// Another brand's inbox can't be named.
		const other = await setUp();
		await expect(
			createCredential(support, {
				name: "Bad",
				scope: "inboxes",
				inbox_ids: [other.support.id],
			}),
		).rejects.toThrow();
		expect((await api(all.token, `/inboxes/${other.support.id}`)).status).toBe(404);
	});
});

describe("timeline pages", () => {
	it("pages a long conversation back with `before`", async () => {
		const { support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		const first = `p-${uid()}@guest.test`;
		await arrive(fake, mail({ to, id: first }), to);
		let parent = first;
		for (let i = 0; i < 4; i++) {
			const id = `p-${uid()}@guest.test`;
			await arrive(fake, mail({ to, id, inReplyTo: parent, references: [first] }), to);
			parent = id;
		}
		const [conversation] = await conversationsOf(support.id);
		const { token } = await credential(support);
		const page1 = await (await api(token, `/conversations/${conversation?.id}?limit=2`)).json();
		expect(page1.timeline).toHaveLength(2);
		expect(page1.has_more).toBe(true);
		const page2 = await (
			await api(token, `/conversations/${conversation?.id}?limit=2&before=${page1.before}`)
		).json();
		const page3 = await (
			await api(token, `/conversations/${conversation?.id}?limit=2&before=${page2.before}`)
		).json();
		expect(page3.has_more).toBe(false);
		const ids = [...page3.timeline, ...page2.timeline, ...page1.timeline].map(
			(t: Json) => t.id,
		);
		expect(new Set(ids).size).toBe(5);
	});
});

describe("read state per message", () => {
	it("marks single messages read or unread for one reader", async () => {
		const { org, support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		const first = `u-${uid()}@guest.test`;
		await arrive(fake, mail({ to, id: first }), to);
		await arrive(fake, mail({ to, id: `u-${uid()}@guest.test`, inReplyTo: first }), to);
		const [conversation] = await conversationsOf(support.id);
		const { token } = await credential(support);
		const open = await (await api(token, `/conversations/${conversation?.id}`)).json();
		expect(open.timeline.map((t: Json) => t.unread)).toEqual([true, true]);
		const [m1, m2] = open.timeline;
		// Reading one message leaves the conversation unread.
		await api(token, `/messages/${m1.id}?mark_read=true`);
		let list = await (await api(token, "/conversations?unread=true")).json();
		expect(list.data).toHaveLength(1);
		await api(token, `/messages/${m2.id}`, {
			method: "PATCH",
			body: JSON.stringify({ read: true }),
		});
		list = await (await api(token, "/conversations?unread=true")).json();
		expect(list.data).toHaveLength(0);
		// Read whole, then the first message unread again: only it is.
		await api(token, `/conversations/${conversation?.id}?mark_read=true`);
		await api(token, `/messages/${m1.id}`, {
			method: "PATCH",
			body: JSON.stringify({ read: false }),
		});
		const again = await (await api(token, `/conversations/${conversation?.id}`)).json();
		expect(again.unread).toBe(true);
		expect(again.timeline.map((t: Json) => t.unread)).toEqual([true, false]);
		// Nobody else's state changed.
		const pat = await person(org.id);
		const theirs = await getConversation(pat, conversation?.id as string);
		expect(theirs.timeline.map((t) => (t.type === "inbound" ? t.unread : null))).toEqual([
			true,
			true,
		]);
	});
});

describe("reply attachments", () => {
	it("keeps a draft's files, sends them, and sends on received ones only with the permission", async () => {
		const { support } = await setUp();
		const fake = fakeAws();
		const to = [support.address];
		const raw = [
			"From: Ana Guest <ana@guest.test>",
			`To: ${support.address}`,
			"Subject: Itinerary",
			`Message-ID: <a-${uid()}@guest.test>`,
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b1"',
			"",
			"--b1",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"Here it is.",
			"--b1",
			'Content-Type: application/pdf; name="itinerary.pdf"',
			'Content-Disposition: attachment; filename="itinerary.pdf"',
			"Content-Transfer-Encoding: base64",
			"",
			btoa("%PDF-1.4 fake"),
			"--b1--",
			"",
		].join("\r\n");
		await arrive(fake, raw, to);
		const [conversation] = await conversationsOf(support.id);
		const drafter = await credential(support, ["draft"]);
		const draft = await (
			await api(drafter.token, `/conversations/${conversation?.id}/drafts`, {
				method: "POST",
				body: JSON.stringify({
					text: "Your invoice is attached.",
					attachments: [
						{
							filename: "invoice.txt",
							content: btoa("Invoice 1042"),
							content_type: "text/plain",
						},
					],
				}),
			})
		).json();
		expect(draft.attachments).toMatchObject([{ filename: "invoice.txt", size: 12 }]);
		expect(draft.attachments[0].key).toBeUndefined();
		const message = (
			await (await api(drafter.token, `/conversations/${conversation?.id}`)).json()
		).timeline[0];
		const attachment = message.attachments[0];
		// Sending on a received attachment needs "attachments".
		const refused = await api(drafter.token, `/drafts/${draft.id}`, {
			method: "PATCH",
			body: JSON.stringify({
				attachments: [
					{ id: draft.attachments[0].id },
					{ message_id: message.id, attachment_id: attachment.id },
				],
			}),
		});
		expect(refused.status).toBe(403);
		const sender_ = await credential(support, ["draft", "send", "attachments"]);
		const sent = await (
			await api(sender_.token, `/drafts/${draft.id}/send`, {
				method: "POST",
				body: JSON.stringify({
					attachments: [
						{ id: draft.attachments[0].id },
						{ message_id: message.id, attachment_id: attachment.id },
					],
				}),
			})
		).json();
		expect(sent.status).toBe("sent");
		expect(sent.attachments.map((a: Json) => a.filename)).toEqual([
			"invoice.txt",
			"itinerary.pdf",
		]);
		expect(fake.sends).toHaveLength(1);
		const body = await db
			.select()
			.from(schema.emailBodies)
			.where(eq(schema.emailBodies.email_id, sent.email_id))
			.get();
		expect(body?.attachments?.map((a) => a.filename)).toEqual(["invoice.txt", "itinerary.pdf"]);
	});
});
