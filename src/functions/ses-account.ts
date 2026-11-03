import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { ApiError } from "@/server/errors";
import { orgMiddleware } from "@/server/middleware";
import {
	cancelMove,
	checkMove,
	completeMove,
	connectOrgAws,
	disconnectOrgAws,
	ownAccountCosts,
	ownAccountStatus,
} from "@/server/org-aws-manage";

/**
 * An organization's own Amazon SES account (Settings), optional: everyone sees whether it has
 * one; only this deployment's admins connect, replace, move or remove it, and see its costs.
 */

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
		throw error;
	}
}

const adminOnly = (isAdmin: boolean) => {
	if (!isAdmin)
		throw new Response("Only this deployment's admins can change the SES account", {
			status: 403,
		});
};

export const ownSesAccountFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ check: z.boolean().optional() }).default({}))
	.handler(async ({ data, context }) => ({
		...(await apiCall(() =>
			ownAccountStatus(context.organizationId, { check: data.check ?? true }),
		)),
		canEdit: context.isAdmin,
	}));

export const connectOwnSesAccountFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			accessKeyId: z.string().max(128),
			secretAccessKey: z.string().max(256),
			region: z.string().max(32),
		}),
	)
	.handler(async ({ data, context }) => {
		adminOnly(context.isAdmin);
		return {
			...(await apiCall(() => connectOrgAws(context.organizationId, data, context.userId))),
			canEdit: true,
		};
	});

export const disconnectOwnSesAccountFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		adminOnly(context.isAdmin);
		return {
			...(await apiCall(() => disconnectOrgAws(context.organizationId, context.userId))),
			canEdit: true,
		};
	});

/** A move to another account: check its domains now (and finish it if all are verified), or cancel it. */
export const ownSesMoveFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ action: z.enum(["check", "cancel"]) }))
	.handler(async ({ data, context }) => {
		adminOnly(context.isAdmin);
		const org = context.organizationId;
		return {
			...(await apiCall(async () => {
				if (data.action === "cancel") return cancelMove(org);
				const move = await db
					.select()
					.from(schema.orgAwsMoves)
					.where(eq(schema.orgAwsMoves.organization_id, org))
					.get();
				if (move && (await checkMove(move))) await completeMove(org);
				return ownAccountStatus(org, { check: true });
			})),
			canEdit: true,
		};
	});

export const ownSesCostsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ force: z.boolean().optional() }).default({}))
	.handler(async ({ data, context }) => {
		adminOnly(context.isAdmin);
		return apiCall(() => ownAccountCosts(context.organizationId, { force: data.force }));
	});
