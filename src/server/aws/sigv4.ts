/**
 * AWS Signature Version 4 with Web Crypto only (no SDK): every AWS call Mailroom makes (SES v2's
 * JSON API, SNS and STS's query API, Cost Explorer's JSON 1.1 API) goes through signV4.
 */

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
	[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export const sha256Hex = async (s: string | Uint8Array) =>
	hex(
		await crypto.subtle.digest(
			"SHA-256",
			(typeof s === "string" ? enc.encode(s) : s) as BufferSource,
		),
	);

async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
	const k = await crypto.subtle.importKey(
		"raw",
		key as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding, as AWS wants it (encodeURIComponent leaves !'()* alone). */
export const awsEncode = (s: string) =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/** The query string sorted by name then value, each part encoded once. */
function canonicalQuery(url: URL) {
	return [...url.searchParams]
		.map(([k, v]) => [awsEncode(k), awsEncode(v)] as const)
		.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
}

export interface Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** The headers of a signed AWS request. */
export async function signV4(o: {
	method: string;
	url: URL;
	body: string;
	region: string;
	service: string;
	credentials: Credentials;
	contentType?: string;
	/** More headers to send, signed with the rest (lowercase names, e.g. x-amz-target). */
	headers?: Record<string, string>;
	now?: Date;
}): Promise<Record<string, string>> {
	const amzDate = (o.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const payloadHash = await sha256Hex(o.body);
	const headers: Record<string, string> = {
		"content-type": o.contentType ?? "application/json",
		host: o.url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
		...o.headers,
		...(o.credentials.sessionToken
			? { "x-amz-security-token": o.credentials.sessionToken }
			: {}),
	};
	const names = Object.keys(headers).sort();
	// Every service but S3 encodes the (already encoded) path a second time.
	const path = o.url.pathname
		.split("/")
		.map((segment) => awsEncode(segment))
		.join("/");
	const canonical = [
		o.method,
		path || "/",
		canonicalQuery(o.url),
		...names.map((n) => `${n}:${headers[n]}`),
		"",
		names.join(";"),
		payloadHash,
	].join("\n");
	const scope = `${day}/${o.region}/${o.service}/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
	let key: ArrayBuffer = await hmac(enc.encode(`AWS4${o.credentials.secretAccessKey}`), day);
	key = await hmac(key, o.region);
	key = await hmac(key, o.service);
	key = await hmac(key, "aws4_request");
	const signature = hex(await hmac(key, toSign));
	const { host: _host, ...sent } = headers;
	return {
		...sent,
		authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
	};
}
