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
	corners: "round",
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

/** The page's CSS variables, light, dark, or following the device. */
function vars(p: SubscriberPage, accent: string) {
	const light = `--bg:${p.background};--card:${p.card};--ink:${p.text};--mut:${mix(p.text, p.card, 0.62)};--line:${mix(p.text, p.card, 0.12)};--btn:${accent};--btnInk:${inkOn(accent)}`;
	const da = lum(accent) < 0.08 ? "#eceef1" : accent;
	const dark = `--bg:#0d0f12;--card:#16191e;--ink:#eceef1;--mut:#9aa1ac;--line:#262a31;--btn:${da};--btnInk:${inkOn(da)}`;
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
	// A colorful accent glows softly at the top; a black or gray one would only smudge it.
	const n = Number.parseInt(accent.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	const glow =
		Math.max(r, g, b) - Math.min(r, g, b) > 40
			? "radial-gradient(900px 420px at 50% -120px,color-mix(in srgb,var(--btn) 14%,transparent),transparent 70%),"
			: "";
	const css = `${vars(p, accent)}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;background:${glow}var(--bg);color:var(--ink);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
.wrap{max-width:31rem;margin:0 auto;padding:clamp(28px,9vh,96px) 18px 40px;text-align:${left ? "left" : "center"}}
.brand{display:flex;justify-content:${left ? "flex-start" : "center"};margin:0 0 22px;animation:rise .5s ease both}
.logo{display:block;height:var(--logo-h);width:var(--logo-w);max-width:200px;object-fit:var(--logo-fit);border-radius:var(--logo-r)}
.word{font:700 19px/1.2 var(--heading-font);letter-spacing:-.01em;color:var(--ink)}
main{${card ? "padding:36px 36px 32px;background:var(--card);border:var(--bw) solid var(--line);box-shadow:var(--shadow),0 1px 0 rgba(0,0,0,.02);border-radius:var(--r-card)" : "padding:4px 0"};animation:rise .55s .05s ease both}
@media (max-width:520px){.wrap{padding-top:28px}main{${card ? "padding:28px 22px 24px" : "padding:0"}}}
.icon{display:flex;align-items:center;justify-content:center;width:52px;height:52px;margin:${left ? "0 0 18px" : "0 auto 18px"};border-radius:999px;background:color-mix(in srgb,var(--btn) 12%,transparent);color:var(--btn);animation:pop .5s .15s cubic-bezier(.2,.9,.3,1.3) both}
.icon svg{width:24px;height:24px}
h1{margin:0 0 10px;font:650 clamp(22px,5vw,26px)/1.22 var(--heading-font);letter-spacing:-.018em;text-wrap:balance}
p{margin:0 0 24px;color:var(--mut);font-size:15.5px;text-wrap:pretty}
p strong{color:var(--ink);font-weight:600;white-space:nowrap}
@media (max-width:420px){p strong{white-space:normal;overflow-wrap:anywhere}}
.acts{display:flex;flex-wrap:wrap;gap:10px;justify-content:${left ? "flex-start" : "center"}}
.acts form{display:contents}
button{display:inline-flex;align-items:center;justify-content:center;min-height:46px;min-width:180px;font:600 15px/1 var(--font);padding:0 24px;border-radius:var(--r-btn);border:1px solid var(--btn);background:var(--btn);color:var(--btnInk);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.08),inset 0 1px 0 rgba(255,255,255,.12);transition:transform .15s,filter .15s,background .15s,border-color .15s}
button:hover{filter:brightness(1.08);transform:translateY(-1px)}
button:active{transform:none}
button:focus-visible{outline:2px solid var(--btn);outline-offset:3px}
button.quiet{background:var(--card);color:var(--ink);border-color:var(--line);font-weight:550;box-shadow:none}
button.quiet:hover{filter:none;border-color:color-mix(in srgb,var(--ink) 30%,var(--line))}
@media (max-width:520px){.acts button{width:100%}}
form{margin:0}
section{margin-top:30px;padding-top:26px;border-top:1px solid var(--line);text-align:left}
h2{margin:0 0 14px;font:600 12px/1.4 var(--font);letter-spacing:.07em;text-transform:uppercase;color:var(--mut)}
.topics{border:1px solid var(--line);border-radius:var(--r-sm);overflow:hidden;margin:0 0 16px}
label.topic{display:flex;gap:14px;align-items:center;justify-content:space-between;padding:14px 16px;cursor:pointer;transition:background .15s}
label.topic+label.topic{border-top:1px solid var(--line)}
label.topic:hover{background:color-mix(in srgb,var(--ink) 3%,transparent)}
label.topic span{font-weight:550;line-height:1.4}
label.topic small{display:block;margin-top:2px;color:var(--mut);font-size:13px;font-weight:400}
label.topic input{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:38px;height:22px;margin:0;border-radius:999px;background:color-mix(in srgb,var(--ink) 16%,transparent);cursor:pointer;transition:background .2s}
label.topic input::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s cubic-bezier(.3,.7,.4,1)}
label.topic input:checked{background:var(--btn)}
label.topic input:checked::after{transform:translateX(16px)}
label.topic input:focus-visible{outline:2px solid var(--btn);outline-offset:2px}
section button{min-width:0;min-height:40px;font-size:14px}
.ok{display:flex;align-items:center;gap:8px;margin:0 0 14px;color:var(--ink);font-weight:550;font-size:14px}
.ok::before{content:"";width:18px;height:18px;flex:none;border-radius:50%;background:var(--btn) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/12px no-repeat}
.after{margin-top:22px;font-size:14px;animation:rise .55s .1s ease both}
.after a{display:inline-flex;align-items:center;gap:6px;color:var(--ink);font-weight:550;text-decoration:none;opacity:.8;transition:opacity .15s}
.after a:hover{opacity:1}
.after a::after{content:"→";transition:transform .15s}
.after a:hover::after{transform:translateX(2px)}
.foot{margin-top:26px;font-size:12px;line-height:1.6;color:var(--mut);white-space:pre-line}
@keyframes rise{from{opacity:0;transform:translateY(10px)}}
@keyframes pop{from{opacity:0;transform:scale(.6)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;
	const brand = o.logo
		? `<img class="logo" src="${esc(o.logo)}" alt="${esc(o.brand)}">`
		: o.brand && p.logo !== "none"
			? `<span class="word">${esc(o.brand)}</span>`
			: "";
	const link = p.link
		? `<div class="after"><a href="${esc(p.link.url)}">${esc(p.link.label)}</a></div>`
		: "";
	const foot = p.footer ? `<div class="foot">${esc(p.footer)}</div>` : "";
	return `<!doctype html><html lang="${o.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(o.title)}</title>${fonts ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${esc(fonts)}">` : ""}<style>${css}</style></head><body><div class="wrap">${brand ? `<div class="brand">${brand}</div>` : ""}<main>${o.body}</main>${link}${foot}</div></body></html>`;
}

const svg = (d: string) =>
	`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

/** The round picture above the heading, for each state. */
export const PAGE_ICONS = {
	ask: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
	done: svg('<path d="M20 6 9 17l-5-5"/>'),
	back: svg(
		'<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
	),
	invalid: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
};
