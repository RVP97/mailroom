import {
	type Corners,
	cornersOf,
	inkOn,
	type LogoShape,
	type LogoSize,
	logoShapeOf,
	logoSizeOf,
	PAGE_FONTS,
	type PageFont,
	shapeVars,
} from "./newsletter-look";

/**
 * A brand's unsubscribe and preferences page (/unsubscribe): what people see after the unsubscribe
 * link of one of its emails. Its logo, colors, font, shape and every line it says can be the
 * brand's own; whatever is left out takes the defaults (the brand's logo and kit accent). Shared by
 * the server, which renders it, and the dashboard, which edits it beside a live preview.
 */

/** The lines it says. {name} is the brand (or the email's sender), {email} the address. */
export const PAGE_TEXTS = {
	ask: {
		label: "Heading",
		en: "Stop getting these emails from {name}?",
		es: "¿Dejar de recibir estos correos de {name}?",
	},
	who: {
		label: "Explanation",
		en: "{email} won't get this sender's emails of this kind any more.",
		es: "A {email} ya no le llegarán estos correos de este remitente.",
	},
	out: { label: "Unsubscribe button", en: "Unsubscribe", es: "Darme de baja" },
	done: {
		label: "After unsubscribing",
		en: "Done: you won't get these emails from {name} any more.",
		es: "Listo: ya no recibirá estos correos de {name}.",
	},
	sorry: {
		label: "Goodbye note",
		en: "",
		es: "",
	},
	back: { label: "Subscribe again button", en: "Subscribe again", es: "Volver a recibirlos" },
	backDone: {
		label: "After subscribing again",
		en: "Done: you'll get these emails from {name} again.",
		es: "Listo: volverá a recibir estos correos de {name}.",
	},
	prefs: {
		label: "Preferences heading",
		en: "Or choose what you get",
		es: "O elija qué recibir",
	},
	save: { label: "Save button", en: "Save preferences", es: "Guardar preferencias" },
	saved: { label: "After saving", en: "Preferences saved.", es: "Preferencias guardadas." },
} as const;
export type TextKey = keyof typeof PAGE_TEXTS;

export type SubscriberPage = {
	/** "brand" (the brand's logo), "none", or an image's address. */
	logo: string;
	logo_shape: LogoShape;
	logo_size: LogoSize;
	/** Where the logo, title and buttons sit. */
	align: "center" | "left";
	theme: "auto" | "light" | "dark";
	/** The page behind, the card, its text, and buttons (null: the brand kit's accent). */
	background: string;
	card: string;
	text: string;
	accent: string | null;
	font: PageFont;
	heading_font: PageFont;
	corners: Corners;
	borders: boolean;
	/** "card": a box in the middle of the page; "plain": straight on the page. */
	layout: "card" | "plain";
	/** "auto" follows the reader's browser (English or Spanish). */
	language: "auto" | "en" | "es";
	/** The brand's own lines in place of the defaults (empty: the default). */
	texts: Partial<Record<TextKey, string>>;
	/** Offered after they unsubscribe; off hides the button. */
	resubscribe: boolean;
	/** A link under the card: "Back to Harbor Inn" → https://harborinn.com. */
	link: { label: string; url: string } | null;
	/** A line at the very bottom (an address, a legal line). */
	footer: string;
};

export const DEFAULT_PAGE: SubscriberPage = {
	logo: "brand",
	logo_shape: "original",
	logo_size: "medium",
	align: "center",
	theme: "auto",
	background: "#f6f7f9",
	card: "#ffffff",
	text: "#14161a",
	accent: null,
	font: "system",
	heading_font: "system",
	corners: "soft",
	borders: true,
	layout: "card",
	language: "auto",
	texts: {},
	resubscribe: true,
	link: null,
	footer: "",
};

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const httpUrl = (v: unknown) =>
	typeof v === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : null;
const font = (v: unknown, d: PageFont): PageFont =>
	typeof v === "string" && v in PAGE_FONTS ? (v as PageFont) : d;
