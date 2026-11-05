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
 * link of one of its emails. Its layout, logo, colors, fonts, shape and every line it says can be
 * the brand's own; whatever is left out takes the defaults (the brand's logo and kit accent). Pure:
 * the server renders it for readers, and the dashboard draws the same HTML for its live preview.
 */

/** The lines it says. {name} is the brand (or the email's sender), {email} the address. */
export const PAGE_TEXTS = {
	eyebrow: { label: "Small title", en: "Email preferences", es: "Preferencias de correo" },
	ask: {
		label: "Heading",
		en: "Unsubscribe from {name}?",
		es: "¿Darse de baja de {name}?",
	},
	who: {
		label: "Explanation",
		en: "You'll stop getting these emails at {email}. You can come back anytime.",
		es: "Dejará de recibir estos correos en {email}. Puede volver cuando quiera.",
	},
	out: { label: "Unsubscribe button", en: "Unsubscribe", es: "Darme de baja" },
	done: {
		label: "Heading after unsubscribing",
		en: "You're unsubscribed",
		es: "Listo, se dio de baja",
	},
	sorry: {
		label: "Goodbye note",
		en: "You won't get these emails from {name} anymore. Sorry to see you go.",
		es: "Ya no recibirá estos correos de {name}. Lamentamos verle partir.",
	},
	back: { label: "Subscribe again button", en: "Subscribe again", es: "Volver a suscribirme" },
	backDone: {
		label: "Heading after subscribing again",
		en: "Welcome back!",
		es: "¡Qué gusto tenerle de vuelta!",
	},
	backBody: {
		label: "Line after subscribing again",
		en: "You'll get these emails from {name} again.",
		es: "Volverá a recibir estos correos de {name}.",
	},
	prefs: {
		label: "Preferences heading",
		en: "Or choose what you'd like to get",
		es: "O elija qué quiere recibir",
	},
	save: { label: "Save button", en: "Save preferences", es: "Guardar preferencias" },
	saved: {
		label: "After saving",
		en: "Your preferences are saved.",
		es: "Sus preferencias se guardaron.",
	},
} as const;
export type TextKey = keyof typeof PAGE_TEXTS;

export type PageLayout = "card" | "plain" | "banner" | "split";

export type SubscriberPage = {
	/** Which ready-made template it started from (only to show it picked). */
	template: string | null;
	/**
	 * "card": a box in the middle; "plain": straight on the page; "banner": a band in the brand's
	 * color with the card over it; "split": the brand's color down one side, the page on the other.
	 */
	layout: PageLayout;
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
	heading_size: "md" | "lg";
	/** Above the heading: nothing, a small title ("Email preferences"), or a line icon. */
	mark: "none" | "eyebrow" | "icon";
	corners: Corners;
	borders: boolean;
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
	template: null,
	layout: "card",
	logo: "brand",
	logo_shape: "original",
	logo_size: "medium",
	align: "center",
	theme: "auto",
	background: "#f6f6f4",
	card: "#ffffff",
	text: "#18181b",
	accent: null,
	font: "inter",
	heading_font: "inter",
	heading_size: "md",
	mark: "eyebrow",
	corners: "round",
	borders: true,
	language: "auto",
	texts: {},
	resubscribe: true,
	link: null,
	footer: "",
};

/** The look a template sets: everything but the brand's own logo, accent, words and links. */
type Look = Pick<
	SubscriberPage,
	| "layout"
	| "logo_shape"
	| "logo_size"
	| "align"
	| "theme"
	| "background"
	| "card"
	| "text"
	| "font"
	| "heading_font"
	| "heading_size"
	| "mark"
	| "corners"
	| "borders"
>;

