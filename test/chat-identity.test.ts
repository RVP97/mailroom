import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { saveChatWidget, setIdentitySecret } from "@/server/chat";
import { verifyIdentity } from "@/server/chat-identity";
import { handleChat, publicConfig } from "@/server/chat-public";
import { db, schema } from "@/server/db";
import { createInbox } from "@/server/inboxes";
import { setSetting } from "@/server/settings";
import { seedOrg, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const SITE = "https://app.acme-books.test";

beforeAll(async () => {
	await useTopic();
	await setSetting("aws_account_id", "123456789012");
	await setSetting("inbound_bucket", "mailroom-inbound-123456789012-us-east-1");
	await setSetting("inbound_rule_set", "mailroom");
	await setSetting("inbound_set_up_at", new Date().toISOString());
});

// biome-ignore lint/suspicious/noExplicitAny: the endpoints' answers, read loosely in tests
type Json = any;

const b64url = (raw: Uint8Array | string) =>
	btoa(String.fromCharCode(...(typeof raw === "string" ? new TextEncoder().encode(raw) : raw)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

/** An HS256 JWT, as the website's server makes it. */
async function sign(secret: string, payload: Record<string, unknown>, alg = "HS256") {
	const h = b64url(JSON.stringify({ alg, typ: "JWT" }));
	const p = b64url(JSON.stringify(payload));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(
		await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${h}.${p}`)),
	);
	return `${h}.${p}.${b64url(sig)}`;
}

const soon = () => Math.floor(Date.now() / 1000) + 3600;

async function receivingInbox() {
	const org = await seedOrg();
	await db
		.update(schema.domains)
		.set({
			receiving: true,
			receiving_status: "active",
			receiving_host: org.domain,
			sending: true,
		})
		.where(eq(schema.domains.id, org.domainId));
	const inbox = await createInbox(org.id, {
		name: "Soporte",
		local_part: "soporte",
		domain: org.domain,
	});
	return { org, inbox };
}

async function setUp(required = false) {
	const { org, inbox } = await receivingInbox();
	await saveChatWidget(
		inbox,
		{
			origins: ["acme-books.test"],
			notify: ["owner@acme-books.test"],
			design: { language: "es" },
		},
		{ userId: null },
	);
	const { widget, secret } = await setIdentitySecret(inbox, true);
	if (required) await saveChatWidget(inbox, { identity_required: true });
	return { org, inbox, widget, secret: secret as string };
}

async function call(key: string, action: string, o: { body?: unknown; token?: string } = {}) {
	const headers: Record<string, string> = { origin: SITE };
	if (o.token) headers.authorization = `Bearer ${o.token}`;
	if (o.body) headers["content-type"] = "application/json";
	const res = await handleChat(
		new Request(`https://mailroom.test/chat/${key}/${action}`, {
			method: o.body ? "POST" : "GET",
			headers,
			body: o.body ? JSON.stringify(o.body) : undefined,
		}),
	);
	return { status: res.status, json: (await res.json().catch(() => null)) as Json };
}

describe("website chat: identity verification", () => {
	it("verifies HS256 tokens signed with the widget's secret and nothing else", async () => {
		const secret = `mrcs_${uid()}`;
		const good = await sign(secret, {
			sub: "user_1",
			email: "Ana@Acme.test",
			name: "Ana",
			attributes: {
				empresa: "Acme SA",
				rfc: "AAA010101AAA",
				seats: 3,
				pro: true,
				x: { no: 1 },
			},
			exp: soon(),
		});
		const who = await verifyIdentity(secret, good);
		expect(who).toMatchObject({
			userId: "user_1",
			email: "ana@acme.test",
			name: "Ana",
			attributes: { empresa: "Acme SA", rfc: "AAA010101AAA", seats: 3, pro: true },
		});
		expect(who.attributes).not.toHaveProperty("x");
		await expect(verifyIdentity("mrcs_other", good)).rejects.toMatchObject({
			code: "invalid_identity",
		});
		await expect(
			verifyIdentity(secret, await sign(secret, { sub: "u", exp: 10 })),
		).rejects.toThrow(/expired/);
		await expect(
			verifyIdentity(secret, await sign(secret, { sub: "u", exp: soon() + 90 * 86_400 })),
		).rejects.toThrow(/too far/);
		await expect(
			verifyIdentity(secret, await sign(secret, { sub: "u", exp: soon() }, "none")),
		).rejects.toThrow(/HS256/);
		await expect(verifyIdentity(secret, await sign(secret, { exp: soon() }))).rejects.toThrow(
			/sub/,
		);
		// A tampered payload keeps the old signature.
		const [h, , s] = good.split(".");
		const forged = `${h}.${b64url(JSON.stringify({ sub: "admin", exp: soon() }))}.${s}`;
		await expect(verifyIdentity(secret, forged)).rejects.toThrow(/signature/);
	});

	it("starts a verified chat without the robot check, with the site's details", async () => {
		const { widget, secret } = await setUp();
		const identity = await sign(secret, {
			sub: "user_42",
			email: "ana@acme.test",
			name: "Ana López",
			attributes: { empresa: "Acme SA" },
			exp: soon(),
		});
		const r = await call(widget.public_key, "start", {
			body: { text: "¿Cómo cancelo una factura?", client_id: uid(), identity },
		});
		expect(r.status).toBe(201);
		expect(r.json.conversation.visitor).toMatchObject({
			verified: true,
			user_id: "user_42",
			email: "ana@acme.test",
			name: "Ana López",
			attributes: { empresa: "Acme SA" },
		});
		const row = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, r.json.conversation.id))
			.get();
		expect(row?.contact).toBe("ana@acme.test");
		// The visitor can't overwrite what the site signed.
		await call(widget.public_key, "profile", {
			token: r.json.token,
			body: { email: "someone@else.test" },
		});
		const after = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, r.json.conversation.id))
			.get();
		expect(after?.visitor_email).toBe("ana@acme.test");
	});

	it("brings the person's chat back on another browser, and forgets someone else's", async () => {
		const { widget, secret } = await setUp();
		const ana = await sign(secret, { sub: "ana", email: "ana@acme.test", exp: soon() });
		const first = await call(widget.public_key, "start", {
			body: { text: "Hola", client_id: uid(), identity: ana },
		});
		// Another browser: no visitor token, the same person.
		const back = await call(widget.public_key, "identify", { body: { identity: ana } });
		expect(back.status).toBe(200);
		expect(back.json.status).toBe("resumed");
		expect(back.json.token).toMatch(/^mrv_/);
		expect(back.json.token).not.toBe(first.json.token);
		expect(back.json.conversation.id).toBe(first.json.conversation.id);
		expect(back.json.messages.map((m: Json) => m.text)).toContain("Hola");
		// The new token works for the same chat.
		const more = await call(widget.public_key, "messages", {
			token: back.json.token,
			body: { text: "Sigo aquí", client_id: uid() },
		});
		expect(more.status).toBe(201);
		// The same browser, someone else signed in: the chat isn't theirs.
		const beto = await sign(secret, { sub: "beto", exp: soon() });
		const other = await call(widget.public_key, "identify", {
			token: back.json.token,
			body: { identity: beto },
		});
		expect(other.json).toEqual({ status: "other_person" });
		const fresh = await call(widget.public_key, "identify", { body: { identity: beto } });
		expect(fresh.json).toEqual({ status: "none" });
		// A forged token gets nothing.
		const forged = await sign("mrcs_wrong", { sub: "ana", exp: soon() });
		const no = await call(widget.public_key, "identify", { body: { identity: forged } });
		expect(no.status).toBe(401);
	});

	it("only lets signed-in people chat when required", async () => {
		const { widget, secret } = await setUp(true);
		const anon = await call(widget.public_key, "start", {
			body: { text: "Hola", client_id: uid() },
		});
		expect(anon.status).toBe(401);
		expect(anon.json.error.code).toBe("identity_required");
		const ok = await call(widget.public_key, "start", {
			body: {
				text: "Hola",
				client_id: uid(),
				identity: await sign(secret, { sub: "u1", exp: soon() }),
			},
		});
		expect(ok.status).toBe(201);
	});

	it("needs the secret before requiring it, and turning it off lifts the rule", async () => {
		const { inbox } = await receivingInbox();
		await saveChatWidget(inbox, { origins: ["acme-books.test"] });
		await expect(saveChatWidget(inbox, { identity_required: true })).rejects.toThrow(
			/identity secret/,
		);
		await setIdentitySecret(inbox, true);
		const { widget } = await saveChatWidget(inbox, { identity_required: true });
		expect(widget.identity_required).toBe(true);
		const off = await setIdentitySecret(inbox, false);
		expect(off.widget.identity_secret).toBeNull();
		expect(off.widget.identity_required).toBe(false);
	});

	it("tells the widget its language and never the secret", async () => {
		const { widget, inbox } = await setUp(true);
		const w = await db
			.select()
			.from(schema.chatWidgets)
			.where(eq(schema.chatWidgets.inbox_id, inbox.id))
			.get();
		const cfg = await publicConfig({ widget: w as typeof widget, inbox });
		expect(cfg.language).toBe("es");
		// Texts it wasn't given come in Spanish too.
		expect(cfg.away).toMatch(/^Gracias/);
		expect(cfg.placeholder).toBe("Escriba un mensaje…");
		expect(cfg.identity_required).toBe(true);
		expect(JSON.stringify(cfg)).not.toContain("mrcs_");
	});
});
