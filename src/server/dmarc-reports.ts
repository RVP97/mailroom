import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { XMLParser } from "fast-xml-parser";
import { Gunzip, strFromU8, unzipSync } from "fflate";
import PostalMime from "postal-mime";
import { db, schema } from "./db";
import { dmarcReportsAddress } from "./dmarc-address";

/**
 * DMARC aggregate reports: Gmail, Yahoo, Outlook and others email one a day to the address in a
 * domain's rua=, saying which IPs sent mail as the domain and whether it passed. Mailroom receives
 * them (Cloudflare Email Routing → this Worker's email handler), keeps the rows for domains it
 * sends from, and the domain page shows who sends as the domain and what fails.
 *
 * Apple doesn't send them, so iCloud never shows up here.
 */

export { dmarcReportsAddress };

export interface AggregateRow {
	header_from: string;
	source_ip: string;
	count: number;
	disposition: string | null;
	dkim: string | null;
	spf: string | null;
	dkim_domain: string | null;
	spf_domain: string | null;
}

export interface AggregateReport {
	reporter: string;
	report_id: string;
	domain: string;
	policy: string | null;
	begin_at: string;
	end_at: string;
	rows: AggregateRow[];
}

const list = <T>(v: T | T[] | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown) => (v == null || v === "" ? null : String(v).trim().toLowerCase());
const time = (v: unknown) => {
	const n = Number(v);
	return new Date(Number.isFinite(n) ? n * 1000 : 0).toISOString();
};

/** The domain whose result passed, else the first one listed. */
function authDomain(results: { domain?: unknown; result?: unknown }[]) {
	const pass = results.find((r) => str(r.result) === "pass");
	return str((pass ?? results[0])?.domain);
}

type XmlAuth = { domain?: unknown; result?: unknown };
/** One <record> as the XML parser gives it. */
type XmlRecord = {
	row?: {
		source_ip?: unknown;
		count?: unknown;
		policy_evaluated?: { disposition?: unknown; dkim?: unknown; spf?: unknown };
	};
	identifiers?: { header_from?: unknown };
	auth_results?: { dkim?: XmlAuth | XmlAuth[]; spf?: XmlAuth | XmlAuth[] };
};

/** A report's XML, read. Null when it isn't a DMARC aggregate report. */
export function parseAggregateReport(xml: string): AggregateReport | null {
	const doc = new XMLParser({ ignoreAttributes: true, parseTagValue: false }).parse(xml);
	const f = doc?.feedback;
	const meta = f?.report_metadata;
	const domain = str(f?.policy_published?.domain);
	if (!meta?.org_name || meta.report_id == null || !domain) return null;
	const rows: AggregateRow[] = list<XmlRecord>(f.record).flatMap((r) => {
		const ip = str(r?.row?.source_ip);
		if (!ip) return [];
		const evaluated = r.row?.policy_evaluated ?? {};
		return [
			{
				header_from: str(r.identifiers?.header_from) ?? domain,
				source_ip: ip,
				count: Math.max(0, Math.trunc(Number(r.row?.count) || 0)),
				disposition: str(evaluated.disposition),
				dkim: str(evaluated.dkim),
				spf: str(evaluated.spf),
				dkim_domain: authDomain(list(r.auth_results?.dkim)),
				spf_domain: authDomain(list(r.auth_results?.spf)),
			},
		];
	});
	return {
		reporter: String(meta.org_name).trim(),
		report_id: String(meta.report_id).trim(),
		domain,
		policy: str(f.policy_published.p),
		begin_at: time(meta.date_range?.begin),
		end_at: time(meta.date_range?.end),
		rows,
	};
}

/** A report unpacked is at most this big: a few KB compressed can't grow into gigabytes. */
const MAX_XML = 20 * 1024 * 1024;

function gunzipCapped(bytes: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	let total = 0;
	const g = new Gunzip((chunk) => {
		total += chunk.length;
		if (total > MAX_XML) throw new Error("DMARC report too big unpacked");
		parts.push(chunk);
	});
	g.push(bytes, true);
	const out = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

/** The XML in a report file: .xml, .xml.gz or .zip (what providers attach). */
export function reportXml(name: string, bytes: Uint8Array): string | null {
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return strFromU8(gunzipCapped(bytes));
	if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
		const files = unzipSync(bytes, {
			filter: (f) => /\.xml$/i.test(f.name) && f.originalSize <= MAX_XML,
		});
		const first = Object.values(files)[0];
		return first ? strFromU8(first) : null;
	}
	return /\.xml$/i.test(name) || strFromU8(bytes.slice(0, 200)).includes("<feedback")
		? strFromU8(bytes)
		: null;
}

/** Every report in an email: providers attach one file, some put it in the body. */
export async function reportsInEmail(raw: ArrayBuffer | Uint8Array | string) {
	const email = await PostalMime.parse(raw);
	const out: AggregateReport[] = [];
	const files = email.attachments.map((a) => ({
		name: a.filename ?? "",
		bytes:
			typeof a.content === "string"
				? new TextEncoder().encode(a.content)
				: new Uint8Array(a.content),
	}));
	if (!files.length && email.text?.includes("<feedback"))
		files.push({ name: "report.xml", bytes: new TextEncoder().encode(email.text) });
	for (const f of files) {
		try {
			const xml = reportXml(f.name, f.bytes);
			const report = xml ? parseAggregateReport(xml) : null;
			if (report) out.push(report);
		} catch {
			// A file that isn't a report (a logo, a broken archive): skipped.
		}
	}
	return out;
}

/** D1 binds at most 100 values per statement: 10 columns a row, so 9 rows at a time. */
const ROWS_PER_INSERT = 9;

