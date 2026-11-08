import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createBroadcast, updateBroadcast } from "@/server/broadcasts";
import { contentCalendar, dayOf } from "@/server/calendar";
import { db, schema } from "@/server/db";
import { seedOrg, uid } from "./helpers";

describe("content calendar", () => {
	it("puts sent, scheduled and planned broadcasts on their days", async () => {
		const org = await seedOrg();
		const tz = "America/Mexico_City";
		const planned = await createBroadcast(org.id, org.id, {
			name: "Weekend offer",
			html: "",
			planned_on: "2026-11-20",
		});
		const scheduled = await createBroadcast(org.id, org.id, { name: "Rates", html: "" });
		await db
			.update(schema.broadcasts)
			.set({ status: "scheduled", scheduled_at: "2026-11-12T16:00:00.000Z" })
			.where(eq(schema.broadcasts.id, scheduled.id));
		const sent = await createBroadcast(org.id, org.id, { name: "News", html: "" });
		await db
			.update(schema.broadcasts)
			// 02:30 UTC on the 3rd is still the 2nd in Mexico City.
			.set({ status: "sent", started_at: "2026-11-03T02:30:00.000Z" })
			.where(eq(schema.broadcasts.id, sent.id));
		// Outside the range: not shown.
		await createBroadcast(org.id, org.id, {
			name: "Later",
			html: "",
			planned_on: "2027-01-05",
		});
		await db.insert(schema.campaigns).values({
			id: `cmp-${org.id}`,
			organization_id: org.id,
			name: "Holidays",
			starts_on: "2026-11-25",
			ends_on: "2027-01-06",
			created_at: "2026-11-01T00:00:00.000Z",
			updated_at: "2026-11-01T00:00:00.000Z",
		});
		const cal = await contentCalendar(
			{ brands: [org.id], names: new Map(), from: "2026-10-26", to: "2026-12-06" },
			tz,
		);
		const on = Object.fromEntries(cal.items.map((x) => [x.name, [x.state, x.day, x.time]]));
		expect(on).toEqual({
			News: ["sent", "2026-11-02", "20:30"],
			Rates: ["scheduled", "2026-11-12", "10:00"],
			"Weekend offer": ["planned", "2026-11-20", null],
		});
		expect(cal.campaigns.map((c) => c.name)).toEqual(["Holidays"]);
		// Moving the draft, then taking it off.
		await updateBroadcast(org.id, org.id, planned.id, { planned_on: "2026-11-21" });
		const moved = await contentCalendar(
			{ brands: [org.id], names: new Map(), from: "2026-11-21", to: "2026-11-21" },
			tz,
		);
		expect(moved.items.map((x) => x.name)).toEqual(["Weekend offer"]);
		await updateBroadcast(org.id, org.id, planned.id, { planned_on: null });
		const off = await contentCalendar(
			{ brands: [org.id], names: new Map(), from: "2026-11-21", to: "2026-11-21" },
			tz,
		);
		expect(off.items).toHaveLength(0);
		// Another brand sees nothing.
		const other = await seedOrg();
		const none = await contentCalendar(
			{ brands: [other.id], names: new Map(), from: "2026-10-26", to: "2026-12-06" },
			tz,
		);
		expect(none.items).toHaveLength(0);
		expect(none.campaigns).toHaveLength(0);
	});

	it("checks the range", async () => {
		await expect(
			contentCalendar({
				brands: ["x"],
				names: new Map(),
				from: "2026-01-01",
				to: "2026-06-01",
			}),
		).rejects.toThrow(/62 days/);
		await expect(
			contentCalendar({
				brands: ["x"],
				names: new Map(),
				from: "2026-1-1",
				to: "2026-01-02",
			}),
		).rejects.toThrow(/YYYY-MM-DD/);
		expect(dayOf("2026-11-08T05:59:00.000Z", "America/Mexico_City").day).toBe("2026-11-07");
	});

	it("shows automation emails sent and due, and when RSS issues are likely", async () => {
		const org = await seedOrg();
		const tz = "UTC";
		const DAY = 86_400_000;
		const now = Date.now();
		const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
		const at = new Date(now).toISOString();
		const auto = `au-${uid()}`;
		await db.insert(schema.automations).values({
			id: auto,
			organization_id: org.id,
			name: "Welcome series",
			status: "active",
			trigger: { type: "contact.created" },
			steps: [
				{ type: "wait", minutes: 2880 },
				{ type: "send", template_id: "t1" },
				{ type: "wait", minutes: 60 },
				{ type: "segment", action: "add", segment_id: "s1" },
			],
			created_at: at,
			updated_at: at,
		});
		const run = (step: number, next: number) => ({
			id: `run-${uid()}`,
			automation_id: auto,
			organization_id: org.id,
			contact_id: `ct-${uid()}`,
			step,
			status: "active" as const,
			next_at: new Date(next).toISOString(),
			created_at: at,
			updated_at: at,
		});
		await db.insert(schema.automationRuns).values([
			run(1, now + 2 * DAY),
			run(1, now + 2 * DAY + 60_000),
			// Waiting before a segment step: no email.
			run(3, now + 2 * DAY),
		]);
		await db.insert(schema.emails).values(
			[1, 2].map(() => ({
				id: crypto.randomUUID(),
				organization_id: org.id,
				from: "hola@hotel.test",
				to: ["ana@example.com"],
				subject: "Welcome",
				status: "delivered" as const,
				source: "automation",
				tags: [{ name: "automation", value: auto }],
				created_at: new Date(now - DAY).toISOString(),
			})),
		);
		// A newsletter whose feed made an issue every 7 days.
		const news = `nl-${uid()}`;
		await db.insert(schema.newsletters).values({
			id: news,
			organization_id: org.id,
			name: "Harbor Blog",
			slug: `blog-${uid()}`,
			rss_url: "https://blog.test/feed",
			rss_mode: "send",
			created_at: at,
			updated_at: at,
		});
		for (const ago of [15, 8, 1]) {
			const x = await createBroadcast(org.id, org.id, { name: `Posts ${ago}`, html: "" });
			await db
				.update(schema.broadcasts)
				.set({
					newsletter_id: news,
					rss_items: ["https://blog.test/p"],
					status: "sent",
					started_at: new Date(now - ago * DAY).toISOString(),
				})
				.where(eq(schema.broadcasts.id, x.id));
		}
		const cal = await contentCalendar(
			{
				brands: [org.id],
				names: new Map(),
				from: day(now - 3 * DAY),
				to: day(now + 20 * DAY),
			},
			tz,
		);
		expect(cal.automations).toEqual([
			expect.objectContaining({ day: day(now - DAY), state: "sent", emails: 2 }),
			expect.objectContaining({
				name: "Welcome series",
				day: day(now + 2 * DAY),
				state: "due",
				emails: 2,
			}),
		]);
		expect(cal.expected.map((e) => [e.day, e.every_days, e.mode])).toEqual([
			[day(now + 6 * DAY), 7, "send"],
			[day(now + 13 * DAY), 7, "send"],
			[day(now + 20 * DAY), 7, "send"],
		]);
	});
});
