import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
	type AwsConfig,
	arn,
	associateWithTenant,
	createIdentity,
	deleteIdentity,
	disassociateFromTenant,
	getAccount,
	getIdentity,
	putMailFrom,
} from "./aws/ses";
import { callerAccount, createTopic, subscribeHttps } from "./aws/sns";
import { type CredentialsError, defaultCredentialsError } from "./aws-health";
import { type AwsCosts, costsKept } from "./costs";
import { db, schema } from "./db";
import { adminEmails, aws, awsConfigured, awsFetcher, baseUrl, region } from "./env";
import { ApiError, validation } from "./errors";
import { forgetOrg } from "./org";
import {
	brandsOfOrganization,
	decryptSecret,
	encryptSecret,
	forgetOwnAccounts,
	ownAccountRow,
	toAccount,
} from "./org-aws";
import {
	accountId,
	exists,
	notFoundAtSes,
	type SesTarget,
	SNS_TOPIC,
	sendingOf,
	sesTarget,
	setUpOrganization,
	snsEndpoint,
	tenantFor,
} from "./provision";
import { getSetting } from "./settings";
import { iso } from "./time";

/**
 * Managing an organization's own SES account (org-aws.ts), from Settings › Amazon SES account:
 * connecting it, replacing its keys, going back to the deployment's account, and moving an
 * organization that already has domains. A move verifies every domain in the new account first
 * (new DKIM records, shown on each domain's page) while the old account keeps sending; once all
 * are verified (the cron checks every 5 minutes) sending switches, receiving rules follow, and
 * what Mailroom made in the old account is removed.
 */

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const awsMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What an organization's brands have in the account they use: domains, SMTP users, receiving. */
async function accountBound(organizationId: string) {
	const brands = await brandsOfOrganization(organizationId);
	const [domains, smtp] = await Promise.all([
		db.select().from(schema.domains).where(inArray(schema.domains.organization_id, brands)),
		db
			.select({ id: schema.smtpCredentials.organization_id })
			.from(schema.smtpCredentials)
			.where(inArray(schema.smtpCredentials.organization_id, brands)),
	]);
	return { brands, domains, smtp: smtp.length };
}

const moveRow = async (organizationId: string) =>
	(await db
		.select()
		.from(schema.orgAwsMoves)
		.where(eq(schema.orgAwsMoves.organization_id, organizationId))
		.get()) ?? null;

export interface MoveView {
	/** null: back to the deployment's account. */
	to: { accountId: string; region: string } | null;
	startedAt: string;
	error: string | null;
	subscriptionConfirmedAt: string | null;
	domains: { id: string; name: string; brand_id: string; verified: boolean }[];
}

export interface OwnAccountStatus {
	connected: boolean;
	accountId: string | null;
	region: string | null;
	/** The access key's id, shortened (AKIA…WXYZ). */
	accessKey: string | null;
	topicArn: string | null;
	subscriptionConfirmedAt: string | null;
	lastEventAt: string | null;
	connectedAt: string | null;
	/** SES's sends a second there, as last read (each account is paced apart). */
	maxSendRate: number | null;
	/** AWS refused its keys while sending: emails wait until they work again. */
	credentialsError: CredentialsError | null;
	/** Its domains receive there (its own S3 drop box and rule set). */
	receivingSetUp: boolean;
	domains: number;
	smtp: number;
	/** SES's view of the account, when asked to check. */
	ses: Awaited<ReturnType<typeof getAccount>> | null;
	error: string | null;
	move: MoveView | null;
	/** The deployment's account, for comparison. */
	defaultRegion: string;
	endpoint: string;
}

