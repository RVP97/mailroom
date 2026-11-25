import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn } from "@/server/brands";
import {
	linkConversationIssue,
	listConversationIssues,
	listOrgWebhookIntegrations,
	saveOrgWebhookIntegration,
	unlinkConversationIssue,
} from "@/server/issue-links";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

export const listConversationIssuesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ conversationId: z.string() }))
	.handler(({ data }) => call(() => listConversationIssues(data.conversationId)));

export const linkConversationIssueFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			brand: z.string(),
			conversationId: z.string(),
			url: z.string().url(),
			title: z.string().max(200).optional(),
			reopen_on_close: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandIn(context.organizationId, data.brand);
			return linkConversationIssue(
				brand,
				data.conversationId,
				{ url: data.url, title: data.title, reopen_on_close: data.reopen_on_close },
				context.userId,
			);
		}),
	);

export const unlinkConversationIssueFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ conversationId: z.string(), id: z.string() }))
	.handler(({ data }) => call(() => unlinkConversationIssue(data.conversationId, data.id)));

export const listWebhookIntegrationsFn = createServerFn({ method: "GET" })
	.middleware([can("settings:manage")])
	.handler(({ context }) => call(() => listOrgWebhookIntegrations(context.organizationId)));

export const saveWebhookIntegrationFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			kind: z.enum(["github", "linear", "slack", "whatsapp"]),
			secret: z.string().max(500).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveOrgWebhookIntegration(context.organizationId, data, context.userId)),
	);