/** Ready-made pages to start from. Each keeps the brand's logo, color, words and links. */
export const PAGE_TEMPLATES: { id: string; name: string; hint: string; look: Look }[] = [
	{
		id: "classic",
		name: "Classic",
		hint: "A calm card in the middle",
		look: {
			layout: "card",
			logo_shape: "original",
			logo_size: "medium",
			align: "center",
			theme: "auto",
			background: "#f6f6f4",
			card: "#ffffff",
			text: "#18181b",
			font: "inter",
			heading_font: "inter",
			heading_size: "md",
			mark: "eyebrow",
			corners: "round",
			borders: true,
		},
	},
	{
		id: "editorial",
		name: "Editorial",
		hint: "Big serif type, like a magazine",
		look: {
			layout: "plain",
			logo_shape: "original",
			logo_size: "small",
			align: "left",
			theme: "light",
			background: "#faf7f2",
			card: "#faf7f2",
			text: "#1c1917",
			font: "inter",
			heading_font: "fraunces",
			heading_size: "lg",
			mark: "eyebrow",
			corners: "square",
			borders: true,
		},
	},
	{
		id: "banner",
		name: "Banner",
		hint: "A band in your color, the card over it",
		look: {
			layout: "banner",
			logo_shape: "rounded",
			logo_size: "large",
			align: "center",
			theme: "light",
			background: "#f4f4f5",
			card: "#ffffff",
			text: "#18181b",
			font: "dm-sans",
			heading_font: "dm-sans",
			heading_size: "md",
			mark: "none",
			corners: "soft",
			borders: false,
		},
	},
	{
		id: "split",
		name: "Split",
		hint: "Your color down one side",
		look: {
			layout: "split",
			logo_shape: "rounded",
			logo_size: "large",
			align: "left",
			theme: "light",
			background: "#ffffff",
			card: "#ffffff",
			text: "#111827",
			font: "inter",
			heading_font: "space-grotesk",
			heading_size: "lg",
			mark: "eyebrow",
			corners: "soft",
			borders: true,
		},
	},
	{
		id: "boutique",
		name: "Boutique",
		hint: "Warm cream and an elegant serif",
		look: {
			layout: "card",
			logo_shape: "circle",
			logo_size: "large",
			align: "center",
			theme: "light",
			background: "#f3ede4",
			card: "#fffdf9",
			text: "#2b2118",
			font: "lora",
			heading_font: "playfair",
			heading_size: "lg",
			mark: "none",
			corners: "square",
			borders: true,
		},
	},
	{
		id: "minimal",
		name: "Minimal",
		hint: "Just the words, nothing else",
		look: {
			layout: "plain",
			logo_shape: "original",
			logo_size: "small",
			align: "center",
			theme: "auto",
			background: "#ffffff",
			card: "#ffffff",
			text: "#0a0a0a",
			font: "system",
			heading_font: "system",
			heading_size: "md",
			mark: "none",
			corners: "soft",
			borders: true,
		},
	},
	{
		id: "midnight",
		name: "Midnight",
		hint: "Dark, with a glow in your color",
		look: {
			layout: "card",
			logo_shape: "rounded",
			logo_size: "medium",
			align: "center",
			theme: "dark",
			background: "#0b0b0f",
			card: "#15151b",
			text: "#f4f4f5",
			font: "inter",
			heading_font: "inter",
			heading_size: "md",
			mark: "icon",
			corners: "round",
			borders: true,
		},
	},
];

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: unknown, d: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : d);
const httpUrl = (v: unknown) =>
	typeof v === "string" && /^https?:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim() : null;
const font = (v: unknown, d: PageFont): PageFont =>
	typeof v === "string" && v in PAGE_FONTS ? (v as PageFont) : d;
const line = (v: unknown, max: number) =>
	typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const LAYOUTS: PageLayout[] = ["card", "plain", "banner", "split"];

/** A page from anywhere (stored JSON, a form, the MCP), cleaned, with defaults for the rest. */
export function pageOf(raw: unknown): SubscriberPage {
	const x = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_PAGE;
	const texts: Partial<Record<TextKey, string>> = {};
	const t = (x.texts && typeof x.texts === "object" ? x.texts : {}) as Record<string, unknown>;
	for (const k of Object.keys(PAGE_TEXTS) as TextKey[]) {
		const v = line(t[k], k === "who" || k === "sorry" || k === "backBody" ? 400 : 160);
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
		template:
			typeof x.template === "string" && PAGE_TEMPLATES.some((p) => p.id === x.template)
				? x.template
				: null,
		layout: LAYOUTS.includes(x.layout as PageLayout) ? (x.layout as PageLayout) : d.layout,
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
		heading_size: x.heading_size === "lg" ? "lg" : "md",
		mark: x.mark === "none" || x.mark === "icon" ? x.mark : "eyebrow",
		corners: cornersOf(x.corners, d.corners),
		borders: x.borders !== false,
		language: x.language === "en" || x.language === "es" ? x.language : "auto",
		texts,
		resubscribe: x.resubscribe !== false,
		link: linkUrl && linkLabel ? { label: linkLabel, url: linkUrl } : null,
		footer: line(x.footer, 300),
	};
}

