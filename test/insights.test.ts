import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { db, schema } from "@/server/db";
import {
	percentile,
	statsByStream,
	statsByTag,
	statsByTemplate,
	timeToInbox,
} from "@/server/insights";
import { checkSlowDelivery } from "@/server/slow-delivery";
import { dayOf, iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

const NOW = Date.parse("2027-02-10T18:00:00.000Z");

function email(
	org: string,
	o: Partial<typeof schema.emails.$inferInsert> & { seconds?: number } = {},
) {
	const { seconds = 3, ...rest } = o;
	const sent = NOW - 30 * 60_000;
	return {
		id: crypto.randomUUID(),
		organization_id: org,
		from: "Acme <hola@mail.acme.test>",
		to: [`c${uid()}@gmail.com`],
		subject: "s",
		source: "api",
		status: "delivered",
		created_at: iso(sent),
		sent_at: iso(sent),
		delivered_at: iso(sent + seconds * 1000),
		...rest,
	} satisfies typeof schema.emails.$inferInsert;
}

describe("insights", () => {
	it("counts each template's and tag's emails, leaving out ones that never went out", async () => {
		const org = await seedOrg();
		const tpl = `tpl_${uid()}`;
		await db.insert(schema.templates).values({
			id: tpl,
			organization_id: org.id,
			name: "Password reset",
			draft: { subject: "Reset", html: "<p>x</p>" },
			created_at: iso(NOW),
			updated_at: iso(NOW),
		} as typeof schema.templates.$inferInsert);
		const tags = [{ name: "category", value: "login" }];
		await db.insert(schema.emails).values([
			email(org.id, { template_id: tpl, tags, opened_at: iso(NOW) }),
			email(org.id, { template_id: tpl, tags }),
			email(org.id, {
				template_id: tpl,
				tags,
				status: "bounced",
				delivered_at: null,
				bounced_at: iso(NOW),
			}),
			email(org.id, {
				template_id: tpl,
				tags,
				status: "suppressed",
				sent_at: null,
				delivered_at: null,
			}),
			email(org.id, { tags: [{ name: "mailroom_broadcast", value: "x" }] }),
		]);
		const [t] = await statsByTemplate(org.id, 30, NOW);
		expect(t).toMatchObject({ name: "Password reset", sent: 3, delivered: 2, bounced: 1 });
		expect(t?.openRate).toBeCloseTo(0.5);
		const byTag = await statsByTag(org.id, 30, NOW);
		expect(byTag).toHaveLength(1);
		expect(byTag[0]).toMatchObject({ name: "category", value: "login", sent: 3 });
	});

	it("splits transactional and marketing domains", async () => {
		const org = await seedOrg();
		await db.insert(schema.domains).values({
			id: `dom_${uid()}`,
			organization_id: org.id,
			name: `news.${org.domain}`,
			status: "verified",
			dkim_tokens: [],
			region: "us-east-1",
			created_at: iso(NOW),
			purpose: "marketing",
		});
		const day = dayOf(NOW);
		await db.insert(schema.domainStats).values([
			{ organization_id: org.id, day, domain: org.domain, sent: 100, delivered: 99 },
			{
				organization_id: org.id,
				day,
				domain: `news.${org.domain}`,
				sent: 50,
				delivered: 40,
				complained: 1,
			},
		]);
		const [tx, mkt] = await statsByStream(org.id, 7, NOW);
		expect(tx).toMatchObject({ stream: "transactional", sent: 100, delivered: 99 });
		expect(mkt).toMatchObject({ stream: "marketing", sent: 50, complained: 1 });
		expect(mkt?.complaint).toBe("danger");
	});

	it("measures time to inbox per provider, broadcasts aside", async () => {
		const org = await seedOrg();
		await db
			.insert(schema.emails)
			.values([
				email(org.id, { seconds: 2 }),
				email(org.id, { seconds: 4 }),
				email(org.id, { seconds: 600, to: ["a@hotmail.com"] }),
				email(org.id, { seconds: 9000, broadcast_id: "b_1" }),
			]);
		const t = await timeToInbox(org.id, 1, NOW);
		expect(t.all.count).toBe(3);
		expect(t.all.median).toBeCloseTo(4, 0);
		expect(t.byProvider.map((p) => p.provider)).toEqual(["gmail", "outlook"]);
		expect(t.byProvider[1]?.slowShare).toBe(1);
		expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
	});

	it("emails owners once a day when emails take minutes to arrive", async () => {
		const org = await seedOrg();
		for (let i = 0; i < 25; i += 5)
			await db
				.insert(schema.emails)
				.values(Array.from({ length: 5 }, () => email(org.id, { seconds: 240 })));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await checkSlowDelivery(NOW);
		const subjects = () =>
			log.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes("taking long to arrive"));
		const first = subjects().length;
		expect(first).toBeGreaterThan(0);
		const row = await db
			.select()
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, org.id))
			.get();
		expect(row?.slow_alerted_at).toBe(iso(NOW));
		await checkSlowDelivery(NOW + 3_600_000);
		expect(subjects().length).toBe(first);
		log.mockRestore();
	});
});

describe("weekly digest", () => {
	it("sums up the organization's week, says what needs a look, and sends once a week", async () => {
		const { runWeeklyDigest, digestFor, setDigestEnabled } = await import("@/server/digest");
		const org = await seedOrg();
		const day = dayOf(NOW - 86_400_000);
		await db.insert(schema.dailyStats).values({
			organization_id: org.id,
			day,
			sent: 200,
			delivered: 196,
			bounced: 2,
			opened: 80,
		});
		await db
			.update(schema.domains)
			.set({ paused_at: iso(NOW) })
			.where(eq(schema.domains.id, org.domainId));
		const lines = await digestFor(org.id, NOW);
		expect(lines?.[0]).toContain("sent 200 emails");
		expect(lines?.join(" ")).toContain(`${org.domain} is paused.`);

		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const sent = () =>
			log.mock.calls
				.map((c) => String(c[0]))
				.filter((l) => l.includes(`Org ${org.id}: your week in email`)).length;
		await runWeeklyDigest(NOW);
		const first = sent();
		expect(first).toBeGreaterThan(0);
		await runWeeklyDigest(NOW + 60_000);
		expect(sent()).toBe(first);
		await setDigestEnabled(org.id, false);
		await runWeeklyDigest(NOW + 8 * 86_400_000);
		expect(sent()).toBe(first);
		log.mockRestore();
	});
});
