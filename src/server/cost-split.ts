import { and, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { AwsCosts, MonthSummary } from "./costs";
import { db, schema } from "./db";
import { ownAccountBrands } from "./org-aws";

/**
 * The AWS bill split by organization, for the admins' AWS page: what each one's email (sent and
 * received in the month) is of the account's, times what the month came to. SES charges per
 * email either way, and S3, SNS and the rest grow with it, so the share of emails is the share of
 * the bill; a brand's emails count for its organization, and each brand is shown under it.
 */

export interface OrgCost {
	id: string;
	name: string;
	sent: number;
	received: number;
	/** Of the month's emails, 0 to 1. */
	share: number;
	amount: number;
	brands: { id: string; name: string; sent: number; received: number; amount: number }[];
}

export interface CostSplit {
	start: string;
	unit: string;
	total: number;
	estimated: boolean;
	organizations: OrgCost[];
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

const nextMonth = (start: string) => {
	const d = new Date(`${start}T00:00:00Z`);
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
};

/** Emails sent and received in a month, by brand. */
export async function monthCounts(start: string) {
	const from = `${start}T00:00:00.000Z`;
	const to = nextMonth(start);
	const e = schema.emails;
	const r = schema.receivedEmails;
	const [sent, received] = await Promise.all([
		db
			.select({ id: e.organization_id, n: sql<number>`COUNT(*)` })
			.from(e)
			.where(and(isNotNull(e.sent_at), gte(e.sent_at, from), lt(e.sent_at, to)))
			.groupBy(e.organization_id),
		db
			.select({ id: r.organization_id, n: sql<number>`COUNT(*)` })
			.from(r)
			.where(and(gte(r.created_at, from), lt(r.created_at, to)))
			.groupBy(r.organization_id),
	]);
	// What went out through an organization's own SES account is on that account's bill.
	const elsewhere = await ownAccountBrands();
	const out = new Map<string, { sent: number; received: number }>();
	for (const s of sent)
		if (!elsewhere.has(s.id)) out.set(s.id, { sent: Number(s.n), received: 0 });
	for (const x of received) {
		const c = out.get(x.id) ?? { sent: 0, received: 0 };
		c.received = Number(x.n);
		out.set(x.id, c);
	}
	return out;
}

export async function splitMonth(month: MonthSummary, unit: string): Promise<CostSplit> {
	const counts = await monthCounts(month.start);
	const ids = [...counts.keys()];
	const parents = new Map<string, string>();
	const names = new Map<string, string>();
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		const [brands, orgs] = await Promise.all([
			db
				.select({ id: schema.brands.id, parent: schema.brands.parent_id })
				.from(schema.brands)
				.where(inArray(schema.brands.id, chunk)),
			db
				.select({ id: schema.organization.id, name: schema.organization.name })
				.from(schema.organization)
				.where(inArray(schema.organization.id, chunk)),
		]);
		for (const b of brands) parents.set(b.id, b.parent);
		for (const o of orgs) names.set(o.id, o.name);
	}
	const missing = [...new Set([...parents.values()].filter((p) => !names.has(p)))];
	for (let i = 0; i < missing.length; i += 90) {
		const rows = await db
			.select({ id: schema.organization.id, name: schema.organization.name })
			.from(schema.organization)
			.where(inArray(schema.organization.id, missing.slice(i, i + 90)));
		for (const o of rows) names.set(o.id, o.name);
	}
	let all = 0;
	for (const c of counts.values()) all += c.sent + c.received;
	const perEmail = all ? month.total / all : 0;
	const orgs = new Map<string, OrgCost>();
	for (const [brand, c] of counts) {
		const orgId = parents.get(brand) ?? brand;
		const o =
			orgs.get(orgId) ??
			({
				id: orgId,
				name: names.get(orgId) ?? orgId,
				sent: 0,
				received: 0,
				share: 0,
				amount: 0,
				brands: [],
			} as OrgCost);
		const amount = (c.sent + c.received) * perEmail;
		o.sent += c.sent;
		o.received += c.received;
		o.amount += amount;
		if (brand !== orgId)
			o.brands.push({
				id: brand,
				name: names.get(brand) ?? brand,
				sent: c.sent,
				received: c.received,
				amount: round(amount),
			});
		orgs.set(orgId, o);
	}
	const organizations = [...orgs.values()]
		.map((o) => ({
			...o,
			share: all ? (o.sent + o.received) / all : 0,
			amount: round(o.amount),
			brands: o.brands.sort((a, b) => b.amount - a.amount),
		}))
		.sort((a, b) => b.amount - a.amount || b.sent - a.sent);
	return {
		start: month.start,
		unit,
		total: month.total,
		estimated: month.estimated,
		organizations,
	};
}

/** This month's split (and last month's), from the kept Cost Explorer answer. */
export async function costByOrganization(costs: AwsCosts | null) {
	if (!costs?.thisMonth) return null;
	const [thisMonth, lastMonth] = await Promise.all([
		splitMonth(costs.thisMonth, costs.unit),
		costs.lastMonth ? splitMonth(costs.lastMonth, costs.unit) : null,
	]);
	return { thisMonth, lastMonth };
}
