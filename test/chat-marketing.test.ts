import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { saveChatWidget, setIdentitySecret } from "@/server/chat";
import { handleChat, publicConfig } from "@/server/chat-public";
import { addToSegment, createSegment, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { createInbox } from "@/server/inboxes";
import { createNewsletter } from "@/server/newsletters";
import { setSetting } from "@/server/settings";
import { createForm } from "@/server/signup-forms";
import { fakeOutside, seedOrg, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const SITE = "https://shop.harbor-chat.test";

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

async function sign(secret: string, payload: Record<string, unknown>) {
	const h = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
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

async function setUp() {
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
		name: "Front desk",
		local_part: "hola",
		domain: org.domain,
	});
	const readers = await createSegment(org.id, { name: "Readers" });
	const vip = await createSegment(org.id, { name: "VIP" });
	const form = await createForm(org.id, {
		name: "Chat",
		title: "Harbor News",
		from: `hola@${org.domain}`,
		segment_id: readers.id,
	});
	const n = await createNewsletter(org.id, {
		name: `Harbor News ${uid()}`,
		description: "Rates and events, monthly",
		segment_id: readers.id,
		from: `News <news@${org.domain}>`,
		form_id: form.id,
	});
	await saveChatWidget(
		inbox,
		{
			origins: ["harbor-chat.test"],
			notify: ["owner@harbor.test"],
			design: {
				newsletter_id: n.id,
				popups: [
					{
						pages: ["/rooms"],
						text: "Winter rates for our best guests",
						style: "banner",
						segment_id: vip.id,
					},
					{ pages: ["/*"], text: "Get our news", style: "popup", signup: true },
				],
			},
		},
		{ userId: null },
	);
	const { widget, secret } = await setIdentitySecret(inbox, true);
	return { org, inbox, widget, secret: secret as string, readers, vip, n, form };
}

async function call(key: string, action: string, body: unknown) {
	const res = await handleChat(
		new Request(`https://mailroom.test/chat/${key}/${action}`, {
			method: "POST",
			headers: { origin: SITE, "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return { status: res.status, json: (await res.json().catch(() => null)) as Json };
}

describe("website chat as a marketing channel", () => {
	it("shows the newsletter and the messages, but never who a message is for", async () => {
		const { widget, inbox, vip, n } = await setUp();
		const config = await publicConfig({ widget, inbox });
		expect(config.newsletter).toMatchObject({
			name: n.name,
			description: "Rates and events, monthly",
			signup: true,
		});
		expect(config.popups[0]).toMatchObject({ style: "banner", targeted: true });
		expect(config.popups[1]).toMatchObject({ style: "popup", signup: true, targeted: false });
		expect(JSON.stringify(config)).not.toContain(vip.id);
	});

	it("tells a signed-in visitor which messages are theirs and lets them subscribe", async () => {
		const { org, widget, secret, vip, readers } = await setUp();
		const email = `ana-${uid()}@guest.test`;
		const { contact } = await upsertContact(org.id, { email, source: "import" });
		await addToSegment(org.id, contact.id, vip.id);
		// Nobody signed in: nothing about anyone.
		const anon = await call(widget.public_key, "audience", {});
		expect(anon.json).toMatchObject({ known: false, popups: [], newsletter: null });
		// An email the visitor typed isn't enough either.
		const typed = await call(widget.public_key, "audience", { email });
		expect(typed.json.known).toBe(false);
		const identity = await sign(secret, { sub: "u1", email, exp: soon() });
		const me = await call(widget.public_key, "audience", { identity });
		expect(me.json).toMatchObject({
			known: true,
			popups: [0],
			newsletter: { subscribed: false, email },
		});
		const sub = await call(widget.public_key, "subscribe", { identity, action: "subscribe" });
		expect(sub.status).toBe(200);
		expect(sub.json).toMatchObject({ status: "subscribed", subscribed: true });
		const inReaders = await db
			.select()
			.from(schema.contactSegments)
			.where(
				and(
					eq(schema.contactSegments.contact_id, contact.id),
					eq(schema.contactSegments.segment_id, readers.id),
				),
			)
			.get();
		expect(inReaders).toBeTruthy();
		const out = await call(widget.public_key, "subscribe", { identity, action: "unsubscribe" });
		expect(out.json).toMatchObject({ status: "unsubscribed", subscribed: false });
		// A forged token gets nowhere.
		const forged = await sign("mrcs_not-the-secret", { sub: "u1", email, exp: soon() });
		const bad = await call(widget.public_key, "subscribe", { identity: forged });
		expect(bad.status).toBe(401);
	});

	it("sends anyone else the newsletter's confirmation email, and only that", async () => {
		fakeOutside();
		const { org, widget, readers } = await setUp();
		const email = `luis-${uid()}@guest.test`;
		const r = await call(widget.public_key, "subscribe", { email });
		expect(r.status).toBe(200);
		expect(r.json.status).toBe("check_inbox");
		const queued = await db
			.select({ subject: schema.emails.subject, to: schema.emails.to })
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, org.id))
			.all();
		expect(queued.find((q) => q.to.includes(email))?.subject).toMatch(
			/Confirm your subscription/,
		);
		// Not subscribed until they click.
		const c = await db
			.select()
			.from(schema.contacts)
			.where(
				and(eq(schema.contacts.organization_id, org.id), eq(schema.contacts.email, email)),
			)
			.get();
		if (c) {
			const member = await db
				.select()
				.from(schema.contactSegments)
				.where(
					and(
						eq(schema.contactSegments.contact_id, c.id),
						eq(schema.contactSegments.segment_id, readers.id),
					),
				)
				.get();
			expect(member).toBeFalsy();
		}
		// Unsubscribing someone takes being them.
		const out = await call(widget.public_key, "subscribe", { email, action: "unsubscribe" });
		expect(out.status).toBe(401);
		const junk = await call(widget.public_key, "subscribe", { email: "not-an-email" });
		expect(junk.status).toBe(400);
	});

	it("only takes the brand's own newsletter and segments", async () => {
		const { inbox } = await setUp();
		const other = await seedOrg();
		const theirs = await createSegment(other.id, { name: "Theirs" });
		await expect(
			saveChatWidget(inbox, {
				design: { popups: [{ pages: ["/"], text: "Hi", segment_id: theirs.id }] },
			}),
		).rejects.toThrow(/segment of this brand/);
		await expect(saveChatWidget(inbox, { design: { newsletter_id: "nope" } })).rejects.toThrow(
			/newsletters/,
		);
	});
});
