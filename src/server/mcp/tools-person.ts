import { z } from "zod";
import { maskDigits } from "../../lib/roles";
import { personAcrossBrands } from "../person-across";
import { orgAt, organization, type Tool } from "./kit";

/** One person across the organization's brands (the contact page's «Across your brands»). */
export const PERSON_TOOLS: Tool[] = [
	{
		name: "get_person",
		title: "One person across brands",
		description:
			"One address across all the organization's brands, joined for viewing (each brand keeps its own contact and consent): per brand, its contact (or none), emails sent, opened and clicked, conversations (open ones too), lead score, open follow-ups, whether the brand blocks them, and what they spent.",
		input: { organization, address: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const p = await personAcrossBrands(org.id, a.address as string);
			return org.masked ? { ...p, email: maskDigits(p.email) } : p;
		},
	},
];
