import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { recipients } from "./alerts";
import { orgOf } from "./brands";
import { db, schema } from "./db";
import { cfg } from "./env";
import { dnsRecords } from "./provision";
import { sendSystemEmail, systemLayout } from "./system-email";
import { iso } from "./time";

/**
 * The deliverability watch. Once a day (and on demand) each verified domain's DNS is checked
 * against what Mailroom asked for (DKIM, MAIL FROM, the receiving MX, DMARC) and the domain is
 * looked up on the domain blocklists that answer public resolvers (best effort: Spamhaus DBL and
 * SURBL often refuse them, which reads as "unknown", not as clean). A new problem emails the
 * organization's owners and admins once; it's shown on the domain's page until it's fixed.
 */

export type HealthProblem = {
	record: string;
	name: string;
	expected: string;
	found: string[];
	level: "error" | "warning";
};
export type Listing = { list: string; status: "listed" | "clean" | "unknown"; detail?: string };

const TYPES = { A: 1, CNAME: 5, MX: 15, TXT: 16 } as const;
const TIMEOUT_MS = 3000;
/** Domains checked per daily run (the least recently checked first). */
const PER_RUN = 200;

/** Answers over DNS-over-HTTPS; null when the lookup itself failed. */
export async function lookup(
	name: string,
	type: keyof typeof TYPES,
	fetcher: typeof fetch = fetch,
): Promise<string[] | null> {
	try {
		const r = await fetcher(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
			{
				headers: { accept: "application/dns-json" },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		);
		if (!r.ok) return null;
		const body = (await r.json()) as {
			Status?: number;
			Answer?: { type: number; data: string }[];
		};
		if (body.Status !== 0 && body.Status !== 3) return null;
		return (body.Answer ?? [])
			.filter((a) => a.type === TYPES[type])
			.map((a) =>
				a.data
					.replace(/"\s*"/g, "")
					.replace(/"/g, "")
					.trim()
					.replace(/\.$/, "")
					.toLowerCase(),
			);
	} catch {
		return null;
	}
}

type Domain = typeof schema.domains.$inferSelect;

/** What's wrong with a domain's DNS now (empty: nothing). */
export async function dnsProblems(d: Domain, fetcher: typeof fetch = fetch) {
	const out: HealthProblem[] = [];
	for (const r of dnsRecords(d)) {
		const expected = r.value.replace(/"/g, "").toLowerCase();
		if (r.record === "DKIM") {
			const found = await lookup(r.name, "CNAME", fetcher);
			if (found && !found.includes(expected))
				out.push({ record: "DKIM", name: r.name, expected, found, level: "error" });
		} else if (r.record === "MX" || r.record === "Receiving") {
			const found = await lookup(r.name, "MX", fetcher);
			if (found && !found.some((f) => f.endsWith(expected)))
				out.push({ record: r.record, name: r.name, expected, found, level: "error" });
		} else if (r.record === "SPF") {
			const found = await lookup(r.name, "TXT", fetcher);
			const spf = found?.filter((t) => t.startsWith("v=spf1")) ?? null;
			if (spf && !spf.some((t) => t.includes("include:amazonses.com")))
				out.push({ record: "SPF", name: r.name, expected, found: spf, level: "error" });
		} else if (r.record === "DMARC") {
			const found = await lookup(r.name, "TXT", fetcher);
			const dmarc = found?.filter((t) => t.startsWith("v=dmarc1")) ?? null;
			if (dmarc && !dmarc.length)
				out.push({
					record: "DMARC",
					name: r.name,
					expected,
					found: [],
					level: "warning",
				});
		}
	}
	return out;
}

/** The domain on the blocklists that take DNS queries (best effort). */
export async function blocklists(name: string, fetcher: typeof fetch = fetch) {
	const out: Listing[] = [];
	const dbl = await lookup(`${name}.dbl.spamhaus.org`, "A", fetcher);
	out.push(
		dbl === null || dbl.some((a) => a.startsWith("127.255.255."))
			? { list: "Spamhaus DBL", status: "unknown" }
			: dbl.some((a) => a.startsWith("127.0.1."))
				? { list: "Spamhaus DBL", status: "listed", detail: dbl.join(", ") }
				: { list: "Spamhaus DBL", status: "clean" },
	);
	const surbl = await lookup(`${name}.multi.surbl.org`, "A", fetcher);
	out.push(
		surbl === null || surbl.includes("127.0.0.1")
			? { list: "SURBL", status: "unknown" }
			: surbl.some((a) => a.startsWith("127.0.0."))
				? { list: "SURBL", status: "listed", detail: surbl.join(", ") }
				: { list: "SURBL", status: "clean" },
	);
	return out;
}

/** What alerting compares: the problems and listings, not when they were found. */
const fingerprint = (problems: HealthProblem[], listings: Listing[]) =>
	[
		...problems.filter((p) => p.level === "error").map((p) => `${p.record}:${p.name}`),
		...listings.filter((l) => l.status === "listed").map((l) => `listed:${l.list}`),
	]
		.sort()
		.join("|");

/** Checks one domain now and records it; emails people when a new problem shows. */
export async function checkDomainHealth(
	d: Domain,
	o: { now?: number; fetcher?: typeof fetch; notify?: boolean } = {},
) {
	const now = o.now ?? Date.now();
	const [problems, listings] = await Promise.all([
		dnsProblems(d, o.fetcher),
		d.sending ? blocklists(d.name, o.fetcher) : Promise.resolve([]),
	]);
	const h = schema.domainHealth;
	const before = await db.select().from(h).where(eq(h.domain_id, d.id)).get();
	const key = fingerprint(problems, listings);
	let alerted = before?.alerted ?? null;
	if (key && key !== alerted && o.notify !== false) {
		try {
			await notify(d, problems, listings);
			alerted = key;
		} catch (error) {
			console.error("deliverability: alert not sent", d.id, error);
		}
	} else if (!key) alerted = null;
	const row = {
		domain_id: d.id,
		organization_id: d.organization_id,
		problems,
		listings,
		checked_at: iso(now),
		alerted,
	};
	await db.insert(h).values(row).onConflictDoUpdate({ target: h.domain_id, set: row });
	return row;
}

export const healthView = (row: typeof schema.domainHealth.$inferSelect | null | undefined) =>
	row
		? {
				checked_at: row.checked_at,
				ok:
					!row.problems.some((p) => p.level === "error") &&
					!row.listings.some((l) => l.status === "listed"),
				problems: row.problems,
				listings: row.listings,
			}
		: null;

export async function domainHealth(domainId: string) {
	return healthView(
		await db
			.select()
			.from(schema.domainHealth)
			.where(eq(schema.domainHealth.domain_id, domainId))
			.get(),
	);
}

/** The daily run: verified domains, the least recently checked first. */
export async function runDeliverabilityWatch(now = Date.now(), fetcher: typeof fetch = fetch) {
	const d = schema.domains;
	const h = schema.domainHealth;
	const due = await db
		.select({ domain: d })
		.from(d)
		.leftJoin(h, eq(h.domain_id, d.id))
		.where(
			and(
				eq(d.status, "verified"),
				or(isNull(h.checked_at), lt(h.checked_at, iso(now - 20 * 3_600_000))),
			),
		)
		.orderBy(asc(h.checked_at))
		.limit(PER_RUN);
	for (const { domain } of due)
		await checkDomainHealth(domain, { now, fetcher }).catch((error) =>
			console.error("deliverability: check failed", domain.name, error),
		);
	return due.length;
}

async function notify(d: Domain, problems: HealthProblem[], listings: Listing[]) {
	const errors = problems.filter((p) => p.level === "error");
	const listed = listings.filter((l) => l.status === "listed");
	const subject = `${d.name}: ${errors.length ? "DNS records changed" : "found on a blocklist"}`;
	const lines = [
		...errors.map(
			(p) =>
				`${p.record} at ${p.name} should be ${p.expected}; it's ${p.found.length ? p.found.join(", ") : "missing"}.`,
		),
		...listed.map(
			(l) =>
				`${d.name} is on ${l.list}. Mail with its links may go to spam; ask the list to remove it once the cause is fixed.`,
		),
		errors.length
			? "Until the records are back, emails from this domain may fail DKIM or SPF and land in spam. The domain's page lists the records to add."
			: "",
	].filter(Boolean);
	const body = systemLayout({
		title: subject,
		lines,
		button: { label: "Open the domain", url: `${cfg().BETTER_AUTH_URL ?? ""}/domains/${d.id}` },
	});
	const to = await recipients(await orgOf(d.organization_id));
	const results = await Promise.allSettled(
		to.map((address) => sendSystemEmail({ to: address, subject, ...body })),
	);
	if (to.length && results.every((r) => r.status === "rejected"))
		throw (results[0] as PromiseRejectedResult).reason;
}
