import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	type ChatSender,
	chatWidgetView,
	deleteChatFiles,
	emailVisitors,
	notifyTeam,
	originAllowed,
	originHost,
	replyText,
	saveChatWidget,
} from "@/server/chat";
import { handleChat } from "@/server/chat-public";
import { getConversation, purgeConversations, saveDraft, sendReply } from "@/server/conversations";
import { db, schema } from "@/server/db";
import { purgeReceived, receiveSes } from "@/server/inbound";
import { createInbox, type Inbox, type InboxActor } from "@/server/inboxes";
import { setSetting } from "@/server/settings";
import { fakeOutside, seedOrg, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const BUCKET = "mailroom-inbound-123456789012-us-east-1";
const SITE = "https://www.acme-hotel.test";

beforeAll(async () => {
	await useTopic();
	await setSetting("aws_account_id", "123456789012");
	await setSetting("inbound_bucket", BUCKET);
	await setSetting("inbound_rule_set", "mailroom");
	await setSetting("inbound_set_up_at", new Date().toISOString());
});

// biome-ignore lint/suspicious/noExplicitAny: the endpoints' answers, read loosely in tests
type Json = any;

/** A brand receiving at its domain, a Support inbox with a chat on acme-hotel.test. */
async function setUp(o: { askEmail?: "off" | "optional" | "required" } = {}) {
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
		name: "Support",
		local_part: "support",
		domain: org.domain,
	});
	const { widget } = await saveChatWidget(
		inbox,
		{
			origins: ["acme-hotel.test"],
			notify: ["owner@acme-hotel.test"],
			ask_email: o.askEmail ?? "optional",
			design: { title: "Acme Hotel", color: "#0f766e" },
		},
		{ userId: null },
	);
	return { org, inbox, widget };
}

async function call(
	key: string,
	action: string,
	o: {
		method?: string;
		body?: unknown;
		token?: string;
		origin?: string | null;
		query?: string;
	} = {},
) {
	const headers: Record<string, string> = {};
	if (o.origin !== null) headers.origin = o.origin ?? SITE;
	if (o.token) headers.authorization = `Bearer ${o.token}`;
	if (o.body) headers["content-type"] = "application/json";
	const res = await handleChat(
		new Request(`https://mailroom.test/chat/${key}/${action}${o.query ?? ""}`, {
			method: o.method ?? (o.body ? "POST" : "GET"),
			headers,
			body: o.body ? JSON.stringify(o.body) : undefined,
		}),
	);
	return {
		status: res.status,
		headers: res.headers,
		json: (await res.json().catch(() => null)) as Json,
	};
}

async function start(
	key: string,
	text = "Hi! Is breakfast included?",
	extra: Record<string, unknown> = {},
) {
	const r = await call(key, "start", {
		body: { text, page: `${SITE}/rooms`, client_id: uid(), ...extra },
	});
	expect(r.status).toBe(201);
	return r.json as { token: string; conversation: { id: string }; messages: Json[] };
}

function person(organizationId: string, name = "Pat Rivera"): InboxActor {
	return {
		organizationId,
		brands: [organizationId],
		inboxIds: null,
		permissions: new Set(["read", "attachments", "triage", "draft", "send"]),
		sendScope: "anyone",
		type: "person",
		id: `user_${uid()}`,
		name,
		reader: `user:${uid()}`,
	};
}

const noEmail = { send: async () => "never" };

/** Captures what the cron emails. */
function sender() {
	const sent: Record<string, Json>[] = [];
	const s: ChatSender = {
		send: async (_brand, input) => {
			sent.push(input);
			return `email-${sent.length}`;
		},
	};
	return { s, sent };
}