export async function ownAccountStatus(
	organizationId: string,
	o: { check?: boolean } = {},
): Promise<OwnAccountStatus> {
	const [row, bound, move] = await Promise.all([
		ownAccountRow(organizationId),
		accountBound(organizationId),
		moveRow(organizationId),
	]);
	const status: OwnAccountStatus = {
		connected: !!row,
		accountId: row?.account_id ?? null,
		region: row?.region ?? null,
		accessKey: row ? `${row.access_key_id.slice(0, 4)}…${row.access_key_id.slice(-4)}` : null,
		topicArn: row?.topic_arn ?? null,
		subscriptionConfirmedAt: row?.subscription_confirmed_at ?? null,
		lastEventAt: row?.last_event_at ?? null,
		connectedAt: row?.created_at ?? null,
		maxSendRate: row?.max_send_rate ?? null,
		credentialsError: row
			? row.credentials_error
				? { message: row.credentials_error, at: row.credentials_error_at ?? "" }
				: null
			: await defaultCredentialsError(),
		receivingSetUp: !!row?.inbound_bucket,
		domains: bound.domains.length,
		smtp: bound.smtp,
		ses: null,
		error: null,
		move: move
			? {
					to: move.to_access_key_id
						? { accountId: move.to_account_id, region: move.to_region }
						: null,
					startedAt: move.started_at,
					error: move.error,
					subscriptionConfirmedAt: move.subscription_confirmed_at,
					domains: bound.domains
						.filter((d) => d.move_dkim_tokens)
						.map((d) => ({
							id: d.id,
							name: d.name,
							brand_id: d.organization_id,
							verified: d.move_status === "verified",
						})),
				}
			: null,
		defaultRegion: region(),
		endpoint: snsEndpoint(),
	};
	if (row && o.check)
		try {
			status.ses = await getAccount((await toAccount(row)).aws);
			const rate = status.ses.SendQuota?.MaxSendRate;
			if (rate && rate !== row.max_send_rate) {
				await db
					.update(schema.orgAws)
					.set({ max_send_rate: rate })
					.where(eq(schema.orgAws.organization_id, organizationId));
				forgetOwnAccounts();
				status.maxSendRate = rate;
			}
		} catch (error) {
			status.error = awsMessage(error);
		}
	return status;
}

interface CheckedKeys {
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	config: AwsConfig;
	account: string;
	maxSendRate: number | null;
}

