import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSegment, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import {
	cleanUpCold,
	coldContacts,
	engagementOf,
	engagementOverview,
	scoreOf,
} from "@/server/engagement";
import { iso } from "@/server/time";
import { seedOrg } from "./helpers";

const DAY = 86_400_000;
const now = Date.parse("2031-06-01T12:00:00.000Z");
const old = "2031-01-01T00:00:00.000Z";

const mail = (
	org: string,
	to: string,
	daysAgo: number,
	o: { opened?: boolean; clicked?: boolean; source?: string; broadcast?: boolean } = {},
) => ({
	id: crypto.randomUUID(),
	organization_id: org,
	from: "news@hotel.test",
	to: [to],
	subject: "News",
	status: "delivered" as const,
	source: o.source ?? "broadcast",
	broadcast_id: o.broadcast === false ? null : "b-1",
	created_at: iso(now - daysAgo * DAY),
	opened_at: o.opened || o.clicked ? iso(now - daysAgo * DAY + 3_600_000) : null,
	clicked_at: o.clicked ? iso(now - daysAgo * DAY + 3_600_000) : null,
});

describe("engagement", () => {
	it("scores from opens, clicks and how recent; too few emails is too new to tell", () => {
		expect(scoreOf(undefined).level).toBe("new");
		expect(
			scoreOf({ sent: 2, opened: 0, clicked: 0, last_sent_at: null, last_engaged_at: null })
				.level,
		).toBe("new");
		// One opened email (or four) is still too little to call anyone engaged.
		const once = scoreOf(
			{ sent: 1, opened: 1, clicked: 0, last_sent_at: null, last_engaged_at: iso(now - DAY) },
			now,
		);
		expect(once).toMatchObject({ score: null, level: "new", stars: 0 });
		expect(
			scoreOf(
				{ sent: 4, opened: 4, clicked: 2, last_sent_at: null, last_engaged_at: iso(now) },
				now,
			).level,
		).toBe("new");
		const fan = scoreOf(
			{ sent: 6, opened: 6, clicked: 3, last_sent_at: null, last_engaged_at: iso(now - DAY) },
			now,
		);
		expect(fan).toMatchObject({ level: "champion", stars: 5 });
		const quiet = scoreOf(
			{ sent: 8, opened: 0, clicked: 0, last_sent_at: null, last_engaged_at: null },
			now,
		);
		expect(quiet).toMatchObject({ score: 0, level: "cold", stars: 1 });
		const fading = scoreOf(
			{
				sent: 8,
				opened: 2,
				clicked: 0,
				last_sent_at: null,
				last_engaged_at: iso(now - 50 * DAY),
			},
			now,
		);
		expect(fading.level).toBe("cooling");
	});

	it("finds cold contacts and cleans them up: a segment, unsubscribed, or deleted", async () => {
		const org = await seedOrg();
		const add = async (email: string) =>
			(await upsertContact(org.id, { email }, Date.parse(old))).contact;
		const fan = await add("fan@guest.test");
		const ghost = await add("ghost@guest.test");
		const ghost2 = await add("ghost2@guest.test");
		await add("new@guest.test");
		const rows = [
			...[1, 8, 15, 22, 29].map((d) =>
				mail(org.id, "fan@guest.test", d, { clicked: d < 10, opened: true }),
			),
			...[1, 8, 15, 22, 29, 36].map((d) => mail(org.id, "ghost@guest.test", d)),
			...[1, 8, 15, 22, 29].map((d) => mail(org.id, "Ghost2@Guest.test", d)),
			mail(org.id, "new@guest.test", 1),
			// Transactional mail doesn't count; automations do.
			mail(org.id, "fan@guest.test", 2, { source: "api", broadcast: false }),
		];
		for (let i = 0; i < rows.length; i += 5)
			await db.insert(schema.emails).values(rows.slice(i, i + 5));

		const e = await engagementOf(org.id, [fan, ghost]);
		expect(e.get(fan.id)).toMatchObject({ level: "champion", sent: 5, opened: 5, clicked: 2 });
		expect(e.get(ghost.id)).toMatchObject({ level: "cold", sent: 6, opened: 0 });

		const overview = await engagementOverview(org.id, now);
		expect(overview).toMatchObject({ total: 4, levels: { champion: 1, cold: 2, new: 1 } });

		const cold = await coldContacts(org.id, { min_emails: 6, days: 90 }, now);
		expect(cold.map((c) => c.email)).toEqual(["ghost@guest.test"]);
		const cold5 = await coldContacts(org.id, { min_emails: 5, days: 90 }, now);
		expect(cold5).toHaveLength(2);

		const seg = await createSegment(org.id, { name: "Win back" });
		expect(
			await cleanUpCold(
				org.id,
				{ min_emails: 5, days: 90, action: "segment", segment_id: seg.id },
				now,
			),
		).toEqual({ count: 2 });
		const members = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.segment_id, seg.id));
		expect(members).toHaveLength(2);

		expect(
			await cleanUpCold(
				org.id,
				{ min_emails: 5, days: 90, action: "unsubscribe", ids: [ghost2.id] },
				now,
			),
		).toEqual({ count: 1 });
		const g2 = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.id, ghost2.id))
			.get();
		expect(g2?.unsubscribed).toBe(true);
		const out = await db
			.select()
			.from(schema.unsubscribes)
			.where(eq(schema.unsubscribes.organization_id, org.id));
		expect(out.map((u) => u.address)).toContain("ghost2@guest.test");

		expect(
			await cleanUpCold(org.id, { min_emails: 5, days: 90, action: "delete" }, now),
		).toEqual({ count: 1 });
		const left = await db
			.select()
			.from(schema.contacts)
			.where(eq(schema.contacts.organization_id, org.id));
		expect(left.map((c) => c.email).sort()).toEqual([
			"fan@guest.test",
			"ghost2@guest.test",
			"new@guest.test",
		]);
	});
});
