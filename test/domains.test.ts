import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { addDomain, removeDomain } from "@/server/provision";
import { clearSettingsCache, setSetting } from "@/server/settings";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** SES's identity and tenant endpoints; `existing` identities answer AlreadyExists on create. */
function fakeSes(existing: Record<string, { MailFromDomain?: string }> = {}) {
	const ses: string[] = [];
	fakeOutside({
		extra: async (url, init) => {
			if (url.host !== "email.us-east-1.amazonaws.com") return undefined;
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			ses.push(`${method} ${url.pathname}`);
			if (method === "POST" && url.pathname === "/v2/email/identities") {
				if (body.EmailIdentity in existing)
					return Response.json(
						{ message: "exists" },
						{ status: 400, headers: { "x-amzn-ErrorType": "AlreadyExistsException" } },
					);
				return Response.json({ DkimAttributes: { Tokens: ["n1", "n2", "n3"] } });
			}
			if (method === "GET" && url.pathname.startsWith("/v2/email/identities/")) {
				const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
				return Response.json({
					DkimAttributes: { Tokens: ["e1", "e2", "e3"] },
					MailFromAttributes: existing[name]?.MailFromDomain
						? { MailFromDomain: existing[name].MailFromDomain }
						: {},
				});
			}
			return Response.json({});
		},
	});
	return ses;
}

const domainRow = (id: string) =>
	db.select().from(schema.domains).where(eq(schema.domains.id, id)).get();

describe("domains", () => {
	beforeEach(async () => {
		clearSettingsCache();
		await setSetting("aws_account_id", "123456789012");
	});

	it("removing a domain Mailroom created unlinks it from the tenant, then deletes the identity", async () => {
		const org = await seedOrg();
		const name = `new-${uid()}.test`;
		const ses = fakeSes();
		const d = await addDomain(org.id, name);
		expect(d.ses_owned).toBe(true);
		expect(ses).toContain(`PUT /v2/email/identities/${name}/mail-from`);

		ses.length = 0;
		await removeDomain(org.id, d.id);
		expect(ses).toEqual([
			"POST /v2/email/tenants/resources/delete",
			`DELETE /v2/email/identities/${name}`,
		]);
		expect(await domainRow(d.id)).toBeUndefined();
	});

	it("an identity that was already in SES keeps its MAIL FROM, and removing it only unlinks it", async () => {
		const org = await seedOrg();
		const name = `old-${uid()}.test`;
		const ses = fakeSes({ [name]: { MailFromDomain: `send.${name}` } });
		const d = await addDomain(org.id, name);
		expect(d.ses_owned).toBe(false);
		expect(d.mail_from).toBe(`send.${name}`);
		expect(d.dkim_tokens).toEqual(["e1", "e2", "e3"]);
		expect(ses.some((c) => c.endsWith("/mail-from"))).toBe(false);

		ses.length = 0;
		await removeDomain(org.id, d.id);
		expect(ses).toEqual(["POST /v2/email/tenants/resources/delete"]);
		expect(await domainRow(d.id)).toBeUndefined();
	});

	it("an identity already in SES without a MAIL FROM gets bounce.<domain>", async () => {
		const org = await seedOrg();
		const name = `bare-${uid()}.test`;
		const ses = fakeSes({ [name]: {} });
		const d = await addDomain(org.id, name);
		expect(d.ses_owned).toBe(false);
		expect(d.mail_from).toBe(`bounce.${name}`);
		expect(ses).toContain(`PUT /v2/email/identities/${name}/mail-from`);
	});
});
