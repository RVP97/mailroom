import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { insightDetail, parseSubject, subjectTitle } from "@/server/insight-detail";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

const NOW = Date.parse("2027-02-10T18:00:00.000Z");
const HOUR = 3_600_000;

function email(
	org: string,
	o: Partial<typeof schema.emails.$inferInsert> & { seconds?: number; at?: number } = {},
) {
	const { seconds = 3, at = NOW - HOUR, ...rest } = o;
	return {
		id: crypto.randomUUID(),
		organization_id: org,
		from: "Acme <hola@mail.acme.test>",
		to: [`c${uid()}@gmail.com`],
		subject: "Your code",
		source: "api",
		status: "delivered",
		created_at: iso(at),
		sent_at: iso(at),
		delivered_at: iso(at + seconds * 1000),
		...rest,
	} satisfies typeof schema.emails.$inferInsert;
}

describe("insight detail", () => {
	it("reads a URL's kind and key", () => {
		expect(parseSubject("template", "tpl_1")).toEqual({ kind: "template", id: "tpl_1" });
		expect(parseSubject("tag", "category:receipt")).toEqual({
			kind: "tag",
			name: "category",
			value: "receipt",
		});
		expect(parseSubject("tag", "a:b:c")).toMatchObject({ name: "a", value: "b:c" });
		expect(parseSubject("tag", "nocolon")).toBeNull();
		expect(parseSubject("provider", "gmail")).toEqual({ kind: "provider", provider: "gmail" });
		expect(parseSubject("provider", "aol")).toBeNull();
		expect(parseSubject("nope", "x")).toBeNull();
	});

	it("sums up one template: totals, the period before, speed, providers and reasons", async () => {
		const org = await seedOrg();
		const tpl = `tpl_${uid()}`;
		await db.insert(schema.templates).values({
			id: tpl,
			organization_id: org.id,
			name: "Login code",
			draft: { subject: "Code", html: "<p>x</p>" },
			created_at: iso(NOW),
			updated_at: iso(NOW),
		} as typeof schema.templates.$inferInsert);
		const rows = [
			email(org.id, { template_id: tpl, seconds: 2, opened_at: iso(NOW - HOUR + 60_000) }),
			email(org.id, { template_id: tpl, seconds: 10, to: [`x${uid()}@hotmail.com`] }),
			email(org.id, { template_id: tpl, seconds: 120, to: [`Ana <a${uid()}@yahoo.com>`] }),
			email(org.id, {
				template_id: tpl,
				status: "bounced",
				bounce_type: "Permanent",
				delivered_at: null,
				bounced_at: iso(NOW),
			}),
			// Never went out: left out.
			email(org.id, {
				template_id: tpl,
				status: "suppressed",
				sent_at: null,
				delivered_at: null,
			}),
			// Another template: left out.
			email(org.id, { template_id: "other" }),
			// The period before.
			email(org.id, { template_id: tpl, at: NOW - 40 * 86_400_000 }),
		];
		for (let i = 0; i < rows.length; i += 4)
			await db.insert(schema.emails).values(rows.slice(i, i + 4));

		const d = await insightDetail(org.id, { kind: "template", id: tpl }, 30, NOW);
		expect(d.totals).toMatchObject({ sent: 4, delivered: 3, bounced: 1, opened: 1 });
		expect(d.previous.sent).toBe(1);
		expect(d.series).toHaveLength(30);
		expect(d.series.reduce((s, r) => s + r.sent, 0)).toBe(4);
		expect(d.latency.count).toBe(3);
		expect(d.latency.median).toBeCloseTo(10, 0);
		expect(d.latency.slowShare).toBeCloseTo(1 / 3);
		expect(d.latency.buckets.reduce((s, b) => s + b.count, 0)).toBe(3);
		expect(d.latency.toOpen.median).toBeCloseTo(58, 0);
		expect(d.byProvider.map((p) => p.provider).sort()).toEqual(["gmail", "outlook", "yahoo"]);
		expect(d.byProvider.find((p) => p.provider === "gmail")?.sent).toBe(2);
		expect(d.bySender).toEqual([
			expect.objectContaining({ domain: "mail.acme.test", sent: 4 }),
		]);
		expect(d.byTemplate).toEqual([]);
		expect(d.notDelivered).toEqual([{ status: "bounced", bounceType: "Permanent", count: 1 }]);
		expect(d.opensByHour.reduce((s, h) => s + h.opened, 0)).toBe(1);
		expect(d.recent).toHaveLength(4);
		expect(await subjectTitle(org.id, { kind: "template", id: tpl })).toMatchObject({
			title: "Login code",
			exists: true,
		});
	});

	it("filters a tag and a provider, with the templates behind them", async () => {
		const org = await seedOrg();
		const tags = [{ name: "category", value: "receipt" }];
		await db
			.insert(schema.emails)
			.values([
				email(org.id, { tags, template_id: "t1" }),
				email(org.id, { tags, to: [`o${uid()}@outlook.com`] }),
				email(org.id, { tags: [{ name: "category", value: "login" }] }),
			]);
		const tag = await insightDetail(
			org.id,
			{ kind: "tag", name: "category", value: "receipt" },
			30,
			NOW,
		);
		expect(tag.totals.sent).toBe(2);
		expect(tag.byTemplate).toEqual([
			expect.objectContaining({ id: "t1", name: "Deleted template" }),
		]);
		const gmail = await insightDetail(org.id, { kind: "provider", provider: "gmail" }, 30, NOW);
		expect(gmail.totals.sent).toBe(2);
		expect(gmail.byProvider).toEqual([]);
	});
});
