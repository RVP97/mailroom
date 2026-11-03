import { env, runInDurableObject } from "cloudflare:test";
import { eq, inArray } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { claimDue, type Dispatcher } from "@/server/dispatcher";
import { createEmails, MAX_ATTEMPTS, parseSend, storedContent } from "@/server/send";
import { addSuppression } from "@/server/suppressions";
import { fakeOutside, seedOrg, uid } from "./helpers";

const rawOf = (send: { body: Record<string, unknown> }) =>
	new TextDecoder().decode(
		Uint8Array.from(atob((send.body.Content as { Raw: { Data: string } }).Raw.Data), (c) =>
			c.charCodeAt(0),
		),
	);

const emailRow = (id: string) =>
	db.select().from(schema.emails).where(eq(schema.emails.id, id)).get();

const dispatcher = () => env.DISPATCHER.get(env.DISPATCHER.idFromName("dispatcher"));

/**
 * Runs the Dispatcher's alarm until nothing is queued or being sent. Its own alarms (it sets the
 * next run at once while more is waiting) run alongside: claims keep them from sending twice.
 */
async function drain(max = 100) {
	for (let i = 0; i < max; i++) {
		await runInDurableObject(dispatcher(), (o: Dispatcher) => o.alarm());
		const left = await db
			.select({ id: schema.emails.id })
			.from(schema.emails)
			.where(inArray(schema.emails.status, ["queued", "sending"]))
			.limit(1);
		if (!left.length) break;
		await new Promise((r) => setTimeout(r, 10));
	}
	await runInDurableObject(dispatcher(), (_o: Dispatcher, state) => state.storage.deleteAlarm());
}

// The queue is the whole emails table: each test starts with it empty.
beforeEach(async () => {
	await db.delete(schema.emailBodies);
	await db.delete(schema.emails);
});

