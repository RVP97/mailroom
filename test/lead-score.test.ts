import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { contactLeadScore, getScoring, saveScoring, topLeads } from "@/server/lead-score";
import { matching } from "@/server/live-segments";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

async function contact(org: string, email: string, extra: Record<string, unknown> = {}) {
	const id = `ct-${uid()}`;
	await db.insert(schema.contacts).values({
		id,
		organization_id: org,
		email,
		created_at: iso(),
		updated_at: iso(),
		...extra,
	});
	return id;
}

async function event(org: string, contactId: string, name: string, value?: number) {
	await db.insert(schema.contactEvents).values({
		id: `ev-${uid()}`,
		organization_id: org,
		contact_id: contactId,
		name,
		value: value ?? null,
		currency: value ? "MXN" : null,
		created_at: iso(),
	});
}

describe("lead score", () => {
	it("adds points from rules, caps them and never goes below 0", async () => {
		const org = await seedOrg();
		const ana = await contact(org.id, "ana@example.com", { properties: { plan: "pro" } });
		const luis = await contact(org.id, "luis@example.com", { unsubscribed: true });
		const eva = await contact(org.id, "eva@example.com");
		expect((await getScoring(org.id)).custom).toBe(false);
		await saveScoring(
			org.id,
			{
				rules: [
					{ type: "event", name: "booking.viewed", points: 10, max: 20 },
					{ type: "purchase", points: 30 },
					{
						type: "match",
						condition: { type: "property", key: "plan", op: "is", value: "pro" },
						points: 5,
					},
					{ type: "match", condition: { type: "subscribed", value: false }, points: -50 },
				],
				hot: 40,
				warm: 15,
			},
			null,
		);
		for (let i = 0; i < 3; i++) await event(org.id, ana, "booking.viewed");
		await event(org.id, ana, "purchase", 1200);
		await event(org.id, luis, "booking.viewed");
		await event(org.id, eva, "booking.viewed");
		await event(org.id, eva, "booking.viewed");
		const a = await contactLeadScore(org.id, ana);
		// 20 (3 views, capped) + 30 (purchase) + 5 (pro)
		expect(a.score).toBe(55);
		expect(a.level).toBe("hot");
		expect(a.breakdown.map((b) => b.points)).toEqual([20, 30, 5]);
		expect((await contactLeadScore(org.id, luis)).score).toBe(0);
		expect((await contactLeadScore(org.id, eva)).level).toBe("warm");
		const top = await topLeads(org.id);
		expect(top.leads.map((l) => l.email)).toEqual(["ana@example.com", "eva@example.com"]);
		expect(top.counts).toMatchObject({ hot: 1, warm: 1, scored: 2, total: 3 });
		// Live segments pick by score.
		const hot = await matching(org.id, {
			match: "all",
			conditions: [{ type: "lead_score", op: "hot" }],
		});
		expect(hot).toEqual([ana]);
		const some = await matching(org.id, {
			match: "all",
			conditions: [{ type: "lead_score", op: "at_least", value: 10 }],
		});
		expect(some.sort()).toEqual([ana, eva].sort());
	});

	it("checks rules", async () => {
		const org = await seedOrg();
		await expect(saveScoring(org.id, { rules: [], hot: 10, warm: 20 }, null)).rejects.toThrow();
		await expect(
			saveScoring(
				org.id,
				{
					rules: [
						{ type: "match", condition: { type: "lead_score", op: "hot" }, points: 5 },
					],
				},
				null,
			),
		).rejects.toThrow();
		await expect(
			saveScoring(
				org.id,
				{
					rules: [
						{
							type: "match",
							condition: { type: "segment", segment_id: "nope", value: true },
							points: 5,
						},
					],
				},
				null,
			),
		).rejects.toThrow(/segment/);
	});
});
