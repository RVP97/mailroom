import { z } from "zod";
import { viewScope } from "../brands";
import { contentCalendar } from "../calendar";
import { brand, brandsOf, orgAt, organization, type Tool } from "./kit";

/** The content calendar (the dashboard's Calendar page). */
export const CALENDAR_TOOLS: Tool[] = [
	{
		name: "get_calendar",
		title: "Content calendar",
		description:
			"What's on the content calendar from `from` to `to` (days, YYYY-MM-DD, both included, at most 62 days apart; the deployment's time zone), across the organization's brands (or one): each broadcast and newsletter issue on the day it went out (sent / sending), goes out (scheduled, with its time) or is planned for (a draft's planned_on), and the campaigns running in those days. Plan a draft on a day with save_broadcast's planned_on.",
		input: {
			organization,
			brand,
			from: z.string().describe("First day, YYYY-MM-DD"),
			to: z.string().describe("Last day, YYYY-MM-DD"),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const [brands, scope] = await Promise.all([
				brandsOf(org.id, a.brand),
				viewScope(org.id),
			]);
			return contentCalendar({
				brands,
				names: new Map(scope.brands.map((b) => [b.id, b.name])),
				from: a.from as string,
				to: a.to as string,
			});
		},
	},
];
