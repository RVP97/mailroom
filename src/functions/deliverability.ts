import { createServerFn } from "@tanstack/react-start";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { brandIds } from "@/server/brands";
import { db, schema } from "@/server/db";
import { checkDomainHealth, domainHealth, healthView } from "@/server/deliverability";
import { can, orgMiddleware } from "@/server/middleware";

/** The deliverability watch on a domain's page. */

async function ownDomain(organizationId: string, id: string) {
	const d = await db
		.select()
		.from(schema.domains)
		.where(
			and(
				eq(schema.domains.id, id),
				inArray(schema.domains.organization_id, await brandIds(organizationId)),
			),
		)
		.get();
	if (!d) throw new Response("Domain not found", { status: 404 });
	return d;
}

export const domainHealthFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) =>
		domainHealth((await ownDomain(context.organizationId, data.id)).id),
	);

/** Checks now (it doesn't email: the person is looking at it). */
export const checkDomainHealthFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const d = await ownDomain(context.organizationId, data.id);
		const row = await checkDomainHealth(d, { notify: false });
		return healthView({ ...row, alerted: row.alerted });
	});
