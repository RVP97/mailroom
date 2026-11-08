import { z } from "zod";
import { answerToArticle, answerToSavedReply } from "../answer-reuse";
import { articleView, helpCenterOf } from "../help-center";
import { savedReplyView } from "../inbox-workflow";
import { personActor } from "./inbox-tools";
import { logged, orgAt, organization, type Tool } from "./kit";

const message_id = z
	.string()
	.describe(
		"A sent reply's id or a team chat line's id (get_conversation lists them in its timeline).",
	);

/** A good answer, kept (the conversation page's «Keep this answer» menu). */
export const ANSWER_TOOLS: Tool[] = [
	{
		name: "answer_to_article",
		title: "Make a help article from a reply",
		description:
			"Turns one of the team's replies in a conversation (an email reply or a chat line) into a draft help center article: titled by the visitor's question (chat) or the subject unless `title` is given, with the greeting and the person's name taken out. Publish it with save_help_article.",
		input: { organization, message_id, title: z.string().max(160).optional() },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "help:edit");
			const actor = await personActor(org, ctx);
			const { article } = await answerToArticle(actor, a.message_id as string, {
				title: a.title as string | undefined,
				userId: ctx.userId,
			});
			await logged(ctx, org, "article.from_answer", {
				type: "article",
				id: article.id,
				name: article.title,
			});
			return articleView(article, await helpCenterOf(article.organization_id));
		},
	},
	{
		name: "answer_to_saved_reply",
		title: "Make a saved reply from a reply",
		description:
			"Turns one of the team's replies in a conversation (an email reply or a chat line) into a saved reply for every inbox of the brand, named after the subject unless `name` is given; the person's first name becomes {{contact.first_name}}. Change it with save_saved_reply.",
		input: { organization, message_id, name: z.string().max(100).optional() },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "inbox:reply");
			const actor = await personActor(org, ctx);
			const { reply } = await answerToSavedReply(actor, a.message_id as string, {
				name: a.name as string | undefined,
				userId: ctx.userId,
			});
			await logged(ctx, org, "saved_reply.from_answer", {
				type: "saved_reply",
				id: reply.id,
				name: reply.name,
			});
			return savedReplyView(reply);
		},
	},
];
