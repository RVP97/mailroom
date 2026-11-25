import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	AI_AUTO_MODES,
	AI_PROVIDERS,
	AI_TONES,
	aiSettingsView,
	clearAiSettings,
	draftReplyWithAi,
	getAiSettings,
	polishReplyWithAi,
	saveAiSettings,
	summarizeConversationWithAi,
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
