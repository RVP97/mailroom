import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { RECIPES } from "@/lib/automation-recipes";
import {
	automationOptions,
	automationRuns,
	automationView,
	cancelRun,
	createAutomation,
	deleteAutomation,
	duplicateAutomation,
	getAutomation,
	listAutomations,
	updateAutomation,
} from "@/server/automations";
import { brandIn, viewScope } from "@/server/brands";
import { listBroadcasts } from "@/server/broadcasts";
import { listProperties, listSegments, listTopics } from "@/server/contacts";
import { can, orgMiddleware } from "@/server/middleware";
import { revenueOf } from "@/server/revenue";
import { listTemplates, templateView } from "@/server/templates";
import { call } from "./call";

/** The Automations pages. */

/** A recipe's From (the brand's first verified domain) and who on the team it tells (you). */
async function recipeContext(brand: string, userId: string) {
	const { orgContext } = await import("@/server/org");
	const { db } = await import("@/server/db");
	const { user } = await import("@/server/db/auth-schema");
	const { eq } = await import("drizzle-orm");
	const ctx = await orgContext(brand);
	const domain = ctx.domains.find((d) => d.verified)?.name;
	const me = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).get();
	return {
		from: domain ? `hello@${domain}` : "hello@example.com",
		team: me ? [me.email] : [],
	};
}

async function brandsOf(organizationId: string) {
	const { brands } = await viewScope(organizationId);
	return { brands, ids: brands.length ? brands.map((b) => b.id) : [organizationId] };
}

export const listAutomationsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, ids } = await brandsOf(context.organizationId);
		const scope = data.brand
			? [await call(() => brandIn(context.organizationId, data.brand as string))]
			: ids;
		const rows = await listAutomations(scope);
		const stats = await Promise.all(rows.map((x) => automationRuns(x.id, 0)));
		const brandName = new Map(brands.map((b) => [b.id, b.name]));
		return {
			brands,
			automations: rows.map((x, i) => ({
				...automationView(x),
				brand: brandName.get(x.organization_id) ?? null,
				counts: stats[i]?.counts ?? {},
			})),
		};
	});

export const getAutomationFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands, ids } = await brandsOf(context.organizationId);
			const x = await getAutomation(ids, data.id);
			const [runs, segments, topics, templates, properties, broadcasts, more, revenue] =
				await Promise.all([
					automationRuns(x.id, 50),
					listSegments(x.organization_id),
					listTopics(x.organization_id),
					listTemplates(context.organizationId),
					listProperties(x.organization_id),
					listBroadcasts([x.organization_id], { limit: 100 }),
					automationOptions(x.organization_id),
					revenueOf("automation", x.id),
				]);
			return {
				...more,
				/** Purchases credited to its emails, each currency apart. */
				revenue,
				events: more.events.map((e) => e.name),
				automation: automationView(x),
				brand: brands.find((b) => b.id === x.organization_id) ?? null,
				...runs,
				segments: segments.map((s) => ({ id: s.id, name: s.name, live: !!s.rules })),
				topics: topics.map((t) => ({ id: t.id, name: t.name })),
				properties: properties.map((p) => ({ key: p.key, type: p.type })),
				broadcasts: broadcasts
					.filter((b) => b.status !== "draft")
					.map((b) => ({ id: b.id, name: b.name, subject: b.subject })),
				templates: templates.map(templateView).map((t) => ({
					id: t.id,
					name: t.name,
					alias: t.alias,
					published: t.status === "published",
					from: t.from,
					subject: t.subject,
				})),
			};
		}),
	);

export const createAutomationFn = createServerFn({ method: "POST" })
	.middleware([can("automations:edit")])
	.validator(z.object({ brand: z.string().nullish(), recipe: z.string().nullish() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			const recipe = data.recipe ? RECIPES.find((r) => r.id === data.recipe) : null;
			const x = await createAutomation(
				brand,
				recipe
					? recipe.build(await recipeContext(brand, context.userId))
					: {
							name: "Untitled automation",
							trigger: { type: "contact.created" },
							steps: [],
						},
			);
			return { id: x.id };
		}),
	);

export const saveAutomationFn = createServerFn({ method: "POST" })
	.middleware([can("automations:edit")])
	.validator(
		z.object({
			id: z.string(),
			fields: z.object({
				name: z.string().optional(),
				status: z.enum(["draft", "active", "paused"]).optional(),
				// Checked in full by the automation's own input (src/server/automations.ts).
				trigger: z.record(z.string(), z.unknown()).optional(),
				steps: z.array(z.record(z.string(), z.unknown())).optional(),
				reentry: z.boolean().optional(),
				goal_event: z.string().nullish(),
			}),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await brandsOf(context.organizationId);
			const x = await getAutomation(ids, data.id);
			const row = await updateAutomation(x.organization_id, x.id, data.fields);
			return automationView(row);
		}),
	);

export const deleteAutomationFn = createServerFn({ method: "POST" })
	.middleware([can("automations:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await brandsOf(context.organizationId);
			const x = await getAutomation(ids, data.id);
			await deleteAutomation(x.organization_id, x.id);
			return { ok: true };
		}),
	);

export const duplicateAutomationFn = createServerFn({ method: "POST" })
	.middleware([can("automations:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await brandsOf(context.organizationId);
			return { id: (await duplicateAutomation(ids, data.id)).id };
		}),
	);

export const cancelRunFn = createServerFn({ method: "POST" })
	.middleware([can("automations:activate")])
	.validator(z.object({ automation: z.string(), run: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await brandsOf(context.organizationId);
			const x = await getAutomation(ids, data.automation);
			await cancelRun(x.organization_id, data.run);
			return { ok: true };
		}),
	);
