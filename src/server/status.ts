import { sql } from "drizzle-orm";
import type { EmailStatus } from "./db/schema";

/**
 * Which status wins when events arrive out of order (SNS doesn't keep order): a later, more
 * final state never goes back to an earlier one.
 */
export const STATUS_RANK: Record<EmailStatus, number> = {
	canceled: 0,
	scheduled: 1,
	queued: 2,
	sending: 3,
	sent: 4,
	delivery_delayed: 5,
	delivered: 6,
	suppressed: 7,
	failed: 7,
	soft_bounced: 7,
	bounced: 8,
	complained: 9,
};

const rankCase = (column: string) =>
	`CASE ${column} ${Object.entries(STATUS_RANK)
		.map(([s, r]) => `WHEN '${s}' THEN ${r}`)
		.join(" ")} ELSE 0 END`;

/** SQL: the email's status, moved to `next` only if `next` ranks higher. */
export const advanceStatus = (next: EmailStatus) =>
	sql.raw(
		`CASE WHEN ${STATUS_RANK[next]} > ${rankCase("status")} THEN '${next}' ELSE status END`,
	);
