import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import {
	companyForEmail,
	companyInput,
	deleteCompany,
	getCompany,
	listCompanies,
	upsertCompany,
} from "@/server/companies";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

export const listCompaniesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().optional(), search: z.string().optional() }).optional())
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			const scope = data?.brand ? [await brandIn(context.organizationId, data.brand)] : ids;
			return {
				brands,
				companies: await listCompanies(scope, { search: data?.search }),
			};
		}),
	);

export const getCompanyFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			return getCompany(ids, data.id);
		}),
	);

export const saveCompanyFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			brand: z.string().optional(),
			id: z.string().optional(),
			fields: companyInput,
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return upsertCompany(brand, data.fields, { id: data.id });
		}),
	);

export const deleteCompanyFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			return deleteCompany(ids, data.id);
		}),
	);

export const companyForEmailFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string(), email: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandIn(context.organizationId, data.brand);
			return companyForEmail(brand, data.email);
		}),
	);
