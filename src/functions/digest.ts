import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import {
	combineDigestsEnabled,
	digestEnabled,
	sendCombinedDigest,
	sendDigest,
	setCombineDigests,
	setDigestEnabled,
} from "@/server/digest";
import { can, orgMiddleware, sessionMiddleware } from "@/server/middleware";

/** Whether the organization's owners and admins get the weekly digest, and the user's combine choice. */
export const getDigestFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const [on, combine] = await Promise.all([
			digestEnabled(context.organizationId),
			combineDigestsEnabled(context.userId),
		]);
		return { on, combine };
	});

export const setDigestFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ on: z.boolean() }))
	.handler(async ({ data, context }) => {
		await setDigestEnabled(context.organizationId, data.on);
		return { on: data.on };
	});

/** Whether the signed-in person combines all of their organizations' weekly digests into one email. */
export const getDigestPreferenceFn = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) => ({
		combine: await combineDigestsEnabled(context.userId),
	}));

export const setCombineDigestsFn = createServerFn({ method: "POST" })
	.middleware([sessionMiddleware])
	.validator(z.object({ combine: z.boolean() }))
	.handler(async ({ data, context }) => {
		await setCombineDigests(context.userId, data.combine);
		return { combine: data.combine };
	});

/** Last week's digest, now, only to the person asking. */
export const sendDigestNowFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const org = await db
			.select({ id: schema.organization.id, name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, context.organizationId))
			.get();
		if (!org) throw new Error("Organization not found");
		const lines = await sendDigest(org, Date.now(), { to: context.email });
		return { sent: !!lines, to: context.email };
	});

/** Last week's combined digest across all of the person's organizations, now, only to them. */
export const sendCombinedDigestNowFn = createServerFn({ method: "POST" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) =>
		sendCombinedDigest({
			userId: context.userId,
			email: context.email,
			isAdmin: context.isAdmin,
		}),
	);
