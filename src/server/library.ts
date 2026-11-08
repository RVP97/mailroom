import { and, desc, eq } from "drizzle-orm";
import { type BrandKit, kitOf } from "../lib/brand-kit";
import { type Block, parseDoc } from "../lib/email-doc";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import { iso } from "./time";

/*
 * What everyone in an organization builds emails with: saved sections (blocks saved from one
 * email to drop into another) and each brand's kit (colors, fonts, buttons).
 */

const s = schema.savedSections;

/** Blocks from anywhere, cleaned as a design's are. */
function cleanBlocks(raw: unknown): Block[] {
	const doc = parseDoc({ theme: {}, blocks: raw });
	return doc?.blocks ?? [];
}

export async function listSections(organizationId: string) {
	const rows = await db
		.select({
			id: s.id,
			name: s.name,
			blocks: s.blocks,
			updated_at: s.updated_at,
			created_by: s.created_by,
			who: schema.user.name,
			email: schema.user.email,
		})
		.from(s)
		.leftJoin(schema.user, eq(schema.user.id, s.created_by))
		.where(eq(s.organization_id, organizationId))
		.orderBy(desc(s.updated_at))
		.limit(200);
	return rows.map(({ who, email, ...r }) => ({ ...r, who: who || email || null }));
}

export async function saveSection(o: {
	organizationId: string;
	userId: string;
	id?: string;
	name: string;
	blocks: unknown;
	now?: number;
}) {
	const name = o.name.trim().slice(0, 80);
	if (!name) throw new ApiError(422, "validation_error", "Name the section");
	const blocks = cleanBlocks(o.blocks);
	if (!blocks.length) throw new ApiError(422, "validation_error", "Pick at least one block");
	if (blocks.length > 30)
		throw new ApiError(422, "validation_error", "A section holds up to 30 blocks");
	const now = iso(o.now);
	if (o.id) {
		const [row] = await db
			.update(s)
			.set({ name, blocks, updated_by: o.userId, updated_at: now })
			.where(and(eq(s.id, o.id), eq(s.organization_id, o.organizationId)))
			.returning();
		if (!row) throw new ApiError(404, "not_found", "That section is gone");
		return row;
	}
	const row = {
		id: crypto.randomUUID(),
		organization_id: o.organizationId,
		name,
		blocks,
		created_by: o.userId,
		updated_by: o.userId,
		created_at: now,
		updated_at: now,
	};
	await db.insert(s).values(row);
	return row;
}

export async function renameSection(organizationId: string, id: string, name: string) {
	const n = name.trim().slice(0, 80);
	if (!n) throw new ApiError(422, "validation_error", "Name the section");
	await db
		.update(s)
		.set({ name: n })
		.where(and(eq(s.id, id), eq(s.organization_id, organizationId)));
}

export async function deleteSection(organizationId: string, id: string) {
	const row = await db
		.select({ name: s.name })
		.from(s)
		.where(and(eq(s.id, id), eq(s.organization_id, organizationId)))
		.get();
	await db.delete(s).where(and(eq(s.id, id), eq(s.organization_id, organizationId)));
	return row?.name ?? null;
}

// ── Brand kits ──────────────────────────────────────────────────────────────────────────

/** A brand's kit, or null when it has none yet. */
export async function getKit(brand: string): Promise<BrandKit | null> {
	const row = await db
		.select({ kit: schema.brandKits.kit })
		.from(schema.brandKits)
		.where(eq(schema.brandKits.organization_id, brand))
		.get();
	return row ? kitOf(row.kit) : null;
}

export async function saveKit(
	brand: string,
	raw: unknown,
	userId: string | null,
	now = Date.now(),
) {
	const kit = kitOf(raw);
	await db
		.insert(schema.brandKits)
		.values({ organization_id: brand, kit, updated_by: userId, updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.brandKits.organization_id,
			set: { kit, updated_by: userId, updated_at: iso(now) },
		});
	// "Everywhere": every page of the brand changes with it.
	const applied = kit.everywhere ? await applyKitEverywhere(brand, kit, now) : null;
	return Object.assign(kit, applied ? { applied } : {});
}

/**
 * The kit's color (and its fonts, where a page can use them) on everything else the brand
 * shows people: sign-up forms, website chat widgets, newsletter pages, the help center, and the
 * unsubscribe page (which then follows the kit by itself). Returns how many of each changed.
 */
export async function applyKitEverywhere(brand: string, kit: BrandKit, now = Date.now()) {
	const at = iso(now);
	const { FONTS } = await import("../lib/email-doc");
	const builtIn = (f: string) => (f in FONTS ? f : null);
	const [forms, widgets, newsletters, pages] = await Promise.all([
		db
			.select({ id: schema.signupForms.id, design: schema.signupForms.design })
			.from(schema.signupForms)
			.where(eq(schema.signupForms.organization_id, brand)),
		db
			.select({ id: schema.chatWidgets.inbox_id, design: schema.chatWidgets.design })
			.from(schema.chatWidgets)
			.where(eq(schema.chatWidgets.organization_id, brand)),
		db
			.select({ id: schema.newsletters.id, look: schema.newsletters.look })
			.from(schema.newsletters)
			.where(eq(schema.newsletters.organization_id, brand)),
		db
			.select({ look: schema.subscriberPages.look })
			.from(schema.subscriberPages)
			.where(eq(schema.subscriberPages.organization_id, brand))
			.get(),
	]);
	const font = builtIn(kit.font);
	const heading = builtIn(kit.heading_font);
	await Promise.all([
		...forms.map((f) =>
			db
				.update(schema.signupForms)
				.set({
					design: {
						...((f.design as Record<string, unknown>) ?? {}),
						accent: kit.accent,
					},
					updated_at: at,
				})
				.where(eq(schema.signupForms.id, f.id)),
		),
		...widgets.map((w) =>
			db
				.update(schema.chatWidgets)
				.set({ design: { ...(w.design ?? {}), color: kit.accent }, updated_at: at })
				.where(eq(schema.chatWidgets.inbox_id, w.id)),
		),
		...newsletters.map((n) =>
			db
				.update(schema.newsletters)
				.set({
					accent: kit.accent,
					look: {
						...(n.look ?? {}),
						...(font ? { font } : {}),
						...(heading ? { heading_font: heading } : {}),
					},
					updated_at: at,
				})
				.where(eq(schema.newsletters.id, n.id)),
		),
		db
			.update(schema.helpCenters)
			.set({ accent: kit.accent, updated_at: at })
			.where(eq(schema.helpCenters.organization_id, brand)),
		pages
			? db
					.update(schema.subscriberPages)
					.set({ look: { ...pages.look, accent: null }, updated_at: at })
					.where(eq(schema.subscriberPages.organization_id, brand))
			: Promise.resolve(),
	]);
	const help = await db
		.select({ id: schema.helpCenters.organization_id })
		.from(schema.helpCenters)
		.where(eq(schema.helpCenters.organization_id, brand))
		.get();
	return {
		signup_forms: forms.length,
		chat_widgets: widgets.length,
		newsletters: newsletters.length,
		help_center: !!help,
		unsubscribe_page: true,
	};
}

export async function removeKit(brand: string) {
	await db.delete(schema.brandKits).where(eq(schema.brandKits.organization_id, brand));
}
