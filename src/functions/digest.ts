import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { digestEnabled, sendDigest, setDigestEnabled } from "@/server/digest";
import { can, orgMiddleware } from "@/server/middleware";

/** Whether the organization's owners and admins get the weekly digest. */
export const getDigestFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => ({ on: await digestEnabled(context.organizationId) }));

export const setDigestFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ on: z.boolean() }))
	.handler(async ({ data, context }) => {
		await setDigestEnabled(context.organizationId, data.on);
		return { on: data.on };
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
