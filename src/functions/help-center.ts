import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import {
	articleCategories,
	articleView,
	createArticle,
	deleteArticle,
	dismissGap,
	getArticle,
	helpCenterOf,
	helpCenterView,
	helpGaps,
	listArticles,
	saveHelpCenter,
	updateArticle,
} from "@/server/help-center";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

/** The Help center pages: a brand's articles, its public page's settings, the questions with no
 * article yet. */

async function scopeOf(organizationId: string, brand?: string | null) {
	const { brands } = await viewScope(organizationId);
	const ids = brands.length ? brands.map((b) => b.id) : [organizationId];
	const one = brand ? await call(() => brandIn(organizationId, brand)) : null;
	return { brands, ids, scope: one ? [one] : ids, one };
}

export const helpPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, scope, one } = await scopeOf(context.organizationId, data.brand);
		// The help center's settings are a brand's: the chosen one, else the organization's.
		const brand = one ?? context.organizationId;
		const [rows, center, gaps, categories] = await Promise.all([
			listArticles(scope),
			helpCenterOf(brand),
			helpGaps(scope),
			articleCategories(scope),
		]);
		const centers = new Map(
			await Promise.all(
				[...new Set(rows.map((r) => r.organization_id))].map(
					async (id) => [id, await helpCenterOf(id)] as const,
				),
			),
		);
		return {
			brands,
			brand,
			center: helpCenterView(center),
			articles: rows.map((a) => ({
				...articleView(a, centers.get(a.organization_id) ?? null, false),
				brand: brands.find((b) => b.id === a.organization_id)?.name ?? null,
			})),
			gaps,
			categories,
		};
	});

export const articlePageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids, brands } = await scopeOf(context.organizationId);
			const a = await getArticle(ids, data.id);
			const center = await helpCenterOf(a.organization_id);
			return {
				article: articleView(a, center),
				center: helpCenterView(center),
				brand: brands.find((b) => b.id === a.organization_id) ?? null,
				categories: await articleCategories([a.organization_id]),
			};
		}),
	);

const articleFields = z.object({
	title: z.string().optional(),
	description: z.string().nullable().optional(),
	category: z.string().nullable().optional(),
	slug: z.string().optional(),
	// Checked in full by the server's own schema.
	design: z.unknown().optional(),
	html: z.string().optional(),
	status: z.enum(["draft", "published"]).optional(),
});

export const saveArticleFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(
		z.object({ brand: z.string().nullish(), id: z.string().optional(), fields: articleFields }),
	)
	.handler(({ data, context }) =>
		call(async () => {
			if (data.id) {
				const { ids } = await scopeOf(context.organizationId);
				const a = await getArticle(ids, data.id);
				const row = await updateArticle(a.organization_id, a.id, data.fields);
				return articleView(row, await helpCenterOf(row.organization_id));
			}
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			const row = await createArticle(brand, data.fields, context.userId);
			return articleView(row, await helpCenterOf(brand));
		}),
	);

export const deleteArticleFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const x = await getArticle(ids, data.id);
			const a = await deleteArticle(x.organization_id, x.id);
			return { ok: true, id: a.id, title: a.title };
		}),
	);

export const saveHelpCenterFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(
		z.object({
			brand: z.string().nullish(),
			fields: z.object({
				title: z.string().optional(),
				intro: z.string().nullable().optional(),
				slug: z.string().optional(),
				enabled: z.boolean().optional(),
				accent: z.string().nullable().optional(),
			}),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return helpCenterView(await saveHelpCenter(brand, data.fields, context.userId));
		}),
	);

export const dismissGapFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(z.object({ question: z.string().max(300) }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			await dismissGap(ids, data.question);
			return { ok: true };
		}),
	);
