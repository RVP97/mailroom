import { and, desc, eq, inArray, like, lt, or, sql } from "drizzle-orm";
import PostalMime, { type Address, type Email } from "postal-mime";
import { archiveBucket, archiveReceived, archivingBrands } from "./archive";
import {
	activateRuleSet,
	activeRuleSet,
	bucketName,
	createReceiptRule,
	createRuleSet,
	deleteObject,
	deleteReceiptRule,
	getObject,
	ruleName,
	setUpBucket,
	withSesPublish,
} from "./aws/receiving";
import { type AwsConfig, createIdentity, getIdentity, SesError } from "./aws/ses";
import { setTopicPolicy, topicPolicy } from "./aws/sns";
import {
	inboxEvent,
	purgeConversations,
	referenceIds,
	snippetOf,
	threadReceived,
} from "./conversations";
import { batch, db, schema } from "./db";
import type { ReceivedAttachment } from "./db/schema";
import {
	aws,
	awsConfigured,
	baseUrl,
	cfg,
	inboundDomain,
	inboundRetentionDays,
	region,
} from "./env";
import { ApiError, notFound, validation } from "./errors";
import { answers, forward, rulesFor } from "./inbound-rules";
import { brandInboxes, inboxOf, purgeInboxActivity } from "./inboxes";
import { forgetOrg } from "./org";
import {
	brandsOfOrganization,
	forgetOwnAccounts,
	moveFor,
	type OrgAwsRow,
	ownAccount,
	ownAccountBrands,
	toAccount,
} from "./org-aws";
import { accountId, inboundMx } from "./provision";
import { inScope, type Scope } from "./queries";
import { getSetting, setSetting } from "./settings";
import { iso } from "./time";
import { emitEvent } from "./webhooks";

/**
 * Receiving email, Resend's way, through SES:
 *
 * 1. A domain's MX points at SES (inbound-smtp.<region>.amazonaws.com). A receipt rule for it
 *    (in the account's active rule set) has SES check the message for spam and viruses, store it
 *    in the S3 drop box and tell the SNS topic, the one SES's sending events already use.
 * 2. /webhooks/ses gets the notification (handleSns → receiveSes): Mailroom copies the message to
 *    R2, deletes it from S3, records it for each brand it was for, and sends `email.received` to
 *    the organization's webhooks (metadata only, like Resend).
 * 3. The API, the dashboard and the assistant read it from R2, parsed when asked for.
 *
 * Every brand also has a Mailroom address, <brand slug>@INBOUND_DOMAIN (with +anything), on the
 * deployment's own domain: one rule for the whole domain.
 */

/** The rule set Mailroom makes when the account has none active. */
export const RULE_SET = "mailroom";
/** Where SES puts messages in the bucket. */
export const PREFIX = "inbound/";

const r2 = () => cfg().INBOUND ?? null;
const lower = (s: string) => s.trim().toLowerCase();
const domainOfAddress = (a: string) => lower(a.split("@").pop() ?? "");

// ── Setup ──────────────────────────────────────────────────────────────────

/** The deployment's receiving side: the drop box, SNS's permission, the rule set and the
 * Mailroom address domain. Each step tolerates being run again. */
export async function setUpReceiving() {
	if (!awsConfigured()) throw validation("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first");
	if (!r2()) throw validation("Add the INBOUND R2 bucket binding to wrangler.jsonc first");
	const topicArn = await getSetting("sns_topic_arn");
	if (!topicArn) throw validation("Set up events first: receiving uses the same SNS topic");
	const a = aws();
	const account = await accountId();
	const bucket = bucketName(account, region());
	await setUpBucket(a, bucket, account);
	const policy = withSesPublish(await topicPolicy(a, topicArn), topicArn, account);
	if (policy) await setTopicPolicy(a, topicArn, policy);
	// Only one rule set can be active: another app's stays, and Mailroom's rules join it.
	let ruleSet = await activeRuleSet(a);
	if (!ruleSet) {
		await createRuleSet(a, RULE_SET);
		await activateRuleSet(a, RULE_SET);
		ruleSet = RULE_SET;
	}
	await setSetting("inbound_bucket", bucket);
	await setSetting("inbound_rule_set", ruleSet);
	const domain = inboundDomain();
	if (domain) {
		let tokens: string[] = [];
		try {
			tokens = (await createIdentity(a, domain)).DkimAttributes?.Tokens ?? [];
		} catch (error) {
			if (!(error instanceof SesError && /AlreadyExists/.test(error.type))) throw error;
			tokens = (await getIdentity(a, domain)).DkimAttributes?.Tokens ?? [];
		}
		await setSetting("inbound_dkim_tokens", JSON.stringify(tokens));
		await createReceiptRule(a, rule(ruleSet, bucket, topicArn, domain));
	}
	// The domains already receiving, in case the rule set is a new one (not those of an
	// organization with its own account: they receive there).
	const receiving = await db
		.select({
			name: schema.domains.name,
			host: schema.domains.receiving_host,
			brand: schema.domains.organization_id,
		})
		.from(schema.domains)
		.where(eq(schema.domains.receiving, true));
	const elsewhere = await ownAccountBrands();
	for (const d of receiving)
		if (!elsewhere.has(d.brand))
			await createReceiptRule(a, rule(ruleSet, bucket, topicArn, d.host ?? d.name));
	await setSetting("inbound_set_up_at", iso());
	return receivingStatus();
}

