import { and, eq, inArray, lt } from "drizzle-orm";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * Free checks of a recipient before SES sees it, so a typo or a dead domain never becomes a
 * bounce that counts against the account's bounce rate:
 * - a misspelled big provider (gmial.com, hotmail.con);
 * - a domain that doesn't exist or takes no email, from DNS (MX, else an address record), asked
 *   of Cloudflare's DNS over HTTPS and kept in mail_domains.
 * A lookup that fails or times out lets the address through: the bounce, if it comes, still
 * suppresses it.
 */

export const DOMAIN_TYPOS: Record<string, string> = {
	"gmial.com": "gmail.com",
	"gamil.com": "gmail.com",
	"gmai.com": "gmail.com",
	"gmail.co": "gmail.com",
	"gmail.con": "gmail.com",
	"gmail.cm": "gmail.com",
	"gmail.om": "gmail.com",
	"gmail.comm": "gmail.com",
	"gnail.com": "gmail.com",
	"gmaill.com": "gmail.com",
	"hotmial.com": "hotmail.com",
	"hotmal.com": "hotmail.com",
	"hotmai.com": "hotmail.com",
	"hotmail.con": "hotmail.com",
	"hotmail.co": "hotmail.com",
	"hotmil.com": "hotmail.com",
	"hotamil.com": "hotmail.com",
	"outlok.com": "outlook.com",
	"outllok.com": "outlook.com",
	"outlook.con": "outlook.com",
	"outlook.co": "outlook.com",
	"yaho.com": "yahoo.com",
	"yahoo.con": "yahoo.com",
	"yahooo.com": "yahoo.com",
	"yaho.com.mx": "yahoo.com.mx",
	"iclod.com": "icloud.com",
	"icloud.con": "icloud.com",
	"icoud.com": "icloud.com",
	"live.con": "live.com",
	"live.com.mex": "live.com.mx",
};

export type DomainState = "ok" | "nxdomain" | "no_mail";

const DAY = 86_400_000;
/** A domain that takes email is asked again after 30 days; one that doesn't, after a day. */
const KEEP_MS: Record<DomainState, number> = { ok: 30 * DAY, nxdomain: DAY, no_mail: DAY };
/** DNS lookups per request at most, so a send with many new domains stays quick. */
export const MAX_LOOKUPS = 8;

interface DohAnswer {
	Status?: number;
	Answer?: { type: number; data: string }[];
}

async function doh(name: string, type: "MX" | "A" | "AAAA", fetcher: typeof fetch) {
	const res = await fetcher(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
		{ headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3_000) },
	);
	if (!res.ok) throw new Error(`DoH ${res.status}`);
	return (await res.json()) as DohAnswer;
}

/** What DNS says of a mail domain (null: no answer, let it through). */
export async function lookupDomain(
	domain: string,
	fetcher: typeof fetch = fetch,
): Promise<DomainState | null> {
	try {
		const mx = await doh(domain, "MX", fetcher);
		if (mx.Status === 3) return "nxdomain";
		if (mx.Status !== 0) return null;
		const records = (mx.Answer ?? []).filter((a) => a.type === 15);
		if (records.length) {
			// A null MX («0 .», RFC 7505): the domain says it takes no email.
			return records.every((r) => /^\d+\s+\.?$/.test(r.data.trim())) ? "no_mail" : "ok";
		}
		// No MX: mail goes to the domain's own address (RFC 5321), if it has one.
		const [a, aaaa] = await Promise.all([
			doh(domain, "A", fetcher),
			doh(domain, "AAAA", fetcher),
		]);
		const has = (r: DohAnswer, t: number) => (r.Answer ?? []).some((x) => x.type === t);
		return has(a, 1) || has(aaaa, 28) ? "ok" : "no_mail";
	} catch (error) {
		console.error("address-checks: lookup failed", domain, error);
		return null;
	}
}

/**
 * Of these addresses, the ones that can't get email, with why. Each domain is looked up once
 * (cached ones first); past MAX_LOOKUPS fresh lookups the rest go through unchecked.
 */
export async function undeliverable(
	addresses: string[],
	o: { now?: number; fetcher?: typeof fetch } = {},
): Promise<Record<string, string>> {
	const now = o.now ?? Date.now();
	const out: Record<string, string> = {};
	const byDomain = new Map<string, string[]>();
	for (const a of addresses) {
		const domain = a.split("@")[1]?.toLowerCase() ?? "";
		const typo = DOMAIN_TYPOS[domain];
		if (typo) out[a] = `looks misspelled (did you mean @${typo}?)`;
		else if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), a]);
	}
	const list = [...byDomain.keys()];
	if (!list.length) return out;
	const dm = schema.mailDomains;
	const kept = new Map<string, DomainState>();
	for (let i = 0; i < list.length; i += 90) {
		const rows = await db
			.select()
			.from(dm)
			.where(inArray(dm.domain, list.slice(i, i + 90)));
		for (const r of rows)
			if (Date.parse(r.checked_at) + KEEP_MS[r.state as DomainState] > now)
				kept.set(r.domain, r.state as DomainState);
	}
	const fresh = list.filter((d) => !kept.has(d)).slice(0, MAX_LOOKUPS);
	const looked = await Promise.all(
		fresh.map(async (d) => [d, await lookupDomain(d, o.fetcher)] as const),
	);
	const rows = looked.flatMap(([domain, state]) => {
		if (!state) return [];
		kept.set(domain, state);
		return [{ domain, state, checked_at: iso(now) }];
	});
	if (rows.length)
		await db
			.insert(dm)
			.values(rows)
			.onConflictDoNothing()
			.catch((error) => console.error("address-checks: not kept", error));
	for (const [domain, state] of kept) {
		if (state === "ok") continue;
		for (const a of byDomain.get(domain) ?? [])
			out[a] =
				state === "nxdomain" ? "the domain doesn't exist" : "the domain takes no email";
	}
	return out;
}

/** Nightly: domains not asked about in 60 days. */
export async function purgeMailDomains(now = Date.now()) {
	await db
		.delete(schema.mailDomains)
		.where(lt(schema.mailDomains.checked_at, iso(now - 60 * DAY)));
}

// For the suppression checks (send.ts): the suppressed among these addresses, with why.
export async function suppressedAmong(organizationId: string, addresses: string[]) {
	const s = schema.suppressions;
	const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
	const out: Record<string, string> = {};
	for (let i = 0; i < list.length; i += 90) {
		const rows = await db
			.select({ address: s.address, reason: s.reason })
			.from(s)
			.where(
				and(
					eq(s.organization_id, organizationId),
					inArray(s.address, list.slice(i, i + 90)),
				),
			);
		for (const r of rows) out[r.address] = `suppressed (${r.reason})`;
	}
	return out;
}
