import { and, eq } from "drizzle-orm";
import { unsuppressAtSes } from "./aws/ses";
import { db, schema } from "./db";
import { aws, awsConfigured } from "./env";
import { validation } from "./errors";
import { ownAccount } from "./org-aws";
import { iso } from "./time";

/** An organization's suppression list: addresses it never sends to. */

export async function addSuppression(organizationId: string, address: string, detail?: string) {
	const a = address.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) throw validation("Enter an email address");
	await db
		.insert(schema.suppressions)
		.values({
			organization_id: organizationId,
			address: a,
			reason: "manual",
			detail: detail ?? null,
			created_at: iso(),
		})
		.onConflictDoNothing();
}

/**
 * Takes an address off the list (and off SES's own account-wide list, where a bounce or a
 * complaint also put it: otherwise SES would keep dropping it).
 */
export async function removeSuppression(organizationId: string, address: string) {
	const a = address.trim().toLowerCase();
	await db
		.delete(schema.suppressions)
		.where(
			and(
				eq(schema.suppressions.organization_id, organizationId),
				eq(schema.suppressions.address, a),
			),
		);
	const own = await ownAccount(organizationId);
	if (own || awsConfigured())
		await unsuppressAtSes(own?.aws ?? aws(), a).catch((error) =>
			console.error("suppressions: SES kept it", error),
		);
}