const rule = (ruleSet: string, bucket: string, topicArn: string, domain: string) => ({
	ruleSet,
	name: ruleName(domain),
	recipients: [domain],
	bucket,
	prefix: PREFIX,
	topicArn,
});

export interface Place {
	aws: AwsConfig;
	bucket: string;
	ruleSet: string;
	topicArn: string;
}

async function where(): Promise<Place | null> {
	const [bucket, ruleSet, topicArn] = await Promise.all([
		getSetting("inbound_bucket"),
		getSetting("inbound_rule_set"),
		getSetting("sns_topic_arn"),
	]);
	return bucket && ruleSet && topicArn && awsConfigured()
		? { aws: aws(), bucket, ruleSet, topicArn }
		: null;
}

/**
 * Where a brand's domains receive: the deployment's drop box and rule set, or, for an
 * organization with its own SES account, the same made in that account (the first time one of
 * its domains receives). SES only receives for domains verified in the same account.
 */
async function placeFor(brandId: string, o: { create?: boolean } = {}): Promise<Place | null> {
	const own = await ownAccount(brandId);
	if (!own) return where();
	if (own.row.inbound_bucket && own.row.inbound_rule_set && own.topicArn)
		return {
			aws: own.aws,
			bucket: own.row.inbound_bucket,
			ruleSet: own.row.inbound_rule_set,
			topicArn: own.topicArn,
		};
	if (!o.create || !own.topicArn) return null;
	if (!r2()) throw validation("Add the INBOUND R2 bucket binding to wrangler.jsonc first");
	const a = own.aws;
	const bucket = bucketName(own.accountId, own.region);
	await setUpBucket(a, bucket, own.accountId);
	const policy = withSesPublish(await topicPolicy(a, own.topicArn), own.topicArn, own.accountId);
	if (policy) await setTopicPolicy(a, own.topicArn, policy);
	let ruleSet = await activeRuleSet(a);
	if (!ruleSet) {
		await createRuleSet(a, RULE_SET);
		await activateRuleSet(a, RULE_SET);
		ruleSet = RULE_SET;
	}
	await db
		.update(schema.orgAws)
		.set({ inbound_bucket: bucket, inbound_rule_set: ruleSet, updated_at: iso() })
		.where(eq(schema.orgAws.organization_id, own.organizationId));
	forgetOwnAccounts();
	return { aws: a, bucket, ruleSet, topicArn: own.topicArn };
}

export interface ReceivingStatus {
	setUp: boolean;
	setUpAt: string | null;
	bucket: string | null;
	ruleSet: string | null;
	/** The INBOUND R2 binding is there. */
	storage: boolean;
	/** The Mailroom address domain, its DNS records and whether SES verified it. */
	domain: string | null;
	verified: boolean | null;
	/** With what DNS has of each: SUCCESS once SES verified the domain (DKIM) or the MX is SES's. */
	records: {
		type: "CNAME" | "MX";
		name: string;
		value: string;
		priority?: number;
		status: "SUCCESS" | "PENDING";
	}[];
}

export async function receivingStatus(): Promise<ReceivingStatus> {
	const [bucket, ruleSet, setUpAt, tokensJson] = await Promise.all([
		getSetting("inbound_bucket"),
		getSetting("inbound_rule_set"),
		getSetting("inbound_set_up_at"),
		getSetting("inbound_dkim_tokens"),
	]);
	const domain = inboundDomain();
	const tokens = tokensJson ? (JSON.parse(tokensJson) as string[]) : [];
	let verified: boolean | null = null;
	if (domain && setUpAt && awsConfigured())
		try {
			verified = !!(await getIdentity(aws(), domain)).VerifiedForSendingStatus;
		} catch (error) {
			console.error("inbound: identity not read", error);
		}
	const mx = domain && setUpAt ? await receivingActive(domain, region()) : false;
	return {
		setUp: !!(bucket && ruleSet && setUpAt),
		setUpAt,
		bucket,
		ruleSet,
		storage: !!r2(),
		domain,
		verified,
		records: domain
			? [
					...tokens.map((t) => ({
						type: "CNAME" as const,
						name: `${t}._domainkey.${domain}`,
						value: `${t}.dkim.amazonses.com`,
						status: verified ? ("SUCCESS" as const) : ("PENDING" as const),
					})),
					{
						type: "MX" as const,
						name: domain,
						value: inboundMx(region()),
						priority: 10,
						status: mx ? ("SUCCESS" as const) : ("PENDING" as const),
					},
				]
			: [],
	};
}

/** A brand's inbound address: its own (on one of its receiving domains) when it picked one and
 * that domain still receives, otherwise <slug>@INBOUND_DOMAIN (null without one). */
