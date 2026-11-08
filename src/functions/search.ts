import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIds, viewScope } from "@/server/brands";
import { personOf } from "@/server/inboxes";
import { orgMiddleware } from "@/server/middleware";
import { searchEverything } from "@/server/search";

/** ⌘K: everything in the organization matching what's typed. */
export const searchEverythingFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ q: z.string().max(200) }))
	.handler(async ({ data, context }) => {
		const [brands, scope, actor] = await Promise.all([
			brandIds(context.organizationId),
			viewScope(context.organizationId),
			personOf(context),
		]);
		return searchEverything({
			organizationId: context.organizationId,
			brands,
			actor,
			q: data.q,
			names: new Map(scope.brands.map((b) => [b.id, b.name])),
			masked: context.masked,
		});
	});
