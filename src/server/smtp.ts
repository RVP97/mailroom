import { and, eq, ne } from "drizzle-orm";
import type { AwsConfig } from "./aws/ses";
import { queryCall, tag } from "./aws/sns";
import { db, schema } from "./db";
import { aws, awsConfigured, region } from "./env";
import { ApiError } from "./errors";
import { awsFor, ownAccount } from "./org-aws";
import { getSetting } from "./settings";
import { iso } from "./time";

/**
 * SES SMTP credentials for an organization, made from the dashboard in one click: an IAM user
 * (path /mailroom-smtp/) that can only send, and only from the organization's domains, and its
 * access key. The SMTP username is the key's id; the password is derived from its secret
 * (AWS's documented algorithm) and shown once.
 *
 * Mailroom's own IAM user may create such users only with the «mailroom-smtp-boundary»
 * permissions boundary (ses:SendRawEmail and nothing else), so whatever policy it puts on them,
 * they can never do more than send email.
 */

export const SMTP_PATH = "/mailroom-smtp/";
export const SMTP_BOUNDARY = "mailroom-smtp-boundary";
const POLICY_NAME = "mailroom-smtp";
const VERSION = "2010-05-08";

/** IAM in the account the brand sends from (its organization's own, or the deployment's). */
const iamFor = (a: AwsConfig) => (params: Record<string, string>) =>
	queryCall(a, "iam", { Version: VERSION, ...params });

const missing = (error: unknown) => error instanceof Error && /NoSuchEntity/.test(error.message);
const already = (error: unknown) =>
	error instanceof Error && /EntityAlreadyExists/.test(error.message);

/** The SES SMTP password of an access key's secret, for one region. */
export async function smtpPassword(secretAccessKey: string, smtpRegion: string) {
	const enc = new TextEncoder();
	const sign = async (key: Uint8Array, data: string) =>
		new Uint8Array(
			await crypto.subtle.sign(
				"HMAC",
				await crypto.subtle.importKey(
					"raw",
					key as BufferSource,
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["sign"],
				),
				enc.encode(data),
			),
		);
	let key = await sign(enc.encode(`AWS4${secretAccessKey}`), "11111111");
	for (const part of [smtpRegion, "ses", "aws4_request", "SendRawEmail"])
		key = await sign(key, part);
	return btoa(String.fromCharCode(4, ...key));
}

/**
 * What the user may send: any address at the organization's verified domains or their
 * subdomains. Only verified ones: a pending domain proves nothing, and its subdomains could be
 * another brand's.
 */
export async function smtpPolicy(organizationId: string) {
	const domains = await db
		.select({ name: schema.domains.name })
		.from(schema.domains)
		.where(
			and(
				eq(schema.domains.organization_id, organizationId),
				eq(schema.domains.sending, true),
				eq(schema.domains.status, "verified"),
			),
		);
	const from = domains.flatMap((d) => [`*@${d.name}`, `*@*.${d.name}`]);
	return JSON.stringify({
		Version: "2012-10-17",
		Statement: [
			{
				Effect: "Allow",
				Action: "ses:SendRawEmail",
				Resource: "*",
				// No domains yet: a condition nothing matches, so the user can't send at all.
				Condition: { StringLike: { "ses:FromAddress": from.length ? from : ["-"] } },
			},
		],
	});
}

/**
 * The brand's own IAM user, named from its id: a name from the slug (lowercased, cut to 64)
 * could come out the same for two organizations, and the second would take over the first's.
 */
const userName = (organizationId: string) =>
	`mailroom-smtp-${organizationId.replace(/[^a-zA-Z0-9_-]/g, "")}`.slice(0, 64);

/** Another brand's credentials on the same IAM user (named from a slug, before ids were used). */
async function sharedWith(organizationId: string, iamUser: string) {
	const other = await db
		.select({ id: schema.smtpCredentials.organization_id })
		.from(schema.smtpCredentials)
		.where(
			and(
				eq(schema.smtpCredentials.iam_user, iamUser),
				ne(schema.smtpCredentials.organization_id, organizationId),
			),
		)
		.get();
	return !!other;
}

export async function smtpCredentials(organizationId: string) {
	return (
		(await db
			.select()
			.from(schema.smtpCredentials)
			.where(eq(schema.smtpCredentials.organization_id, organizationId))
			.get()) ?? null
	);
}

/**
 * New credentials for the organization (replacing any it had): the username, and the password,
 * which is never kept.
 */
