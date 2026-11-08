import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createBroadcast, updateBroadcast } from "@/server/broadcasts";
import { contentCalendar, dayOf } from "@/server/calendar";
import { db, schema } from "@/server/db";
import { seedOrg } from "./helpers";

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
});
