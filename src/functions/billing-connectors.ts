import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { BILLING_PROVIDERS } from "@/lib/billing-providers";
import {
	deleteBillingConnector,
	listBillingConnectors,
	saveBillingConnector,
} from "@/server/billing-connectors";
import { brandIn, viewScope } from "@/server/brands";
import { can } from "@/server/middleware";
import { call } from "./call";

export const listBillingConnectorsFn = createServerFn({ method: "GET" })
	.middleware([can("settings:manage")])
	.handler(({ context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			return { brands, connectors: await listBillingConnectors(ids) };
		}),
	);

export const saveBillingConnectorFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			brand: z.string().optional(),
			id: z.string().optional(),
			provider: z.enum(BILLING_PROVIDERS),
			name: z.string().min(1).max(80),
			signing_secret: z.string().max(500).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return saveBillingConnector(brand, data, context.userId);
		}),
	);

export const deleteBillingConnectorFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			return deleteBillingConnector(ids, data.id);
		}),
	);
