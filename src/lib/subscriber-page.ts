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
	tagline: {
		label: "Big line on the side",
		en: "Your inbox, your call.",
		es: "Su correo, su decisión.",
	},
	taglineBody: {
		label: "Line under it",
		en: "Pick exactly what {name} sends you, or stop it all. You can change it anytime.",
		es: "Elija qué le envía {name}, o deténgalo todo. Puede cambiarlo cuando quiera.",
	},
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
		hint: "A calm, crisp card",
		look: {
			layout: "card",
			logo_shape: "rounded",
			logo_size: "medium",
			align: "center",
			theme: "auto",
			background: "#f5f6f8",
			card: "#ffffff",
			text: "#0f172a",
			font: "inter",
			heading_font: "inter",
			heading_size: "md",
			mark: "none",
			corners: "soft",
			borders: true,
		},
	},
	{
		id: "editorial",
		name: "Editorial",
		hint: "A masthead and big serif type",
		look: {
			layout: "plain",
			logo_shape: "original",
			logo_size: "small",
			align: "left",
			theme: "light",
			background: "#faf8f3",
			card: "#faf8f3",
			text: "#1a1a1a",
			font: "newsreader",
			heading_font: "instrument-serif",
			heading_size: "lg",
			mark: "none",
			corners: "square",
			borders: true,
		},
	},
	{
		id: "studio",
		name: "Studio",
		hint: "Your color down one side",
		look: {
			layout: "split",
			logo_shape: "rounded",
			logo_size: "medium",
			align: "left",
			theme: "light",
			background: "#ffffff",
			card: "#ffffff",
			text: "#111113",
			font: "instrument-sans",
			heading_font: "instrument-sans",
			heading_size: "lg",
			mark: "eyebrow",
			corners: "soft",
			borders: true,
		},
	},
	{
		id: "bold",
		name: "Bold",
		hint: "A big band in your color",
		look: {
			layout: "banner",
			logo_shape: "rounded",
			logo_size: "medium",
			align: "left",
			theme: "light",
			background: "#f3f1ec",
			card: "#ffffff",
			text: "#17150f",
			font: "dm-sans",
			heading_font: "bricolage",
			heading_size: "lg",
			mark: "none",
			corners: "round",
			borders: false,
		},
	},
	{
		id: "boutique",
		name: "Boutique",
		hint: "Sand, fine serif, quiet luxury",
		look: {
			layout: "plain",
			logo_shape: "circle",
			logo_size: "large",
			align: "center",
			theme: "light",
			background: "#efe9e0",
			card: "#efe9e0",
			text: "#2b2620",
			font: "jost",
			heading_font: "cormorant",
			heading_size: "lg",
			mark: "eyebrow",
			corners: "square",
			borders: true,
		},
	},
	{
		id: "minimal",
		name: "Minimal",
		hint: "Just the words",
		look: {
			layout: "plain",
			logo_shape: "rounded",
			logo_size: "small",
			align: "center",
			theme: "auto",
			background: "#ffffff",
			card: "#ffffff",
			text: "#1d1d1f",
			font: "system",
			heading_font: "system",
			heading_size: "md",
			mark: "none",
			corners: "round",
			borders: true,
		},
	},
	{
		id: "midnight",
		name: "Midnight",
		hint: "Dark, with a soft glow",
		look: {
			layout: "card",
			logo_shape: "rounded",
			logo_size: "small",
			align: "left",
			theme: "dark",
			background: "#09090b",
			card: "#111113",
			text: "#fafafa",
			font: "geist",
			heading_font: "geist",
			heading_size: "md",
			mark: "none",
			corners: "soft",
			borders: true,
		},
	},
];

/** Templates renamed since they first shipped. */
const RENAMED: Record<string, string> = { split: "studio", banner: "bold" };

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
		template: templateOf(x.template),
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

function templateOf(v: unknown): string | null {
	const id = typeof v === "string" ? (RENAMED[v] ?? v) : null;
	return id && PAGE_TEMPLATES.some((p) => p.id === id) ? id : null;
}