export async function mailroomAddress(brandId: string): Promise<string | null> {
	const a = await inboundAddresses(brandId);
	return a.own ?? a.fallback;
}

export interface InboundAddresses {
	/** The brand's own address, when it picked one and its domain receives. */
	own: string | null;
	/** <slug>@INBOUND_DOMAIN: always works, whatever the brand picked. */
	fallback: string | null;
	/** What it picked, even when its domain doesn't receive right now. */
	picked: string | null;
	/** Its domains' receiving hosts, where it can pick an address. */
	hosts: { host: string; active: boolean }[];
}

export async function inboundAddresses(brandId: string): Promise<InboundAddresses> {
	const domain = inboundDomain();
	const [org, settings, hosts] = await Promise.all([
		db
			.select({ slug: schema.organization.slug })
			.from(schema.organization)
			.where(eq(schema.organization.id, brandId))
			.get(),
		db
			.select({ address: schema.organizationSettings.inbound_address })
			.from(schema.organizationSettings)
			.where(eq(schema.organizationSettings.organization_id, brandId))
			.get(),
		receivingHosts(brandId),
	]);
	const picked = settings?.address ?? null;
	return {
		own: picked && hosts.some((h) => h.host === domainOfAddress(picked)) ? picked : null,
		fallback: domain && org?.slug ? `${org.slug}@${domain}` : null,
		picked,
		hosts,
	};
}

async function receivingHosts(brandId: string) {
	const rows = await db
		.select({
			host: schema.domains.receiving_host,
			status: schema.domains.receiving_status,
		})
		.from(schema.domains)
		.where(
			and(eq(schema.domains.organization_id, brandId), eq(schema.domains.receiving, true)),
		);
	// Mail is routed by receiving_host (ownersOf), so a domain without one can't be picked.
	return rows.flatMap((r) => (r.host ? [{ host: r.host, active: r.status === "active" }] : []));
}

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** Sets (or, with null, clears) the brand's own inbound address: a local part (no "+", which
 * stays for tags) at one of its receiving domains. */
export async function setInboundAddress(
	brandId: string,
	address: string | null,
	now = Date.now(),
): Promise<InboundAddresses> {
	let value: string | null = null;
	if (address) {
		value = lower(address);
		const [local = "", host = "", ...rest] = value.split("@");
		if (rest.length || !LOCAL_PART.test(local) || local.includes(".."))
			throw validation("Use letters, digits, dots, dashes or underscores before the @");
		const hosts = await receivingHosts(brandId);
		if (!hosts.some((h) => h.host === host))
			throw validation(
				hosts.length
					? `Pick one of the brand's receiving domains: ${hosts.map((h) => h.host).join(", ")}`
					: "Turn receiving on for one of the brand's domains first (on the domain's page)",
			);
	}
	const row = { organization_id: brandId, inbound_address: value, updated_at: iso(now) };
	await db
		.insert(schema.organizationSettings)
		.values(row)
		.onConflictDoUpdate({ target: schema.organizationSettings.organization_id, set: row });
	return inboundAddresses(brandId);
}

// ── A domain's receiving ───────────────────────────────────────────────────

interface Doh {
	Status?: number;
	Answer?: { type: number; data: string }[];
}

/** The domain's MX hosts (lowercase, without the final dot); null when DNS didn't answer. */
export async function mxHosts(name: string, fetcher: typeof fetch = fetch) {
	try {
		const res = await fetcher(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
			{ headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3_000) },
		);
		if (!res.ok) return null;
		const answer = (await res.json()) as Doh;
		if (answer.Status !== 0 && answer.Status !== 3) return null;
		return (answer.Answer ?? [])
			.filter((r) => r.type === 15)
			.map((r) => lower(r.data.split(/\s+/).pop() ?? "").replace(/\.$/, ""))
			.filter(Boolean);
	} catch (error) {
		console.error("inbound: MX not looked up", name, error);
		return null;
	}
}

const pointsHere = (hosts: string[] | null, r: string) =>
	!!hosts?.length && hosts.every((h) => h === inboundMx(r));

/** Whether the domain's MX points at SES (in its region) now. */
export const receivingActive = async (name: string, r: string) =>
	pointsHere(await mxHosts(name), r);

/** One DNS label, like links (tracking): `reply`, `inbox`, `buzon`… A domain receives at itself
 * unless given one (the API's receiving_prefix); the dashboard adds subdomains as domains. */
export const RECEIVING_PREFIX_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Where a domain receives: <prefix>.<domain>, or the domain itself with an empty prefix. */
export const receivingHostFor = (name: string, prefix: string) =>
	prefix ? `${prefix}.${name}` : name;

/** The prefix of a receiving host (empty: the domain itself). */
export const receivingPrefixOf = (d: { name: string; receiving_host: string | null }) =>
	d.receiving_host && d.receiving_host !== d.name
		? d.receiving_host.slice(0, -(d.name.length + 1))
		: "";

/**
 * Refuses a host whose MX sends its mail to a mailbox today (Google Workspace, Outlook…) unless
 * `replaceMx`: SES's MX would take that mail. Returns the MX hosts it found.
 */
