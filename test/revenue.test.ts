import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { recordEvent } from "@/server/automations";
import { db, schema } from "@/server/db";
import { purchaseOf, revenueOf, revenueReport } from "@/server/revenue";
import { iso } from "@/server/time";
import { fakeOutside, seedOrg, uid } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const DAY = 86_400_000;

async function sent(
	org: { id: string; domain: string },
	to: string,
	o: {
		broadcast?: string;
		automation?: string;
		opened?: number;
		clicked?: number;
		created: number;
	},
) {
	const id = crypto.randomUUID();
	await db.insert(schema.emails).values({
		id,
		organization_id: org.id,
		from: `news@${org.domain}`,
		to: [to],
		recipient: to,
		subject: "Hi",
		status: "sent",
		source: o.broadcast ? "broadcast" : "automation",
		broadcast_id: o.broadcast ?? null,
		tags: o.automation ? [{ name: "automation", value: o.automation }] : [],
		opened_at: o.opened ? iso(o.opened) : null,
		clicked_at: o.clicked ? iso(o.clicked) : null,
		created_at: iso(o.created),
	});
	return id;
}

describe("revenue", () => {
	it("reads purchases from the event or its data", () => {
		expect(purchaseOf({ value: 120, currency: "usd" })).toEqual({
			value: 120,
			currency: "USD",
		});
		expect(purchaseOf({ data: { revenue: "49.999", currency: "MXN" } })).toEqual({
			value: 50,
			currency: "MXN",
		});
		expect(purchaseOf({ data: { total: 10 } })).toEqual({ value: 10, currency: null });
		expect(purchaseOf({ data: { room: "12" } })).toBeNull();
		expect(purchaseOf({ value: -5 })).toBeNull();
	});

	it("credits the last email opened or clicked, or chat, within 7 days", async () => {
		fakeOutside();
		const org = await seedOrg();
		const now = Date.now();
		const b = `b_${uid()}`;
		const auto = `a_${uid()}`;
		// Ana opened a broadcast 2 days ago, then clicked an automation email yesterday.
		await sent(org, "ana@guest.test", {
			broadcast: b,
			created: now - 3 * DAY,
			opened: now - 2 * DAY,
		});
		await sent(org, "ana@guest.test", {
			automation: auto,
			created: now - 2 * DAY,
			clicked: now - DAY,
		});
		// Luis only opened a broadcast 10 days ago: too long ago.
		await sent(org, "luis@guest.test", {
			broadcast: b,
			created: now - 11 * DAY,
			opened: now - 10 * DAY,
		});
		// Eva opened the broadcast 3 days ago but wrote in the website chat an hour ago.
		await sent(org, "eva@guest.test", {
			broadcast: b,
			created: now - 4 * DAY,
			opened: now - 3 * DAY,
		});
		const chat = `cv_${uid()}`;
		await db.insert(schema.conversations).values({
			id: chat,
			organization_id: org.id,
			subject: "Chat",
			contact: "eva@guest.test",
			contact_address: "eva@guest.test",
			channel: "chat",
			last_message_at: iso(now - 3_600_000),
			last_inbound_at: iso(now - 3_600_000),
			created_at: iso(now - 3_600_000),
			updated_at: iso(now - 3_600_000),
		});
		// Mia opened the broadcast yesterday.
		await sent(org, "mia@guest.test", {
			broadcast: b,
			created: now - 2 * DAY,
			opened: now - DAY,
		});

		const buy = (email: string, value: number, data?: Record<string, unknown>) =>
			recordEvent(org.id, { event: "purchase", email, value, currency: "USD", data }, now);
		const ana = await buy("ana@guest.test", 200);
		expect(ana).toMatchObject({
			value: 200,
			currency: "USD",
			credit: { type: "automation", id: auto },
		});
		const luis = await buy("luis@guest.test", 80);
		expect(luis).toMatchObject({ value: 80, credit: null });
		const eva = await buy("eva@guest.test", 50);
		expect(eva).toMatchObject({ credit: { type: "chat", id: chat } });
		await buy("mia@guest.test", 120);
		await buy("mia@guest.test", 30);
		// No value: not a purchase.
		const plain = await recordEvent(
			org.id,
			{ event: "checked_in", email: "mia@guest.test" },
			now,
		);
		expect(plain).not.toHaveProperty("value");

		const row = await db
			.select()
			.from(schema.contactEvents)
			.where(eq(schema.contactEvents.id, ana.id as string))
			.get();
		expect(row?.credit_email_id).toBeTruthy();

		expect(await revenueOf("broadcast", b)).toEqual([
			{ currency: "USD", total: 150, purchases: 2 },
		]);
		expect(await revenueOf("automation", auto)).toEqual([
			{ currency: "USD", total: 200, purchases: 1 },
		]);

		const r = await revenueReport([org.id], 30, now + 1000);
		expect(r.currency).toBe("USD");
		expect(r.totals[0]).toMatchObject({
			total: 480,
			purchases: 5,
			credited: 400,
			credited_purchases: 4,
		});
		expect(Object.fromEntries(r.by_type.map((t) => [t.type, t.total]))).toEqual({
			automation: 200,
			broadcast: 150,
			none: 80,
			chat: 50,
		});
		expect(r.latest).toHaveLength(5);
		expect(r.daily.reduce((s, d) => s + d.total, 0)).toBe(480);
	});

	it("counts a campaign's broadcasts together", async () => {
		fakeOutside();
		const org = await seedOrg();
		const now = Date.now();
		const campaign = `cmp_${uid()}`;
		await db.insert(schema.campaigns).values({
			id: campaign,
			organization_id: org.id,
			name: "Winter",
			created_at: iso(now),
			updated_at: iso(now),
		});
		const ids: string[] = [];
		for (const name of ["One", "Two"]) {
			const id = `b_${uid()}`;
			ids.push(id);
			await db.insert(schema.broadcasts).values({
				id,
				organization_id: org.id,
				name,
				from: `news@${org.domain}`,
				subject: name,
				status: "sent",
				campaign_id: campaign,
				created_at: iso(now),
				updated_at: iso(now),
			} as never);
		}
		await sent(org, "ana@guest.test", {
			broadcast: ids[0],
			created: now - DAY,
			clicked: now - DAY,
		});
		await sent(org, "luis@guest.test", {
			broadcast: ids[1],
			created: now - DAY,
			opened: now - DAY,
		});
		await recordEvent(org.id, { event: "purchase", email: "ana@guest.test", value: 10 }, now);
		await recordEvent(org.id, { event: "purchase", email: "luis@guest.test", value: 15 }, now);
		expect(await revenueOf("campaign", campaign)).toEqual([
			{ currency: null, total: 25, purchases: 2 },
		]);
		const r = await revenueReport([org.id], 7, now + 1000);
		expect(r.campaigns).toEqual([{ id: campaign, name: "Winter", total: 25, purchases: 2 }]);
		expect(r.broadcasts.map((b) => b.name).sort()).toEqual(["One", "Two"]);
	});
});