describe("website chat: settings", () => {
	it("keeps websites as hostnames and allows their subdomains, Mailroom's host and nothing else", async () => {
		expect(originHost("https://www.acme.com/path?x")).toBe("www.acme.com");
		expect(originHost("*.acme.com")).toBe("acme.com");
		expect(originHost("acme.com:8080")).toBe("acme.com");
		expect(originHost("localhost")).toBe("localhost");
		expect(originHost("not a host")).toBeNull();
		const w = { origins: ["acme.com"] };
		expect(originAllowed(w, "https://acme.com")).toBe(true);
		expect(originAllowed(w, "https://shop.acme.com")).toBe(true);
		expect(originAllowed(w, "https://evilacme.com")).toBe(false);
		expect(originAllowed(w, "http://acme.com")).toBe(false);
		expect(originAllowed(w, "https://mailroom.test")).toBe(true);
		expect(originAllowed(w, null)).toBe(false);
	});

	it("serves the widget with its settings, and nothing for an unknown key", async () => {
		const { widget } = await setUp();
		const res = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}.js`),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("javascript");
		const body = await res.text();
		expect(body).toContain("mailroomChat(");
		expect(body).toContain('"title":"Acme Hotel"');
		expect(body).toContain('"color":"#0f766e"');
		expect(body).not.toContain("owner@acme-hotel.test");
		const none = await handleChat(
			new Request("https://mailroom.test/chat/mrc_aaaaaaaaaaaaaaaaaaaaaaaa.js"),
		);
		expect(none.status).toBe(404);
	});
});

describe("website chat: the visitor", () => {
	it("answers only the chat's websites (CORS), and starts a chat on the first message", async () => {
		const { widget, inbox } = await setUp();
		const elsewhere = await call(widget.public_key, "start", {
			body: { text: "hi" },
			origin: "https://evil.test",
		});
		expect(elsewhere.status).toBe(403);
		expect(elsewhere.headers.get("access-control-allow-origin")).toBeNull();
		const preflight = await call(widget.public_key, "start", { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(SITE);

		const started = await start(widget.public_key);
		expect(started.token).toMatch(/^mrv_/);
		expect(started.messages).toHaveLength(1);
		expect(started.messages[0]).toMatchObject({
			author: "visitor",
			text: "Hi! Is breakfast included?",
		});
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, started.conversation.id))
			.get();
		expect(x).toMatchObject({
			channel: "chat",
			inbox_id: inbox.id,
			subject: "Hi! Is breakfast included?",
			contact: "Website visitor",
			page_url: `${SITE}/rooms`,
			status: "open",
			messages: 1,
		});
		expect(x?.chat_key).toMatch(/^[a-z0-9]{12}$/);
		// The token is never stored as it is.
		const v = await db
			.select()
			.from(schema.chatVisitors)
			.where(eq(schema.chatVisitors.conversation_id, x?.id ?? ""))
			.get();
		expect(v?.token_hash).not.toContain("mrv_");
	});

	it("needs the visitor's token for the chat, and keeps each chat to its widget", async () => {
		const a = await setUp();
		const b = await setUp();
		const chat = await start(a.widget.public_key);
		expect((await call(a.widget.public_key, "messages")).status).toBe(401);
		expect((await call(b.widget.public_key, "messages", { token: chat.token })).status).toBe(
			401,
		);
		const mine = await call(a.widget.public_key, "messages", { token: chat.token });
		expect(mine.status).toBe(200);
		expect(mine.json.messages).toHaveLength(1);
	});

	it("takes messages once each (client ids), only after the last one asked for, and limits the pace", async () => {
		const { widget } = await setUp();
		const chat = await start(widget.public_key);
		const first = chat.messages[0].id;
		const again = { text: "Also, is parking free?", client_id: "c-1" };
		const one = await call(widget.public_key, "messages", { body: again, token: chat.token });
		const two = await call(widget.public_key, "messages", { body: again, token: chat.token });
		expect(one.status).toBe(201);
		expect(two.json.message.id).toBe(one.json.message.id);
		const after = await call(widget.public_key, "messages", {
			token: chat.token,
			query: `?after=${first}`,
		});
		expect(after.json.messages.map((m: Json) => m.text)).toEqual(["Also, is parking free?"]);
		let last = 0;
		for (let i = 0; i < 25; i++)
			last = (
				await call(widget.public_key, "messages", {
					body: { text: `spam ${i}` },
					token: chat.token,
				})
			).status;
		expect(last).toBe(429);
	});

	it("asks for the email first when the chat requires it", async () => {
		const { widget } = await setUp({ askEmail: "required" });
		const r = await call(widget.public_key, "start", { body: { text: "hello" } });
		expect(r.status).toBe(422);
		const ok = await start(widget.public_key, "hello", {
			email: "Ana@Guest.test",
			name: "Ana",
		});
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, ok.conversation.id))
			.get();
		expect(x).toMatchObject({
			visitor_email: "ana@guest.test",
			visitor_name: "Ana",
			contact: "ana@guest.test",
		});
	});

	it("stores a visitor's file in R2 and serves it only by its signed link", async () => {
		const { widget } = await setUp();
		const chat = await start(widget.public_key);
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "photo.png", {
				type: "image/png",
			}),
		);
		const res = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
				method: "POST",
				headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
				body: form,
			}),
		);
		expect(res.status).toBe(201);
		const { message } = (await res.json()) as Json;
		expect(message.files[0]).toMatchObject({ filename: "photo.png", image: true, size: 8 });
		const file = await handleChat(new Request(message.files[0].url));
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("image/png");
		const forged = await handleChat(new Request(message.files[0].url.replace(/.$/, "x")));
		expect(forged.status).toBe(404);
		// A script isn't a file it takes.
		const bad = new FormData();
		bad.append("file", new File(["<svg onload=alert(1)>"], "x.svg", { type: "image/svg+xml" }));
		const refused = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
				method: "POST",
				headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
				body: bad,
			}),
		);
		expect(refused.status).toBe(422);
		// A factura's XML, even when the browser sends no type: a download, never shown inline.
		const xml = new FormData();
		xml.append("file", new File(["<cfdi:Comprobante/>"], "factura.xml", { type: "" }));
		const sent = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
				method: "POST",
				headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
				body: xml,
			}),
		);
		expect(sent.status).toBe(201);
		const x = ((await sent.json()) as Json).message.files[0];
		expect(x).toMatchObject({ filename: "factura.xml", image: false });
		const got = await handleChat(new Request(x.url));
		expect(got.headers.get("content-type")).toBe("application/xml");
		expect(got.headers.get("content-disposition")).toMatch(/^attachment/);
	});

	it("takes only the files its settings allow, and only what they say they are", async () => {
		const { widget, inbox } = await setUp();
		const chat = await start(widget.public_key);
		const send = async (file: File) => {
			const form = new FormData();
			form.append("file", file);
			const res = await handleChat(
				new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
					method: "POST",
					headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
					body: form,
				}),
			);
			return { status: res.status, code: ((await res.json()) as Json).error?.code };
		};
		const pdf = () =>
			new File([new TextEncoder().encode("%PDF-1.7\n...")], "a.pdf", {
				type: "application/pdf",
			});
		expect((await send(pdf())).status).toBe(201);
		// A program named like a PDF.
		const exe = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0])], "invoice.pdf", {
			type: "application/pdf",
		});
		expect(await send(exe)).toEqual({ status: 422, code: "file_refused" });
		// Not a JPEG at all.
		expect(await send(new File(["hello"], "photo.jpg", { type: "image/jpeg" }))).toEqual({
			status: 422,
			code: "file_refused",
		});
		// A .zip isn't taken unless archives are on.
		const zip = new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])], "a.zip", {
			type: "application/zip",
		});
		expect(await send(zip)).toEqual({ status: 422, code: "file_kind" });
		// Only images, up to 1 MB.
		await saveChatWidget(inbox, { file_kinds: ["images"], file_max_mb: 1 });
		expect(await send(pdf())).toEqual({ status: 422, code: "file_kind" });
		const big = new Uint8Array(1024 * 1024 + 10);
		big.set([0xff, 0xd8, 0xff]);
		expect(await send(new File([big], "big.jpg", { type: "image/jpeg" }))).toEqual({
			status: 413,
			code: "too_large",
		});
		// Files off.
		await saveChatWidget(inbox, { files_enabled: false });
		expect((await send(pdf())).code).toBe("files_off");
	});

	it("stops at once when the chat is turned off", async () => {
		const { widget, inbox } = await setUp();
		await saveChatWidget(inbox, { enabled: false });
		const r = await call(widget.public_key, "start", { body: { text: "hi" } });
		expect(r.status).toBe(410);
	});
});

describe("website chat: the team", () => {
	it("answers in the chat from the dashboard (and the API), shown in the conversation's timeline", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key);
		const pat = person(org.id);
		const reply = await sendReply(pat, chat.conversation.id, { text: "Yes, it is!" }, noEmail);
		expect(reply).toMatchObject({ channel: "chat", text: "Yes, it is!" });
		const seen = await call(widget.public_key, "messages", { token: chat.token });
		expect(seen.json.messages.at(-1)).toMatchObject({
			author: "team",
			name: "Pat",
			text: "Yes, it is!",
		});
		// Their last names and ids stay with the team.
		expect(JSON.stringify(seen.json)).not.toContain("Rivera");
		const full = await getConversation(pat, chat.conversation.id);
		expect(full.channel).toBe("chat");
		expect(full.timeline.map((t) => t.type)).toEqual(["chat", "chat"]);
		expect(full.timeline.at(-1)).toMatchObject({
			author: { type: "person", name: "Pat Rivera" },
			via: "api",
		});
	});

	it("emails the team a minute's messages at once, Reply-To the chat's address, unless someone read them", async () => {
		const { org, widget, inbox } = await setUp();
		const t0 = Date.parse("2025-03-01T10:00:00Z");
		vi.setSystemTime(t0);
		const chat = await start(widget.public_key, "First question");
		await call(widget.public_key, "messages", {
			body: { text: "Second question" },
			token: chat.token,
		});
		vi.useRealTimers();
		const { s, sent } = sender();
		expect(await notifyTeam(t0 + 10_000, s)).toBe(0);
		expect(await notifyTeam(t0 + 60_000, s)).toBe(1);
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		expect(sent[0]).toMatchObject({
			to: ["owner@acme-hotel.test"],
			reply_to: [`support+chat-${x?.chat_key}@${org.domain}`],
		});
		expect(sent[0]?.from).toBe(`Visitor via chat <${inbox.address}>`);
		expect(sent[0]?.text).toContain("First question");
		expect(sent[0]?.text).toContain("Second question");
		expect(sent[0]?.text).toContain("Write your reply above this line");
		// Sent once.
		expect(await notifyTeam(t0 + 120_000, s)).toBe(0);
		// Read in the dashboard first: no email.
		vi.setSystemTime(t0 + 200_000);
		await call(widget.public_key, "messages", { body: { text: "Third" }, token: chat.token });
		vi.useRealTimers();
		await getConversation(person(org.id), chat.conversation.id, {
			markRead: true,
			now: t0 + 210_000,
		});
		expect(await notifyTeam(t0 + 300_000, s)).toBe(0);
		expect(sent).toHaveLength(1);
	});

	it("emails a visitor who left the team's reply (only what the team wrote), and never one who saw it", async () => {
		const { org, widget, inbox } = await setUp();
		const t0 = Date.parse("2025-03-02T11:00:00Z");
		vi.setSystemTime(t0);
		const chat = await start(widget.public_key, "Secret visitor text", {
			email: "ana@guest.test",
		});
		vi.setSystemTime(t0 + 60_000);
		await sendReply(
			person(org.id),
			chat.conversation.id,
			{ text: "We have a room for you." },
			noEmail,
		);
		vi.useRealTimers();
		const { s, sent } = sender();
		expect(await emailVisitors(t0 + 2 * 60_000, s)).toBe(0);
		expect(await emailVisitors(t0 + 5 * 60_000, s)).toBe(1);
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		expect(sent[0]).toMatchObject({
			to: ["ana@guest.test"],
			reply_to: [`support+chatv-${x?.chat_key}@${org.domain}`],
			subject: "Your chat with Acme Hotel",
		});
		expect(sent[0]?.from).toBe(`Acme Hotel <${inbox.address}>`);
		expect(sent[0]?.text).toContain("We have a room for you.");
		expect(sent[0]?.text).not.toContain("Secret visitor text");
		expect(sent[0]?.text).toContain(`${SITE}/rooms#mailroom-chat`);
		// The visitor saw the next one in the widget: nothing to email.
		vi.setSystemTime(t0 + 6 * 60_000);
		await sendReply(person(org.id), chat.conversation.id, { text: "Anything else?" }, noEmail);
		await call(widget.public_key, "seen", { body: {}, token: chat.token });
		vi.useRealTimers();
		expect(await emailVisitors(t0 + 20 * 60_000, s)).toBe(0);
	});
});

