import { eq } from "drizzle-orm";
import { db, schema } from "./db";
import { iso } from "./time";

/** The deployment's settings (app_settings), read through a short in-memory cache. */
export type SettingKey =
	| "aws_account_id"
	| "sns_topic_arn"
	| "sns_subscription_confirmed_at"
	| "sns_last_event_at"
	/** When the configuration sets stopped asking SES for opens and clicks: Mailroom tracks
	 * them itself from then on (src/server/tracking.ts). */
	| "own_tracking_at"
	/** Receiving (src/server/inbound.ts): the S3 drop box, the receipt rule set Mailroom's rules
	 * are in, and the Mailroom address domain's DKIM tokens. */
	| "inbound_bucket"
	| "inbound_rule_set"
	| "inbound_set_up_at"
	| "inbound_dkim_tokens"
	/** The AWS account's costs from Cost Explorer, as JSON (src/server/costs.ts). */
	| "aws_costs"
	/** The deployment's sending limits, as JSON (src/server/sending-limits.ts). */
	| "sending_limits"
	/** Gmail Postmaster Tools (src/server/postmaster.ts): the connected Google account. */
	| "postmaster_refresh_token"
	| "postmaster_account"
	| "postmaster_connected_at"
	/** AWS refused the deployment's keys while sending (src/server/aws-health.ts): JSON
	 * { message, at }, or "" once a send works again. */
	| "aws_credentials_error";

const cache = new Map<string, { value: string | null; until: number }>();
const TTL_MS = 30_000;

export async function getSetting(key: SettingKey): Promise<string | null> {
	const hit = cache.get(key);
	if (hit && hit.until > Date.now()) return hit.value;
	const row = await db
		.select({ value: schema.appSettings.value })
		.from(schema.appSettings)
		.where(eq(schema.appSettings.key, key))
		.get();
	const value = row?.value ?? null;
	cache.set(key, { value, until: Date.now() + TTL_MS });
	return value;
}

export async function setSetting(key: SettingKey, value: string) {
	const row = { key, value, updated_at: iso() };
	await db
		.insert(schema.appSettings)
		.values(row)
		.onConflictDoUpdate({ target: schema.appSettings.key, set: row });
	cache.set(key, { value, until: Date.now() + TTL_MS });
}

export const clearSettingsCache = () => cache.clear();