const line = (v: unknown, max: number) =>
	typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** A page from anywhere (stored JSON, a form, the MCP), cleaned, with defaults for the rest. */
export function pageOf(raw: unknown): SubscriberPage {
	const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_PAGE;
	const texts: Partial<Record<TextKey, string>> = {};
	const t = (x.texts && typeof x.texts === "object" ? x.texts : {}) as Record<string, unknown>;
	for (const k of Object.keys(PAGE_TEXTS) as TextKey[]) {
		const v = line(t[k], k === "who" || k === "sorry" ? 400 : 160);
		if (v) texts[k] = v;
	}
	const l = (x.link && typeof x.link === "object" ? x.link : null) as Record<
		string,
		unknown
	> | null;
	const linkUrl = httpUrl(l?.url);
	const linkLabel = line(l?.label, 60);
	const f = font(x.font, d.font);
	return {
		logo:
			x.logo === "none"
				? "none"
				: (httpUrl(x.logo) ??
					(typeof x.logo === "string" && /^\/media\/\S+$/.test(x.logo)
						? x.logo
						: "brand")),
		logo_shape: logoShapeOf(x.logo_shape),
		logo_size: logoSizeOf(x.logo_size),
		align: x.align === "left" ? "left" : "center",
		theme: x.theme === "light" || x.theme === "dark" ? x.theme : "auto",
		background: hex(x.background, d.background),
		card: hex(x.card, d.card),
		text: hex(x.text, d.text),
		accent: typeof x.accent === "string" && HEX.test(x.accent) ? x.accent.toLowerCase() : null,
		font: f,
		heading_font: font(x.heading_font, f),
		corners: cornersOf(x.corners, d.corners),
		borders: x.borders !== false,
		layout: x.layout === "plain" ? "plain" : "card",
		language: x.language === "en" || x.language === "es" ? x.language : "auto",
		texts,
		resubscribe: x.resubscribe !== false,
		link: linkUrl && linkLabel ? { label: linkLabel, url: linkUrl } : null,
		footer: line(x.footer, 300),
	};
}

const esc = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
	);

/** One of its lines, the brand's own or the default, filled and escaped for HTML. */
export function pageText(
	p: SubscriberPage,
	lang: "en" | "es",
	key: TextKey,
	values: { name: string; email: string },
) {
	const raw = p.texts[key] || PAGE_TEXTS[key][lang];
	return esc(raw)
		.replace(/\{\s*name\s*\}/g, esc(values.name))
		.replace(/\{\s*email\s*\}/g, esc(values.email));
}

/** The language the page speaks: the one picked, or the reader's (Spanish or English). */
export function pageLang(p: SubscriberPage, acceptLanguage: string | null): "en" | "es" {
	if (p.language !== "auto") return p.language;
	return /^es\b/i.test(acceptLanguage ?? "") ? "es" : "en";
}

