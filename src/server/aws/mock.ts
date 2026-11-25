/**
 * AWS_MOCK=1: a stand-in for Amazon SES, SNS, STS, IAM, S3 and Cost Explorer, so the whole app
 * runs locally with no AWS account. Every call succeeds as if the account were set up and out of
 * the sandbox; domains verify at once. A sent email gets its SES events shortly after, the way SNS
 * would post them:
 *
 *   bounce@…     → hard Bounce        complaint@… → Delivery, then Complaint
 *   ooto@…       → soft Bounce        anything else → Delivery
 *
 * (the local parts SES's own mailbox simulator uses, so a test list means the same thing on the
 * real thing at success@simulator.amazonses.com). Only allowed for local URLs (env.ts).
 */

type ApplyEvent = (event: Record<string, unknown>, eventId: string) => Promise<unknown>;

let seq = 0;
const id = () => `mock-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const xml = (action: string, inner: string) =>
	new Response(
		`<${action}Response><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>${id()}</RequestId></ResponseMetadata></${action}Response>`,
		{ headers: { "content-type": "text/xml" } },
	);

const ACCOUNT = "000000000000";

/** What SES v2 would answer, by path. */
function ses(method: string, path: string, body: Record<string, unknown>): unknown {
	if (path === "/v2/email/account")
		return {
			ProductionAccessEnabled: true,
			SendingEnabled: true,
			EnforcementStatus: "HEALTHY",
			SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 0 },
		};
	const identity = /^\/v2\/email\/identities\/([^/]+)$/.exec(path);
	if (identity && method === "GET") {
		const domain = decodeURIComponent(identity[1] ?? "");
		return {
			IdentityType: "DOMAIN",
			VerifiedForSendingStatus: true,
			VerificationStatus: "SUCCESS",
			DkimAttributes: {
				Status: "SUCCESS",
				SigningEnabled: true,
				Tokens: ["mock1", "mock2", "mock3"].map((t) => `${t}${domain.replace(/\W/g, "")}`),
			},
			MailFromAttributes: {
				MailFromDomain: `mail.${domain}`,
				MailFromDomainStatus: "SUCCESS",
				BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
			},
		};
	}
	if (path === "/v2/email/identities" && method === "POST")
		return {
			VerifiedForSendingStatus: true,
			DkimAttributes: {
				Status: "SUCCESS",
				SigningEnabled: true,
				Tokens: ["mock1", "mock2", "mock3"],
			},
		};
	if (path === "/v2/email/tenants" || path === "/v2/email/tenants/get") {
		const name = String(body.TenantName ?? "tenant");
		const tenant = {
			TenantName: name,
			TenantId: `tn-${name}`,
			TenantArn: `arn:aws:ses:us-east-1:${ACCOUNT}:tenant/${name}`,
			SendingStatus: "ENABLED",
		};
		return path.endsWith("/get") ? { Tenant: tenant } : tenant;
	}
	if (path.startsWith("/v2/email/reputation"))
		return {
			ReputationEntity: {
				SendingStatusAggregate: "ENABLED",
				AwsSesManagedStatus: { SendingStatus: "ENABLED" },
				CustomerManagedStatus: { SendingStatus: "ENABLED" },
			},
		};
	return {};
}

/** The events SES would publish for one recipient. */
function eventsFor(to: string, mail: Record<string, unknown>) {
	const local = to.split("@")[0]?.toLowerCase().split("+")[0] ?? "";
	const ts = new Date().toISOString();
	const recipient = { emailAddress: to };
	if (local === "bounce")
		return [
			{
				eventType: "Bounce",
				mail,
				bounce: {
					bounceType: "Permanent",
					bounceSubType: "General",
					bouncedRecipients: [
						{ ...recipient, diagnosticCode: "smtp; 550 5.1.1 user unknown" },
					],
					timestamp: ts,
				},
			},
		];
	if (local === "ooto")
		return [
			{
				eventType: "Bounce",
				mail,
				bounce: {
					bounceType: "Transient",
					bounceSubType: "General",
					bouncedRecipients: [recipient],
					timestamp: ts,
				},
			},
		];
	const delivery = {
		eventType: "Delivery",
		mail,
		delivery: {
			recipients: [to],
			timestamp: ts,
			processingTimeMillis: 400,
			smtpResponse: "250 ok",
		},
	};
	if (local === "complaint")
		return [
			delivery,
			{
				eventType: "Complaint",
				mail,
				complaint: {
					complainedRecipients: [recipient],
					complaintFeedbackType: "abuse",
					timestamp: ts,
				},
			},
		];
	return [delivery];
}

export function mockAwsFetch(
	apply: ApplyEvent,
	delayMs = 1500,
	keep: (p: Promise<unknown>) => void = () => {},
): typeof fetch {
	return async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		// S3 bucket calls (inbound receiving drop box).
		if (/\.s3\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname)) {
			return new Response("", { status: 200 });
		}
		// Cost Explorer (JSON 1.1 API).
		if (/^ce\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname)) {
			return Response.json({
				ResultsByTime: [],
				Total: { Amount: "0", Unit: "USD" },
			});
		}
		const text =
			request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
		// Query APIs (SNS, STS, IAM, SES v1): form bodies, XML answers.
		if (text && /^Action=|&Action=/.test(text)) {
			const p = new URLSearchParams(text);
			const action = p.get("Action") ?? "";
			if (action === "GetCallerIdentity") return xml(action, `<Account>${ACCOUNT}</Account>`);
			if (action === "CreateTopic")
				return xml(
					action,
					`<TopicArn>arn:aws:sns:us-east-1:${ACCOUNT}:${p.get("Name")}</TopicArn>`,
				);
			if (action === "Subscribe")
				return xml(action, "<SubscriptionArn>pending confirmation</SubscriptionArn>");
			if (action === "CreateAccessKey")
				return xml(
					action,
					`<AccessKey><AccessKeyId>AKIAMOCK${seq}</AccessKeyId><SecretAccessKey>mock</SecretAccessKey></AccessKey>`,
				);
			if (action === "DescribeActiveReceiptRuleSet")
				return xml(action, "<Metadata><Name>mailroom</Name></Metadata>");
			return xml(action, "");
		}
		const body = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
		if (url.pathname === "/v2/email/outbound-emails") {
			const messageId = `0100-${id()}`;
			const dest = (body.Destination ?? {}) as Record<string, string[] | undefined>;
			const to = [
				...(dest.ToAddresses ?? []),
				...(dest.CcAddresses ?? []),
				...(dest.BccAddresses ?? []),
			];
			const tags: Record<string, string[]> = {};
			for (const t of (body.EmailTags ?? []) as { Name: string; Value: string }[])
				tags[t.Name] = [t.Value];
			const mail = { messageId, timestamp: new Date().toISOString(), destination: to, tags };
			console.log(`[aws-mock] sent ${messageId} to ${to.join(", ")}`);
			// After the caller has stored the message id, the way SNS arrives a moment later.
			const later = new Promise<void>((done) => setTimeout(done, delayMs)).then(() =>
				Promise.all(
					to.flatMap((r) =>
						eventsFor(r, mail).map((e, i) =>
							apply(e, `${messageId}-${i}-${r}`).catch((err) =>
								console.error("[aws-mock] event not applied", err),
							),
						),
					),
				),
			);
			// A Worker drops a timer once its request ends; `keep` is waitUntil there.
			keep(later);
			return Response.json({ MessageId: messageId });
		}
		return Response.json(ses(request.method, url.pathname, body));
	};
}
