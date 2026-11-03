import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/server/db";
import { forgetOrg } from "@/server/org";
import { sendSystemEmail } from "@/server/system-email";
import { fakeOutside, seedOrg } from "./helpers";

const vars = env as unknown as {
	SYSTEM_FROM?: string;
	SYSTEM_FROM_SES?: string;
	SYSTEM_EMAIL?: { send: (m: unknown) => Promise<{ messageId: string }> };
};

afterEach(() => {
	vars.SYSTEM_FROM = "";
	vars.SYSTEM_FROM_SES = "";
	delete vars.SYSTEM_EMAIL;
});

const message = {
	to: "ana@cliente.test",
	subject: "Su código",
	text: "123456",
	html: "<p>123456</p>",
};

describe("system emails", () => {
	it("go through the organization that owns SYSTEM_FROM's domain", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		vars.SYSTEM_FROM = `Mailroom <no-reply@${org.domain}>`;
		await sendSystemEmail(message);
		expect(aws.sends).toHaveLength(1);
		expect(aws.sends[0]?.body.TenantName).toBe(`mailroom-${org.slug}`);
	});

	it("go straight to SES when SES has paused that organization's tenant", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		await db
			.update(schema.orgSending)
			.set({ tenant_status: "DISABLED" })
			.where(eq(schema.orgSending.organization_id, org.id));
		forgetOrg(org.id);
		vars.SYSTEM_FROM = `Mailroom <no-reply@${org.domain}>`;
		await sendSystemEmail(message);
		expect(aws.sends).toHaveLength(1);
		expect(aws.sends[0]?.body.TenantName).toBeUndefined();
		expect(aws.sends[0]?.body.ConfigurationSetName).toBeUndefined();
		const logged = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, org.id));
		expect(logged).toHaveLength(0);
	});

	it("go through Cloudflare's Email Sending when it's set up, without touching SES", async () => {
		const aws = fakeOutside();
		const send = vi.fn(async () => ({ messageId: "cf-1" }));
		vars.SYSTEM_EMAIL = { send };
		vars.SYSTEM_FROM = "Mailroom <no-reply@acme.test>";
		vars.SYSTEM_FROM_SES = "Mailroom <no-reply@globex.test>";
		await sendSystemEmail(message);
		expect(send).toHaveBeenCalledWith({
			from: { email: "no-reply@acme.test", name: "Mailroom" },
			to: message.to,
			subject: message.subject,
			html: message.html,
			text: message.text,
		});
		expect(aws.sends).toHaveLength(0);
	});

	it("fall back to SES from SYSTEM_FROM_SES when Cloudflare refuses", async () => {
		const aws = fakeOutside();
		const org = await seedOrg();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vars.SYSTEM_EMAIL = {
			send: async () => {
				throw Object.assign(new Error("sender not verified"), {
					code: "E_SENDER_NOT_VERIFIED",
				});
			},
		};
		vars.SYSTEM_FROM = "Mailroom <no-reply@acme.test>";
		vars.SYSTEM_FROM_SES = `Mailroom <no-reply@${org.domain}>`;
		await sendSystemEmail(message);
		expect(aws.sends).toHaveLength(1);
		expect(aws.sends[0]?.body.TenantName).toBe(`mailroom-${org.slug}`);
	});
});
