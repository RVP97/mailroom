import { eq, inArray } from "drizzle-orm";
import type { AwsConfig } from "./aws/ses";
import { db, schema } from "./db";
import { aws, awsFetcher, cfg, maxSendRate } from "./env";

/**
 * An organization's own Amazon SES account, optional. Most deployments send everything through
 * one account (AWS_ACCESS_KEY_ID): this is for an organization whose bounces and complaints
 * should never count against the others' account, or that pays for its own SES. Its brands then
 * send, verify their domains and get their events through that account; with none, nothing
 * changes. Set and removed in provision.ts (connectOrgAws), only while it has no domains.
 *
 * The secret key is kept encrypted (AES-GCM) with a key derived from BETTER_AUTH_SECRET, so
 * changing that secret means entering the organization's keys again.
 */

export type OrgAwsRow = typeof schema.orgAws.$inferSelect;

export interface OwnAccount {
	organizationId: string;
	aws: AwsConfig;
	region: string;
	accountId: string;
	topicArn: string | null;
	row: OrgAwsRow;
}

let secretKey: Promise<CryptoKey> | undefined;
function keyOf() {
	const secret = (cfg() as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET;
	if (!secret) throw new Error("Set BETTER_AUTH_SECRET first: it encrypts the keys");
	secretKey ??= crypto.subtle
		.digest("SHA-256", new TextEncoder().encode(`org-aws:${secret}`))
		.then((raw) =>
			crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
		);
	return secretKey;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptSecret(plain: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await keyOf(),
		new TextEncoder().encode(plain),
	);
	return `${b64(iv)}.${b64(new Uint8Array(sealed))}`;
}

export async function decryptSecret(sealed: string) {
	const [iv, data] = sealed.split(".");
	if (!iv || !data) throw new Error("The organization's AWS secret is unreadable");
	const plain = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: unb64(iv) as BufferSource },
		await keyOf(),
		unb64(data) as BufferSource,
	);
	return new TextDecoder().decode(plain);
}

/** The move to another account its organization is in the middle of (org-aws-manage.ts), if any. */
export async function moveFor(brandId: string) {
	const org = await organizationOf(brandId);
	return (
		(await db
			.select()
			.from(schema.orgAwsMoves)
			.where(eq(schema.orgAwsMoves.organization_id, org))
			.get()) ?? null
	);
}

/** The organization a brand is in (itself for an organization). */
export async function organizationOf(brandId: string) {
	const row = await db
		.select({ parent_id: schema.brands.parent_id })
		.from(schema.brands)
		.where(eq(schema.brands.id, brandId))
		.get();
	return row?.parent_id ?? brandId;
}

export async function toAccount(row: OrgAwsRow): Promise<OwnAccount> {
	return {
		organizationId: row.organization_id,
		region: row.region,
		accountId: row.account_id,
		topicArn: row.topic_arn,
		row,
		aws: {
			region: row.region,
			credentials: {
				accessKeyId: row.access_key_id,
				secretAccessKey: await decryptSecret(row.secret_encrypted),
			},
			fetcher: awsFetcher(),
		},
	};
}

const cache = new Map<string, { value: OwnAccount | null; until: number }>();
const TTL_MS = 60_000;

/** The brand's organization's own SES account, or null: it uses the deployment's. */
export async function ownAccount(brandId: string): Promise<OwnAccount | null> {
	const hit = cache.get(brandId);
	if (hit && hit.until > Date.now()) return hit.value;
	const org = await organizationOf(brandId);
	const row = await db
		.select()
		.from(schema.orgAws)
		.where(eq(schema.orgAws.organization_id, org))
		.get();
	const value = row ? await toAccount(row) : null;
	cache.set(brandId, { value, until: Date.now() + TTL_MS });
	return value;
}

/** The account a brand's calls go to: its organization's own, or the deployment's. */
export const awsFor = async (brandId: string): Promise<AwsConfig> =>
	(await ownAccount(brandId))?.aws ?? aws();

/**
 * The send rate a brand's emails keep: its organization's own account's (as SES last said, 1 a
 * second until read), or the deployment's MAX_SEND_RATE. Each account is paced apart.
 */
export async function paceFor(brandId: string): Promise<{ key: string; perSecond: number }> {
	const own = await ownAccount(brandId);
	if (!own) return { key: "default", perSecond: maxSendRate() };
	return {
		key: `${own.accountId}:${own.region}`,
		perSecond: own.row.max_send_rate && own.row.max_send_rate > 0 ? own.row.max_send_rate : 1,
	};
}

/** After an organization's account changes (its brands' entries go too). */
export const forgetOwnAccounts = () => cache.clear();

/** The organization's own row, as stored (no secret decrypted). */
export const ownAccountRow = (organizationId: string) =>
	db.select().from(schema.orgAws).where(eq(schema.orgAws.organization_id, organizationId)).get();

/** The organization whose own account's topic this is (SNS posts), or null. */
export const ownAccountByTopic = (topicArn: string) =>
	db.select().from(schema.orgAws).where(eq(schema.orgAws.topic_arn, topicArn)).get();

/** Every brand of an organization, its own included. */
export async function brandsOfOrganization(organizationId: string) {
	const rows = await db
		.select({ id: schema.brands.id })
		.from(schema.brands)
		.where(eq(schema.brands.parent_id, organizationId));
	return [organizationId, ...rows.map((r) => r.id)];
}

/** Every brand that sends through an organization's own account (the cost split leaves them out). */
export async function ownAccountBrands(): Promise<Set<string>> {
	const orgs = await db.select({ id: schema.orgAws.organization_id }).from(schema.orgAws);
	if (!orgs.length) return new Set();
	const ids = orgs.map((o) => o.id);
	const brands = await db
		.select({ id: schema.brands.id })
		.from(schema.brands)
		.where(inArray(schema.brands.parent_id, ids));
	return new Set([...ids, ...brands.map((b) => b.id)]);
}
