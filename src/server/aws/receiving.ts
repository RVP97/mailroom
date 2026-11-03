import { createHash } from "node:crypto";
import type { AwsConfig } from "./ses";
import { signV4 } from "./sigv4";
import { AwsQueryError, queryCall, tag } from "./sns";

/**
 * Receiving email with SES: its receipt rules (SES v1's query API, the only one that has them)
 * and the S3 bucket SES drops each message in. S3 is only a drop box: Mailroom copies a message
 * to R2 as soon as SES says it arrived and deletes it from S3, and a lifecycle rule clears
 * anything left after a day.
 */

const V1 = "2010-12-01";

const ses = (aws: AwsConfig, params: Record<string, string>) =>
	queryCall(aws, "ses", { ...params, Version: V1 });

export const alreadyExists = (error: unknown) =>
	error instanceof AwsQueryError && /AlreadyExists/.test(error.code);
export const notThere = (error: unknown) =>
	error instanceof AwsQueryError && /NotExist|NotFound/.test(error.code);

/** The account's active receipt rule set (only one can be active per region), or null. */
export async function activeRuleSet(aws: AwsConfig): Promise<string | null> {
	const xml = await ses(aws, { Action: "DescribeActiveReceiptRuleSet" });
	const metadata = /<Metadata>([\s\S]*?)<\/Metadata>/.exec(xml)?.[1];
	return metadata ? tag(metadata, "Name") : null;
}

export async function createRuleSet(aws: AwsConfig, name: string) {
	try {
		await ses(aws, { Action: "CreateReceiptRuleSet", RuleSetName: name });
	} catch (error) {
		if (!alreadyExists(error)) throw error;
	}
}

export const activateRuleSet = (aws: AwsConfig, name: string) =>
	ses(aws, { Action: "SetActiveReceiptRuleSet", RuleSetName: name });

export interface ReceiptRule {
	ruleSet: string;
	name: string;
	/** Domains (every address at them) or addresses. */
	recipients: string[];
	bucket: string;
	prefix: string;
	topicArn: string;
}

/** A rule: store the message in the bucket and tell the topic. Already there is fine. */
export async function createReceiptRule(aws: AwsConfig, r: ReceiptRule) {
	const params: Record<string, string> = {
		Action: "CreateReceiptRule",
		RuleSetName: r.ruleSet,
		"Rule.Name": r.name,
		"Rule.Enabled": "true",
		// SES's spam and virus checks: their verdicts come with each message.
		"Rule.ScanEnabled": "true",
		"Rule.TlsPolicy": "Optional",
		"Rule.Actions.member.1.S3Action.BucketName": r.bucket,
		"Rule.Actions.member.1.S3Action.ObjectKeyPrefix": r.prefix,
		"Rule.Actions.member.1.S3Action.TopicArn": r.topicArn,
	};
	r.recipients.forEach((to, i) => {
		params[`Rule.Recipients.member.${i + 1}`] = to;
	});
	try {
		await ses(aws, params);
	} catch (error) {
		if (!alreadyExists(error)) throw error;
	}
}

/** Removes a rule; one that isn't there is fine. */
export async function deleteReceiptRule(aws: AwsConfig, ruleSet: string, name: string) {
	try {
		await ses(aws, { Action: "DeleteReceiptRule", RuleSetName: ruleSet, RuleName: name });
	} catch (error) {
		if (!notThere(error)) throw error;
	}
}

/** Rule names: letters, numbers, ., _ and -, starting and ending with a letter or number. */
export const ruleName = (domain: string) =>
	`mailroom-${domain.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`
		.slice(0, 64)
		.replace(/[^a-z0-9]+$/, "");

// ── S3 ─────────────────────────────────────────────────────────────────────

/** S3 answered with an error. */
export class S3Error extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(`S3 ${code || status}: ${message}`);
		this.name = "S3Error";
	}
}

