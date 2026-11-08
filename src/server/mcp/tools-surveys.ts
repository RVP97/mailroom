import { z } from "zod";
import {
	createSurvey,
	deleteSurvey,
	getSurvey,
	listResponses,
	listSurveys,
	surveyResults,
	surveyView,
	updateSurvey,
} from "../surveys";
import {
	brand,
	brandOf,
	brandsOf,
	defined,
	logged,
	oneBrand,
	orgAt,
	organization,
	type Tool,
} from "./kit";

/** Surveys: NPS, satisfaction and one-question surveys, their results and answers. */

const WHERE =
	"Ask it in an email with the editor's survey block ({ type: 'survey', survey_id, kind, question, options, low_label, high_label, align }: each answer links to {{{SURVEY_URL}}}/<survey>/<answer>, filled per contact), on the web at its url, in a website chat when it ends (save_chat_widget design.survey_id), or after support conversations (update_inbox_workflow csat.survey_id).";

export const SURVEY_TOOLS: Tool[] = [
	{
		name: "list_surveys",
		title: "List surveys",
		description:
			"The brand's surveys (NPS 0-10, csat 1-5, or choice): question, whether open, public url, how many answers and when the last came, with the last 90 days' score (nps, satisfied_pct and average, or the top choice).",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const brands = await brandsOf(org.id, a.brand);
			const rows = await listSurveys(brands);
			return Promise.all(
				rows.map(async (s) => ({
					...s,
					last_90_days: await surveyResults(await getSurvey(brands, s.id), { days: 90 }),
				})),
			);
		},
	},
	{
		name: "get_survey",
		title: "A survey's results and answers",
		description:
			"One survey with its results over `days` (all time without): total, NPS with promoters/passives/detractors, or average and % satisfied (4-5), or the top choice; how many picked each answer; answers by place (email, web, chat, conversation); and the latest answers with comments (comments_only for just those). Each answer has the contact, score or choice, NPS group and where it came from.",
		input: {
			organization,
			survey: z.string(),
			days: z.number().int().min(1).max(3650).optional(),
			comments_only: z.boolean().optional(),
			limit: z.number().int().min(1).max(200).optional(),
			offset: z.number().int().min(0).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const s = await getSurvey(await brandsOf(org.id), a.survey as string);
			const days = a.days as number | undefined;
			return {
				survey: surveyView(s),
				results: await surveyResults(s, { days }),
				answers: await listResponses(s, {
					days,
					comments: !!a.comments_only,
					limit: (a.limit as number | undefined) ?? 50,
					offset: (a.offset as number | undefined) ?? 0,
				}),
			};
		},
	},
	{
		name: "save_survey",
		title: "Make or change a survey",
		description: `Creates a survey (kind nps, csat or choice; sensible question and labels by default) or with \`survey\` changes one: name (only the team sees it), question, options (a choice's answers, 2-10), low_label/high_label (under the scale's ends), comment_prompt (the follow-up question; null: no comment box), thanks (after they answer), enabled (false closes it). The kind can't change once it has answers. Answers from known contacts are recorded as the event survey.answered ({ survey_id, survey, kind, score, answer, group, comment, source }), for automations; live segments take a { type: "survey", survey_id, answer: any|promoter|passive|detractor|at_least|at_most|choice, value, days } rule. ${WHERE}`,
		input: {
			organization,
			brand: oneBrand,
			survey: z.string().optional().describe("Its id, to change it"),
			name: z.string().max(80).optional(),
			kind: z.enum(["nps", "csat", "choice"]).optional(),
			question: z.string().max(300).optional(),
			options: z.array(z.string().max(120)).max(10).optional(),
			low_label: z.string().max(40).nullable().optional(),
			high_label: z.string().max(40).nullable().optional(),
			comment_prompt: z.string().max(200).nullable().optional(),
			thanks: z.string().max(300).optional(),
			enabled: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "surveys:edit");
			const fields = defined(a, ["organization", "brand", "survey"]);
			const row = a.survey
				? await getSurvey(await brandsOf(org.id), a.survey as string).then((s) =>
						updateSurvey(s.organization_id, s.id, fields),
					)
				: await createSurvey(await brandOf(org.id, a.brand), fields, ctx.userId);
			await logged(ctx, org, "survey.edited", { type: "survey", id: row.id, name: row.name });
			return surveyView(row);
		},
	},
	{
		name: "delete_survey",
		title: "Delete a survey",
		description:
			"Deletes a survey and its answers; its links in emails already sent stop working. The survey.answered events stay on the contacts.",
		input: { organization, survey: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "surveys:edit");
			const x = await getSurvey(await brandsOf(org.id), a.survey as string);
			await deleteSurvey(x.organization_id, x.id);
			await logged(ctx, org, "survey.deleted", { type: "survey", id: x.id, name: x.name });
			return { deleted: x.id };
		},
	},
];