/** A page with a template's look put on it (its logo choice, color, words and links stay). */
export function withTemplate(p: SubscriberPage, id: string): SubscriberPage {
	const t = PAGE_TEMPLATES.find((x) => x.id === id);
	return t ? { ...p, ...t.look, template: t.id } : p;
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
		.replace(/\{\s*email\s*\}/g, values.email ? `<strong>${esc(values.email)}</strong>` : "");
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
/** A color with some hue (not black, white or gray). */
const colorful = (h: string) => {
	const n = Number.parseInt(h.slice(1), 16);
	const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	return Math.max(...c) - Math.min(...c) > 40;
};

/** The page's CSS variables, light, dark, or following the device. */
function vars(p: SubscriberPage, accent: string) {
	const tone = (bg: string, card: string, ink: string, btn: string) =>
		`--bg:${bg};--card:${card};--ink:${ink};--mut:${mix(ink, card, 0.6)};--line:${mix(ink, card, 0.11)};--btn:${btn};--btnInk:${inkOn(btn)};--band:${accent};--bandInk:${inkOn(accent)}`;
	const light = tone(p.background, p.card, p.text, accent);
	const da = lum(accent) < 0.08 ? "#f4f4f5" : accent;
	// A dark page of its own (Midnight) keeps its colors; the others get a dark of their own.
	const ownDark = lum(p.background) < 0.05;
	const dark = ownDark
		? tone(p.background, p.card, p.text, da)
		: tone("#0c0c0f", "#16161b", "#f1f1f3", da);
	const rest = `--font:${PAGE_FONTS[p.font].stack};--heading-font:${PAGE_FONTS[p.heading_font].stack};${shapeVars(p, 52)}`;
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

const svg = (d: string) =>
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/** The line icon above the heading (mark "icon"), for each state. */
export const PAGE_ICONS = {
	ask: svg(
		'<path d="M3.5 7.5 12 13l8.5-5.5"/><rect x="3" y="5" width="18" height="14" rx="2.5"/>',
	),
	done: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
	back: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
	invalid: svg('<path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="9"/>'),
};

export type PageState = "ask" | "done" | "back" | "invalid";

/** What the page takes from the brand: its name, its logo (absolute) and its kit's accent. */
export type BrandDress = { name: string; logo: string | null; accent: string | null };

/**
 * A whole page in a state: its heading, its line, its button, and (`prefs`) the preferences form
 * already drawn. `form` draws a button's form (the live page posts to its own link). `origin`
 * makes a logo of its own (/media/…) absolute.
 */
export function subscriberPageHtml(
	p: SubscriberPage,
	o: {
		lang: "en" | "es";
		state: PageState;
		name: string;
		email: string;
		dress: BrandDress;
		origin?: string;
		form: (action: "unsubscribe" | "resubscribe", label: string, quiet: boolean) => string;
		prefs?: string;
	},
) {
	const v = { name: o.name, email: o.email };
	const t = (k: TextKey) => pageText(p, o.lang, k, v);
	const title = o.lang === "es" ? "Darse de baja" : "Unsubscribe";
	let body: string;
	if (o.state === "invalid")
		body = `<h1>${o.lang === "es" ? "Este enlace ya no sirve" : "This link doesn't work"}</h1><p>${
			o.lang === "es"
				? "Use el enlace para darse de baja de un correo reciente."
				: "Use the unsubscribe link in a recent email instead."
		}</p>`;
	else if (o.state === "ask")
		body = `<h1>${t("ask")}</h1><p>${t("who")}</p><div class="acts">${o.form("unsubscribe", t("out"), false)}</div>`;
	else if (o.state === "done") {
		const sorry = t("sorry");
		body = `<h1>${t("done")}</h1>${sorry ? `<p>${sorry}</p>` : ""}${p.resubscribe ? `<div class="acts">${o.form("resubscribe", t("back"), true)}</div>` : ""}`;
	} else {
		const line = t("backBody");
		body = `<h1>${t("backDone")}</h1>${line ? `<p>${line}</p>` : ""}<div class="acts">${o.form("unsubscribe", t("out"), true)}</div>`;
	}
	const mark =
		p.mark === "icon"
			? `<div class="icon">${PAGE_ICONS[o.state]}</div>`
			: p.mark === "eyebrow"
				? `<div class="eyebrow">${t("eyebrow")}</div>`
				: "";
	const own = p.logo.startsWith("/") ? `${o.origin ?? ""}${p.logo}` : p.logo;
	const logo = p.logo === "none" ? null : p.logo === "brand" ? o.dress.logo : own;
	return renderSubscriberPage(p, {
		lang: o.lang,
		title,
		body: `${mark}${body}${o.state === "invalid" ? "" : (o.prefs ?? "")}`,
		logo,
		accent: o.dress.accent,
		brand: o.dress.name,
		eyebrow: t("eyebrow"),
	});
}

/** The dashboard's preview: a page not saved yet, in one state, with made-up topics. */
export function previewSubscriberHtml(
	raw: unknown,
	o: {
		dress: BrandDress;
		state: Exclude<PageState, "invalid">;
		lang: "en" | "es";
		dark?: boolean;
	},
) {
	let p = pageOf(raw);
	if (o.dark !== undefined && p.theme === "auto") p = { ...p, theme: o.dark ? "dark" : "light" };
	const l = p.language === "auto" ? o.lang : p.language;
	const t = (k: TextKey) => pageText(p, l, k, { name: o.dress.name, email: "" });
	const topics =
		l === "es"
			? [
					["Novedades", "Lo nuevo, una vez al mes."],
					["Ofertas", "Precios especiales y promociones."],
				]
			: [
					["News", "What's new, once a month."],
					["Offers", "Special prices and promotions."],
				];
	const prefs = `<section><h2>${t("prefs")}</h2><form><div class="topics">${topics
		.map(
			([n, d], i) =>
				`<label class="topic"><span>${n}<small>${d}</small></span><input type="checkbox"${i === 0 ? " checked" : ""}></label>`,
		)
		.join("")}</div><button type="button" class="quiet">${t("save")}</button></form></section>`;
	// The preview draws again on every change: no entrance motion each time.
	const still = "<style>*{animation:none!important}</style></head>";
	return subscriberPageHtml(p, {
		lang: l,
		state: o.state,
		name: o.dress.name || "Harbor Inn",
		email: "ana@example.com",
		dress: { ...o.dress, name: o.dress.name || "Harbor Inn" },
		form: (_a, label, quiet) =>
			`<form><button type="button"${quiet ? ' class="quiet"' : ""}>${label}</button></form>`,
		prefs: o.state === "back" ? "" : prefs,
	}).replace("</head>", still);
}

/**
 * The whole page around `body` (its mark, heading, lines and forms). `logo` is the image to show
 * (the brand's or the page's own, already absolute), `accent` the brand kit's when it has none.
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
		eyebrow?: string;
	},
) {
	const accent = p.accent ?? (o.accent && HEX.test(o.accent) ? o.accent : "#18181b");
	const left = p.align === "left";
	const L = p.layout;
	const boxed = L === "card" || L === "banner";
	const fonts = pageFontsHref(p);
	const lg = p.heading_size === "lg";
	const glow =
		(L === "card" || L === "plain") && colorful(accent)
			? "radial-gradient(1000px 460px at 50% -160px,color-mix(in srgb,var(--btn) 16%,transparent),transparent 70%),"
			: "";
	const css = `${vars(p, accent)}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:${glow}var(--bg);color:var(--ink);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{position:relative;max-width:${L === "plain" && lg ? "36rem" : "31rem"};margin:0 auto;padding:${L === "banner" ? "0 18px 40px" : "clamp(32px,10vh,112px) 18px 48px"};text-align:${left ? "left" : "center"}}
.brand{display:flex;align-items:center;justify-content:${left ? "flex-start" : "center"};gap:12px;margin:0 0 28px;animation:rise .5s ease both}
.logo{display:block;height:var(--logo-h);width:var(--logo-w);max-width:200px;object-fit:var(--logo-fit);border-radius:var(--logo-r)}
.word{font:650 18px/1.2 var(--heading-font);letter-spacing:-.01em;color:var(--ink)}
main{${boxed ? `padding:40px 40px 36px;background:var(--card);border:var(--bw) solid var(--line);border-radius:var(--r-card);box-shadow:${L === "banner" ? "0 1px 2px rgba(0,0,0,.04),0 24px 60px -24px rgba(0,0,0,.28)" : "var(--shadow)"}` : "padding:0"};animation:rise .55s .05s ease both}
@media (max-width:540px){main{${boxed ? "padding:30px 22px 26px" : "padding:0"}}}
.eyebrow{margin:0 0 14px;font:600 11.5px/1.3 var(--font);letter-spacing:.12em;text-transform:uppercase;color:${colorful(accent) ? "var(--btn)" : "var(--mut)"}}
.icon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;margin:${left ? "0 0 20px" : "0 auto 20px"};border-radius:999px;border:1px solid var(--line);color:var(--ink)}
.icon svg{width:20px;height:20px}
h1{margin:0 0 12px;font:${lg ? "500 clamp(30px,6.4vw,44px)/1.08" : "650 clamp(23px,5vw,27px)/1.2"} var(--heading-font);letter-spacing:${lg ? "-.025em" : "-.018em"};text-wrap:balance}
p{margin:0 0 28px;color:var(--mut);font-size:${lg ? "17px" : "15.5px"};line-height:1.6;text-wrap:pretty}
p strong{color:var(--ink);font-weight:600;white-space:nowrap}
@media (max-width:420px){p strong{white-space:normal;overflow-wrap:anywhere}}
.acts{display:flex;flex-wrap:wrap;gap:10px;justify-content:${left ? "flex-start" : "center"}}
.acts form{display:contents}
button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:${left ? "0" : "190px"};font:600 15px/1 var(--font);padding:0 26px;border-radius:var(--r-btn);border:1px solid var(--btn);background:var(--btn);color:var(--btnInk);cursor:pointer;transition:transform .15s,filter .15s,border-color .15s,background .15s}
button:hover{filter:brightness(1.08)}
button:active{transform:translateY(1px)}
button:focus-visible{outline:2px solid var(--btn);outline-offset:3px}
button.quiet{background:transparent;color:var(--ink);border-color:${mix("var(--ink)", "transparent", 0.18)};font-weight:550}
button.quiet:hover{filter:none;border-color:var(--ink)}
@media (max-width:540px){.acts button{width:100%}}
form{margin:0}
section{margin-top:34px;padding-top:28px;border-top:1px solid var(--line);text-align:left}
h2{margin:0 0 14px;font:600 11.5px/1.4 var(--font);letter-spacing:.12em;text-transform:uppercase;color:var(--mut)}
.topics{border:1px solid var(--line);border-radius:var(--r-sm);margin:0 0 16px;background:var(--card)}
label.topic{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:15px 16px;cursor:pointer}
label.topic+label.topic{border-top:1px solid var(--line)}
label.topic span{font-weight:550;line-height:1.4}
label.topic small{display:block;margin-top:2px;color:var(--mut);font-size:13px;font-weight:400}
label.topic input{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:40px;height:24px;margin:0;border-radius:999px;background:${mix("var(--ink)", "transparent", 0.16)};cursor:pointer;transition:background .2s}
label.topic input::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .22s cubic-bezier(.3,.7,.4,1)}
label.topic input:checked{background:var(--btn)}
label.topic input:checked::after{transform:translateX(16px)}
label.topic input:focus-visible{outline:2px solid var(--btn);outline-offset:2px}
section button{min-width:0;min-height:42px;font-size:14px;padding:0 20px}
.ok{display:flex;align-items:center;gap:8px;margin:0 0 14px;color:var(--ink);font-weight:550;font-size:14px}
.ok::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:var(--btn)}
.after{margin-top:24px;font-size:14px;animation:rise .55s .1s ease both}
.after a{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:550;text-decoration:none;opacity:.75;transition:opacity .15s}
.after a:hover{opacity:1}
.after a::after{content:"→";transition:transform .15s}
.after a:hover::after{transform:translateX(3px)}
.foot{margin-top:28px;font-size:12px;line-height:1.6;color:var(--mut);white-space:pre-line}
.band{position:relative;display:flex;align-items:flex-start;justify-content:center;height:clamp(200px,34vh,280px);padding-top:clamp(36px,7vh,56px);background:radial-gradient(circle at 1px 1px,${mix("var(--bandInk)", "transparent", 0.14)} 1px,transparent 0) 0 0/22px 22px,linear-gradient(160deg,var(--band),${mix("var(--band)", "#000", 0.78)});color:var(--bandInk)}
.band .brand{margin:0}
.band .word{color:var(--bandInk);font-size:20px}
.band .logo{box-shadow:0 0 0 ${p.logo_shape === "circle" ? "4px" : "6px"} ${mix("#fff", "transparent", 0.9)};background:#fff}
.L-banner .wrap{margin-top:calc(clamp(200px,34vh,280px) * -1 + clamp(110px,19vh,150px))}
.split{display:grid;min-height:100vh;grid-template-columns:minmax(0,5fr) minmax(0,7fr)}
.side{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:24px;padding:48px;background:radial-gradient(circle at 1px 1px,${mix("var(--bandInk)", "transparent", 0.12)} 1px,transparent 0) 0 0/22px 22px,linear-gradient(170deg,var(--band),${mix("var(--band)", "#000", 0.75)});color:var(--bandInk);overflow:hidden}
.side .brand{justify-content:flex-start;margin:0}
.side .word{color:var(--bandInk);font-size:22px}
.side .big{font:500 clamp(28px,3.4vw,44px)/1.08 var(--heading-font);letter-spacing:-.025em;max-width:12ch}
.side .small{font:600 11.5px/1.3 var(--font);letter-spacing:.12em;text-transform:uppercase;opacity:.75}
.split .wrap{display:flex;flex-direction:column;justify-content:center;max-width:34rem;margin:0;padding:48px clamp(24px,6vw,88px)}
.split .eyebrow{color:var(--mut)}
@media (max-width:1000px){.side{padding:32px}}
@media (max-width:600px){.split{grid-template-columns:1fr;min-height:0}.side{padding:28px 22px;flex-direction:row;align-items:center}.side .big,.side .small{display:none}.split .wrap{padding:36px 22px 40px;max-width:none}}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
	const mark = o.logo
		? `<img class="logo" src="${esc(o.logo)}" alt="${esc(o.brand)}">`
		: o.brand && p.logo !== "none"
			? `<span class="word">${esc(o.brand)}</span>`
			: "";
	const brand = mark ? `<div class="brand">${mark}</div>` : "";
	const link = p.link
		? `<div class="after"><a href="${esc(p.link.url)}">${esc(p.link.label)}</a></div>`
		: "";
	const foot = p.footer ? `<div class="foot">${esc(p.footer)}</div>` : "";
	const content = `<main>${o.body}</main>${link}${foot}`;
	const page =
		L === "split"
			? `<div class="split"><aside class="side">${brand || "<span></span>"}<div class="big">${esc(o.brand)}</div><div class="small">${o.eyebrow ?? ""}</div></aside><div class="wrap">${content}</div></div>`
			: L === "banner"
				? `<div class="band">${brand}</div><div class="wrap">${content}</div>`
				: `<div class="wrap">${brand}${content}</div>`;
	return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.title)}</title>${fonts ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : ""}<style>${css}</style></head><body class="L-${L}">${page}</body></html>`;
}
