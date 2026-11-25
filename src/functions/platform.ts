import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { TRANSPORT_PROVIDERS } from "@/lib/transports";
import { brandIn } from "@/server/brands";
import { importContactsBundle, importHelpArticlesBundle } from "@/server/importers";
import { can, orgMiddleware } from "@/server/middleware";
import { getBrandTransport, saveBrandTransport, transportView } from "@/server/transports";
import { call } from "./call";

export const getBrandTransportFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().optional() }).optional())
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data?.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return transportView(await getBrandTransport(brand));
		}),
	);

export const saveBrandTransportFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			brand: z.string().optional(),
			provider: z.enum(TRANSPORT_PROVIDERS),
			api_key: z.string().max(500).optional(),
			clear_key: z.boolean().optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return saveBrandTransport(brand, data, context.userId);
		}),
	);

export const importContactsBundleFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			brand: z.string().optional(),
			source: z.enum(["csv", "json"]),
			content: z.string().min(1).max(2_000_000),
			segment_id: z.string().nullable().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return importContactsBundle(brand, data);
		}),
	);

export const importHelpArticlesBundleFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(
		z.object({
			brand: z.string().optional(),
			content: z.string().min(1).max(2_000_000),
			publish: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return importHelpArticlesBundle(brand, data, context.userId);
		}),
	);
