import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn } from "@/server/brands";
import { can, orgMiddleware } from "@/server/middleware";
import {
	getSubscriberPage,
	previewSubscriberPage,
	resetSubscriberPage,
	saveSubscriberPage,
} from "@/server/subscriber-pages";
import { call } from "./call";

/** A brand's unsubscribe and preferences page (src/lib/subscriber-page.ts). */

export const subscriberPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string() }))
	.handler(({ data, context }) =>
		call(async () => getSubscriberPage(await brandIn(context.organizationId, data.brand))),
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

export const previewSubscriberPageFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			brand: z.string(),
			page: z.record(z.string(), z.unknown()),
			state: z.enum(["ask", "done", "back"]),
			lang: z.enum(["en", "es"]),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => ({
			html: await previewSubscriberPage(
				await brandIn(context.organizationId, data.brand),
				data.page,
				data.state,
				data.lang,
			),
		})),
	);
