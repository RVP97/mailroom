import { and, eq, gte, inArray, like, sql } from "drizzle-orm";
import { FREE_PROVIDERS } from "../lib/free-providers";
import { batch, db, raw, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

/**
 * The email firewall: checks each brand can turn on one by one (a newsletter may refuse
 * throwaway addresses while receipts go to anyone), run on every recipient before the brand's
 * email is recorded. Everything is off until turned on. «Always allow» wins over every
 * check, «Never send to» over the rest; a blocked recipient is dropped with the rule that did it
 * («firewall: disposable»), like a suppressed one.
 */

export type FirewallRule = "never" | "disposable" | "free" | "plus";

export interface FirewallSettings {
	block_disposable: boolean;
	block_free: boolean;
	block_plus: boolean;
	never: string[];
	always: string[];
	updated_at: string | null;
}

export const RULE_LABEL: Record<FirewallRule, string> = {
	never: "on «Never send to»",
	disposable: "disposable address",
	free: "free inbox",
	plus: "plus address",
};

const OFF: FirewallSettings = {
	block_disposable: false,
	block_free: false,
	block_plus: false,
	never: [],
	always: [],
	updated_at: null,
};

/** Some throwaway domains, so the check works before the daily list is first fetched. */
const DISPOSABLE_SEED = [
	"mailinator.com",
	"guerrillamail.com",
	"guerrillamail.net",
	"sharklasers.com",
	"10minutemail.com",
	"temp-mail.org",
	"tempmail.com",
	"yopmail.com",
	"trashmail.com",
	"getnada.com",
	"dispostable.com",
	"maildrop.cc",
	"throwawaymail.com",
	"fakeinbox.com",
	"mintemail.com",
	"mohmal.com",
	"emailondeck.com",
	"tempail.com",
	"burnermail.io",
	"mailnesia.com",
];

export const DISPOSABLE_LIST_URL =
	"https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf";

/** A brand's firewall (the default brand's id is its organization's). */
export async function getFirewall(brandId: string): Promise<FirewallSettings> {
	const row = await db
		.select()
		.from(schema.firewall)
		.where(eq(schema.firewall.organization_id, brandId))
		.get();
	return row ? { ...OFF, ...row } : { ...OFF };
}

export type BlockedCounts = Record<FirewallRule, number> & { total: number };

/**
 * How many of each brand's emails the firewall left a recipient out of over the last n days, by
 * rule (from what each email keeps of its dropped recipients).
 */
export async function blockedByFirewall(
	brandIds: string[],
	days = 30,
	now = Date.now(),
): Promise<Map<string, BlockedCounts>> {
	const e = schema.emails;
	const since = iso(now - days * 86_400_000);
	const count = (rule: FirewallRule) =>
		sql<number>`SUM(${e.dropped} LIKE ${`%"firewall: ${RULE_LABEL[rule]}"%`})`;
	const out = new Map<string, BlockedCounts>();
	for (let i = 0; i < brandIds.length; i += 90) {
		const rows = await db
			.select({
				brand: e.organization_id,
				total: sql<number>`count(*)`,
				never: count("never"),
				disposable: count("disposable"),
				free: count("free"),
				plus: count("plus"),
			})
			.from(e)
			.where(
				and(
					inArray(e.organization_id, brandIds.slice(i, i + 90)),
					gte(e.created_at, since),
					like(e.dropped, '%"firewall: %'),
				),
			)
			.groupBy(e.organization_id);
		for (const r of rows)
			out.set(r.brand, {
				total: Number(r.total) || 0,
				never: Number(r.never) || 0,
				disposable: Number(r.disposable) || 0,
				free: Number(r.free) || 0,
				plus: Number(r.plus) || 0,
			});
	}
	return out;
}

const NONE: BlockedCounts = { total: 0, never: 0, disposable: 0, free: 0, plus: 0 };

export const firewallOn = (fw: FirewallSettings) =>
	fw.block_disposable || fw.block_free || fw.block_plus || fw.never.length > 0;

/** Every brand's firewall, for the organization's overview (brands without one are all off). */
export async function firewallsOf(brandIds: string[]) {
	const rows: (typeof schema.firewall.$inferSelect)[] = [];
	// D1 takes up to 100 parameters a statement.
	for (let i = 0; i < brandIds.length; i += 90)
		rows.push(
			...(await db
				.select()
				.from(schema.firewall)
				.where(inArray(schema.firewall.organization_id, brandIds.slice(i, i + 90)))),
		);
	const byId = new Map(rows.map((r) => [r.organization_id, r]));
	const blocked = await blockedByFirewall(brandIds);
	return brandIds.map((id) => {
		const r = byId.get(id);
		const fw: FirewallSettings = r ? { ...OFF, ...r } : { ...OFF };
		return { brand_id: id, ...fw, on: firewallOn(fw), blocked: blocked.get(id) ?? NONE };
	});
}

/**
 * One list entry, cleaned: an address (a@b.com), a domain that covers its subdomains
 * (example.com) or an ending (.ru). Null when it's none of these.
 */
export function listEntry(raw: string): string | null {
	const v = raw.trim().toLowerCase().replace(/^\*@/, "").replace(/^@/, "");
	if (!v) return null;
	if (v.includes("@")) return /^[^@\s]+@[a-z0-9.-]+\.[a-z0-9-]+$/.test(v) ? v : null;
	const d = v.replace(/^\*\./, ".");
	return /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(d) && d !== "." ? d : null;
}

const MAX_ENTRIES = 1000;

export async function setFirewall(
	brandId: string,
	patch: Partial<Omit<FirewallSettings, "updated_at">>,
	now = Date.now(),
) {
	const current = await getFirewall(brandId);
	const clean = (list: string[] | undefined, field: string) => {
		if (!list) return undefined;
		const out: string[] = [];
		for (const x of list) {
			const e = listEntry(x);
			if (!e)
				throw validation(
					`${x.trim() || "An empty line"} isn't an address or a domain (${field})`,
				);
			if (!out.includes(e)) out.push(e);
		}
		if (out.length > MAX_ENTRIES) throw validation(`Up to ${MAX_ENTRIES} entries (${field})`);
		return out;
	};
	const next = {
		block_disposable: patch.block_disposable ?? current.block_disposable,
		block_free: patch.block_free ?? current.block_free,
		block_plus: patch.block_plus ?? current.block_plus,
		never: clean(patch.never, "never") ?? current.never,
		always: clean(patch.always, "always") ?? current.always,
		updated_at: iso(now),
	};
	await db
		.insert(schema.firewall)
		.values({ organization_id: brandId, ...next })
		.onConflictDoUpdate({ target: schema.firewall.organization_id, set: next });
	return next;
}

/** The domain and every parent of it but the last label: a.b.example.com → itself, b.example.com, example.com. */
const domainsOf = (domain: string) => {
	const parts = domain.split(".");
	const out: string[] = [];
	for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
	return out;
};

const listed = (list: string[], address: string, domain: string) =>
	list.some((e) =>
		e.includes("@")
			? e === address
			: e.startsWith(".")
				? domain.endsWith(e)
				: domain === e || domain.endsWith(`.${e}`),
	);

/**
 * Which rule, if any, blocks each address (lowercase bare addresses in, the blocked ones out).
 * One query at most (the disposable list), only when that check is on.
 */
export async function firewallBlocks(
	fw: FirewallSettings,
	addresses: string[],
): Promise<Record<string, FirewallRule>> {
	const out: Record<string, FirewallRule> = {};
	if (!firewallOn(fw) || !addresses.length) return out;
	let disposable = new Set<string>();
	if (fw.block_disposable) {
		const candidates = [...new Set(addresses.flatMap((a) => domainsOf(a.split("@")[1] ?? "")))];
		disposable = new Set(DISPOSABLE_SEED.filter((d) => candidates.includes(d)));
		// D1 takes up to 100 parameters a statement.
		for (let i = 0; i < candidates.length; i += 90) {
			const rows = await db
				.select({ domain: schema.disposableDomains.domain })
				.from(schema.disposableDomains)
				.where(inArray(schema.disposableDomains.domain, candidates.slice(i, i + 90)));
			for (const r of rows) disposable.add(r.domain);
		}
	}
	for (const address of addresses) {
		const [local = "", domain = ""] = address.split("@");
		if (listed(fw.always, address, domain)) continue;
		const rule: FirewallRule | null = listed(fw.never, address, domain)
			? "never"
			: fw.block_disposable && domainsOf(domain).some((d) => disposable.has(d))
				? "disposable"
				: fw.block_free && FREE_PROVIDERS.has(domain)
					? "free"
					: fw.block_plus && local.includes("+")
						? "plus"
						: null;
		if (rule) out[address] = rule;
	}
	return out;
}

/** What the firewall says of one address, for the dashboard's lookup and the API. */
export async function checkAddress(brandId: string, address: string) {
	const a = address.trim().toLowerCase();
	const rule = (await firewallBlocks(await getFirewall(brandId), [a]))[a] ?? null;
	return { address: a, blocked: !!rule, rule, reason: rule ? RULE_LABEL[rule] : null };
}

/**
 * Replaces the throwaway domains with the community list's (daily; about 5,000 domains). Keeps
 * the old list when the fetch fails or comes back suspiciously short.
 */
export async function refreshDisposableDomains(fetcher: typeof fetch = fetch) {
	const res = await fetcher(DISPOSABLE_LIST_URL);
	if (!res.ok) throw new Error(`disposable list: HTTP ${res.status}`);
	const domains = [
		...new Set(
			(await res.text())
				.split("\n")
				.map((l) => l.trim().toLowerCase())
				.filter((l) => l && !l.startsWith("#") && /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(l)),
		),
	];
	if (domains.length < 1000) throw new Error(`disposable list: only ${domains.length} domains`);
	const statements = [raw("DELETE FROM disposable_domains")];
	for (let i = 0; i < domains.length; i += 90) {
		const chunk = domains.slice(i, i + 90);
		statements.push(
			raw(
				`INSERT OR IGNORE INTO disposable_domains (domain) VALUES ${chunk.map(() => "(?)").join(",")}`,
				...chunk,
			),
		);
	}
	await batch(statements);
	return domains.length;
}

/** Fetches the list when it's empty (a new deployment) or once a day. */
export async function refreshDisposableIfDue(now: number, fetcher: typeof fetch = fetch) {
	const at = new Date(now);
	const daily = at.getUTCHours() === 4;
	if (!daily) {
		const row = await db
			.select({ n: sql<number>`count(*)` })
			.from(schema.disposableDomains)
			.get();
		if (Number(row?.n ?? 0) > 0) return null;
	}
	return refreshDisposableDomains(fetcher);
}

/** A brand's firewall with what it blocked in the last 30 days. */
export async function firewallWithCounts(brandId: string) {
	const [fw, blocked] = await Promise.all([getFirewall(brandId), blockedByFirewall([brandId])]);
	return { ...fw, blocked: blocked.get(brandId) ?? NONE };
}
