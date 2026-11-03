import { type Credentials, signV4 } from "./sigv4";

/**
 * Amazon SES API v2, signed by hand: sending, identities (domains and DKIM), tenants (one per
 * organization), configuration sets and their SNS event destination, the account's quota and a
 * tenant's reputation status.
 */

export interface AwsConfig {
	region: string;
	credentials: Credentials;
	fetcher?: typeof fetch;
}

/** SES answered with an error. */
export class SesError extends Error {
	constructor(
		readonly status: number,
		readonly type: string,
		message: string,
	) {
		super(message || type || `SES ${status}`);
		this.name = "SesError";
	}

	/**
	 * AWS refused the keys themselves (deactivated, deleted, wrong secret) or what they may do:
	 * nothing will send until someone fixes them, so emails wait rather than fail.
	 */
	get credentials() {
		return (
			(this.status === 403 || this.status === 400) &&
			/UnrecognizedClient|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|AccessDenied|MissingAuthenticationToken|InvalidSignature|NotAuthorized/.test(
				this.type,
			)
		);
	}

	/**
	 * A refusal of the account or a passing one (throttling, a pause, the day's quota, AWS
	 * itself): the message may go later. Anything else is about this message.
	 */
	get transient() {
		return (
			this.status >= 500 ||
			this.status === 429 ||
			/TooManyRequests|Throttl|SendingPaused|LimitExceeded|ServiceUnavailable|InternalFailure/.test(
				this.type,
			)
		);
	}
}

