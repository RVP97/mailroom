import type { AwsConfig } from "./ses";
import { signV4 } from "./sigv4";

/**
 * SNS: the topic SES publishes its events to, and the messages SNS posts to /webhooks/ses. Every
 * message is checked against SNS's signature (its certificate, only from sns.<region>.
 * amazonaws.com over HTTPS) before anything is done with it.
 */

export interface SnsMessage {
	Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation" | string;
	MessageId: string;
	TopicArn: string;
	Subject?: string;
	Message: string;
	Timestamp: string;
	SignatureVersion: string;
	Signature: string;
	SigningCertURL: string;
	SubscribeURL?: string;
	Token?: string;
}

/** SNS signs only from its own regional hosts, over HTTPS. */
export function trustedSnsUrl(raw: string | undefined): URL | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === "https:" &&
			/^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(url.hostname)
			? url
			: null;
	} catch {
		return null;
	}
}

/** What SNS signed: the message's fields in its order, each name then value on its own line. */
export function snsStringToSign(m: SnsMessage): string {
	const keys =
		m.Type === "Notification"
			? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
			: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
	const record = m as unknown as Record<string, string | undefined>;
	return keys
		.filter((k) => record[k] !== undefined)
		.map((k) => `${k}\n${record[k]}\n`)
		.join("");
}

// ── The certificate's public key (a minimal DER walk: X.509 → SubjectPublicKeyInfo) ──

function pemToDer(pem: string): Uint8Array {
	const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The element at `at`: where its content starts and ends. */
function tlv(der: Uint8Array, at: number) {
	let len = der[at + 1] as number;
	let start = at + 2;
	if (len & 0x80) {
		const n = len & 0x7f;
		len = 0;
		for (let i = 0; i < n; i++) len = len * 256 + (der[start + i] as number);
		start += n;
	}
	return { start, end: start + len };
}

/** The certificate's SubjectPublicKeyInfo, as DER. */
export function spkiOfCertificate(der: Uint8Array): Uint8Array {
	const cert = tlv(der, 0);
	const tbs = tlv(der, cert.start);
	let at = tbs.start;
	// [0] version is optional; then serial, signature, issuer, validity, subject, spki.
	if (der[at] === 0xa0) at = tlv(der, at).end;
	for (let i = 0; i < 5; i++) at = tlv(der, at).end;
	return der.slice(at, tlv(der, at).end);
}

/** Resolved keys only: a pending fetch kept across requests would die with its request. */
const keys = new Map<string, CryptoKey>();

async function keyOf(url: URL, hash: "SHA-1" | "SHA-256", fetcher: typeof fetch) {
	const id = `${url.href}|${hash}`;
	const kept = keys.get(id);
	if (kept) return kept;
	const res = await fetcher(url, {
		signal: AbortSignal.timeout(5_000),
		cf: { cacheTtl: 86_400, cacheEverything: true },
	} as RequestInit);
	if (!res.ok) throw new Error(`SNS certificate ${res.status}`);
	const key = await crypto.subtle.importKey(
		"spki",
		spkiOfCertificate(pemToDer(await res.text())) as BufferSource,
		{ name: "RSASSA-PKCS1-v1_5", hash },
		false,
		["verify"],
	);
	keys.set(id, key);
	return key;
}

/** Whether SNS signed this message (SignatureVersion 1: SHA-1, 2: SHA-256, both RSA). */
export async function verifySns(m: SnsMessage, fetcher: typeof fetch = fetch): Promise<boolean> {
	const url = trustedSnsUrl(m.SigningCertURL);
	if (!url || !m.Signature) return false;
	const hash =
		m.SignatureVersion === "2" ? "SHA-256" : m.SignatureVersion === "1" ? "SHA-1" : null;
	if (!hash) return false;
	try {
		const key = await keyOf(url, hash, fetcher);
		return await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			Uint8Array.from(atob(m.Signature), (c) => c.charCodeAt(0)) as BufferSource,
			new TextEncoder().encode(snsStringToSign(m)),
		);
	} catch (error) {
		console.error("sns: signature not checked", error);
		return false;
	}
}