export async function checkReceivingMx(host: string, r: string, replaceMx?: boolean) {
	const hosts = await mxHosts(host);
	const elsewhere = (hosts ?? []).filter((h) => h !== inboundMx(r));
	if (elsewhere.length && !replaceMx)
		throw new ApiError(
			409,
			"domain_has_mx",
			`${host} already receives email at ${elsewhere.join(", ")}. Pointing its MX at SES would take that mail: add a subdomain to receive at instead (reply.${host}), or confirm to replace it.`,
		);
	return hosts;
}

/**
 * Turns receiving on or off for a domain: at the domain itself, or <prefix>.<domain> with a
 * `prefix`. On, an MX that already sends that host's mail elsewhere is refused unless
 * `replaceMx` (checkReceivingMx).
 */
export async function setDomainReceiving(
	organizationId: string,
	id: string,
	on: boolean,
	o: { replaceMx?: boolean; prefix?: string } = {},
) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw notFound("Domain");
	if (await moveFor(organizationId))
		throw new ApiError(
			409,
			"moving_ses_account",
			"This organization is moving to another SES account: change receiving once the move is done",
		);
	if (on) {
		const own = !!(await ownAccount(organizationId));
		const w = await placeFor(organizationId, { create: true });
		if (!w)
			throw new ApiError(
				409,
				"receiving_not_set_up",
				own
					? "The organization's SES account has no events topic yet: connect it again (Settings › Amazon SES account)"
					: "Receiving isn't set up for this deployment yet (AWS account page › Set up receiving)",
			);
		const prefix = o.prefix ?? (d.receiving ? receivingPrefixOf(d) : "");
		if (prefix && !RECEIVING_PREFIX_RE.test(prefix))
			throw validation("The prefix is one word: letters, digits and dashes (reply, inbox…)");
		const host = receivingHostFor(d.name, prefix);
		const hosts = await checkReceivingMx(host, d.region, o.replaceMx);
		await createReceiptRule(w.aws, rule(w.ruleSet, w.bucket, w.topicArn, host));
		// Moved to another host: the old one's rule goes.
		if (d.receiving && (d.receiving_host ?? d.name) !== host)
			await dropReceiving(d, organizationId);
		const update = {
			receiving: true,
			receiving_host: host,
			receiving_status: pointsHere(hosts, d.region) ? "active" : "pending",
		};
		await db.update(schema.domains).set(update).where(eq(schema.domains.id, id));
		forgetOrg(organizationId);
		return { ...d, ...update };
	}
	if (!d.sending)
		throw validation("A domain is for sending, receiving or both: remove it instead");
	await dropReceiving(d, organizationId);
	const update = { receiving: false, receiving_status: null, receiving_host: null };
	await db.update(schema.domains).set(update).where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	return { ...d, ...update };
}

/**
 * Removes the domain's receipt rule (a domain being removed, or receiving turned off), in the
 * account its brand receives in (or `o.place`: the account an organization is moving away from).
 */
export async function dropReceiving(
	d: { name: string; receiving: boolean; receiving_host: string | null },
	brandId?: string,
	o: { place?: Place | null } = {},
) {
	if (!d.receiving) return;
	const place =
		o.place !== undefined ? o.place : brandId ? await placeFor(brandId) : await where();
	if (place)
		await deleteReceiptRule(place.aws, place.ruleSet, ruleName(d.receiving_host ?? d.name));
}

/** A receiving domain's rule in the account its brand now receives in (after a move). */
export async function addReceivingRule(brandId: string, host: string) {
	const place = await placeFor(brandId, { create: true });
	if (!place) throw new Error("Receiving isn't set up for this account");
	await createReceiptRule(place.aws, rule(place.ruleSet, place.bucket, place.topicArn, host));
}

/** Where a brand receives now (the account it's moving away from, for the move's cleanup). */
export const receivingPlace = (brandId: string) => placeFor(brandId);

/** Cron: receiving domains whose MX wasn't pointing at SES yet, looked up again. */
export async function checkPendingReceiving(limit = 20, fetcher: typeof fetch = fetch) {
	const rows = await db
		.select({
			id: schema.domains.id,
			name: schema.domains.name,
			host: schema.domains.receiving_host,
			region: schema.domains.region,
		})
		.from(schema.domains)
		.where(
			and(eq(schema.domains.receiving, true), eq(schema.domains.receiving_status, "pending")),
		)
		.limit(limit);
	for (const r of rows)
		if (pointsHere(await mxHosts(r.host ?? r.name, fetcher), r.region))
			await db
				.update(schema.domains)
				.set({ receiving_status: "active" })
				.where(eq(schema.domains.id, r.id));
}

// ── Arrival ────────────────────────────────────────────────────────────────

type Verdict = { status?: string };

