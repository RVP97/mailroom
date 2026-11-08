import { z } from "zod";
import {
	articleView,
	createArticle,
	deleteArticle,
	getArticle,
	helpCenterOf,
	helpCenterView,
	helpGaps,
	listArticles,
	saveHelpCenter,
	updateArticle,
} from "../help-center";
import {
	brand,
	brandOf,
	brandsOf,
	DESIGN_HELP,
	defined,
	logged,
	oneBrand,
	orgAt,
	organization,
	type Tool,
} from "./kit";

/** The help center: its articles, its public page, and the questions no article answers yet. */

const centers = async (ids: string[]) =>
	new Map(
		await Promise.all(
			[...new Set(ids)].map(async (id) => [id, await helpCenterOf(id)] as const),
		),
	);

export const HELP_TOOLS: Tool[] = [
	{
		name: "get_help_center",
		title: "A brand's help center",
		description:
			"A brand's help center: its public page (/help/<slug>, on the brand's own host when it has one), title, intro, whether it's on, and the questions people asked the website chat or the help center's search in the last 30 days that no published article answered (write those next). Null center: none yet (the first article makes it).",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			return {
				center: helpCenterView(await helpCenterOf(b)),
				questions_without_article: await helpGaps([b]),
			};
		},
	},
	{
		name: "update_help_center",
		title: "Change the help center's page",
		description:
			"Turns a brand's help center on (making it if needed) or changes it: title, intro (under the title), slug (its address /help/<slug>), enabled (false hides its pages and the chat's suggestions; articles stay), accent (#rrggbb).",
		input: {
			organization,
			brand: oneBrand,
			title: z.string().max(80).optional(),
			intro: z.string().max(300).nullable().optional(),
			slug: z.string().max(64).optional(),
			enabled: z.boolean().optional(),
			accent: z.string().nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "help:edit");
			const b = await brandOf(org.id, a.brand);
			const c = await saveHelpCenter(b, defined(a, ["organization", "brand"]), ctx.userId);
			await logged(ctx, org, "help_center.edited", {
				type: "help_center",
				id: b,
				name: c.title,
			});
			return helpCenterView(c);
		},
	},
	{
		name: "list_help_articles",
		title: "List help center articles",
		description:
			"The help center's articles: title, summary, category, status (draft|published), address, views and yes/no votes. q finds the ones that best answer a question (as the website chat does); status and category filter.",
		input: {
			organization,
			brand,
			q: z.string().max(500).optional(),
			status: z.enum(["draft", "published"]).optional(),
			category: z.string().optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const rows = await listArticles(await brandsOf(org.id, a.brand), {
				q: (a.q as string | undefined) || undefined,
				status: a.status as "draft" | "published" | undefined,
				category: (a.category as string | undefined) || undefined,
			});
			const cs = await centers(rows.map((r) => r.organization_id));
			return rows.map((r) => articleView(r, cs.get(r.organization_id) ?? null, false));
		},
	},
	{
		name: "get_help_article",
		title: "A help center article",
		description:
			"One article by id or slug: everything, with its design, HTML and plain words.",
		input: { organization, article: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const x = await getArticle(await brandsOf(org.id), a.article as string);
			return articleView(x, await helpCenterOf(x.organization_id));
		},
	},
	{
		name: "save_help_article",
		title: "Write or edit a help article",
		description: `Creates an article in a brand's help center (title required), or with \`article\` edits one. Fields: title (the question people ask), description (one line in lists, search and the chat), category, slug (its address under the help center), status ("draft" or "published": only published ones are public and suggested in the chat), and its content as design (${DESIGN_HELP}) or html. The page shows it without the email's footer.`,
		input: {
			organization,
			brand: oneBrand,
			article: z.string().optional().describe("Its id or slug, to edit it"),
			title: z.string().max(160).optional(),
			description: z.string().max(300).nullable().optional(),
			category: z.string().max(60).nullable().optional(),
			slug: z.string().optional(),
			status: z.enum(["draft", "published"]).optional(),
			design: z.unknown().optional(),
			html: z.string().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "help:edit");
			const fields = defined(a, ["organization", "brand", "article"]);
			let row: Awaited<ReturnType<typeof getArticle>>;
			if (a.article) {
				const x = await getArticle(await brandsOf(org.id), a.article as string);
				row = await updateArticle(x.organization_id, x.id, fields);
			} else row = await createArticle(await brandOf(org.id, a.brand), fields, ctx.userId);
			await logged(ctx, org, "article.edited", {
				type: "article",
				id: row.id,
				name: row.title,
			});
			return articleView(row, await helpCenterOf(row.organization_id));
		},
	},
	{
		name: "delete_help_article",
		title: "Delete a help article",
		description:
			"Deletes an article: it leaves the help center at once and links to it stop working.",
		input: { organization, article: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "help:edit");
			const x = await getArticle(await brandsOf(org.id), a.article as string);
			await deleteArticle(x.organization_id, x.id);
			await logged(ctx, org, "article.deleted", { type: "article", id: x.id, name: x.title });
			return { deleted: x.id };
		},
	},
];
