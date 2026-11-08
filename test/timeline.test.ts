import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { listContactEvents, purgeEvents } from "@/server/contact-events";
import { getContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { iso } from "@/server/time";
import { contactTimeline, mergeContacts, personPanel } from "@/server/timeline";
import { fakeOutside, seedOrg, uid } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const call = async (key: string, method: string, path: string, body?: unknown) => {
	const res = await handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			method,
			headers: {
				authorization: `Bearer ${key}`,
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

async function setUp() {
	fakeOutside();
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	return { ...org, token };
}

describe("one person, everywhere", () => {
	it("keeps app events on the contact and lists them", async () => {
		const org = await setUp();
		const email = `ana-${uid()}@example.com`;
		const sent = await call(org.token, "POST", "/events", {
			event: "purchase",
			email,
			data: { plan: "pro", amount: 49 },
		});
		expect(sent.status).toBe(202);
		expect(sent.body.id).toBeTruthy();
		const c = await getContact(org.id, email);
		const page = await call(org.token, "GET", `/contacts/${c.id}/events`);
		expect(page.status).toBe(200);
		const data = page.body.data as { event: string; data: Record<string, unknown> }[];
		expect(data).toHaveLength(1);
		expect(data[0]?.event).toBe("purchase");
		expect(data[0]?.data).toEqual({ plan: "pro", amount: 49 });
	});

	it("puts events, emails, conversations and joining on one timeline, newest first", async () => {
		const org = await setUp();
		const email = `luis-${uid()}@example.com`;
		await call(org.token, "POST", "/contacts", { email, first_name: "Luis" });
		const c = await getContact(org.id, email);
		const t0 = Date.now() - 60_000;
		await db
			.update(schema.contacts)
			.set({ created_at: iso(t0) })
			.where(eq(schema.contacts.id, c.id));
		await db.insert(schema.emails).values({
			id: crypto.randomUUID(),
			organization_id: org.id,
			from: `hola@${org.domain}`,
			to: [`Luis <${email.toUpperCase()}>`],
			recipient: email,
			subject: "Your booking",
			status: "delivered",
			source: "api",
			created_at: iso(t0 + 1000),
			opened_at: iso(t0 + 5000),
		});
		await db.insert(schema.conversations).values({
			id: crypto.randomUUID(),
			organization_id: org.id,
			subject: "Late check-in?",
			contact: `Luis <${email}>`,
			contact_address: email,
			status: "open",
			messages: 1,
			last_message_at: iso(t0 + 2000),
			created_at: iso(t0 + 2000),
			updated_at: iso(t0 + 2000),
		});
		await call(org.token, "POST", "/events", { event: "booking.created", email });
		const t = await contactTimeline(org.id, await getContact(org.id, email));
		const kinds = t.data.map((x) => x.kind);
		expect(kinds).toEqual(["event", "conversation", "email", "joined"]);
		const mail = t.data.find((x) => x.kind === "email");
		expect(mail && "opened_at" in mail && mail.opened_at).toBeTruthy();
		// Paging: what's before the second item.
		const second = t.data[1]?.at as string;
		const older = await contactTimeline(org.id, await getContact(org.id, email), {
			before: second,
		});
		expect(older.data.map((x) => x.kind)).toEqual(["email", "joined"]);

		const p = await personPanel(org.id, email);
		expect(p.contact?.first_name).toBe("Luis");
		expect(p.others).toHaveLength(1);
		expect(p.contact && "events" in p ? p.events[0]?.event : null).toBe("booking.created");
	});

	it("shows someone who wrote in before being a contact", async () => {
		const org = await setUp();
		const p = await personPanel(org.id, `nobody-${uid()}@example.com`);
		expect(p.contact).toBeNull();
		expect(p.broadcasts).toEqual([]);
	});

	it("merges two contacts of the same person", async () => {
		const org = await setUp();
		const a = `ana-${uid()}@example.com`;
		const b = `ana.work-${uid()}@example.com`;
		const seg = (await call(org.token, "POST", "/segments", { name: "VIP" })).body.id as string;
		await call(org.token, "POST", "/contacts", { email: a });
		await call(org.token, "POST", "/contacts", {
			email: b,
			first_name: "Ana",
			segments: [seg],
		});
		await call(org.token, "POST", "/events", { event: "signup", email: b });
		const out = await mergeContacts(org.id, a, b);
		expect(out.merged_email).toBe(b);
		const kept = await getContact(org.id, a);
		expect(kept.first_name).toBe("Ana");
		await expect(getContact(org.id, b)).rejects.toThrow();
		const ev = await listContactEvents(org.id, { contact: kept.id });
		expect(ev.data.map((x) => x.name)).toEqual(["signup"]);
		const segs = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.contact_id, kept.id));
		expect(segs.map((s) => s.segment_id)).toEqual([seg]);
	});

	it("deletes events past retention", async () => {
		const org = await setUp();
		const email = `old-${uid()}@example.com`;
		await call(org.token, "POST", "/events", { event: "visit", email });
		const c = await getContact(org.id, email);
		await db
			.update(schema.contactEvents)
			.set({ created_at: iso(Date.now() - 400 * 86_400_000) })
			.where(eq(schema.contactEvents.contact_id, c.id));
		expect(await purgeEvents()).toBeGreaterThanOrEqual(1);
		expect((await listContactEvents(org.id, { contact: c.id })).data).toHaveLength(0);
	});
});
