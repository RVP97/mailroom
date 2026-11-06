import { and, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ENFORCING_DMARC, prepareBimiSvg } from "../lib/bimi";
import type { AwsConfig } from "./aws/ses";
import {
	arn,
	associateWithTenant,
	createConfigurationSet,
	createIdentity,
	createSnsDestination,
	createTenant,
	deleteIdentity,
	disassociateFromTenant,
	getAccount,
	getIdentity,
	getTenant,
	getTenantReputation,
	putMailFrom,
	SesError,
	updateSnsDestination,
} from "./aws/ses";
import { callerAccount, createTopic, subscribeHttps } from "./aws/sns";
import { db, schema } from "./db";
import { withReportsAddress } from "./dmarc-address";
import { aws, awsConfigured, baseUrl, inboundDomain, region } from "./env";
import { ApiError, validation } from "./errors";
import { forgetOrg } from "./org";
import { awsFor, moveFor, ownAccount } from "./org-aws";
import { getSetting, setSetting } from "./settings";
import { syncSmtpPolicy } from "./smtp";
import { iso } from "./time";
import { dropTrackingHost, trackingTarget } from "./tracking";

/**
 * Everything Mailroom sets up in AWS, from the dashboard (never on its own):
 * - the deployment, once: the account id, an SNS topic for SES's events and its HTTPS
 *   subscription to /webhooks/ses;
 * - each brand: an SES tenant and a configuration set (events → the topic), both
 *   «mailroom-<slug>», associated with each other, and a second pair «mailroom-<slug>-mkt» its
 *   Marketing domains send through;
 * - each domain: an SES identity with Easy DKIM, a custom MAIL FROM, associated with its
 *   brand's tenant for its purpose.
 *   An identity already in SES (another app's) keeps its MAIL FROM and configuration set, and
 *   removing the domain only unlinks it.
 * Each step tolerates "already exists", so a half-finished setup can simply be run again.
 */

export const exists = (error: unknown) =>
	error instanceof SesError && /AlreadyExists/.test(error.type);

export async function accountId() {
	const kept = await getSetting("aws_account_id");
	if (kept) return kept;
	const id = await callerAccount(aws());
	await setSetting("aws_account_id", id);
	return id;
}

export const SNS_TOPIC = "mailroom-ses-events";
export const snsEndpoint = () => `${baseUrl()}/webhooks/ses`;

/**
 * The SES account a brand works in: its organization's own (org-aws.ts), or the deployment's.
 * Every call about a brand's tenants, identities and sends goes through this.
 */
export interface SesTarget {
	aws: AwsConfig;
	region: string;
	account: () => Promise<string>;
	topicArn: string | null;
	/** Its organization's own account. */
	own: boolean;
}

export async function sesTarget(brandId: string): Promise<SesTarget> {
	const own = await ownAccount(brandId);
	if (own)
		return {
			aws: own.aws,
			region: own.region,
			account: async () => own.accountId,
			topicArn: own.topicArn,
			own: true,
		};
	if (!awsConfigured()) throw new ApiError(409, "aws_not_set_up", "AWS isn't configured");
	return {
		aws: aws(),
		region: region(),
		account: accountId,
		topicArn: await getSetting("sns_topic_arn"),
		own: false,
	};
}

