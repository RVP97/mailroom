import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { memberActor } from "@/server/inboxes";
import { searchEverything } from "@/server/search";
import { iso } from "@/server/time";
import { seedOrg } from "./helpers";

const actor = (org: string, masked = false) =>
	memberActor({
		organizationId: org,
		brands: [org],
		userId: "user-me",
		name: "Me",
		canReply: true,
		masked,
	});

describe("search everything", () => {
	it("finds contacts, conversations, broadcasts and more in the brand only", async () => {
		const org = await seedOrg();
		const now = iso();
		await db.insert(schema.contacts).values({
			id: `ct-${org.id}`,
			organization_id: org.id,
			email: "sofia.marin@example.com",
			first_name: "Sofía",
			last_name: "Marín",
			created_at: now,
			updated_at: now,
		});
		await db.insert(schema.conversations).values({
			id: `cv-${org.id}`,
			organization_id: org.id,
			subject: "Marina view room booking 20261108",
			contact: "guest@example.com",
			status: "open",
			last_message_at: now,
			created_at: now,
			updated_at: now,
		});
		await db.insert(schema.broadcasts).values({
			id: `b-${org.id}`,
			organization_id: org.id,
			name: "Marina weekend",
			subject: "Our marina",
			html: "",
			created_at: now,
			updated_at: now,
		});
		const r = await searchEverything({
			organizationId: org.id,
			brands: [org.id],
			actor: actor(org.id),
			q: "marin",
			names: new Map(),
			masked: false,
		});
		const kinds = r.hits.map((h) => `${h.kind}:${h.id}`);
		expect(kinds).toContain(`contact:ct-${org.id}`);
		expect(kinds).toContain(`conversation:cv-${org.id}`);
		expect(kinds).toContain(`broadcast:b-${org.id}`);
		expect(r.hits.find((h) => h.kind === "contact")?.title).toBe("Sofía Marín");
		expect(r.hits.find((h) => h.kind === "broadcast")?.path).toBe(`/broadcasts/b-${org.id}`);
		// Only some kinds.
		const only = await searchEverything({
			organizationId: org.id,
			brands: [org.id],
			actor: actor(org.id),
			q: "marin",
			names: new Map(),
			masked: false,
			kinds: ["broadcast"],
		});
		expect(only.hits.map((h) => h.kind)).toEqual(["broadcast"]);
		// Masked members see codes as dots.
		const masked = await searchEverything({
			organizationId: org.id,
			brands: [org.id],
			actor: actor(org.id, true),
			q: "marina view",
			names: new Map(),
			masked: true,
		});
		expect(masked.hits.find((h) => h.kind === "conversation")?.title).not.toContain("20261108");
		// Another brand finds nothing of this one; one letter finds nothing at all.
		const other = await seedOrg();
		const none = await searchEverything({
			organizationId: other.id,
			brands: [other.id],
			actor: actor(other.id),
			q: "marin",
			names: new Map(),
			masked: false,
		});
		expect(none.hits).toHaveLength(0);
		const short = await searchEverything({
			organizationId: org.id,
			brands: [org.id],
			actor: actor(org.id),
			q: "m",
			names: new Map(),
			masked: false,
		});
		expect(short.hits).toHaveLength(0);
	});
});