/** SES's notification of a received message (S3 action). */
export interface SesReceipt {
	notificationType?: string;
	mail?: {
		messageId?: string;
		timestamp?: string;
		source?: string;
		destination?: string[];
		commonHeaders?: {
			from?: string[];
			to?: string[];
			cc?: string[];
			subject?: string;
			messageId?: string;
		};
	};
	receipt?: {
		timestamp?: string;
		recipients?: string[];
		spamVerdict?: Verdict;
		virusVerdict?: Verdict;
		spfVerdict?: Verdict;
		dkimVerdict?: Verdict;
		dmarcVerdict?: Verdict;
		action?: { type?: string; bucketName?: string; objectKey?: string };
	};
}

interface Owner {
	brandId: string;
	domainId: string | null;
	recipients: string[];
}

/** Which brands a message's envelope recipients belong to: by their domain, or their slug at
 * INBOUND_DOMAIN. Recipients of nobody's are left out. */
export async function ownersOf(recipients: string[]): Promise<Owner[]> {
	const owners = new Map<string, Owner>();
	const add = (brandId: string, domainId: string | null, to: string) => {
		const key = `${brandId}|${domainId ?? ""}`;
		const o = owners.get(key) ?? { brandId, domainId, recipients: [] };
		o.recipients.push(to);
		owners.set(key, o);
	};
	const addresses = [...new Set(recipients.map(lower).filter((r) => r.includes("@")))];
	const names = [...new Set(addresses.map(domainOfAddress))];
	const own = inboundDomain();
	const domains = names.length
		? await db
				.select({
					id: schema.domains.id,
					host: schema.domains.receiving_host,
					organization_id: schema.domains.organization_id,
				})
				.from(schema.domains)
				.where(
					and(
						inArray(schema.domains.receiving_host, names),
						eq(schema.domains.receiving, true),
					),
				)
		: [];
	const slugs = own
		? [
				...new Set(
					addresses
						.filter((a) => domainOfAddress(a) === own)
						.map((a) => a.split("@")[0]?.split("+")[0] ?? ""),
				),
			].filter(Boolean)
		: [];
	const brands = slugs.length
		? await db
				.select({ id: schema.organization.id, slug: schema.organization.slug })
				.from(schema.organization)
				.where(inArray(schema.organization.slug, slugs))
		: [];
	for (const to of addresses) {
		const name = domainOfAddress(to);
		if (own && name === own) {
			const slug = to.split("@")[0]?.split("+")[0];
			const b = brands.find((x) => x.slug === slug);
			if (b) add(b.id, null, to);
			continue;
		}
		const d = domains.find((x) => x.host === name);
		if (d) add(d.organization_id, d.id, to);
	}
	return [...owners.values()];
}

const formatAddress = (a: Address | undefined): string[] => {
	if (!a) return [];
	if (a.group) return a.group.flatMap(formatAddress);
	if (!a.address) return [];
	return [a.name ? `${a.name.replace(/"/g, "'")} <${a.address}>` : a.address];
};
const formatAddresses = (list: Address[] | undefined) => (list ?? []).flatMap(formatAddress);

const byteLength = (c: ArrayBuffer | string) =>
	typeof c === "string" ? new TextEncoder().encode(c).length : c.byteLength;

/** The parsed message's attachments, as the API lists them. */
const attachmentsOf = (email: Email | null): ReceivedAttachment[] =>
	(email?.attachments ?? []).map((a, i) => ({
		id: `att_${i + 1}`,
		filename: a.filename ?? null,
		content_type: a.mimeType || "application/octet-stream",
		content_disposition: a.disposition ?? null,
		content_id: a.contentId?.replace(/^<|>$/g, "") ?? null,
		size: byteLength(a.content),
	}));

export type ReceiveResult = "applied" | "duplicate" | "ignored" | "retry";

/**
 * One received message: copied from S3 to R2 for each brand it was for, recorded and sent to
 * webhooks, then deleted from S3. Something passing (S3, R2) answers "retry", so SNS delivers it
 * again; a message already recorded is only cleaned up.
 */