/** The deployment's AWS side: account, topic, subscription. */
export async function setUpAccount() {
	if (!awsConfigured()) throw validation("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY first");
	if (!/^https:\/\//.test(baseUrl()))
		throw validation("BETTER_AUTH_URL must be this deployment's public https URL");
	await accountId();
	const topicArn = await createTopic(aws(), SNS_TOPIC);
	await setSetting("sns_topic_arn", topicArn);
	await subscribeHttps(aws(), topicArn, snsEndpoint());
	return { topicArn };
}

export interface AccountStatus {
	configured: boolean;
	region: string;
	accountId: string | null;
	topicArn: string | null;
	subscriptionConfirmedAt: string | null;
	lastEventAt: string | null;
	endpoint: string;
	ses: Awaited<ReturnType<typeof getAccount>> | null;
	error: string | null;
}

export async function accountStatus(): Promise<AccountStatus> {
	const status: AccountStatus = {
		configured: awsConfigured(),
		region: region(),
		accountId: await getSetting("aws_account_id"),
		topicArn: await getSetting("sns_topic_arn"),
		subscriptionConfirmedAt: await getSetting("sns_subscription_confirmed_at"),
		lastEventAt: await getSetting("sns_last_event_at"),
		endpoint: snsEndpoint(),
		ses: null,
		error: null,
	};
	if (status.configured)
		try {
			status.ses = await getAccount(aws());
		} catch (error) {
			status.error = error instanceof Error ? error.message : String(error);
		}
	return status;
}

/** SES names: letters, numbers, - and _ (64 at most). */
export const sesName = (slug: string) =>
	`mailroom-${slug
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")}`.slice(0, 64);

/** The marketing tenant's name for a brand's tenant name. */
export const marketingName = (name: string) => `${name.slice(0, 60)}-mkt`;

/** A tenant and its configuration set (events → the topic), associated; its ARN. */
async function ensureTenant(
	t: SesTarget,
	name: string,
	brandId: string,
	topicArn: string,
	account: string,
) {
	const a = t.aws;
	let tenantArn: string | undefined;
	try {
		tenantArn = (await createTenant(a, name)).TenantArn;
	} catch (error) {
		if (!exists(error)) throw error;
		tenantArn = (await getTenant(a, name)).Tenant?.TenantArn;
	}
	try {
		await createConfigurationSet(a, name, {
			tags: [{ Key: "mailroom-organization", Value: brandId }],
		});
	} catch (error) {
		if (!exists(error)) throw error;
	}
	try {
		await createSnsDestination(a, name, topicArn);
	} catch (error) {
		if (!exists(error)) throw error;
	}
	try {
		await associateWithTenant(a, name, arn(t.region, account, "configuration-set", name));
	} catch (error) {
		if (!exists(error)) throw error;
	}
	return tenantArn ?? null;
}

/**
 * A brand's tenants and configuration sets (its own and its marketing ones). `o.in`: made in
 * that account instead (an organization moving there), without changing what the brand uses.
 */
export async function setUpOrganization(organizationId: string, o: { in?: SesTarget } = {}) {
	const org = await db
		.select()
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.get();
	if (!org) throw new ApiError(404, "not_found", "Brand not found");
	const target = o.in ?? (await sesTarget(organizationId));
	const topicArn = target.topicArn;
	if (!topicArn)
		throw new ApiError(
			409,
			"aws_not_set_up",
			target.own
				? "The organization's own SES account has no events topic yet: connect it again (Settings › Amazon SES account)"
				: "An admin has to finish AWS setup first (Admin › AWS)",
		);
	const current = await db
		.select({ tenant_name: schema.orgSending.tenant_name })
		.from(schema.orgSending)
		.where(eq(schema.orgSending.organization_id, organizationId))
		.get();
	// A brand keeps its tenant's first name, even after its slug changes.
	const name = current?.tenant_name ?? sesName(org.slug);
	const save = (row: Partial<typeof schema.orgSending.$inferInsert>) =>
		db
			.insert(schema.orgSending)
			.values({ organization_id: organizationId, updated_at: iso(), ...row })
			.onConflictDoUpdate({
				target: schema.orgSending.organization_id,
				set: { ...row, updated_at: iso() },
			});
	if (o.in) {
		const account = await target.account();
		await ensureTenant(target, name, organizationId, topicArn, account);
		await ensureTenant(target, marketingName(name), organizationId, topicArn, account);
		return;
	}
	try {
		const account = await target.account();
		const tenantArn = await ensureTenant(target, name, organizationId, topicArn, account);
		const marketing = marketingName(name);
		const marketingArn = await ensureTenant(
			target,
			marketing,
			organizationId,
			topicArn,
			account,
		);
		await save({
			tenant_name: name,
			tenant_arn: tenantArn,
			configuration_set: name,
			marketing_tenant_name: marketing,
			marketing_tenant_arn: marketingArn,
			marketing_configuration_set: marketing,
			status: "ready",
			last_error: null,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await save({ status: "error", last_error: message.slice(0, 500) });
		throw new ApiError(502, "aws_error", message);
	} finally {
		forgetOrg(organizationId);
	}
}

/** The tenant a domain of this purpose sends through. */
export const tenantFor = (
	sending: Pick<typeof schema.orgSending.$inferSelect, "tenant_name" | "marketing_tenant_name">,
	purpose: string,
) => (purpose === "marketing" ? sending.marketing_tenant_name : sending.tenant_name);

export async function sendingOf(brandId: string) {
	return db
		.select()
		.from(schema.orgSending)
		.where(eq(schema.orgSending.organization_id, brandId))
		.get();
}

export const notFoundAtSes = (error: unknown) =>
	error instanceof SesError && (error.status === 404 || /NotFound/.test(error.type));

/** Moves a domain's identity from one tenant to another (another brand, or another purpose). */
async function retenant(brandId: string, name: string, from: string | null, to: string | null) {
	if (from === to) return;
	const t = await sesTarget(brandId);
	const a = t.aws;
	const identity = arn(t.region, await t.account(), "identity", name);
	if (from)
		try {
			await disassociateFromTenant(a, from, identity);
		} catch (error) {
			if (!notFoundAtSes(error)) throw error;
		}
	if (to)
		try {
			await associateWithTenant(a, to, identity);
		} catch (error) {
			if (!exists(error)) throw error;
		}
}

/** In SES, a domain moving from one brand to another (removeBrand moves the rows). */
export async function moveDomainTenant(
	d: Pick<typeof schema.domains.$inferSelect, "name" | "purpose">,
	fromBrand: string,
	toBrand: string,
) {
	const [from, to] = await Promise.all([sendingOf(fromBrand), sendingOf(toBrand)]);
	// An identity lives in one SES account: it can't move to a brand that sends from another.
	const [fromOwn, toOwn] = await Promise.all([ownAccount(fromBrand), ownAccount(toBrand)]);
	if ((fromOwn?.accountId ?? null) !== (toOwn?.accountId ?? null))
		throw new ApiError(
			409,
			"other_ses_account",
			`${d.name} is in another Amazon SES account than that brand: remove it and add it there`,
		);
	if (d.purpose === "marketing" && to && !to.marketing_tenant_name)
		await setUpOrganization(toBrand);
	const target = d.purpose === "marketing" ? await sendingOf(toBrand) : to;
	await retenant(
		toBrand,
		d.name,
		from ? tenantFor(from, d.purpose) : null,
		target ? tenantFor(target, d.purpose) : null,
	);
}

/**
 * A domain's purpose: "marketing" sends through the brand's marketing tenant (made now if the
 * brand predates it) and gets a one-click unsubscribe on every email.
 */
export async function setDomainPurpose(
	brandId: string,
	id: string,
	purpose: "transactional" | "marketing",
) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, brandId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	if (d.purpose === purpose) return d;
	let sending = await sendingOf(brandId);
	if (purpose === "marketing" && sending && !sending.marketing_tenant_name) {
		await setUpOrganization(brandId);
		sending = await sendingOf(brandId);
	}
	if (sending)
		await retenant(brandId, d.name, tenantFor(sending, d.purpose), tenantFor(sending, purpose));
	await db.update(schema.domains).set({ purpose }).where(eq(schema.domains.id, id));
	forgetOrg(brandId);
	return { ...d, purpose };
}

/** Pauses or resumes sending from one domain. */
export async function setDomainPaused(
	brandId: string,
	id: string,
	paused: boolean,
	reason: "you" | "unknown_recipients" | "sending_limits" = "you",
	now = Date.now(),
	o: { isAdmin?: boolean } = {},
) {
	if (!paused && !o.isAdmin) {
		const x = await db
			.select({ reason: schema.domains.paused_reason })
			.from(schema.domains)
			.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, brandId)))
			.get();
		if (!x) throw new ApiError(404, "not_found", "Domain not found");
		if (x.reason === "sending_limits")
			throw new ApiError(
				403,
				"paused_by_mailroom",
				"Mailroom paused this domain for going over the sending limits; ask this deployment's admins to resume it",
			);
	}
	const d = schema.domains;
	const [row] = await db
		.update(d)
		.set(
			paused
				? {
						paused_at: sql`COALESCE(${d.paused_at}, ${iso(now)})`,
						// A pause for the sending limits stays one (only admins lift it), whoever pauses again.
						paused_reason: sql`CASE WHEN ${d.paused_at} IS NOT NULL AND ${d.paused_reason} = 'sending_limits' THEN 'sending_limits' ELSE ${reason} END`,
					}
				: { paused_at: null, paused_reason: null, resumed_at: iso(now) },
		)
		.where(
			and(
				eq(d.id, id),
				eq(d.organization_id, brandId),
				// Resuming by the brand: never a limits pause placed in between.
				!paused && !o.isAdmin
					? sql`coalesce(${d.paused_reason}, '') <> 'sending_limits'`
					: undefined,
			),
		)
		.returning();
	if (!row) {
		if (!paused && !o.isAdmin)
			throw new ApiError(
				403,
				"paused_by_mailroom",
				"Mailroom paused this domain for going over the sending limits; ask this deployment's admins to resume it",
			);
		throw new ApiError(404, "not_found", "Domain not found");
	}
	forgetOrg(brandId);
	return row;
}