/**
 * Keeps a report when it's about a domain Mailroom sends from. The same report sent twice (a
 * provider retrying) is kept once. Returns whether it was new.
 */
export async function storeReport(r: AggregateReport, now = Date.now()): Promise<boolean> {
	const names = [...new Set([r.domain, ...r.rows.map((x) => x.header_from)])];
	const known = await db
		.select({ name: schema.domains.name })
		.from(schema.domains)
		.where(inArray(schema.domains.name, names.slice(0, 90)));
	const ours = new Set(known.map((k) => k.name));
	// A report for the parent domain (acme.com) still covers a sending subdomain's rows.
	const rows = r.rows.filter((x) => ours.has(x.header_from) || ours.has(r.domain));
	if (!rows.length) return false;
	const id = crypto.randomUUID();
	const inserted = await db
		.insert(schema.dmarcReports)
		.values({
			id,
			reporter: r.reporter,
			report_id: r.report_id,
			domain: r.domain,
			policy: r.policy,
			begin_at: r.begin_at,
			end_at: r.end_at,
			received_at: new Date(now).toISOString(),
		})
		.onConflictDoNothing()
		.returning({ id: schema.dmarcReports.id });
	if (!inserted.length) return false;
	const inserts = [];
	for (let i = 0; i < rows.length; i += ROWS_PER_INSERT)
		inserts.push(
			db
				.insert(schema.dmarcRows)
				.values(
					rows
						.slice(i, i + ROWS_PER_INSERT)
						.map((x) => ({ ...x, report_id: id, begin_at: r.begin_at })),
				),
		);
	for (let i = 0; i < inserts.length; i += 50) {
		const chunk = inserts.slice(i, i + 50);
		await db.batch(chunk as [(typeof chunk)[0], ...typeof chunk]);
	}
	return true;
}

/** The Worker's email handler: a report arrived at DMARC_REPORTS_ADDRESS. */
export async function receiveDmarcEmail(message: {
	raw: ReadableStream<Uint8Array>;
	from: string;
	to: string;
}) {
	const raw = await new Response(message.raw).arrayBuffer();
	const reports = await reportsInEmail(raw);
	let kept = 0;
	for (const r of reports) if (await storeReport(r)) kept++;
	console.log(
		JSON.stringify({ event: "dmarc_report", from: message.from, found: reports.length, kept }),
	);
	return kept;
}

const pass = sql<number>`SUM(CASE WHEN ${schema.dmarcRows.dkim} = 'pass' OR ${schema.dmarcRows.spf} = 'pass' THEN ${schema.dmarcRows.count} ELSE 0 END)`;
const total = sql<number>`SUM(${schema.dmarcRows.count})`;

export interface DmarcSource {
	source_ip: string;
	dkim_domain: string | null;
	spf_domain: string | null;
	messages: number;
	passed: number;
	/** What providers did with the ones that failed. */
	quarantined: number;
	rejected: number;
}

export interface DmarcSummary {
	/** Whether the domain's record sends its reports to Mailroom (from the DNS lookup). */
	address: string | null;
	days: number;
	messages: number;
	passed: number;
	reporters: { reporter: string; messages: number; passed: number }[];
	sources: DmarcSource[];
	last_report_at: string | null;
}

/** The last `days` of reports about mail From the domain. */
export async function dmarcSummary(
	domain: string,
	days = 30,
	now = Date.now(),
): Promise<DmarcSummary> {
	const since = new Date(now - days * 86_400_000).toISOString();
	const r = schema.dmarcRows;
	const where = and(eq(r.header_from, domain.toLowerCase()), gte(r.begin_at, since));
	const [totals, reporters, sources, last] = await Promise.all([
		db.select({ messages: total, passed: pass }).from(r).where(where),
		db
			.select({ reporter: schema.dmarcReports.reporter, messages: total, passed: pass })
			.from(r)
			.innerJoin(schema.dmarcReports, eq(schema.dmarcReports.id, r.report_id))
			.where(where)
			.groupBy(schema.dmarcReports.reporter)
			.orderBy(desc(total)),
		db
			.select({
				source_ip: r.source_ip,
				dkim_domain: r.dkim_domain,
				spf_domain: r.spf_domain,
				messages: total,
				passed: pass,
				quarantined: sql<number>`SUM(CASE WHEN ${r.disposition} = 'quarantine' THEN ${r.count} ELSE 0 END)`,
				rejected: sql<number>`SUM(CASE WHEN ${r.disposition} = 'reject' THEN ${r.count} ELSE 0 END)`,
			})
			.from(r)
			.where(where)
			.groupBy(r.source_ip, r.dkim_domain, r.spf_domain)
			// Failing sources first: they're what needs a look.
			.orderBy(sql`(${total} - ${pass}) DESC`, desc(total))
			.limit(50),
		db
			.select({ at: sql<string>`MAX(${schema.dmarcReports.received_at})` })
			.from(r)
			.innerJoin(schema.dmarcReports, eq(schema.dmarcReports.id, r.report_id))
			.where(eq(r.header_from, domain.toLowerCase())),
	]);
	return {
		address: dmarcReportsAddress(),
		days,
		messages: Number(totals[0]?.messages ?? 0),
		passed: Number(totals[0]?.passed ?? 0),
		reporters: reporters.map((x) => ({
			...x,
			messages: Number(x.messages),
			passed: Number(x.passed),
		})),
		sources: sources.map((x) => ({
			...x,
			messages: Number(x.messages),
			passed: Number(x.passed),
			quarantined: Number(x.quarantined),
			rejected: Number(x.rejected),
		})),
		last_report_at: last[0]?.at ?? null,
	};
}
