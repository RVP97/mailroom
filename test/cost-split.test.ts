import { describe, expect, it } from "vitest";
import { createBrand } from "@/server/brands";
import { splitMonth } from "@/server/cost-split";
import { db, schema } from "@/server/db";
import { seedOrg } from "./helpers";

const email = (organization_id: string, sent_at: string | null) => ({
	id: crypto.randomUUID(),
	organization_id,
	from: "a@b.test",
	to: ["c@d.test"],
	subject: "Hi",
	status: (sent_at ? "sent" : "queued") as "sent" | "queued",
	sent_at,
	created_at: sent_at ?? "2031-03-02T00:00:00.000Z",
});

describe("cost by organization", () => {
	it("splits the month's bill by each organization's share of its emails, brands included", async () => {
		await db.delete(schema.emails);
		const a = await seedOrg();
		const b = await seedOrg();
		const { brand } = await createBrand(a.id, { name: "Hotel Two" });
		const inMonth = "2031-03-10T12:00:00.000Z";
		await db.insert(schema.emails).values([
			email(a.id, inMonth),
			email(a.id, inMonth),
			email(brand.id, inMonth),
			email(b.id, inMonth),
			email(b.id, "2031-04-01T00:00:00.000Z"), // next month
			email(b.id, null), // not sent
		]);
		const split = await splitMonth(
			{
				start: "2031-03-01",
				total: 4,
				charges: 4,
				credits: 0,
				estimated: true,
				byService: [],
			},
			"USD",
		);
		expect(split.organizations.map((o) => [o.id, o.sent, o.amount])).toEqual([
			[a.id, 3, 3],
			[b.id, 1, 1],
		]);
		expect(split.organizations[0]?.brands).toEqual([
			{ id: brand.id, name: "Hotel Two", sent: 1, received: 0, amount: 1 },
		]);
		expect(split.organizations[0]?.share).toBeCloseTo(0.75);
	});
});