/**
 * Once: every configuration set stops asking SES for opens and clicks, then Mailroom tracks them
 * itself (own_tracking_at). Until it's done (the IAM user needs
 * ses:UpdateConfigurationSetEventDestination), SES keeps tracking as before.
 */
export async function syncEventDestinations() {
	if (await getSetting("own_tracking_at")) return "done" as const;
	const topicArn = await getSetting("sns_topic_arn");
	if (!topicArn) return "waiting" as const;
	const rows = await db
		.select({
			brand: schema.orgSending.organization_id,
			name: schema.orgSending.configuration_set,
		})
		.from(schema.orgSending);
	for (const r of rows)
		if (r.name)
			try {
				// A set in an organization's own account sends to that account's topic.
				const t = await sesTarget(r.brand);
				if (!t.topicArn) continue;
				await updateSnsDestination(t.aws, r.name, t.topicArn);
			} catch (error) {
				// A set that's gone, or never got its destination, has nothing to stop.
				if (!(error instanceof SesError && error.status === 404)) throw error;
			}
	await setSetting("own_tracking_at", iso());
	return "done" as const;
}

/** Reads SES's status of the brand's tenants (SES pauses tenants on its own). */
export async function refreshTenantStatus(organizationId: string) {
	const row = await sendingOf(organizationId);
	if (!row?.tenant_arn) return row ?? null;
	try {
		const a = await awsFor(organizationId);
		const [r, m] = await Promise.all([
			getTenantReputation(a, row.tenant_arn),
			row.marketing_tenant_arn
				? getTenantReputation(a, row.marketing_tenant_arn).catch(() => null)
				: Promise.resolve(null),
		]);
		const status = r.ReputationEntity?.SendingStatusAggregate ?? null;
		const marketing =
			m?.ReputationEntity?.SendingStatusAggregate ?? row.marketing_tenant_status;
		await db
			.update(schema.orgSending)
			.set({
				tenant_status: status,
				marketing_tenant_status: marketing ?? null,
				tenant_checked_at: iso(),
			})
			.where(eq(schema.orgSending.organization_id, organizationId));
		return {
			...row,
			tenant_status: status,
			marketing_tenant_status: marketing ?? null,
			reputation: r.ReputationEntity ?? null,
		};
	} catch (error) {
		console.error("provision: tenant status not read", error);
		return row;
	}
}

