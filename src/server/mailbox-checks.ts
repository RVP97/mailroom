import { and, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { cfg } from "./env";
import { iso } from "./time";

/**
 * Paid mailbox checks with Emailable, for first-time recipients only. The free checks
 * (address-checks.ts) catch typos and dead domains, and SES Auto Validation catches some dead
 * mailboxes, but a mistyped Gmail address (a domain that's fine, a mailbox that isn't) still
 * bounces once. So before an address that nobody has delivered to yet gets its first email,
 * Emailable is asked whether the mailbox exists, and the answer is kept for every organization:
 * - an address SES delivered to is never checked (mailbox_checks "delivered");
 * - each answer is kept (KEEP_MS), so an address costs one check, not one per email;
 * - at most MAX_CHECKS per send and EMAILABLE_MONTHLY_LIMIT a month; past that, addresses go
 *   through unchecked, as do those Emailable can't answer for (risky, unknown, errors).
 * Only "undeliverable" leaves an address out. Off without EMAILABLE_API_KEY.
 */

export type MailboxState = "delivered" | "deliverable" | "undeliverable" | "risky" | "unknown";

const DAY = 86_400_000;
const KEEP_MS: Record<MailboxState, number> = {
	delivered: 365 * DAY,
	deliverable: 180 * DAY,
	undeliverable: 90 * DAY,
	risky: 30 * DAY,
	unknown: DAY,
};
/** Fresh Emailable checks per send at most, so a batch of new addresses stays quick and cheap. */
export const MAX_CHECKS = 5;
/** Checks a month when EMAILABLE_MONTHLY_LIMIT isn't set (~$7.60 USD at $0.0076 each). */
export const DEFAULT_MONTHLY_LIMIT = 1000;

const REASONS: Record<string, string> = {
	rejected_email: "the mailbox doesn't exist",
	invalid_domain: "the domain doesn't exist",
	invalid_email: "isn't a valid address",
	invalid_smtp: "the mail server refuses it",
};

/** Why an address can't get email, from Emailable's reason. */
export const rejectedBecause = (reason: string | null) =>
	`${REASONS[reason ?? ""] ?? "can't receive email"} (checked with Emailable)`;

export const emailableConfigured = () => !!cfg().EMAILABLE_API_KEY;

const monthLimit = () => {
	const n = Number.parseInt(cfg().EMAILABLE_MONTHLY_LIMIT ?? "", 10);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MONTHLY_LIMIT;
};

/** What Emailable says of one address (null: no answer; let it through, keep nothing). */
export async function verifyMailbox(
	address: string,
	fetcher: typeof fetch = fetch,
): Promise<{ state: MailboxState; reason: string | null } | null> {
	const key = cfg().EMAILABLE_API_KEY;
	if (!key) return null;
	try {
		const res = await fetcher(
			`https://api.emailable.com/v1/verify?email=${encodeURIComponent(address)}&timeout=5`,
			{ headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) },
		);
		// 249: Emailable is still checking (a slow mail server). Not worth holding the send for.
		if (res.status === 249) return null;
		if (!res.ok) throw new Error(`Emailable ${res.status}`);
		const body = (await res.json()) as { state?: string; reason?: string };
		const state = body.state as MailboxState;
		if (!["deliverable", "undeliverable", "risky", "unknown"].includes(state)) return null;
		return { state, reason: body.reason ?? null };
	} catch (error) {
		console.error("mailbox-checks: Emailable failed", error);
		return null;
	}
}

async function kept(addresses: string[], now: number) {
	const m = schema.mailboxChecks;
	const out = new Map<string, { state: MailboxState; reason: string | null }>();
	for (let i = 0; i < addresses.length; i += 90) {
		const rows = await db
			.select()
			.from(m)
			.where(inArray(m.address, addresses.slice(i, i + 90)));
		for (const r of rows) {
			const state = r.state as MailboxState;
			if (Date.parse(r.checked_at) + (KEEP_MS[state] ?? DAY) > now)
				out.set(r.address, { state, reason: r.reason });
		}
	}
	return out;
}

/** Emailable checks made this month (UTC), against EMAILABLE_MONTHLY_LIMIT. */
async function usedThisMonth(now: number) {
	const d = new Date(now);
	const start = iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
	const m = schema.mailboxChecks;
	const row = await db
		.select({ n: sql<number>`count(*)` })
		.from(m)
		.where(and(gte(m.checked_at, start), ne(m.state, "delivered")))
		.get();
	return row?.n ?? 0;
}

/**
 * Of these addresses (lowercase, bare), the ones Emailable says can't receive email, with why.
 * `cachedOnly`: only what's already known, no paid check (the recipient lookup, sandbox sends).
 */
export async function mailboxRejected(
	addresses: string[],
	o: { now?: number; fetcher?: typeof fetch; cachedOnly?: boolean } = {},
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const list = [...new Set(addresses)];
	if (!list.length || !emailableConfigured()) return out;
	const now = o.now ?? Date.now();
	const known = await kept(list, now);
	if (!o.cachedOnly) {
		const unknown = list.filter((a) => !known.has(a));
		const room = unknown.length
			? Math.min(MAX_CHECKS, Math.max(0, monthLimit() - (await usedThisMonth(now))))
			: 0;
		const fresh = unknown.slice(0, room);
		const answers = await Promise.all(
			fresh.map(async (a) => [a, await verifyMailbox(a, o.fetcher)] as const),
		);
		const rows = answers.flatMap(([address, answer]) => {
			if (!answer) return [];
			known.set(address, answer);
			return [{ address, ...answer, checked_at: iso(now) }];
		});
		if (rows.length)
			await db
				.insert(schema.mailboxChecks)
				.values(rows)
				.onConflictDoUpdate({
					target: schema.mailboxChecks.address,
					set: {
						state: sql`excluded.state`,
						reason: sql`excluded.reason`,
						checked_at: sql`excluded.checked_at`,
					},
				})
				.catch((error) => console.error("mailbox-checks: not kept", error));
	}
	for (const [address, r] of known)
		if (r.state === "undeliverable") out[address] = rejectedBecause(r.reason);
	return out;
}

/** SES delivered to these addresses: their mailbox exists, so they're never checked. */
export function markDelivered(addresses: string[], at: string) {
	return addresses.filter(Boolean).map((a) =>
		db
			.insert(schema.mailboxChecks)
			.values({ address: a.toLowerCase(), state: "delivered", reason: null, checked_at: at })
			.onConflictDoUpdate({
				target: schema.mailboxChecks.address,
				set: { state: "delivered", reason: null, checked_at: at },
			}),
	);
}

/** Nightly: answers past their keep time (and so asked again if the address comes back). */
export async function purgeMailboxChecks(now = Date.now()) {
	await db
		.delete(schema.mailboxChecks)
		.where(lt(schema.mailboxChecks.checked_at, iso(now - 365 * DAY)));
}
