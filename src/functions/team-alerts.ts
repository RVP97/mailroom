import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { can } from "@/server/middleware";
import {
	ALERT_EVENTS,
	ALERT_KINDS,
	deleteAlertChannel,
	listAlertChannels,
	saveAlertChannel,
	testAlertChannel,
} from "@/server/team-alerts";
import { call } from "./call";

export const listAlertChannelsFn = createServerFn({ method: "GET" })
	.middleware([can("settings:manage")])
	.handler(({ context }) => call(() => listAlertChannels(context.organizationId)));

export const saveAlertChannelFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			id: z.string().optional(),
			kind: z.enum(ALERT_KINDS).optional(),
			name: z.string().min(1).max(80),
			webhook_url: z.string().max(2000).optional(),
			events: z.array(z.enum(ALERT_EVENTS)).min(1),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveAlertChannel(context.organizationId, data, context.userId)),
	);

export const deleteAlertChannelFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(() => deleteAlertChannel(context.organizationId, data.id)),
	);

export const testAlertChannelFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) => call(() => testAlertChannel(context.organizationId, data.id)));