// ── Domains ────────────────────────────────────────────────────────────────

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface DnsRecord {
	record:
		| "DKIM"
		| "SPF"
		| "MX"
		| "DMARC"
		| "BIMI"
		| "Tracking"
		| "Receiving"
		| "Gmail"
		| "Ownership";
	type: "CNAME" | "TXT" | "MX";
	name: string;
	value: string;
	priority?: number;
	status?: string;
	optional?: boolean;
	/** Why it's there, when that's not obvious (a move to another SES account). */
	note?: string;
}

/** The DNS records a domain needs, in the order to add them. */
export function dnsRecords(
	d: Pick<
		typeof schema.domains.$inferSelect,
		| "name"
		| "dkim_tokens"
		| "mail_from"
		| "region"
		| "dkim_status"
		| "mail_from_status"
		| "bimi_logo"
		| "bimi_updated_at"
		| "tracking_host"
		| "tracking_status"
		| "receiving"
		| "receiving_status"
		| "receiving_host"
	> & {
		sending?: boolean;
		move_dkim_tokens?: string[] | null;
		move_status?: string | null;
		organization_id?: string;
		ses_owned?: boolean;
		owner_proven?: boolean;
	},
): DnsRecord[] {
	const records: DnsRecord[] = d.dkim_tokens.map((t) => ({
		record: "DKIM",
		type: "CNAME",
		name: `${t}._domainkey.${d.name}`,
		value: `${t}.dkim.amazonses.com`,
		status: d.dkim_status ?? undefined,
	}));
	// A domain SES already had (its DKIM records may be someone else's): proof it's this brand's.
	if (needsOwnershipProof(d) && d.organization_id)
		records.unshift({
			record: "Ownership",
			type: "TXT",
			name: ownershipHost(d.name),
			value: `"${ownershipValue(d.organization_id)}"`,
			status: "PENDING",
			note: "SES already had this domain, so Mailroom asks for proof that it's yours",
		});
	// Moving to another SES account: its DKIM records there too (both sets can stay).
	for (const t of d.move_dkim_tokens ?? [])
		records.push({
			record: "DKIM",
			type: "CNAME",
			name: `${t}._domainkey.${d.name}`,
			value: `${t}.dkim.amazonses.com`,
			status: d.move_status === "verified" ? "SUCCESS" : "PENDING",
			note: "For the SES account it's moving to",
		});
	if (d.mail_from) {
		records.push({
			record: "MX",
			type: "MX",
			name: d.mail_from,
			value: `feedback-smtp.${d.region}.amazonses.com`,
			priority: 10,
			status: d.mail_from_status ?? undefined,
		});
		records.push({
			record: "SPF",
			type: "TXT",
			name: d.mail_from,
			value: '"v=spf1 include:amazonses.com ~all"',
			status: d.mail_from_status ?? undefined,
		});
	}
	// Opens and clicks on the domain's own host (src/server/tracking.ts).
	if (d.tracking_host && trackingTarget())
		records.push({
			record: "Tracking",
			type: "CNAME",
			name: d.tracking_host,
			value: trackingTarget(),
			status:
				d.tracking_status === "active"
					? "SUCCESS"
					: d.tracking_status === "failed"
						? "FAILED"
						: "PENDING",
		});
	// Mailroom receives the domain's email: its MX goes to SES (src/server/inbound.ts).
	if (d.receiving)
		records.push({
			record: "Receiving",
			type: "MX",
			name: d.receiving_host ?? d.name,
			value: inboundMx(d.region),
			priority: 10,
			status: d.receiving_status === "active" ? "SUCCESS" : "PENDING",
		});
	// With a logo, DMARC must enforce for inboxes to show it (BIMI).
	records.push({
		record: "DMARC",
		type: "TXT",
		name: `_dmarc.${d.name}`,
		// With Mailroom's rua=, providers' daily reports show on the domain page (dmarc-reports.ts).
		value: `"${withReportsAddress((d.bimi_logo ? ENFORCING_DMARC : "v=DMARC1; p=none;").replace(/"/g, ""))}"`,
		optional: true,
	});
	if (d.bimi_logo)
		records.push({
			record: "BIMI",
			type: "TXT",
			name: `default._bimi.${d.name}`,
			value: `"v=BIMI1; l=${bimiLogoUrl(d)};"`,
			optional: true,
		});
	// A domain only for receiving: SES's verification (DKIM) and its MX.
	if (d.sending === false)
		return records.filter(
			(r) => r.record === "DKIM" || r.record === "Receiving" || r.record === "Ownership",
		);
	return records;
}

