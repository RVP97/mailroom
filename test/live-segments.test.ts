import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { recordEvent } from "@/server/automations";
import {
	addToSegment,
	createProperty,
	createSegment,
	getContact,
	renameSegment,
	upsertContact,
} from "@/server/contacts";
import { db, schema } from "@/server/db";
import {
	checkRules,
	previewRules,
	refreshLiveSegments,
	refreshSegment,
} from "@/server/live-segments";
import { iso } from "@/server/time";
import { fakeOutside, seedOrg, uid } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const members = async (segment: string) =>
	(
		await db
			.select({ id: schema.contactSegments.contact_id })
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.segment_id, segment))
	)
		.map((r) => r.id)
		.sort();

async function people() {
	fakeOutside();
	const org = await seedOrg();
	await createProperty(org.id, { key: "city", type: "string" });
	await createProperty(org.id, { key: "plan", type: "string" });
	const mk = async (name: string, properties: Record<string, string>) => {
		const email = `${name}-${uid()}@example.com`;
		await upsertContact(org.id, { email, first_name: name, properties });
		return getContact(org.id, email);
	};
	const ana = await mk("ana", { city: "Monterrey", plan: "pro" });
	const luis = await mk("luis", { city: "CDMX", plan: "pro" });
	const eva = await mk("eva", { city: "Monterrey", plan: "free" });
	return { org, ana, luis, eva };
}

describe("live segments", () => {
	it("keeps members matching property rules, all or any", async () => {
		const { org, ana, luis, eva } = await people();
		const all = await createSegment(org.id, {
			name: "Pro in Monterrey",
			rules: {
				match: "all",
				conditions: [
					{ type: "property", key: "city", op: "is", value: "monterrey" },
					{ type: "property", key: "plan", op: "is", value: "pro" },
				],
			},
		});
		expect(all.rules).toBeTruthy();
		expect(await members(all.id)).toEqual([ana.id]);
		const any = await createSegment(org.id, {
			name: "Monterrey or pro",
			rules: {
				match: "any",
				conditions: [
					{ type: "property", key: "city", op: "is", value: "Monterrey" },
					{ type: "property", key: "plan", op: "is", value: "pro" },
				],
			},
		});
		expect(await members(any.id)).toEqual([ana.id, luis.id, eva.id].sort());
	});

	it("follows events: people join when they do something and leave when it no longer fits", async () => {
		const { org, ana, luis } = await people();
		const s = await createSegment(org.id, {
			name: "Bought lately",
			rules: { conditions: [{ type: "event", name: "purchase", did: true, days: 30 }] },
		});
		expect(await members(s.id)).toEqual([]);
		await recordEvent(org.id, { event: "purchase", email: ana.email, data: { amount: 10 } });
		const row = await db
			.select()
			.from(schema.segments)
			.where(eq(schema.segments.id, s.id))
			.get();
		if (!row) throw new Error("no segment");
		expect(await refreshSegment(row)).toEqual({ joined: 1, left: 0 });
		expect(await members(s.id)).toEqual([ana.id]);
		// 31 days on, the purchase is out of the window.
		expect(await refreshSegment(row, Date.now() + 31 * 86_400_000)).toEqual({
			joined: 0,
			left: 1,
		});
		// Did not buy: everyone else.
		const not = await previewRules(org.id, {
			conditions: [{ type: "event", name: "purchase", did: false }],
		});
		expect(not.count).toBe(2);
		expect(not.sample.map((c) => c.id)).toContain(luis.id);
	});

	it("refuses hand changes and rules that name another live segment", async () => {
		const { org, ana } = await people();
		const live = await createSegment(org.id, {
			name: "Pro",
			rules: { conditions: [{ type: "property", key: "plan", op: "is", value: "pro" }] },
		});
		await expect(addToSegment(org.id, ana.id, live.id)).rejects.toThrow();
		await expect(
			checkRules(org.id, {
				conditions: [{ type: "segment", segment_id: live.id, value: true }],
			}),
		).rejects.toThrow(/list segment/);
		const list = await createSegment(org.id, { name: "Guests" });
		expect(list.rules).toBeNull();
		const ok = await checkRules(org.id, {
			conditions: [{ type: "segment", segment_id: list.id, value: false }],
		});
		expect(ok.match).toBe("all");
		await expect(
			checkRules(org.id, {
				conditions: [{ type: "segment", segment_id: "nope", value: true }],
			}),
		).rejects.toThrow();
	});

	it("turns a list live and back, and the cron refreshes stale ones", async () => {
		const { org, ana, eva } = await people();
		const s = await createSegment(org.id, { name: "Monterrey" });
		await renameSegment(org.id, s.id, {
			rules: {
				conditions: [{ type: "property", key: "city", op: "is", value: "Monterrey" }],
			},
		});
		expect(await members(s.id)).toEqual([ana.id, eva.id].sort());
		// Eva moves; the cron catches it once the segment is older than its refresh window.
		await db
			.update(schema.contacts)
			.set({ properties: { city: "Puebla", plan: "free" } })
			.where(eq(schema.contacts.id, eva.id));
		await db
			.update(schema.segments)
			.set({ refreshed_at: iso(Date.now() - 20 * 60_000) })
			.where(eq(schema.segments.id, s.id));
		expect(await refreshLiveSegments()).toBeGreaterThanOrEqual(1);
		expect(await members(s.id)).toEqual([ana.id]);
		// Back to a list: its members stay, and it can be changed by hand again.
		const back = await renameSegment(org.id, s.id, { rules: null });
		expect(back.rules).toBeNull();
		await addToSegment(org.id, eva.id, s.id);
		expect(await members(s.id)).toEqual([ana.id, eva.id].sort());
	});
});
