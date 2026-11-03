import { beforeEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import { setSetting } from "@/server/settings";
import {
	createSmtpCredentials,
	deleteSmtpCredentials,
	smtpCredentials,
	smtpPassword,
	syncSmtpPolicy,
} from "@/server/smtp";
import { iso } from "@/server/time";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** IAM's query API: the actions called, with their parameters. */
function fakeIam(o: { denied?: boolean } = {}) {
	const calls: Record<string, string>[] = [];
	let keys = 0;
	fakeOutside({
		extra: async (url, init) => {
			if (url.host !== "iam.amazonaws.com") return undefined;
			const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
			calls.push(p);
			if (o.denied)
				return new Response(
					"<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>",
					{ status: 403 },
				);
			if (p.Action === "CreateAccessKey") {
				keys++;
				return new Response(
					`<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>AKIAFAKE${keys}</AccessKeyId><SecretAccessKey>secret/${keys}+x</SecretAccessKey></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
				);
			}
			if (p.Action === "ListAccessKeys")
				return new Response(
					`<ListAccessKeysResponse><AccessKeyMetadata><member><AccessKeyId>AKIAFAKE${keys}</AccessKeyId></member></AccessKeyMetadata></ListAccessKeysResponse>`,
				);
			return new Response("<Ok/>");
		},
	});
	return calls;
}

describe("SMTP credentials", () => {
	beforeEach(async () => {
		await setSetting("aws_account_id", "123456789012");
	});

	it("derives the SES SMTP password as AWS documents it", async () => {
		// The same key run through AWS's Python reference (smtp_credentials_generate.py).
		expect(await smtpPassword("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-2")).toBe(
			"BMPPgbAHoFVbze1Ud0oA5uNdXRwUXUZ+qOwphGJbl/cS",
		);
	});

	it("creates a send-only user under the boundary, limited to the organization's domains", async () => {
		const iam = fakeIam();
		const org = await seedOrg();
		const c = await createSmtpCredentials(org.id);
		expect(c.access_key_id).toBe("AKIAFAKE1");
		expect(c.password).toBe(await smtpPassword("secret/1+x", c.region));

		const user = iam.find((p) => p.Action === "CreateUser");
		expect(user?.Path).toBe("/mailroom-smtp/");
		expect(user?.PermissionsBoundary).toBe(
			"arn:aws:iam::123456789012:policy/mailroom-smtp-boundary",
		);
		const policy = JSON.parse(
			iam.find((p) => p.Action === "PutUserPolicy")?.PolicyDocument ?? "",
		);
		expect(policy.Statement[0].Action).toBe("ses:SendRawEmail");
		expect(policy.Statement[0].Condition.StringLike["ses:FromAddress"]).toEqual([
			`*@${org.domain}`,
			`*@*.${org.domain}`,
		]);
		// Only the key id is kept, never the secret.
		const row = await smtpCredentials(org.id);
		expect(row?.access_key_id).toBe("AKIAFAKE1");
		expect(JSON.stringify(row)).not.toContain("secret");
	});

	it("replaces the key, deleting the old one", async () => {
		const iam = fakeIam();
		const org = await seedOrg();
		await createSmtpCredentials(org.id);
		const again = await createSmtpCredentials(org.id);
		expect(again.access_key_id).toBe("AKIAFAKE2");
		expect(iam).toContainEqual(
			expect.objectContaining({ Action: "DeleteAccessKey", AccessKeyId: "AKIAFAKE1" }),
		);
	});

	it("follows the domains", async () => {
		const iam = fakeIam();
		const org = await seedOrg();
		await createSmtpCredentials(org.id);
		await db.insert(schema.domains).values({
			id: `dom_${uid()}`,
			organization_id: org.id,
			name: "second.test",
			status: "verified",
			dkim_tokens: [],
			region: "us-east-1",
			created_at: iso(),
		});
		await syncSmtpPolicy(org.id);
		const last = iam.filter((p) => p.Action === "PutUserPolicy").at(-1);
		expect(
			JSON.parse(last?.PolicyDocument ?? "").Statement[0].Condition.StringLike[
				"ses:FromAddress"
			],
		).toContain("*@second.test");
	});

	it("deletes the user and forgets it", async () => {
		const iam = fakeIam();
		const org = await seedOrg();
		await createSmtpCredentials(org.id);
		await deleteSmtpCredentials(org.id);
		expect(iam.map((p) => p.Action).slice(-4)).toEqual([
			"ListAccessKeys",
			"DeleteAccessKey",
			"DeleteUserPolicy",
			"DeleteUser",
		]);
		expect(await smtpCredentials(org.id)).toBeNull();
	});

	it("says what to run when Mailroom's AWS user may not make SMTP users", async () => {
		fakeIam({ denied: true });
		const org = await seedOrg();
		await expect(createSmtpCredentials(org.id)).rejects.toThrow(/update-iam\.sh/);
	});
});
