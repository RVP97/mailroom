import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import { forgetOrg } from "@/server/org";
import { decryptSecret, forgetOwnAccounts, paceFor } from "@/server/org-aws";
import {
	checkMoves,
	connectOrgAws,
	disconnectOrgAws,
	ownAccountStatus,
} from "@/server/org-aws-manage";
import { dnsRecords } from "@/server/provision";
import { createEmails, parseSend } from "@/server/send";
import { clearSettingsCache, setSetting } from "@/server/settings";
import { iso } from "@/server/time";
import { fakeOutside, seedOrg, signedSns, TOPIC, uid } from "./helpers";

const OWN_ACCOUNT = "999988887777";
const OWN_KEY = "AKIAOWNACCOUNTKEY123";
const OWN_SECRET = "own/secret/key/that/is/long/enough/1234";
const OWN_TOPIC = `arn:aws:sns:eu-west-1:${OWN_ACCOUNT}:mailroom-ses-events`;
const OWN_BUCKET = `mailroom-inbound-${OWN_ACCOUNT}-eu-west-1`;

interface Call {
	method: string;
	host: string;
	path: string;
	action: string | null;
	key: string;
}

/**
 * The organization's own account in eu-west-1 (STS, SES v1 and v2, SNS, S3) and the deployment's
 * in us-east-1. Every call is kept with the access key it was signed with. `verified`: the
 * identities SES says are verified in eu-west-1. `failSends`: SES's error for eu-west-1 sends.
 */
