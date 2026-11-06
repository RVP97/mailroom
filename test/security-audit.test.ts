import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { maskedSearch, maskHeaders } from "@/lib/permissions";
import { hostedPage, parseDesign } from "@/lib/signup-form-render";
import { memberAccess } from "@/server/access";
import { createBroadcast, getBroadcast, updateBroadcast } from "@/server/broadcasts";
import { addToSegment, createSegment, removeFromSegment, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { decideReview, requestReview, setApprovalRequired } from "@/server/reviews";
import { setSetting } from "@/server/settings";
import { createSmtpCredentials, deleteSmtpCredentials } from "@/server/smtp";
import { fakeOutside, seedOrg, uid } from "./helpers";

/** Regression tests for the security audit's findings (one block each). */

async function person(organizationId: string, role: string) {
	const userId = `user_${uid()}`;
	await db
		.insert(schema.user)
		.values({ id: userId, name: `P ${role}`, email: `${userId}@p.test` });
	await db.insert(schema.member).values({
		id: `mem_${uid()}`,
		organizationId,
		userId,
		role,
		createdAt: new Date(),
	});
	return { userId, access: await memberAccess(organizationId, userId) };
}

describe("sign-up form designs", () => {
	it("never lets an image address end the page's <style>", () => {
		const d = parseDesign({
			layout: "split",
			image_url: "https://x.test/a.png</style><script>alert(1)</script>",
		});
		expect(d.image_url).not.toContain("<");
		const html = hostedPage(
			{
				id: "frm_x",
				action: "https://mailroom.test/subscribe/frm_x",
				title: "News",
				ask_name: false,
			},
			{ ...d, image_url: 'https://x.test/a"</style><script>alert(1)</script>' } as never,
			{ nonce: "n1" },
		);
		expect(html).not.toContain("</style><script>alert(1)");
		expect(html).toContain('<script nonce="n1">');
	});

	it("keeps only https images", () => {
		expect(parseDesign({ image_url: "javascript:alert(1)" }).image_url).toBe("");
		expect(parseDesign({ image_url: "https://img.test/a b.png" }).image_url).toBe("");
	});
});

describe("segments", () => {
	it("refuses another brand's contact", async () => {
		const a = await seedOrg();
		const b = await seedOrg();
		const segment = await createSegment(a.id, { name: "Guests" });
		const { contact } = await upsertContact(b.id, { email: `x-${uid()}@guest.test` });
		await expect(addToSegment(a.id, contact.id, segment.id)).rejects.toThrow(/Contact/);
		await expect(removeFromSegment(a.id, contact.id, segment.id)).rejects.toThrow(/Contact/);
		const rows = await db
			.select()
			.from(schema.contactSegments)
			.where(eq(schema.contactSegments.contact_id, contact.id));
		expect(rows).toEqual([]);
	});
});

describe("broadcast approval", () => {
	it("asks again when the audience or Reply-To changes, and never lets the author approve", async () => {
		fakeOutside();
		const org = await seedOrg();
		await setApprovalRequired(org.id, true);
		const writer = await person(org.id, "writer");
		const marketer = await person(org.id, "marketer");
		const other = await person(org.id, "marketer");

		// A marketer's own draft: no approving it without a request, nor after asking.
		const own = await createBroadcast(
			org.id,
			org.id,
			{ from: `News <news@${org.domain}>`, subject: "Mine", html: "<p>Hi</p>" },
			Date.now(),
			marketer.userId,
		);
		const decide = (who: typeof marketer, id: string) =>
			decideReview({
				organizationId: org.id,
				brand: org.id,
				id,
				userId: who.userId,
				access: who.access,
				approve: true,
			});
		await expect(decide(marketer, own.id)).rejects.toThrow();
		await requestReview({
			organizationId: org.id,
			brand: org.id,
			id: own.id,
			userId: marketer.userId,
		});
		await expect(decide(marketer, own.id)).rejects.toThrow();

		// A writer's draft approved by a marketer, then the writer changes Reply-To.
		const b = await createBroadcast(
			org.id,
			org.id,
			{ from: `News <news@${org.domain}>`, subject: "Hello", html: "<p>Hi</p>" },
			Date.now(),
			writer.userId,
		);
		await requestReview({
			organizationId: org.id,
			brand: org.id,
			id: b.id,
			userId: writer.userId,
		});
		await decide(other, b.id);
		expect((await getBroadcast(org.id, b.id)).review).toBe("approved");
		await updateBroadcast(
			org.id,
			org.id,
			b.id,
			{ reply_to: ["outside@elsewhere.test"] },
			Date.now(),
			writer.userId,
		);
		expect((await getBroadcast(org.id, b.id)).review).toBeNull();
	});
});

describe("masking", () => {
	it("dots digits in headers and keeps them out of searches", () => {
		expect(maskHeaders({ subject: "Your code 482913", "x-n": "12" })).toEqual({
			subject: "Your code ••••••",
			"x-n": "12",
		});
		expect(maskedSearch("Your code 4829")).toBe("Your code");
		expect(maskedSearch("ana 12")).toBe("ana 12");
	});
});

describe("SMTP users", () => {
	beforeEach(async () => {
		await setSetting("aws_account_id", "123456789012");
	});

	it("gives each brand its own IAM user, whatever its slug", async () => {
		const calls: Record<string, string>[] = [];
		let keys = 0;
		fakeOutside({
			extra: async (url, init) => {
				if (url.host !== "iam.amazonaws.com") return undefined;
				const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
				calls.push(p);
				if (p.Action === "CreateAccessKey") {
					keys++;
					return new Response(
						`<CreateAccessKeyResponse><CreateAccessKeyResult><AccessKey><AccessKeyId>AKIAFAKE${keys}</AccessKeyId><SecretAccessKey>s/${keys}</SecretAccessKey></AccessKey></CreateAccessKeyResult></CreateAccessKeyResponse>`,
					);
				}
				if (p.Action === "ListAccessKeys")
					return new Response(
						"<ListAccessKeysResponse><AccessKeyMetadata></AccessKeyMetadata></ListAccessKeysResponse>",
					);
				return new Response("<Ok/>");
			},
		});
		const victim = await seedOrg();
		const attacker = await seedOrg();
		// Slugs that came out the same IAM user name before (lowercased, symbols dropped).
		await db
			.update(schema.organization)
			.set({ slug: `${victim.slug}!` })
			.where(eq(schema.organization.id, attacker.id));
		const v = await createSmtpCredentials(victim.id);
		const a = await createSmtpCredentials(attacker.id);
		expect(a.iam_user).not.toBe(v.iam_user);
		await deleteSmtpCredentials(attacker.id);
		expect(calls.some((c) => c.Action === "DeleteUser" && c.UserName === v.iam_user)).toBe(
			false,
		);
	});

	it("only removes its own key from a user another brand also has", async () => {
		const calls: Record<string, string>[] = [];
		fakeOutside({
			extra: async (url, init) => {
				if (url.host !== "iam.amazonaws.com") return undefined;
				calls.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
				return new Response("<Ok/>");
			},
		});
		const one = await seedOrg();
		const two = await seedOrg();
		const shared = `mailroom-smtp-legacy-${uid()}`;
		for (const [o, key] of [
			[one, "AKIAONE"],
			[two, "AKIATWO"],
		] as const)
			await db.insert(schema.smtpCredentials).values({
				organization_id: o.id,
				iam_user: shared,
				access_key_id: key,
				region: "us-east-1",
				created_at: new Date().toISOString(),
			});
		await deleteSmtpCredentials(two.id);
		expect(calls.map((c) => [c.Action, c.AccessKeyId ?? c.UserName])).toEqual([
			["DeleteAccessKey", "AKIATWO"],
		]);
	});
});
