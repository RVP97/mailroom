import { z } from "zod";
import { domainFromEmail, upsertCompany } from "./companies";
import { importContacts } from "./contacts";
import { validation } from "./errors";
import { createArticle } from "./help-center";

/**
 * One-click migration importers for teams switching from Mailchimp, Beehiiv, Loops, Resend,
 * Intercom, or Zendesk. Accepts CSV or JSON exports directly.
 */

function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		const next = text[i + 1];
		if (quoted) {
			if (ch === '"' && next === '"') {
				cell += '"';
				i++;
			} else if (ch === '"') {
				quoted = false;
			} else {
				cell += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === ",") {
			row.push(cell);
			cell = "";
		} else if (ch === "\r" && next === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			i++;
		} else if (ch === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else {
			cell += ch;
		}
	}
	if (cell.length || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

const EMAIL_KEYS = new Set(["email", "email_address", "e_mail", "correo", "subscriber_email"]);
const FIRST_KEYS = new Set(["first_name", "firstname", "fname", "first", "nombre"]);
const LAST_KEYS = new Set(["last_name", "lastname", "lname", "last", "apellido"]);
const COMPANY_KEYS = new Set(["company", "company_name", "organization", "account"]);
const PLAN_KEYS = new Set(["plan", "tier", "subscription_plan"]);
const UNSUB_KEYS = new Set(["unsubscribed", "status", "subscribed"]);

const normKey = (k: string) =>
	k
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_|_$/g, "");

export async function importContactsBundle(
	brandId: string,
	raw: { source: "csv" | "json"; content: string; segment_id?: string | null },
) {
	const content = raw.content.trim();
	if (!content) throw validation("content: paste CSV or JSON rows to import");

	let records: Record<string, string>[] = [];
	if (raw.source === "json" || content.startsWith("[") || content.startsWith("{")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			throw validation("content: invalid JSON");
		}
		const arr = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as { data?: unknown }).data)
				? (parsed as { data: unknown[] }).data
				: Array.isArray((parsed as { contacts?: unknown }).contacts)
					? (parsed as { contacts: unknown[] }).contacts
					: [];
		records = arr.slice(0, 5000).map((item) => {
			const out: Record<string, string> = {};
			if (item && typeof item === "object") {
				for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
					if (v !== null && v !== undefined && typeof v !== "object")
						out[normKey(k)] = String(v).trim();
				}
			}
			return out;
		});
	} else {
		const rows = parseCsvRows(content);
		const [header, ...body] = rows;
		if (!header?.length) throw validation("content: CSV needs a header row");
		const keys = header.map(normKey);
		records = body.slice(0, 5000).map((r) => {
			const out: Record<string, string> = {};
			keys.forEach((k, idx) => {
				if (k && r[idx]?.trim()) out[k] = (r[idx] as string).trim();
			});
			return out;
		});
	}

	const batchRows: {
		email: string;
		first_name?: string;
		last_name?: string;
		unsubscribed?: boolean;
		properties?: Record<string, string>;
	}[] = [];
	const companiesByDomain = new Map<string, { name: string; plan?: string; count: number }>();
	const errors: string[] = [];

	for (const rec of records) {
		const emailKey = Object.keys(rec).find((k) => EMAIL_KEYS.has(k));
		const email = emailKey ? rec[emailKey]?.toLowerCase() : "";
		if (!email?.includes("@")) continue;

		const firstKey = Object.keys(rec).find((k) => FIRST_KEYS.has(k));
		const lastKey = Object.keys(rec).find((k) => LAST_KEYS.has(k));
		const compKey = Object.keys(rec).find((k) => COMPANY_KEYS.has(k));
		const planKey = Object.keys(rec).find((k) => PLAN_KEYS.has(k));
		const unsubKey = Object.keys(rec).find((k) => UNSUB_KEYS.has(k));

		let unsubscribed: boolean | undefined;
		if (unsubKey) {
			const v = (rec[unsubKey] ?? "").toLowerCase();
			if (unsubKey === "subscribed") unsubscribed = v === "false" || v === "0" || v === "no";
			else if (unsubKey === "status") unsubscribed = v === "unsubscribed" || v === "cleaned";
			else unsubscribed = v === "true" || v === "1" || v === "yes";
		}

		const properties: Record<string, string> = {};
		for (const [k, v] of Object.entries(rec)) {
			if (
				!v ||
				EMAIL_KEYS.has(k) ||
				FIRST_KEYS.has(k) ||
				LAST_KEYS.has(k) ||
				UNSUB_KEYS.has(k) ||
				k === "id" ||
				!/^[a-z][a-z0-9_]{0,63}$/.test(k)
			)
				continue;
			properties[k] = v;
		}

		batchRows.push({
			email,
			...(firstKey ? { first_name: rec[firstKey] } : {}),
			...(lastKey ? { last_name: rec[lastKey] } : {}),
			...(unsubscribed !== undefined ? { unsubscribed } : {}),
			...(Object.keys(properties).length ? { properties } : {}),
		});

		const dom = domainFromEmail(email);
		if (dom && (compKey || planKey)) {
			const prev = companiesByDomain.get(dom);
			companiesByDomain.set(dom, {
				name: (compKey && rec[compKey]) || prev?.name || dom.split(".")[0] || dom,
				...((planKey ? rec[planKey] : prev?.plan)
					? { plan: (planKey ? rec[planKey] : prev?.plan) as string }
					: {}),
				count: (prev?.count ?? 0) + 1,
			});
		}
	}

	let imported = 0;
	if (batchRows.length) {
		try {
			const res = await importContacts(brandId, batchRows, {
				segment: raw.segment_id ?? null,
			});
			imported = res.added + res.updated;
		} catch (err) {
			errors.push(err instanceof Error ? err.message : "import failed");
		}
	}

	let companiesSynced = 0;
	for (const [domain, info] of companiesByDomain) {
		await upsertCompany(brandId, {
			name: info.name,
			domain,
			...(info.plan ? { plan: info.plan } : {}),
		})
			.then(() => {
				companiesSynced += info.count;
			})
			.catch(() => {});
	}

	return { imported, companies_synced: companiesSynced, errors: errors.slice(0, 20) };
}

