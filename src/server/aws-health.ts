import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { adminEmails, baseUrl } from "./env";
import { forgetOwnAccounts, ownAccount } from "./org-aws";
import { getSetting, setSetting } from "./settings";
import { iso } from "./time";

/**
 * When AWS refuses an account's keys while sending (deactivated, deleted, a wrong secret, a
 * policy without ses:SendRawEmail), nothing from that account can go until someone fixes them.
 * Its emails wait in the queue (send.ts, markRefused) instead of failing, the deployment's admins
 * get one email, and the error shows on the AWS page or the organization's SES card. The first
 * send that works clears it.
 */

export interface CredentialsError {
	message: string;
	at: string;
}

/** The deployment's own keys' last refusal (null: they work, as far as sends show). */
export async function defaultCredentialsError(): Promise<CredentialsError | null> {
	const raw = await getSetting("aws_credentials_error");
	if (!raw) return null;
	try {
		return JSON.parse(raw) as CredentialsError;
	} catch {
		return null;
	}
}

/** AWS refused the keys a brand sends with: kept, and the admins told the first time. */
export async function credentialsRefused(brandId: string, message: string, now = Date.now()) {
	const own = await ownAccount(brandId);
	const at = iso(now);
	let first: boolean;
	if (own) {
		first = !own.row.credentials_error;
		if (first)
			await db
				.update(schema.orgAws)
				.set({ credentials_error: message.slice(0, 500), credentials_error_at: at })
				.where(eq(schema.orgAws.organization_id, own.organizationId));
		forgetOwnAccounts();
	} else {
		first = !(await defaultCredentialsError());
		if (first)
			await setSetting(
				"aws_credentials_error",
				JSON.stringify({ message: message.slice(0, 500), at }),
			);
	}
	if (first)
		await tellAdmins(own ? await organizationName(own.organizationId) : null, message).catch(
			(error) => console.error("aws-health: admins not emailed", error),
		);
}

/** A send went through: the account's keys work again. */
export async function credentialsWorked(brandId: string) {
	const own = await ownAccount(brandId);
	if (own) {
		if (!own.row.credentials_error) return;
		await db
			.update(schema.orgAws)
			.set({ credentials_error: null, credentials_error_at: null })
			.where(eq(schema.orgAws.organization_id, own.organizationId));
		forgetOwnAccounts();
		return;
	}
	if (await defaultCredentialsError()) await setSetting("aws_credentials_error", "");
}

async function organizationName(id: string) {
	const row = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, id))
		.get();
	return row?.name ?? id;
}

async function tellAdmins(organization: string | null, message: string) {
	const { sendSystemEmail, systemLayout } = await import("./system-email");
	const subject = organization
		? `AWS refused ${organization}'s SES keys`
		: "AWS refused Mailroom's SES keys";
	const body = systemLayout({
		title: subject,
		lines: [
			`Amazon SES answered: ${message}`,
			organization
				? `Emails from ${organization}'s brands are waiting in the queue and go out once its keys work again: replace them in its Settings › Amazon SES account.`
				: "Emails are waiting in the queue and go out once the keys work again: check the IAM user's access key (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) and its policy.",
			"Emails waiting more than 3 days are marked failed.",
		],
		button: { label: "Open Mailroom", url: baseUrl() },
	});
	await Promise.allSettled(adminEmails().map((to) => sendSystemEmail({ to, subject, ...body })));
}
