import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { localSpan, zonedInstant } from "@/lib/zoned";
import { broadcastReport } from "@/server/broadcast-report";
import {
	createBroadcast,
	resendBroadcast,
	runBroadcasts,
	sendBroadcast,
	variantStats,
} from "@/server/broadcasts";
import { createSegment, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { learnTimezone } from "@/server/tracking";
import { fakeOutside, seedOrg } from "./helpers";

beforeEach(async () => {
	await db.delete(schema.emails);
});

async function setUp(n: number) {
	fakeOutside();
	const org = await seedOrg();
	const seg = await createSegment(org.id, { name: "All" });
	for (let i = 0; i < n; i++)
		await upsertContact(org.id, {
			email: `c${String(i).padStart(3, "0")}@guest.test`,
			segments: [seg.id],
		});
	const b = await createBroadcast(org.id, org.id, {
		name: "News",
		segment_id: seg.id,
		from: `Hotel <news@${org.domain}>`,
		subject: "Subject A",
		html: "<p>Hi</p>",
	});
	return { org, seg, b };
}

const emailsOf = (id: string) =>
	db.select().from(schema.emails).where(eq(schema.emails.broadcast_id, id));

const broadcast = (id: string) =>
	db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get();

describe("A/B tests", () => {
	it("tests the subjects on part of the segment, then sends the winner to the rest", async () => {
		const { org, b } = await setUp(60);
		const t0 = Date.parse("2026-11-10T12:00:00Z");
		await sendBroadcast(org.id, b.id, null, t0, {
			ab_test: { subjects: ["Subject B"], metric: "opens", size: 50, wait_minutes: 60 },
		});
		await runBroadcasts(t0, b.id);
		const test = await emailsOf(b.id);
		// About half are in the test, split between A and B.
		expect(test.length).toBeGreaterThan(15);
		expect(test.length).toBeLessThan(45);
		expect(new Set(test.map((e) => e.variant))).toEqual(new Set([0, 1]));
		for (const e of test) expect(e.subject).toBe(e.variant === 0 ? "Subject A" : "Subject B");
		expect(await broadcast(b.id)).toMatchObject({
			status: "testing",
			test_ends_at: new Date(t0 + 3_600_000).toISOString(),
		});

		// B gets the opens.
		await db
			.update(schema.emails)
			.set({ sent_at: new Date(t0).toISOString() })
			.where(eq(schema.emails.broadcast_id, b.id));
		for (const e of test.filter((e) => e.variant === 1))
			await db
				.update(schema.emails)
				.set({ opened_at: new Date(t0).toISOString() })
				.where(eq(schema.emails.id, e.id));

		// Not before the test ends.
		expect(await runBroadcasts(t0 + 30 * 60_000)).toBe(0);
		await runBroadcasts(t0 + 61 * 60_000);
		const all = await emailsOf(b.id);
		expect(all).toHaveLength(60);
		const rest = all.filter((e) => e.variant === null);
		expect(rest.length).toBe(60 - test.length);
		expect(new Set(rest.map((e) => e.subject))).toEqual(new Set(["Subject B"]));
		expect(await broadcast(b.id)).toMatchObject({ status: "sent", ab_test: { winner: 1 } });
		const stats = await variantStats(b.id);
		expect(stats.find((s) => s.variant === 1)?.opened).toBe(
			test.filter((e) => e.variant === 1).length,
		);
	});

	it("can't be combined with a local-time send", async () => {
		const { org, b } = await setUp(1);
		await expect(
			sendBroadcast(org.id, b.id, null, Date.now(), {
				ab_test: { subjects: ["B"] },
				local_time: "2030-01-01T09:00",
			}),
		).rejects.toThrow(/local time/);
	});
});

describe("local-time sends", () => {
	it("knows when a wall-clock time happens in a zone", () => {
		expect(
			new Date(zonedInstant("2026-11-10T09:00", "America/Mexico_City")).toISOString(),
		).toBe("2026-11-10T15:00:00.000Z");
		expect(new Date(zonedInstant("2026-07-10T09:00", "Europe/Madrid")).toISOString()).toBe(
			"2026-07-10T07:00:00.000Z",
		);
		const { first, last } = localSpan("2026-11-10T09:00");
		expect(new Date(first).toISOString()).toBe("2026-11-09T19:00:00.000Z");
		expect(new Date(last).toISOString()).toBe("2026-11-10T21:00:00.000Z");
	});

	it("queues each contact for their own 9:00, and those unplaced in the deployment's zone", async () => {
		const { org, b } = await setUp(3);
		await db
			.update(schema.contacts)
			.set({ timezone: "Asia/Tokyo" })
			.where(eq(schema.contacts.email, "c000@guest.test"));
		await db
			.update(schema.contacts)
			.set({ timezone: "America/Mexico_City" })
			.where(eq(schema.contacts.email, "c001@guest.test"));
		const t0 = Date.parse("2026-11-09T12:00:00Z");
		const row = await sendBroadcast(org.id, b.id, null, t0, { local_time: "2026-11-10T09:00" });
		expect(row.scheduled_at).toBe("2026-11-09T19:00:00.000Z");
		expect(await runBroadcasts(t0)).toBe(0);
		await runBroadcasts(Date.parse("2026-11-09T19:00:00Z"));
		const at = Object.fromEntries((await emailsOf(b.id)).map((e) => [e.to[0], e.send_at]));
		expect(at).toEqual({
			"c000@guest.test": "2026-11-10T00:00:00.000Z",
			"c001@guest.test": "2026-11-10T15:00:00.000Z",
			// The test deployment's TIMEZONE, or UTC.
			"c002@guest.test": new Date(
				zonedInstant("2026-11-10T09:00", process.env.TIMEZONE || "UTC"),
			).toISOString(),
		});
	});
});

describe("resends and time zones", () => {
	it("resends to those who didn't open or click", async () => {
		const { org, b } = await setUp(3);
		await sendBroadcast(org.id, b.id, null);
		await runBroadcasts(Date.now(), b.id);
		const sent = await emailsOf(b.id);
		const now = new Date().toISOString();
		await db
			.update(schema.emails)
			.set({ sent_at: now })
			.where(eq(schema.emails.broadcast_id, b.id));
		const byTo = (a: string) => sent.find((e) => e.to[0] === a)?.id as string;
		await db
			.update(schema.emails)
			.set({ opened_at: now })
			.where(eq(schema.emails.id, byTo("c000@guest.test")));
		await db
			.update(schema.emails)
			.set({ clicked_at: now })
			.where(eq(schema.emails.id, byTo("c001@guest.test")));

		expect(await broadcast(b.id)).toMatchObject({ status: "sent" });
		const again = await resendBroadcast(org.id, b.id, { subject: "Did you see this?" });
		expect(again).toMatchObject({
			status: "draft",
			resend_of: b.id,
			subject: "Did you see this?",
		});
		await sendBroadcast(org.id, again.id, null);
		await runBroadcasts(Date.now(), again.id);
		expect((await emailsOf(again.id)).map((e) => [e.to[0], e.subject])).toEqual([
			["c002@guest.test", "Did you see this?"],
		]);

		// Its time zone is kept from where they open or click.
		await learnTimezone(byTo("c002@guest.test"), "Europe/Madrid");
		const c = await db
			.select()
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.email, "c002@guest.test"),
					eq(schema.contacts.organization_id, org.id),
				),
			)
			.get();
		expect(c?.timezone).toBe("Europe/Madrid");
	});
});