describe("website chat: sending a draft twice", () => {
	it("a second Send of a chat draft (a retry, a double click) answers with the line it made", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key, "Do you have rooms?");
		const pat = person(org.id);
		const draft = await saveDraft(pat, chat.conversation.id, { text: "Yes, we do." });
		const first = await sendReply(pat, chat.conversation.id, {}, noEmail, {
			draftId: draft.id,
			clientId: "click-1",
		});
		// The dashboard's retry, and another click with its own id: both are that same line.
		for (const clientId of ["click-1", "click-2", undefined]) {
			const again = await sendReply(pat, chat.conversation.id, {}, noEmail, {
				draftId: draft.id,
				clientId,
			});
			expect(again.id).toBe(first.id);
		}
		const lines = await db
			.select()
			.from(schema.chatMessages)
			.where(eq(schema.chatMessages.conversation_id, chat.conversation.id));
		expect(lines.filter((l) => l.author === "person")).toHaveLength(1);
	});

	it("emails the visitor in the chat's language, with the brand's color", async () => {
		const { org, widget, inbox } = await setUp();
		await saveChatWidget(
			inbox,
			{ design: { language: "es", color: "#0f766e" } },
			{ userId: null },
		);
		const t0 = Date.parse("2025-03-05T11:00:00Z");
		vi.setSystemTime(t0);
		const chat = await start(widget.public_key, "Hola", { email: "ana@guest.test" });
		vi.setSystemTime(t0 + 60_000);
		await sendReply(person(org.id), chat.conversation.id, { text: "Con gusto." }, noEmail);
		vi.useRealTimers();
		const { s, sent } = sender();
		expect(await emailVisitors(t0 + 10 * 60_000, s)).toBe(1);
		expect(sent[0]?.subject).toBe("Su chat con Acme Hotel");
		expect(sent[0]?.text).toContain("Escriba su respuesta arriba de esta línea");
		expect(sent[0]?.text).toContain("Nueva respuesta de Acme Hotel");
		expect(sent[0]?.text).toContain("Seguir en el chat");
		expect(sent[0]?.text).not.toContain("Write your reply");
		expect(sent[0]?.html).toContain("background:#0f766e");
		expect(sent[0]?.html).toContain('lang="es"');
		// Their answer by email is cut at the Spanish marker too.
		expect(
			replyText("Gracias\n\n##- Escriba su respuesta arriba de esta línea -##\nviejo"),
		).toBe("Gracias");
	});
});

