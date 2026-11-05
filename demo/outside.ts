/**
 * What the app reaches outside (Amazon SES, DNS over HTTPS, Google), answered in the browser: SES
 * accepts every email and gives it an id, DNS finds the records a verified domain has. Nothing
 * leaves the visitor's browser.
 */

import { clockTime, realNow } from "./clock";
import { onSesSend } from "./ses";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sent = 0;

/** Received messages waiting in the S3 drop box (SES puts them there; demo/seed/inbox.ts here). */
const s3 = new Map<string, Uint8Array>();
export const putInDropBox = (key: string, raw: string) =>
	s3.set(key, new TextEncoder().encode(raw));

async function aws(url: URL, request: Request): Promise<Response> {
	const method = request.method;
	if (/\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.host)) {
		const key = decodeURIComponent(url.pathname.slice(1));
		if (method === "GET") {
			const body = s3.get(key);
			return body
				? new Response(body as BodyInit)
				: new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
		}
		if (method === "DELETE") s3.delete(key);
		return new Response(null, { status: method === "DELETE" ? 204 : 200 });
	}
	if (url.pathname === "/v2/email/outbound-emails" && method === "POST") {
		const messageId = `0100019a-demo-${Date.now().toString(36)}-${(++sent).toString(36)}-000000`;
		onSesSend(await request.json(), messageId);
		return json({ MessageId: messageId });
	}
	if (url.pathname.startsWith("/v2/email/identities") && method === "POST")
		return json({
			IdentityType: "DOMAIN",
			VerifiedForSendingStatus: false,
			DkimAttributes: { Tokens: ["demoaaa", "demobbb", "democcc"], Status: "PENDING" },
		});
	if (url.pathname.startsWith("/v2/email/identities"))
		return json({
			IdentityType: "DOMAIN",
			VerifiedForSendingStatus: true,
			DkimAttributes: { Tokens: ["demoaaa", "demobbb", "democcc"], Status: "SUCCESS" },
			MailFromAttributes: { MailFromDomainStatus: "SUCCESS" },
		});
	// IAM: the SMTP user and its key.
	if (url.host === "iam.amazonaws.com") {
		const body = await request.text();
		const xml = (inner: string) =>
			new Response(`<?xml version="1.0"?><Response>${inner}</Response>`, {
				headers: { "content-type": "text/xml" },
			});
		if (body.includes("Action=CreateAccessKey"))
			return xml(
				`<CreateAccessKeyResult><AccessKey><AccessKeyId>AKIADEMO${(++sent).toString().padStart(8, "0")}</AccessKeyId><SecretAccessKey>demo-secret-${sent}</SecretAccessKey></AccessKey></CreateAccessKeyResult>`,
			);
		return xml("");
	}
	// Cost Explorer: what this much email costs on SES.
	const target = request.headers.get("x-amz-target") ?? "";
	if (target.endsWith("GetCostAndUsage")) {
		const q = (await request.json()) as { TimePeriod: { Start: string; End: string } };
		const out = [];
		const today = new Date().toISOString().slice(0, 10);
		for (
			let d = new Date(`${q.TimePeriod.Start}T00:00:00Z`);
			d.toISOString().slice(0, 10) < q.TimePeriod.End;
			d.setUTCMonth(d.getUTCMonth() + 1)
		) {
			const start = d.toISOString().slice(0, 10);
			const current = start.slice(0, 7) === today.slice(0, 7);
			const part = current ? Number(today.slice(8, 10)) / 30 : 1;
			const line = (service: string, amount: number, type = "Usage") => ({
				Keys: [service, type],
				Metrics: { UnblendedCost: { Amount: (amount * part).toFixed(4), Unit: "USD" } },
			});
			out.push({
				TimePeriod: { Start: start },
				Estimated: current,
				Groups: [
					line("Amazon Simple Email Service", 1.62),
					line("Amazon Simple Notification Service", 0.09),
					line("Amazon Simple Storage Service", 0.01),
					line("Tax", 0.15, "Tax"),
				],
			});
		}
		return json({ ResultsByTime: out });
	}
	if (target.endsWith("GetCostForecast")) return json({ Total: { Amount: "1.05", Unit: "USD" } });
	if (url.pathname === "/v2/email/account")
		return json({
			ProductionAccessEnabled: true,
			SendingEnabled: true,
			SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 1284 },
		});
	return json({});
}

function dns(url: URL): Response {
	const name = url.searchParams.get("name") ?? "";
	const type = url.searchParams.get("type") ?? "A";
	const answer = (data: string, t: number) =>
		json({ Status: 0, Answer: [{ name, type: t, data }] });
	if (type === "MX") return answer("10 inbound-smtp.us-east-1.amazonaws.com.", 15);
	if (type === "TXT")
		return answer(
			name.startsWith("_dmarc.")
				? '"v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"'
				: '"v=spf1 include:amazonses.com ~all"',
			16,
		);
	if (type === "CNAME") return answer(`${name.split(".")[0]}.dkim.amazonses.com.`, 5);
	return answer("203.0.113.10", 1);
}

export function installOutside() {
	const real = globalThis.fetch.bind(globalThis);
	const here = typeof location === "undefined" ? "https://demo.invalid/" : location.href;
	globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request =
			input instanceof Request ? input : new Request(new URL(String(input), here), init);
		const url = new URL(request.url, here);
		if (url.origin === new URL(here).origin) return real(input, init);
		if (url.host.endsWith(".amazonaws.com")) return aws(url, request);
		if (url.host === "cloudflare-dns.com" || url.host === "dns.google") return dns(url);
		if (url.host.endsWith("googleapis.com") || url.host.endsWith("google.com")) return json({});
		if (url.host === "api.github.com") return real(input, init);
		// One of the demo's webhook endpoints was down for half a day a week ago: its deliveries
		// failed and were retried.
		const ago = (realNow() - clockTime()) / 86_400_000;
		if (url.host === "hooks.acme.example" && ago > 8 && ago < 8.5)
			return new Response("Service Unavailable", { status: 503 });
		// Anything else (link checks, feeds, webhooks): answered as if it worked.
		return new Response("", { status: 200 });
	};
}