/** Checks keys against STS and SES, and that the account is free for this organization. */
async function checkKeys(
	organizationId: string,
	input: { accessKeyId: string; secretAccessKey: string; region: string },
): Promise<CheckedKeys> {
	const accessKeyId = input.accessKeyId.trim();
	const secretAccessKey = input.secretAccessKey.trim();
	const awsRegion = input.region.trim().toLowerCase();
	if (!/^AKIA[A-Z0-9]{12,}$/.test(accessKeyId))
		throw validation("Use an IAM user's access key id (it starts with AKIA)");
	if (secretAccessKey.length < 30) throw validation("Paste the whole secret access key");
	if (!REGION_RE.test(awsRegion)) throw validation("Enter the SES region, like us-east-1");
	if (!/^https:\/\//.test(baseUrl()))
		throw validation("BETTER_AUTH_URL must be this deployment's public https URL");
	const isBrand = await db
		.select({ id: schema.brands.id })
		.from(schema.brands)
		.where(eq(schema.brands.id, organizationId))
		.get();
	if (isBrand) throw validation("Brands use their organization's account: set it there");
	const config: AwsConfig = {
		region: awsRegion,
		credentials: { accessKeyId, secretAccessKey },
		fetcher: awsFetcher(),
	};
	let account: string;
	try {
		account = await callerAccount(config);
	} catch (error) {
		throw new ApiError(422, "aws_keys_refused", `AWS refused these keys: ${awsMessage(error)}`);
	}
	let maxSendRate: number | null = null;
	try {
		maxSendRate = (await getAccount(config)).SendQuota?.MaxSendRate ?? null;
	} catch (error) {
		throw new ApiError(
			422,
			"aws_ses_refused",
			`The keys work, but SES in ${awsRegion} refused them (they need Mailroom's IAM policy): ${awsMessage(error)}`,
		);
	}
	// Each account (and region) is one organization's: its events topic says whose they are.
	if (awsConfigured() && account === (await accountId().catch(() => null)))
		throw validation(
			"That's this deployment's own AWS account, which every organization already uses",
		);
	const [taken, takenByMove] = await Promise.all([
		db
			.select({ id: schema.orgAws.organization_id })
			.from(schema.orgAws)
			.where(and(eq(schema.orgAws.account_id, account), eq(schema.orgAws.region, awsRegion)))
			.get(),
		db
			.select({ id: schema.orgAwsMoves.organization_id })
			.from(schema.orgAwsMoves)
			.where(
				and(
					eq(schema.orgAwsMoves.to_account_id, account),
					eq(schema.orgAwsMoves.to_region, awsRegion),
					isNotNull(schema.orgAwsMoves.to_access_key_id),
				),
			)
			.get(),
	]);
	if (
		(taken && taken.id !== organizationId) ||
		(takenByMove && takenByMove.id !== organizationId)
	)
		throw validation("That SES account is already another organization's in this region");
	return { accessKeyId, secretAccessKey, region: awsRegion, config, account, maxSendRate };
}

async function makeTopic(config: AwsConfig) {
	try {
		return await createTopic(config, SNS_TOPIC);
	} catch (error) {
		throw new ApiError(
			502,
			"aws_error",
			`The events topic couldn't be made (sns:CreateTopic): ${awsMessage(error)}`,
		);
	}
}

async function subscribe(config: AwsConfig, topicArn: string) {
	try {
		await subscribeHttps(config, topicArn, snsEndpoint());
	} catch (error) {
		throw new ApiError(
			502,
			"aws_error",
			`The events subscription couldn't be made (sns:Subscribe): ${awsMessage(error)}`,
		);
	}
}

const refuseWhileMoving = async (organizationId: string) => {
	if (await moveRow(organizationId))
		throw new ApiError(
			409,
			"moving_ses_account",
			"It's in the middle of a move to another SES account: wait for it, or cancel it first",
		);
};

const refuseSmtp = (smtp: number) => {
	if (smtp)
		throw new ApiError(
			409,
			"has_smtp",
			"Delete its SMTP credentials first: they're an IAM user in the account they were made in (make new ones after)",
		);
};

/**
 * Connects an organization's own SES account, or replaces its keys (the same account). Without
 * domains it switches at once (its brands' tenants are made there); with domains it starts a
 * move (startMove).
 */
export async function connectOrgAws(
	organizationId: string,
	input: { accessKeyId: string; secretAccessKey: string; region: string },
	userId?: string,
) {
	const keys = await checkKeys(organizationId, input);
	const existing = await ownAccountRow(organizationId);
	const now = iso();
	if (existing?.account_id === keys.account && existing.region === keys.region) {
		// New keys for the same account: nothing else changes, and sending resumes with them.
		await db
			.update(schema.orgAws)
			.set({
				access_key_id: keys.accessKeyId,
				secret_encrypted: await encryptSecret(keys.secretAccessKey),
				max_send_rate: keys.maxSendRate ?? existing.max_send_rate,
				credentials_error: null,
				credentials_error_at: null,
				updated_at: now,
			})
			.where(eq(schema.orgAws.organization_id, organizationId));
		forgetOwnAccounts();
		return ownAccountStatus(organizationId);
	}
	await refuseWhileMoving(organizationId);
	const bound = await accountBound(organizationId);
	refuseSmtp(bound.smtp);
	const topicArn = await makeTopic(keys.config);
	if (bound.domains.length)
		return startMove(organizationId, { keys, topicArn, existing: null }, bound, userId);
	const row = {
		organization_id: organizationId,
		access_key_id: keys.accessKeyId,
		secret_encrypted: await encryptSecret(keys.secretAccessKey),
		region: keys.region,
		account_id: keys.account,
		topic_arn: topicArn,
		subscription_confirmed_at: null,
		last_event_at: null,
		credentials_error: null,
		credentials_error_at: null,
		max_send_rate: keys.maxSendRate,
		costs: null,
		inbound_bucket: null,
		inbound_rule_set: null,
		created_by: userId ?? null,
		created_at: now,
		updated_at: now,
	};
	// Saved before subscribing: SNS's confirmation is matched by the topic.
	await db
		.insert(schema.orgAws)
		.values(row)
		.onConflictDoUpdate({ target: schema.orgAws.organization_id, set: row });
	forgetOwnAccounts();
	await subscribe(keys.config, topicArn);
	await setUpBrands(bound.brands);
	return ownAccountStatus(organizationId);
}

/**
 * Back to the deployment's account: at once without domains (what Mailroom made in the
 * organization's account stays there, unused), else a move.
 */
export async function disconnectOrgAws(organizationId: string, userId?: string) {
	const row = await ownAccountRow(organizationId);
	if (!row) return ownAccountStatus(organizationId);
	await refuseWhileMoving(organizationId);
	const bound = await accountBound(organizationId);
	refuseSmtp(bound.smtp);
	if (bound.domains.length) {
		if (!awsConfigured() || !(await getSetting("sns_topic_arn")))
			throw new ApiError(409, "aws_not_set_up", "The deployment's AWS account isn't set up");
		return startMove(organizationId, null, bound, userId);
	}
	await db.delete(schema.orgAws).where(eq(schema.orgAws.organization_id, organizationId));
	forgetOwnAccounts();
	if (awsConfigured()) await setUpBrands(bound.brands);
	return ownAccountStatus(organizationId);
}

/** Each brand's tenants and configuration sets in the account it now uses (failures stay on it). */
async function setUpBrands(brands: string[]) {
	for (const b of brands)
		await setUpOrganization(b).catch((error) =>
			console.error("org-aws: brand not set up", b, error),
		);
}

// ── Moves ──────────────────────────────────────────────────────────────────

type Move = typeof schema.orgAwsMoves.$inferSelect;

/** The account a move goes to, as a target for provision.ts. */
async function moveTarget(move: Move): Promise<SesTarget> {
	if (move.to_access_key_id && move.to_secret_encrypted) {
		const config: AwsConfig = {
			region: move.to_region,
			credentials: {
				accessKeyId: move.to_access_key_id,
				secretAccessKey: await decryptSecret(move.to_secret_encrypted),
			},
			fetcher: awsFetcher(),
		};
		return {
			aws: config,
			region: move.to_region,
			account: async () => move.to_account_id,
			topicArn: move.to_topic_arn,
			own: true,
		};
	}
	return {
		aws: aws(),
		region: region(),
		account: accountId,
		topicArn: await getSetting("sns_topic_arn"),
		own: false,
	};
}

type Domain = typeof schema.domains.$inferSelect;

/**
 * Starts moving an organization with domains: its brands' tenants and each domain's identity
 * (with its MAIL FROM and tenant) are made in the new account now; sending stays where it is
 * until every domain is verified there (checkMoves). `to` null: the deployment's account.
 */
async function startMove(
	organizationId: string,
	to: { keys: CheckedKeys; topicArn: string; existing: null } | null,
	bound: Awaited<ReturnType<typeof accountBound>>,
	userId?: string,
) {
	const toRegion = to?.keys.region ?? region();
	const current = await sesTarget(organizationId);
	// A receiving domain's MX names the region: it would stop receiving in another one.
	if (toRegion !== current.region && bound.domains.some((d) => d.receiving))
		throw validation(
			`Its domains that receive have their MX at SES in ${current.region}: move to an account in the same region, or turn receiving off first`,
		);
	const move: Move = {
		organization_id: organizationId,
		to_access_key_id: to?.keys.accessKeyId ?? null,
		to_secret_encrypted: to ? await encryptSecret(to.keys.secretAccessKey) : null,
		to_region: toRegion,
		to_account_id: to?.keys.account ?? (await accountId()),
		to_topic_arn: to?.topicArn ?? null,
		subscription_confirmed_at: null,
		max_send_rate: to?.keys.maxSendRate ?? null,
		error: null,
		started_by: userId ?? null,
		started_at: iso(),
	};
	// Saved before subscribing: SNS's confirmation is matched by the topic.
	await db.insert(schema.orgAwsMoves).values(move);
	try {
		if (to) await subscribe(to.keys.config, to.topicArn);
		const target = await moveTarget(move);
		for (const b of bound.brands) await setUpOrganization(b, { in: target });
		for (const d of bound.domains) await prepareDomain(target, d);
	} catch (error) {
		// Half a move helps nobody: what was made in the new account goes, and it can be tried again.
		await cancelMove(organizationId).catch((x) => console.error("org-aws: not undone", x));
		throw error instanceof ApiError
			? error
			: new ApiError(502, "aws_error", `The move couldn't start: ${awsMessage(error)}`);
	}
	return ownAccountStatus(organizationId);
}

/** A domain's identity in the account its organization is moving to. */
async function prepareDomain(target: SesTarget, d: Domain) {
	const sending = await sendingOf(d.organization_id);
	const configurationSet =
		(d.purpose === "marketing"
			? sending?.marketing_configuration_set
			: sending?.configuration_set) ?? undefined;
	let tokens: string[] = [];
	let owned = true;
	try {
		tokens =
			(await createIdentity(target.aws, d.name, configurationSet)).DkimAttributes?.Tokens ??
			[];
	} catch (error) {
		if (!exists(error)) throw error;
		owned = false;
		tokens = (await getIdentity(target.aws, d.name)).DkimAttributes?.Tokens ?? [];
	}
	if (owned && d.mail_from)
		await putMailFrom(target.aws, d.name, d.mail_from).catch((error) =>
			console.error("org-aws: MAIL FROM not set", d.name, error),
		);
	const tenant = sending ? tenantFor(sending, d.purpose) : null;
	if (tenant)
		try {
			await associateWithTenant(
				target.aws,
				tenant,
				arn(target.region, await target.account(), "identity", d.name),
			);
		} catch (error) {
			if (!exists(error)) throw error;
		}
	await db
		.update(schema.domains)
		.set({ move_dkim_tokens: tokens, move_status: "pending", move_ses_owned: owned })
		.where(eq(schema.domains.id, d.id));
	forgetOrg(d.organization_id);
}

/** Removes a domain's identity from the account its organization is moving to (provision.ts). */
export async function dropMovedIdentity(brandId: string, d: Domain) {
	const { moveFor } = await import("./org-aws");
	const move = await moveFor(brandId);
	if (move) {
		const target = await moveTarget(move);
		const sending = await sendingOf(d.organization_id);
		const tenant = sending ? tenantFor(sending, d.purpose) : null;
		if (tenant)
			await disassociateFromTenant(
				target.aws,
				tenant,
				arn(target.region, await target.account(), "identity", d.name),
			).catch((error) => {
				if (!notFoundAtSes(error)) throw error;
			});
		if (d.move_ses_owned)
			await deleteIdentity(target.aws, d.name).catch((error) => {
				if (!notFoundAtSes(error)) throw error;
			});
	}
	await db
		.update(schema.domains)
		.set({ move_dkim_tokens: null, move_status: null, move_ses_owned: null })
		.where(eq(schema.domains.id, d.id));
	forgetOrg(d.organization_id);
}

/** Stops a move: what it made in the new account goes; sending never left the old one. */
export async function cancelMove(organizationId: string) {
	const brands = await brandsOfOrganization(organizationId);
	const domains = await db
		.select()
		.from(schema.domains)
		.where(
			and(
				inArray(schema.domains.organization_id, brands),
				isNotNull(schema.domains.move_dkim_tokens),
			),
		);
	for (const d of domains)
		await dropMovedIdentity(d.organization_id, d).catch((error) =>
			console.error("org-aws: identity not removed", d.name, error),
		);
	await db
		.delete(schema.orgAwsMoves)
		.where(eq(schema.orgAwsMoves.organization_id, organizationId));
	return ownAccountStatus(organizationId);
}

/** Cron (every 5 minutes): each move's domains checked in the new account; done once all are. */
export async function checkMoves(now = Date.now()) {
	const moves = await db.select().from(schema.orgAwsMoves);
	for (const move of moves)
		try {
			if (await checkMove(move)) await completeMove(move.organization_id, now);
		} catch (error) {
			console.error("org-aws: move not checked", move.organization_id, error);
			await db
				.update(schema.orgAwsMoves)
				.set({ error: awsMessage(error).slice(0, 500) })
				.where(eq(schema.orgAwsMoves.organization_id, move.organization_id));
		}
}

/** Reads each pending domain's verification in the new account; true when all are verified. */
export async function checkMove(move: Move) {
	const target = await moveTarget(move);
	const brands = await brandsOfOrganization(move.organization_id);
	const domains = await db
		.select()
		.from(schema.domains)
		.where(
			and(
				inArray(schema.domains.organization_id, brands),
				isNotNull(schema.domains.move_dkim_tokens),
			),
		);
	let all = true;
	for (const d of domains) {
		if (d.move_status === "verified") continue;
		const identity = await getIdentity(target.aws, d.name);
		if (identity.VerifiedForSendingStatus)
			await db
				.update(schema.domains)
				.set({ move_status: "verified" })
				.where(eq(schema.domains.id, d.id));
		else all = false;
	}
	if (move.error)
		await db
			.update(schema.orgAwsMoves)
			.set({ error: null })
			.where(eq(schema.orgAwsMoves.organization_id, move.organization_id));
	return all;
}

/**
 * Every domain is verified in the new account: the old account's identities, tenant links and
 * receipt rules go, sending switches, receiving rules are made in the new account, and the
 * deployment's admins are told.
 */
export async function completeMove(organizationId: string, now = Date.now()) {
	const move = await moveRow(organizationId);
	if (!move) return;
	const brands = await brandsOfOrganization(organizationId);
	const domains = await db
		.select()
		.from(schema.domains)
		.where(inArray(schema.domains.organization_id, brands));
	const from = await sesTarget(organizationId);
	const { addReceivingRule, dropReceiving, receivingPlace } = await import("./inbound");
	const fromReceiving = await receivingPlace(organizationId).catch(() => null);
	const fromAccount = await from.account();
	for (const d of domains) {
		const sending = await sendingOf(d.organization_id);
		const tenant = sending ? tenantFor(sending, d.purpose) : null;
		try {
			if (tenant)
				await disassociateFromTenant(
					from.aws,
					tenant,
					arn(from.region, fromAccount, "identity", d.name),
				).catch((error) => {
					if (!notFoundAtSes(error)) throw error;
				});
			if (d.receiving) await dropReceiving(d, undefined, { place: fromReceiving });
			if (d.ses_owned)
				await deleteIdentity(from.aws, d.name).catch((error) => {
					if (!notFoundAtSes(error)) throw error;
				});
		} catch (error) {
			console.error("org-aws: old account not cleaned up", d.name, error);
		}
	}
	// Sending switches.
	if (move.to_access_key_id && move.to_secret_encrypted) {
		const existing = await ownAccountRow(organizationId);
		const at = iso(now);
		const row = {
			organization_id: organizationId,
			access_key_id: move.to_access_key_id,
			secret_encrypted: move.to_secret_encrypted,
			region: move.to_region,
			account_id: move.to_account_id,
			topic_arn: move.to_topic_arn,
			subscription_confirmed_at: move.subscription_confirmed_at,
			last_event_at: null,
			credentials_error: null,
			credentials_error_at: null,
			max_send_rate: move.max_send_rate,
			costs: null,
			inbound_bucket: null,
			inbound_rule_set: null,
			created_by: move.started_by,
			created_at: existing?.created_at ?? at,
			updated_at: at,
		};
		await db
			.insert(schema.orgAws)
			.values(row)
			.onConflictDoUpdate({ target: schema.orgAws.organization_id, set: row });
	} else await db.delete(schema.orgAws).where(eq(schema.orgAws.organization_id, organizationId));
	forgetOwnAccounts();
	for (const d of domains)
		await db
			.update(schema.domains)
			.set({
				dkim_tokens: d.move_dkim_tokens ?? d.dkim_tokens,
				dkim_status: "SUCCESS",
				ses_owned: d.move_ses_owned ?? false,
				region: move.to_region,
				// Another region: the MAIL FROM's MX changes (its domain page shows the new one).
				mail_from_status:
					d.mail_from && move.to_region !== d.region ? "PENDING" : d.mail_from_status,
				move_dkim_tokens: null,
				move_status: null,
				move_ses_owned: null,
			})
			.where(eq(schema.domains.id, d.id));
	await db
		.delete(schema.orgAwsMoves)
		.where(eq(schema.orgAwsMoves.organization_id, organizationId));
	await setUpBrands(brands);
	for (const d of domains)
		if (d.receiving)
			await addReceivingRule(d.organization_id, d.receiving_host ?? d.name).catch((error) =>
				console.error("org-aws: receiving not moved", d.name, error),
			);
	for (const b of brands) forgetOrg(b);
	await tellAdmins(organizationId, move).catch((error) =>
		console.error("org-aws: admins not emailed", error),
	);
}

async function tellAdmins(organizationId: string, move: Move) {
	const org = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.get();
	const { sendSystemEmail, systemLayout } = await import("./system-email");
	const name = org?.name ?? organizationId;
	const subject = `${name} moved to ${move.to_access_key_id ? "its own SES account" : "the deployment's SES account"}`;
	const body = systemLayout({
		title: subject,
		lines: [
			`Every domain of ${name} is verified in SES account ${move.to_account_id} (${move.to_region}), and its emails go through it from now on.`,
			"The old DKIM records can be deleted from DNS. Make new SMTP credentials if its apps used them.",
		],
		button: { label: "Open Mailroom", url: baseUrl() },
	});
	await Promise.allSettled(adminEmails().map((to) => sendSystemEmail({ to, subject, ...body })));
}

// ── Hourly and on demand ───────────────────────────────────────────────────

/** Cron (hourly): each organization account's send rate, as SES says it now. */
export async function refreshOwnAccounts() {
	const rows = await db.select().from(schema.orgAws);
	for (const row of rows)
		try {
			const rate = (await getAccount((await toAccount(row)).aws)).SendQuota?.MaxSendRate;
			if (rate && rate !== row.max_send_rate)
				await db
					.update(schema.orgAws)
					.set({ max_send_rate: rate })
					.where(eq(schema.orgAws.organization_id, row.organization_id));
		} catch (error) {
			console.error("org-aws: account not read", row.organization_id, error);
		}
	forgetOwnAccounts();
}

/** The organization's own account's AWS costs (Cost Explorer), kept a day like the deployment's. */
export async function ownAccountCosts(
	organizationId: string,
	o: { force?: boolean } = {},
): Promise<AwsCosts | null> {
	const row = await ownAccountRow(organizationId);
	if (!row) return null;
	let cached: AwsCosts | null = null;
	try {
		cached = row.costs ? (JSON.parse(row.costs) as AwsCosts) : null;
	} catch {}
	return costsKept({
		aws: (await toAccount(row)).aws,
		cached,
		force: o.force,
		save: (costs) =>
			db
				.update(schema.orgAws)
				.set({ costs: JSON.stringify(costs) })
				.where(eq(schema.orgAws.organization_id, organizationId)),
	});
}