function fakeAccounts(
	o: { verified?: Set<string>; failSends?: { status: number; type: string } } = {},
) {
	const calls: Call[] = [];
	const sends: Record<string, unknown>[] = [];
	const objects = new Map<string, string>();
	const outside = fakeOutside({
		extra: async (url, init) => {
			const method = init?.method ?? "GET";
			const auth = new Headers(init?.headers).get("authorization") ?? "";
			const key = /Credential=([^/]+)/.exec(auth)?.[1] ?? "";
			const body = init?.body ? String(init.body) : "";
			const action = new URLSearchParams(body).get("Action");
			if (url.host.endsWith("amazonaws.com"))
				calls.push({ method, host: url.host, path: url.pathname, action, key });
			if (url.host === "email.us-east-1.amazonaws.com") return Response.json({});
			if (!url.host.endsWith("eu-west-1.amazonaws.com")) return undefined;
			if (url.host === "sts.eu-west-1.amazonaws.com")
				return new Response(
					`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${OWN_ACCOUNT}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
				);
			if (url.host === "sns.eu-west-1.amazonaws.com")
				return new Response(
					action === "CreateTopic"
						? `<CreateTopicResponse><CreateTopicResult><TopicArn>${OWN_TOPIC}</TopicArn></CreateTopicResult></CreateTopicResponse>`
						: `<${action}Response/>`,
				);
			if (url.host === `${OWN_BUCKET}.s3.eu-west-1.amazonaws.com`) {
				const k = url.pathname.slice(1);
				if (method === "GET") {
					const raw = objects.get(k);
					return raw === undefined
						? new Response("<Error/>", { status: 404 })
						: new Response(raw);
				}
				if (method === "DELETE") objects.delete(k);
				return new Response("");
			}
			if (url.host === "email.eu-west-1.amazonaws.com" && url.pathname === "/")
				return new Response(
					action === "DescribeActiveReceiptRuleSet"
						? "<DescribeActiveReceiptRuleSetResponse><DescribeActiveReceiptRuleSetResult></DescribeActiveReceiptRuleSetResult></DescribeActiveReceiptRuleSetResponse>"
						: `<${action}Response/>`,
				);
			if (url.pathname === "/v2/email/account")
				return Response.json({
					ProductionAccessEnabled: true,
					SendingEnabled: true,
					SendQuota: { Max24HourSend: 50000, MaxSendRate: 40, SentLast24Hours: 0 },
				});
			if (url.pathname === "/v2/email/tenants")
				return Response.json({
					TenantArn: `arn:aws:ses:eu-west-1:${OWN_ACCOUNT}:tenant/${JSON.parse(body).TenantName}/t-9`,
				});
			if (url.pathname === "/v2/email/outbound-emails") {
				if (o.failSends)
					return Response.json(
						{ message: "The security token included in the request is invalid." },
						{
							status: o.failSends.status,
							headers: { "x-amzn-ErrorType": o.failSends.type },
						},
					);
				sends.push(JSON.parse(body));
				return Response.json({ MessageId: `0200-own-${uid()}` });
			}
			if (url.pathname === "/v2/email/identities" && method === "POST")
				return Response.json({ DkimAttributes: { Tokens: ["o1", "o2", "o3"] } });
			if (url.pathname.startsWith("/v2/email/identities/") && method === "GET") {
				const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
				return Response.json({
					VerifiedForSendingStatus: o.verified?.has(name) ?? false,
					DkimAttributes: { Tokens: ["o1", "o2", "o3"] },
				});
			}
			return Response.json({});
		},
	});
	return { calls, sends, objects, outside };
}

/** An organization with no domains yet (sending set up in the deployment's account). */
async function bareOrg() {
	const org = await seedOrg();
	await db.delete(schema.domains).where(eq(schema.domains.id, org.domainId));
	forgetOrg(org.id);
	return org;
}

async function addVerifiedDomain(brand: string, name: string, extra: Record<string, unknown> = {}) {
	const id = `dom_${uid()}`;
	await db.insert(schema.domains).values({
		id,
		organization_id: brand,
		name,
		status: "verified",
		dkim_tokens: ["a"],
		region: "eu-west-1",
		created_at: iso(),
		...extra,
	});
	forgetOrg(brand);
	return id;
}

const connect = (id: string) =>
	connectOrgAws(id, { accessKeyId: OWN_KEY, secretAccessKey: OWN_SECRET, region: "eu-west-1" });

const emailOf = (brand: string) =>
	db.select().from(schema.emails).where(eq(schema.emails.organization_id, brand)).get();

describe("an organization's own SES account", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		// One account is one organization's: each test connects it afresh.
		await db.delete(schema.orgAws);
		await db.delete(schema.orgAwsMoves);
		clearSettingsCache();
		forgetOwnAccounts();
		await setSetting("aws_account_id", "123456789012");
		await setSetting("sns_topic_arn", TOPIC);
		await setSetting("aws_credentials_error", "");
	});

	it("connects: checks the keys, makes the topic there, sets the brand up there, keeps the secret encrypted", async () => {
		const org = await bareOrg();
		const own = fakeAccounts();
		const status = await connect(org.id);
		expect(status.connected).toBe(true);
		expect(status.accountId).toBe(OWN_ACCOUNT);
		expect(status.accessKey).toBe("AKIA…Y123");
		expect(status.maxSendRate).toBe(40);
		const mine = own.calls.filter((c) => c.host.includes("eu-west-1"));
		const actions = mine.map((c) => c.action ?? c.path);
		expect(actions).toContain("GetCallerIdentity");
		expect(actions).toContain("CreateTopic");
		expect(actions).toContain("Subscribe");
		expect(actions).toContain("/v2/email/tenants");
		expect(mine.every((c) => c.key === OWN_KEY)).toBe(true);

		const row = await db
			.select()
			.from(schema.orgAws)
			.where(eq(schema.orgAws.organization_id, org.id))
			.get();
		expect(row?.secret_encrypted).not.toContain(OWN_SECRET);
		expect(await decryptSecret(row?.secret_encrypted ?? "")).toBe(OWN_SECRET);
		expect(row?.topic_arn).toBe(OWN_TOPIC);
		const sending = await db
			.select()
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, org.id))
			.get();
		expect(sending?.status).toBe("ready");
		expect(sending?.tenant_arn).toContain(`:${OWN_ACCOUNT}:tenant/`);
		// Paced at its own account's rate, apart from the deployment's.
		expect(await paceFor(org.id)).toEqual({ key: `${OWN_ACCOUNT}:eu-west-1`, perSecond: 40 });
	});

	it("sends through its own account, while other organizations keep the deployment's", async () => {
		const org = await bareOrg();
		const own = fakeAccounts();
		await connect(org.id);
		await addVerifiedDomain(org.id, org.domain);
		const other = await seedOrg();
		await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "x@cliente.test", subject: "s", text: "t" }),
		]);
		await createEmails(other.id, [
			parseSend({ from: `a@${other.domain}`, to: "y@cliente.test", subject: "s", text: "t" }),
		]);
		expect(own.sends).toHaveLength(1);
		expect(own.outside.sends).toHaveLength(1);
		expect(String(own.outside.sends[0]?.headers.get("authorization"))).toContain(
			"Credential=AKIDEXAMPLE/",
		);
		expect((await paceFor(other.id)).key).toBe("default");
	});

	it("keeps emails waiting when AWS refuses the keys, and a working send clears the error", async () => {
		const org = await bareOrg();
		fakeAccounts();
		await connect(org.id);
		await addVerifiedDomain(org.id, org.domain);
		vi.restoreAllMocks();
		fakeAccounts({ failSends: { status: 403, type: "UnrecognizedClientException" } });
		const [r] = await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "x@cliente.test", subject: "s", text: "t" }),
		]);
		expect(r?.status).toBe("queued");
		const waiting = await emailOf(org.id);
		expect(waiting?.status).toBe("queued");
		expect(waiting?.attempts).toBe(0);
		const status = await ownAccountStatus(org.id);
		expect(status.credentialsError?.message).toMatch(/security token/);

		vi.restoreAllMocks();
		fakeAccounts();
		forgetOwnAccounts();
		await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "z@cliente.test", subject: "s", text: "t" }),
		]);
		expect((await ownAccountStatus(org.id)).credentialsError).toBeNull();
	});

	it("moves an organization with domains: verified in the new account first, then sending switches", async () => {
		const org = await seedOrg();
		const verified = new Set<string>();
		const fake = fakeAccounts({ verified });
		const started = await connect(org.id);
		expect(started.connected).toBe(false);
		expect(started.move?.to).toEqual({ accountId: OWN_ACCOUNT, region: "eu-west-1" });
		expect(started.move?.domains).toEqual([
			expect.objectContaining({ name: org.domain, verified: false }),
		]);
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		expect(d?.move_dkim_tokens).toEqual(["o1", "o2", "o3"]);
		// The domain's page shows the new account's DKIM records beside the old ones.
		const records = dnsRecords(d as NonNullable<typeof d>).filter((x) => x.record === "DKIM");
		expect(records.map((x) => x.name)).toContain(`o1._domainkey.${org.domain}`);
		expect(records.find((x) => x.name.startsWith("a."))?.note).toBeUndefined();

		// Meanwhile it still sends through the deployment's account.
		await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "x@cliente.test", subject: "s", text: "t" }),
		]);
		expect(fake.outside.sends).toHaveLength(1);
		expect(fake.sends).toHaveLength(0);

		await checkMoves();
		expect((await ownAccountStatus(org.id)).move).not.toBeNull();
		verified.add(org.domain);
		fake.calls.length = 0;
		await checkMoves();
		const done = await ownAccountStatus(org.id);
		expect(done.move).toBeNull();
		expect(done.connected).toBe(true);
		const after = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		expect(after?.dkim_tokens).toEqual(["o1", "o2", "o3"]);
		expect(after?.move_dkim_tokens).toBeNull();
		// The old account's tenant lets go of the identity.
		expect(
			fake.calls.some(
				(c) =>
					c.host === "email.us-east-1.amazonaws.com" &&
					c.path === "/v2/email/tenants/resources/delete",
			),
		).toBe(true);
		forgetOrg(org.id);
		await createEmails(org.id, [
			parseSend({ from: `a@${org.domain}`, to: "y@cliente.test", subject: "s", text: "t" }),
		]);
		expect(fake.sends).toHaveLength(1);
	});

	it("receives at a domain in its own account: its own drop box and rule, its own keys", async () => {
		const org = await bareOrg();
		const fake = fakeAccounts();
		await connect(org.id);
		const domainId = await addVerifiedDomain(org.id, `own-${uid()}.test`);
		const { setDomainReceiving } = await import("@/server/inbound");
		await setDomainReceiving(org.id, domainId, true, { replaceMx: true });
		const ses = fake.calls.filter((c) => c.host === "email.eu-west-1.amazonaws.com");
		expect(ses.map((c) => c.action)).toContain("CreateReceiptRule");
		expect(fake.calls.some((c) => c.host === `${OWN_BUCKET}.s3.eu-west-1.amazonaws.com`)).toBe(
			true,
		);
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, domainId))
			.get();
		const host = d?.receiving_host ?? "";
		fake.objects.set(
			"inbound/k1",
			["From: a@guest.test", `To: hi@${host}`, "Subject: Hola", "", "Hi"].join("\r\n"),
		);
		const notification = (bucket: string) =>
			signedSns({
				Type: "Notification",
				MessageId: `sns-${uid()}`,
				TopicArn: OWN_TOPIC,
				Message: JSON.stringify({
					notificationType: "Received",
					mail: { messageId: `ses-${uid()}`, destination: [`hi@${host}`] },
					receipt: {
						recipients: [`hi@${host}`],
						virusVerdict: { status: "PASS" },
						action: { type: "S3", bucketName: bucket, objectKey: "inbound/k1" },
					},
				}),
				Timestamp: iso(),
			});
		// Another bucket than its own: not its message.
		expect(await handleSns(await notification("someone-elses-bucket"))).toBe("ignored");
		expect(await handleSns(await notification(OWN_BUCKET))).toBe("applied");
		const row = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id))
			.get();
		expect(row?.subject).toBe("Hola");
		expect(fake.objects.has("inbound/k1")).toBe(false);
	});

	it("takes events from its topic only about its own brands' emails", async () => {
		const org = await bareOrg();
		fakeAccounts();
		await connect(org.id);
		const other = await seedOrg();
		await createEmails(other.id, [
			parseSend({ from: `a@${other.domain}`, to: "z@cliente.test", subject: "s", text: "t" }),
		]);
		const theirs = await emailOf(other.id);
		const confirm = await signedSns({
			Type: "SubscriptionConfirmation",
			MessageId: `sub-${uid()}`,
			TopicArn: OWN_TOPIC,
			Message: "subscribe",
			SubscribeURL: `https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${OWN_TOPIC}&Token=t`,
			Token: "t",
			Timestamp: iso(),
		});
		expect(await handleSns(confirm)).toBe("confirmed");
		expect((await ownAccountStatus(org.id)).subscriptionConfirmedAt).not.toBeNull();

		// A bounce "about" another organization's email, published to this organization's topic.
		const forged = await signedSns({
			Type: "Notification",
			MessageId: `sns-${uid()}`,
			TopicArn: OWN_TOPIC,
			Message: JSON.stringify({
				eventType: "Bounce",
				mail: { messageId: theirs?.message_id, tags: { mailroom_id: [theirs?.id] } },
				bounce: {
					bounceType: "Permanent",
					bouncedRecipients: [{ emailAddress: "z@cliente.test" }],
				},
			}),
			Timestamp: iso(),
		});
		expect(await handleSns(forged)).toBe("ignored");
		expect((await emailOf(other.id))?.status).not.toBe("bounced");
	});

	it("goes back to the deployment's account at once without domains", async () => {
		const org = await bareOrg();
		fakeAccounts();
		await connect(org.id);
		const back = await disconnectOrgAws(org.id);
		expect(back.connected).toBe(false);
		expect(back.move).toBeNull();
		const sending = await db
			.select()
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, org.id))
			.get();
		expect(sending?.status).toBe("ready");
	});
});
