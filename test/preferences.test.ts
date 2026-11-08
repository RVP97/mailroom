import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createSegment, getContact, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { heldOutCount, marketingRules } from "@/server/marketing-rules";
import { createEmails, parseSend } from "@/server/send";
import { iso } from "@/server/time";
import { handleUnsubscribePage } from "@/server/unsubscribes";
import { fakeOutside, seedOrg, uid } from "./helpers";

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

const linkIn = (raw: string) =>
	/List-Unsubscribe: <([^>]+)>/.exec(raw.replace(/\r?\n[ \t]+/g, " "))?.[1] as string;

describe("preference center", () => {
	it("shows newsletters, how often, and conversations, and saves them", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const now = Date.now();
		const readers = await createSegment(org.id, { name: "Readers" });
		const all = await createSegment(org.id, { name: "All" });
		await db.insert(schema.newsletters).values({
			id: `nl_${uid()}`,
			organization_id: org.id,
			name: "The Harbor Letter",
			slug: `letter-${uid()}`,
			description: "Once a month",
			segment_id: readers.id,
			created_at: iso(now),
			updated_at: iso(now),
		} as never);
		await upsertContact(org.id, { email: "ana@cliente.test", segments: [readers.id, all.id] });
		await upsertContact(org.id, { email: "luis@cliente.test", segments: [all.id] });
		await db.insert(schema.conversations).values({
			id: `cv_${uid()}`,
			organization_id: org.id,
			subject: "Late check-out?",
			contact: "ana@cliente.test",
			contact_address: "ana@cliente.test",
			status: "resolved",
			last_message_at: iso(now - 86_400_000),
			created_at: iso(now - 86_400_000),
			updated_at: iso(now - 86_400_000),
		});
		await createEmails(org.id, [
			parseSend({
				from: `Harbor <news@${org.domain}>`,
				to: "ana@cliente.test",
				subject: "News",
				html: "<p>Hi</p>",
				unsubscribe_group: "g",
			}),
		]);
		const url = linkIn(rawOf(aws.sends[0] as never));
		const page = await (await handleUnsubscribePage(new Request(url))).text();
		expect(page).toContain("The Harbor Letter");
		expect(page).toContain("How often");
		expect(page).toContain("At most one a week");
		expect(page).toContain("Your conversations with us");
		expect(page).toContain("Late check-out?");

		const post = (body: string) =>
			handleUnsubscribePage(
				new Request(url, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
				}),
			);
		// Leaves the newsletter, and wants one a week.
		const saved = await (await post("action=preferences&pace=weekly")).text();
		expect(saved).toContain("Your preferences are saved.");
		const ana = await getContact(org.id, "ana@cliente.test");
		expect(ana.pace).toBe("weekly");
		const inReaders = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.segment_id, readers.id));
		expect(inReaders).toHaveLength(0);

		// She got a broadcast two days ago: the next one this week skips her.
		await db.insert(schema.emails).values({
			id: crypto.randomUUID(),
			organization_id: org.id,
			from: `news@${org.domain}`,
			to: ["ana@cliente.test"],
			recipient: "ana@cliente.test",
			subject: "Last week",
			status: "sent",
			source: "broadcast",
			broadcast_id: `b_${uid()}`,
			created_at: iso(now - 2 * 86_400_000),
		});
		const rules = await marketingRules(org.id);
		expect(await heldOutCount(org.id, all.id, rules)).toBe(1);

		// Pauses everything for 30 days.
		const paused = await (await post("action=preferences&pace=pause&newsletter=x")).text();
		expect(paused).toContain("Paused until");
		const after = await getContact(org.id, "ana@cliente.test");
		const until = Date.parse(after.paused_until ?? "");
		expect(until - now).toBeGreaterThan(29 * 86_400_000);
		expect(await heldOutCount(org.id, all.id, rules)).toBe(1);

		// Back to everything.
		await post("action=preferences&pace=all");
		const back = await getContact(org.id, "ana@cliente.test");
		expect(back.pace).toBeNull();
		expect(back.paused_until).toBeNull();
	});
});
