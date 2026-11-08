import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { viewScope } from "./brands";
import { db, schema } from "./db";
import { ApiError } from "./errors";

/*
 * One person across the organization's brands: each brand keeps its own contact (its own
 * consent, segments and reputation), and this joins them for viewing only. Per brand: their
 * contact, the emails they got and opened, their conversations, lead score, open follow-ups,
 * whether the brand blocks them, and what they spent.
 */

const ct = schema.contacts;
const em = schema.emails;
const cv = schema.conversations;

export async function personAcrossBrands(organizationId: string, address: string) {
	const email = address.trim().toLowerCase();
	if (!email.includes("@")) throw new ApiError(422, "validation_error", "That isn't an address");
	const { brands } = await viewScope(organizationId);
	const ids = brands.length ? brands.map((b) => b.id) : [organizationId];
	const [contacts, emails, conversations, suppressed] = await Promise.all([
		db
			.select()
			.from(ct)
			.where(and(inArray(ct.organization_id, ids), eq(ct.email, email))),
		db
			.select({
				brand: em.organization_id,
				sent: sql<number>`COUNT(*)`,
				opened: sql<number>`SUM(CASE WHEN ${em.opened_at} IS NOT NULL THEN 1 ELSE 0 END)`,
				clicked: sql<number>`SUM(CASE WHEN ${em.clicked_at} IS NOT NULL THEN 1 ELSE 0 END)`,
				last: sql<string | null>`MAX(${em.created_at})`,
			})
			.from(em)
			.where(and(inArray(em.organization_id, ids), eq(em.recipient, email)))
			.groupBy(em.organization_id),
		db
			.select({
				brand: cv.organization_id,
				total: sql<number>`COUNT(*)`,
				open: sql<number>`SUM(CASE WHEN ${cv.status} = 'open' THEN 1 ELSE 0 END)`,
				last: sql<string | null>`MAX(${cv.last_message_at})`,
			})
			.from(cv)
			.where(and(inArray(cv.organization_id, ids), eq(cv.contact_address, email)))
			.groupBy(cv.organization_id),
		db
			.select({
				brand: schema.suppressions.organization_id,
				reason: schema.suppressions.reason,
			})
			.from(schema.suppressions)
			.where(
				and(
					inArray(schema.suppressions.organization_id, ids),
					eq(schema.suppressions.address, email),
				),
			),
	]);
	const contactIds = contacts.map((c) => c.id);
	const [spent, followUps] = contactIds.length
		? await Promise.all([
				db
					.select({
						contact: schema.contactEvents.contact_id,
						currency: schema.contactEvents.currency,
						value: sql<number>`SUM(${schema.contactEvents.value})`,
						n: sql<number>`COUNT(*)`,
					})
					.from(schema.contactEvents)
					.where(
						and(
							inArray(schema.contactEvents.contact_id, contactIds),
							isNotNull(schema.contactEvents.value),
						),
					)
					.groupBy(schema.contactEvents.contact_id, schema.contactEvents.currency),
				db
					.select({
						contact: schema.contactNotes.contact_id,
						n: sql<number>`COUNT(*)`,
					})
					.from(schema.contactNotes)
					.where(
						and(
							inArray(schema.contactNotes.contact_id, contactIds),
							isNotNull(schema.contactNotes.due_at),
							isNull(schema.contactNotes.done_at),
						),
					)
					.groupBy(schema.contactNotes.contact_id),
			])
		: [[], []];
	const { contactLeadScore } = await import("./lead-score");
	const leads = new Map(
		await Promise.all(
			contacts.map(
				async (c) =>
					[
						c.id,
						await contactLeadScore(c.organization_id, c.id).catch(() => null),
					] as const,
			),
		),
	);
	const names = new Map(brands.map((b) => [b.id, b.name]));
	const rows = ids
		.map((id) => {
			const c = contacts.find((x) => x.organization_id === id) ?? null;
			const e = emails.find((x) => x.brand === id);
			const v = conversations.find((x) => x.brand === id);
			const s = suppressed.find((x) => x.brand === id);
			const lead = c ? leads.get(c.id) : null;
			const money = c ? spent.filter((x) => x.contact === c.id) : [];
			return {
				brand_id: id,
				brand: names.get(id) ?? null,
				contact: c
					? {
							id: c.id,
							first_name: c.first_name,
							last_name: c.last_name,
							unsubscribed: c.unsubscribed,
							created_at: c.created_at,
							source: c.source,
						}
					: null,
				emails: {
					sent: Number(e?.sent ?? 0),
					opened: Number(e?.opened ?? 0),
					clicked: Number(e?.clicked ?? 0),
					last_at: e?.last ?? null,
				},
				conversations: {
					total: Number(v?.total ?? 0),
					open: Number(v?.open ?? 0),
					last_at: v?.last ?? null,
				},
				lead: lead ? { score: lead.score, level: lead.level } : null,
				follow_ups: Number(followUps.find((x) => x.contact === c?.id)?.n ?? 0),
				suppressed: s?.reason ?? null,
				spent: money.map((m) => ({
					currency: m.currency,
					value: Math.round(Number(m.value) * 100) / 100,
					purchases: Number(m.n),
				})),
			};
		})
		.filter((r) => r.contact || r.emails.sent || r.conversations.total || r.suppressed);
	const name =
		contacts.map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ")).find(Boolean) ??
		null;
	return {
		email,
		name,
		brands: rows,
		totals: {
			brands: rows.length,
			contacts: rows.filter((r) => r.contact).length,
			emails: rows.reduce((t, r) => t + r.emails.sent, 0),
			conversations: rows.reduce((t, r) => t + r.conversations.total, 0),
		},
	};
}
