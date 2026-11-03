import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { toBase64, unsafeSvg } from "../lib/svg-safety";
import { db, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

export { unsafeSvg };

/**
 * Organization logos: the one the organization uploaded, or else a brand logo (BIMI) one of its
 * domains already has, so most organizations show a logo without doing anything.
 */

/** The largest image accepted (the dashboard sends a 256 px square, a few KB). */
export const ORG_LOGO_MAX_BYTES = 200 * 1024;

const TYPES = {
	"image/png": (b: Uint8Array) =>
		b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
	"image/jpeg": (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	"image/webp": (b: Uint8Array) =>
		String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
		String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
	// An SVG keeps its shapes sharp at any size; checked below, served under a CSP that runs nothing.
	"image/svg+xml": (b: Uint8Array) =>
		/<svg\b/i.test(new TextDecoder().decode(b.subarray(0, 4096))),
} as const;

/** An SVG's text as the data: URL setOrgLogo takes. */
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${toBase64(svg)}`;

export type OrgLogo = {
	/** Where the image is, with a version so a new one shows at once. */
	url: string;
	/** "own": uploaded for the organization; "bimi": a domain's brand logo. */
	source: "own" | "bimi";
	/** For "bimi", the domain whose logo it is. */
	domain?: string;
	/** For "own", the domain logo shown instead if it's removed. */
	fallback?: { url: string; domain: string };
	/** What's behind it ("white", "black", "#rrggbb"); null: nothing, the logo as it is. */
	background: string | null;
};

/** A background the dashboard can pick: white, black or a hex color. */
export function cleanBackground(value: string | null): string | null {
	if (value === null || value === "" || value === "none") return null;
	const v = value.trim().toLowerCase();
	if (v === "white" || v === "black") return v;
	if (/^#[0-9a-f]{6}$/.test(v)) return v;
	if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
	throw validation("Pick white, black or a color like #0d2b29.");
}

/** Sets what shows behind the organization's logo (its own or its domain's). */
export async function setOrgLogoBackground(organizationId: string, value: string | null) {
	const background = cleanBackground(value);
	const t = schema.orgLogos;
	const row = await db
		.select({ data: t.data })
		.from(t)
		.where(eq(t.organization_id, organizationId))
		.get();
	// Nothing left to keep: no upload and no background.
	if (!background && row && !row.data)
		await db.delete(t).where(eq(t.organization_id, organizationId));
	else if (row)
		await db.update(t).set({ background }).where(eq(t.organization_id, organizationId));
	else if (background)
		await db
			.insert(t)
			.values({ organization_id: organizationId, background, updated_at: iso() });
	return background;
}

/** Saves an organization's logo (a data: URL of a PNG, WebP or JPEG), or removes it with null. */
export async function setOrgLogo(organizationId: string, dataUrl: string | null) {
	const t = schema.orgLogos;
	if (dataUrl === null) {
		// The background stays for the domain's logo, if one was chosen.
		await db.delete(t).where(and(eq(t.organization_id, organizationId), isNull(t.background)));
		await db
			.update(t)
			.set({ content_type: null, data: null, updated_at: iso() })
			.where(eq(t.organization_id, organizationId));
		return null;
	}
	const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
		dataUrl,
	);
	if (!m?.[1] || !m[2]) throw validation("Upload the logo as a PNG, JPEG, WebP or SVG image.");
	const type = m[1] as keyof typeof TYPES;
	let bytes: Uint8Array;
	try {
		bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
	} catch {
		throw validation("The image couldn't be read.");
	}
	if (bytes.length > ORG_LOGO_MAX_BYTES)
		throw validation(`The logo is ${Math.ceil(bytes.length / 1024)} KB; the most is 200 KB.`);
	if (!TYPES[type](bytes)) throw validation("That file isn't the image it says it is.");
	if (type === "image/svg+xml") {
		const why = unsafeSvg(new TextDecoder().decode(bytes));
		if (why) throw validation(why);
	}
	const row = { content_type: type, data: m[2], updated_at: iso() };
	await db
		.insert(schema.orgLogos)
		.values({ organization_id: organizationId, ...row })
		.onConflictDoUpdate({ target: schema.orgLogos.organization_id, set: row });
	return logoUrl(organizationId, row.updated_at);
}

const logoUrl = (id: string, at: string) =>
	`/logos/${encodeURIComponent(id)}?v=${encodeURIComponent(at)}`;

/** An organization's uploaded logo, for /logos/<id>. */
export async function orgLogoImage(
	organizationId: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string } | null> {
	const row = await db
		.select({ type: schema.orgLogos.content_type, data: schema.orgLogos.data })
		.from(schema.orgLogos)
		.where(eq(schema.orgLogos.organization_id, organizationId))
		.get();
	if (!row?.data || !row.type) return null;
	return { bytes: Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0)), type: row.type };
}

/**
 * Each organization's logo: its own, or else the BIMI logo of one of its domains (its default
 * brand's before other brands', verified before pending, then by name). Missing: no logo.
 */
export async function orgLogos(organizationIds: string[]): Promise<Map<string, OrgLogo>> {
	const out = new Map<string, OrgLogo>();
	const ids = [...new Set(organizationIds)];
	if (!ids.length) return out;
	const d = schema.domains;
	const b = schema.brands;
	const [own, links, domains] = await Promise.all([
		db
			.select({
				id: schema.orgLogos.organization_id,
				at: schema.orgLogos.updated_at,
				data: sql<number>`${schema.orgLogos.data} is not null`,
				background: schema.orgLogos.background,
			})
			.from(schema.orgLogos)
			.where(inArray(schema.orgLogos.organization_id, ids)),
		db.select({ id: b.id, parent: b.parent_id }).from(b).where(inArray(b.parent_id, ids)),
		db
			.select({
				name: d.name,
				owner: d.organization_id,
				status: d.status,
				at: d.bimi_updated_at,
			})
			.from(d)
			.where(
				and(
					isNotNull(d.bimi_logo),
					or(
						inArray(d.organization_id, ids),
						inArray(
							d.organization_id,
							db.select({ id: b.id }).from(b).where(inArray(b.parent_id, ids)),
						),
					),
				),
			),
	]);
	const backgrounds = new Map(own.map((r) => [r.id, r.background]));
	for (const r of own)
		if (r.data)
			out.set(r.id, { url: logoUrl(r.id, r.at), source: "own", background: r.background });
	const parentOf = new Map(links.map((l) => [l.id, l.parent]));
	const rank = (x: (typeof domains)[number], org: string) =>
		`${x.owner === org ? 0 : 1}${x.status === "verified" ? 0 : 1}${x.name}`;
	const best = new Map<string, (typeof domains)[number]>();
	for (const x of domains) {
		const org = ids.includes(x.owner) ? x.owner : parentOf.get(x.owner);
		if (!org) continue;
		const cur = best.get(org);
		if (!cur || rank(x, org) < rank(cur, org)) best.set(org, x);
	}
	for (const [org, x] of best) {
		const bimi = {
			url: `/bimi/${x.name}.svg?v=${encodeURIComponent(x.at ?? "")}`,
			domain: x.name,
		};
		const mine = out.get(org);
		if (mine) mine.fallback = bimi;
		else out.set(org, { ...bimi, source: "bimi", background: backgrounds.get(org) ?? null });
	}
	return out;
}
