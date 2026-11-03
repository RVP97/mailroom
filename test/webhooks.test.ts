import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import { createEmails, parseSend } from "@/server/send";
import { createWebhook } from "@/server/webhook-admin";
import { MAX_DELIVERY_ATTEMPTS, retryDueDeliveries, signedHeaders } from "@/server/webhooks";
import { fakeOutside, seedOrg, snsNotification, useTopic } from "./helpers";

beforeAll(useTopic);

/** Standard Webhooks' check, written independently (as a customer's server would). */
function verify(secret: string, headers: Record<string, string>, body: string) {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const expected = createHmac("sha256", key)
		.update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`)
		.digest("base64");
	return headers["webhook-signature"]?.split(" ").includes(`v1,${expected}`);
}

describe("webhooks", () => {
	it("signs the Standard Webhooks (and Svix) way", async () => {
		const secret = `whsec_${Buffer.from("0123456789abcdef0123").toString("base64")}`;
		const body = '{"type":"email.delivered"}';
		const h = await signedHeaders(
			secret,
			"msg_1",
			body,
			Date.parse("2026-12-31T23:30:00-06:00"),
		);
		expect(h["webhook-timestamp"]).toBe(String(Date.parse("2027-01-01T05:30:00Z") / 1000));
		expect(verify(secret, h, body)).toBe(true);
		expect(verify(secret, h, `${body} `)).toBe(false);
		expect(h["svix-signature"]).toBe(h["webhook-signature"]);
	});

	it("posts a bounce in Resend's shape to subscribed endpoints only, then retries a failure until it gives up", async () => {
		const org = await seedOrg();
		const posted: { url: string; body: string; headers: Record<string, string> }[] = [];
		let failing = true;
		const aws = fakeOutside({
			extra: async (url, init) => {
				if (url.host !== "hooks.hotel.test") return undefined;
				posted.push({
					url: url.toString(),
					body: String(init?.body),
					headers: init?.headers as Record<string, string>,
				});
				return new Response("", { status: failing ? 500 : 200 });
			},
		});
		const hook = await createWebhook(org.id, {
			url: "https://hooks.hotel.test/bounces",
			events: ["email.bounced"],
		});
		const delivery = () =>
			db
				.select()
				.from(schema.webhookDeliveries)
				.where(eq(schema.webhookDeliveries.webhook_id, hook.id))
				.get();
		await createWebhook(org.id, {
			url: "https://hooks.hotel.test/opens",
			events: ["email.opened"],
		});
		const [sent] = await createEmails(org.id, [
			parseSend({
				from: `a@${org.domain}`,
				to: "nadie@cliente.test",
				subject: "s",
				text: "t",
				tags: [{ name: "booking", value: "B-31" }],
			}),
		]);
		const messageId = (
			await db
				.select()
				.from(schema.emails)
				.where(eq(schema.emails.id, sent?.id as string))
				.get()
		)?.message_id;
		expect(aws.sends).toHaveLength(1);
		await handleSns(
			await snsNotification({
				eventType: "Bounce",
				mail: { messageId, tags: { mailroom_id: [sent?.id] } },
				bounce: {
					bounceType: "Permanent",
					bounceSubType: "General",
					bouncedRecipients: [
						{ emailAddress: "nadie@cliente.test", diagnosticCode: "550 user unknown" },
					],
				},
			}),
		);
		// The first try runs in the background.
		await vi.waitFor(async () => expect((await delivery())?.attempts).toBe(1));
		expect(posted.map((p) => p.url)).toEqual(["https://hooks.hotel.test/bounces"]);
		const payload = JSON.parse(posted[0]?.body as string);
		expect(payload).toMatchObject({
			type: "email.bounced",
			data: {
				email_id: sent?.id,
				to: ["nadie@cliente.test"],
				subject: "s",
				tags: { booking: "B-31" },
				bounce: { type: "Permanent", subType: "General", message: "550 user unknown" },
			},
		});
		expect(
			verify(
				hook.secret,
				posted[0]?.headers as Record<string, string>,
				posted[0]?.body as string,
			),
		).toBe(true);

		let d = await delivery();
		expect(d).toMatchObject({ status: "pending", attempts: 1, response_status: 500 });
		// Not due yet: nothing is tried.
		expect((await retryDueDeliveries(Date.now())).tried).toBe(0);
		// Each retry when due, until the schedule runs out.
		let at = Date.now();
		for (let i = 2; i <= MAX_DELIVERY_ATTEMPTS; i++) {
			at = Date.parse((await delivery())?.next_attempt_at as string) + 1;
			await retryDueDeliveries(at);
		}
		d = await delivery();
		expect(d?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
		expect(d?.status).toBe("failed");
		expect(posted).toHaveLength(MAX_DELIVERY_ATTEMPTS);
		failing = false;
	});

	it("delivers on a retry once the endpoint is back", async () => {
		const org = await seedOrg();
		let ok = false;
		fakeOutside({
			extra: (url) =>
				url.host === "hooks.hotel.test"
					? new Response("", { status: ok ? 204 : 503 })
					: undefined,
		});
		const hook = await createWebhook(org.id, {
			url: "https://hooks.hotel.test/all",
			events: ["email.failed", "email.suppressed"],
		});
		const { addSuppression } = await import("@/server/suppressions");
		await addSuppression(org.id, "baja@cliente.test");
		await createEmails(org.id, [
			parseSend({
				from: `a@${org.domain}`,
				to: "baja@cliente.test",
				subject: "s",
				text: "t",
			}),
		]);
		const first = () =>
			db
				.select()
				.from(schema.webhookDeliveries)
				.where(eq(schema.webhookDeliveries.webhook_id, hook.id))
				.get();
		await vi.waitFor(async () => expect((await first())?.attempts).toBe(1));
		const row = await first();
		expect(row).toMatchObject({
			event_type: "email.suppressed",
			status: "pending",
			response_status: 503,
		});
		ok = true;
		await retryDueDeliveries(Date.parse(row?.next_attempt_at as string) + 1);
		const after = await db
			.select()
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.id, row?.id as string))
			.get();
		expect(after).toMatchObject({ status: "delivered", attempts: 2, response_status: 204 });
	});
});
