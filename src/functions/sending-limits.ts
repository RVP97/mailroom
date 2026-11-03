import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminMiddleware, orgMiddleware } from "@/server/middleware";
import {
	getSendingLimits,
	organizationActions,
	setOrganizationActions,
	setSendingLimits,
} from "@/server/sending-limits";

/** The deployment's sending limits (Admin), and an organization's own actions (Settings). */

export const sendingLimitsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => ({
		limits: await getSendingLimits(),
		actions: await organizationActions(context.organizationId),
		canEdit: context.isAdmin,
	}));

export const saveSendingLimitsFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator((raw: unknown) => raw)
	.handler(async ({ data }) => {
		try {
			return await setSendingLimits(data);
		} catch (error) {
			const message =
				error instanceof z.ZodError
					? (error.issues[0]?.message ?? "Check the numbers")
					: String(error);
			throw new Response(message, { status: 422 });
		}
	});

const action = z.enum(["alert", "pause"]).nullable().optional();

/** Only the deployment's admins: an organization can't lift Mailroom's pauses on itself. */
export const setOrganizationActionsFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ transactional: action, marketing: action }))
	.handler(async ({ data, context }) => {
		if (!context.isAdmin)
			throw new Response("Only this deployment's admins can change this", { status: 403 });
		return setOrganizationActions(context.organizationId, data);
	});
