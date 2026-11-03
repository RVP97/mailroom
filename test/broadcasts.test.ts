import { env, runInDurableObject } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { runBroadcasts } from "@/server/broadcasts";
import { db, schema } from "@/server/db";
import type { Dispatcher } from "@/server/dispatcher";
import { storedContent } from "@/server/send";
import { addSuppression } from "@/server/suppressions";
import { handleUnsubscribePage } from "@/server/unsubscribes";
import { fakeOutside, seedOrg } from "./helpers";

const pending = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: (p: Promise<unknown>) => pending.push(p),
}));

/** What the API left running after answering (its first chunk queued). */
const settled = async () => {
	await Promise.all(pending.splice(0));
};

const queuedFor = async (id: string) =>
	(
		await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.broadcast_id, id))
	).length;

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

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

/** The raw message with its base64 parts decoded. */
const readable = (raw: string) =>
	raw.replace(
		/Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/g,
		(_, b64: string) =>
			new TextDecoder().decode(
				Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)),
			),
	);

const dispatcher = () => env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));

async function drain() {
	for (let i = 0; i < 50; i++) {
		await runInDurableObject(dispatcher(), (o: Dispatcher) => o.alarm());
		const left = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(inArray(schema.emails.status, ["queued", "sending"]))
			.limit(1);
		if (!left.length) break;
		await new Promise((r) => setTimeout(r, 10));
	}
	await runInDurableObject(dispatcher(), (_o: Dispatcher, state) => state.storage.deleteAlarm());
}

