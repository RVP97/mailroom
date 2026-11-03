import { createServerFn } from "@tanstack/react-start";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
	brandIn,
	createBrand,
	getBrand,
	listBrands,
	removeBrand,
	renameBrand,
	setBrandPaused,
} from "@/server/brands";
import { db, schema } from "@/server/db";
import { ApiError } from "@/server/errors";
import { can, orgMiddleware } from "@/server/middleware";
import { dailyStats, inScope, statsByOrganization } from "@/server/queries";

/** The organization's brands: who its emails are from, each its own SES tenant and reputation. */

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
		throw error;
	}
}

/** Every brand with its domains and last 7 days, the organization's own first. */
export const listBrandsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const brands = await listBrands(context.organizationId);
		const [stats, domains] = await Promise.all([
			statsByOrganization(7, Date.now(), { org: context.organizationId }),
			db
				.select({
					brand: schema.domains.organization_id,
					n: sql<number>`count(*)`,
					marketing: sql<number>`sum(${schema.domains.purpose} = 'marketing')`,
					paused: sql<number>`sum(${schema.domains.paused_at} IS NOT NULL)`,
				})
				.from(schema.domains)
				.where(inScope(schema.domains.organization_id, { org: context.organizationId }))
				.groupBy(schema.domains.organization_id),
		]);
		const byBrand = new Map(stats.map((s) => [s.organization_id, s]));
		const domainsOf = new Map(domains.map((d) => [d.brand, d]));
		return brands.map((b) => {
			const s = byBrand.get(b.id);
			const d = domainsOf.get(b.id);
			return {
				...b,
				domains: Number(d?.n ?? 0),
				marketingDomains: Number(d?.marketing ?? 0),
				pausedDomains: Number(d?.paused ?? 0),
				sent: s?.sent ?? 0,
				delivered: s?.delivered ?? 0,
				bounceRate: s?.bounceRate ?? 0,
				complaintRate: s?.complaintRate ?? 0,
				bounce: s?.bounce ?? "ok",
				complaint: s?.complaint ?? "ok",
			};
		});
	});

/** One brand: its setup, domains and last 30 days. */
export const getBrandFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const brand = await apiCall(() => getBrand(context.organizationId, data.id));
		const [stats, domains] = await Promise.all([
			dailyStats(brand.id, 30),
			db
				.select({
					id: schema.domains.id,
					name: schema.domains.name,
					status: schema.domains.status,
					purpose: schema.domains.purpose,
					paused_at: schema.domains.paused_at,
					paused_reason: schema.domains.paused_reason,
				})
				.from(schema.domains)
				.where(eq(schema.domains.organization_id, brand.id)),
		]);
		return { brand, stats, domains };
	});

export const createBrandFn = createServerFn({ method: "POST" })
	.middleware([can("brands:edit")])
	.validator(z.object({ name: z.string().trim().min(1).max(80) }))
	.handler(({ data, context }) =>
		apiCall(async () => {
			const { brand } = await createBrand(context.organizationId, { name: data.name });
			return brand;
		}),
	);

export const updateBrandFn = createServerFn({ method: "POST" })
	.middleware([can("brands:edit")])
	.validator(
		z.object({
			id: z.string(),
			name: z.string().trim().min(1).max(80).optional(),
			paused: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		apiCall(async () => {
			const id = await brandIn(context.organizationId, data.id);
			if (data.name) await renameBrand(context.organizationId, id, data.name);
			if (data.paused !== undefined)
				await setBrandPaused(context.organizationId, id, data.paused, {
					isAdmin: context.isAdmin,
				});
			return getBrand(context.organizationId, id);
		}),
	);

export const removeBrandFn = createServerFn({ method: "POST" })
	.middleware([can("brands:edit")])
	.validator(z.object({ id: z.string(), moveTo: z.string() }))
	.handler(({ data, context }) =>
		apiCall(() => removeBrand(context.organizationId, data.id, data.moveTo)),
	);