const articleBundleItem = z.object({
	title: z.string().trim().min(1).max(160),
	description: z.string().trim().max(300).nullish(),
	category: z.string().trim().max(60).nullish(),
	html: z.string().max(500_000).optional(),
	body: z.string().max(500_000).optional(),
	status: z.enum(["draft", "published"]).optional(),
	locale: z.string().max(16).optional(),
});

/** Import Intercom / Zendesk / Crisp Help Center JSON export directly into Mailroom Help Center. */
export async function importHelpArticlesBundle(
	brandId: string,
	raw: { content: string; publish?: boolean },
	userId: string | null = null,
) {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.content.trim());
	} catch {
		throw validation(
			'content: paste a JSON array of articles, e.g. [{"title":"...","body":"<p>...</p>"}]',
		);
	}
	const list = Array.isArray(parsed)
		? parsed
		: Array.isArray((parsed as { data?: unknown }).data)
			? (parsed as { data: unknown[] }).data
			: Array.isArray((parsed as { articles?: unknown }).articles)
				? (parsed as { articles: unknown[] }).articles
				: [];
	if (!list.length) throw validation("No articles found in the JSON payload");

	let imported = 0;
	const errors: string[] = [];
	for (const item of list.slice(0, 100)) {
		const res = articleBundleItem.safeParse(item);
		if (!res.success) {
			errors.push("Skipped invalid article row");
			continue;
		}
		const a = res.data;
		try {
			await createArticle(
				brandId,
				{
					title: a.title,
					description: a.description ?? null,
					category: a.category ?? null,
					html: a.html ?? a.body ?? `<p>${a.title}</p>`,
					status: raw.publish ? "published" : (a.status ?? "draft"),
					...(a.locale ? { locale: a.locale } : {}),
				},
				userId,
			);
			imported++;
		} catch (err) {
			errors.push(`${a.title}: ${err instanceof Error ? err.message : "failed"}`);
		}
	}
	return { imported, errors: errors.slice(0, 20) };
}