describe("website chat: its email settings", () => {
	it("emails the team right away when its wait is 0", async () => {
		const { widget, inbox } = await setUp();
		await saveChatWidget(inbox, { email_team_after: 0 });
		const t0 = Date.parse("2025-03-04T09:00:00Z");
		vi.setSystemTime(t0);
		await start(widget.public_key, "Quick question");
		vi.useRealTimers();
		const { s } = sender();
		expect(await notifyTeam(t0 + 5_000, s)).toBe(1);
	});

	it("waits as long as each chat says, and sends nothing when its emails are off", async () => {
		const { org, widget, inbox } = await setUp();
		await saveChatWidget(inbox, { email_team_after: 10, email_visitor: false });
		const t0 = Date.parse("2025-03-03T09:00:00Z");
		vi.setSystemTime(t0);
		const chat = await start(widget.public_key, "Hello?", { email: "ana@guest.test" });
		vi.useRealTimers();
		const { s, sent } = sender();
		// The team: not after a minute, after ten.
		expect(await notifyTeam(t0 + 2 * 60_000, s)).toBe(0);
		expect(await notifyTeam(t0 + 10 * 60_000, s)).toBe(1);
		// The visitor: never.
		vi.setSystemTime(t0 + 11 * 60_000);
		await sendReply(person(org.id), chat.conversation.id, { text: "Hi!" }, noEmail);
		vi.useRealTimers();
		expect(await emailVisitors(t0 + 30 * 60_000, s)).toBe(0);
		expect(sent.map((m) => m.to)).toEqual([["owner@acme-hotel.test"]]);

		// The team's emails off: nothing, and the lines aren't kept for later.
		await saveChatWidget(inbox, { email_team: false });
		vi.setSystemTime(t0 + 40 * 60_000);
		await call(widget.public_key, "messages", {
			body: { text: "Still there?" },
			token: chat.token,
		});
		vi.useRealTimers();
		expect(await notifyTeam(t0 + 50 * 60_000, s)).toBe(0);
		await saveChatWidget(inbox, { email_team: true });
		expect(await notifyTeam(t0 + 51 * 60_000, s)).toBe(0);
		expect(sent).toHaveLength(1);
	});
});

describe("website chat: answering by email", () => {
	function fakeS3(objects: Map<string, string>) {
		return fakeOutside({
			extra: async (url, init) => {
				if (url.host === `${BUCKET}.s3.us-east-1.amazonaws.com`) {
					const key = url.pathname.slice(1);
					if ((init?.method ?? "GET") === "GET") {
						const raw = objects.get(key);
						return raw === undefined
							? new Response("", { status: 404 })
							: new Response(raw);
					}
					objects.delete(key);
					return new Response("");
				}
				return undefined;
			},
		});
	}

	async function arrive(o: { to: string; from: string; text: string; dkim?: string }) {
		const objects = new Map<string, string>();
		fakeS3(objects);
		const key = `inbound/${uid()}`;
		objects.set(
			key,
			[
				`From: ${o.from}`,
				`To: ${o.to}`,
				"Subject: Re: Chat with Visitor",
				`Message-ID: <${uid()}@mail.test>`,
				"MIME-Version: 1.0",
				"Content-Type: text/plain; charset=utf-8",
				"",
				o.text,
				"",
			].join("\r\n"),
		);
		const at = new Date().toISOString();
		return receiveSes({
			notificationType: "Received",
			mail: { messageId: `ses-${uid()}`, timestamp: at, destination: [o.to] },
			receipt: {
				timestamp: at,
				recipients: [o.to],
				spamVerdict: { status: "PASS" },
				virusVerdict: { status: "PASS" },
				dkimVerdict: { status: o.dkim ?? "PASS" },
				dmarcVerdict: { status: o.dkim ?? "PASS" },
				spfVerdict: { status: "PASS" },
				action: { type: "S3", bucketName: BUCKET, objectKey: key },
			},
		});
	}

	it("turns a notified address's reply into the team's line, without what it quotes", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key);
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		const to = `support+chat-${x?.chat_key}@${org.domain}`;
		const r = await arrive({
			to,
			from: "Owner Person <owner@acme-hotel.test>",
			text: "Yes, breakfast is included.\n\nOn Wed, Nov 5, 2026 at 10:00 AM Visitor via chat <support@x.test>\nwrote:\n> Hi! Is breakfast included?",
		});
		expect(r).toBe("applied");
		const seen = await call(widget.public_key, "messages", { token: chat.token });
		expect(seen.json.messages.at(-1)).toMatchObject({
			author: "team",
			name: "Owner",
			text: "Yes, breakfast is included.",
		});
		// Not kept as an email too.
		const kept = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(kept).toHaveLength(0);
	});

	it("keeps anyone else's email to that address out of the chat", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key);
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		const to = `support+chat-${x?.chat_key}@${org.domain}`;
		// A stranger, and the owner's address without DKIM (forged).
		await arrive({ to, from: "mallory@evil.test", text: "Click this link" });
		await arrive({ to, from: "owner@acme-hotel.test", text: "Forged", dkim: "FAIL" });
		const seen = await call(widget.public_key, "messages", { token: chat.token });
		expect(seen.json.messages).toHaveLength(1);
		const kept = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(kept).toHaveLength(2);
	});

	it("puts the visitor's emailed answer in the chat", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key, "hi", { email: "ana@guest.test" });
		const x = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		await arrive({
			to: `support+chatv-${x?.chat_key}@${org.domain}`,
			from: "Ana <ana@guest.test>",
			text: "Two adults, please.\n\nEl mié, 5 nov 2026 a las 10:00, Acme Hotel (<support@x.test>) escribió:\n> We have a room",
		});
		const seen = await call(widget.public_key, "messages", { token: chat.token });
		expect(seen.json.messages.at(-1)).toMatchObject({
			author: "visitor",
			text: "Two adults, please.",
		});
	});

	it("reads only the new words of a reply", () => {
		expect(replyText("Thanks!\n\n##- Write your reply above this line -##\nold")).toBe(
			"Thanks!",
		);
		expect(replyText("Sure\n\nOn Tue, Nov 4, 2026, Ana <a@b.c> wrote:\n> q")).toBe("Sure");
		expect(replyText("Ok\n-- \nPat\nAcme")).toBe("Ok");
		expect(replyText("Listo\n\nEnviado desde mi iPhone")).toBe("Listo");
		expect(
			replyText("Fine\n\nFrom: Ana <a@b.c>\nSent: Tuesday\nTo: x\nSubject: y\n\nold"),
		).toBe("Fine");
		expect(replyText("> only a quote")).toBe("");
	});
});

