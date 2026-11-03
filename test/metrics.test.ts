import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { blockedByFirewall, setFirewall } from "@/server/firewall";
import { dailyStats, listEmails, statsByDomain, summarizeEmails } from "@/server/queries";
import { createEmails, parseSend } from "@/server/send";
import { addSuppression } from "@/server/suppressions";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** An email row as SES's events would have left it. */
function email(
	org: string,
	o: Partial<typeof schema.emails.$inferInsert> & {
		status: (typeof schema.emails.$inferInsert)["status"];
	},
) {
	return {
		id: crypto.randomUUID(),
		organization_id: org,
		from: "Acme <hola@mail.acme.test>",
		to: [`c${uid()}@gmail.com`],
		subject: "s",
		source: "api",
		created_at: "2026-12-31T12:00:00.000Z",
		...o,
	};
}

describe("statuses and Overview's drill-downs", () => {
	it("filters hundreds of emails by group, day (Mexico City evening), domain and provider", async () => {
		const org = await seedOrg();
		const rows = [];
		// 150 delivered on the 31st, 40 opened, 10 clicked; then one of each way not to arrive.
		for (let i = 0; i < 150; i++)
			rows.push(
				email(org.id, {
					status: "delivered",
					delivered_at: "2027-01-01T05:20:00.000Z", // 11:20 pm on the 31st in Mexico City
					opened_at: i < 40 ? "2027-01-01T05:31:00.000Z" : null,
					clicked_at: i < 10 ? "2027-01-01T05:40:00.000Z" : null,
					to: [i % 3 ? `c${i}@hotmail.com` : `c${i}@gmail.com`],
				}),
			);
		rows.push(
			email(org.id, {
				status: "bounced",
				bounce_type: "Permanent/General",
				bounced_at: "2027-01-01T05:30:00.000Z",
			}),
			email(org.id, {
				status: "soft_bounced",
				bounce_type: "Transient/MailboxFull",
				last_event_at: "2027-01-01T06:30:00.000Z", // 12:30 am on the 1st
			}),
			email(org.id, { status: "failed", from: "a@otro.test" }),
			email(org.id, {
				status: "suppressed",
				dropped: { "x@mailinator.com": "firewall: disposable address" },
			}),
			email(org.id, {
				status: "suppressed",
				dropped: { "y@gmail.com": "unsubscribed (marketing)" },
			}),
		);
		for (let i = 0; i < rows.length; i += 6)
			await db.insert(schema.emails).values(rows.slice(i, i + 6));

		const all = (f: Parameters<typeof listEmails>[1]) =>
			listEmails(org.id, { ...f, limit: 500 }, 500).then((p) => p.data);
		expect(await all({ status: "not_delivered" })).toHaveLength(5);
		expect(await all({ status: "opened", day: "2026-12-31" })).toHaveLength(40);
		expect(await all({ status: "opened", day: "2027-01-01" })).toHaveLength(0);
		expect(await all({ status: "clicked" })).toHaveLength(10);
		expect(await all({ status: "delivered", day: "2026-12-31" })).toHaveLength(150);
		expect(await all({ status: "soft_bounced", day: "2026-12-31" })).toHaveLength(0);
		expect(await all({ status: "soft_bounced", day: "2027-01-01" })).toHaveLength(1);
		expect(await all({ status: "firewall" })).toHaveLength(1);
		expect(await all({ status: "unsubscribed" })).toHaveLength(1);
		expect(await all({ domain: "otro.test" })).toHaveLength(1);
		expect(await all({ domain: "mail.acme.test", status: "delivered" })).toHaveLength(150);
		expect(await all({ provider: "outlook" })).toHaveLength(100);
		expect(await all({ provider: "gmail", status: "delivered" })).toHaveLength(50);
		expect(await all({ provider: "other" })).toHaveLength(0);

		// The drill-down's numbers count each status on its own day, like Overview's charts.
		expect(await summarizeEmails(org.id, { day: "2026-12-31" })).toMatchObject({
			all: 155,
			delivered: 150,
			opened: 40,
			clicked: 10,
			not_delivered: 4,
			bounced: 1,
			soft_bounced: 0,
			failed: 1,
			suppressed: 2,
		});
		expect(await summarizeEmails(org.id, { provider: "outlook" })).toMatchObject({
			all: 100,
			delivered: 100,
		});

		const blocked = (
			await blockedByFirewall([org.id], 30, Date.parse("2027-01-02T00:00:00Z"))
		).get(org.id);
		expect(blocked).toMatchObject({ total: 1, disposable: 1, plus: 0 });
	});

	it("counts sends the firewall, a suppression or nobody kept out, per brand and domain", async () => {
		fakeOutside();
		const org = await seedOrg();
		await addSuppression(org.id, "rebote@cliente.test");
		await setFirewall(org.id, { block_plus: true });
		const send = (to: string) =>
			createEmails(org.id, [
				parseSend({ from: `a@${org.domain}`, to, subject: "s", text: "t" }),
			]);
		const [suppressed] = await send("rebote@cliente.test");
		const [blocked] = await send("ana+promo@cliente.test");
		expect(suppressed?.status).toBe("suppressed");
		expect(blocked?.status).toBe("suppressed");
		const today = await dailyStats(org.id, 1);
		expect(today.totals.suppressed).toBe(2);
		const domain = await dailyStats(org.id, 1, Date.now(), { domain: org.domain });
		expect(domain.totals.suppressed).toBe(2);
		const byDomain = await statsByDomain(org.id, 1);
		expect(byDomain).toEqual([expect.objectContaining({ domain: org.domain, suppressed: 2 })]);
		const rows = await listEmails(org.id, { status: "firewall" });
		expect(rows.data.map((e) => e.id)).toEqual([blocked?.id]);
	});
});
