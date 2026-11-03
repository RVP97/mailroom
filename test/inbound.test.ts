import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { setArchiveEnabled } from "@/server/archive";
import { ruleName, withSesPublish } from "@/server/aws/receiving";
import { orgOf } from "@/server/brands";
import { db, schema } from "@/server/db";
import { handleSns } from "@/server/events";
import {
	checkPendingReceiving,
	inboundAddresses,
	mailroomAddress,
	ownersOf,
	purgeReceived,
	receivingStatus,
	serveAttachment,
	setDomainReceiving,
	setInboundAddress,
	setUpReceiving,
} from "@/server/inbound";
import { matches } from "@/server/inbound-rules";
import { forgetOrg, orgContext } from "@/server/org";
import { addDomain, dnsRecords, setDomainSending } from "@/server/provision";
import { storedContent } from "@/server/send";
import { clearSettingsCache, getSetting, setSetting } from "@/server/settings";
import { createWebhook } from "@/server/webhook-admin";
import { fakeOutside, seedOrg, snsNotification, TOPIC, uid, useTopic } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const ACCOUNT = "123456789012";
const BUCKET = `mailroom-inbound-${ACCOUNT}-us-east-1`;
const store = () => (env as unknown as { INBOUND: R2Bucket }).INBOUND;

beforeAll(async () => {
	await useTopic();
	await setSetting("aws_account_id", ACCOUNT);
});

/** Receiving set up (as setUpReceiving leaves it) without calling AWS. */
async function receivingReady() {
	await setSetting("inbound_bucket", BUCKET);
	await setSetting("inbound_rule_set", "mailroom");
	await setSetting("inbound_set_up_at", new Date().toISOString());
}

type Call = { method: string; url: URL; body: string; headers: Headers };

/** Every AWS call made, with the answers receiving needs; `objects` are the S3 drop box. */
function fakeAws(
	o: { mx?: Record<string, string[]>; objects?: Map<string, string>; activeSet?: string } = {},
) {
	const calls: Call[] = [];
	const objects = o.objects ?? new Map<string, string>();
	const fake = fakeOutside({
		extra: async (url, init) => {
			const body = typeof init?.body === "string" ? init.body : "";
			const call = {
				method: init?.method ?? "GET",
				url,
				body,
				headers: new Headers(init?.headers),
			};
			if (url.host === "app.test") return new Response("ok");
			calls.push(call);
			if (url.host === "email.us-east-1.amazonaws.com" && url.pathname === "/") {
				const action = new URLSearchParams(body).get("Action");
				if (action === "DescribeActiveReceiptRuleSet")
					return new Response(
						`<DescribeActiveReceiptRuleSetResponse><DescribeActiveReceiptRuleSetResult>${o.activeSet ? `<Metadata><Name>${o.activeSet}</Name></Metadata>` : ""}</DescribeActiveReceiptRuleSetResult></DescribeActiveReceiptRuleSetResponse>`,
					);
				return new Response(`<${action}Response/>`);
			}
			if (
				url.host === "email.us-east-1.amazonaws.com" &&
				url.pathname === "/v2/email/identities"
			)
				return Response.json({ DkimAttributes: { Tokens: ["t1", "t2", "t3"] } });
			if (url.host === "email.us-east-1.amazonaws.com")
				return Response.json({ VerifiedForSendingStatus: false });
			if (url.host === "sns.us-east-1.amazonaws.com") {
				const action = new URLSearchParams(body).get("Action");
				if (action === "GetTopicAttributes")
					return new Response(
						"<GetTopicAttributesResponse><GetTopicAttributesResult><Attributes><entry><key>Policy</key><value>{&quot;Version&quot;:&quot;2008-10-17&quot;,&quot;Statement&quot;:[{&quot;Sid&quot;:&quot;__default_statement_ID&quot;}]}</value></entry></Attributes></GetTopicAttributesResult></GetTopicAttributesResponse>",
					);
				return new Response("<SetTopicAttributesResponse/>");
			}
			if (url.host === `${BUCKET}.s3.us-east-1.amazonaws.com`) {
				const key = url.pathname.slice(1);
				if (call.method === "GET") {
					const raw = objects.get(key);
					return raw === undefined
						? new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })
						: new Response(raw);
				}
				if (call.method === "DELETE") objects.delete(key);
				return new Response("");
			}
			return undefined;
		},
	});
	// MX lookups: each domain's, as given (none by default).
	const spy = vi.spyOn(globalThis, "fetch");
	const original = spy.getMockImplementation() as typeof fetch;
	spy.mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.host === "cloudflare-dns.com" && url.searchParams.get("type") === "MX") {
			const hosts = o.mx?.[url.searchParams.get("name") ?? ""] ?? [];
			return Response.json({
				Status: 0,
				Answer: hosts.map((h) => ({ type: 15, data: `10 ${h}.` })),
			});
		}
		return original(input, init);
	});
	return { ...fake, calls, objects };
}

