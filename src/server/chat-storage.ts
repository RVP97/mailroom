import { z } from "zod";
import { signV4 } from "./aws/sigv4";
import { ApiError, validation } from "./errors";
import { decryptSecret, encryptSecret } from "./org-aws";

/**
 * A website chat's own bucket (optional): visitors' and the team's files go to a bucket of the
 * website's (Cloudflare R2, Amazon S3 or anything that speaks S3) instead of Mailroom's R2.
 * Files still come through Mailroom first, so their type, size and content checks
 * (src/lib/chat-files.ts) apply the same; only where the bytes are kept changes. Links stay
 * Mailroom's signed /chat/files/… links, so the bucket can stay private.
 *
 * The secret is AES-GCM encrypted like an organization's own SES keys (org-aws.ts) and never
 * shown again.
 */

export const STORAGE_PROVIDERS = ["r2", "s3", "other"] as const;
export type StorageProvider = (typeof STORAGE_PROVIDERS)[number];

/** As kept on chat_widgets.file_storage. */
export interface FileStorage {
	provider: StorageProvider;
	/** https://… (R2: https://<account>.r2.cloudflarestorage.com; S3: none, the region's). */
	endpoint: string | null;
	region: string;
	bucket: string;
	/** Keys start with it (e.g. "chat/"). */
	prefix: string;
	access_key_id: string;
	/** Sealed with encryptSecret. */
	secret: string;
	connected_at: string;
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX_RE = /^[A-Za-z0-9_./-]*$/;

export const fileStorageInput = z.object({
	provider: z.enum(STORAGE_PROVIDERS),
	/** R2: the Cloudflare account id (or the endpoint itself). */
	account_id: z.string().trim().max(64).optional(),
	endpoint: z.string().trim().max(300).optional(),
	region: z.string().trim().max(40).optional(),
	bucket: z.string().trim().max(63),
	prefix: z.string().trim().max(100).optional(),
	access_key_id: z.string().trim().min(1).max(200),
	/** Left out: keep the one saved (same provider and access key). */
	secret_access_key: z.string().trim().max(200).optional(),
});
export type FileStorageInput = z.infer<typeof fileStorageInput>;

/** Only public https hosts (never an address on a private network or the Worker itself). */
function endpointOf(raw: string) {
	let url: URL;
	try {
		url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
	} catch {
		throw validation("file_storage.endpoint: not a web address");
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:") throw validation("file_storage.endpoint: use https://");
	if (
		!host.includes(".") ||
		/^[\d.]+$/.test(host) ||
		host.includes(":") ||
		/(^|\.)(localhost|local|internal|home\.arpa)$/.test(host)
	)
		throw validation("file_storage.endpoint: use the storage service's public address");
	return `https://${url.host}`;
}

/** The settings to keep, from what was typed (the secret sealed; one left out kept from before). */
export async function fileStorageFrom(
	v: FileStorageInput,
	existing: FileStorage | null,
	now: string,
): Promise<FileStorage> {
	const bucket = v.bucket.toLowerCase();
	if (!BUCKET_RE.test(bucket)) throw validation("file_storage.bucket: not a bucket name");
	let prefix = (v.prefix ?? "").replace(/^\/+/, "");
	if (!PREFIX_RE.test(prefix) || prefix.includes(".."))
		throw validation("file_storage.prefix: letters, numbers and - _ . / only");
	if (prefix && !prefix.endsWith("/")) prefix += "/";
	let endpoint: string | null = null;
	let region = v.region || "";
	if (v.provider === "r2") {
		const id = (v.account_id || "").toLowerCase();
		if (/^[a-f0-9]{32}$/.test(id)) endpoint = `https://${id}.r2.cloudflarestorage.com`;
		else if (v.endpoint) endpoint = endpointOf(v.endpoint);
		else
			throw validation("file_storage.account_id: your Cloudflare account id (32 characters)");
		if (!/\.r2\.cloudflarestorage\.com$/.test(endpoint))
			throw validation(
				"file_storage.endpoint: an R2 address ends in .r2.cloudflarestorage.com",
			);
		region = "auto";
	} else if (v.provider === "s3") {
		if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
			throw validation("file_storage.region: the bucket's AWS region, like us-east-1");
	} else {
		if (!v.endpoint) throw validation("file_storage.endpoint: the service's S3 address");
		endpoint = endpointOf(v.endpoint);
		region ||= "us-east-1";
	}
	const sameKey =
		existing && existing.provider === v.provider && existing.access_key_id === v.access_key_id;
	const secret = v.secret_access_key
		? await encryptSecret(v.secret_access_key)
		: sameKey
			? existing.secret
			: null;
	if (!secret) throw validation("file_storage.secret_access_key: the key's secret");
	return {
		provider: v.provider,
		endpoint,
		region,
		bucket,
		prefix,
		access_key_id: v.access_key_id,
		secret,
		connected_at: sameKey && !v.secret_access_key ? existing.connected_at : now,
	};
}

/** Where a file is: what a ChatAttachment keeps, so a later change of bucket can't misdirect it. */
export const placeOf = (s: FileStorage) => `${s.endpoint ?? `s3.${s.region}`}/${s.bucket}`;

function urlFor(s: FileStorage, key: string) {
	const path = key
		.split("/")
		.map((p) => encodeURIComponent(p))
		.join("/");
	// Amazon's own buckets by their own name (path style is on its way out there).
	const base =
		s.provider === "s3"
			? `https://${s.bucket}.s3.${s.region}.amazonaws.com`
			: `${s.endpoint}/${s.bucket}`;
	return new URL(`${base}/${path}`);
}

async function call(
	s: FileStorage,
	method: "PUT" | "GET" | "DELETE",
	key: string,
	o: { body?: Uint8Array | string; contentType?: string } = {},
) {
	const url = urlFor(s, key);
	const body = o.body ?? "";
	const headers = await signV4({
		method,
		url,
		body,
		region: s.region,
		service: "s3",
		credentials: {
			accessKeyId: s.access_key_id,
			secretAccessKey: await decryptSecret(s.secret),
		},
		contentType: o.contentType ?? "application/octet-stream",
	});
	return fetch(url, {
		method,
		headers,
		body: method === "GET" || method === "DELETE" ? undefined : (body as BodyInit),
	});
}

/** What the bucket said, in words people can act on. */
async function refusal(res: Response, doing: string) {
	const text = await res.text().catch(() => "");
	const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${res.status}`;
	const why =
		code === "NoSuchBucket"
			? "there's no bucket by that name there"
			: code === "InvalidAccessKeyId"
				? "that access key doesn't exist"
				: code === "SignatureDoesNotMatch"
					? "the secret doesn't match the access key"
					: code === "PermanentRedirect" || code === "AuthorizationHeaderMalformed"
						? "the bucket is in another region"
						: code === "AccessDenied" || res.status === 403
							? "the key isn't allowed to (it needs to read, write and delete objects in that bucket)"
							: code;
	return new ApiError(422, "storage_refused", `Your bucket refused to ${doing}: ${why}`);
}

export async function putFile(s: FileStorage, key: string, bytes: Uint8Array, type: string) {
	const res = await call(s, "PUT", key, { body: bytes, contentType: type }).catch(() => null);
	if (!res) throw new ApiError(502, "storage_unreachable", "Your bucket couldn't be reached");
	if (!res.ok) throw await refusal(res, "keep the file");
}

/** The file's bytes, or null when it's gone (or the bucket says no). */
export async function getFile(s: FileStorage, key: string) {
	const res = await call(s, "GET", key).catch(() => null);
	return res?.ok && res.body ? res.body : null;
}

export async function deleteFiles(s: FileStorage, keys: string[]) {
	for (const key of keys) {
		const res = await call(s, "DELETE", key).catch(() => null);
		if (res && !res.ok && res.status !== 404) console.warn("chat storage delete", res.status);
	}
}

/** Writes, reads and deletes a small file, so settings that can't work are never saved. */
export async function testStorage(s: FileStorage) {
	const key = `${s.prefix}mailroom-test-${crypto.randomUUID()}.txt`;
	const body = new TextEncoder().encode("Mailroom checks it can keep chat files here.");
	let res = await call(s, "PUT", key, { body, contentType: "text/plain" }).catch(() => null);
	if (!res)
		throw new ApiError(
			422,
			"storage_unreachable",
			"Your bucket couldn't be reached at that address",
		);
	if (!res.ok) throw await refusal(res, "take a test file");
	res = await call(s, "GET", key);
	if (!res.ok) throw await refusal(res, "give back the test file");
	await res.body?.cancel();
	res = await call(s, "DELETE", key);
	if (!res.ok && res.status !== 404) throw await refusal(res, "delete the test file");
}

/** What the dashboard and the API show of it (never the secret). */
export const fileStorageView = (s: FileStorage | null) =>
	s
		? {
				provider: s.provider,
				endpoint: s.endpoint,
				region: s.region,
				bucket: s.bucket,
				prefix: s.prefix,
				access_key_id: s.access_key_id,
				account_id:
					s.provider === "r2"
						? (/^https:\/\/([a-f0-9]{32})\./.exec(s.endpoint ?? "")?.[1] ?? null)
						: null,
				connected_at: s.connected_at,
			}
		: null;