export async function receiveSes(
	e: SesReceipt,
	now = Date.now(),
	o: { own?: OrgAwsRow } = {},
): Promise<ReceiveResult> {
	const action = e.receipt?.action;
	const sesId = e.mail?.messageId;
	if (action?.type !== "S3" || !action.bucketName || !action.objectKey || !sesId)
		return "ignored";
	// From an organization's own account: its drop box, its keys, and only its brands' domains.
	const bucket = o.own ? o.own.inbound_bucket : await getSetting("inbound_bucket");
	if (!bucket || action.bucketName !== bucket) return "ignored";
	const a = o.own ? (await toAccount(o.own)).aws : aws();
	const store = r2();
	if (!store) {
		console.error("inbound: no INBOUND R2 binding; the message stays in S3 for a day");
		return "retry";
	}
	const allowed = o.own ? await brandsOfOrganization(o.own.organization_id) : null;
	const owners = (await ownersOf(e.receipt?.recipients ?? e.mail?.destination ?? [])).filter(
		(x) => !allowed || (x.domainId && allowed.includes(x.brandId)),
	);
	// A virus, or nobody's address: nothing is kept.
	if (!owners.length || e.receipt?.virusVerdict?.status === "FAIL") {
		await deleteObject(a, action.bucketName, action.objectKey).catch(() => {});
		return "ignored";
	}
	// Each agent inbox it came to gets its own copy; the brand's other addresses share one.
	const targets: (Owner & { inboxId: string | null })[] = [];
	for (const o of owners) {
		const list = await brandInboxes(o.brandId);
		const groups = new Map<string | null, string[]>();
		for (const to of o.recipients) {
			const inbox = inboxOf(list, to)?.id ?? null;
			groups.set(inbox, [...(groups.get(inbox) ?? []), to]);
		}
		for (const [inboxId, recipients] of groups) targets.push({ ...o, recipients, inboxId });
	}
	const known = await db
		.select({
			organization_id: schema.receivedEmails.organization_id,
			inbox_id: schema.receivedEmails.inbox_id,
		})
		.from(schema.receivedEmails)
		.where(eq(schema.receivedEmails.ses_message_id, sesId));
	const fresh = targets.filter(
		(o) =>
			!known.some(
				(k) => k.organization_id === o.brandId && (k.inbox_id ?? null) === o.inboxId,
			),
	);
	if (!fresh.length) {
		await deleteObject(a, action.bucketName, action.objectKey).catch(() => {});
		return "duplicate";
	}
	let bytes: Uint8Array;
	try {
		bytes = await getObject(a, action.bucketName, action.objectKey);
	} catch (error) {
		console.error("inbound: message not read from S3", error);
		return "retry";
	}
	let parsed: Email | null = null;
	try {
		parsed = await PostalMime.parse(bytes);
	} catch (error) {
		console.error("inbound: message not parsed", error);
	}
	const h = e.mail?.commonHeaders ?? {};
	const at = e.receipt?.timestamp ?? e.mail?.timestamp ?? iso(now);
	const attachments = attachmentsOf(parsed);
	const verdict = (v: Verdict | undefined) => v?.status ?? null;
	const cc = parsed ? formatAddresses(parsed.cc) : (h.cc ?? []);
	let applied = false;
	const from = formatAddress(parsed?.from)[0] ?? h.from?.[0] ?? e.mail?.source ?? "";
	const subject = (parsed?.subject ?? h.subject ?? "").slice(0, 998);
	const replyTo = parsed?.replyTo?.length ? formatAddresses(parsed.replyTo) : null;
	const references = parsed?.references ? referenceIds(parsed.references).join(" ") : null;
	const snippet = snippetOf(parsed?.text);
	// The brand's inbound rules, once per brand (whichever of its copies): a drop keeps nothing;
	// forwards go once with its first copy.
	const ruled = new Map<string, Awaited<ReturnType<typeof rulesFor>>>();
	for (const o of fresh) {
		const id = crypto.randomUUID();
		const key = `${PREFIX}${o.brandId}/${id}.eml`;
		const incoming = {
			brandId: o.brandId,
			recipients:
				owners.find((x) => x.brandId === o.brandId && x.domainId === o.domainId)
					?.recipients ?? o.recipients,
			from,
			subject,
			replyTo,
			parsed,
		};
		const first = !ruled.has(o.brandId);
		const rules =
			ruled.get(o.brandId) ??
			(await rulesFor(incoming).catch((error) => {
				console.error("inbound: rules not read", error);
				return [];
			}));
		ruled.set(o.brandId, rules);
		if (rules.some((x) => x.rule.action === "drop")) {
			applied = true;
			continue;
		}
		try {
			await store.put(key, bytes, { httpMetadata: { contentType: "message/rfc822" } });
		} catch (error) {
			console.error("inbound: message not stored in R2", error);
			return "retry";
		}
		const row = {
			id,
			organization_id: o.brandId,
			domain_id: o.domainId,
			ses_message_id: sesId,
			message_id: parsed?.messageId ?? h.messageId ?? null,
			in_reply_to: parsed?.inReplyTo ?? null,
			from,
			to: parsed ? formatAddresses(parsed.to) : (h.to ?? []),
			cc: cc.length ? cc : null,
			reply_to: replyTo,
			subject,
			recipients: o.recipients,
			size: bytes.byteLength,
			attachments,
			spam: verdict(e.receipt?.spamVerdict),
			virus: verdict(e.receipt?.virusVerdict),
			spf: verdict(e.receipt?.spfVerdict),
			dkim: verdict(e.receipt?.dkimVerdict),
			dmarc: verdict(e.receipt?.dmarcVerdict),
			object_key: key,
			answers_email_id: await answers(o.brandId, parsed).catch(() => null),
			actions: null as string[] | null,
			inbox_id: o.inboxId,
			conversation_id: null as string | null,
			references,
			created_at: at,
		};
		const inserted = await db
			.insert(schema.receivedEmails)
			.values(row)
			.onConflictDoNothing()
			.returning({ id: schema.receivedEmails.id });
		if (!inserted.length) {
			await store.delete(key);
			continue;
		}
		applied = true;
		// Its conversation: a failure here leaves it unthreaded, never lost.
		const thread = await threadReceived(row, snippet, now).catch((error) => {
			console.error("inbound: not threaded", error);
			return null;
		});
		row.conversation_id = thread?.conversationId ?? null;
		const actions: string[] = [];
		for (const x of first ? rules : [])
			if (x.rule.action === "forward")
				actions.push(
					await forward(incoming, x.rule, x.to, id).catch((error) => {
						console.error("inbound: forward failed", error);
						return `Not forwarded: ${error instanceof Error ? error.message : error}`;
					}),
				);
		if (actions.length) {
			row.actions = actions;
			await db
				.update(schema.receivedEmails)
				.set({ actions })
				.where(eq(schema.receivedEmails.id, id));
		}
		await emitEvent(o.brandId, "email.received", id, receivedData(row), now, {
			id,
			from: row.from,
			to: row.to,
			subject: row.subject,
			created_at: row.created_at,
			tags: null,
		});
		if (thread) {
			const about = {
				id: thread.conversationId,
				organization_id: o.brandId,
				inbox_id: o.inboxId,
				subject: row.subject,
			};
			const summary = {
				message_id: id,
				from: row.from,
				to: row.to,
				received_at: row.created_at,
				snippet,
				attachments: attachments.length,
				spam: row.spam === "FAIL",
			};
			if (thread.created) await inboxEvent(about, "inbox.conversation.created", summary, now);
			await inboxEvent(about, "inbox.message.received", summary, now);
		}
	}
	await deleteObject(a, action.bucketName, action.objectKey).catch((error) =>
		console.error("inbound: S3 copy not deleted (its lifecycle rule will)", error),
	);
	return applied ? "applied" : "duplicate";
}

