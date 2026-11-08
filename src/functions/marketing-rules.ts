import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { marketingRules, setMarketingRules } from "@/server/marketing-rules";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

/** Quiet mode and the frequency cap of the organization (Settings → Sending). */
export const getMarketingRulesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => marketingRules(context.organizationId));

export const setMarketingRulesFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			quiet_mode: z.boolean().optional(),
			cap: z
				.object({
					count: z.number().int().min(1).max(100),
					days: z.number().int().min(1).max(90),
				})
				.nullable()
				.optional(),
		}),
	)
	.handler(async ({ data, context }) =>
		call(() => setMarketingRules(context.organizationId, data)),
	);
