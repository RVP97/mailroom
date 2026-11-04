import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import { lookupRecipient } from "@/server/lookup";
import { MAX_CHECKS, mailboxRejected } from "@/server/mailbox-checks";
import { createEmails, parseSend } from "@/server/send";
import { fakeOutside, seedOrg, snsNotification, uid, useTopic } from "./helpers";

const vars = env as unknown as { EMAILABLE_API_KEY?: string; EMAILABLE_MONTHLY_LIMIT?: string };

beforeAll(useTopic);
beforeEach(async () => {
	vars.EMAILABLE_API_KEY = "test-key";
	await db.delete(schema.mailboxChecks);
});
afterEach(() => {
	vars.EMAILABLE_API_KEY = undefined;
	vars.EMAILABLE_MONTHLY_LIMIT = undefined;
});

/** The fake outside world, with Emailable answering "undeliverable" for addresses in `dead`. */
function fake(dead: string[] = []) {
	const asked: string[] = [];
	const aws = fakeOutside({
		extra: (url, init) => {
			if (url.host !== "api.emailable.com") return undefined;
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
			const email = url.searchParams.get("email") ?? "";
			asked.push(email);
			return Response.json(
				dead.includes(email)
					? { email, state: "undeliverable", reason: "rejected_email" }
					: { email, state: "deliverable", reason: "accepted_email" },
			);
		},
	});
	return { aws, asked };
}

const send = (org: { id: string; domain: string }, to: string | string[]) =>
	createEmails(org.id, [parseSend({ from: `a@${org.domain}`, to, subject: "s", text: "t" })]);

describe("Emailable mailbox checks", () => {
	it("leaves out a first-time address whose mailbox doesn't exist, and pays for it once", async () => {
		const org = await seedOrg();
		const typo = `cludia${uid()}@gmail.com`;
		const ok = `ana${uid()}@gmail.com`;
		const { aws, asked } = fake([typo]);
		const [r] = await send(org, [ok, typo]);
		expect(r?.status).toBe("sent");
		expect((aws.sends[0]?.body.Destination as { ToAddresses: string[] }).ToAddresses).toEqual([
			ok,
		]);
		const row = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, r?.id as string))
			.get();
		expect(row?.dropped?.[typo]).toBe("the mailbox doesn't exist (checked with Emailable)");
		expect(asked.sort()).toEqual([ok, typo].sort());

		// Both answers are kept: the next emails (any organization) ask nothing.
		const other = await seedOrg();
		const [again] = await send(other, typo);
		expect(again?.status).toBe("failed");
		expect(asked).toHaveLength(2);

		// The recipient lookup says why, without paying for a check.
		const seen = await lookupRecipient(
			other.id,
			typo,
			{ channel: "dashboard" },
			{ skipDns: true },
		);
		expect(seen.can_receive).toBe(false);
		expect(seen.reasons.join(" ")).toContain("Emailable");
	});

	it("never checks an address SES already delivered to", async () => {
		const org = await seedOrg();
		const to = `c${uid()}@cliente.test`;
		const { asked } = fake();
		vars.EMAILABLE_API_KEY = undefined;
		const [r] = await send(org, to);
		const email = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.id, r?.id as string))
			.get();
		const delivery = await snsNotification({
			eventType: "Delivery",
			mail: {
				messageId: email?.message_id,
				timestamp: "2026-12-31T23:30:00.000Z",
				tags: { mailroom_id: [email?.id] },
			},
			delivery: { timestamp: "2026-12-31T23:30:05.000Z", recipients: [to] },
		});
		expect(await handleSns(delivery)).toBe("applied");
		vars.EMAILABLE_API_KEY = "test-key";
		await send(org, to);
		expect(asked).toEqual([]);
	});

	it("is off without a key and keeps to its limits", async () => {
		const org = await seedOrg();
		const { asked } = fake();
		vars.EMAILABLE_API_KEY = undefined;
		await send(org, `x${uid()}@cliente.test`);
		expect(asked).toEqual([]);

		vars.EMAILABLE_API_KEY = "test-key";
		const many = Array.from({ length: MAX_CHECKS + 3 }, () => `m${uid()}@cliente.test`);
		await mailboxRejected(many);
		expect(asked).toHaveLength(MAX_CHECKS);

		// The month's checks are spent: the rest go through unchecked.
		vars.EMAILABLE_MONTHLY_LIMIT = String(MAX_CHECKS);
		await mailboxRejected([`n${uid()}@cliente.test`]);
		expect(asked).toHaveLength(MAX_CHECKS);
	});

	it("lets an address through when Emailable can't answer", async () => {
		const org = await seedOrg();
		fakeOutside({
			extra: (url) =>
				url.host === "api.emailable.com"
					? new Response("busy", { status: 503 })
					: undefined,
		});
		const [r] = await send(org, `q${uid()}@cliente.test`);
		expect(r?.status).toBe("sent");
		expect(await db.select().from(schema.mailboxChecks)).toEqual([]);
	});
});
