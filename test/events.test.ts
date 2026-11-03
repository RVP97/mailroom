import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import { dailyStats, listEmails } from "@/server/queries";
import { createEmails, parseSend } from "@/server/send";
import { getSetting } from "@/server/settings";
import { fakeOutside, seedOrg, signedSns, snsNotification, TOPIC, uid, useTopic } from "./helpers";

beforeAll(useTopic);

/** One email sent through the fake SES: its id and SES message id. */
async function sentEmail(org: { id: string; domain: string }, to = `c${uid()}@cliente.test`) {
	fakeOutside();
	const [r] = await createEmails(org.id, [
		parseSend({ from: `a@${org.domain}`, to, subject: "s", text: "t" }),
	]);
	const row = await db
		.select()
		.from(schema.emails)
		.where(eq(schema.emails.id, r?.id as string))
		.get();
	return { id: row?.id as string, messageId: row?.message_id as string, to };
}

const mail = (e: { id: string; messageId: string }, extra: Record<string, unknown> = {}) => ({
	messageId: e.messageId,
	timestamp: "2026-12-31T23:00:00.000-06:00",
	tags: { mailroom_id: [e.id] },
	...extra,
});

const row = (id: string) => db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();

describe("SNS", () => {
	it("refuses another topic and anything not signed by SNS", async () => {
		fakeOutside();
		const other = await signedSns({
			Type: "Notification",
			MessageId: "x",
			TopicArn: `${TOPIC}-other`,
			Message: "{}",
			Timestamp: "2026-12-31T23:30:00Z",
		});
		expect(await handleSns(other)).toBe("invalid");
		const good = await snsNotification({ eventType: "Delivery" });
		expect(await handleSns({ ...good, Message: '{"eventType":"Bounce"}' })).toBe("invalid");
	});

	it("confirms our topic's subscription only at SNS's own URL", async () => {
		const confirmed: string[] = [];
		fakeOutside({
			extra: (url) => {
				if (
					url.host === "sns.us-east-1.amazonaws.com" &&
					url.searchParams.get("Action") === "ConfirmSubscription"
				) {
					confirmed.push(url.toString());
					return new Response("<ok/>");
				}
			},
		});
		const base = {
			Type: "SubscriptionConfirmation",
			MessageId: "sub-1",
			TopicArn: TOPIC,
			Message: "You have chosen to subscribe",
			Timestamp: "2026-12-31T23:30:00Z",
			Token: "tok",
		};
		const evil = await signedSns({
			...base,
			SubscribeURL: "https://evil.test/?Action=ConfirmSubscription",
		});
		expect(await handleSns(evil)).toBe("invalid");
		const ok = await signedSns({
			...base,
			SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=tok`,
		});
		expect(await handleSns(ok)).toBe("confirmed");
		expect(confirmed).toHaveLength(1);
		expect(await getSetting("sns_subscription_confirmed_at")).not.toBeNull();
	});
});

describe("SES events", () => {
	it("never moves an email back when events arrive out of order, and applies each once", async () => {
		const org = await seedOrg();
		const e = await sentEmail(org);
		fakeOutside();
		const delivery = await snsNotification({
			eventType: "Delivery",
			mail: mail(e),
			delivery: { timestamp: "2026-12-31T23:30:05.000-06:00", recipients: [e.to] },
		});
		expect(await handleSns(delivery)).toBe("applied");
		expect(await handleSns(delivery)).toBe("duplicate");
		const send = await snsNotification({ eventType: "Send", mail: mail(e) });
		expect(await handleSns(send)).toBe("applied");
		const r = await row(e.id);
		expect(r?.status).toBe("delivered");
		expect(r?.last_event).toBe("delivered");
		expect(r?.delivered_at).toBe("2026-12-31T23:30:05.000-06:00");
		// Counted in Mexico City's day, not UTC's (05:30 UTC is already January 1st).
		const stats = await dailyStats(org.id, 3, Date.parse("2027-01-01T12:00:00Z"));
		const dec31 = stats.series.find((d) => d.day === "2026-12-31");
		expect(dec31?.delivered).toBe(1);
		expect(stats.series.find((d) => d.day === "2027-01-01")?.delivered).toBe(0);
	});

	it("suppresses hard bounces and complaints, not soft bounces, and later sends skip them", async () => {
		const org = await seedOrg();
		const hard = await sentEmail(org);
		const soft = await sentEmail(org);
		const complained = await sentEmail(org);
		fakeOutside();
		await handleSns(
			await snsNotification({
				eventType: "Bounce",
				mail: mail(hard),
				bounce: {
					bounceType: "Permanent",
					bounceSubType: "General",
					timestamp: "2026-12-31T23:31:00.000-06:00",
					bouncedRecipients: [
						{
							emailAddress: hard.to.toUpperCase(),
							diagnosticCode: "smtp; 550 5.1.1 user unknown",
						},
					],
				},
			}),
		);
		await handleSns(
			await snsNotification({
				eventType: "Bounce",
				mail: mail(soft),
				bounce: {
					bounceType: "Transient",
					bounceSubType: "MailboxFull",
					bouncedRecipients: [{ emailAddress: soft.to }],
				},
			}),
		);
		await handleSns(
			await snsNotification({
				eventType: "Complaint",
				mail: mail(complained),
				complaint: {
					complainedRecipients: [{ emailAddress: complained.to }],
					complaintFeedbackType: "abuse",
				},
			}),
		);
		const h = await row(hard.id);
		expect(h?.status).toBe("bounced");
		expect(h?.bounce_type).toBe("Permanent/General");
		expect(h?.error).toContain("550 5.1.1");
		const list = await db
			.select({ address: schema.suppressions.address, reason: schema.suppressions.reason })
			.from(schema.suppressions)
			.where(eq(schema.suppressions.organization_id, org.id));
		expect(list.sort((a, b) => a.address.localeCompare(b.address))).toEqual(
			[
				{ address: hard.to, reason: "bounce" },
				{ address: complained.to, reason: "complaint" },
			].sort((a, b) => a.address.localeCompare(b.address)),
		);
		// A delivery arriving after the bounce doesn't undo it.
		await handleSns(
			await snsNotification({
				eventType: "Delivery",
				mail: mail(hard),
				delivery: { recipients: [hard.to] },
			}),
		);
		expect((await row(hard.id))?.status).toBe("bounced");

		const aws = fakeOutside();
		const [again] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: hard.to, subject: "s", text: "t" }),
		]);
		expect(again?.status).toBe("suppressed");
		expect(aws.sends).toHaveLength(0);
	});

	it("tells a soft bounce and an Auto Validation hold apart from a bounce", async () => {
		const org = await seedOrg();
		const soft = await sentEmail(org);
		const held = await sentEmail(org);
		fakeOutside();
		await handleSns(
			await snsNotification({
				eventType: "Bounce",
				mail: mail(soft),
				bounce: {
					bounceType: "Transient",
					bounceSubType: "General",
					timestamp: "2026-12-31T23:31:00.000-06:00",
					bouncedRecipients: [
						{
							emailAddress: soft.to,
							diagnosticCode: "smtp; A delivery loop was detected",
						},
					],
				},
			}),
		);
		await handleSns(
			await snsNotification({
				eventType: "Bounce",
				mail: mail(held),
				bounce: {
					bounceType: "Permanent",
					bounceSubType: "EmailValidationSuppressed",
					timestamp: "2026-12-31T23:32:00.000-06:00",
					bouncedRecipients: [{ emailAddress: held.to }],
				},
			}),
		);
		// The server, not the address: not delivered, kept off the bounce rate and the list.
		const s = await row(soft.id);
		expect(s?.status).toBe("soft_bounced");
		expect(s?.error).toContain("delivery loop");
		expect(s?.last_event).toBe("soft_bounced");
		expect(s?.bounced_at).toBeNull();
		// SES never sent it: suppressed, and the address stays off later sends.
		const h = await row(held.id);
		expect(h?.status).toBe("suppressed");
		expect(h?.bounced_at).toBeNull();
		const list = await db
			.select({ address: schema.suppressions.address })
			.from(schema.suppressions)
			.where(eq(schema.suppressions.organization_id, org.id));
		expect(list.map((r) => r.address)).toEqual([held.to]);
		const day = (await dailyStats(org.id, 3, Date.parse("2027-01-01T12:00:00Z"))).totals;
		expect(day).toMatchObject({ bounced: 0, soft_bounced: 1, suppressed: 1 });
		// The sending domain counts the same, and the evening's events fall on the 31st.
		const byDomain = await dailyStats(org.id, 3, Date.parse("2027-01-01T12:00:00Z"), {
			domain: org.domain,
		});
		expect(byDomain.totals).toMatchObject({ soft_bounced: 1, suppressed: 1 });
		expect(byDomain.series.find((d) => d.day === "2026-12-31")?.soft_bounced).toBe(1);
		// Lists: the not-delivered group finds both, each status only its own.
		const notDelivered = await listEmails(org.id, { status: "not_delivered" });
		expect(notDelivered.data.map((e) => e.id).sort()).toEqual([soft.id, held.id].sort());
		const softOnly = await listEmails(org.id, { status: "soft_bounced", day: "2026-12-31" });
		expect(softOnly.data.map((e) => e.id)).toEqual([soft.id]);
		expect(
			(await listEmails(org.id, { status: "soft_bounced", day: "2027-01-01" })).data,
		).toHaveLength(0);
		const events = await db
			.select({ type: schema.emailEvents.type })
			.from(schema.emailEvents)
			.where(eq(schema.emailEvents.email_id, held.id));
		expect(events.map((e) => e.type)).toEqual(["email.suppressed"]);
	});

	it("counts opens and clicks once per email in the day's stats, every one on the email", async () => {
		const org = await seedOrg();
		const e = await sentEmail(org);
		fakeOutside();
		for (let i = 0; i < 3; i++)
			await handleSns(
				await snsNotification({
					eventType: "Open",
					mail: mail(e),
					open: { timestamp: `2026-12-31T23:4${i}:00.000-06:00` },
				}),
			);
		await handleSns(
			await snsNotification({
				eventType: "Click",
				mail: mail(e),
				click: { link: "https://hotel.test/reserva" },
			}),
		);
		const r = await row(e.id);
		expect(r?.open_count).toBe(3);
		expect(r?.click_count).toBe(1);
		expect(r?.opened_at).toBe("2026-12-31T23:40:00.000-06:00");
		const stats = await dailyStats(org.id, 400, Date.parse("2027-01-01T12:00:00Z"));
		expect(stats.totals.opened).toBe(1);
		expect(stats.totals.clicked).toBe(1);
	});

	it("records an email sent over SMTP from its first event, by its configuration set", async () => {
		const org = await seedOrg();
		fakeOutside();
		const messageId = `0100-smtp-${uid()}`;
		const result = await handleSns(
			await snsNotification({
				eventType: "Send",
				mail: {
					messageId,
					timestamp: "2026-12-31T23:30:00.000Z",
					source: `reservas@${org.domain}`,
					destination: ["huesped@cliente.test"],
					commonHeaders: {
						from: [`Reservas <reservas@${org.domain}>`],
						to: ["huesped@cliente.test"],
						subject: "Su llegada",
					},
					tags: { "ses:configuration-set": [org.configurationSet] },
				},
			}),
		);
		expect(result).toBe("applied");
		const smtp = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.message_id, messageId))
			.get();
		expect(smtp).toMatchObject({
			organization_id: org.id,
			source: "smtp",
			subject: "Su llegada",
			status: "sent",
		});
		// Unknown configuration set: ignored.
		const stranger = await snsNotification({
			eventType: "Send",
			mail: {
				messageId: `0100-other-${uid()}`,
				tags: { "ses:configuration-set": ["someone-else"] },
			},
		});
		expect(await handleSns(stranger)).toBe("ignored");
	});

	it("keeps counters exact with 150 events arriving at once", async () => {
		const org = await seedOrg();
		fakeOutside();
		const [first] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "x@cliente.test", subject: "s", text: "t" }),
		]);
		const base = await row(first?.id as string);
		const emails = await Promise.all(
			Array.from({ length: 150 }, async (_, i) => {
				const id = crypto.randomUUID();
				await db.insert(schema.emails).values({
					...(base as NonNullable<typeof base>),
					id,
					message_id: `0100-bulk-${i}-${uid()}`,
					to: [`b${i}@cliente.test`],
				});
				return { id, messageId: `0100-bulk-${i}` };
			}),
		);
		const rows = await db
			.select({ id: schema.emails.id, messageId: schema.emails.message_id })
			.from(schema.emails)
			.where(and(eq(schema.emails.organization_id, org.id)));
		const bulk = rows.filter((r) => emails.some((e) => e.id === r.id));
		const notices = await Promise.all(
			bulk.flatMap((e) => [
				snsNotification({
					eventType: "Delivery",
					mail: mail({ id: e.id, messageId: e.messageId as string }),
					delivery: { timestamp: "2026-12-31T23:59:59.000-06:00" },
				}),
			]),
		);
		const results = await Promise.all(notices.map((n) => handleSns(n)));
		expect(results.filter((r) => r === "applied")).toHaveLength(150);
		// The same 150 again (SNS retries): nothing changes.
		const again = await Promise.all(notices.map((n) => handleSns(n)));
		expect(again.every((r) => r === "duplicate")).toBe(true);
		const stats = await dailyStats(org.id, 400, Date.parse("2027-01-01T12:00:00Z"));
		expect(stats.series.find((d) => d.day === "2026-12-31")?.delivered).toBe(150);
	});
});
