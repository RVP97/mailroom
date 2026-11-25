import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { iso } from "./time";

/**
 * B2B Companies / Accounts: group contacts by corporate email domain (or explicit company_id),
 * track plan, MRR, seats & renewal date, and surface account context inside the Inbox sidebar.
 */

const FREE_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"yahoo.com",
	"hotmail.com",
	"outlook.com",
	"live.com",
	"icloud.com",
	"me.com",
	"proton.me",
	"protonmail.com",
	"hey.com",
	"aol.com",
	"fastmail.com",
	"gmx.com",
	"mail.com",
]);

export type CompanyRow = typeof schema.companies.$inferSelect;

export const companyInput = z.object({
	name: z.string().trim().min(1, "name: give the company a name").max(120),
	domain: z.string().trim().toLowerCase().max(120).nullable().optional(),
	plan: z.string().trim().max(60).nullable().optional(),
	mrr: z.number().min(0).max(100_000_000).nullable().optional(),
	seats: z.number().int().min(0).max(1_000_000).nullable().optional(),
	renewal_at: z.string().trim().max(40).nullable().optional(),
	website: z.string().trim().max(300).nullable().optional(),
	notes: z.string().max(10_000).nullable().optional(),
	properties: z.record(z.string().max(64), z.union([z.string().max(500), z.number()])).optional(),
});

export function domainFromEmail(email: string): string | null {
	const at = email.lastIndexOf("@");
	if (at < 0) return null;
	const dom = email
		.slice(at + 1)
		.trim()
		.toLowerCase();
	if (!dom?.includes(".") || FREE_DOMAINS.has(dom)) return null;
	return dom;
}

function cleanDomain(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const d = raw
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, "")
		.replace(/^www\./, "")
		.replace(/\/.*$/, "");
	if (!d) return null;
	if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
		throw validation("domain: enter a valid domain like acme.com");
	return d;
}

export function companyView(
	c: CompanyRow,
	counts?: { contacts?: number; open_conversations?: number },
) {
	return {
		object: "company" as const,
		id: c.id,
		brand_id: c.organization_id,
		name: c.name,
		domain: c.domain,
		plan: c.plan,
		mrr: c.mrr,
		seats: c.seats,
		renewal_at: c.renewal_at,
		website: c.website,
		notes: c.notes,
		properties: c.properties ?? {},
		contacts_count: counts?.contacts ?? 0,
		open_conversations: counts?.open_conversations ?? 0,
		created_at: c.created_at,
		updated_at: c.updated_at,
	};
}

export async function listCompanies(
	brands: string[],
	o: { search?: string; plan?: string; limit?: number } = {},
) {
	if (!brands.length) return [];
	const q = o.search?.trim();
	const rows = await db
		.select()
		.from(schema.companies)
		.where(
			and(
				inArray(schema.companies.organization_id, brands),
				o.plan ? eq(schema.companies.plan, o.plan) : undefined,
				q
					? or(
							like(schema.companies.name, `%${q}%`),
							like(schema.companies.domain, `%${q}%`),
							like(schema.companies.plan, `%${q}%`),
						)
					: undefined,
			),
		)
		.orderBy(desc(schema.companies.mrr), desc(schema.companies.updated_at))
		.limit(Math.min(o.limit ?? 100, 200));

	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const counts = await db
		.select({
			company_id: schema.contacts.company_id,
			n: sql<number>`count(*)`,
		})
		.from(schema.contacts)
		.where(inArray(schema.contacts.company_id, ids))
		.groupBy(schema.contacts.company_id);
	const countMap = new Map(counts.map((c) => [c.company_id, Number(c.n)]));
	return rows.map((r) => companyView(r, { contacts: countMap.get(r.id) ?? 0 }));
}

export async function getCompany(brands: string[], id: string) {
	if (!brands.length) throw notFound("Company");
	const row = await db
		.select()
		.from(schema.companies)
		.where(and(inArray(schema.companies.organization_id, brands), eq(schema.companies.id, id)))
		.get();
	if (!row) throw notFound("Company");

	const members = await db
		.select()
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, row.organization_id),
				or(
					eq(schema.contacts.company_id, row.id),
					row.domain ? like(schema.contacts.email, `%@${row.domain}`) : undefined,
				),
			),
		)
		.orderBy(desc(schema.contacts.updated_at))
		.limit(100);

	const emails = members.map((m) => m.email.toLowerCase());
	const convs = emails.length
		? await db
				.select({
					id: schema.conversations.id,
					subject: schema.conversations.subject,
					contact: schema.conversations.contact,
					status: schema.conversations.status,
					channel: schema.conversations.channel,
					priority: schema.conversations.priority,
					last_message_at: schema.conversations.last_message_at,
				})
				.from(schema.conversations)
				.where(
					and(
						eq(schema.conversations.organization_id, row.organization_id),
						inArray(schema.conversations.contact_address, emails),
					),
				)
				.orderBy(desc(schema.conversations.last_message_at))
				.limit(30)
		: [];

	const openCount = convs.filter((x) => x.status === "open").length;
	return {
		company: companyView(row, { contacts: members.length, open_conversations: openCount }),
		contacts: members.map((m) => ({
			id: m.id,
			email: m.email,
			first_name: m.first_name,
			last_name: m.last_name,
			unsubscribed: m.unsubscribed,
			created_at: m.created_at,
		})),
		conversations: convs,
	};
}