/** sRGB luminance, 0 (black) to 1 (white). */
function lum(h: string) {
	const n = Number.parseInt(h.slice(1), 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
}
const mix = (a: string, b: string, t: number) =>
	`color-mix(in srgb,${a} ${Math.round(t * 100)}%,${b})`;

/** The page's CSS variables, light, dark, or following the device. */
function vars(p: SubscriberPage, accent: string) {
	const light = `--bg:${p.background};--card:${p.card};--ink:${p.text};--mut:${mix(p.text, p.card, 0.62)};--line:${mix(p.text, p.card, 0.12)};--btn:${accent};--btnInk:${inkOn(accent)}`;
	const da = lum(accent) < 0.08 ? "#eceef1" : accent;
	const dark = `--bg:#0d0f12;--card:#16191e;--ink:#eceef1;--mut:#9aa1ac;--line:#262a31;--btn:${da};--btnInk:${inkOn(da)}`;
	const rest = `--font:${PAGE_FONTS[p.font].stack};--heading-font:${PAGE_FONTS[p.heading_font].stack};${shapeVars(p, 40)}`;
	if (p.theme === "light") return `:root{${light};${rest};color-scheme:light}`;
	if (p.theme === "dark") return `:root{${dark};${rest};color-scheme:dark}`;
	return `:root{${light};${rest};color-scheme:light dark}@media (prefers-color-scheme:dark){:root{${dark}}}`;
}

/** The Google Fonts stylesheet it needs, if any. */
export function pageFontsHref(p: Pick<SubscriberPage, "font" | "heading_font">) {
	const families = [...new Set([p.font, p.heading_font])]
		.map((k) => (PAGE_FONTS[k] as { google?: string }).google)
		.filter(Boolean);
	return families.length
		? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${f}`).join("&")}&display=swap`
		: null;
}

/**
 * The whole page around `body` (its heading, lines and forms). `logo` is the image to show (the
 * brand's or the page's own, already absolute), `accent` the brand kit's when the page has none.
 */
export function renderSubscriberPage(
	p: SubscriberPage,
	o: {
		lang: "en" | "es";
		title: string;
		body: string;
		logo: string | null;
		accent: string | null;
		brand: string;
	},
) {
	const accent = p.accent ?? (o.accent && HEX.test(o.accent) ? o.accent : "#14161a");
	const left = p.align === "left";
	const card = p.layout === "card";
	const fonts = pageFontsHref(p);
	const css = `${vars(p, accent)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased}
.wrap{max-width:32rem;margin:10vh auto 2rem;padding:0 16px;text-align:${left ? "left" : "center"}}
main{${card ? "padding:32px 32px 28px;background:var(--card);border:var(--bw) solid var(--line);box-shadow:var(--shadow);border-radius:var(--r-card)" : "padding:8px 0"}}
@media (max-width:520px){.wrap{margin-top:24px}main{${card ? "padding:24px 20px" : "padding:4px 0"}}}
.logo{display:block;height:var(--logo-h);width:var(--logo-w);max-width:200px;object-fit:var(--logo-fit);border-radius:var(--logo-r);margin:${left ? "0 0 20px" : "0 auto 20px"}}
h1{margin:0 0 8px;font:600 21px/1.3 var(--heading-font);text-wrap:balance}
p{margin:0 0 18px;color:var(--mut)}
.sorry{color:var(--ink)}
.acts{display:flex;flex-wrap:wrap;gap:8px;justify-content:${left ? "flex-start" : "center"}}
button{font:600 15px/1 var(--font);padding:12px 20px;border-radius:var(--r-btn);border:1px solid var(--btn);background:var(--btn);color:var(--btnInk);cursor:pointer}
button:hover{filter:brightness(1.07)}
button.quiet{background:transparent;color:var(--ink);border-color:var(--line);font-weight:500}
form{margin:0}
section{margin-top:26px;padding-top:22px;border-top:1px solid var(--line);text-align:left}
h2{margin:0 0 12px;font:600 15px/1.4 var(--heading-font)}
label.topic{display:flex;gap:10px;align-items:flex-start;margin:0 0 12px;cursor:pointer}
label.topic input{margin-top:5px;width:16px;height:16px;flex:none;accent-color:var(--btn)}
label.topic small{display:block;color:var(--mut);font-size:13px}
.ok{color:var(--ink);font-weight:500}
.after{margin-top:18px;font-size:14px}
.after a{color:var(--ink);font-weight:500;text-decoration:none;border-bottom:1px solid var(--line)}
.after a:hover{border-color:var(--ink)}
.foot{margin-top:28px;font-size:12px;color:var(--mut);white-space:pre-line}`;
	const logo = o.logo ? `<img class="logo" src="${esc(o.logo)}" alt="${esc(o.brand)}">` : "";
	const link = p.link
		? `<div class="after"><a href="${esc(p.link.url)}">${esc(p.link.label)}</a></div>`
		: "";
	const foot = p.footer ? `<div class="foot">${esc(p.footer)}</div>` : "";
	return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.title)}</title>${fonts ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : ""}<style>${css}</style></head><body><div class="wrap"><main>${logo}${o.body}</main>${link}${foot}</div></body></html>`;
}