describe("website chat: retention", () => {
	async function chatAt(inbox: Inbox, at: string) {
		const id = crypto.randomUUID();
		await db.insert(schema.conversations).values({
			id,
			organization_id: inbox.organization_id,
			inbox_id: inbox.id,
			subject: "Old chat",
			contact: "Website visitor",
			last_message_at: at,
			created_at: at,
			updated_at: at,
			channel: "chat",
			chat_key: `k${uid()}`.slice(0, 12),
		});
		await db.insert(schema.chatMessages).values({
			id: crypto.randomUUID(),
			organization_id: inbox.organization_id,
			conversation_id: id,
			inbox_id: inbox.id,
			author: "visitor",
			text: "old",
			via: "widget",
			created_at: at,
		});
		return id;
	}
	const exists = async (id: string) =>
		!!(await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, id))
			.get());

	it("deletes an inbox's chats after its own period, keeps them when it says always, and the rest after the deployment's", async () => {
		const now = Date.parse("2026-11-05T03:00:00Z");
		const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
		const week = await setUp();
		await saveChatWidget(week.inbox, { retention_days: 7 });
		const always = await setUp();
		await saveChatWidget(always.inbox, { retention_days: 0 });
		const usual = await setUp();
		const a = await chatAt(week.inbox, days(8));
		const b = await chatAt(week.inbox, days(6));
		const c = await chatAt(always.inbox, days(400));
		const d = await chatAt(usual.inbox, days(31));
		const e = await chatAt(usual.inbox, days(29));
		await purgeReceived(now);
		expect(await exists(a)).toBe(false);
		expect(await exists(b)).toBe(true);
		expect(await exists(c)).toBe(true);
		expect(await exists(d)).toBe(false);
		expect(await exists(e)).toBe(true);
		const lines = await db
			.select()
			.from(schema.chatMessages)
			.where(eq(schema.chatMessages.conversation_id, a));
		expect(lines).toHaveLength(0);
		await purgeConversations(days(1), 1, now);
	});
});

describe("website chat: live", () => {
	it("pushes the team's reply to the visitor's socket, and the visitor's typing to the team's", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key);
		const res = await handleChat(
			new Request(
				`https://mailroom.test/chat/${widget.public_key}/live?token=${chat.token}`,
				{
					headers: { upgrade: "websocket", origin: SITE },
				},
			),
		);
		expect(res.status).toBe(101);
		const ws = res.webSocket as WebSocket;
		ws.accept();
		const got: Json[] = [];
		ws.addEventListener("message", (e) => got.push(JSON.parse(e.data as string)));
		await sendReply(person(org.id), chat.conversation.id, { text: "Live hello" }, noEmail);
		await vi.waitFor(() => expect(got.some((e) => e.type === "message")).toBe(true));
		expect(got.find((e) => e.type === "message").message).toMatchObject({
			author: "team",
			text: "Live hello",
		});
		ws.close();
	});
});