/**
 * A domain whose SES identity was there before Mailroom added it (another app's, or one another
 * brand removed) is verified in SES already, with DKIM records anyone can't be asked to prove.
 * Before it can send, its brand shows it controls the domain's DNS: a TXT record at
 * _mailroom.<domain> naming the brand. Once found it's kept (owner_proven), and domains verified
 * before this check counted as proven (migration 0040), so they never stop sending over it.
 */
export const ownershipHost = (name: string) => `_mailroom.${name}`;
export const ownershipValue = (brandId: string) => `mailroom-verification=${brandId}`;
export const needsOwnershipProof = (d: { ses_owned?: boolean; owner_proven?: boolean }) =>
	d.ses_owned === false && d.owner_proven === false;

async function ownsDomain(name: string, brandId: string) {
	try {
		const { txtRecords } = await import("../lib/dmarc");
		const want = ownershipValue(brandId);
		return (await txtRecords(ownershipHost(name))).some((t) => t.trim() === want);
	} catch {
		return false;
	}
}

/** SES's receiving host in a region: where a receiving domain's MX points. */
export const inboundMx = (r: string) => `inbound-smtp.${r}.amazonaws.com`;

/** Where Mailroom serves a domain's BIMI logo. It stays the same when the logo changes, so the
 * DNS record never has to. */