// ── SNS, STS and IAM query APIs (setup only) ───────────────────────────────

/** One call of a query-protocol API (SNS, STS, IAM, SES v1's receipt rules): its XML answer. */
export async function queryCall(
	aws: AwsConfig,
	service: "sns" | "sts" | "iam" | "ses",
	params: Record<string, string>,
): Promise<string> {
	// IAM is global: one endpoint, signed for us-east-1. SES's host is email.<region>.
	const global = service === "iam";
	const host = service === "ses" ? "email" : service;
	const url = new URL(
		global ? "https://iam.amazonaws.com/" : `https://${host}.${aws.region}.amazonaws.com/`,
	);
	const signingRegion = global ? "us-east-1" : aws.region;
	const body = new URLSearchParams(params).toString();
	const headers = await signV4({
		method: "POST",
		url,
		body,
		region: signingRegion,
		service,
		credentials: aws.credentials,
		contentType: "application/x-www-form-urlencoded; charset=utf-8",
	});
	const res = await (aws.fetcher ?? fetch)(url, {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(15_000),
	});
	const text = await res.text();
	if (!res.ok) {
		const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? String(res.status);
		const message = /<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200);
		throw new AwsQueryError(service, code, message);
	}
	return text;
}

/** A query API answered with an error: its code (AlreadyExists, NotFound…). */
export class AwsQueryError extends Error {
	constructor(
		readonly service: string,
		readonly code: string,
		message: string,
	) {
		super(`${service.toUpperCase()} ${code}: ${message}`);
		this.name = "AwsQueryError";
	}
}

/** XML text with its entities decoded. */
export const unescapeXml = (s: string) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");

export const tag = (xml: string, name: string) =>
	new RegExp(`<${name}>([^<]+)</${name}>`).exec(xml)?.[1] ?? null;

/** The AWS account id of the credentials. */
export async function callerAccount(aws: AwsConfig): Promise<string> {
	const xml = await queryCall(aws, "sts", { Action: "GetCallerIdentity", Version: "2011-06-15" });
	const account = tag(xml, "Account");
	if (!account) throw new Error("STS returned no account");
	return account;
}

/** Creates (or finds: CreateTopic is idempotent) the topic; its ARN. */
export async function createTopic(aws: AwsConfig, name: string): Promise<string> {
	const xml = await queryCall(aws, "sns", {
		Action: "CreateTopic",
		Name: name,
		Version: "2010-03-31",
	});
	const topicArn = tag(xml, "TopicArn");
	if (!topicArn) throw new Error("SNS returned no topic");
	return topicArn;
}

/** Subscribes an HTTPS endpoint; SNS then posts a SubscriptionConfirmation to it. */
export async function subscribeHttps(aws: AwsConfig, topicArn: string, endpoint: string) {
	await queryCall(aws, "sns", {
		Action: "Subscribe",
		TopicArn: topicArn,
		Protocol: "https",
		Endpoint: endpoint,
		ReturnSubscriptionArn: "true",
		// Raw delivery off: the signed envelope is what proves the message came from SNS.
		Version: "2010-03-31",
	});
}

/** The topic's access policy (JSON), or null. */
export async function topicPolicy(aws: AwsConfig, topicArn: string): Promise<string | null> {
	const xml = await queryCall(aws, "sns", {
		Action: "GetTopicAttributes",
		TopicArn: topicArn,
		Version: "2010-03-31",
	});
	const m = /<entry>\s*<key>Policy<\/key>\s*<value>([^<]*)<\/value>/.exec(xml);
	return m?.[1] ? unescapeXml(m[1]) : null;
}

export async function setTopicPolicy(aws: AwsConfig, topicArn: string, policy: string) {
	await queryCall(aws, "sns", {
		Action: "SetTopicAttributes",
		TopicArn: topicArn,
		AttributeName: "Policy",
		AttributeValue: policy,
		Version: "2010-03-31",
	});
}