const query = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));

const MESSAGE = (to: string, subject = "Booking question") =>
	[
		"From: Ana Guest <ana@guest.test>",
		`To: ${to}`,
		`Subject: ${subject}`,
		"Message-ID: <guest-1@guest.test>",
		"In-Reply-To: <0100-sent@email.amazonses.com>",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b1"',
		"",
		"--b1",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Is breakfast included?",
		"--b1",
		'Content-Type: application/pdf; name="itinerary.pdf"',
		'Content-Disposition: attachment; filename="itinerary.pdf"',
		"Content-Transfer-Encoding: base64",
		"",
		btoa("%PDF-1.4 fake"),
		"--b1--",
		"",
	].join("\r\n");

/** SES's notification for a message it stored in the drop box. */
function received(o: { to: string[]; key: string; sesId?: string; virus?: string; spam?: string }) {
	const sesId = o.sesId ?? `ses-${uid()}`;
	return {
		notificationType: "Received",
		mail: {
			messageId: sesId,
			timestamp: "2026-11-01T20:00:00.000Z",
			source: "ana@guest.test",
			destination: o.to,
			commonHeaders: {
				from: ["Ana Guest <ana@guest.test>"],
				to: o.to,
				subject: "Booking question",
			},
		},
		receipt: {
			timestamp: "2026-11-01T20:00:00.000Z",
			recipients: o.to,
			spamVerdict: { status: o.spam ?? "PASS" },
			virusVerdict: { status: o.virus ?? "PASS" },
			spfVerdict: { status: "PASS" },
			dkimVerdict: { status: "PASS" },
			dmarcVerdict: { status: "PASS" },
			action: { type: "S3", topicArn: TOPIC, bucketName: BUCKET, objectKey: o.key },
		},
	};
}

/** A brand with a domain that receives. */
async function receivingBrand() {
	await receivingReady();
	const org = await seedOrg();
	await db
		.update(schema.domains)
		.set({ receiving: true, receiving_status: "active", receiving_host: org.domain })
		.where(eq(schema.domains.id, org.domainId));
	return org;
}

const call = (key: string, path: string) =>
	handleApi(
		new Request(`https://mailroom.test/api${path}`, {
			headers: { authorization: `Bearer ${key}` },
		}),
	);

