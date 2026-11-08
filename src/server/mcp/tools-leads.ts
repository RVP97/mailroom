import { z } from "zod";
import { getContact } from "../contacts";
import {
	contactLeadScore,
	getScoring,
	resetScoring,
	ruleLabel,
	saveScoring,
	topLeads,
} from "../lead-score";
import { brandOf, logged, oneBrand, orgAt, organization, type Tool } from "./kit";

const RULES_HELP =
	"Each rule: { type: email, action: received|opened|clicked, points, max? } (points per marketing email, up to max), { type: event, name, key?, value?, points, max? } (per event your app sent, with that data if set), { type: purchase, points, max? } (per event with a value), or { type: match, condition, points } (once, if they match one live-segment condition, anything save_segment's rules take except engagement and lead_score). points: -100 to 100; label? names it.";

/** Lead scores (the dashboard's Contacts › Leads). */
export const LEAD_TOOLS: Tool[] = [
	{
		name: "list_leads",
		title: "Hottest leads",
		description:
			"A brand's contacts by lead score, highest first (only those above 0, or one level: hot|warm|cold), with how many are hot and warm and the scoring rules. A contact's own score and what each rule gave: get_lead_score.",
		input: {
			organization,
			brand: oneBrand,
			level: z.enum(["hot", "warm", "cold"]).optional(),
			limit: z.number().int().min(1).max(200).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const top = await topLeads(await brandOf(org.id, a.brand), {
				level: a.level as "hot" | "warm" | "cold" | undefined,
				limit: a.limit as number | undefined,
			});
			return {
				...top,
				scoring: { ...top.scoring, labels: top.scoring.rules.map(ruleLabel) },
			};
		},
	},
	{
		name: "get_lead_score",
		title: "A contact's lead score",
		description:
			"One contact's lead score (by id or address), its level (hot, warm or cold) and the points each rule gave.",
		input: { organization, brand: oneBrand, contact: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const brand = await brandOf(org.id, a.brand);
			const c = await getContact(brand, a.contact as string);
			return { contact_id: c.id, email: c.email, ...(await contactLeadScore(brand, c.id)) };
		},
	},
	{
		name: "get_lead_scoring",
		title: "How leads are scored",
		description:
			"A brand's lead scoring: its rules (each with a plain label), the days counted, and the hot and warm thresholds. custom: false means the starting rules.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const s = await getScoring(await brandOf(org.id, a.brand));
			return { ...s, labels: s.rules.map(ruleLabel) };
		},
	},
	{
		name: "save_lead_scoring",
		title: "Change how leads are scored",
		description: `Replaces a brand's lead scoring: rules (up to 30), days (7–730, default 90), hot and warm (points; warm below hot). reset: true goes back to the starting rules. ${RULES_HELP} Live segments can then pick { type: lead_score, op: hot|warm|cold|at_least|at_most, value? }.`,
		input: {
			organization,
			brand: oneBrand,
			rules: z.array(z.record(z.string(), z.unknown())).optional(),
			days: z.number().int().optional(),
			hot: z.number().int().optional(),
			warm: z.number().int().optional(),
			reset: z.boolean().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const brand = await brandOf(org.id, a.brand);
			const s = a.reset
				? await resetScoring(brand)
				: await saveScoring(
						brand,
						{ rules: a.rules ?? [], days: a.days, hot: a.hot, warm: a.warm },
						ctx.userId,
					);
			await logged(ctx, org, "lead_scoring.edited", {
				type: "brand",
				id: brand,
				name: "Lead scoring",
			});
			return s;
		},
	},
];