export const bimiLogoUrl = (d: { name: string }) => `${baseUrl()}/bimi/${d.name}.svg`;

/**
 * Adds a domain to a brand, to send from, to receive at, or both. SES verifies it the same way
 * either way (its DKIM records); only a sending domain gets a MAIL FROM, DMARC and tracking.
 */
export async function addDomain(
	organizationId: string,
	rawName: string,
	purpose: "transactional" | "marketing" = "transactional",
	o: { sending?: boolean; receiving?: boolean; replaceMx?: boolean } = {},
) {
	const name = rawName.trim().toLowerCase().replace(/\.$/, "");
	if (!DOMAIN.test(name)) throw validation("Enter a domain like example.com or mail.example.com");
	const sends = o.sending ?? true;
	if (!sends && !o.receiving) throw validation("A domain is for sending, receiving or both");
	if (await moveFor(organizationId))
		throw new ApiError(
			409,
			"moving_ses_account",
			"This organization is moving to another SES account: add domains once the move is done (or cancel it)",
		);
	const target = await sesTarget(organizationId);
	// Checked before anything is created: an MX at a mailbox today is the person's call.
	if (o.receiving) {
		const { checkReceivingMx } = await import("./inbound");
		await checkReceivingMx(name, target.region, o.replaceMx);
	}
	let sending = await sendingOf(organizationId);
	if (sending?.status !== "ready")
		throw new ApiError(409, "brand_not_ready", "Set up sending for this brand first");
	if (purpose === "marketing" && !sending.marketing_tenant_name) {
		await setUpOrganization(organizationId);
		sending = (await sendingOf(organizationId)) ?? sending;
	}
	const inbound = inboundDomain();
	if (inbound && (name === inbound || name.endsWith(`.${inbound}`)))
		throw new ApiError(409, "domain_exists", "This domain is Mailroom's own receiving domain");
	// Another brand's receiving host counts too: mail to it, and its receipt rule, are that brand's.
	const taken = await db
		.select({ organization_id: schema.domains.organization_id })
		.from(schema.domains)
		.where(or(eq(schema.domains.name, name), eq(schema.domains.receiving_host, name)))
		.get();
	if (taken)
		throw new ApiError(
			409,
			"domain_exists",
			taken.organization_id === organizationId
				? "This domain is already added"
				: "This domain belongs to another brand",
		);
	// A name under another organization's domain: SES may count it verified through its parent in
	// the shared account, with no DNS change by whoever adds it. Only that domain's organization
	// adds names under it.
	const parents = name
		.split(".")
		.slice(1)
		.map((_, i, labels) => labels.slice(i).join("."))
		.filter((p) => p.includes("."));
	if (parents.length) {
		const { parentOf } = await import("./brands");
		const mine = (await parentOf(organizationId)) ?? organizationId;
		const above = await db
			.select({ organization_id: schema.domains.organization_id })
			.from(schema.domains)
			.where(inArray(schema.domains.name, parents));
		for (const d of above)
			if (((await parentOf(d.organization_id)) ?? d.organization_id) !== mine)
				throw new ApiError(
					409,
					"domain_exists",
					"This domain is under another organization's domain",
				);
	}
	const a = target.aws;
	let tokens: string[] = [];
	let owned = true;
	let mailFrom: string | null = sends ? `bounce.${name}` : null;
	try {
		const created = await createIdentity(
			a,
			name,
			(purpose === "marketing"
				? sending.marketing_configuration_set
				: sending.configuration_set) ?? undefined,
		);
		tokens = created.DkimAttributes?.Tokens ?? [];
	} catch (error) {
		if (!exists(error))
			throw new ApiError(
				502,
				"aws_error",
				error instanceof Error ? error.message : String(error),
			);
		owned = false;
		const identity = await getIdentity(a, name);
		tokens = identity.DkimAttributes?.Tokens ?? [];
		mailFrom = identity.MailFromAttributes?.MailFromDomain || mailFrom;
	}
	// An existing identity's MAIL FROM is another app's DNS: only set one where there is none.
	if (mailFrom && mailFrom === `bounce.${name}`)
		try {
			await putMailFrom(a, name, mailFrom);
		} catch (error) {
			console.error("provision: MAIL FROM not set", error);
		}
	const tenant = tenantFor(sending, purpose);
	if (tenant)
		try {
			await associateWithTenant(
				a,
				tenant,
				arn(target.region, await target.account(), "identity", name),
			);
		} catch (error) {
			if (!exists(error))
				throw new ApiError(
					502,
					"aws_error",
					error instanceof Error ? error.message : String(error),
				);
		}
	const row = {
		id: crypto.randomUUID(),
		organization_id: organizationId,
		name,
		status: "pending",
		dkim_tokens: tokens,
		dkim_status: "PENDING",
		mail_from: mailFrom,
		mail_from_status: mailFrom ? "PENDING" : null,
		sending: sends,
		region: target.region,
		ses_owned: owned,
		owner_proven: owned,
		purpose,
		created_at: iso(),
	};
	await db.insert(schema.domains).values(row);
	forgetOrg(organizationId);
	if (sends) await syncSmtpPolicy(organizationId);
	if (o.receiving) {
		const { setDomainReceiving } = await import("./inbound");
		return setDomainReceiving(organizationId, row.id, true, { replaceMx: true });
	}
	const saved = await db.select().from(schema.domains).where(eq(schema.domains.id, row.id)).get();
	if (!saved) throw new ApiError(500, "internal_error", "Domain not saved");
	return saved;
}

