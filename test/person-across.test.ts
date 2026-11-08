import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { forgetOrg } from "@/server/org";
import { personAcrossBrands } from "@/server/person-across";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

async function brandOf(orgId: string) {
	const b = await seedOrg();
	await db.insert(schema.brands).values({
		id: b.id,
		parent_id: orgId,
		external_id: `ext_${uid()}`,
		created_at: iso(),
	});
	forgetOrg(b.id);
	forgetOrg(orgId);
	return b;
}

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

const mail = (org: string, to: string, opened = false) => ({
	id: crypto.randomUUID(),
	organization_id: org,
	from: "news@hotel.test",
	to: [to],
	recipient: to,
	subject: "News",
	status: "delivered" as const,
	source: "broadcast",
	created_at: iso(),
	opened_at: opened ? iso() : null,
});

describe("one person across brands", () => {
	it("joins each brand's contact, emails, conversations, blocks and purchases", async () => {
		const org = await seedOrg();
		const cafe = await brandOf(org.id);
		const spa = await brandOf(org.id);
		const quiet = await brandOf(org.id);
		const ana = await contact(org.id, "ana@example.com", { first_name: "Ana" });
		await contact(cafe.id, "ana@example.com", { unsubscribed: true });
		await db
			.insert(schema.emails)
			.values([
				mail(org.id, "ana@example.com", true),
				mail(org.id, "ana@example.com"),
				mail(spa.id, "ana@example.com"),
			]);
		await db.insert(schema.conversations).values({
			id: `cv-${uid()}`,
			organization_id: cafe.id,
			subject: "Table for two",
			contact: "ana@example.com",
			contact_address: "ana@example.com",
			last_message_at: iso(),
			created_at: iso(),
			updated_at: iso(),
		});
		await db.insert(schema.suppressions).values({
			organization_id: spa.id,
			address: "ana@example.com",
			reason: "complaint",
			created_at: iso(),
		});
		await db.insert(schema.contactEvents).values({
			id: `ev-${uid()}`,
			organization_id: org.id,
			contact_id: ana,
			name: "booking.completed",
			value: 2100.5,
			currency: "MXN",
			created_at: iso(),
		});

		const p = await personAcrossBrands(org.id, " Ana@Example.com ");
		expect(p.email).toBe("ana@example.com");
		expect(p.name).toBe("Ana");
		// The brand that never heard of her isn't listed.
		expect(p.brands.map((b) => b.brand_id).sort()).toEqual([org.id, cafe.id, spa.id].sort());
		expect(p.brands.some((b) => b.brand_id === quiet.id)).toBe(false);
		const by = Object.fromEntries(p.brands.map((b) => [b.brand_id, b]));
		expect(by[org.id]).toMatchObject({
			contact: { id: ana, unsubscribed: false },
			emails: { sent: 2, opened: 1 },
			spent: [{ currency: "MXN", value: 2100.5, purchases: 1 }],
		});
		expect(by[cafe.id]).toMatchObject({
			contact: { unsubscribed: true },
			conversations: { total: 1, open: 1 },
		});
		expect(by[spa.id]).toMatchObject({ contact: null, suppressed: "complaint" });
		expect(p.totals).toMatchObject({ brands: 3, contacts: 2, emails: 3, conversations: 1 });

		// Another organization sees none of it.
		const other = await seedOrg();
		expect((await personAcrossBrands(other.id, "ana@example.com")).brands).toEqual([]);
	});
});
