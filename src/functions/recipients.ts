import { createServerFn } from "@tanstack/react-start";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { listAccessLog } from "@/server/access-log";
import { brandIds, brandIn } from "@/server/brands";
import { db, schema } from "@/server/db";
import { ApiError } from "@/server/errors";
import { checkAddress, firewallsOf, firewallWithCounts, setFirewall } from "@/server/firewall";
import { lookupRecipient } from "@/server/lookup";
import { can, orgMiddleware } from "@/server/middleware";

/** A recipient across every brand, the email firewall and the access log. */

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
		throw error;
	}
}

/** Can this address get email, and what was sent to it. Logged in the access log. */
export const lookupRecipientFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ address: z.string().max(320) }))
	.handler(({ data, context }) =>
		apiCall(() =>
			lookupRecipient(
				context.organizationId,
				data.address,
				{
					channel: "dashboard",
					userId: context.userId,
					actor: context.email,
				},
				{ maskDigits: context.masked },
			),
		),
	);

/** Every brand's firewall, for Settings. */
export const firewallsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => firewallsOf(await brandIds(context.organizationId)));

/** One brand's firewall (each brand has its own). */
export const firewallFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string() }))
	.handler(async ({ data, context }) =>
		apiCall(async () => firewallWithCounts(await brandIn(context.organizationId, data.brand))),
	);

export const updateFirewallFn = createServerFn({ method: "POST" })
	.middleware([can("recipients:block")])
	.validator(
		z.object({
			brand: z.string(),
			block_disposable: z.boolean().optional(),
			block_free: z.boolean().optional(),
			block_plus: z.boolean().optional(),
			never: z.array(z.string().max(320)).max(1000).optional(),
			always: z.array(z.string().max(320)).max(1000).optional(),
		}),
	)
	.handler(({ data: { brand, ...patch }, context }) =>
		apiCall(async () => setFirewall(await brandIn(context.organizationId, brand), patch)),
	);

/** What the firewall would do with one address (the settings' «Check»). */
export const testFirewallFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string(), address: z.string().max(320) }))
	.handler(({ data, context }) =>
		apiCall(async () =>
			checkAddress(await brandIn(context.organizationId, data.brand), data.address),
		),
	);

/** Who looked up recipients or let them receive again, newest first. */
export const accessLogFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const rows = await listAccessLog(context.organizationId, 200);
		const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
		const people = ids.length
			? await db
					.select({
						id: schema.user.id,
						name: schema.user.name,
						email: schema.user.email,
					})
					.from(schema.user)
					.where(inArray(schema.user.id, ids.slice(0, 90)))
			: [];
		const byId = new Map(people.map((p) => [p.id, p]));
		return rows.map((r) => ({
			...r,
			who: (r.user_id && byId.get(r.user_id)?.name) || r.actor || "Someone",
		}));
	});
