import { describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { importContacts } from "@/server/contacts";
import { isUnsubscribed, unsubscribe } from "@/server/unsubscribes";
import { seedOrg } from "./helpers";

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
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown>[] },
	};
};

async function orgWithKey() {
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	return { ...org, token };
}

describe("contacts", () => {
	it("adds a contact (again: updates it), with properties, a segment and topics", async () => {
		const org = await orgWithKey();
		const seg = await call(org.token, "POST", "/segments", { name: "Guests" });
		expect(seg.status).toBe(201);
		const topic = await call(org.token, "POST", "/topics", {
			name: "Offers",
			default_subscription: "opt_in",
		});
		const unknown = await call(org.token, "POST", "/contacts", {
			email: "ana@guest.test",
			properties: { city: "Puebla" },
		});
		expect(unknown.status).toBe(422);
		await call(org.token, "POST", "/contact-properties", { key: "city", type: "string" });
		await call(org.token, "POST", "/contact-properties", { key: "nights", type: "number" });

		const made = await call(org.token, "POST", "/contacts", {
			email: "Ana <ANA@guest.test>",
			first_name: "Ana",
			properties: { city: "Puebla", nights: "3" },
			segments: [{ id: seg.body.id }],
			topics: [{ id: topic.body.id, subscription: "opt_in" }],
		});
		expect(made).toMatchObject({ status: 201, body: { created: true } });
		const again = await call(org.token, "POST", "/contacts", {
			email: "ana@guest.test",
			last_name: "García",
			properties: { nights: 4 },
		});
		expect(again).toMatchObject({ status: 200, body: { id: made.body.id, created: false } });

		const one = await call(org.token, "GET", "/contacts/ana@guest.test");
		expect(one.body).toMatchObject({
			email: "ana@guest.test",
			first_name: "Ana",
			last_name: "García",
			properties: { city: "Puebla", nights: 4 },
			unsubscribed: false,
		});
		const inSeg = await call(org.token, "GET", `/contacts?segment_id=${seg.body.id}`);
		expect(inSeg.body.data?.map((c) => c.email)).toEqual(["ana@guest.test"]);
		const audience = await call(org.token, "GET", `/audiences/${seg.body.id}/contacts`);
		expect(audience.body.data).toHaveLength(1);
		const topics = await call(org.token, "GET", `/contacts/${made.body.id}/topics`);
		expect(topics.body.data?.[0]).toMatchObject({ name: "Offers", subscription: "opt_in" });
		const segs = await call(org.token, "GET", `/segments/${seg.body.id}`);
		expect(segs.body).toMatchObject({ name: "Guests", contacts: 1 });

		await call(org.token, "DELETE", `/contacts/${made.body.id}/segments/${seg.body.id}`);
		expect((await call(org.token, "GET", `/segments/${seg.body.id}`)).body.contacts).toBe(0);
		expect((await call(org.token, "DELETE", "/contacts/ana@guest.test")).status).toBe(200);
		expect((await call(org.token, "GET", "/contacts/ana@guest.test")).status).toBe(404);
	});

	it("keeps unsubscribe links and contacts in step", async () => {
		const org = await orgWithKey();
		const topic = await call(org.token, "POST", "/topics", { name: "News" });
		const made = await call(org.token, "POST", "/contacts", { email: "luis@guest.test" });
		// The topic's link: opted out of the topic only.
		await unsubscribe({
			organizationId: org.id,
			group: `topic:${topic.body.id}`,
			address: "luis@guest.test",
			emailId: crypto.randomUUID(),
		});
		const topics = await call(org.token, "GET", `/contacts/${made.body.id}/topics`);
		expect(topics.body.data?.[0]).toMatchObject({ subscription: "opt_out" });
		expect((await call(org.token, "GET", `/contacts/${made.body.id}`)).body.unsubscribed).toBe(
			false,
		);
		// Opting in again through the API takes them out of the group.
		await call(org.token, "PATCH", `/contacts/${made.body.id}/topics`, [
			{ id: topic.body.id, subscription: "opt_in" },
		]);
		expect(await isUnsubscribed(org.id, `topic:${topic.body.id}`, "luis@guest.test")).toBe(
			false,
		);
		// The broadcasts link (no topic): unsubscribed from all.
		await unsubscribe({
			organizationId: org.id,
			group: "broadcasts",
			address: "luis@guest.test",
			emailId: crypto.randomUUID(),
		});
		expect((await call(org.token, "GET", `/contacts/${made.body.id}`)).body.unsubscribed).toBe(
			true,
		);
		await call(org.token, "PATCH", `/contacts/${made.body.id}`, { unsubscribed: false });
		expect(await isUnsubscribed(org.id, "broadcasts", "luis@guest.test")).toBe(false);
	});

	it("imports a CSV's rows: adds, updates, skips bad addresses, makes properties", async () => {
		const org = await orgWithKey();
		const seg = await call(org.token, "POST", "/segments", { name: "Import" });
		await call(org.token, "POST", "/contacts", { email: "old@guest.test", first_name: "Old" });
		const r = await importContacts(
			org.id,
			[
				{ email: "old@guest.test", last_name: "Timer", properties: { room: "12" } },
				{ email: "new@guest.test", first_name: "New" },
				{ email: "not-an-address" },
			],
			{ segment: seg.body.id as string },
		);
		expect(r).toMatchObject({ imported: 2, added: 1, updated: 1, skipped: 1 });
		const old = await call(org.token, "GET", "/contacts/old@guest.test");
		expect(old.body).toMatchObject({
			first_name: "Old",
			last_name: "Timer",
			properties: { room: "12" },
		});
		const props = await call(org.token, "GET", "/contact-properties");
		expect(props.body.data?.map((p) => p.key)).toEqual(["room"]);
		expect((await call(org.token, "GET", `/segments/${seg.body.id}`)).body.contacts).toBe(2);
	});
});