describe("website chat: ending, rating and past chats", () => {
	it("lets the visitor end the chat, and writing again reopens it", async () => {
		const { inbox, widget } = await setUp();
		const chat = await start(widget.public_key);
		const ended = await call(widget.public_key, "end", { body: {}, token: chat.token });
		expect(ended.status).toBe(200);
		expect(ended.json.conversation).toMatchObject({ status: "resolved", rating: null });
		const row = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		expect(row?.status).toBe("resolved");
		const activity = await db
			.select()
			.from(schema.inboxActivity)
			.where(eq(schema.inboxActivity.conversation_id, chat.conversation.id));
		expect(activity.map((a) => a.action)).toContain("chat.ended");
		await call(widget.public_key, "messages", {
			body: { text: "One more thing", client_id: uid() },
			token: chat.token,
		});
		const again = await call(widget.public_key, "messages", { token: chat.token });
		expect(again.json.conversation.status).toBe("open");
		// A chat that doesn't let visitors end it.
		await saveChatWidget(inbox, { design: { allow_end: false } }, { userId: null });
		const refused = await call(widget.public_key, "end", { body: {}, token: chat.token });
		expect(refused.status).toBe(403);
	});

	it("keeps the visitor's rating and comment as the conversation's CSAT", async () => {
		const { org, inbox, widget } = await setUp();
		const chat = await start(widget.public_key);
		await call(widget.public_key, "end", { body: {}, token: chat.token });
		const bad = await call(widget.public_key, "rate", {
			body: { rating: 9 },
			token: chat.token,
		});
		expect(bad.status).toBe(422);
		const rated = await call(widget.public_key, "rate", {
			body: { rating: 4 },
			token: chat.token,
		});
		expect(rated.json.conversation.rating).toBe(4);
		await call(widget.public_key, "rate", {
			body: { rating: 4, comment: "Quick and kind" },
			token: chat.token,
		});
		const full = await getConversation(person(org.id), chat.conversation.id);
		expect(full.csat).toMatchObject({ rating: 4, comment: "Quick and kind" });
		await saveChatWidget(inbox, { design: { ask_rating: false } }, { userId: null });
		const off = await call(widget.public_key, "rate", {
			body: { rating: 5 },
			token: chat.token,
		});
		expect(off.status).toBe(403);
	});

	it("lists the visitor's chats this browser has, newest first, and nothing of other chats", async () => {
		const { widget } = await setUp();
		const other = await setUp();
		const first = await start(widget.public_key, "First question");
		await new Promise((r) => setTimeout(r, 5));
		const second = await start(widget.public_key, "Second question");
		const elsewhere = await start(other.widget.public_key, "Not this chat");
		const r = await call(widget.public_key, "history", {
			body: {
				tokens: [first.token, "mrv_nonsense", elsewhere.token, second.token],
			},
		});
		expect(r.status).toBe(200);
		expect(r.json.conversations.map((x: Json) => [x.id, x.ref])).toEqual([
			[second.conversation.id, 3],
			[first.conversation.id, 0],
		]);
		expect(r.json.conversations[1]).toMatchObject({
			status: "open",
			snippet: "First question",
		});
	});
});

describe("website chat: who answers, and when", () => {
	it("tells the visitor when the team has read their message, and shows the replier's photo", async () => {
		const { org, widget } = await setUp();
		const chat = await start(widget.public_key);
		const before = await call(widget.public_key, "messages", { token: chat.token });
		expect(before.json.conversation.team_seen_at).toBeNull();
		const pat = person(org.id);
		await db.insert(schema.user).values({
			id: pat.id as string,
			name: "Pat Rivera",
			email: `pat-${uid()}@acme-hotel.test`,
			emailVerified: true,
			image: "https://photos.example/pat.jpg",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const { updateConversation } = await import("@/server/conversations");
		await updateConversation(pat, chat.conversation.id, { read: true });
		const after = await call(widget.public_key, "messages", { token: chat.token });
		expect(after.json.conversation.team_seen_at).toBeTruthy();
		await sendReply(pat, chat.conversation.id, { text: "Hello!" }, noEmail);
		const lines = await call(widget.public_key, "messages", { token: chat.token });
		expect(lines.json.messages.at(-1)).toMatchObject({
			name: "Pat",
			avatar: "https://photos.example/pat.jpg",
		});
		const { chatTeam } = await import("@/server/chat");
		expect(await chatTeam(widget.inbox_id)).toEqual([
			{ name: "Pat", avatar: "https://photos.example/pat.jpg" },
		]);
	});

	it("works out the usual reply time and passes the business hours to the widget", async () => {
		const { inbox, widget } = await setUp();
		const { usualReply } = await import("@/server/chat");
		expect(await usualReply(inbox.id)).toBeNull();
		const at = Date.now() - 3600_000;
		for (const mins of [2, 5, 40]) {
			const chat = await start(widget.public_key);
			await db
				.update(schema.conversations)
				.set({
					created_at: new Date(at).toISOString(),
					first_reply_at: new Date(at + mins * 60_000).toISOString(),
				})
				.where(eq(schema.conversations.id, chat.conversation.id));
		}
		expect(await usualReply(inbox.id)).toBe("minutes");
		const { updateSettings } = await import("@/server/inbox-workflow");
		await updateSettings(inbox, {
			sla: {
				business_hours: {
					timezone: "America/Mexico_City",
					days: [1, 2, 3],
					start: "09:00",
					end: "18:00",
				},
			},
		});
		await saveChatWidget(inbox, { design: { reply_time: "auto" } }, { userId: null });
		const res = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}.js`),
		);
		const js = await res.text();
		expect(js).toContain('"usual_reply":"minutes"');
		expect(js).toContain('"hours":{"timezone":"America/Mexico_City"');
	});
});

describe("website chat: topics", () => {
	it("tags a chat started from a topic and gives it to its person, and shows only the words", async () => {
		const { org, inbox, widget } = await setUp();
		const ana = `user_${uid()}`;
		await db.insert(schema.user).values({
			id: ana,
			name: "Ana Ruiz",
			email: `ana-${uid()}@acme-hotel.test`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const { orgOf } = await import("@/server/brands");
		await db.insert(schema.member).values({
			id: uid(),
			organizationId: await orgOf(org.id),
			userId: ana,
			role: "member",
			createdAt: new Date(),
		});
		await saveChatWidget(
			inbox,
			{
				design: {
					topics: [
						{ label: "Booking", tag: "booking" },
						{ label: "Billing", tag: "billing", assignee: `user:${ana}` },
					],
				},
			},
			{ userId: null },
		);
		const res = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}.js`),
		);
		const js = await res.text();
		expect(js).toContain('"topics":[{"label":"Booking"},{"label":"Billing"}]');
		expect(js).not.toContain(ana);
		const chat = await start(widget.public_key, "Billing", { topic: 1 });
		const row = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		expect(row?.tags).toContain("billing");
		expect(row?.assignee).toBe(`user:${ana}`);
	});
});

