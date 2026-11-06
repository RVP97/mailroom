import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { sameShape } from "@/server/automations";
import { setBrandPaused } from "@/server/brands";
import {
	cancelBroadcast,
	createBroadcast,
	deleteBroadcast,
	runBroadcasts,
	sendBroadcast,
	updateBroadcast,
} from "@/server/broadcasts";
import { createSegment, importContacts, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import { setDomainPaused } from "@/server/provision";
import { setApprovalRequired } from "@/server/reviews";
import { createEmails, parseSend } from "@/server/send";
import { fakeOutside, seedOrg, snsNotification, uid, useTopic } from "./helpers";

beforeAll(useTopic);

async function setUp(n = 3) {
	fakeOutside();
	const org = await seedOrg();
	const seg = await createSegment(org.id, { name: "All" });
	for (let i = 0; i < n; i++)
		await upsertContact(org.id, { email: `c${i}-${uid()}@guest.test`, segments: [seg.id] });
	const b = await createBroadcast(org.id, org.id, {
		name: "News",
		segment_id: seg.id,
		from: `Hotel <news@${org.domain}>`,
		subject: "Hello",
		html: "<p>Hi</p>",
	});
	return { org, b };
}

const broadcast = (id: string) =>
	db.select().from(schema.broadcasts).where(eq(schema.broadcasts.id, id)).get();
const emailsOf = (id: string) =>
	db.select().from(schema.emails).where(eq(schema.emails.broadcast_id, id));

describe("broadcasts", () => {
	it("refuses to send without approval on every path, not only the dashboard's", async () => {
		const { org, b } = await setUp();
		await setApprovalRequired(org.id, true);
		await expect(sendBroadcast(org.id, b.id)).rejects.toThrow(/review/);
		await expect(
			createBroadcast(org.id, org.id, {
				name: "Again",
				from: `Hotel <news@${org.domain}>`,
				subject: "Hi",
				html: "<p>Hi</p>",
				segment_id: b.segment_id,
				send: true,
			}),
		).rejects.toThrow(/review/);
		expect((await broadcast(b.id))?.status).toBe("draft");
	});

	it("unscheduling one the cron already started stops it instead of making it a draft", async () => {
		const { org, b } = await setUp();
		const now = Date.now();
		await sendBroadcast(org.id, b.id, null, now);
		const scheduled = await broadcast(b.id);
		await runBroadcasts(now, b.id);
		// What the page still shows (scheduled) is stale: cancel works from the real state.
		expect(scheduled?.status).toBe("scheduled");
		const row = await cancelBroadcast(org.id, b.id, now);
		expect(row.status).toBe("canceled");
		const emails = await emailsOf(b.id);
		expect(emails.length).toBe(3);
		expect(emails.every((e) => e.status === "canceled")).toBe(true);
		// And a canceled broadcast can't be edited, sent again or deleted.
		await expect(updateBroadcast(org.id, org.id, b.id, { subject: "x" })).rejects.toThrow();
		await expect(sendBroadcast(org.id, b.id)).rejects.toThrow();
		await expect(deleteBroadcast(org.id, b.id)).rejects.toThrow();
	});

	it("won't cancel a broadcast whose emails have all gone", async () => {
		const { org, b } = await setUp();
		const now = Date.now();
		await sendBroadcast(org.id, b.id, null, now);
		await runBroadcasts(now, b.id);
		await db
			.update(schema.emails)
			.set({ status: "delivered" })
			.where(eq(schema.emails.broadcast_id, b.id));
		await expect(cancelBroadcast(org.id, b.id, now)).rejects.toThrow(/gone out/);
		expect((await broadcast(b.id))?.status).toBe("sent");
	});
});

describe("pauses", () => {
	it("a brand can't lift Mailroom's pause by pausing again first", async () => {
		const org = await seedOrg();
		await setBrandPaused(org.id, org.id, true, { by: "mailroom", reason: "limits" });
		await setBrandPaused(org.id, org.id, true);
		const s = await db
			.select()
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, org.id))
			.get();
		expect(s?.paused_by).toBe("mailroom");
		await expect(setBrandPaused(org.id, org.id, false)).rejects.toThrow(/admins/);
	});

	it("a domain paused for the sending limits stays that way when paused again", async () => {
		const org = await seedOrg();
		await setDomainPaused(org.id, org.domainId, true, "sending_limits");
		await setDomainPaused(org.id, org.domainId, true, "you");
		await expect(setDomainPaused(org.id, org.domainId, false)).rejects.toThrow(/admins/);
		await setDomainPaused(org.id, org.domainId, false, "you", Date.now(), { isAdmin: true });
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		expect(d?.paused_at).toBeNull();
	});
});

describe("emails", () => {
	it("SES's word replaces a failure we only guessed (no answer from SES)", async () => {
		fakeOutside();
		const org = await seedOrg();
		const to = `c${uid()}@cliente.test`;
		const [r] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to, subject: "s", text: "t" }),
		]);
		const id = r?.id as string;
		// As the cron leaves a send that died before SES answered.
		await db
			.update(schema.emails)
			.set({ status: "failed", message_id: null })
			.where(eq(schema.emails.id, id));
		await handleSns(
			await snsNotification({
				eventType: "Delivery",
				mail: {
					messageId: `ses-${uid()}`,
					timestamp: "2026-12-31T23:00:00.000-06:00",
					tags: { mailroom_id: [id] },
				},
				delivery: { timestamp: "2026-12-31T23:30:05.000-06:00", recipients: [to] },
			}),
		);
		const row = await db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();
		expect(row?.status).toBe("delivered");
		expect(row?.message_id).toMatch(/^ses-/);
	});
});

describe("contacts", () => {
	it("an import's unsubscribed contacts are out of the broadcasts group too", async () => {
		const org = await seedOrg();
		const email = `u${uid()}@guest.test`;
		await importContacts(org.id, [{ email, unsubscribed: true }]);
		const u = await db
			.select()
			.from(schema.unsubscribes)
			.where(
				and(
					eq(schema.unsubscribes.organization_id, org.id),
					eq(schema.unsubscribes.address, email),
				),
			)
			.get();
		expect(u?.group).toBe("broadcasts");
	});
});

describe("automations", () => {
	it("tells changed-in-place and added steps from removed or moved ones", () => {
		const wait = { type: "wait" as const, minutes: 5 };
		const send = { type: "send" as const, template_id: "t" };
		expect(sameShape([wait, send], [{ ...wait, minutes: 9 }, send, wait])).toBe(true);
		expect(sameShape([wait, send], [send])).toBe(false);
		expect(sameShape([wait, send], [send, wait])).toBe(false);
	});
});
