import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import { listSegments } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { can, orgMiddleware } from "@/server/middleware";
import {
	brandLooks,
	createForm,
	deleteForm,
	formEmbed,
	formView,
	getForm,
	listForms,
	turnstileFor,
	updateForm,
} from "@/server/signup-forms";
import { brandWidget, turnstileConfigured } from "@/server/turnstile";
import { call } from "./call";

/** Contacts › Forms: the brands' public sign-up forms, with what each needs to be set up. */

async function brandList(organizationId: string) {
	const { brands } = await viewScope(organizationId);
	return brands.length ? brands : [{ id: organizationId, name: "" }];
}

export const listFormsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const brands = await brandList(context.organizationId);
		const ids = brands.map((b) => b.id);
		const forms = await listForms(ids);
		const widgets = new Map(
			(
				await db
					.select()
					.from(schema.turnstileWidgets)
					.where(inArray(schema.turnstileWidgets.organization_id, ids))
			).map((w) => [w.organization_id, w]),
		);
		const per = await Promise.all(
			brands.map(async (b) => {
				const [segments, topics, domains] = await Promise.all([
					listSegments(b.id),
					db
						.select({ id: schema.topics.id, name: schema.topics.name })
						.from(schema.topics)
						.where(eq(schema.topics.organization_id, b.id)),
					db
						.select({ name: schema.domains.name })
						.from(schema.domains)
						.where(
							and(
								eq(schema.domains.organization_id, b.id),
								eq(schema.domains.status, "verified"),
								eq(schema.domains.sending, true),
							),
						),
				]);
				return {
					id: b.id,
					segments: segments.map((s) => ({ id: s.id, name: s.name })),
					topics,
					domains: domains.map((d) => d.name),
				};
			}),
		);
		return {
			brands,
			options: Object.fromEntries(per.map((p) => [p.id, p])),
			turnstileConfigured: turnstileConfigured(),
			logos: await brandLooks(ids),
			forms: await Promise.all(
				forms.map(async (f) => {
					const w = widgets.get(f.organization_id);
					const sitekey = w?.sitekey && w.secret ? w.sitekey : null;
					return {
						...formView(f),
						...(await formEmbed(f, { sitekey })),
						turnstile: !!sitekey,
						turnstileError: w?.error ?? null,
					};
				}),
			),
		};
	});

const fields = z.object({
	brand: z.string().nullish(),
	name: z.string(),
	title: z.string(),
	from: z.string(),
	segment_id: z.string().nullable(),
	topic_id: z.string().nullable(),
	website: z.string().nullable(),
	redirect_url: z.string().nullable(),
	ask_name: z.boolean(),
	enabled: z.boolean(),
	design: z.record(z.string(), z.unknown()).optional(),
});

export const saveFormFn = createServerFn({ method: "POST" })
	.middleware([can("forms:edit")])
	.validator(z.object({ id: z.string().optional(), fields }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brand: named, ...f } = data.fields;
			const input = {
				...f,
				website: f.website?.trim() || null,
				redirect_url: f.redirect_url?.trim() || null,
			};
			if (data.id) {
				const ids = (await brandList(context.organizationId)).map((b) => b.id);
				const x = await getForm(ids, data.id);
				return formView(await updateForm(x.organization_id, x.id, input));
			}
			const brand = named
				? await brandIn(context.organizationId, named)
				: context.organizationId;
			return formView(await createForm(brand, input));
		}),
	);

export const deleteFormFn = createServerFn({ method: "POST" })
	.middleware([can("forms:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const ids = (await brandList(context.organizationId)).map((b) => b.id);
			const x = await getForm(ids, data.id);
			await deleteForm(x.organization_id, x.id);
			return { ok: true };
		}),
	);

/** Tries the brand's Turnstile widget again (after the API token got its permission). */
export const retryTurnstileFn = createServerFn({ method: "POST" })
	.middleware([can("forms:edit")])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandIn(context.organizationId, data.brand);
			const error = await turnstileFor(brand);
			return { error, on: !!(await brandWidget(brand)) };
		}),
	);
