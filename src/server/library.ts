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
	if (blocks.length > 30) throw new ApiError(422, "validation_error", "A section holds up to 30 blocks");
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

export async function saveKit(brand: string, raw: unknown, userId: string | null, now = Date.now()) {
	const kit = kitOf(raw);
	await db
		.insert(schema.brandKits)
		.values({ organization_id: brand, kit, updated_by: userId, updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.brandKits.organization_id,
			set: { kit, updated_by: userId, updated_at: iso(now) },
		});
	return kit;
}

export async function removeKit(brand: string) {
	await db.delete(schema.brandKits).where(eq(schema.brandKits.organization_id, brand));
}
