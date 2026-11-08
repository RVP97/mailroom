import { z } from "zod";
import { viewScope } from "../brands";
import { SEARCH_KINDS, type SearchKind, searchEverything } from "../search";
import { personActor } from "./inbox-tools";
import { brand, brandsOf, orgAt, organization, type Tool } from "./kit";

/** Search everything (the dashboard's ⌘K). */
export const SEARCH_TOOLS: Tool[] = [
	{
		name: "search_everything",
		title: "Search everything",
		description:
			"Finds what matches `query` (at least 2 characters) across the organization's brands (or one): contacts (address or name), conversations (subject, contact, messages), broadcasts and newsletter issues, templates, segments, automations, newsletters, campaigns, surveys, help articles and domains. Each hit has its kind, id, title, a detail line and its dashboard path; use the id with that kind's get_ tool. `kinds` narrows it; `per` is how many of each kind (default 5, at most 20).",
		input: {
			organization,
			brand,
			query: z.string().max(200),
			kinds: z
				.array(z.enum(SEARCH_KINDS as [SearchKind, ...SearchKind[]]))
				.optional()
				.describe("Only these kinds"),
			per: z.number().int().min(1).max(20).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const [brands, scope, actor] = await Promise.all([
				brandsOf(org.id, a.brand),
				viewScope(org.id),
				personActor(org, ctx),
			]);
			return searchEverything({
				organizationId: org.id,
				brands,
				actor,
				q: a.query as string,
				names: new Map(scope.brands.map((b) => [b.id, b.name])),
				masked: org.masked,
				per: a.per as number | undefined,
				kinds: a.kinds as SearchKind[] | undefined,
			});
		},
	},
];
