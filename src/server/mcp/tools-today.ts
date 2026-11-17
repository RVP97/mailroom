import { viewScope } from "../brands";
import { today } from "../today";
import { brand, brandsOf, dashboardUrl, orgAt, organization, type Tool } from "./kit";

/** Today: what needs the person now (the dashboard's Today page). */
export const TODAY_TOOLS: Tool[] = [
	{
		name: "get_today",
		title: "What needs me today",
		description:
			"What needs the signed-in person now, across the organization's brands (or one): broadcasts waiting for their approval and their own sent back with changes, open conversations past or within 2 hours of their SLA, conversations assigned to them (and how many have nobody), notes that @mention them on open conversations, broadcasts sending now or scheduled before midnight (the deployment's time zone), unhappy survey answers from the last 24 hours (NPS 0-6, satisfaction 1-2), and delivery problems (SES pauses, bounce/complaint limits, paused or failing domains). Start a day with it.",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const [brands, scope] = await Promise.all([
				brandsOf(org.id, a.brand),
				viewScope(org.id),
			]);
			const found = await today({
				brands,
				userId: ctx.userId,
				canApprove: org.access.can("broadcasts:approve"),
				canReply: org.access.can("inbox:reply"),
				names: new Map(scope.brands.map((b) => [b.id, b.name])),
			});
			return withUrls(found, (path) => dashboardUrl(org, path));
		},
	},
];

/** Every item's dashboard `link` ("/domains/x") gets its full `url` in the organization too. */
function withUrls<T>(value: T, url: (path: string) => string): T {
	if (Array.isArray(value)) return value.map((v) => withUrls(v, url)) as T;
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = withUrls(v, url);
	const link = (value as { link?: unknown }).link;
	if (typeof link === "string" && link.startsWith("/")) out.url = url(link);
	return out as T;
}