/**
 * Lets brands send from the domain, or stops it (a domain kept only for receiving). Sending on
 * gives it a MAIL FROM where it has none; a domain is always for one or the other.
 */
export async function setDomainSending(organizationId: string, id: string, on: boolean) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	if (!on && !d.receiving)
		throw validation("A domain is for sending, receiving or both: remove it instead");
	const update: Partial<typeof schema.domains.$inferInsert> = { sending: on };
	if (on && !d.mail_from) {
		const mailFrom = `bounce.${d.name}`;
		try {
			await putMailFrom(await awsFor(organizationId), d.name, mailFrom);
		} catch (error) {
			console.error("provision: MAIL FROM not set", error);
		}
		update.mail_from = mailFrom;
		update.mail_from_status = "PENDING";
	}
	await db.update(schema.domains).set(update).where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	await syncSmtpPolicy(organizationId);
	return { ...d, ...update };
}

const STATUS: Record<string, string> = {
	SUCCESS: "verified",
	FAILED: "failed",
	TEMPORARY_FAILURE: "temporary_failure",
	PENDING: "pending",
	NOT_STARTED: "pending",
};

/** Asks SES how the domain's verification goes. */
export async function verifyDomain(organizationId: string, id: string) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	const identity = await getIdentity(await awsFor(organizationId), d.name);
	const dkim = identity.DkimAttributes?.Status ?? "PENDING";
	let status = identity.VerifiedForSendingStatus ? "verified" : (STATUS[dkim] ?? "pending");
	// SES's word isn't enough for an identity that was there before: the brand's TXT proof is.
	let ownerProven = d.owner_proven;
	if (needsOwnershipProof(d)) {
		ownerProven = await ownsDomain(d.name, d.organization_id);
		if (!ownerProven && status === "verified") status = "pending";
	}
	const update = {
		status,
		owner_proven: ownerProven,
		dkim_status: dkim,
		dkim_tokens: identity.DkimAttributes?.Tokens?.length
			? identity.DkimAttributes.Tokens
			: d.dkim_tokens,
		mail_from_status: identity.MailFromAttributes?.MailFromDomainStatus ?? d.mail_from_status,
		receiving_status: d.receiving_status,
		checked_at: iso(),
	};
	// A receiving domain whose MX wasn't at SES yet: looked up again too.
	if (d.receiving && d.receiving_status !== "active") {
		const { receivingActive } = await import("./inbound");
		if (await receivingActive(d.receiving_host ?? d.name, d.region))
			update.receiving_status = "active";
	}
	await db.update(schema.domains).set(update).where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	// SMTP may send only from verified domains: the policy follows the change.
	if (d.sending && (status === "verified") !== (d.status === "verified"))
		await syncSmtpPolicy(d.organization_id).catch((error) =>
			console.error("provision: SMTP policy not synced", error),
		);
	return { ...d, ...update };
}

