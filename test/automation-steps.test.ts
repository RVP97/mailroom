import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import {
	onConversation,
	recordEvent,
	runAutomations,
	runDailyTriggers,
	splitSide,
} from "@/server/automations";
import { createProperty, getContact, updateContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { iso } from "@/server/time";
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

const runsOf = (automation: string) =>
	db
		.select()
		.from(schema.automationRuns)
		.where(eq(schema.automationRuns.automation_id, automation));

const sentTo = async (address: string) =>
	(await db.select().from(schema.emails).where(eq(schema.emails.source, "automation"))).filter(
		(e) => e.to.includes(address),
	);

beforeEach(async () => {
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

async function setUp() {
	fakeOutside();
	const org = await seedOrg();
	const { token } = await createKey({ organizationId: org.id, name: "test", permission: "full" });
	const make = async (body: Record<string, unknown>) => {
		const res = await call(token, "POST", "/automations", { status: "active", ...body });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.id as string;
	};
	return { ...org, token, make };
}

describe("automation steps and triggers", () => {
	it("waits for an event: goes on when it comes, or takes the no path when time runs out", async () => {
		const org = await setUp();
		const id = await org.make({
			name: "Finish your booking",
			trigger: { type: "event", event: "cart.started" },
			steps: [
				{
					type: "wait_event",
					event: "booking.created",
					days: 1,
					no: [
						{
							type: "email",
							from: `Hotel <hola@${org.domain}>`,
							subject: "Still thinking, {{{FIRST_NAME|friend}}}?",
							body: "Your room is waiting.\n\nSee you soon.",
						},
					],
				},
				{ type: "property", key: "booked", value: "yes" },
			],
		});
		await createProperty(org.id, { key: "booked", type: "string" });
		const a = `a-${uid()}@guest.test`;
		const b = `b-${uid()}@guest.test`;
		const now = Date.now();
		await recordEvent(org.id, { event: "cart.started", email: a }, now);
		await recordEvent(org.id, { event: "cart.started", email: b }, now);
		await runAutomations(now);
		const waiting = await runsOf(id);
		expect(waiting.every((r) => r.waiting_for === "booking.created")).toBe(true);
		// A books: their run wakes right away and goes on.
		await recordEvent(org.id, { event: "booking.created", email: a }, now + 60_000);
		await runAutomations(now + 60_000);
		const ca = await getContact(org.id, a);
		expect(ca.properties?.booked).toBe("yes");
		// B doesn't: a day later the no path sends them a reminder, then the run ends.
		await runAutomations(now + 86_400_000 + 60_000);
		expect(await sentTo(b)).toHaveLength(1);
		expect(await sentTo(a)).toHaveLength(0);
		const cb = await getContact(org.id, b);
		expect(cb.properties?.booked).toBeUndefined();
		const runs = await runsOf(id);
		expect(runs.map((r) => r.status).sort()).toEqual(["done", "done"]);
	});

	it("counts a goal and ends runs under way there", async () => {
		const org = await setUp();
		const id = await org.make({
			name: "Nurture",
			trigger: { type: "event", event: "signed_up" },
			goal_event: "purchase",
			steps: [
				{ type: "wait", days: 3 },
				{ type: "score", key: "score", add: 5 },
			],
		});
		const email = `g-${uid()}@guest.test`;
		const now = Date.now();
		await recordEvent(org.id, { event: "signed_up", email }, now);
		await runAutomations(now);
		await recordEvent(org.id, { event: "purchase", email }, now + 3600_000);
		const [run] = await runsOf(id);
		expect(run?.status).toBe("done");
		expect(run?.converted_at).toBeTruthy();
		const auto = await call(org.token, "GET", `/automations/${id}`);
		expect(auto.body.goal_event).toBe("purchase");
	});

	it("starts on property changes, unsubscribing and topics, and adds to scores", async () => {
		const org = await setUp();
		await createProperty(org.id, { key: "plan", type: "string" });
		await createProperty(org.id, { key: "score", type: "number" });
		const vip = await org.make({
			name: "Upgraded",
			trigger: { type: "property.changed", key: "plan", equals: "pro" },
			steps: [{ type: "score", key: "score", add: 10 }],
		});
		const left = await org.make({
			name: "Goodbye",
			trigger: { type: "unsubscribed" },
			steps: [{ type: "score", key: "score", add: -1 }],
		});
		const topic = (
			await call(org.token, "POST", "/topics", {
				name: "Offers",
				default_subscription: "opt_out",
			})
		).body.id as string;
		const offers = await org.make({
			name: "Likes offers",
			trigger: { type: "topic.changed", topic_id: topic, value: "opt_in" },
			steps: [{ type: "score", key: "score", add: 2 }],
		});
		const email = `p-${uid()}@guest.test`;
		await call(org.token, "POST", "/contacts", { email, properties: { plan: "free" } });
		const c = await getContact(org.id, email);
		await updateContact(org.id, c.id, { properties: { plan: "pro" } });
		await updateContact(org.id, c.id, { topics: [{ id: topic, subscription: "opt_in" }] });
		await updateContact(org.id, c.id, { unsubscribed: true });
		expect(await runsOf(vip)).toHaveLength(1);
		expect(await runsOf(left)).toHaveLength(1);
		expect(await runsOf(offers)).toHaveLength(1);
		await runAutomations(Date.now());
		expect((await getContact(org.id, email)).properties?.score).toBe(11);
	});

	it("starts on birthdays once a year and on contacts who stopped engaging", async () => {
		const org = await setUp();
		await createProperty(org.id, { key: "birthday", type: "string" });
		const bday = await org.make({
			name: "Happy birthday",
			trigger: { type: "date", key: "birthday", offset_days: 0, yearly: true },
			steps: [{ type: "wait", days: 1 }],
		});
		const cold = await org.make({
			name: "Win back",
			trigger: { type: "inactive", days: 30 },
			steps: [{ type: "wait", days: 1 }],
		});
		const now = Date.parse("2026-11-08T15:13:00Z");
		const email = `d-${uid()}@guest.test`;
		await call(org.token, "POST", "/contacts", {
			email,
			properties: { birthday: "1990-11-08" },
		});
		await call(org.token, "POST", "/contacts", {
			email: `x-${uid()}@guest.test`,
			properties: { birthday: "1990-11-09" },
		});
		// Opened something 30 and a half days ago, nothing since.
		await db.insert(schema.emails).values({
			id: crypto.randomUUID(),
			organization_id: org.id,
			from: `hola@${org.domain}`,
			to: [email],
			recipient: email,
			subject: "October",
			status: "delivered",
			source: "broadcast",
			created_at: iso(now - 31 * 86_400_000),
			opened_at: iso(now - 30.5 * 86_400_000),
		});
		expect(await runDailyTriggers(now)).toBe(2);
		expect(await runDailyTriggers(now)).toBe(0); // once a day
		expect(await runsOf(bday)).toHaveLength(1);
		expect(await runsOf(cold)).toHaveLength(1);
	});

	it("starts on conversations of known contacts and acts on them", async () => {
		const org = await setUp();
		const inbox = crypto.randomUUID();
		await db.insert(schema.inboxes).values({
			id: inbox,
			organization_id: org.id,
			name: "Help",
			address: `help-${uid()}@${org.domain}`,
			created_at: iso(),
			updated_at: iso(),
		} as typeof schema.inboxes.$inferInsert);
		const id = await org.make({
			name: "Unhappy guests",
			trigger: { type: "conversation.rated", op: "at_most", rating: 2 },
			steps: [
				{ type: "conversation", action: "priority", value: "urgent" },
				{ type: "conversation", action: "tag", value: "Unhappy" },
			],
		});
		const email = `c-${uid()}@guest.test`;
		await call(org.token, "POST", "/contacts", { email });
		const cv = crypto.randomUUID();
		await db.insert(schema.conversations).values({
			id: cv,
			organization_id: org.id,
			inbox_id: inbox,
			subject: "Noisy room",
			contact: email,
			contact_address: email,
			last_message_at: iso(),
			created_at: iso(),
			updated_at: iso(),
			csat_rating: 1,
		} as typeof schema.conversations.$inferInsert);
		expect(await onConversation(cv, "rated")).toBe(1);
		await runAutomations(Date.now());
		const x = await db
			.select()
			.from(schema.conversations)
			.where(and(eq(schema.conversations.id, cv)))
			.get();
		expect(x?.priority).toBe("urgent");
		expect(x?.tags).toEqual(["unhappy"]);
		expect(await runsOf(id)).toHaveLength(1);
		// A visitor who isn't a contact starts nothing.
		await db
			.update(schema.conversations)
			.set({ contact_address: "stranger@else.test" })
			.where(eq(schema.conversations.id, cv));
		expect(await onConversation(cv, "rated")).toBe(0);
	});

	it("splits contacts the same way every time, about by the percent", () => {
		const a = Array.from({ length: 1000 }, (_, i) => splitSide(`run-${i}`, [2], 30));
		const share = a.filter(Boolean).length / 1000;
		expect(share).toBeGreaterThan(0.25);
		expect(share).toBeLessThan(0.35);
		expect(splitSide("run-1", [2], 30)).toBe(splitSide("run-1", [2], 30));
	});

	it("refuses steps that aren't the brand's", async () => {
		const org = await setUp();
		const bad = await call(org.token, "POST", "/automations", {
			name: "x",
			status: "active",
			trigger: { type: "unsubscribed" },
			steps: [{ type: "topic", topic_id: "nope", value: "opt_in" }],
		});
		expect(bad.status).toBe(422);
		const from = await call(org.token, "POST", "/automations", {
			name: "x",
			status: "active",
			trigger: { type: "unsubscribed" },
			steps: [{ type: "email", from: "me@gmail.com", subject: "Hi", body: "Hello" }],
		});
		expect(from.status).toBe(422);
		const hook = await call(org.token, "POST", "/automations", {
			name: "x",
			trigger: { type: "unsubscribed" },
			steps: [{ type: "webhook", url: "http://example.com/hook" }],
		});
		expect(hook.status).toBe(422);
	});
});