type ReceivedRow = typeof schema.receivedEmails.$inferSelect;

/** What `email.received` carries beyond from, to and subject (Resend's fields). */
const receivedData = (
	r: Pick<
		ReceivedRow,
		"cc" | "recipients" | "to" | "message_id" | "attachments" | "spam" | "answers_email_id"
	>,
) => ({
	/** Our email it answers (by In-Reply-To or References), when it does. */
	in_reply_to_email_id: r.answers_email_id,
	cc: r.cc ?? [],
	// The brand's envelope recipients nobody listed in To or Cc: who it was Bcc'd to.
	bcc: r.recipients.filter(
		(x) => ![...r.to, ...(r.cc ?? [])].some((y) => y.toLowerCase().includes(x)),
	),
	message_id: r.message_id,
	spam: r.spam === "FAIL",
	attachments: (r.attachments ?? []).map((x) => ({
		id: x.id,
		filename: x.filename,
		content_type: x.content_type,
		content_disposition: x.content_disposition,
		content_id: x.content_id,
	})),
});

// ── Reading ────────────────────────────────────────────────────────────────

const re = schema.receivedEmails;

export interface ReceivedFilter {
	/** An address (or part of one) in From or To, the subject's start, or an id. */
	search?: string | null;
	/** Sent to this domain of the brand's (its name); "mailroom" for its Mailroom address. */
	domain?: string | null;
	/** Cursor: the last id of the previous page. */
	after?: string | null;
	limit?: number;
}

export async function listReceived(scope: Scope, f: ReceivedFilter = {}, max = 100) {
	const limit = Math.min(Math.max(f.limit ?? 50, 1), max);
	const conds = [inScope(re.organization_id, scope)];
	const search = f.search?.trim().toLowerCase();
	if (search) {
		const pattern = `%${search.replace(/[%_\\]/g, "\\$&")}%`;
		conds.push(
			or(
				eq(re.id, search),
				sql`lower(${re.from}) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(${re.to}) LIKE ${pattern} ESCAPE '\\'`,
				like(re.subject, `${search.replace(/[%_\\]/g, "\\$&")}%`),
			) as never,
		);
	}
	if (f.domain === "mailroom") conds.push(sql`${re.domain_id} IS NULL`);
	else if (f.domain) {
		const d = await db
			.select({ id: schema.domains.id })
			.from(schema.domains)
			.where(eq(schema.domains.name, f.domain.toLowerCase()))
			.get();
		conds.push(eq(re.domain_id, d?.id ?? "-"));
	}
	if (f.after) {
		const cursor = await db
			.select({ created_at: re.created_at })
			.from(re)
			.where(eq(re.id, f.after))
			.get();
		if (cursor)
			conds.push(
				or(
					lt(re.created_at, cursor.created_at),
					and(eq(re.created_at, cursor.created_at), lt(re.id, f.after)),
				) as never,
			);
	}
	const rows = await db
		.select()
		.from(re)
		.where(and(...conds))
		.orderBy(desc(re.created_at), desc(re.id))
		.limit(limit + 1);
	return { has_more: rows.length > limit, data: rows.slice(0, limit) };
}

export async function getReceived(scope: Scope, id: string) {
	return db
		.select()
		.from(re)
		.where(and(eq(re.id, id), inScope(re.organization_id, scope)))
		.get();
}

/** The whole message, parsed (null: it's past its retention, or R2 lost it). */
export async function parsedMessage(row: Pick<ReceivedRow, "object_key">) {
	const object = await r2()?.get(row.object_key);
	if (!object) return null;
	return PostalMime.parse(await object.arrayBuffer());
}

