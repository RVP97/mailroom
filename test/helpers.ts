import { vi } from "vitest";
import type { SnsMessage } from "@/server/aws/sns";
import { snsStringToSign } from "@/server/aws/sns";
import { db, schema } from "@/server/db";
import { forgetOrg } from "@/server/org";
import { clearSettingsCache, setSetting } from "@/server/settings";
import { iso } from "@/server/time";
import cert from "./fixtures/sns-test-cert.pem?raw";
import key from "./fixtures/sns-test-key.pem?raw";

export const TOPIC = "arn:aws:sns:us-east-1:123456789012:mailroom-ses-events";
export const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

let n = 0;
/** A unique suffix per call (tests in one file share the database). */
export const uid = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/** An organization set up for sending, with a verified domain. */
export async function seedOrg(o: { domain?: string; ready?: boolean } = {}) {
	const id = `org_${uid()}`;
	const slug = id.replace(/_/g, "-");
	const domain = o.domain ?? `${slug}.test`;
	await db
		.insert(schema.organization)
		.values({ id, name: `Org ${id}`, slug, createdAt: new Date() });
	await db.insert(schema.orgSending).values({
		organization_id: id,
		tenant_name: `mailroom-${slug}`,
		tenant_arn: `arn:aws:ses:us-east-1:123456789012:tenant/mailroom-${slug}/t-1`,
		configuration_set: `mailroom-${slug}`,
		status: o.ready === false ? "not_set_up" : "ready",
		updated_at: iso(),
	});
	const domainId = `dom_${uid()}`;
	await db.insert(schema.domains).values({
		id: domainId,
		organization_id: id,
		name: domain,
		status: "verified",
		dkim_tokens: ["a", "b", "c"],
		region: "us-east-1",
		created_at: iso(),
	});
	forgetOrg(id);
	return { id, slug, domain, domainId, configurationSet: `mailroom-${slug}` };
}

export interface FakeAws {
	/** SES SendEmail calls (their JSON bodies). */
	sends: { body: Record<string, unknown>; headers: Headers }[];
	/** Other calls by URL. */
	calls: string[];
	/** The next SendEmail answers with this (status, AWS error type). */
	failNext: (status: number, type: string, times?: number) => void;
}

/**
 * A fake for everything the app reaches outside: SES (SendEmail answers a message id), SNS's
 * certificate, Cloudflare's DNS over HTTPS (every domain takes email unless listed), and any
 * other URL through `extra`.
 */
export function fakeOutside(
	o: {
		deadDomains?: string[];
		extra?: (
			url: URL,
			init?: RequestInit,
		) => Response | undefined | Promise<Response | undefined>;
	} = {},
): FakeAws {
	const sends: FakeAws["sends"] = [];
	const calls: string[] = [];
	let failures: { status: number; type: string; times: number } | null = null;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const request = input instanceof Request ? input : new Request(String(input), init);
		const url = new URL(request.url);
		if (
			url.host === "email.us-east-1.amazonaws.com" &&
			url.pathname === "/v2/email/outbound-emails"
		) {
			if (failures && failures.times > 0) {
				failures.times--;
				return Response.json(
					{ message: `fake ${failures.type}` },
					{ status: failures.status, headers: { "x-amzn-ErrorType": failures.type } },
				);
			}
			const body = (await request.json()) as Record<string, unknown>;
			sends.push({ body, headers: request.headers });
			return Response.json({ MessageId: `0100-fake-${sends.length}-${uid()}` });
		}
		calls.push(url.toString());
		if (url.toString() === CERT_URL) return new Response(cert);
		if (url.host === "cloudflare-dns.com") {
			const name = url.searchParams.get("name") ?? "";
			if (o.deadDomains?.includes(name)) return Response.json({ Status: 3 });
			return Response.json({ Status: 0, Answer: [{ type: 15, data: `10 mx.${name}.` }] });
		}
		const extra = await o.extra?.(url, init);
		if (extra) return extra;
		throw new Error(`Unmocked outbound request in test: ${url}`);
	});
	return {
		sends,
		calls,
		failNext: (status, type, times = 1) => {
			failures = { status, type, times };
		},
	};
}

let signingKey: Promise<CryptoKey> | null = null;
const pemBytes = (pem: string) =>
	Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s+/g, "")), (c) => c.charCodeAt(0));

/** An SNS message signed with the test certificate (SignatureVersion 2). */
export async function signedSns(
	m: Omit<SnsMessage, "Signature" | "SignatureVersion" | "SigningCertURL">,
) {
	signingKey ??= crypto.subtle.importKey(
		"pkcs8",
		pemBytes(key),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const full = { ...m, SignatureVersion: "2", SigningCertURL: CERT_URL } as SnsMessage;
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		await signingKey,
		new TextEncoder().encode(snsStringToSign(full)),
	);
	return { ...full, Signature: btoa(String.fromCharCode(...new Uint8Array(signature))) };
}

/** SES's event as SNS delivers it. */
export function snsNotification(event: unknown, messageId = `sns-${uid()}`) {
	return signedSns({
		Type: "Notification",
		MessageId: messageId,
		TopicArn: TOPIC,
		Message: JSON.stringify(event),
		Timestamp: iso(),
	});
}

export async function useTopic() {
	clearSettingsCache();
	await setSetting("sns_topic_arn", TOPIC);
}