export async function removeDomain(organizationId: string, id: string) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	// Mid-move, its identity in the account it was moving to goes too.
	if (d.move_dkim_tokens) {
		const { dropMovedIdentity } = await import("./org-aws-manage");
		await dropMovedIdentity(organizationId, d);
	}
	const target = await sesTarget(organizationId);
	const a = target.aws;
	const notFound = (error: unknown) =>
		error instanceof SesError && (error.status === 404 || /NotFound/.test(error.type));
	const sending = await sendingOf(organizationId);
	const tenant = sending ? tenantFor(sending, d.purpose) : null;
	// SES refuses to delete an identity that still belongs to a tenant.
	if (tenant)
		try {
			await disassociateFromTenant(
				a,
				tenant,
				arn(target.region, await target.account(), "identity", d.name),
			);
		} catch (error) {
			if (!notFound(error)) throw error;
		}
	await dropTrackingHost(d);
	const { dropReceiving } = await import("./inbound");
	await dropReceiving(d, organizationId);
	if (d.ses_owned)
		try {
			await deleteIdentity(a, d.name);
		} catch (error) {
			if (!notFound(error)) throw error;
		}
	await db.delete(schema.domains).where(eq(schema.domains.id, id));
	forgetOrg(organizationId);
	await syncSmtpPolicy(organizationId);
}

/**
 * Cron: pending domains are checked again (each run, for their first 3 days), the least recently
 * checked first so older ones never crowd out new ones; and every other domain once a day, so a
 * verification SES withdrew later (DKIM records removed) or a failure fixed since shows.
 */
export async function checkPendingDomains(now = Date.now(), limit = 10, settled = 5) {
	const d = schema.domains;
	const cols = { id: d.id, organization_id: d.organization_id };
	const leastRecent = sql`${d.checked_at} IS NOT NULL, ${d.checked_at}`;
	const [fresh, others] = await Promise.all([
		db
			.select(cols)
			.from(d)
			.where(and(eq(d.status, "pending"), gt(d.created_at, iso(now - 3 * 86_400_000))))
			.orderBy(leastRecent)
			.limit(limit),
		db
			.select(cols)
			.from(d)
			.where(
				and(
					or(sql`${d.status} <> 'pending'`, lte(d.created_at, iso(now - 3 * 86_400_000))),
					or(isNull(d.checked_at), lt(d.checked_at, iso(now - 86_400_000))),
				),
			)
			.orderBy(leastRecent)
			.limit(settled),
	]);
	for (const r of [...fresh, ...others])
		await verifyDomain(r.organization_id, r.id).catch(async (error) => {
			console.error("domains: check failed", error);
			// Looked at anyway, so one SES won't answer for doesn't hold up the others.
			await db
				.update(d)
				.set({ checked_at: iso(now) })
				.where(eq(d.id, r.id));
		});
}

// ── Brand logo (BIMI) ──────────────────────────────────────────────────────

/**
 * Sets a domain's brand logo (made SVG Tiny PS, see prepareBimiSvg), or removes it with null.
 * Its title is the brand's name, which screen readers read.
 */
export async function setBimiLogo(organizationId: string, id: string, svg: string | null) {
	const d = await db
		.select({ id: schema.domains.id })
		.from(schema.domains)
		.where(and(eq(schema.domains.id, id), eq(schema.domains.organization_id, organizationId)))
		.get();
	if (!d) throw new ApiError(404, "not_found", "Domain not found");
	let logo: string | null = null;
	if (svg !== null) {
		const org = await db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, organizationId))
			.get();
		const r = prepareBimiSvg(svg, org?.name ?? "");
		if ("error" in r) throw validation(r.error);
		logo = r.svg;
	}
	await db
		.update(schema.domains)
		.set({ bimi_logo: logo, bimi_updated_at: logo ? iso() : null })
		.where(eq(schema.domains.id, id));
}

/** A domain's logo for /bimi/<name>.svg, when it has one. */
export async function bimiLogo(name: string): Promise<string | null> {
	const d = await db
		.select({ logo: schema.domains.bimi_logo })
		.from(schema.domains)
		.where(eq(schema.domains.name, name.toLowerCase()))
		.get();
	return d?.logo ?? null;
}