/** The API's view of a received email (with its content when `content`). */
export async function receivedView(row: ReceivedRow, content = true) {
	const parsed = content ? await parsedMessage(row).catch(() => null) : null;
	return {
		object: "email",
		id: row.id,
		brand_id: row.organization_id,
		created_at: row.created_at,
		from: row.from,
		to: row.to,
		...receivedData(row),
		reply_to: row.reply_to ?? [],
		subject: row.subject,
		in_reply_to: row.in_reply_to,
		actions: row.actions ?? [],
		recipients: row.recipients,
		size: row.size,
		verdicts: {
			spam: row.spam,
			virus: row.virus,
			spf: row.spf,
			dkim: row.dkim,
			dmarc: row.dmarc,
		},
		...(content
			? {
					html: parsed?.html ?? null,
					text: parsed?.text ?? null,
					headers: parsed
						? Object.fromEntries(
								(parsed.headers as unknown as { key: string; value: string }[]).map(
									(x) => [x.key, x.value],
								),
							)
						: null,
				}
			: {}),
	};
}

// ── Attachments ────────────────────────────────────────────────────────────

/** How long an attachment's download link works. */
const LINK_TTL_S = 3600;

let hmacKey: Promise<CryptoKey> | null = null;
const key = () => {
	hmacKey ??= crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(
			`inbound:${(cfg() as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? ""}`,
		),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hmacKey;
};

const b64url = (b: Uint8Array) =>
	btoa(String.fromCharCode(...b))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

export async function sign(value: string) {
	const mac = await crypto.subtle.sign("HMAC", await key(), new TextEncoder().encode(value));
	return b64url(new Uint8Array(mac).slice(0, 18));
}

/** A link that downloads the attachment, signed, for LINK_TTL_S. */
export async function downloadUrl(emailId: string, attachmentId: string, now = Date.now()) {
	const expires = Math.floor(now / 1000) + LINK_TTL_S;
	const signature = await sign(`${emailId}:${attachmentId}:${expires}`);
	return {
		download_url: `${baseUrl()}/inbound/${emailId}/${attachmentId}/${expires}/${signature}`,
		expires_at: iso(expires * 1000),
	};
}

export async function attachmentsView(row: ReceivedRow, now = Date.now()) {
	return Promise.all(
		(row.attachments ?? []).map(async (x) => ({
			object: "attachment",
			...x,
			...(await downloadUrl(row.id, x.id, now)),
		})),
	);
}

/** GET /inbound/<email>/<attachment>/<expires>/<signature>: the attachment's bytes. */
export async function serveAttachment(path: string, now = Date.now()): Promise<Response> {
	const [emailId, attachmentId, expires, signature] = path.split("/").slice(2);
	const gone = new Response("This link has expired or is not valid", { status: 404 });
	if (!emailId || !attachmentId || !expires || !signature) return gone;
	if (Number(expires) * 1000 < now) return gone;
	const expected = await sign(`${emailId}:${attachmentId}:${expires}`);
	if (expected.length !== signature.length) return gone;
	let diff = 0;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
	if (diff) return gone;
	const row = await db.select().from(re).where(eq(re.id, emailId)).get();
	const index = Number(attachmentId.replace(/^att_/, "")) - 1;
	const meta = row?.attachments?.[index];
	if (!row || !meta || meta.id !== attachmentId) return gone;
	const parsed = await parsedMessage(row).catch(() => null);
	const a = parsed?.attachments[index];
	if (!a) return gone;
	const name = (meta.filename ?? `attachment-${index + 1}`).replace(/["\r\n]/g, "");
	return new Response(a.content, {
		headers: {
			"content-type": meta.content_type,
			"content-disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}

// ── Retention ──────────────────────────────────────────────────────────────

/** Cron (daily): received emails past INBOUND_RETENTION_DAYS, rows and messages. */
export async function purgeReceived(now = Date.now(), rounds = 10) {
	const before = iso(now - inboundRetentionDays() * 86_400_000);
	await purgeRows(before, rounds);
	// Conversations whose last message is that old (their drafts and replies with them), and
	// the inboxes' activity.
	await purgeConversations(before, rounds);
	await purgeInboxActivity(before);
}

async function purgeRows(before: string, rounds: number) {
	for (let i = 0; i < rounds; i++) {
		const rows = await db
			.select()
			.from(re)
			.where(lt(re.created_at, before))
			.limit(archiveBucket() ? 100 : 500);
		if (!rows.length) return;
		const bucket = archiveBucket();
		// Into the long-term archive first, for organizations that keep one; when R2 refuses,
		// they wait for the next run.
		if (bucket) {
			const on = await archivingBrands([...new Set(rows.map((r) => r.organization_id))]);
			const keep = rows.filter((r) => on.has(r.organization_id));
			if (keep.length) await archiveReceived(bucket, keep, r2());
		}
		await r2()?.delete(rows.map((r) => r.object_key));
		await batch([
			db.delete(re).where(
				inArray(
					re.id,
					rows.map((r) => r.id),
				),
			),
		]);
		if (rows.length < (bucket ? 100 : 500)) return;
	}
}
