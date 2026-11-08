import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { iso } from "@/server/time";
import { today, todaySpan } from "@/server/today";
import { seedOrg } from "./helpers";

const ME = "user-me";

async function conversation(org: string, id: string, extra: Record<string, unknown>) {
	const now = iso();
	await db.insert(schema.conversations).values({
		id,
		organization_id: org,
		subject: id,
		contact: `${id}@example.com`,
		status: "open",
		last_message_at: now,
		created_at: now,
		updated_at: now,
		...extra,
	});
}

describe("today", () => {
	it("gathers what needs the person now", async () => {
		const org = await seedOrg();
		const now = Date.now();
		await conversation(org.id, `late-${org.id}`, {
			sla_first_due_at: iso(now - 600_000),
			sla_breached: "first",
		});
		await conversation(org.id, `mine-${org.id}`, {
			assignee: `user:${ME}`,
			assignee_name: "Me",
			sla_first_due_at: iso(now + 3_600_000),
		});
		await conversation(org.id, `later-${org.id}`, {
			sla_first_due_at: iso(now + 10 * 3_600_000),
		});
		await db
			.update(schema.domains)
			.set({ paused_at: iso(now), paused_reason: "too many bounces" })
			.where(eq(schema.domains.id, org.domainId));
		await db
			.update(schema.orgSending)
			.set({ marketing_alert_level: "warning" })
			.where(eq(schema.orgSending.organization_id, org.id));
		const t = await today(
			{ brands: [org.id], userId: ME, canApprove: true, canReply: true, names: new Map() },
			now,
		);
		expect(t.sla.map((x) => x.id)).toEqual([`late-${org.id}`, `mine-${org.id}`]);
		expect(t.sla[0]?.breached).toBe(true);
		expect(t.mine.count).toBe(1);
		expect(t.unassigned).toBe(2);
		expect(t.deliverability.map((x) => x.level).sort()).toEqual(["danger", "warning"]);
		expect(t.deliverability.find((x) => x.level === "danger")?.text).toContain(
			"too many bounces",
		);
		// Another brand's things never show.
		const other = await seedOrg();
		const none = await today(
			{ brands: [other.id], userId: ME, canApprove: true, canReply: true, names: new Map() },
			now,
		);
		expect(none.sla).toHaveLength(0);
		expect(none.deliverability).toHaveLength(0);
	});

	it("knows where today starts and ends in the deployment's zone", () => {
		const at = Date.parse("2026-11-08T03:30:00Z");
		const mx = todaySpan(at, "America/Mexico_City");
		expect(mx.day).toBe("2026-11-07");
		expect(new Date(mx.start).toISOString()).toBe("2026-11-07T06:00:00.000Z");
		expect(new Date(mx.end).toISOString()).toBe("2026-11-08T06:00:00.000Z");
	});
});
