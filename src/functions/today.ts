import { createServerFn } from "@tanstack/react-start";
import { brandIds, viewScope } from "@/server/brands";
import { orgMiddleware } from "@/server/middleware";
import { today } from "@/server/today";

/** The Today page: what needs the signed-in member now, across every brand they can see. */
export const todayFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const [ids, { brands }] = await Promise.all([
			brandIds(context.organizationId),
			viewScope(context.organizationId),
		]);
		const data = await today({
			brands: ids,
			userId: context.userId,
			canApprove: context.access.can("broadcasts:approve"),
			canReply: context.access.can("inbox:reply"),
			names: new Map(brands.map((b) => [b.id, b.name])),
		});
		return { ...data, name: context.name || context.email };
	});
