import { raw } from "./db";

/**
 * The day's counters (daily_stats per brand, domain_stats per brand and sending domain) behind
 * Overview. Each event adds one to both.
 */

export type Counter =
	| "sent"
	| "delivered"
	| "bounced"
	| "soft_bounced"
	| "complained"
	| "opened"
	| "clicked"
	| "failed"
	| "delayed"
	| "suppressed";

/** The From address's domain: "Acme <hello@mail.acme.com>" → mail.acme.com. */
export function senderDomain(from: string): string {
	const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
	return address.split("@")[1]?.trim().toLowerCase() ?? "";
}

/**
 * One more in a counter, for the brand and for its sending domain. With `onlyIfNull`, only when
 * the email's column is still empty (first open, first click), so it must run before the email
 * is updated.
 */
export function bump(
	organizationId: string,
	day: string,
	from: string,
	counter: Counter,
	onlyIfNull?: { emailId: string; column: "opened_at" | "clicked_at" },
) {
	const domain = senderDomain(from);
	const when = onlyIfNull
		? `WHERE (SELECT ${onlyIfNull.column} FROM emails WHERE id = ?3) IS NULL`
		: "";
	const daily = onlyIfNull
		? raw(
				`INSERT INTO daily_stats (organization_id, day, ${counter})
				SELECT ?1, ?2, 1 ${when}
				ON CONFLICT (organization_id, day) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
				onlyIfNull.emailId,
			)
		: raw(
				`INSERT INTO daily_stats (organization_id, day, ${counter}) VALUES (?1, ?2, 1)
				ON CONFLICT (organization_id, day) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
			);
	if (!domain) return [daily];
	const byDomain = onlyIfNull
		? raw(
				`INSERT INTO domain_stats (organization_id, day, domain, ${counter})
				SELECT ?1, ?2, ?4, 1 ${when}
				ON CONFLICT (organization_id, day, domain) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
				onlyIfNull.emailId,
				domain,
			)
		: raw(
				`INSERT INTO domain_stats (organization_id, day, domain, ${counter}) VALUES (?1, ?2, ?3, 1)
				ON CONFLICT (organization_id, day, domain) DO UPDATE SET ${counter} = ${counter} + 1`,
				organizationId,
				day,
				domain,
			);
	return [daily, byDomain];
}