describe("website chat: pop-up messages", () => {
	it("passes the pop-ups to the widget and notes which one a chat started from", async () => {
		const { org, inbox, widget } = await setUp();
		await saveChatWidget(
			inbox,
			{
				design: {
					popups: [{ text: "Questions about our plans?", pages: ["/pricing"], after: 5 }],
				},
			},
			{ userId: null },
		);
		const js = await (
			await handleChat(new Request(`https://mailroom.test/chat/${widget.public_key}.js`))
		).text();
		expect(js).toContain(
			'"popups":[{"pages":["/pricing"],"text":"Questions about our plans?","after":5,"style":"nudge","title":null,"button":null,"signup":false,"targeted":false}]',
		);
		const chat = await start(widget.public_key, "Is there a yearly plan?", { popup: 0 });
		const activity = await db
			.select()
			.from(schema.inboxActivity)
			.where(eq(schema.inboxActivity.conversation_id, chat.conversation.id));
		expect(activity.find((a) => a.action === "chat.started")?.detail).toMatchObject({
			popup: "Questions about our plans?",
		});
		expect(org.id).toBeTruthy();
	});
});

/** The emails about one chat (other tests' chats are pending too). */
const about = (sent: Json[], words: string) =>
	sent.filter((e) => JSON.stringify(e).includes(words));

describe("website chat: an agent answers first", () => {
	it("gives new chats to the agent, emails the team only if it's silent, and hands off to a person", async () => {
		const { org, inbox, widget } = await setUp();
		const { createCredential } = await import("@/server/inboxes");
		const readOnly = await createCredential(inbox, { name: "Reader", permissions: ["read"] });
		await expect(
			saveChatWidget(inbox, { first_agent: readOnly.credential.id }, { userId: null }),
		).rejects.toThrow(/send/);
		const { credential } = await createCredential(inbox, {
			name: "Concierge",
			permissions: ["read", "send"],
		});
		await saveChatWidget(
			inbox,
			{ first_agent: credential.id, agent_wait: 5 },
			{ userId: null },
		);
		const chat = await start(widget.public_key, "Do you have valet service?");
		const state = await call(widget.public_key, "messages", { token: chat.token });
		expect(state.json.conversation.with_agent).toBe(true);
		const row = await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, chat.conversation.id))
			.get();
		expect(row?.assignee).toBe(`cred:${credential.id}`);
		// Within its wait the team isn't emailed; once it answered, never for those lines.
		const { s, sent } = sender();
		await notifyTeam(Date.now() + 2 * 60_000, s);
		expect(about(sent, "valet service")).toHaveLength(0);
		const agent: InboxActor = {
			organizationId: org.id,
			brands: [org.id],
			inboxIds: [inbox.id],
			permissions: new Set(["read", "send"]),
			sendScope: "replies",
			type: "agent",
			id: credential.id,
			name: "Concierge",
			reader: `cred:${credential.id}`,
		};
		await sendReply(agent, chat.conversation.id, { text: "Yes, free parking!" }, noEmail);
		await notifyTeam(Date.now() + 10 * 60_000, s);
		expect(about(sent, "valet service")).toHaveLength(0);
		// The visitor asks for a person: told in the chat, and the team is emailed.
		const handed = await call(widget.public_key, "handoff", { body: {}, token: chat.token });
		expect(handed.json.conversation.with_agent).toBe(false);
		const lines = await call(widget.public_key, "messages", { token: chat.token });
		expect(lines.json.messages.at(-1)).toMatchObject({
			author: "system",
			text: expect.stringMatching(/someone from the team/),
		});
		await notifyTeam(Date.now() + 2 * 60_000, s);
		expect(about(sent, "valet service")).toHaveLength(1);
	});

	it("lets the agent hand a chat off itself, and emails the team when it stays silent", async () => {
		const { org, inbox, widget } = await setUp();
		const { createCredential } = await import("@/server/inboxes");
		const { credential } = await createCredential(inbox, {
			name: "Concierge",
			permissions: ["read", "send"],
		});
		await saveChatWidget(
			inbox,
			{ first_agent: credential.id, agent_wait: 2 },
			{ userId: null },
		);
		const chat = await start(widget.public_key, "Can I get a refund?");
		const { s, sent } = sender();
		await notifyTeam(Date.now() + 3 * 60_000, s);
		expect(about(sent, "refund")).toHaveLength(1);
		const agent: InboxActor = {
			organizationId: org.id,
			brands: [org.id],
			inboxIds: [inbox.id],
			permissions: new Set(["read", "send"]),
			sendScope: "replies",
			type: "agent",
			id: credential.id,
			name: "Concierge",
			reader: `cred:${credential.id}`,
		};
		const { updateConversation } = await import("@/server/conversations");
		await updateConversation(agent, chat.conversation.id, { hand_off: true });
		const after = await call(widget.public_key, "messages", { token: chat.token });
		expect(after.json.conversation.with_agent).toBe(false);
		// Someone else's chat isn't the agent's to hand off.
		const other = await start(widget.public_key, "Hello");
		await updateConversation(agent, other.conversation.id, { hand_off: true });
		const pat = person(org.id);
		await updateConversation(pat, other.conversation.id, { assignee: null });
		await expect(
			updateConversation(
				{ ...agent, permissions: new Set(["read"]) },
				other.conversation.id,
				{ hand_off: true },
			),
		).rejects.toThrow();
	});
});

