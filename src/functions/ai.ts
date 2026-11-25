import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	AI_AUTO_MODES,
	AI_PROVIDERS,
	AI_TONES,
	aiAssistEmailCopy,
	aiDraftHelpArticle,
	aiSettingsView,
	aiTranslateHelpArticle,
	clearAiSettings,
	draftReplyWithAi,
	getAiSettings,
	polishReplyWithAi,
	saveAiSettings,
	summarizeConversationWithAi,
	triageConversationWithAi,
} from "@/server/ai";
import { personOf } from "@/server/inboxes";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

export const getAiSettingsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) =>
		call(async () => aiSettingsView(await getAiSettings(context.organizationId))),
	);

export const saveAiSettingsFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			provider: z.enum(AI_PROVIDERS).optional(),
			model: z.string().trim().min(1).max(120).optional(),
			base_url: z.string().trim().max(500).nullable().optional(),
			api_key: z.string().trim().min(4).max(500).optional(),
			clear_key: z.boolean().optional(),
			copilot_enabled: z.boolean().optional(),
			auto_mode: z.enum(AI_AUTO_MODES).optional(),
			system_prompt: z.string().max(4000).nullable().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveAiSettings(context.organizationId, data, context.userId)),
	);

export const clearAiSettingsFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.handler(({ context }) => call(() => clearAiSettings(context.organizationId)));

export const aiDraftReplyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			conversation: z.string(),
			instruction: z.string().max(1000).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () =>
			draftReplyWithAi(await personOf(context), data.conversation, data.instruction),
		),
	);

export const aiSummarizeFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ conversation: z.string() }))
	.handler(({ data, context }) =>
		call(async () => summarizeConversationWithAi(await personOf(context), data.conversation)),
	);

export const aiTriageConversationFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ conversation: z.string() }))
	.handler(({ data, context }) =>
		call(async () => triageConversationWithAi(await personOf(context), data.conversation)),
	);

export const aiPolishFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			text: z.string().min(1).max(12_000),
			tone: z.enum(AI_TONES),
		}),
	)
	.handler(({ data, context }) =>
		call(() => polishReplyWithAi(context.organizationId, data.text, data.tone)),
	);

export const aiEmailAssistFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			mode: z.enum(["subjects", "rewrite", "spam_check"]),
			subject: z.string().max(300).optional(),
			body: z.string().min(1).max(12_000),
			instruction: z.string().max(500).optional(),
		}),
	)
	.handler(({ data, context }) => call(() => aiAssistEmailCopy(context.organizationId, data)));

export const aiDraftHelpArticleFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(
		z.object({
			brand: z.string().optional(),
			question: z.string().min(2).max(400),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const { brandIn } = await import("@/server/brands");
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return aiDraftHelpArticle(context.organizationId, brand, data.question);
		}),
	);

export const aiTranslateHelpArticleFn = createServerFn({ method: "POST" })
	.middleware([can("help:edit")])
	.validator(
		z.object({
			title: z.string().min(1).max(160),
			description: z.string().max(300).nullable().optional(),
			category: z.string().max(60).nullable().optional(),
			html: z.string().max(500_000),
			locale: z.string().min(2).max(16),
		}),
	)
	.handler(({ data, context }) =>
		call(() =>
			aiTranslateHelpArticle(
				context.organizationId,
				{
					title: data.title,
					description: data.description,
					category: data.category,
					html: data.html,
				},
				data.locale,
			),
		),
	);