describe("broadcast reports", () => {
	it("counts each link's clickers, hour-by-hour opens and the apps people read in", async () => {
		const { org, b } = await setUp(3);
		await sendBroadcast(org.id, b.id, null);
		await runBroadcasts(Date.now(), b.id);
		const sent = await emailsOf(b.id);
		const start = "2026-11-10T09:15:00.000Z";
		await db
			.update(schema.emails)
			.set({ sent_at: start, opened_at: "2026-11-10T10:05:00.000Z" })
			.where(eq(schema.emails.broadcast_id, b.id));
		const event = (i: number, type: string, data: Record<string, unknown>) => ({
			id: `ev-${b.id}-${i}`,
			email_id: sent[i % sent.length]?.id as string,
			organization_id: org.id,
			type,
			at: start,
			data,
		});
		await db.insert(schema.emailEvents).values([
			event(0, "email.clicked", { click: { link: "https://hotel.test/rooms" } }),
			event(3, "email.clicked", { click: { link: "https://hotel.test/rooms" } }),
			event(1, "email.clicked", { click: { link: "https://hotel.test/rooms" } }),
			event(2, "email.clicked", { click: { link: "https://hotel.test/spa" } }),
			event(4, "email.opened", {
				open: {
					userAgent:
						"Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
				},
			}),
			event(5, "email.opened", {
				open: {
					userAgent:
						"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
				},
			}),
		]);
		const r = await broadcastReport(b.id, start, Date.parse("2026-11-10T12:30:00Z"));
		expect(r.links).toEqual([
			{ url: "https://hotel.test/rooms", clicks: 3, people: 2 },
			{ url: "https://hotel.test/spa", clicks: 1, people: 1 },
		]);
		expect(r.timeline.map((t) => [t.hour.slice(11, 13), t.opens])).toEqual([
			["09", 0],
			["10", 3],
			["11", 0],
			["12", 0],
		]);
		expect(r.apps.map((a) => a.name).sort()).toEqual(["Apple Mail (iPhone)", "Gmail"]);
	});
});