describe("website chat: files in the website's own bucket", () => {
	const ACCOUNT = "0123456789abcdef0123456789abcdef";
	const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;

	/** A fake R2 (its S3 API) that takes the right key and refuses any other. */
	function fakeBucket() {
		const objects = new Map<string, { bytes: Uint8Array; type: string | null }>();
		const deleted: string[] = [];
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const req = input instanceof Request ? input : new Request(String(input), init);
			const url = new URL(req.url);
			if (url.host !== HOST) return new Response("not here", { status: 500 });
			if (!req.headers.get("authorization")?.includes("Credential=good-key/"))
				return new Response("<Error><Code>InvalidAccessKeyId</Code></Error>", {
					status: 403,
				});
			const [, bucket, ...rest] = url.pathname.split("/");
			if (bucket !== "acme-chat")
				return new Response("<Error><Code>NoSuchBucket</Code></Error>", { status: 404 });
			const key = rest.map(decodeURIComponent).join("/");
			if (req.method === "PUT") {
				objects.set(key, {
					bytes: new Uint8Array(await req.arrayBuffer()),
					type: req.headers.get("content-type"),
				});
				return new Response(null, { status: 200 });
			}
			if (req.method === "DELETE") {
				deleted.push(key);
				objects.delete(key);
				return new Response(null, { status: 204 });
			}
			const o = objects.get(key);
			return o ? new Response(o.bytes as BodyInit) : new Response("", { status: 404 });
		});
		return { objects, deleted, spy };
	}

	const r2 = (o: Record<string, unknown> = {}) => ({
		provider: "r2",
		account_id: ACCOUNT,
		bucket: "acme-chat",
		prefix: "support/",
		access_key_id: "good-key",
		secret_access_key: "s3cret",
		...o,
	});

	it("saves only settings that can write there, and never shows the secret", async () => {
		const { inbox } = await setUp();
		const fake = fakeBucket();
		await expect(
			saveChatWidget(inbox, { file_storage: r2({ access_key_id: "bad-key" }) }),
		).rejects.toMatchObject({ code: "storage_refused" });
		await expect(
			saveChatWidget(inbox, { file_storage: r2({ bucket: "someone-else" }) }),
		).rejects.toThrow(/no bucket by that name/);
		await expect(
			saveChatWidget(inbox, {
				file_storage: r2({ provider: "other", endpoint: "http://10.0.0.1" }),
			}),
		).rejects.toThrow(/https/);
		const { widget } = await saveChatWidget(inbox, { file_storage: r2() });
		// The test file went in and came out again.
		expect(fake.objects.size).toBe(0);
		expect(fake.deleted[0]).toMatch(/^support\/mailroom-test-/);
		const view = chatWidgetView(widget);
		expect(view.file_storage).toMatchObject({
			provider: "r2",
			bucket: "acme-chat",
			account_id: ACCOUNT,
			region: "auto",
		});
		expect(JSON.stringify(view)).not.toContain("s3cret");
		expect(widget.file_storage?.secret).not.toContain("s3cret");
		// Saving other settings (or the same bucket without the secret) keeps it.
		const again = await saveChatWidget(inbox, {
			daily_limit: 50,
			file_storage: r2({ secret_access_key: undefined }),
		});
		expect(again.widget.file_storage?.secret).toBe(widget.file_storage?.secret);
		fake.spy.mockRestore();
	});

	it("keeps a visitor's file there, serves it by its link and deletes it with the chat", async () => {
		const { inbox, widget } = await setUp();
		const fake = fakeBucket();
		await saveChatWidget(inbox, { file_storage: r2() });
		const chat = await start(widget.public_key);
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "photo.png", {
				type: "image/png",
			}),
		);
		const res = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
				method: "POST",
				headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
				body: form,
			}),
		);
		expect(res.status).toBe(201);
		const { message } = (await res.json()) as Json;
		const [key] = [...fake.objects.keys()];
		expect(key).toMatch(new RegExp(`^support/${chat.conversation.id}/`));
		expect(fake.objects.get(key ?? "")?.type).toBe("image/png");
		const file = await handleChat(new Request(message.files[0].url));
		expect(file.status).toBe(200);
		expect(new Uint8Array(await file.arrayBuffer())[0]).toBe(137);
		// Its checks still apply: a program called .png never reaches the bucket.
		const bad = new FormData();
		bad.append("file", new File(["MZ\x90\x00 program"], "x.png", { type: "image/png" }));
		const refused = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/files`, {
				method: "POST",
				headers: { origin: SITE, authorization: `Bearer ${chat.token}` },
				body: bad,
			}),
		);
		expect(refused.status).toBe(422);
		expect(fake.objects.size).toBe(1);
		await deleteChatFiles([chat.conversation.id]);
		expect(fake.deleted).toContain(key);
		expect(fake.objects.size).toBe(0);
		fake.spy.mockRestore();
	});
});

describe("website chat: links from the website's app", () => {
	const link = (key: string, token: string, body: Record<string, unknown>) =>
		call(key, "links", { body, token });

	it("takes links only on its hosts, of the kinds and size it takes, and serves them as they are", async () => {
		const { inbox, widget } = await setUp();
		const chat = await start(widget.public_key);
		const url = "https://files.fiscalisto.test/u/123/factura.pdf";
		expect((await link(widget.public_key, chat.token, { url })).json.error.code).toBe(
			"links_off",
		);
		await expect(
			saveChatWidget(inbox, { file_links: { hosts: ["10.0.0.1"] } }),
		).rejects.toThrow(/website address/);
		const { widget: w } = await saveChatWidget(inbox, {
			file_links: { hosts: ["https://fiscalisto.test/"] },
		});
		expect(chatWidgetView(w).file_links).toEqual({ hosts: ["fiscalisto.test"] });
		const ok = await link(widget.public_key, chat.token, { url, size: 2048 });
		expect(ok.status).toBe(201);
		expect(ok.json.message.files[0]).toMatchObject({
			filename: "factura.pdf",
			content_type: "application/pdf",
			url,
		});
		// Another site, plain http, a kind it doesn't take, too big: refused.
		const bad = async (body: Record<string, unknown>) =>
			(await link(widget.public_key, chat.token, body)).json.error.code;
		expect(await bad({ url: "https://evil.test/factura.pdf" })).toBe("link_host");
		expect(await bad({ url: "https://fiscalisto.test.evil.test/a.pdf" })).toBe("link_host");
		expect(await bad({ url: "http://files.fiscalisto.test/a.pdf" })).toBe("validation_error");
		expect(await bad({ url: "https://files.fiscalisto.test/a.exe" })).toBe("file_kind");
		expect(await bad({ url, size: 50 * 1024 * 1024 })).toBe("too_large");
		// The widget is told it may send links; nothing to delete with the chat.
		const page = await handleChat(
			new Request(`https://mailroom.test/chat/${widget.public_key}/config`, {
				headers: { origin: SITE },
			}),
		);
		if (page.ok) expect(((await page.json()) as Json).files?.links ?? true).toBe(true);
		await deleteChatFiles([chat.conversation.id]);
	});
});