beforeEach(async () => {
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

async function setUp() {
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	const seg = (await call(token, "POST", "/segments", { name: "Guests" })).body.id as string;
	const topic = (
		await call(token, "POST", "/topics", { name: "Offers", default_subscription: "opt_out" })
	).body.id as string;
	await call(token, "POST", "/contact-properties", { key: "city", type: "string" });
	const add = (email: string, extra: Record<string, unknown> = {}) =>
		call(token, "POST", "/contacts", { email, segments: [seg], ...extra });
	await add("ana@guest.test", { first_name: "Ana", properties: { city: "Puebla" } });
	await add("luis@guest.test", { first_name: "<b>Luis</b>" });
	await add("gone@guest.test", { unsubscribed: true });
	await add("nooffers@guest.test", { topics: [{ id: topic, subscription: "opt_out" }] });
	await add("bounced@guest.test");
	await call(token, "POST", "/contacts", { email: "other@guest.test" }); // in no segment
	await addSuppression(org.id, "bounced@guest.test", "bounce");
	return { ...org, token, seg, topic };
}

describe("broadcasts", () => {
	it("sends to the segment's subscribed contacts, each filled in, with the topic's unsubscribe link", async () => {
		const aws = fakeOutside();
		const org = await setUp();
		const made = await call(org.token, "POST", "/broadcasts", {
			name: "November",
			segment_id: org.seg,
			topic_id: org.topic,
			from: `Hotel <news@${org.domain}>`,
			subject: "{{{FIRST_NAME|Hi}}}, our news",
			preview_text: "Rooms from $90",
			html: "<html><body><p>Hola {{{FIRST_NAME|amigo}}} de {{{contact.city|México}}}</p></body></html>",
		});
		expect(made).toMatchObject({ status: 201, body: { status: "draft" } });
		const id = made.body.id as string;

		const draft = await call(org.token, "GET", `/broadcasts/${id}`);
		expect(draft.body).toMatchObject({ status: "draft", segment_id: org.seg });
		const changed = await call(org.token, "PATCH", `/broadcasts/${id}`, { name: "Nov news" });
		expect(changed.status).toBe(200);

		const sent = await call(org.token, "POST", `/broadcasts/${id}/send`, {});
		expect(sent.body).toMatchObject({ status: "scheduled" });
		await settled();
		expect(await queuedFor(id)).toBe(2);
		// Once queued, it can't change or be queued again.
		expect(await runBroadcasts(Date.now(), id)).toBe(0);
		expect((await call(org.token, "PATCH", `/broadcasts/${id}`, { name: "x" })).status).toBe(
			409,
		);
		await drain();

		expect(aws.sends).toHaveLength(2);
		const raws = aws.sends.map((x) => readable(rawOf(x)));
		const ana = raws.find((r) => r.includes("To: ana@guest.test")) as string;
		const luis = raws.find((r) => r.includes("To: luis@guest.test")) as string;
		expect(ana).toContain("Subject: Ana, our news");
		expect(ana).toContain("Hola Ana de Puebla");
		expect(ana).toContain("Rooms from $90");
		expect(ana).toMatch(/List-Unsubscribe: <https:\/\/[^>]+\/unsubscribe\?t=/);
		// A contact's values are text in the HTML.
		expect(luis).toContain("&#60;b&#62;Luis&#60;/b&#62;");
		expect(luis).toContain("de México");

		const rows = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.broadcast_id, id));
		expect(rows.map((r) => r.status)).toEqual(["sent", "sent"]);
		expect(rows[0]?.unsubscribe_group).toBe(`topic:${org.topic}`);
		expect(rows[0]?.source).toBe("broadcast");
		// The dashboard's preview renders it for the contact.
		const anaRow = rows.find((r) => r.to[0] === "ana@guest.test");
		expect((await storedContent(anaRow?.id as string))?.content.html).toContain("Hola Ana");

		const done = await call(org.token, "GET", `/broadcasts/${id}`);
		expect(done.body).toMatchObject({ status: "sent", queued: 2 });
		expect(done.body.stats).toMatchObject({ total: 2, sent: 2 });

		// The unsubscribe page offers the brand's public topics.
		const url = /List-Unsubscribe: <([^>]+)>/.exec(ana)?.[1] as string;
		const page = await (await handleUnsubscribePage(new Request(url))).text();
		expect(page).toContain('name="topic"');
		expect(page).toContain("Offers");
		const form = new FormData();
		form.set("action", "preferences");
		const saved = await handleUnsubscribePage(new Request(url, { method: "POST", body: form }));
		expect(await saved.text()).toContain("Preferences saved");
		const topics = await call(org.token, "GET", "/contacts/ana@guest.test/topics");
		expect(JSON.stringify(topics.body)).toContain("opt_out");
	});

	it("schedules, unschedules, refuses what isn't ready, and stops a send", async () => {
		fakeOutside();
		const org = await setUp();
		const bare = await call(org.token, "POST", "/broadcasts", { subject: "Hi" });
		const noSegment = await call(org.token, "POST", `/broadcasts/${bare.body.id}/send`, {});
		expect(noSegment.status).toBe(422);
		const foreign = await call(org.token, "POST", "/broadcasts", {
			segment_id: org.seg,
			from: "news@not-ours.test",
			subject: "Hi",
			html: "<p>Hi</p>",
			send: true,
		});
		expect(foreign.status).toBe(422);

		const made = await call(org.token, "POST", "/broadcasts", {
			segment_id: org.seg,
			from: `news@${org.domain}`,
			subject: "Later",
			html: "<p>Hi</p>",
		});
		const id = made.body.id as string;
		const at = new Date(Date.now() + 3_600_000).toISOString();
		const scheduled = await call(org.token, "POST", `/broadcasts/${id}/send`, {
			scheduled_at: at,
		});
		expect(scheduled.body).toMatchObject({ status: "scheduled" });
		await settled();
		expect(await runBroadcasts(Date.now(), id)).toBe(0);
		const back = await call(org.token, "POST", `/broadcasts/${id}/cancel`);
		expect(back.body).toMatchObject({ status: "draft" });

		await call(org.token, "POST", `/broadcasts/${id}/send`, {});
		await settled();
		expect(await queuedFor(id)).toBe(3); // no topic: the opted-out one too
		const stopped = await call(org.token, "POST", `/broadcasts/${id}/cancel`);
		expect(stopped.body).toMatchObject({ status: "canceled" });
		const rows = await db
			.select({ status: schema.emails.status })
			.from(schema.emails)
			.where(eq(schema.emails.broadcast_id, id));
		// Nothing is left queued: canceled, or already taken by the Dispatcher.
		expect(rows.some((r) => r.status === "queued")).toBe(false);
		expect((await call(org.token, "DELETE", `/broadcasts/${id}`)).status).toBe(409);
		expect((await call(org.token, "DELETE", `/broadcasts/${bare.body.id}`)).status).toBe(200);
	});
});
