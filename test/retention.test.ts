import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { purge } from "@/server/cron";
import { db, schema } from "@/server/db";
import { createEmails, parseSend } from "@/server/send";
import { dayOf, lastDays } from "@/server/time";
import { fakeOutside, seedOrg } from "./helpers";

describe("days in Mexico City", () => {
	it("puts 11:30 pm on the 31st in the 31st, and lists days across the new year", () => {
		expect(dayOf("2026-12-31T23:30:00-06:00")).toBe("2026-12-31");
		expect(dayOf("2027-01-01T05:59:59Z")).toBe("2026-12-31");
		expect(dayOf("2027-01-01T06:00:00Z")).toBe("2027-01-01");
		expect(lastDays(3, Date.parse("2027-01-01T05:30:00Z"))).toEqual([
			"2026-12-29",
			"2026-12-30",
			"2026-12-31",
		]);
	});
});

describe("retention", () => {
	it("drops old bodies and logs in chunks, but never the body of an email still waiting to go", async () => {
		fakeOutside();
		const org = await seedOrg();
		const old = Date.now() - 120 * 86_400_000;
		const inputs = Array.from({ length: 130 }, (_, i) =>
			parseSend({
				from: `a@${org.domain}`,
				to: `c${i}@cliente.test`,
				subject: "s",
				text: "t",
			}),
		);
		const sentLongAgo = await createEmails(org.id, inputs.slice(0, 120), { now: old });
		await db
			.update(schema.emails)
			.set({ status: "delivered" })
			.where(eq(schema.emails.organization_id, org.id));
		const waiting = await createEmails(
			org.id,
			[
				parseSend({
					from: `a@${org.domain}`,
					to: "w@cliente.test",
					subject: "s",
					text: "t",
					scheduled_at: new Date(Date.now() + 86_400_000).toISOString(),
				}),
			],
			{ now: Date.now() - 10 * 86_400_000 },
		);
		await purge(Date.now());
		const left = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, org.id));
		expect(left.map((r) => r.id)).toEqual([waiting[0]?.id]);
		const bodies = await db
			.select({ id: schema.emailBodies.email_id })
			.from(schema.emailBodies);
		expect(bodies.map((b) => b.id)).not.toEqual(expect.arrayContaining([sentLongAgo[0]?.id]));
		expect(bodies.map((b) => b.id)).toContain(waiting[0]?.id);
	});
});
