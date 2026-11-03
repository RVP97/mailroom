import { and, eq } from "drizzle-orm";
import { explainBounce } from "../lib/bounces";
import { maskDigits } from "../lib/roles";
import { type AccessChannel, logAccess } from "./access-log";
import { undeliverable } from "./address-checks";
import { brandIds, brandNames } from "./brands";
import { db, schema } from "./db";
import { validation } from "./errors";
import { type FirewallRule, firewallBlocks, getFirewall, RULE_LABEL } from "./firewall";
import { inScope, listEmails } from "./queries";

/**
 * Everything about one recipient across the organization's brands, for support ("did my code
 * arrive?"): whether they can receive now and why not, their suppressions and unsubscribes, what
 * the firewall says, and the last emails sent to them. Every lookup is logged.
 */
export async function lookupRecipient(
	organizationId: string,
	address: string,
	who: { channel: AccessChannel; userId?: string | null; actor?: string | null },
	o: { skipDns?: boolean; now?: number; maskDigits?: boolean } = {},
) {
	const a = address.trim().toLowerCase();
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) throw validation("That isn't an email address");
	const ids = await brandIds(organizationId);
	const [names, suppressions, unsubscribes, emails, blocked, dead] = await Promise.all([
		brandNames(ids),
		db
			.select()
			.from(schema.suppressions)
			.where(
				and(
					inScope(schema.suppressions.organization_id, { org: organizationId }),
					eq(schema.suppressions.address, a),
				),
			),
		db
			.select()
			.from(schema.unsubscribes)
			.where(
				and(
					inScope(schema.unsubscribes.organization_id, { org: organizationId }),
					eq(schema.unsubscribes.address, a),
				),
			),
		listEmails({ org: organizationId }, { search: a, limit: 50 }),
		Promise.all(
			ids.map(
				async (id) => [id, (await firewallBlocks(await getFirewall(id), [a]))[a]] as const,
			),
		),
		o.skipDns
			? Promise.resolve({} as Record<string, string>)
			: undeliverable([a], { now: o.now }),
	]);
	await logAccess({
		organizationId,
		action: "recipient_lookup",
		subject: a,
		channel: who.channel,
		userId: who.userId,
		actor: who.actor,
		now: o.now,
	});
	const walls = blocked.filter(([, rule]) => rule) as [string, FirewallRule][];
	// Only emails really to this address (the search also matches a part of one).
	const mine = emails.data.filter((e) =>
		[...e.to, ...(e.cc ?? []), ...(e.bcc ?? [])].some((x) => x.toLowerCase().includes(a)),
	);
	const last = mine[0] ?? null;
	const lastBounce = mine.find((e) => e.status === "bounced" || e.last_event === "bounced");
	const reasons = [
		...suppressions.map(
			(s) =>
				`Suppressed for ${names.get(s.organization_id) ?? "a brand"} (${s.reason === "bounce" ? "it bounced" : s.reason === "complaint" ? "marked as spam" : "added by hand"})`,
		),
		...walls.map(
			([id, rule]) =>
				`Blocked by ${ids.length > 1 ? `${names.get(id) ?? "a brand"}'s` : "the"} firewall: ${RULE_LABEL[rule]}`,
		),
		...(dead[a] ? [`The address ${dead[a]}`] : []),
	];
	return {
		object: "recipient" as const,
		address: a,
		can_receive: reasons.length === 0,
		reasons,
		/** Unsubscribed from these groups only: other emails still reach them. */
		unsubscribed: unsubscribes.map((u) => ({
			brand_id: u.organization_id,
			brand: names.get(u.organization_id) ?? null,
			group: u.group,
			created_at: u.created_at,
		})),
		suppressions: suppressions.map((s) => ({
			brand_id: s.organization_id,
			brand: names.get(s.organization_id) ?? null,
			reason: s.reason,
			detail: s.detail,
			email_id: s.email_id,
			created_at: s.created_at,
			explanation:
				s.reason === "bounce"
					? explainBounce({ type: "Permanent", message: s.detail, recipient: a })
					: null,
		})),
		/** The brands whose firewall blocks this address. */
		firewall: walls.map(([id, rule]) => ({
			brand_id: id,
			brand: names.get(id) ?? null,
			rule,
			reason: RULE_LABEL[rule],
		})),
		last_status: last
			? { status: last.status, last_event: last.last_event, at: last.created_at }
			: null,
		last_bounce_id: lastBounce?.id ?? null,
		emails: mine.map((e) => ({
			id: e.id,
			brand_id: e.organization_id,
			subject: o.maskDigits ? maskDigits(e.subject) : e.subject,
			status: e.status,
			last_event: e.last_event,
			dropped: e.dropped,
			open_count: e.open_count,
			click_count: e.click_count,
			created_at: e.created_at,
		})),
	};
}

export type RecipientLookup = Awaited<ReturnType<typeof lookupRecipient>>;