describe("sending", () => {
	it("sends one email now through the organization's tenant and configuration set", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const [r] = await createEmails(org.id, [
			parseSend({
				from: `Reservas <reservas@${org.domain}>`,
				to: "ana@cliente.test",
				subject: "Su reserva",
				html: "<p>Hola</p>",
				tags: [{ name: "kind", value: "booking" }],
			}),
		]);
		expect(r?.status).toBe("sent");
		expect(aws.sends).toHaveLength(1);
		const body = aws.sends[0]?.body as Record<string, unknown>;
		expect(body.TenantName).toBe(`mailroom-${org.slug}`);
		expect(body.ConfigurationSetName).toBe(org.configurationSet);
		expect(body.FromEmailAddress).toBe(`"Reservas" <reservas@${org.domain}>`);
		expect(rawOf(aws.sends[0] as never)).toContain(`From: "Reservas" <reservas@${org.domain}>`);
		expect(body.EmailTags).toEqual([
			{ Name: "mailroom_id", Value: r?.id },
			{ Name: "mailroom_org", Value: org.id },
			{ Name: "kind", Value: "booking" },
		]);
		expect(rawOf(aws.sends[0] as never)).toContain("Subject: Su reserva");
		const row = await emailRow(r?.id as string);
		expect(row?.status).toBe("sent");
		expect(row?.message_id).toMatch(/^0100-fake-/);
		expect((await storedContent(row?.id as string))?.content.html).toBe("<p>Hola</p>");
	});

	it("refuses a domain the organization doesn't own or hasn't verified, and an org not set up", async () => {
		fakeOutside();
		const org = await seedOrg();
		const other = await seedOrg();
		await expect(
			createEmails(org.id, [
				parseSend({ from: `a@${other.domain}`, to: "b@c.test", subject: "s", text: "t" }),
			]),
		).rejects.toMatchObject({ status: 403, code: "invalid_from_address" });
		await db
			.update(schema.domains)
			.set({ status: "pending" })
			.where(eq(schema.domains.id, org.domainId));
		const { forgetOrg } = await import("@/server/org");
		forgetOrg(org.id);
		await expect(
			createEmails(org.id, [
				parseSend({ from: `a@${org.domain}`, to: "b@c.test", subject: "s", text: "t" }),
			]),
		).rejects.toMatchObject({ status: 403 });
		const notReady = await seedOrg({ ready: false });
		await expect(
			createEmails(notReady.id, [
				parseSend({
					from: `a@${notReady.domain}`,
					to: "b@c.test",
					subject: "s",
					text: "t",
				}),
			]),
		).rejects.toMatchObject({ code: "brand_not_ready" });
	});

	it("leaves out suppressed, misspelled and dead-domain recipients; never sends to nobody", async () => {
		const aws = fakeOutside({ deadDomains: ["no-existe.test"] });
		const org = await seedOrg();
		await addSuppression(org.id, "Rebote@Cliente.test");
		const [mixed] = await createEmails(org.id, [
			parseSend({
				from: `a@${org.domain}`,
				to: ["ok@cliente.test", "rebote@cliente.test", "ana@gmial.com"],
				cc: "x@no-existe.test",
				subject: "s",
				text: "t",
			}),
		]);
		expect(mixed?.status).toBe("sent");
		const sent = aws.sends[0]?.body.Destination as Record<string, string[]>;
		expect(sent.ToAddresses).toEqual(["ok@cliente.test"]);
		expect(sent.CcAddresses).toBeUndefined();
		const row = await emailRow(mixed?.id as string);
		expect(Object.keys(row?.dropped ?? {}).sort()).toEqual(
			["ana@gmial.com", "rebote@cliente.test", "x@no-existe.test"].sort(),
		);
		// The record keeps who it was addressed to.
		expect(row?.to).toEqual(["ok@cliente.test", "rebote@cliente.test", "ana@gmial.com"]);

		const [onlySuppressed] = await createEmails(org.id, [
			parseSend({
				from: `a@${org.domain}`,
				to: "rebote@cliente.test",
				subject: "s",
				text: "t",
			}),
		]);
		expect(onlySuppressed?.status).toBe("suppressed");
		expect(aws.sends).toHaveLength(1);
	});

	it("replays an idempotent request, refuses the key with another body, and sends once under a race", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const input = parseSend({
			from: `a@${org.domain}`,
			to: "b@cliente.test",
			subject: "s",
			text: "t",
		});
		const key = `key-${uid()}`;
		const [first] = await createEmails(org.id, [input], { idempotencyKey: key });
		const [again] = await createEmails(org.id, [input], { idempotencyKey: key });
		expect(again?.id).toBe(first?.id);
		expect(aws.sends).toHaveLength(1);
		await expect(
			createEmails(org.id, [{ ...input, subject: "other" }], { idempotencyKey: key }),
		).rejects.toMatchObject({ status: 409 });
		// A day later the key is free again.
		const later = await createEmails(org.id, [input], {
			idempotencyKey: key,
			now: Date.now() + 86_400_000 + 60_000,
		});
		expect(later[0]?.id).not.toBe(first?.id);

		// Five requests with one key at once: one email, one send.
		const raceKey = `race-${uid()}`;
		const before = aws.sends.length;
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				createEmails(org.id, [input], { idempotencyKey: raceKey }),
			),
		);
		expect(new Set(results.map((r) => r[0]?.id)).size).toBe(1);
		expect(aws.sends.length - before).toBe(1);
	});

	it("queues a batch of 150 and the Dispatcher sends each exactly once", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const inputs = Array.from({ length: 150 }, (_, i) =>
			parseSend({
				from: `a@${org.domain}`,
				to: `cliente${i}@cliente.test`,
				subject: `Aviso ${i}`,
				text: "t",
			}),
		);
		const results = await createEmails(org.id, inputs);
		expect(results).toHaveLength(150);
		expect(results.every((r) => r.status === "queued")).toBe(true);
		expect(aws.sends).toHaveLength(0);
		await drain();
		expect(aws.sends).toHaveLength(150);
		const ids = aws.sends.map(
			(s) => (s.body.EmailTags as { Name: string; Value: string }[])[0]?.Value,
		);
		expect(new Set(ids).size).toBe(150);
		const rows = await db.select({ status: schema.emails.status }).from(schema.emails);
		expect(rows).toHaveLength(150);
		expect(rows.every((r) => r.status === "sent")).toBe(true);
	});

	it("never lets two runs claim the same email", async () => {
		fakeOutside();
		const org = await seedOrg();
		await createEmails(
			org.id,
			Array.from({ length: 120 }, (_, i) =>
				parseSend({
					from: `a@${org.domain}`,
					to: `c${i}@cliente.test`,
					subject: "s",
					text: "t",
				}),
			),
		);
		const runs = await Promise.all(Array.from({ length: 6 }, () => claimDue(Date.now(), 30)));
		const claimed = runs.flat().map((r) => r.id);
		expect(new Set(claimed).size).toBe(claimed.length);
		// Claimed ones aren't claimable again until their claim runs out.
		expect(claimed).toHaveLength(120);
		expect(await claimDue(Date.now(), 90)).toHaveLength(0);
		// A claim left by a run that died is claimable again after five minutes.
		const again = [
			...(await claimDue(Date.now() + 6 * 60_000, 90)),
			...(await claimDue(Date.now() + 6 * 60_000, 90)),
		];
		expect(again).toHaveLength(120);
	});

	it("schedules for 11:30 pm Mexico time on the 31st and sends it then", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		const now = Date.parse("2026-12-30T12:00:00-06:00");
		const [r] = await createEmails(
			org.id,
			[
				parseSend({
					from: `a@${org.domain}`,
					to: "b@cliente.test",
					subject: "Feliz año",
					text: "t",
					scheduled_at: "2026-12-31T23:30:00-06:00",
				}),
			],
			{ now },
		);
		expect(r?.status).toBe("scheduled");
		const row = await emailRow(r?.id as string);
		expect(row?.send_at).toBe("2027-01-01T05:30:00.000Z");
		expect(await claimDue(Date.parse("2026-12-31T23:29:00-06:00"), 50)).toEqual([]);
		const due = await claimDue(Date.parse("2026-12-31T23:30:00-06:00"), 50);
		expect(due.map((d) => d.id)).toContain(r?.id);
		expect(aws.sends).toHaveLength(0);
	});

	it("retries SES's transient errors with backoff and gives up on a rejection", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		aws.failNext(500, "InternalFailure");
		const [transient] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "b@cliente.test", subject: "s", text: "t" }),
		]);
		expect(transient?.status).toBe("queued");
		const row = await emailRow(transient?.id as string);
		expect(row?.attempts).toBe(1);
		expect(Date.parse(row?.send_at as string)).toBeGreaterThan(Date.now());

		aws.failNext(400, "MessageRejected");
		const [rejected] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "c@cliente.test", subject: "s", text: "t" }),
		]);
		expect(rejected?.status).toBe("failed");
		expect(rejected?.error?.code).toBe("message_rejected");
		expect(MAX_ATTEMPTS).toBeGreaterThan(1);
	});

	it("validates like Resend", () => {
		expect(() => parseSend({ from: "a@b.test", to: "x", subject: "s", text: "t" })).toThrow(
			/to/,
		);
		expect(() => parseSend({ from: "a@b.test", to: "x@y.test", subject: "s" })).toThrow(
			/html or text/,
		);
		expect(() =>
			parseSend({
				from: "a@b.test",
				to: Array.from({ length: 51 }, (_, i) => `x${i}@y.test`),
				subject: "s",
				text: "t",
			}),
		).toThrow(/1 to 50/);
		const p = parseSend({
			from: "a@b.test",
			to: "x@y.test",
			subject: "s",
			text: "t",
			replyTo: "r@y.test",
			attachments: [{ filename: "a.txt", content: { type: "Buffer", data: [104, 105] } }],
		});
		expect(p.attachments?.[0]?.content).toBe("aGk=");
	});
});
