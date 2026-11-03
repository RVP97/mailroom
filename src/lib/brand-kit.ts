import { DEFAULT_THEME, type FontKey, FONTS, type Theme } from "./email-doc";

/**
 * A brand's kit: the colors, fonts and buttons its emails are built with. Starting designs take
 * it, the editor's color pickers offer its colors first, and its own fonts (uploaded WOFF2 files)
 * show where inboxes support web fonts (Apple Mail, iOS, Samsung, Thunderbird); elsewhere the
 * fallback font shows. "Locked" keeps the editor to the kit's colors and fonts.
 */

export type KitFont = {
	/** The family name as written in CSS ("Acme Sans"). */
	family: string;
	/** A WOFF2 or WOFF file Mailroom hosts. */
	url: string;
	/** One of FONTS: what shows where web fonts don't. */
	fallback: FontKey;
	weight: number;
};

export type BrandKit = {
	colors: { name: string; value: string }[];
	background: string;
	surface: string;
	text: string;
	heading: string;
	accent: string;
	button_text: string;
	/** One of FONTS, or the family of one of `fonts`. */
	font: string;
	heading_font: string;
	fonts: KitFont[];
	radius: number;
	locked: boolean;
};

export const DEFAULT_KIT: BrandKit = {
	colors: [],
	background: DEFAULT_THEME.background,
	surface: DEFAULT_THEME.surface,
	text: DEFAULT_THEME.text,
	heading: DEFAULT_THEME.heading,
	accent: DEFAULT_THEME.accent,
	button_text: DEFAULT_THEME.button_text,
	font: DEFAULT_THEME.font,
	heading_font: DEFAULT_THEME.heading_font,
	fonts: [],
	radius: DEFAULT_THEME.radius,
	locked: false,
};

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const isFontKey = (v: unknown): v is FontKey => typeof v === "string" && v in FONTS;
const httpUrl = (v: unknown) =>
	typeof v === "string" && /^https?:\/\/[^\s"'()<>]+$/i.test(v) ? v : null;
const family = (v: unknown) =>
	typeof v === "string" ? v.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) : "";

/** A kit from anywhere (stored JSON, a form), cleaned. */
export function kitOf(raw: unknown): BrandKit {
	const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const fonts: KitFont[] = (Array.isArray(x.fonts) ? x.fonts : [])
		.map((f: Record<string, unknown>) => ({
			family: family(f?.family),
			url: httpUrl(f?.url) ?? "",
			fallback: isFontKey(f?.fallback) ? f.fallback : ("modern" as FontKey),
			weight: [400, 500, 600, 700].includes(Number(f?.weight)) ? Number(f.weight) : 400,
		}))
		.filter((f) => f.family && f.url)
		.slice(0, 6);
	const fontOk = (v: unknown, d: string) =>
		isFontKey(v) || (typeof v === "string" && fonts.some((f) => f.family === v))
			? (v as string)
			: d;
	return {
		colors: (Array.isArray(x.colors) ? x.colors : [])
			.map((c: Record<string, unknown>) => ({
				name: typeof c?.name === "string" ? c.name.slice(0, 30) : "",
				value: hex(c?.value, ""),
			}))
			.filter((c) => c.value)
			.slice(0, 10),
		background: hex(x.background, DEFAULT_KIT.background),
		surface: hex(x.surface, DEFAULT_KIT.surface),
		text: hex(x.text, DEFAULT_KIT.text),
		heading: hex(x.heading, DEFAULT_KIT.heading),
		accent: hex(x.accent, DEFAULT_KIT.accent),
		button_text: hex(x.button_text, DEFAULT_KIT.button_text),
		font: fontOk(x.font, DEFAULT_KIT.font),
		heading_font: fontOk(x.heading_font, DEFAULT_KIT.heading_font),
		fonts,
		radius: Math.min(32, Math.max(0, Math.round(Number(x.radius ?? DEFAULT_KIT.radius)) || 0)),
		locked: x.locked === true,
	};
}

/** A kit's font as an email theme sets it: a built-in key, or a web font over its fallback. */
function themeFont(kit: BrandKit, v: string): { key: FontKey; face: KitFont | null } {
	if (isFontKey(v)) return { key: v, face: null };
	const face = kit.fonts.find((f) => f.family === v) ?? null;
	return { key: face?.fallback ?? "modern", face };
}

/** The email theme a kit makes (starting designs; "Apply the brand kit"). */
export function kitTheme(kit: BrandKit): Partial<Theme> {
	const body = themeFont(kit, kit.font);
	const heading = themeFont(kit, kit.heading_font);
	return {
		background: kit.background,
		surface: kit.surface,
		text: kit.text,
		heading: kit.heading,
		accent: kit.accent,
		button_text: kit.button_text,
		radius: kit.radius,
		font: body.key,
		heading_font: heading.key,
		font_face: body.face ? { family: body.face.family, url: body.face.url } : null,
		heading_face: heading.face ? { family: heading.face.family, url: heading.face.url } : null,
	};
}

/** Every color of a kit, its named ones first (for color pickers). */
export function kitSwatches(kit: BrandKit) {
	const out = [
		...kit.colors,
		{ name: "Accent", value: kit.accent },
		{ name: "Heading", value: kit.heading },
		{ name: "Text", value: kit.text },
		{ name: "Background", value: kit.background },
		{ name: "Box", value: kit.surface },
	];
	return out.filter((c, i) => out.findIndex((d) => d.value === c.value) === i);
}