async function s3(
	aws: AwsConfig,
	method: "GET" | "PUT" | "DELETE",
	bucket: string,
	path: string,
	o: { body?: string; md5?: boolean } = {},
): Promise<Response> {
	const url = new URL(`https://${bucket}.s3.${aws.region}.amazonaws.com${path}`);
	const body = o.body ?? "";
	const headers = await signV4({
		method,
		url,
		body,
		region: aws.region,
		service: "s3",
		credentials: aws.credentials,
		contentType: body ? "application/xml" : "application/octet-stream",
		// Lifecycle rules (and a few other calls) are refused without the body's MD5, and S3
		// refuses it unsigned ("headers present in the request which were not signed").
		headers: o.md5
			? { "content-md5": createHash("md5").update(body).digest("base64") }
			: undefined,
	});
	const res = await (aws.fetcher ?? fetch)(url, {
		method,
		headers,
		body: body || undefined,
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new S3Error(
			res.status,
			/<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? "",
			/<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? text.slice(0, 200),
		);
	}
	return res;
}

/** The drop box's name: bucket names are global, so it carries the account and region. */
export const bucketName = (account: string, region: string) =>
	`mailroom-inbound-${account}-${region}`.slice(0, 63);

/** Creates the bucket (already ours is fine), lets SES write to it and expires what's left. */
export async function setUpBucket(aws: AwsConfig, bucket: string, account: string) {
	try {
		await s3(aws, "PUT", bucket, "/", {
			body:
				aws.region === "us-east-1"
					? ""
					: `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${aws.region}</LocationConstraint></CreateBucketConfiguration>`,
		});
	} catch (error) {
		if (!(error instanceof S3Error && error.code === "BucketAlreadyOwnedByYou")) throw error;
	}
	await s3(aws, "PUT", bucket, "/?policy", {
		body: JSON.stringify({
			Version: "2012-10-17",
			Statement: [
				{
					Sid: "MailroomSesReceiving",
					Effect: "Allow",
					Principal: { Service: "ses.amazonaws.com" },
					Action: "s3:PutObject",
					Resource: `arn:aws:s3:::${bucket}/*`,
					Condition: { StringEquals: { "AWS:SourceAccount": account } },
				},
			],
		}),
	});
	await s3(aws, "PUT", bucket, "/?lifecycle", {
		md5: true,
		body: `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Rule><ID>mailroom-drop-box</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule></LifecycleConfiguration>`,
	});
}

/** A message SES stored: its raw bytes. */
export async function getObject(aws: AwsConfig, bucket: string, key: string) {
	const res = await s3(aws, "GET", bucket, `/${key}`);
	return new Uint8Array(await res.arrayBuffer());
}

export async function deleteObject(aws: AwsConfig, bucket: string, key: string) {
	try {
		await s3(aws, "DELETE", bucket, `/${key}`);
	} catch (error) {
		if (!(error instanceof S3Error && error.status === 404)) throw error;
	}
}

/**
 * The topic's policy with SES allowed to publish this account's receipt notifications to it,
 * keeping every statement it had (null: already allowed).
 */
export function withSesPublish(policy: string | null, topicArn: string, account: string) {
	const doc = (policy ? JSON.parse(policy) : { Version: "2008-10-17", Statement: [] }) as {
		Version?: string;
		Statement?: { Sid?: string }[];
	};
	const statements = doc.Statement ?? [];
	if (statements.some((s) => s.Sid === "MailroomSesReceiving")) return null;
	if (!policy)
		// SNS's own default statement: the account keeps managing its topic.
		statements.push({
			Sid: "__default_statement_ID",
			Effect: "Allow",
			Principal: { AWS: "*" },
			Action: [
				"SNS:GetTopicAttributes",
				"SNS:SetTopicAttributes",
				"SNS:AddPermission",
				"SNS:RemovePermission",
				"SNS:DeleteTopic",
				"SNS:Subscribe",
				"SNS:ListSubscriptionsByTopic",
				"SNS:Publish",
			],
			Resource: topicArn,
			Condition: { StringEquals: { "AWS:SourceOwner": account } },
		} as { Sid: string });
	statements.push({
		Sid: "MailroomSesReceiving",
		Effect: "Allow",
		Principal: { Service: "ses.amazonaws.com" },
		Action: "SNS:Publish",
		Resource: topicArn,
		Condition: { StringEquals: { "AWS:SourceAccount": account } },
	} as { Sid: string });
	return JSON.stringify({ ...doc, Statement: statements });
}
