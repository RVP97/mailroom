import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { getKit, saveKit } from "@/server/library";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

describe("brand kit everywhere", () => {
	it("puts the kit's color and fonts on every page when it's saved", async () => {
		const org = await seedOrg();
		const now = iso();
		const form = `sf-${uid()}`;
		await db.insert(schema.signupForms).values({
			id: form,
			organization_id: org.id,
			name: "Newsletter",
			title: "Our news",
			from: "news@example.com",
			design: { accent: "#111111", button: "Join" },
			created_at: now,
			updated_at: now,
		});
		const news = `nl-${uid()}`;
		await db.insert(schema.newsletters).values({
			id: news,
			organization_id: org.id,
			name: "Weekly",
			slug: `weekly-${uid()}`,
			accent: "#222222",
			look: { layout: "cards" },
			created_at: now,
			updated_at: now,
		});
		// Without "everywhere", nothing else changes.
		await saveKit(org.id, { accent: "#ff5500" }, null);
		const before = await db
			.select({ design: schema.signupForms.design })
			.from(schema.signupForms)
			.where(eq(schema.signupForms.id, form))
			.get();
		expect(before?.design.accent).toBe("#111111");
		const kit = await saveKit(
			org.id,
			{ accent: "#ff5500", font: "georgia", heading_font: "georgia", everywhere: true },
			null,
		);
		expect(
			(kit as typeof kit & { applied?: { signup_forms: number } }).applied?.signup_forms,
		).toBe(1);
		const after = await db
			.select({ design: schema.signupForms.design })
			.from(schema.signupForms)
			.where(eq(schema.signupForms.id, form))
			.get();
		// The form keeps its own words.
		expect(after?.design).toMatchObject({ accent: "#ff5500", button: "Join" });
		const n = await db
			.select({ accent: schema.newsletters.accent, look: schema.newsletters.look })
			.from(schema.newsletters)
			.where(eq(schema.newsletters.id, news))
			.get();
		expect(n?.accent).toBe("#ff5500");
		expect(n?.look).toMatchObject({
			layout: "cards",
			font: "georgia",
			heading_font: "georgia",
		});
		expect((await getKit(org.id))?.everywhere).toBe(true);
		// Another brand's pages are left alone.
		const other = await seedOrg();
		await saveKit(other.id, { accent: "#00ff00", everywhere: true }, null);
		const still = await db
			.select({ design: schema.signupForms.design })
			.from(schema.signupForms)
			.where(eq(schema.signupForms.id, form))
			.get();
		expect(still?.design.accent).toBe("#ff5500");
	});
});