export async function createSmtpCredentials(organizationId: string, userId?: string) {
	const own = await ownAccount(organizationId);
	if (!own && !awsConfigured()) throw new ApiError(409, "aws_not_set_up", "AWS isn't configured");
	const account = own?.accountId ?? (await getSetting("aws_account_id"));
	if (!account)
		throw new ApiError(409, "aws_not_set_up", "An admin has to finish AWS setup first");
	const iam = iamFor(own?.aws ?? aws());
	const smtpRegion = own?.region ?? region();
	const org = await db
		.select({ id: schema.organization.id })
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.get();
	if (!org) throw new ApiError(404, "not_found", "Organization not found");
	const old = await smtpCredentials(organizationId);
	// An old user another brand also has moves to this brand's own (its old key goes below).
	const oldShared = !!old && (await sharedWith(organizationId, old.iam_user));
	const user = old && !oldShared ? old.iam_user : userName(organizationId);
	try {
		try {
			await iam({
				Action: "CreateUser",
				UserName: user,
				Path: SMTP_PATH,
				PermissionsBoundary: `arn:aws:iam::${account}:policy/${SMTP_BOUNDARY}`,
			});
		} catch (error) {
			if (!already(error)) throw error;
		}
		await iam({
			Action: "PutUserPolicy",
			UserName: user,
			PolicyName: POLICY_NAME,
			PolicyDocument: await smtpPolicy(organizationId),
		});
		const xml = await iam({ Action: "CreateAccessKey", UserName: user });
		const id = tag(xml, "AccessKeyId");
		const secret = tag(xml, "SecretAccessKey");
		if (!id || !secret) throw new Error("IAM returned no access key");
		// The old key stops working now that there's a new one.
		if (old && old.access_key_id !== id)
			await iam({
				Action: "DeleteAccessKey",
				UserName: old.iam_user,
				AccessKeyId: old.access_key_id,
			}).catch((error) => {
				if (!missing(error)) throw error;
			});
		const row = {
			organization_id: organizationId,
			iam_user: user,
			access_key_id: id,
			region: smtpRegion,
			created_at: iso(),
			created_by: userId ?? null,
		};
		await db
			.insert(schema.smtpCredentials)
			.values(row)
			.onConflictDoUpdate({ target: schema.smtpCredentials.organization_id, set: row });
		return { ...row, password: await smtpPassword(secret, row.region) };
	} catch (error) {
		if (error instanceof ApiError) throw error;
		const message = error instanceof Error ? error.message : String(error);
		throw new ApiError(
			502,
			"aws_error",
			/AccessDenied/.test(message)
				? `Mailroom's AWS user can't create SMTP users yet: run scripts/update-iam.sh once${own ? " in the organization's own account" : ""}`
				: message,
		);
	}
}

/** Deletes the organization's SMTP user: its credentials stop working at once. */
export async function deleteSmtpCredentials(organizationId: string) {
	const row = await smtpCredentials(organizationId);
	if (!row) return;
	const iam = iamFor(await awsFor(organizationId));
	const ignoreMissing = (error: unknown) => {
		if (!missing(error)) throw error;
	};
	try {
		// A user another brand also has (named from a slug): only this brand's key goes.
		if (await sharedWith(organizationId, row.iam_user)) {
			await iam({
				Action: "DeleteAccessKey",
				UserName: row.iam_user,
				AccessKeyId: row.access_key_id,
			}).catch(ignoreMissing);
			await db
				.delete(schema.smtpCredentials)
				.where(eq(schema.smtpCredentials.organization_id, organizationId));
			return;
		}
		const keys = await iam({ Action: "ListAccessKeys", UserName: row.iam_user }).catch(
			(error) => {
				ignoreMissing(error);
				return "";
			},
		);
		for (const [, id] of keys.matchAll(/<AccessKeyId>([^<]+)<\/AccessKeyId>/g))
			await iam({
				Action: "DeleteAccessKey",
				UserName: row.iam_user,
				AccessKeyId: id as string,
			}).catch(ignoreMissing);
		await iam({
			Action: "DeleteUserPolicy",
			UserName: row.iam_user,
			PolicyName: POLICY_NAME,
		}).catch(ignoreMissing);
		await iam({ Action: "DeleteUser", UserName: row.iam_user }).catch(ignoreMissing);
	} catch (error) {
		throw new ApiError(
			502,
			"aws_error",
			error instanceof Error ? error.message : String(error),
		);
	}
	await db
		.delete(schema.smtpCredentials)
		.where(eq(schema.smtpCredentials.organization_id, organizationId));
}

/** After a domain is added or removed: the SMTP user may send from exactly the domains there are. */
export async function syncSmtpPolicy(organizationId: string) {
	const row = await smtpCredentials(organizationId);
	if (!row) return;
	// Never this brand's domains on a user another brand also has: new credentials move it off.
	if (await sharedWith(organizationId, row.iam_user)) return;
	try {
		await iamFor(await awsFor(organizationId))({
			Action: "PutUserPolicy",
			UserName: row.iam_user,
			PolicyName: POLICY_NAME,
			PolicyDocument: await smtpPolicy(organizationId),
		});
	} catch (error) {
		console.error("smtp: policy not updated", error);
	}
}
