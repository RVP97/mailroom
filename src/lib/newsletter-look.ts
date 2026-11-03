import type { NewsletterLook } from "@/server/db/schema";

/**
 * How a newsletter's public pages look (its archive, issues on the web, poll results and the
 * referral page): shared by the server, which renders them, and the dashboard, which edits them.
 */

/** Fonts for the web pages (they can load web fonts, unlike most inboxes). */
export const PAGE_FONTS = {
	system: {
		label: "System sans",
		stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
	},
	inter: {
		label: "Inter",
		stack: "Inter,system-ui,sans-serif",
		google: "Inter:wght@400;500;600;700",
	},
	"dm-sans": {
		label: "DM Sans",
		stack: "'DM Sans',system-ui,sans-serif",
		google: "DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700",
	},
	"space-grotesk": {
		label: "Space Grotesk",
		stack: "'Space Grotesk',system-ui,sans-serif",
		google: "Space+Grotesk:wght@400;500;700",
	},
	fraunces: {
		label: "Fraunces",
		stack: "Fraunces,Georgia,serif",
		google: "Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700",
	},
	playfair: {
		label: "Playfair Display",
		stack: "'Playfair Display',Georgia,serif",
		google: "Playfair+Display:wght@400;600;700",
	},
	lora: { label: "Lora", stack: "Lora,Georgia,serif", google: "Lora:wght@400;600;700" },
	georgia: { label: "Georgia", stack: "Georgia,'Times New Roman',serif" },
	mono: {
		label: "Mono",
		stack: "'JetBrains Mono','SF Mono',Menlo,Consolas,monospace",
		google: "JetBrains+Mono:wght@400;600;700",
	},
} as const;
export type PageFont = keyof typeof PAGE_FONTS;

export type Look = {
	logo: string;
	cover: string | null;
	font: PageFont;
	heading_font: PageFont;
	theme: "auto" | "light" | "dark";
	background: string;
	layout: "list" | "cards";
	align: "center" | "left";
	form_position: "top" | "bottom";
	links: { label: string; url: string }[];
};

export const DEFAULT_LOOK: Look = {
	logo: "brand",
	cover: null,
	font: "system",
	heading_font: "system",
	theme: "auto",
	background: "#fafafa",
	layout: "list",
	align: "center",
	form_position: "top",
	links: [],
};

const HEX = /^#[0-9a-f]{6}$/i;
const font = (v: unknown, d: PageFont): PageFont =>
	typeof v === "string" && v in PAGE_FONTS ? (v as PageFont) : d;
const httpUrl = (v: unknown) =>
	typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : null;

/** A stored look, with defaults for whatever it leaves out (or got wrong). */
export function lookOf(raw: NewsletterLook | null | undefined): Look {
	const v = raw ?? {};
	const d = DEFAULT_LOOK;
	const f = font(v.font, d.font);
	return {
		logo:
			v.logo === "none"
				? "none"
				: (httpUrl(v.logo) ?? (v.logo?.startsWith("/") ? v.logo : "brand")),
		cover: httpUrl(v.cover) ?? (v.cover?.startsWith("/") ? v.cover : null),
		font: f,
		heading_font: font(v.heading_font, f),
		theme: v.theme === "light" || v.theme === "dark" ? v.theme : "auto",
		background: v.background && HEX.test(v.background) ? v.background : d.background,
		layout: v.layout === "cards" ? "cards" : "list",
		align: v.align === "left" ? "left" : "center",
		form_position: v.form_position === "bottom" ? "bottom" : "top",
		links: (v.links ?? [])
			.map((l) => ({
				label: String(l?.label ?? "")
					.trim()
					.slice(0, 40),
				url: httpUrl(l?.url),
			}))
			.filter((l): l is { label: string; url: string } => !!l.label && !!l.url)
			.slice(0, 6),
	};
}

/**
 * An email's theme in a newsletter's color and the nearest fonts inboxes show (Inter, Georgia and
 * mono are the same; the other serifs become "book"; the other sans, the system's).
 */
export function emailThemeOf(l: Pick<Look, "font" | "heading_font">, accent: string | null) {
	const f = (x: PageFont): "inter" | "georgia" | "mono" | "book" | "modern" =>
		x === "inter" || x === "georgia" || x === "mono"
			? x
			: x === "fraunces" || x === "playfair" || x === "lora"
				? "book"
				: "modern";
	return {
		...(accent && HEX.test(accent) ? { accent, button_text: inkOn(accent) } : {}),
		font: f(l.font),
		heading_font: f(l.heading_font),
	};
}

/** The Google Fonts stylesheet a look needs, if any. */
export function fontsHref(l: Pick<Look, "font" | "heading_font">) {
	const families = [...new Set([l.font, l.heading_font])]
		.map((k) => (PAGE_FONTS[k] as { google?: string }).google)
		.filter(Boolean);
	return families.length
		? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join("&")}&display=swap`
		: null;
}

/** sRGB luminance, 0 (black) to 1 (white). */
function luminance(hex: string) {
	const n = Number.parseInt(hex.slice(1), 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => {
		const s = x / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
}

/** Text that reads on a color: white on dark ones, near-black on light ones. */
export const inkOn = (hex: string) => (luminance(hex) > 0.45 ? "#18181b" : "#ffffff");

/**
 * The pages' CSS variables: --ink, --soft, --mute, --line, --bg, --card, --accent, --on-accent,
 * --font, --heading-font. Light, dark, or light with dark when the reader's device is dark.
 */
export function lookCss(l: Look, accent: string | null) {
	const a = accent && HEX.test(accent) ? accent : "#18181b";
	const light = `--ink:#18181b;--soft:#52525b;--mute:#a1a1aa;--line:#e4e4e7;--bg:${l.background};--card:#fff;--accent:${a};--on-accent:${inkOn(a)};--link:${luminance(a) > 0.6 ? "#18181b" : a}`;
	// A dark accent (the default black) would vanish on a dark page: buttons go light instead.
	const da = luminance(a) < 0.08 ? "#f4f4f5" : a;
	const dark = `--ink:#f4f4f5;--soft:#a1a1aa;--mute:#71717a;--line:#27272a;--bg:#09090b;--card:#18181b;--accent:${da};--on-accent:${inkOn(da)};--link:${luminance(da) < 0.2 ? "#f4f4f5" : da}`;
	const fonts = `--font:${PAGE_FONTS[l.font].stack};--heading-font:${PAGE_FONTS[l.heading_font].stack}`;
	if (l.theme === "light") return `:root{${light};${fonts};color-scheme:light}`;
	if (l.theme === "dark") return `:root{${dark};${fonts};color-scheme:dark}`;
	return `:root{${light};${fonts};color-scheme:light dark}@media (prefers-color-scheme:dark){:root{${dark}}}`;
}
