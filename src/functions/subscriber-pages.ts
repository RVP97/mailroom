import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn } from "@/server/brands";
import { can, orgMiddleware } from "@/server/middleware";
import {
	brandDress,
	getSubscriberPage,
	resetSubscriberPage,
	saveSubscriberPage,
} from "@/server/subscriber-pages";
import { call } from "./call";

/** A brand's unsubscribe and preferences page (src/lib/subscriber-page.ts). */

/** The saved page and what it takes from the brand (the editor draws its preview with it). */
export const subscriberPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandIn(context.organizationId, data.brand);
			const [page, dress] = await Promise.all([getSubscriberPage(brand), brandDress(brand)]);
			return { ...page, dress };
		}),
	);

export const saveSubscriberPageFn = createServerFn({ method: "POST" })
	.middleware([can("brands:edit")])
	.validator(z.object({ brand: z.string(), page: z.record(z.string(), z.unknown()) }))
	.handler(({ data, context }) =>
		call(async () =>
			saveSubscriberPage(
				await brandIn(context.organizationId, data.brand),
				data.page,
				context.userId,
			),
		),
	);

export const resetSubscriberPageFn = createServerFn({ method: "POST" })
	.middleware([can("brands:edit")])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await resetSubscriberPage(await brandIn(context.organizationId, data.brand));
			return { ok: true };
		}),
	);