export async function upsertCompany(
	brandId: string,
	raw: unknown,
	o: { id?: string; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const v = companyInput.parse(raw ?? {});
	const domain = cleanDomain(v.domain);
	const existing = o.id
		? await db
				.select()
				.from(schema.companies)
				.where(
					and(
						eq(schema.companies.id, o.id),
						eq(schema.companies.organization_id, brandId),
					),
				)
				.get()
		: domain
			? await db
					.select()
					.from(schema.companies)
					.where(
						and(
							eq(schema.companies.organization_id, brandId),
							eq(schema.companies.domain, domain),
						),
					)
					.get()
			: null;
	if (o.id && !existing) throw notFound("Company");

	if (domain && domain !== existing?.domain) {
		const conflict = await db
			.select({ id: schema.companies.id })
			.from(schema.companies)
			.where(
				and(
					eq(schema.companies.organization_id, brandId),
					eq(schema.companies.domain, domain),
				),
			)
			.get();
		if (conflict && conflict.id !== existing?.id)
			throw new ApiError(
				409,
				"domain_taken",
				`A company with domain ${domain} already exists`,
			);
	}

	const row: CompanyRow = {
		id: existing?.id ?? `cmp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: brandId,
		name: v.name,
		domain: domain !== undefined ? domain : (existing?.domain ?? null),
		plan: v.plan !== undefined ? v.plan || null : (existing?.plan ?? null),
		mrr: v.mrr !== undefined ? v.mrr : (existing?.mrr ?? null),
		seats: v.seats !== undefined ? v.seats : (existing?.seats ?? null),
		renewal_at:
			v.renewal_at !== undefined ? v.renewal_at || null : (existing?.renewal_at ?? null),
		website: v.website !== undefined ? v.website || null : (existing?.website ?? null),
		notes: v.notes !== undefined ? v.notes || null : (existing?.notes ?? null),
		properties:
			v.properties !== undefined
				? { ...(existing?.properties ?? {}), ...v.properties }
				: (existing?.properties ?? null),
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};

	if (existing) {
		await db.update(schema.companies).set(row).where(eq(schema.companies.id, existing.id));
	} else {
		await db.insert(schema.companies).values(row);
	}

	// Auto-associate unlinked contacts matching this company's corporate domain
	if (row.domain) {
		await db
			.update(schema.contacts)
			.set({ company_id: row.id })
			.where(
				and(
					eq(schema.contacts.organization_id, brandId),
					like(schema.contacts.email, `%@${row.domain}`),
					sql`${schema.contacts.company_id} IS NULL`,
				),
			);
	}

	return companyView(row);
}

export async function deleteCompany(brands: string[], id: string) {
	if (!brands.length) throw notFound("Company");
	const [removed] = await db
		.delete(schema.companies)
		.where(and(eq(schema.companies.id, id), inArray(schema.companies.organization_id, brands)))
		.returning({ id: schema.companies.id });
	if (!removed) throw notFound("Company");
	return { deleted: true, id: removed.id };
}

/** Look up the Company card for a contact email (explicit company_id OR corporate email domain). */
export async function companyForEmail(brandId: string, email: string | null | undefined) {
	if (!email) return null;
	const lower = email.trim().toLowerCase();
	const contact = await db
		.select({ company_id: schema.contacts.company_id })
		.from(schema.contacts)
		.where(and(eq(schema.contacts.organization_id, brandId), eq(schema.contacts.email, lower)))
		.get();
	let row: CompanyRow | undefined;
	if (contact?.company_id) {
		row = await db
			.select()
			.from(schema.companies)
			.where(eq(schema.companies.id, contact.company_id))
			.get();
	}
	if (!row) {
		const dom = domainFromEmail(lower);
		if (dom) {
			row = await db
				.select()
				.from(schema.companies)
				.where(
					and(
						eq(schema.companies.organization_id, brandId),
						eq(schema.companies.domain, dom),
					),
				)
				.get();
		}
	}
	if (!row) return null;
	const countRow = await db
		.select({ n: sql<number>`count(*)` })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.organization_id, brandId),
				or(
					eq(schema.contacts.company_id, row.id),
					row.domain ? like(schema.contacts.email, `%@${row.domain}`) : undefined,
				),
			),
		)
		.get();
	return companyView(row, { contacts: Number(countRow?.n ?? 0) });
}