describe("receiving setup", () => {
	it("makes the drop box, lets SES publish, activates a rule set and adds the Mailroom address", async () => {
		clearSettingsCache();
		const fake = fakeAws();
		const status = await setUpReceiving();
		const s3 = fake.calls.filter((c) => c.url.host === `${BUCKET}.s3.us-east-1.amazonaws.com`);
		expect(s3.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual([
			"PUT /",
			"PUT /?policy",
			"PUT /?lifecycle",
		]);
		expect(s3[1]?.body).toContain('"Service":"ses.amazonaws.com"');
		expect(s3[2]?.headers.get("content-md5")).toBeTruthy();
		// S3 refuses a Content-MD5 that isn't signed.
		expect(s3[2]?.headers.get("authorization")).toMatch(/SignedHeaders=[^,]*content-md5/);
		const setPolicy = fake.calls.find(
			(c) => c.url.host.startsWith("sns.") && query(c).Action === "SetTopicAttributes",
		);
		const policy = JSON.parse(query(setPolicy as Call).AttributeValue ?? "{}");
		expect(policy.Statement.map((x: { Sid: string }) => x.Sid)).toEqual([
			"__default_statement_ID",
			"MailroomSesReceiving",
		]);
		const ses = fake.calls
			.filter((c) => c.url.host === "email.us-east-1.amazonaws.com" && c.url.pathname === "/")
			.map(query);
		expect(ses.map((q) => q.Action)).toEqual([
			"DescribeActiveReceiptRuleSet",
			"CreateReceiptRuleSet",
			"SetActiveReceiptRuleSet",
			"CreateReceiptRule",
		]);
		const rule = ses[3] ?? {};
		expect(rule["Rule.Recipients.member.1"]).toBe("in.mailroom.test");
		expect(rule["Rule.Actions.member.1.S3Action.BucketName"]).toBe(BUCKET);
		expect(rule["Rule.Actions.member.1.S3Action.TopicArn"]).toBe(TOPIC);
		expect(rule["Rule.ScanEnabled"]).toBe("true");
		expect(status.setUp).toBe(true);
		expect(status.records).toContainEqual({
			type: "MX",
			name: "in.mailroom.test",
			value: "inbound-smtp.us-east-1.amazonaws.com",
			priority: 10,
			// Nothing in DNS yet.
			status: "PENDING",
		});
		expect(status.records.filter((r) => r.type === "CNAME")).toHaveLength(3);
		expect(await getSetting("inbound_rule_set")).toBe("mailroom");
	});

	it("joins the rule set another app already made active", async () => {
		clearSettingsCache();
		const fake = fakeAws({ activeSet: "other-app" });
		await setUpReceiving();
		const ses = fake.calls
			.filter((c) => c.url.host === "email.us-east-1.amazonaws.com" && c.url.pathname === "/")
			.map(query);
		expect(ses.map((q) => q.Action)).toEqual([
			"DescribeActiveReceiptRuleSet",
			"CreateReceiptRule",
		]);
		expect(ses[1]?.RuleSetName).toBe("other-app");
		expect(await getSetting("inbound_rule_set")).toBe("other-app");
		await setSetting("inbound_rule_set", "mailroom");
	});

	it("keeps a topic policy's statements and adds SES once", () => {
		const policy = withSesPublish(
			JSON.stringify({ Version: "2008-10-17", Statement: [{ Sid: "theirs" }] }),
			TOPIC,
			ACCOUNT,
		);
		expect(JSON.parse(policy as string).Statement.map((x: { Sid: string }) => x.Sid)).toEqual([
			"theirs",
			"MailroomSesReceiving",
		]);
		expect(withSesPublish(policy, TOPIC, ACCOUNT)).toBeNull();
	});

	it("names rules after the domain, within SES's limits", () => {
		expect(ruleName("Mail.Harbor-Inn.com")).toBe("mailroom-mail.harbor-inn.com");
		expect(ruleName(`${"a".repeat(80)}.mx`)).toHaveLength(64);
	});
});

describe("a domain's receiving", () => {
	it("refuses a domain whose mail goes elsewhere, unless told to replace it", async () => {
		await receivingReady();
		const org = await seedOrg();
		const fake = fakeAws({ mx: { [org.domain]: ["aspmx.l.google.com"] } });
		await expect(
			setDomainReceiving(org.id, org.domainId, true, { prefix: "" }),
		).rejects.toMatchObject({ code: "domain_has_mx" });
		const d = await setDomainReceiving(org.id, org.domainId, true, {
			prefix: "",
			replaceMx: true,
		});
		expect(d.receiving).toBe(true);
		expect(d.receiving_host).toBe(org.domain);
		expect(d.receiving_status).toBe("pending");
		const rule = fake.calls.map(query).find((q) => q.Action === "CreateReceiptRule");
		expect(rule?.["Rule.Recipients.member.1"]).toBe(org.domain);
		expect(rule?.RuleSetName).toBe("mailroom");
	});

	it("receives at the domain itself by default, or at a subdomain when given one", async () => {
		await receivingReady();
		const org = await seedOrg();
		fakeAws();
		const d = await setDomainReceiving(org.id, org.domainId, true);
		expect(d.receiving_host).toBe(org.domain);
		const fake = fakeAws();
		const moved = await setDomainReceiving(org.id, org.domainId, true, { prefix: "inbox" });
		expect(moved.receiving_host).toBe(`inbox.${org.domain}`);
		const queries = fake.calls.map(query);
		expect(
			queries.find((q) => q.Action === "CreateReceiptRule")?.["Rule.Recipients.member.1"],
		).toBe(`inbox.${org.domain}`);
		expect(queries.find((q) => q.Action === "DeleteReceiptRule")?.RuleName).toBe(
			ruleName(org.domain),
		);
		await expect(
			setDomainReceiving(org.id, org.domainId, true, { prefix: "two words" }),
		).rejects.toMatchObject({ status: 422 });
	});

	it("adds a receive-only domain: no MAIL FROM or DMARC, and nothing sends from it", async () => {
		await receivingReady();
		const org = await seedOrg();
		const name = `in-${uid()}.test`;
		fakeAws();
		const d = await addDomain(org.id, name, "transactional", {
			sending: false,
			receiving: true,
		});
		expect(d.sending).toBe(false);
		expect(d.receiving).toBe(true);
		expect(d.receiving_host).toBe(name);
		expect(d.mail_from).toBeNull();
		expect(dnsRecords(d).map((r) => r.record)).toEqual(["DKIM", "DKIM", "DKIM", "Receiving"]);
		const ctx = await orgContext(org.id);
		expect(ctx.domains.map((x) => x.name)).not.toContain(name);

		// The last role stays on: it's removed instead.
		await expect(setDomainReceiving(org.id, d.id, false)).rejects.toMatchObject({
			status: 422,
		});
		await expect(
			addDomain(org.id, `none-${uid()}.test`, "transactional", { sending: false }),
		).rejects.toMatchObject({ status: 422 });

		// Turning sending on gives it a MAIL FROM, and then it can send.
		fakeAws();
		const sends = await setDomainSending(org.id, d.id, true);
		expect(sends.sending).toBe(true);
		expect(sends.mail_from).toBe(`bounce.${name}`);
		forgetOrg(org.id);
		expect((await orgContext(org.id)).domains.map((x) => x.name)).toContain(name);
		await expect(setDomainSending(org.id, org.domainId, false)).rejects.toMatchObject({
			status: 422,
		});
	});

	it("shows the MX in the domain's records and goes active once it points at SES", async () => {
		await receivingReady();
		const org = await seedOrg();
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		fakeAws();
		await setDomainReceiving(org.id, org.domainId, true, { prefix: "reply" });
		const view = (await (await call(token, `/domains/${org.domainId}`)).json()) as {
			receiving: { host: string; status: string };
			records: {
				record: string;
				name: string;
				type: string;
				value: string;
				status: string;
			}[];
		};
		expect(view.receiving).toEqual({ host: `reply.${org.domain}`, status: "pending" });
		expect(view.records).toContainEqual(
			expect.objectContaining({
				record: "Receiving",
				name: `reply.${org.domain}`,
				type: "MX",
				value: "inbound-smtp.us-east-1.amazonaws.com",
				status: "pending",
			}),
		);
		fakeAws({ mx: { [`reply.${org.domain}`]: ["inbound-smtp.us-east-1.amazonaws.com"] } });
		await checkPendingReceiving(100);
		const d = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		expect(d?.receiving_status).toBe("active");
	});

	it("deletes the rule when receiving is turned off", async () => {
		const org = await receivingBrand();
		const fake = fakeAws();
		const d = await setDomainReceiving(org.id, org.domainId, false);
		expect(d.receiving).toBe(false);
		const q = fake.calls.map(query).find((x) => x.Action === "DeleteReceiptRule");
		expect(q?.RuleName).toBe(ruleName(org.domain));
	});

	it("refuses before receiving is set up", async () => {
		clearSettingsCache();
		await db.delete(schema.appSettings).where(eq(schema.appSettings.key, "inbound_bucket"));
		clearSettingsCache();
		const org = await seedOrg();
		fakeAws();
		await expect(setDomainReceiving(org.id, org.domainId, true)).rejects.toMatchObject({
			code: "receiving_not_set_up",
		});
		await receivingReady();
	});
});

describe("arrival", () => {
	it("moves the message to R2, records it and tells the webhooks", async () => {
		const org = await receivingBrand();
		const hook = await createWebhook(org.id, {
			url: "https://app.test/hook",
			events: ["email.received"],
		});
		const key = `inbound/${uid()}`;
		const to = `reservas@${org.domain}`;
		const fake = fakeAws({ objects: new Map([[key, MESSAGE(to)]]) });
		const result = await handleSns(await snsNotification(received({ to: [to], key })));
		expect(result).toBe("applied");
		const row = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id))
			.get();
		expect(row).toMatchObject({
			from: "Ana Guest <ana@guest.test>",
			to: [to],
			subject: "Booking question",
			message_id: "<guest-1@guest.test>",
			in_reply_to: "<0100-sent@email.amazonses.com>",
			domain_id: org.domainId,
			spam: "PASS",
		});
		expect(row?.attachments).toEqual([
			expect.objectContaining({
				id: "att_1",
				filename: "itinerary.pdf",
				content_type: "application/pdf",
			}),
		]);
		// Out of the drop box, into R2.
		expect(fake.objects.has(key)).toBe(false);
		expect(await (await store().get(row?.object_key as string))?.text()).toContain(
			"Is breakfast included?",
		);
		const [delivery] = await db
			.select()
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.webhook_id, hook.id));
		const payload = JSON.parse(delivery?.payload ?? "{}");
		expect(payload.type).toBe("email.received");
		expect(payload.data).toMatchObject({
			email_id: row?.id,
			from: "Ana Guest <ana@guest.test>",
			to: [to],
			subject: "Booking question",
			message_id: "<guest-1@guest.test>",
			brand_id: org.id,
			attachments: [{ id: "att_1", filename: "itinerary.pdf" }],
		});
		expect(payload.data.html).toBeUndefined();
	});

	it("records a message SNS delivers twice once", async () => {
		const org = await receivingBrand();
		const key = `inbound/${uid()}`;
		const to = `hola@${org.domain}`;
		const objects = new Map([[key, MESSAGE(to)]]);
		fakeAws({ objects });
		const event = received({ to: [to], key });
		expect(await handleSns(await snsNotification(event))).toBe("applied");
		objects.set(key, MESSAGE(to));
		expect(await handleSns(await snsNotification(event))).toBe("duplicate");
		const rows = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(rows).toHaveLength(1);
		expect(objects.has(key)).toBe(false);
	});

	it("drops viruses and mail to nobody's address, and keeps spam marked", async () => {
		const org = await receivingBrand();
		const objects = new Map<string, string>();
		fakeAws({ objects });
		const virus = `inbound/${uid()}`;
		objects.set(virus, MESSAGE(`a@${org.domain}`));
		expect(
			await handleSns(
				await snsNotification(
					received({ to: [`a@${org.domain}`], key: virus, virus: "FAIL" }),
				),
			),
		).toBe("ignored");
		const nobody = `inbound/${uid()}`;
		objects.set(nobody, MESSAGE("a@nobody.test"));
		expect(
			await handleSns(
				await snsNotification(received({ to: ["a@nobody.test"], key: nobody })),
			),
		).toBe("ignored");
		expect(objects.size).toBe(0);
		const spam = `inbound/${uid()}`;
		objects.set(spam, MESSAGE(`a@${org.domain}`));
		await handleSns(
			await snsNotification(received({ to: [`a@${org.domain}`], key: spam, spam: "FAIL" })),
		);
		const rows = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(rows.map((r) => r.spam)).toEqual(["FAIL"]);
	});

	it("finds brands by their Mailroom address, with or without +tag", async () => {
		const org = await seedOrg();
		const owners = await ownersOf([
			`${org.slug}@in.mailroom.test`,
			`${org.slug}+support@IN.mailroom.test`,
			"someone-else@in.mailroom.test",
		]);
		expect(owners).toEqual([
			{
				brandId: org.id,
				domainId: null,
				recipients: [
					`${org.slug}@in.mailroom.test`,
					`${org.slug}+support@in.mailroom.test`,
				],
			},
		]);
	});

	it("gives a brand its own inbound address on a receiving domain, the default as fallback", async () => {
		await receivingReady();
		const org = await seedOrg();
		const fallback = `${org.slug}@in.mailroom.test`;
		expect(await mailroomAddress(org.id)).toBe(fallback);
		// Not until one of its domains receives, and only there.
		await expect(setInboundAddress(org.id, `inbox@${org.domain}`)).rejects.toMatchObject({
			status: 422,
		});
		fakeAws();
		await setDomainReceiving(org.id, org.domainId, true, { prefix: "reply" });
		const host = `reply.${org.domain}`;
		await expect(setInboundAddress(org.id, "inbox@elsewhere.test")).rejects.toMatchObject({
			status: 422,
		});
		await expect(setInboundAddress(org.id, `in box@${host}`)).rejects.toMatchObject({
			status: 422,
		});
		const set = await setInboundAddress(org.id, `Inbox@${host}`);
		expect(set).toMatchObject({ own: `inbox@${host}`, fallback, picked: `inbox@${host}` });
		expect(await mailroomAddress(org.id)).toBe(`inbox@${host}`);
		// Both reach the brand.
		const owners = await ownersOf([`inbox@${host}`, fallback]);
		expect(owners.map((o) => o.brandId)).toEqual([org.id, org.id]);
		// Its domain stops receiving: the default again, the pick kept for later.
		fakeAws();
		await setDomainReceiving(org.id, org.domainId, false);
		expect(await inboundAddresses(org.id)).toMatchObject({
			own: null,
			picked: `inbox@${host}`,
		});
		expect(await mailroomAddress(org.id)).toBe(fallback);
		expect((await setInboundAddress(org.id, null)).picked).toBeNull();
	});

	it("leaves the message in S3 for SNS to try again when S3 fails", async () => {
		const org = await receivingBrand();
		fakeAws();
		const result = await handleSns(
			await snsNotification(received({ to: [`a@${org.domain}`], key: "inbound/missing" })),
		);
		expect(result).toBe("retry");
	});
});

