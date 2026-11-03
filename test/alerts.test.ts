import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { alertLevel, checkAlerts } from "@/server/alerts";
import { db, schema } from "@/server/db";
import { setDomainPaused } from "@/server/provision";
import { DEFAULT_LIMITS, setOrganizationActions, setSendingLimits } from "@/server/sending-limits";
import { dayOf } from "@/server/time";
import { seedOrg, uid } from "./helpers";

/** Sign-in and alert emails are printed (SYSTEM_FROM is empty in tests): their subjects. */
function printedEmails() {
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	log.mockClear();
	return () =>
		log.mock.calls
			.map((c) => String(c[0]))
			.filter((l) => l.startsWith("[email to "))
			.map((l) => l.split("\n")[0] as string);
}

async function seedStats(
	org: { id: string; domain: string },
	sent: number,
	bounced: number,
	complained = 0,
) {
	await db
		.insert(schema.domainStats)
		.values({
			organization_id: org.id,
			day: dayOf(Date.now()),
			domain: org.domain,
			sent,
			bounced,
			complained,
		})
		.onConflictDoUpdate({
			target: [
				schema.domainStats.organization_id,
				schema.domainStats.day,
				schema.domainStats.domain,
			],
			set: { sent, bounced, complained },
		});
}

async function seedOwner(organizationId: string) {
	const userId = `user_${uid()}`;
	const email = `${userId}@cliente.test`;
	await db.insert(schema.user).values({ id: userId, name: "Owner", email });
	await db.insert(schema.member).values({
		id: `mem_${uid()}`,
		organizationId,
		userId,
		role: "owner",
		createdAt: new Date(),
	});
	return email;
}

describe("alert levels", () => {
	it("follows the sending limits, ignores small volumes and puts a paused tenant first", () => {
		const s = (sent: number, bounceRate: number, complaintRate = 0) => ({
			sent,
			bounceRate,
			complaintRate,
		});
		expect(alertLevel(s(100, 0.01), "ENABLED")).toBe("ok");
		expect(alertLevel({ ...s(100, 0), softBounceRate: 0.2 }, "ENABLED")).toBe("warning");
		expect(alertLevel(s(50, 0.5), "ENABLED")).toBe("ok");
		expect(alertLevel(s(100, 0.05), null)).toBe("warning");
		expect(alertLevel(s(100, 0, 0.005), "REINSTATED")).toBe("danger");
		expect(alertLevel(s(3, 0.33), "ENABLED")).toBe("ok");
		expect(alertLevel(s(0, 0), "DISABLED")).toBe("paused");
	});
});

describe("alerts", () => {
	it("emails the owners and admins once per step up, and again only after it went back down", async () => {
		const org = await seedOrg();
		const owner = await seedOwner(org.id);
		const mine = (subjects: string[]) => subjects.filter((l) => l.includes(`Org ${org.id}`));

		await seedStats(org, 100, 6);
		let emails = printedEmails();
		await checkAlerts();
		expect(mine(emails())).toEqual([
			`[email to ${owner}] Org ${org.id}: bounces or complaints are high`,
			`[email to admin@mailroom.test] Org ${org.id}: bounces or complaints are high`,
		]);

		// Same level an hour later: nothing new.
		emails = printedEmails();
		await checkAlerts();
		expect(mine(emails())).toEqual([]);

		await seedStats(org, 100, 12);
		emails = printedEmails();
		await checkAlerts();
		expect(mine(emails())).toEqual([
			`[email to ${owner}] Org ${org.id}: over the sending limits`,
			`[email to admin@mailroom.test] Org ${org.id}: over the sending limits`,
		]);

		// Down to normal is recorded quietly; climbing again alerts again.
		await seedStats(org, 100, 1);
		emails = printedEmails();
		await checkAlerts();
		expect(mine(emails())).toEqual([]);
		await db
			.update(schema.orgSending)
			.set({ tenant_status: "DISABLED" })
			.where(eq(schema.orgSending.organization_id, org.id));
		emails = printedEmails();
		await checkAlerts();
		expect(mine(emails())).toEqual([
			`[email to ${owner}] SES paused sending for Org ${org.id}`,
			`[email to admin@mailroom.test] SES paused sending for Org ${org.id}`,
		]);
		const row = await db
			.select({ level: schema.orgSending.alert_level })
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, org.id))
			.get();
		expect(row?.level).toBe("paused");
	});
});

describe("sending limits", () => {
	it("pauses a marketing stream at the act level, and only admins resume it", async () => {
		const org = await seedOrg();
		await seedOwner(org.id);
		await db
			.update(schema.domains)
			.set({ purpose: "marketing" })
			.where(eq(schema.domains.id, org.domainId));
		await db
			.update(schema.orgSending)
			.set({ marketing_tenant_name: `mailroom-${org.id}-mkt` })
			.where(eq(schema.orgSending.organization_id, org.id));
		await setOrganizationActions(org.id, { marketing: "pause" });
		await seedStats(org, 200, 4, 1); // 2% bounces, 0.5% complaints: over 0.3%
		const emails = printedEmails();
		await checkAlerts();
		expect(emails().filter((l) => l.includes(`Org ${org.id}`))[0]).toContain(
			`Mailroom paused Org ${org.id}'s marketing emails`,
		);
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		expect(d?.paused_reason).toBe("sending_limits");
		await expect(setDomainPaused(org.id, org.domainId, false)).rejects.toThrow(/admins/);
		await setDomainPaused(org.id, org.domainId, false, "you", Date.now(), { isAdmin: true });
	});

	it("only alerts when the organization says so, with the deployment's own levels", async () => {
		const org = await seedOrg();
		await setSendingLimits({
			...DEFAULT_LIMITS,
			min_sent: 10,
			bounce: { warning: 0.2, danger: 0.4 },
		});
		await setOrganizationActions(org.id, { transactional: "alert" });
		try {
			await seedStats(org, 20, 5); // 25%: a warning with these limits
			const emails = printedEmails();
			await checkAlerts();
			expect(emails().filter((l) => l.includes(`Org ${org.id}`))[0]).toContain(
				"bounces or complaints are high",
			);
			await seedStats(org, 20, 10); // 50%: act, but this organization only alerts
			await checkAlerts();
			const d = await db
				.select()
				.from(schema.domains)
				.where(eq(schema.domains.id, org.domainId))
				.get();
			expect(d?.paused_at).toBeNull();
		} finally {
			await setSendingLimits(DEFAULT_LIMITS);
		}
	});
});

describe("sending limits' defaults", () => {
	it("only alert, for both kinds", () => {
		expect(DEFAULT_LIMITS.actions).toEqual({ transactional: "alert", marketing: "alert" });
	});
});