/** A page with a template's look put on it (its logo choice, color, words and links stay). */
export function withTemplate(p: SubscriberPage, id: string): SubscriberPage {
	const t = PAGE_TEMPLATES.find((x) => x.id === templateOf(id));
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
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

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
		body: `<div class="lead">${mark}${body}</div>${o.state === "invalid" ? "" : (o.prefs ?? "")}`,
		logo,
		accent: o.dress.accent,
		brand: o.dress.name,
		eyebrow: t("eyebrow"),
		tagline: t("tagline"),
		taglineBody: t("taglineBody"),
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

/** A topic's box drawn as a check box (square, rounded or round) instead of a switch. */
const checkCss = (s: string, o: { size: number; radius: string; on: string; tick: string }) =>
	`${s} label.topic{flex-direction:row-reverse;justify-content:flex-end;align-items:flex-start}
${s} label.topic input{width:${o.size}px;height:${o.size}px;margin-top:2px;border-radius:${o.radius};background:transparent;box-shadow:inset 0 0 0 1.5px ${mix("var(--ink)", "transparent", 0.32)}}
${s} label.topic input::after{display:none}
${s} label.topic input:checked{background:${o.on};box-shadow:none}
${s} label.topic input:checked::after{display:block;top:${Math.round(o.size * 0.16)}px;left:${Math.round(o.size * 0.34)}px;width:${Math.round(o.size * 0.24)}px;height:${Math.round(o.size * 0.48)}px;border-radius:0;background:none;box-shadow:none;border:solid ${o.tick};border-width:0 2px 2px 0;transform:rotate(45deg)}`;

/** What each template adds to the shared page: the details its knobs can't say. */
function skinCss(t: string, rule: string) {
	switch (t) {
		case "editorial":
			return `.T-editorial .wrap{max-width:1072px;padding:0 16px}
.mast{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:36px 0 18px;border-bottom:1px solid var(--ink)}
.mast .brand{margin:0}
.mast .brand .name{display:inline}
.mast .word{font:400 30px/1 var(--heading-font);letter-spacing:-.01em}
.mast>span{font:600 11px/1.3 var(--font);letter-spacing:.16em;text-transform:uppercase}
.T-editorial main{padding:64px 0 56px;text-align:left}
@media (min-width:860px){.T-editorial main{display:grid;grid-template-columns:minmax(0,7fr) minmax(0,4fr);column-gap:clamp(40px,8vw,120px);align-items:start;padding:80px 0 72px}.T-editorial section{margin:0!important;padding:10px 0 0!important;border:0!important}}
.T-editorial h1{font-weight:400;font-size:clamp(44px,7vw,76px);line-height:.98;letter-spacing:-.02em;margin-bottom:24px}
.T-editorial .lead p{font-size:20px;line-height:1.55;max-width:30em;margin-bottom:36px}
.T-editorial p strong{font-weight:500}
.T-editorial button{min-height:52px;padding:0 30px;border-radius:0;background:var(--ink);border-color:var(--ink);color:var(--bg);font:600 13px/1 var(--font);letter-spacing:.12em;text-transform:uppercase}
.T-editorial button.quiet{background:transparent;color:var(--ink)}
.T-editorial section{margin-top:48px;padding-top:32px;border-top:1px solid var(--line)}
.T-editorial h2{font:italic 400 26px/1.2 var(--heading-font);color:var(--ink);margin-bottom:18px}
.T-editorial label.topic{padding:16px 0}
.T-editorial label.topic span{font-size:19px;font-weight:500}
.T-editorial label.topic small{font-size:16px}
${checkCss(".T-editorial", { size: 20, radius: "0", on: "var(--ink)", tick: "var(--bg)" })}
.T-editorial section button{min-height:32px;padding:0;border:0;background:none;color:var(--ink);text-decoration:underline;text-underline-offset:6px}
.T-editorial .end{flex-direction:row-reverse;justify-content:space-between;align-items:center;flex-wrap:wrap;margin:0;padding:20px 0 32px;border-top:1px solid var(--line)}
.T-editorial .foot{margin:0;font-size:15px}
.T-editorial .after{margin:0}
.T-editorial .after a{font-style:italic;font-weight:400;font-size:15px;opacity:1}
.T-editorial .after a::after{content:none}`;
		case "studio":
			return `.T-studio .lead button:not(.quiet){background:var(--ink);border-color:var(--ink);color:var(--card)}
.T-studio .topics{border:1px solid var(--line);border-radius:var(--r-sm)}
.T-studio label.topic{padding:14px 16px;border:0}
.T-studio label.topic+label.topic{border-top:1px solid var(--line)}
.T-studio label.topic span{font-weight:600;font-size:15px}
.T-studio h2{color:var(--mut);font-size:13px}`;
		case "bold":
			return `.T-bold .wm{display:block}
.T-bold main{border-radius:28px;padding:40px 40px 34px}
@media (max-width:540px){.T-bold main{padding:28px 22px 24px;border-radius:22px}}
.T-bold h1{font-weight:700;font-size:clamp(30px,5vw,36px);line-height:1.05;letter-spacing:-.035em}
.T-bold button{min-height:52px;padding:0 30px;border-radius:999px;font-size:16px}
.T-bold button.quiet{border:2px solid var(--ink)}
.T-bold section{border-top:0;padding-top:0}
.T-bold h2{font:700 18px/1.3 var(--heading-font);letter-spacing:-.02em;margin-bottom:12px}
.T-bold .topics{display:flex;flex-direction:column;gap:8px}
.T-bold label.topic{padding:16px 18px;border:0!important;border-radius:18px;background:${mix("var(--ink)", "var(--card)", 0.045)}}
.T-bold label.topic span{font-size:16px;font-weight:600}
.T-bold label.topic small{font-size:14px}
.T-bold label.topic input{width:48px;height:28px}
.T-bold label.topic input::after{top:4px;left:4px;width:20px;height:20px}
.T-bold label.topic input:checked::after{transform:translateX(20px)}
.T-bold section button{min-height:44px;font-size:15px}`;
		case "boutique":
			return `.T-boutique .wrap{max-width:532px}
.T-boutique .brand{flex-direction:column;gap:18px;margin-bottom:56px}
.T-boutique .brand .name{display:block;font:500 12px/1.3 var(--font);letter-spacing:.32em;text-transform:uppercase}
.T-boutique .eyebrow{display:flex;align-items:center;justify-content:center;gap:16px;font:400 11px/1.3 var(--font);letter-spacing:.28em;text-transform:uppercase;color:var(--mut);margin-bottom:22px}
.T-boutique .eyebrow::before,.T-boutique .eyebrow::after{content:"";width:40px;height:1px;background:${rule}}
.T-boutique h1{font-weight:400;font-size:clamp(40px,6vw,54px);line-height:1.04;letter-spacing:-.01em;margin-bottom:18px}
.T-boutique .lead p{font-size:16px;line-height:1.75;font-weight:300;max-width:26em;margin:0 auto 36px}
.T-boutique p strong{font-weight:500}
.T-boutique button{min-height:52px;padding:0 44px;border-radius:0;font:500 12px/1 var(--font);letter-spacing:.24em;text-transform:uppercase}
.T-boutique button.quiet{border-color:var(--ink);background:transparent}
.T-boutique section{border-top:0;margin-top:64px;padding-top:0;text-align:center}
.T-boutique h2{font:italic 400 24px/1.2 var(--heading-font);color:var(--ink);margin-bottom:22px}
.T-boutique .topics{text-align:left;border-top:1px solid ${rule}}
.T-boutique label.topic{padding:18px 4px;border-top:0!important;border-bottom:1px solid ${rule}!important}
.T-boutique label.topic span{font:500 21px/1.3 var(--heading-font)}
.T-boutique label.topic small{font:300 14px/1.5 var(--font)}
${checkCss(".T-boutique", { size: 18, radius: "50%", on: "var(--ink)", tick: "var(--bg)" })}
.T-boutique section button{min-height:46px;padding:0 32px;font-size:11.5px}
.T-boutique .end{margin-top:64px;gap:10px}
.T-boutique .after a{font:italic 400 18px var(--heading-font);opacity:1}
.T-boutique .after a::after{content:none}
.T-boutique .foot{font-size:11px;letter-spacing:.2em;text-transform:uppercase}`;
		case "minimal":
			return `.T-minimal .wrap{max-width:412px;padding-top:clamp(64px,14vh,120px)}
.T-minimal .brand{margin-bottom:40px}
.T-minimal h1{font-size:26px;letter-spacing:-.022em}
.T-minimal button{font-weight:500}
.T-minimal section{border-top:0;margin-top:72px;padding-top:0}
.T-minimal h2{font-size:13px;font-weight:400;color:var(--mut)}
.T-minimal label.topic{border:0!important;padding:11px 0}
.T-minimal label.topic span{font-weight:400;font-size:15px}
${checkCss(".T-minimal", { size: 20, radius: "6px", on: "var(--ink)", tick: "var(--bg)" })}
.T-minimal section button{min-height:32px;padding:0;border:0;background:none;color:var(--btn)}
.T-minimal .end{margin-top:64px}
.T-minimal .after a{font-weight:400}`;
		case "midnight":
			return `.T-midnight .brand{justify-content:center}
.T-midnight .brand .name{display:inline}
.T-midnight .word{font-size:15px;font-weight:500}
.T-midnight main{padding:32px;border:0;box-shadow:0 0 0 1px ${mix("var(--ink)", "transparent", 0.08)},0 24px 64px -24px rgb(0 0 0/.7)}
.T-midnight h1{font-size:22px;line-height:1.3}
.T-midnight .lead p{font-size:14.5px;margin-bottom:24px}
.T-midnight p strong{font-weight:400}
.T-midnight button{min-height:42px;font-weight:500;font-size:14.5px}
.T-midnight .lead button:not(.quiet){background:var(--ink);border-color:var(--ink);color:var(--bg)}
.T-midnight button.quiet{background:${mix("var(--ink)", "var(--card)", 0.08)};border-color:transparent}
.T-midnight section{border-top:0!important;margin:28px 0 0!important;padding:0!important}
.T-midnight h2{font-size:13px;font-weight:400;color:var(--mut)}
.T-midnight .topics{border-radius:12px;background:${mix("var(--ink)", "var(--card)", 0.04)}}
.T-midnight label.topic{padding:13px 16px;border:0!important}
.T-midnight label.topic+label.topic{border-top:1px solid ${mix("var(--ink)", "transparent", 0.06)}!important}
.T-midnight .end{align-items:center}`;
		default:
			return "";
	}
}

/**
 * The whole page around `body` (its mark, heading, lines and forms). `logo` is the image to show
 * (the brand's or the page's own, already absolute), `accent` the brand kit's when it has none.
 * The knobs (layout, colors, fonts, corners…) draw the page; its template adds its own details.
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
		tagline?: string;
		taglineBody?: string;
	},
) {
	const accent = p.accent ?? (o.accent && HEX.test(o.accent) ? o.accent : "#18181b");
	const left = p.align === "left";
	const L = p.layout;
	const T = p.template ?? "classic";
	const boxed = L === "card" || L === "banner";
	const fonts = pageFontsHref(p);
	const lg = p.heading_size === "lg";
	const start = left ? "flex-start" : "center";
	const rule = mix("var(--ink)", "transparent", 0.2);
	const glow =
		T === "midnight"
			? "radial-gradient(640px 320px at 50% 0,color-mix(in srgb,var(--btn) 22%,transparent),transparent 70%),"
			: "";
	const css = `${vars(p, accent)}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:${glow}var(--bg);color:var(--ink);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{position:relative;max-width:${L === "plain" && lg ? "38rem" : "30rem"};margin:0 auto;padding:${L === "banner" ? "0 16px 48px" : "clamp(48px,11vh,96px) 16px 48px"};text-align:${left ? "left" : "center"}}
.brand{display:flex;align-items:center;justify-content:${start};gap:10px;margin:0 0 28px}
.logo{display:block;height:var(--logo-h);width:var(--logo-w);max-width:200px;object-fit:var(--logo-fit);border-radius:var(--logo-r)}
.word{font:600 17px/1.2 var(--heading-font);letter-spacing:-.01em;color:inherit}
.brand .name{display:none}
main{${boxed ? `padding:36px 36px 32px;background:var(--card);border:var(--bw) solid var(--line);border-radius:var(--r-card);box-shadow:${p.borders ? "0 1px 2px rgb(16 24 40/.04),0 16px 40px -16px rgb(16 24 40/.14)" : "0 2px 4px rgb(16 24 40/.04),0 30px 60px -30px rgb(16 24 40/.3)"}` : "padding:0"}}
@media (max-width:540px){main{${boxed ? "padding:28px 22px 24px" : "padding:0"}}}
.eyebrow{margin:0 0 12px;font:600 13px/1.3 var(--font);color:${colorful(accent) ? "var(--btn)" : "var(--mut)"}}
.icon{display:flex;align-items:center;justify-content:center;width:48px;height:48px;margin:${left ? "0 0 20px" : "0 auto 20px"};border-radius:var(--r-sm);background:${mix("var(--btn)", "var(--card)", 0.12)};color:var(--btn)}
.icon svg{width:22px;height:22px}
h1{margin:0 0 10px;font:${lg ? "600 clamp(30px,5.6vw,38px)/1.08" : "600 24px/1.25"} var(--heading-font);letter-spacing:${lg ? "-.035em" : "-.02em"};text-wrap:balance}
p{margin:0 0 26px;color:var(--mut);font-size:${lg ? "16px" : "15px"};line-height:1.6;text-wrap:pretty}
p strong{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.acts{display:flex;flex-wrap:wrap;gap:10px;justify-content:${start}}
.acts form{display:contents}
button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 24px;font:600 15px/1 var(--font);border-radius:var(--r-btn);border:1px solid var(--btn);background:var(--btn);color:var(--btnInk);cursor:pointer;transition:filter .15s,border-color .15s,background .15s}
button:hover{filter:brightness(1.08)}
button:focus-visible{outline:2px solid var(--btn);outline-offset:3px}
button.quiet{background:transparent;color:var(--ink);border-color:${mix("var(--ink)", "transparent", 0.16)};font-weight:500}
button.quiet:hover{filter:none;border-color:var(--ink)}
.L-card .acts button,.L-card section button{width:100%}
@media (max-width:540px){.acts button{width:100%}}
form{margin:0}
section{margin-top:30px;padding-top:24px;border-top:1px solid var(--line);text-align:left}
.L-card section,.L-banner section{margin:30px -36px 0;padding:24px 36px 0}
@media (max-width:540px){.L-card section,.L-banner section{margin:26px -22px 0;padding:22px 22px 0}}
h2{margin:0 0 10px;font:600 14px/1.4 var(--font);color:var(--ink)}
.topics{margin:0 0 16px}
label.topic{display:flex;gap:16px;align-items:center;justify-content:space-between;padding:12px 0;border-top:1px solid var(--line);cursor:pointer}
label.topic:last-child{border-bottom:1px solid var(--line)}
label.topic span{font-weight:500;font-size:14.5px;line-height:1.4}
label.topic small{display:block;margin-top:1px;color:var(--mut);font-size:13px;font-weight:400}
label.topic input{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:36px;height:20px;margin:0;border-radius:999px;background:${mix("var(--ink)", "var(--card)", 0.16)};cursor:pointer;transition:background .2s}
label.topic input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.2);transition:transform .2s cubic-bezier(.3,.7,.4,1)}
label.topic input:checked{background:var(--btn)}
label.topic input:checked::after{transform:translateX(16px)}
label.topic input:focus-visible{outline:2px solid var(--btn);outline-offset:2px}
section button{min-height:40px;font-size:14px}
.ok{display:flex;align-items:center;gap:8px;margin:0 0 14px;color:var(--ink);font-weight:500;font-size:14px}
.ok::before{content:"";width:6px;height:6px;flex:none;border-radius:50%;background:var(--btn)}
.end{display:flex;flex-direction:column;align-items:${start};gap:8px;margin-top:24px}
.after{font-size:13.5px}
.after a{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:500;text-decoration:none;opacity:.8;transition:opacity .15s}
.after a:hover{opacity:1}
.after a::after{content:"→";transition:transform .15s}
.after a:hover::after{transform:translateX(3px)}
.foot{font-size:12px;line-height:1.6;color:var(--mut);white-space:pre-line}
.band{display:flex;flex-direction:column;align-items:center;gap:18px;height:clamp(240px,38vh,320px);padding-top:clamp(32px,6vh,44px);background:var(--band);color:var(--bandInk);overflow:hidden}
.band .brand{justify-content:center;margin:0}
.band .brand .name{display:inline;font-size:20px}
.wm{display:none;margin-top:10px;font:800 clamp(88px,15vw,180px)/.8 var(--heading-font);letter-spacing:-.06em;opacity:.14;white-space:nowrap}
.L-banner .wrap{max-width:552px;margin-top:calc(-1 * clamp(110px,19vh,150px))}
.split{display:grid;min-height:100vh;grid-template-columns:minmax(0,4fr) minmax(0,5fr)}
.side{display:flex;flex-direction:column;justify-content:space-between;gap:32px;padding:48px 56px;background:var(--band);color:var(--bandInk)}
.side .brand{margin:0;justify-content:flex-start}
.side .brand .name{display:inline}
.side .big{font:600 clamp(40px,5vw,64px)/.95 var(--heading-font);letter-spacing:-.045em;max-width:8ch;text-wrap:balance}
.side .small{margin-top:22px;font-size:15px;line-height:1.55;opacity:.72;max-width:26em}
.side .end{flex-direction:row;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px;margin:0;opacity:.7}
.side .after a,.side .foot{color:inherit}
.side .after a::after{content:"↗"}
.split .wrap{display:flex;flex-direction:column;justify-content:center;max-width:none;margin:0;padding:48px clamp(24px,7vw,112px)}
.split main{width:100%;max-width:420px}
.split .wrap>.end{display:none}
@media (max-width:1000px){.side{padding:36px}}
@media (max-width:600px){.split{grid-template-columns:1fr;min-height:0}.side{padding:24px 22px}.side>div:not(.brand),.side .end{display:none}.split .wrap{padding:36px 22px 40px}.split .wrap>.end{display:flex}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
${skinCss(T, rule)}`;
	const name = o.brand ? `<span class="word name">${esc(o.brand)}</span>` : "";
	const mark = o.logo
		? `<img class="logo" src="${esc(o.logo)}" alt="${esc(o.brand)}">${name}`
		: o.brand && p.logo !== "none"
			? `<span class="word">${esc(o.brand)}</span>`
			: "";
	const brand = mark ? `<div class="brand">${mark}</div>` : "";
	const link = p.link
		? `<div class="after"><a href="${esc(p.link.url)}">${esc(p.link.label)}</a></div>`
		: "";
	const foot = p.footer ? `<div class="foot">${esc(p.footer)}</div>` : "";
	const end = link || foot ? `<div class="end">${link}${foot}</div>` : "";
	const content = `<main>${o.body}</main>${end}`;
	const top =
		T === "editorial"
			? `<header class="mast">${brand || `<div class="brand"><span class="word">${esc(o.brand)}</span></div>`}<span>${o.eyebrow ?? ""}</span></header>`
			: brand;
	const page =
		L === "split"
			? `<div class="split"><aside class="side">${brand || "<span></span>"}<div><div class="big">${o.tagline ?? ""}</div>${o.taglineBody ? `<div class="small">${o.taglineBody}</div>` : ""}</div>${end || "<span></span>"}</aside><div class="wrap">${content}</div></div>`
			: L === "banner"
				? `<div class="band">${brand}<div class="wm" aria-hidden="true">${esc(o.brand)}</div></div><div class="wrap">${content}</div>`
				: `<div class="wrap">${top}${content}</div>`;
	return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.title)}</title>${fonts ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : ""}<style>${css}</style></head><body class="L-${L} T-${T}">${page}</body></html>`;
}