describe("reading", () => {
	async function oneReceived() {
		const org = await receivingBrand();
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		const key = `inbound/${uid()}`;
		const to = `reservas@${org.domain}`;
		fakeAws({ objects: new Map([[key, MESSAGE(to, `Hola ${uid()}`)]]) });
		await handleSns(await snsNotification(received({ to: [to], key })));
		const row = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id))
			.get();
		return { org, token, row: row as typeof schema.receivedEmails.$inferSelect };
	}

	it("lists and shows received emails in Resend's shape", async () => {
		const { token, row } = await oneReceived();
		const list = (await (await call(token, "/emails/receiving")).json()) as {
			object: string;
			data: { id: string; html?: string }[];
		};
		expect(list.object).toBe("list");
		expect(list.data.map((d) => d.id)).toEqual([row.id]);
		expect(list.data[0]?.html).toBeUndefined();
		const one = (await (await call(token, `/emails/receiving/${row.id}`)).json()) as Record<
			string,
			unknown
		>;
		expect(one).toMatchObject({
			object: "email",
			id: row.id,
			text: expect.stringContaining("Is breakfast included?"),
			verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
		});
		expect((one.headers as Record<string, string>)["message-id"]).toBe("<guest-1@guest.test>");
	});

	it("doesn't show another organization's received emails", async () => {
		const { row } = await oneReceived();
		const other = await seedOrg();
		const { token } = await createKey({
			organizationId: other.id,
			name: "t",
			permission: "full",
		});
		expect((await call(token, `/emails/receiving/${row.id}`)).status).toBe(404);
	});

	it("gives signed links that download each attachment, for an hour", async () => {
		const { token, row } = await oneReceived();
		const list = (await (
			await call(token, `/emails/receiving/${row.id}/attachments`)
		).json()) as {
			data: { id: string; filename: string; download_url: string; expires_at: string }[];
		};
		const [a] = list.data;
		expect(a).toMatchObject({ id: "att_1", filename: "itinerary.pdf" });
		const path = new URL(a?.download_url as string).pathname;
		const res = await serveAttachment(path);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("itinerary.pdf");
		expect(await res.text()).toBe("%PDF-1.4 fake");
		expect((await serveAttachment(`${path.slice(0, -2)}xx`)).status).toBe(404);
		expect((await serveAttachment(path, Date.now() + 2 * 3600_000)).status).toBe(404);
		const single = await call(token, `/emails/receiving/${row.id}/attachments/att_1`);
		expect(single.status).toBe(200);
		expect((await call(token, `/emails/receiving/${row.id}/attachments/att_9`)).status).toBe(
			404,
		);
	});

	it("purges what's past its retention, rows and messages", async () => {
		const { row } = await oneReceived();
		await setArchiveEnabled(await orgOf(row.organization_id), true);
		await purgeReceived(Date.parse(row.created_at) + 31 * 86_400_000);
		const left = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.id, row.id))
			.get();
		expect(left).toBeUndefined();
		expect(await store().get(row.object_key)).toBeNull();
		const kept = await store().get(
			`archive/${row.organization_id}/received/${row.created_at.slice(0, 10)}/${row.id}.eml`,
		);
		expect(await kept?.text()).toContain("Hola");
	});

	it("reports the deployment's receiving", async () => {
		await receivingReady();
		fakeAws();
		const status = await receivingStatus();
		expect(status).toMatchObject({ setUp: true, storage: true, domain: "in.mailroom.test" });
	});
});

