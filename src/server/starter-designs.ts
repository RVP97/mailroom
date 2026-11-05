import { eq } from "drizzle-orm";
import { kitTheme } from "../lib/brand-kit";
import type { EmailDoc } from "../lib/email-doc";
import { CATEGORIES, type LogoChoice, STARTERS, starterDoc } from "../lib/email-templates";
import { db, schema } from "./db";
import { validation } from "./errors";
import { getKit } from "./library";
import { publicUrl } from "./public-host";
import { brandLooks, logoBackgrounds } from "./signup-forms";

/** The ready-made designs, as the MCP lists them. */
export const starterList = () =>
	STARTERS.map((s) => ({
		id: s.id,
		name: s.name,
		category: CATEGORIES.find((c) => c.id === s.category)?.label ?? s.category,
		about: s.hint,
	}));

/**
 * A ready-made design made for a brand: its logo (as `logo` says, or none), its name, Mailroom's
 * sample pictures, and its brand kit's colors and fonts unless `brandColors` is false.
 */
export async function starterFor(
	brand: string,
	id: string,
	o: { logo?: LogoChoice; brandColors?: boolean } = {},
): Promise<EmailDoc> {
	const [logos, backgrounds, kit, org] = await Promise.all([
		brandLooks([brand]),
		logoBackgrounds([brand]),
		getKit(brand),
		db
			.select({ name: schema.organization.name })
			.from(schema.organization)
			.where(eq(schema.organization.id, brand))
			.get(),
	]);
	const logo = logos[brand] ?? null;
	const doc = starterDoc(
		id,
		{
			name: org?.name ?? "",
			// Most inboxes don't show SVG.
			logo: logo && !/\.svg(\?|$)/i.test(logo) ? logo : null,
			logoBackground: backgrounds[brand] ?? null,
		},
		{
			logo: o.logo,
			origin: publicUrl(),
			kit: kit && o.brandColors !== false ? kitTheme(kit) : null,
		},
	);
	if (!doc) throw validation(`There's no design "${id}". list_starter_designs has their ids.`);
	return doc;
}
