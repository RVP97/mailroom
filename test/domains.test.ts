import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import {
	addDomain,
	dnsRecords,
	ownershipHost,
	ownershipValue,
	removeDomain,
	verifyDomain,
} from "@/server/provision";
import { clearSettingsCache, setSetting } from "@/server/settings";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** SES's identity and tenant endpoints; `existing` identities answer AlreadyExists on create. */
function fakeSes(
	existing: Record<string, { MailFromDomain?: string }> = {},
	txt: Record<string, string[]> = {},
) {
	const ses: string[] = [];
	fakeOutside({
		txt,
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
					// An identity that was there before is verified in SES already.
					VerifiedForSendingStatus: name in existing,
					DkimAttributes: {
						Tokens: ["e1", "e2", "e3"],
						Status: name in existing ? "SUCCESS" : "PENDING",
					},
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

	it("an identity SES already verified stays pending until the brand proves the domain with a TXT record", async () => {
		const org = await seedOrg();
		const name = `taken-${uid()}.test`;
		fakeSes({ [name]: {} });
		const d = await addDomain(org.id, name);
		const proof = dnsRecords(d).find((r) => r.record === "Ownership");
		expect(proof).toMatchObject({
			type: "TXT",
			name: ownershipHost(name),
			value: `"${ownershipValue(org.id)}"`,
		});
		// SES says verified (someone else's DKIM records): not enough.
		expect((await verifyDomain(org.id, d.id)).status).toBe("pending");
		// Another brand's proof isn't this one's.
		fakeSes({ [name]: {} }, { [ownershipHost(name)]: [ownershipValue("someone-else")] });
		expect((await verifyDomain(org.id, d.id)).status).toBe("pending");
		fakeSes({ [name]: {} }, { [ownershipHost(name)]: [ownershipValue(org.id)] });
		const verified = await verifyDomain(org.id, d.id);
		expect(verified.status).toBe("verified");
		expect(dnsRecords(verified).some((r) => r.record === "Ownership")).toBe(false);
	});

	it("a domain Mailroom created needs no TXT proof", async () => {
		const org = await seedOrg();
		fakeSes();
		const d = await addDomain(org.id, `fresh-${uid()}.test`);
		expect(dnsRecords(d).some((r) => r.record === "Ownership")).toBe(false);
	});
});