describe("inbound rules and replies", () => {
	const api = async (key: string, method: string, path: string, body?: unknown) => {
		const res = await handleApi(
			new Request(`https://mailroom.test/api${path}`, {
				method,
				headers: {
					authorization: `Bearer ${key}`,
					...(body ? { "content-type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			}),
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	it("matches addresses, domains, local parts with +tags, senders and subjects", () => {
		const r = (match_to: string, extra = {}) => ({
			match_to,
			match_from: null,
			match_subject: null,
			enabled: true,
			...extra,
		});
		const m = { to: "Support+vip@Hotel.test", from: "Ana <ana@guest.test>", subject: "Hi" };
		expect(matches(r("*"), m)).toBe(true);
		expect(matches(r("*@hotel.test"), m)).toBe(true);
		expect(matches(r("support@*"), m)).toBe(true);
		expect(matches(r("support@hotel.test"), m)).toBe(true);
		expect(matches(r("sales@hotel.test"), m)).toBe(false);
		expect(matches(r("*", { match_from: "guest.test" }), m)).toBe(true);
		expect(matches(r("*", { match_subject: "invoice" }), m)).toBe(false);
		expect(matches(r("*", { enabled: false }), m)).toBe(false);
	});

	it("forwards a copy from the address it came to, and links an answer to the email it answers", async () => {
		const org = await receivingBrand();
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		const bad = await api(token, "POST", "/inbound-rules", {
			name: "No addresses",
			action: "forward",
		});
		expect(bad.status).toBe(422);
		const rule = await api(token, "POST", "/inbound-rules", {
			name: "Bookings to the front desk",
			match_to: `reservas@${org.domain}`,
			action: "forward",
			forward_to: "desk@staff.test, manager@staff.test",
		});
		expect(rule.status).toBe(201);
		const sentId = crypto.randomUUID();
		await db.insert(schema.emails).values({
			id: sentId,
			organization_id: org.id,
			from: `reservas@${org.domain}`,
			to: ["ana@guest.test"],
			subject: "Your booking",
			status: "sent",
			message_id: "0100-sent",
			created_at: new Date().toISOString(),
		});

		const key = `inbound/${uid()}`;
		const to = `reservas@${org.domain}`;
		fakeAws({ objects: new Map([[key, MESSAGE(to)]]) });
		expect(await handleSns(await snsNotification(received({ to: [to], key })))).toBe("applied");
		const row = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id))
			.get();
		expect(row?.answers_email_id).toBe(sentId);
		expect(row?.actions).toEqual(["Forwarded to desk@staff.test, manager@staff.test"]);

		const copy = await db
			.select()
			.from(schema.emails)
			.where(eq(schema.emails.organization_id, org.id))
			.then((rows) => rows.find((e) => e.id !== sentId));
		expect(copy).toMatchObject({
			from: `"Ana Guest via Mailroom" <${to}>`,
			to: ["desk@staff.test", "manager@staff.test"],
			reply_to: ["Ana Guest <ana@guest.test>"],
			subject: "Booking question",
			source: "system",
		});
		const stored = await storedContent(copy?.id as string);
		expect(stored?.content.text).toContain("Is breakfast included?");
		expect(stored?.content.headers).toMatchObject({ "X-Mailroom-Forwarded": row?.id });
		expect(stored?.attachments[0]?.filename).toBe("itinerary.pdf");

		const view = await api(token, "GET", `/emails/receiving/${row?.id}`);
		expect(view.body).toMatchObject({ in_reply_to_email_id: sentId });
	});

	it("drops what a drop rule takes: nothing kept, nothing sent to webhooks", async () => {
		const org = await receivingBrand();
		const { token } = await createKey({
			organizationId: org.id,
			name: "t",
			permission: "full",
		});
		await api(token, "POST", "/inbound-rules", {
			name: "Auto-replies",
			match_subject: "out of office",
			action: "drop",
		});
		const key = `inbound/${uid()}`;
		const to = `hola@${org.domain}`;
		const fake = fakeAws({
			objects: new Map([[key, MESSAGE(to, "Out of office: back Monday")]]),
		});
		const n = received({ to: [to], key });
		n.mail.commonHeaders.subject = "Out of office: back Monday";
		expect(await handleSns(await snsNotification(n))).toBe("applied");
		const rows = await db
			.select()
			.from(schema.receivedEmails)
			.where(eq(schema.receivedEmails.organization_id, org.id));
		expect(rows).toHaveLength(0);
		expect(fake.objects.has(key)).toBe(false);
	});
});
