import { z } from "zod";
import { AccessError } from "../access";
import {
	AI_AUTO_MODES,
	AI_PROVIDERS,
	aiSettingsView,
	draftReplyWithAi,
	getAiSettings,
	saveAiSettings,
	summarizeConversationWithAi,
} from "../ai";
import { personActor } from "./inbox-tools";
import { organization, type Tool } from "./kit";
import type { McpContext, Membership } from "./tools";

function orgFor(ctx: McpContext, ref: string | undefined, perm?: "settings:manage"): Membership {
	const found = ref
		? ctx.organizations.find(
				(o) => o.id === ref || o.slug === ref || o.handle === ref || o.name === ref,
			)
		: ctx.organizations[0];
	if (!found) throw new Error("Organization not found");
	if (perm && !found.access.can(perm))
		throw new AccessError("You don't have permission for that");
	return found;
}

export const AI_TOOLS: Tool[] = [
	{
		name: "get_ai_settings",
		title: "Get AI assistant settings",
		description:
			"Read the organization's optional BYO-key AI Copilot and auto-responder configuration (provider, model, auto mode, whether a key is saved — never returns the key itself).",
		input: { organization },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			return aiSettingsView(await getAiSettings(org.id));
		},
	},
	{
		name: "save_ai_settings",
		title: "Update AI assistant settings",
		description:
			"Configure the organization's BYO-key AI Copilot and auto-responder settings (provider, model, base_url, copilot_enabled, auto_mode off/draft/reply, system_prompt). API keys are set in the dashboard for safety.",
		input: {
			organization,
			provider: z.enum(AI_PROVIDERS).optional(),
			model: z.string().min(1).max(120).optional(),
			base_url: z.string().max(500).nullable().optional(),
			copilot_enabled: z.boolean().optional(),
			auto_mode: z.enum(AI_AUTO_MODES).optional(),
			system_prompt: z.string().max(4000).nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined, "settings:manage");
			const { organization: _o, ...rest } = a;
			return saveAiSettings(org.id, rest, ctx.userId);
		},
	},
	{
		name: "ai_draft_reply",
		title: "Draft a conversation reply with AI",
		description:
			"Use the organization's configured AI Copilot to draft a reply for a conversation, grounded in its Help Center articles, saved replies and contact history.",
		input: {
			organization,
			conversation_id: z.string().describe("Conversation id."),
			instruction: z
				.string()
				.max(1000)
				.optional()
				.describe("Optional guidance (e.g. offer a 20% refund)."),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			const actor = await personActor(org, ctx);
			return draftReplyWithAi(
				actor,
				a.conversation_id as string,
				a.instruction as string | undefined,
			);
		},
	},
	{
		name: "ai_summarize_conversation",
		title: "Summarize a conversation with AI",
		description:
			"Generate a short summary, bullet points and customer sentiment for a conversation using the organization's configured AI Copilot.",
		input: {
			organization,
			conversation_id: z.string().describe("Conversation id."),
		},
		readOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgFor(ctx, a.organization as string | undefined);
			const actor = await personActor(org, ctx);
			return summarizeConversationWithAi(actor, a.conversation_id as string);
		},
	},
];