/** Waits for throttled calls (the account's rate per second), with jitter. */
const THROTTLE_WAITS_MS = [300, 1000, 2500];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sesCall<T = Record<string, unknown>>(
	aws: AwsConfig,
	method: "GET" | "POST" | "PUT" | "DELETE",
	path: string,
	body?: unknown,
): Promise<T> {
	const url = new URL(`https://email.${aws.region}.amazonaws.com${path}`);
	const payload = body === undefined ? "" : JSON.stringify(body);
	const doFetch = aws.fetcher ?? fetch;
	for (let attempt = 0; ; attempt++) {
		const headers = await signV4({
			method,
			url,
			body: payload,
			region: aws.region,
			service: "ses",
			credentials: aws.credentials,
		});
		const res = await doFetch(url, {
			method,
			headers,
			body: payload || undefined,
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		if (res.ok) return (text ? JSON.parse(text) : {}) as T;
		let message = text;
		try {
			const parsed = JSON.parse(text) as { message?: string; Message?: string };
			message = parsed.message ?? parsed.Message ?? text;
		} catch {}
		const type = (res.headers.get("x-amzn-errortype") ?? "").split(":")[0] ?? "";
		const wait = THROTTLE_WAITS_MS[attempt];
		// The rate per second: wait and go again. The day's quota: no use waiting.
		if (
			(res.status === 429 || type === "TooManyRequestsException") &&
			!/daily|24 hour/i.test(message) &&
			wait !== undefined
		) {
			await sleep(wait + Math.random() * 200);
			continue;
		}
		throw new SesError(res.status, type, message);
	}
}

const enc = encodeURIComponent;

// ── Sending ────────────────────────────────────────────────────────────────

export interface RawSend {
	/** The whole message, base64. */
	raw: string;
	/**
	 * The From with its display name, as the message's From header has it ("Name" <a@b>). SES
	 * writes this over the raw message's From, so a bare address here loses the sender's name
	 * (the inbox then shows the address's local part, «hola»).
	 */
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	configurationSet?: string | null;
	tenant?: string | null;
	tags?: { name: string; value: string }[];
}

/** Sends one raw message; SES's message id. */
export async function sendRaw(aws: AwsConfig, m: RawSend): Promise<string> {
	const res = await sesCall<{ MessageId?: string }>(aws, "POST", "/v2/email/outbound-emails", {
		FromEmailAddress: m.from,
		Destination: {
			ToAddresses: m.to,
			...(m.cc?.length ? { CcAddresses: m.cc } : {}),
			...(m.bcc?.length ? { BccAddresses: m.bcc } : {}),
		},
		Content: { Raw: { Data: m.raw } },
		...(m.configurationSet ? { ConfigurationSetName: m.configurationSet } : {}),
		...(m.tenant ? { TenantName: m.tenant } : {}),
		...(m.tags?.length
			? { EmailTags: m.tags.map((t) => ({ Name: t.name, Value: t.value })) }
			: {}),
	});
	if (!res.MessageId) throw new SesError(500, "NoMessageId", "SES returned no message id");
	return res.MessageId;
}

// ── Account ────────────────────────────────────────────────────────────────

export interface SesAccount {
	ProductionAccessEnabled?: boolean;
	SendingEnabled?: boolean;
	EnforcementStatus?: string;
	SendQuota?: { Max24HourSend?: number; MaxSendRate?: number; SentLast24Hours?: number };
}

export const getAccount = (aws: AwsConfig) => sesCall<SesAccount>(aws, "GET", "/v2/email/account");

// ── Identities (domains) ───────────────────────────────────────────────────

export interface Identity {
	IdentityType?: string;
	VerifiedForSendingStatus?: boolean;
	VerificationStatus?: "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE" | "NOT_STARTED";
	DkimAttributes?: {
		Status?: string;
		Tokens?: string[];
		SigningEnabled?: boolean;
	};
	MailFromAttributes?: {
		MailFromDomain?: string;
		MailFromDomainStatus?: "PENDING" | "SUCCESS" | "FAILED" | "TEMPORARY_FAILURE";
		BehaviorOnMxFailure?: string;
	};
	ConfigurationSetName?: string;
}

export const createIdentity = (aws: AwsConfig, domain: string, configurationSet?: string) =>
	sesCall<{ VerifiedForSendingStatus?: boolean; DkimAttributes?: Identity["DkimAttributes"] }>(
		aws,
		"POST",
		"/v2/email/identities",
		{
			EmailIdentity: domain,
			...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
		},
	);

export const getIdentity = (aws: AwsConfig, domain: string) =>
	sesCall<Identity>(aws, "GET", `/v2/email/identities/${enc(domain)}`);

export const deleteIdentity = (aws: AwsConfig, domain: string) =>
	sesCall(aws, "DELETE", `/v2/email/identities/${enc(domain)}`);

/** A custom MAIL FROM (bounce.example.com): SPF aligns with the domain, for DMARC. */
export const putMailFrom = (aws: AwsConfig, domain: string, mailFrom: string) =>
	sesCall(aws, "PUT", `/v2/email/identities/${enc(domain)}/mail-from`, {
		MailFromDomain: mailFrom,
		BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
	});

// ── Configuration sets ─────────────────────────────────────────────────────

/** Every event SES can publish; the platform listens to all of them. */
export const SES_EVENT_TYPES = [
	"SEND",
	"REJECT",
	"BOUNCE",
	"COMPLAINT",
	"DELIVERY",
	"OPEN",
	"CLICK",
	"RENDERING_FAILURE",
	"DELIVERY_DELAY",
	"SUBSCRIPTION",
] as const;

/**
 * What Mailroom asks SES for: everything but opens and clicks, which it tracks itself on the
 * domain's own host (src/server/tracking.ts). SES would otherwise rewrite every link to its
 * shared awstrack.me domain.
 */
export const MAILROOM_EVENT_TYPES = SES_EVENT_TYPES.filter((t) => t !== "OPEN" && t !== "CLICK");

export const createConfigurationSet = (
	aws: AwsConfig,
	name: string,
	o: { tags?: { Key: string; Value: string }[] } = {},
) =>
	sesCall(aws, "POST", "/v2/email/configuration-sets", {
		ConfigurationSetName: name,
		ReputationOptions: { ReputationMetricsEnabled: true },
		SendingOptions: { SendingEnabled: true },
		// Bounces and complaints are also kept off by SES's own list, account-wide.
		SuppressionOptions: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
		...(o.tags?.length ? { Tags: o.tags } : {}),
	});

export const deleteConfigurationSet = (aws: AwsConfig, name: string) =>
	sesCall(aws, "DELETE", `/v2/email/configuration-sets/${enc(name)}`);

export const createSnsDestination = (aws: AwsConfig, configurationSet: string, topicArn: string) =>
	sesCall(
		aws,
		"POST",
		`/v2/email/configuration-sets/${enc(configurationSet)}/event-destinations`,
		{
			EventDestinationName: "mailroom",
			EventDestination: {
				Enabled: true,
				MatchingEventTypes: MAILROOM_EVENT_TYPES,
				SnsDestination: { TopicArn: topicArn },
			},
		},
	);

/** Sets the destination's events to MAILROOM_EVENT_TYPES (sets made before it tracked). */
export const updateSnsDestination = (aws: AwsConfig, configurationSet: string, topicArn: string) =>
	sesCall(
		aws,
		"PUT",
		`/v2/email/configuration-sets/${enc(configurationSet)}/event-destinations/mailroom`,
		{
			EventDestination: {
				Enabled: true,
				MatchingEventTypes: MAILROOM_EVENT_TYPES,
				SnsDestination: { TopicArn: topicArn },
			},
		},
	);

// ── Tenants ────────────────────────────────────────────────────────────────

export interface Tenant {
	TenantName?: string;
	TenantId?: string;
	TenantArn?: string;
	SendingStatus?: "ENABLED" | "REINSTATED" | "DISABLED";
}

export const createTenant = (aws: AwsConfig, name: string) =>
	sesCall<Tenant>(aws, "POST", "/v2/email/tenants", { TenantName: name });

export const getTenant = (aws: AwsConfig, name: string) =>
	sesCall<{ Tenant?: Tenant }>(aws, "POST", "/v2/email/tenants/get", { TenantName: name });

export const deleteTenant = (aws: AwsConfig, name: string) =>
	sesCall(aws, "POST", "/v2/email/tenants/delete", { TenantName: name });

export const associateWithTenant = (aws: AwsConfig, tenant: string, resourceArn: string) =>
	sesCall(aws, "POST", "/v2/email/tenants/resources", {
		TenantName: tenant,
		ResourceArn: resourceArn,
	});

export const disassociateFromTenant = (aws: AwsConfig, tenant: string, resourceArn: string) =>
	sesCall(aws, "POST", "/v2/email/tenants/resources/delete", {
		TenantName: tenant,
		ResourceArn: resourceArn,
	});

export interface ReputationEntity {
	SendingStatusAggregate?: string;
	ReputationImpact?: string;
	ReputationManagementPolicy?: string;
	CustomerManagedStatus?: { SendingStatus?: string };
	AwsSesManagedStatus?: { SendingStatus?: string; Cause?: string };
}

/** A tenant's sending status (SES pauses a tenant on its own when its reputation drops). */
export const getTenantReputation = (aws: AwsConfig, tenantArn: string) =>
	sesCall<{ ReputationEntity?: ReputationEntity }>(
		aws,
		"GET",
		`/v2/email/reputation/entities/RESOURCE/${enc(tenantArn)}`,
	);

// ── Account suppression list ───────────────────────────────────────────────

/** Takes an address off SES's own (account-wide) suppression list; missing is fine. */
export async function unsuppressAtSes(aws: AwsConfig, address: string) {
	try {
		await sesCall(aws, "DELETE", `/v2/email/suppression/addresses/${enc(address)}`);
	} catch (error) {
		if (!(error instanceof SesError && error.status === 404)) throw error;
	}
}

export const arn = (region: string, account: string, kind: string, name: string) =>
	`arn:aws:ses:${region}:${account}:${kind}/${name}`;
