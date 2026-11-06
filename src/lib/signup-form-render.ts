/**
 * How a sign-up form looks, and its markup. Pure, so the dashboard's canvas, the hosted page, the
 * HTML to paste and the self-updating script embed all come from this one module.
 *
 * A form is a template (its structure) shown one way (inline where it's pasted, or as a popup,
 * a slide-in or a bar over the page), dressed in the design's colors, font and shapes.
 */

export const TEMPLATES = ["card", "minimal", "split", "banner", "spotlight"] as const;
export const DISPLAYS = ["inline", "popup", "slide_in", "bar"] as const;
export const FONTS = [
	"inter",
	"dm_sans",
	"manrope",
	"space_grotesk",
	"fraunces",
	"playfair",
	"system",
	"inherit",
] as const;

export type Template = (typeof TEMPLATES)[number];
export type Display = (typeof DISPLAYS)[number];
export type Font = (typeof FONTS)[number];

export type FormDesign = {
	template: Template;
	display: Display;
	/** When a popup, slide-in or bar shows: after a delay, after scrolling, or on leaving. */
	trigger: "delay" | "scroll" | "exit";
	/** Seconds (delay) or percent of the page (scroll). */
	trigger_value: number;
	/** Days before it shows again to someone who closed it (0: every visit). */
	frequency_days: number;

	show_logo: boolean;
	/** A small line above the title ("NEWSLETTER"); "" for none. */
	eyebrow: string;
	show_title: boolean;
	description: string;
	show_labels: boolean;
	email_label: string;
	email_placeholder: string;
	name_label: string;
	button: string;
	/** Under the button ("No spam. Unsubscribe anytime."); "" for none. */
	fine_print: string;
	/** Social proof beside a row of faces ("Join 2,400+ readers"); "" for none. */
	proof: string;
	success_title: string;
	success: string;
	/** The split template's picture (https). */
	image_url: string;

	accent: string;
	background: string;
	text: string;
	/** A soft wash of the accent over the background. */
	gradient: boolean;
	font: Font;
	radius: "none" | "small" | "medium" | "large" | "full";
	fields: "outline" | "filled" | "underline";
	size: "compact" | "regular" | "large";
	shadow: boolean;
	align: "left" | "center";

	/** The logo as it is, in a rounded square, or in a circle (both cropped to fill). */
	logo_shape: "original" | "rounded" | "circle";
	logo_size: "small" | "medium" | "large";
	/** Above the title, or beside it on one line. */
	logo_position: "top" | "beside";
	/** The box's outline: none, a faint line, or the button color. */
	border: "none" | "subtle" | "accent";
	button_style: "solid" | "soft" | "outline";
	title_size: "small" | "regular" | "large";
	/** How wide the box gets, around the template's own width. */
	width: "narrow" | "regular" | "wide";
	/** Behind a popup: dimmed, blurred, a light wash, or the page as it is. */
	overlay: "dim" | "blur" | "light" | "none";
	/** Which corner a slide-in comes from. */
	slide_position: "right" | "left";
	/** The bar: at the top or bottom, edge to edge or floating, the box's colors or the button's. */
	bar_position: "top" | "bottom";
	bar_style: "floating" | "full";
	bar_tone: "surface" | "accent";
};

export const DEFAULT_DESIGN: FormDesign = {
	template: "card",
	display: "inline",
	trigger: "delay",
	trigger_value: 8,
	frequency_days: 7,
	show_logo: true,
	eyebrow: "Newsletter",
	show_title: true,
	description: "The best of what we do, once a month. No spam, ever.",
	show_labels: false,
	email_label: "Email",
	email_placeholder: "you@example.com",
	name_label: "First name",
	button: "Subscribe",
	fine_print: "Unsubscribe anytime with one click.",
	proof: "",
	success_title: "Almost there",
	success: "Check your inbox and click the link to confirm your subscription.",
	image_url: "",
	accent: "#18181b",
	background: "#ffffff",
	text: "#18181b",
	gradient: false,
	font: "inter",
	radius: "medium",
	fields: "outline",
	size: "regular",
	shadow: true,
	align: "left",
	logo_shape: "original",
	logo_size: "medium",
	logo_position: "top",
	border: "subtle",
	button_style: "solid",
	title_size: "regular",
	width: "regular",
	overlay: "dim",
	slide_position: "right",
	bar_position: "top",
	bar_style: "floating",
	bar_tone: "surface",
};

/** What picking a template changes (it keeps the words and colors). */
export const TEMPLATE_PRESETS: Record<Template, Partial<FormDesign>> = {
	card: { align: "left" },
	minimal: { align: "left" },
	split: { align: "left" },
	banner: { align: "left" },
	spotlight: { align: "center" },
};

export const TEMPLATE_INFO: Record<Template, { name: string; hint: string }> = {
	card: { name: "Card", hint: "A boxed form with room to say why" },
	minimal: { name: "Minimal", hint: "One line, for footers and sidebars" },
	split: { name: "Split", hint: "A picture beside the form" },
	banner: { name: "Banner", hint: "Wide: the pitch left, the form right" },
	spotlight: { name: "Spotlight", hint: "Big and centered, for a page's end" },
};

export const FONT_INFO: Record<Font, { name: string; stack: string; google?: string }> = {
	inter: {
		name: "Inter",
		stack: "'Inter',system-ui,sans-serif",
		google: "Inter:wght@400;500;600;700",
	},
	dm_sans: {
		name: "DM Sans",
		stack: "'DM Sans',system-ui,sans-serif",
		google: "DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700",
	},
	manrope: {
		name: "Manrope",
		stack: "'Manrope',system-ui,sans-serif",
		google: "Manrope:wght@400;500;600;700",
	},
	space_grotesk: {
		name: "Space Grotesk",
		stack: "'Space Grotesk',system-ui,sans-serif",
		google: "Space+Grotesk:wght@400;500;600;700",
	},
	fraunces: {
		name: "Fraunces",
		stack: "'Fraunces',Georgia,serif",
		google: "Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700",
	},
	playfair: {
		name: "Playfair",
		stack: "'Playfair Display',Georgia,serif",
		google: "Playfair+Display:wght@400;500;600;700",
	},
	system: {
		name: "System",
		stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
	},
	inherit: { name: "Website's", stack: "inherit" },
};

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v: unknown, fallback: string, max: number) =>
	typeof v === "string" ? v.slice(0, max) : fallback;
const one = <T extends string>(v: unknown, list: readonly T[], fallback: T): T =>
	list.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const num = (v: unknown, fallback: number, min: number, max: number) =>
	typeof v === "number" && Number.isFinite(v)
		? Math.min(max, Math.max(min, Math.round(v)))
		: fallback;

/** A stored or posted design, with anything missing or wrong set to the default. */
/**
 * An https image address, re-serialized by the URL parser so it can't carry `<`, `>`, quotes or
 * spaces: the value goes into CSS inside a <style> element on pages served from Mailroom's own
 * origin, where a "</style>" would end the element and let a form's design inject markup.
 */
function httpsImage(v: string) {
	if (!/^https:\/\/\S+$/.test(v)) return "";
	try {
		const u = new URL(v);
		return u.protocol === "https:" ? u.href : "";
	} catch {
		return "";
	}
}

/** A URL made safe for `url("…")` inside a <style> element (also covers designs stored before httpsImage). */
const cssUrl = (v: string) =>
	v.replace(
		/["'\\()<>\s]/g,
		(c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`,
	);

export function parseDesign(raw: unknown): FormDesign {
	const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const d = DEFAULT_DESIGN;
	const color = (v: unknown, fallback: string) =>
		typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fallback;
	const image = str(r.image_url, d.image_url, 2000).trim();
	return {
		template: one(r.template, TEMPLATES, d.template),
		display: one(r.display, DISPLAYS, d.display),
		trigger: one(r.trigger, ["delay", "scroll", "exit"] as const, d.trigger),
		trigger_value: num(r.trigger_value, d.trigger_value, 0, 600),
		frequency_days: num(r.frequency_days, d.frequency_days, 0, 365),
		show_logo: bool(r.show_logo, d.show_logo),
		eyebrow: str(r.eyebrow, d.eyebrow, 60),
		show_title: bool(r.show_title, d.show_title),
		description: str(r.description, d.description, 500),
		show_labels: bool(r.show_labels, d.show_labels),
		email_label: str(r.email_label, d.email_label, 60) || d.email_label,
		email_placeholder: str(r.email_placeholder, d.email_placeholder, 80),
		name_label: str(r.name_label, d.name_label, 60) || d.name_label,
		button: str(r.button, d.button, 40) || d.button,
		fine_print: str(r.fine_print, d.fine_print, 200),
		proof: str(r.proof, d.proof, 80),
		success_title: str(r.success_title, d.success_title, 80),
		success: str(r.success, d.success, 300) || d.success,
		image_url: httpsImage(image),
		accent: color(r.accent, d.accent),
		background: color(r.background, d.background),
		text: color(r.text, d.text),
		gradient: bool(r.gradient, d.gradient),
		font: one(r.font, FONTS, d.font),
		radius: one(r.radius, ["none", "small", "medium", "large", "full"] as const, d.radius),
		fields: one(r.fields, ["outline", "filled", "underline"] as const, d.fields),
		size: one(r.size, ["compact", "regular", "large"] as const, d.size),
		shadow: bool(r.shadow, d.shadow),
		align: one(r.align, ["left", "center"] as const, d.align),
		logo_shape: one(r.logo_shape, ["original", "rounded", "circle"] as const, d.logo_shape),
		logo_size: one(r.logo_size, ["small", "medium", "large"] as const, d.logo_size),
		logo_position: one(r.logo_position, ["top", "beside"] as const, d.logo_position),
		border: one(r.border, ["none", "subtle", "accent"] as const, d.border),
		button_style: one(r.button_style, ["solid", "soft", "outline"] as const, d.button_style),
		title_size: one(r.title_size, ["small", "regular", "large"] as const, d.title_size),
		width: one(r.width, ["narrow", "regular", "wide"] as const, d.width),
		overlay: one(r.overlay, ["dim", "blur", "light", "none"] as const, d.overlay),
		slide_position: one(r.slide_position, ["right", "left"] as const, d.slide_position),
		bar_position: one(r.bar_position, ["top", "bottom"] as const, d.bar_position),
		bar_style: one(r.bar_style, ["floating", "full"] as const, d.bar_style),
		bar_tone: one(r.bar_tone, ["surface", "accent"] as const, d.bar_tone),
	};
}

export const esc = (s: string) =>
	s.replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
	);

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const alpha = (hex: string, a: number) => `rgba(${rgb(hex).join(",")},${a})`;
const luminance = (hex: string) => {
	const [r = 0, g = 0, b = 0] = rgb(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Black or white, whichever reads on the color. */
export const onColor = (hex: string) => (luminance(hex) > 0.45 ? "#0a0a0a" : "#ffffff");
const isDark = (hex: string) => luminance(hex) < 0.2;

export type RenderInput = {
	id: string;
	/** Where it posts: the form's /subscribe URL. */
	action: string;
	title: string;
	ask_name: boolean;
	/** The brand's logo (absolute URL or data: URL), and its name for the alt text. */
	logo?: string | null;
	brand?: string;
	/** Posted with it: a referral link's code (ref), where the page was found (utm_source). */
	hidden?: Record<string, string>;
};

export type RenderOptions = {
	sitekey?: string | null;
	/** The dashboard: no scripts, popups shown open, and this state. */
	preview?: "form" | "done";
	/** Force where it shows (the hosted page is always inline). */
	display?: Display;
};

const RADIUS = {
	none: [0, 0],
	small: [4, 6],
	medium: [8, 14],
	large: [12, 20],
	full: [999, 24],
} as const;
const SIZE = {
	compact: { field: 38, font: 14, pad: 22, gap: 10 },
	regular: { field: 44, font: 15, pad: 32, gap: 12 },
	large: { field: 52, font: 16, pad: 40, gap: 14 },
};
const TITLE = { card: 24, minimal: 18, split: 26, banner: 22, spotlight: 34 };
const MAX = { card: 460, minimal: 520, split: 820, banner: 920, spotlight: 640 };
const WIDTH = { narrow: 0.82, regular: 1, wide: 1.2 };
const TITLE_SCALE = { small: 0.84, regular: 1, large: 1.2 };
/** A logo's height as it is, and its side when cropped to a shape. */
const LOGO = { small: [24, 32], medium: [32, 44], large: [44, 60] } as const;

/** How wide the form's box gets. */
export const maxWidth = (d: Pick<FormDesign, "template" | "width">) =>
	Math.round(MAX[d.template] * WIDTH[d.width]);

const logoCss = (d: FormDesign, [height, side]: readonly [number, number], ring: string) =>
	d.logo_shape === "original"
		? `height:${height}px;width:auto;max-width:${height * 5}px;object-fit:contain;border-radius:0;box-shadow:none`
		: `width:${side}px;height:${side}px;max-width:none;object-fit:cover;border-radius:${d.logo_shape === "circle" ? "50%" : `${Math.round(side * 0.26)}px`};box-shadow:0 0 0 1px ${ring}`;

/** The Google Fonts stylesheet a design needs, if any. */
export const fontLink = (d: FormDesign) => {
	const g = FONT_INFO[d.font].google;
	return g
		? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${g}&display=swap">`
		: "";
};

function styles(root: string, d: FormDesign, display: Display, preview = false) {
	const s = `#${root}`;
	const [fieldR, boxR] = RADIUS[d.radius];
	const z = SIZE[d.size];
	const dark = isDark(d.background);
	const t = d.template;
	const border = alpha(d.text, dark ? 0.16 : 0.12);
	const fieldBorder = alpha(d.text, dark ? 0.22 : 0.18);
	const fieldBg =
		d.fields === "filled"
			? alpha(d.text, dark ? 0.08 : 0.045)
			: dark
				? alpha("#ffffff", 0.04)
				: "#ffffff";
	const surface = d.gradient
		? `radial-gradient(120% 140% at 0% 0%,${alpha(d.accent, dark ? 0.32 : 0.14)} 0%,transparent 55%),radial-gradient(90% 120% at 100% 100%,${alpha(d.accent, dark ? 0.2 : 0.08)} 0%,transparent 60%),${d.background}`
		: d.background;
	const boxed = t !== "minimal" || display !== "inline";
	const shadow = d.shadow
		? `0 1px 2px ${alpha("#000000", 0.05)},0 12px 32px -12px ${alpha("#000000", dark ? 0.5 : 0.18)}`
		: "none";
	const center = d.align === "center";
	const title = display === "bar" ? 15 : Math.round(TITLE[t] * TITLE_SCALE[d.title_size]);
	// The accent as text: itself when it reads on the background, else the text color.
	const accentInk = isDark(d.accent) === dark ? d.text : d.accent;
	const underline = d.fields === "underline";
	const boxBorder =
		d.border === "none"
			? "0"
			: d.border === "accent"
				? `1.5px solid ${d.accent}`
				: `1px solid ${border}`;
	const button =
		d.button_style === "solid"
			? `color:${onColor(d.accent)};background:${d.accent};box-shadow:inset 0 1px 0 ${alpha("#ffffff", 0.16)},0 1px 2px ${alpha("#000000", 0.12)}`
			: d.button_style === "soft"
				? `color:${accentInk};background:${alpha(d.accent, dark ? 0.22 : 0.12)};box-shadow:none`
				: `color:${accentInk};background:transparent;box-shadow:inset 0 0 0 1.5px ${accentInk}`;
	const buttonHover =
		d.button_style === "solid"
			? `filter:brightness(${isDark(d.accent) ? 1.18 : 0.94})`
			: `background:${alpha(d.accent, d.button_style === "soft" ? (dark ? 0.3 : 0.18) : dark ? 0.14 : 0.07)}`;
	const beside = d.logo_position === "beside";
	const ring = alpha(d.text, dark ? 0.14 : 0.1);
	const rules = [
		`${s}{all:initial;display:block;box-sizing:border-box;width:100%;font-family:${FONT_INFO[d.font].stack};font-size:${z.font}px;line-height:1.5;color:${d.text};-webkit-font-smoothing:antialiased;text-align:${center ? "center" : "left"}}`,
		`${s} *,${s} *::before,${s} *::after{box-sizing:border-box;margin:0;padding:0;font:inherit;color:inherit;letter-spacing:inherit}`,
		`${s} [hidden]{display:none!important}`,
		`${s} .mr-box{position:relative;max-width:${display === "bar" ? "none" : `${maxWidth(d)}px`};${center ? "margin:0 auto;" : ""}${boxed ? `background:${surface};border:${boxBorder};border-radius:${boxR}px;box-shadow:${shadow};` : ""}overflow:hidden}`,
		`${s} .mr-body{display:flex;flex-direction:column;gap:${z.gap + 8}px;padding:${boxed ? `${z.pad}px` : "0"}}`,
		`${s} .mr-head{display:flex;flex-direction:column;gap:8px;${center ? "align-items:center;" : ""}}`,
		beside
			? `${s} .mr-brand{display:flex;align-items:center;gap:14px;${center ? "justify-content:center;" : ""}}${s} .mr-heading{display:flex;flex-direction:column;gap:4px;min-width:0;text-align:left}`
			: `${s} .mr-brand{display:flex;flex-direction:column;gap:8px;align-items:${center ? "center" : "flex-start"}}${s} .mr-heading{display:flex;flex-direction:column;gap:8px;align-self:stretch;${center ? "align-items:center;" : ""}}`,
		`${s} .mr-logo{display:block;flex:none;${logoCss(d, LOGO[d.logo_size], ring)};${beside ? "" : "margin-bottom:6px"}}`,
		`${s} .mr-eyebrow{font-size:11.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:${accentInk};opacity:${accentInk === d.text ? 0.6 : 1}}`,
		`${s} .mr-title{display:block;font-size:${title}px;font-weight:650;line-height:1.15;letter-spacing:-.022em;text-wrap:balance}`,
		`${s} .mr-desc{color:${alpha(d.text, 0.66)};font-size:${z.font}px;line-height:1.55;text-wrap:pretty;${center ? "max-width:36em;margin:0 auto;" : ""}}`,
		`${s} form{display:flex;flex-direction:column;gap:${z.gap}px}`,
		`${s} .mr-field{display:flex;flex-direction:column;gap:6px;min-width:0}`,
		`${s} label{font-size:13px;font-weight:550;text-align:left}`,
		`${s} input[type=email],${s} input[type=text]{display:block;width:100%;height:${z.field}px;padding:0 ${underline ? 2 : 14}px;font-size:${z.font}px;color:${d.text};background:${underline ? "transparent" : fieldBg};border:${underline ? "0" : `1px solid ${d.fields === "filled" ? "transparent" : fieldBorder}`};${underline ? `border-bottom:1.5px solid ${fieldBorder};` : ""}border-radius:${underline ? 0 : fieldR}px;outline:none;transition:border-color .15s,box-shadow .15s,background .15s;-webkit-appearance:none;appearance:none}`,
		`${s} input::placeholder{color:${alpha(d.text, 0.42)};opacity:1}`,
		`${s} input:focus{border-color:${d.accent};${underline ? "" : `box-shadow:0 0 0 3.5px ${alpha(d.accent, 0.18)};`}${d.fields === "filled" ? `background:${dark ? alpha("#ffffff", 0.06) : "#ffffff"};` : ""}}`,
		`${s} .mr-submit{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:${z.field}px;padding:0 ${Math.round(z.field * 0.45)}px;font-size:${z.font}px;font-weight:600;white-space:nowrap;${button};border:0;border-radius:${fieldR}px;cursor:pointer;transition:filter .15s,background .15s,transform .05s}`,
		`${s} .mr-submit:hover{${buttonHover}}`,
		`${s} .mr-submit:active{transform:translateY(1px)}`,
		`${s} .mr-submit:focus-visible{outline:2px solid ${d.accent};outline-offset:2px}`,
		`${s} .mr-submit[disabled]{cursor:default;opacity:.75}`,
		`${s} .mr-spin{display:none;width:15px;height:15px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:mr-spin .7s linear infinite}`,
		`${s} .mr-busy .mr-spin{display:inline-block}`,
		"@keyframes mr-spin{to{transform:rotate(360deg)}}",
		`${s} .mr-stack .mr-submit{width:100%}`,
		`${s} .mr-row{display:flex;gap:${Math.max(8, z.gap - 2)}px;align-items:flex-end}`,
		`${s} .mr-row .mr-field{flex:1 1 0}`,
		`${s} .mr-row .mr-submit{flex:none}`,
		`${s} .mr-turnstile{display:flex;${center ? "justify-content:center;" : ""}}`,
		`${s} .mr-meta{display:flex;flex-direction:column;gap:10px;${center ? "align-items:center;" : ""}}`,
		`${s} .mr-fine{font-size:12.5px;color:${alpha(d.text, 0.55)}}`,
		`${s} .mr-proof{display:flex;align-items:center;gap:10px;font-size:13px;color:${alpha(d.text, 0.66)}}`,
		`${s} .mr-faces{display:flex}`,
		`${s} .mr-faces i{display:block;width:24px;height:24px;border-radius:50%;border:2px solid ${d.background};margin-left:-7px}`,
		`${s} .mr-faces i:first-child{margin-left:0}`,
		`${s} .mr-error{font-size:13px;color:${dark ? "#ff8a80" : "#d92d20"}}`,
		`${s} .mr-error:empty{display:none}`,
		`${s} .mr-done{display:flex;flex-direction:column;gap:10px;${center ? "align-items:center;" : ""}}`,
		`${s} .mr-check{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:${alpha(d.accent, dark ? 0.24 : 0.1)};color:${accentInk}}`,
		`${s} .mr-done h3{font-size:${Math.min(title, 24)}px;font-weight:650;letter-spacing:-.02em;line-height:1.2}`,
		`${s} .mr-done p{color:${alpha(d.text, 0.66)};max-width:30em}`,
		`${s} .mr-trap{position:absolute!important;left:-9999px!important;width:1px;height:1px;overflow:hidden}`,
		`${s} .mr-close{position:absolute;top:12px;right:12px;z-index:2;display:flex;align-items:center;justify-content:center;width:30px;height:30px;border:0;border-radius:50%;background:${alpha(d.text, 0.06)};color:${alpha(d.text, 0.66)};cursor:pointer;transition:background .15s}`,
		`${s} .mr-close:hover{background:${alpha(d.text, 0.12)};color:${d.text}}`,
		// The split template's picture panel.
		`${s} .mr-split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,6fr)}`,
		`${s} .mr-media{position:relative;min-height:320px;background:${d.image_url ? `${d.background} url("${cssUrl(d.image_url)}") center/cover no-repeat` : `radial-gradient(120% 90% at 100% 0%,${alpha("#ffffff", 0.22)},transparent 55%),linear-gradient(150deg,${d.accent},${alpha(d.accent, 0.7)})`};display:flex;align-items:flex-end;padding:24px}`,
		`${s} .mr-media .mr-logo{margin:0;${d.image_url || d.logo_shape !== "original" ? "" : `filter:brightness(0) invert(${onColor(d.accent) === "#ffffff" ? 1 : 0});`}${d.logo_shape === "original" ? "" : `box-shadow:0 0 0 2px ${alpha("#ffffff", 0.5)};`}opacity:.95}`,
		`${s} .mr-split .mr-body{justify-content:center}`,
		// The banner template: the pitch beside the form.
		`${s} .mr-banner{display:flex;align-items:center;gap:36px}`,
		`${s} .mr-banner .mr-head{flex:1 1 0;min-width:0}`,
		`${s} .mr-banner .mr-act{flex:1.2 1 0;min-width:0;display:flex;flex-direction:column;gap:12px}`,
		`${s}.mr-spotlight .mr-body{padding:${z.pad + 20}px ${z.pad + 8}px}`,
		`${s}.mr-spotlight form,${s}.mr-spotlight .mr-meta{width:100%;max-width:460px;margin:0 auto}`,
		`@media (max-width:600px){${s} .mr-row{flex-direction:column;align-items:stretch}${s} .mr-row .mr-submit{width:100%}${s} .mr-split{grid-template-columns:1fr}${s} .mr-media{min-height:140px}${s} .mr-banner{flex-direction:column;align-items:stretch;gap:20px}${s} .mr-body,${s}.mr-spotlight .mr-body{padding:${boxed ? `${Math.max(22, z.pad - 6)}px` : "0"}}${s} .mr-title{font-size:${Math.max(19, Math.round(title * 0.84))}px}}`,
	];
	// How it sits over the page.
	const OVERLAY = {
		dim: [alpha("#09090b", 0.55), 3],
		blur: [alpha("#09090b", 0.2), 10],
		light: [alpha("#ffffff", 0.62), 4],
		none: ["transparent", 0],
	} as const;
	const [veil, blur] = OVERLAY[d.overlay];
	if (display === "popup")
		rules.push(
			`${s} .mr-layer{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:20px;background:${veil};${blur ? `-webkit-backdrop-filter:blur(${blur}px);backdrop-filter:blur(${blur}px);` : ""}animation:mr-fade .2s ease-out}`,
			`${s} .mr-layer .mr-box{width:100%;box-shadow:${d.shadow ? `0 2px 4px ${alpha("#000000", 0.06)},0 32px 64px -16px ${alpha("#000000", 0.45)}` : "none"};animation:mr-pop .3s cubic-bezier(.2,.9,.3,1.1)}`,
			"@keyframes mr-fade{from{opacity:0}}",
			"@keyframes mr-pop{from{opacity:0;transform:translateY(12px) scale(.97)}}",
		);
	if (display === "slide_in")
		rules.push(
			`${s} .mr-layer{position:fixed;${d.slide_position === "left" ? "left" : "right"}:20px;bottom:20px;z-index:2147483646;width:min(${{ narrow: 340, regular: 400, wide: 460 }[d.width]}px,calc(100vw - 40px));animation:mr-slide .4s cubic-bezier(.2,.9,.3,1)}`,
			`${s} .mr-layer .mr-box{max-width:none;box-shadow:${d.shadow ? `0 2px 4px ${alpha("#000000", 0.06)},0 24px 48px -12px ${alpha("#000000", 0.35)}` : "none"}}`,
			`${s} .mr-layer .mr-split{grid-template-columns:1fr}${s} .mr-layer .mr-media{min-height:120px}${s} .mr-layer .mr-banner{flex-direction:column;align-items:stretch;gap:18px}`,
			`${s} .mr-layer .mr-body{padding:${Math.max(22, z.pad - 6)}px}`,
			`${s} .mr-layer .mr-title{font-size:${Math.round(20 * TITLE_SCALE[d.title_size])}px}`,
			`@keyframes mr-slide{from{opacity:0;transform:translate(${d.slide_position === "left" ? "-16px" : "16px"},24px)}}`,
		);
	if (display === "bar") {
		const floating = d.bar_style === "floating";
		const bottom = d.bar_position === "bottom";
		const tone = d.bar_tone === "accent";
		// On the accent, everything takes the color that reads on it; the button turns inside out.
		const ink = tone ? onColor(d.accent) : d.text;
		const barR = floating ? (d.radius === "full" ? 999 : Math.max(boxR, 10)) : 0;
		const h = Math.min(z.field, 40);
		rules.push(
			`${s} .mr-layer{position:fixed;left:0;right:0;${bottom ? "bottom" : "top"}:0;z-index:2147483646;padding:${floating ? "12px" : "0"};pointer-events:none;animation:${bottom ? "mr-rise" : "mr-drop"} .45s cubic-bezier(.2,.9,.3,1)}`,
			`${s} .mr-layer .mr-box{pointer-events:auto;max-width:${floating ? "1040px" : "none"};margin:0 auto;border-radius:${barR}px;${tone ? `background:${d.accent};border-color:${alpha(ink, 0.14)};` : ""}color:${ink};${floating ? "" : `border-width:${bottom ? "1px 0 0" : "0 0 1px"};`}box-shadow:${floating ? (d.shadow ? `0 1px 2px ${alpha("#000000", 0.06)},0 18px 40px -14px ${alpha("#000000", dark || tone ? 0.5 : 0.28)}` : "none") : `0 ${bottom ? -6 : 6}px 24px -14px ${alpha("#000000", 0.3)}`}}`,
			`${s} .mr-barin{display:flex;align-items:center;gap:16px;max-width:${floating ? "none" : "1100px"};margin:0 auto;padding:${floating ? `10px 52px 10px ${barR > 30 ? 20 : 14}px` : "10px 56px 10px 20px"}}`,
			`${s} .mr-barin .mr-logo{margin:0;${logoCss(d, d.logo_shape === "original" ? [26, 26] : [32, 32], alpha(ink, 0.14))}}`,
			`${s} .mr-barin .mr-text{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap}`,
			`${s} .mr-barin .mr-eyebrow{padding:3px 9px;border-radius:999px;font-size:10.5px;line-height:1.4;opacity:1;color:${tone ? ink : accentInk};background:${alpha(tone ? ink : d.accent, tone ? 0.16 : dark ? 0.22 : 0.1)}}`,
			`${s} .mr-barin .mr-title{font-size:15px;letter-spacing:-.01em}`,
			`${s} .mr-barin .mr-desc{font-size:14px;color:${alpha(ink, 0.7)}}`,
			`${s} .mr-barin form{flex:0 1 400px;min-width:0}`,
			`${s} .mr-barin .mr-row{gap:8px}`,
			`${s} .mr-barin .mr-submit,${s} .mr-barin input{height:${h}px}`,
			`${s} .mr-barin .mr-submit{padding:0 ${Math.round(h * 0.42)}px}`,
			`${s} .mr-barin .mr-done{flex:1 1 auto;flex-direction:row;align-items:center;gap:10px}`,
			`${s} .mr-barin .mr-check{flex:none;width:28px;height:28px}`,
			`${s} .mr-barin .mr-check svg{width:16px;height:16px}`,
			`${s} .mr-barin .mr-done h3{font-size:15px}`,
			`${s} .mr-barin .mr-done p{color:${alpha(ink, 0.7)}}`,
			`${s} .mr-layer .mr-close{top:50%;transform:translateY(-50%);right:${floating ? 10 : 14}px;width:28px;height:28px;background:${alpha(ink, 0.08)};color:${alpha(ink, 0.7)}}`,
			`${s} .mr-layer .mr-close:hover{background:${alpha(ink, 0.15)};color:${ink}}`,
			tone
				? `${s} .mr-barin input{color:${ink};background:${alpha(ink, 0.12)};border-color:${alpha(ink, 0.24)}}${s} .mr-barin input::placeholder{color:${alpha(ink, 0.62)}}${s} .mr-barin input:focus{border-color:${ink};box-shadow:0 0 0 3px ${alpha(ink, 0.22)};background:${alpha(ink, 0.16)}}${s} .mr-barin .mr-submit{color:${d.accent};background:${ink};box-shadow:none}${s} .mr-barin .mr-submit:hover{filter:none;opacity:.9}${s} .mr-barin .mr-check{background:${alpha(ink, 0.16)};color:${ink}}${s} .mr-barin .mr-error{color:${ink}}`
				: "",
			`@media (max-width:640px){${s} .mr-layer{padding:${floating ? "8px" : "0"}}${s} .mr-layer .mr-box{border-radius:${floating ? Math.min(Math.max(boxR, 10), 18) : 0}px}${s} .mr-barin{flex-wrap:wrap;align-items:flex-start;gap:10px 12px;padding:12px 14px 14px}${s} .mr-barin .mr-text{flex:1 1 0;padding-right:34px}${s} .mr-barin form{flex:1 0 100%}${s} .mr-barin .mr-row{flex-direction:row;align-items:stretch}${s} .mr-barin .mr-row .mr-submit{width:auto}${s} .mr-layer .mr-close{top:10px;transform:none}}`,
			"@keyframes mr-drop{from{opacity:0;transform:translateY(-100%)}}",
			"@keyframes mr-rise{from{opacity:0;transform:translateY(100%)}}",
		);
	}
	// The dashboard's canvas: changes ease in rather than snap.
	if (preview)
		rules.push(
			`${s} .mr-box,${s} .mr-submit,${s} input,${s} .mr-logo,${s} .mr-close,${s} .mr-eyebrow,${s} .mr-desc,${s} .mr-check,${s} .mr-media{transition:background-color .3s,color .3s,border-color .3s,border-radius .3s,box-shadow .3s,max-width .35s cubic-bezier(.2,.8,.2,1),width .3s,height .3s,padding .3s}`,
			`${s} .mr-layer{transition:background-color .3s,backdrop-filter .3s,-webkit-backdrop-filter .3s,width .35s}`,
		);
	return rules.join("\n");
}

const CHECK =
	'<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
const CLOSE =
	'<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

/** Faces for the social-proof line, in shades of the accent. */
const faces = (d: FormDesign) =>
	`<span class="mr-faces" aria-hidden="true">${[0.95, 0.72, 0.5, 0.3]
		.map(
			(a) =>
				`<i style="background:linear-gradient(135deg,${alpha(d.accent, a)},${alpha(d.accent, Math.max(0.12, a - 0.35))}),${d.background}"></i>`,
		)
		.join("")}</span>`;

/**
 * The form's markup and scoped styles (no scripts). `display` decides whether it's wrapped in a
 * layer over the page; those start hidden unless it's the dashboard's preview.
 */
export function renderMarkup(f: RenderInput, design: FormDesign, o: RenderOptions = {}) {
	const d = design;
	const display = o.display ?? d.display;
	const t = display === "bar" ? "bar" : d.template;
	const root = `mr-${f.id}`;
	const key = o.sitekey ?? null;
	const done = o.preview === "done";
	// Email and button on one line where there's room; the banner's half-width needs the email alone.
	const inlineRow =
		t !== "card" && t !== "split" && display !== "slide_in" && !(t === "banner" && f.ask_name);
	const field = (id: string, label: string, input: string) =>
		d.show_labels && t !== "bar"
			? `<div class="mr-field"><label for="${root}-${id}">${esc(label)}</label>${input}</div>`
			: `<div class="mr-field">${input}</div>`;
	const emailInput = `<input id="${root}-email" type="email" name="email" required autocomplete="email" placeholder="${esc(d.email_placeholder || d.email_label)}" aria-label="${esc(d.email_label)}">`;
	const nameInput = `<input id="${root}-name" type="text" name="first_name" autocomplete="given-name" placeholder="${esc(d.name_label)}" aria-label="${esc(d.name_label)}">`;
	const submit = `<button type="submit" class="mr-submit"><span class="mr-spin" aria-hidden="true"></span><span>${esc(d.button)}</span></button>`;
	const turnstile = !key
		? ""
		: o.preview
			? // The real check only loads on the form's own sites; the canvas shows where it sits.
				'<div class="mr-turnstile"><div style="display:flex;align-items:center;gap:10px;width:300px;max-width:100%;height:65px;padding:0 14px;border:1px solid #e4e4e7;border-radius:6px;background:#fafafa;color:#3f3f46;font:13px/1.3 system-ui,sans-serif;text-align:left"><span style="display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:#16a34a;color:#fff">&#10003;</span>Success!<span style="margin-left:auto;color:#a1a1aa;font-size:10px;line-height:1.3;text-align:right">CLOUDFLARE<br>Privacy · Terms</span></div></div>'
			: `<div class="mr-turnstile"><div class="cf-turnstile" data-sitekey="${esc(key)}"></div></div>`;
	const fields = [
		// The bar stays one line: email only.
		f.ask_name && t !== "bar" ? field("name", d.name_label, nameInput) : "",
		field("email", d.email_label, emailInput),
	].join("");
	const form = [
		`<form action="${esc(f.action)}" method="post" class="${inlineRow ? "mr-inline" : "mr-stack"}"${done ? " hidden" : ""} novalidate>`,
		inlineRow
			? `<div class="mr-row">${fields}${submit}</div>${turnstile}`
			: `${fields}${turnstile}${submit}`,
		'<div class="mr-trap" aria-hidden="true"><input type="text" name="website" tabindex="-1" autocomplete="off"></div>',
		...Object.entries(f.hidden ?? {}).map(
			([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
		),
		'<p class="mr-error" role="alert"></p>',
		"</form>",
	].join("");
	const logoImg =
		d.show_logo && f.logo
			? `<img class="mr-logo" src="${esc(f.logo)}" alt="${esc(f.brand ?? "")}">`
			: "";
	const logo = t !== "split" ? logoImg : "";
	const eyebrow = d.eyebrow ? `<p class="mr-eyebrow">${esc(d.eyebrow)}</p>` : "";
	const heading = `${eyebrow}${d.show_title ? `<h2 class="mr-title">${esc(f.title)}</h2>` : ""}`;
	const head = [
		logo || heading
			? `<div class="mr-brand">${logo}${heading ? `<div class="mr-heading">${heading}</div>` : ""}</div>`
			: "",
		d.description ? `<p class="mr-desc">${esc(d.description)}</p>` : "",
	].join("");
	const meta =
		d.proof || d.fine_print
			? `<div class="mr-meta"${done ? " hidden" : ""}>${d.proof ? `<p class="mr-proof">${faces(d)}<span>${esc(d.proof)}</span></p>` : ""}${d.fine_print ? `<p class="mr-fine">${esc(d.fine_print)}</p>` : ""}</div>`
			: "";
	const success = `<div class="mr-done" role="status"${done ? "" : " hidden"}><span class="mr-check">${CHECK}</span>${d.success_title ? `<h3>${esc(d.success_title)}</h3>` : ""}<p>${esc(d.success)}</p></div>`;
	const layered = display !== "inline";
	const close = layered
		? `<button type="button" class="mr-close" aria-label="Close">${CLOSE}</button>`
		: "";
	// The pitch goes with the form once someone signs up (the banner keeps it beside the message).
	const headFor = (keep: boolean) =>
		`<div class="mr-head"${done && !keep ? " hidden" : ""}>${head}</div>`;

	let inner: string;
	if (t === "bar")
		inner = `<div class="mr-box"><div class="mr-barin">${logo}<div class="mr-text"${done ? " hidden" : ""}>${d.eyebrow ? `<span class="mr-eyebrow">${esc(d.eyebrow)}</span>` : ""}${d.show_title ? `<strong class="mr-title">${esc(f.title)}</strong>` : ""}${d.description ? `<span class="mr-desc">${esc(d.description)}</span>` : ""}</div>${form}${success}</div>${close}</div>`;
	else if (t === "split")
		inner = `<div class="mr-box"><div class="mr-split"><div class="mr-media">${logoImg}</div><div class="mr-body">${headFor(false)}${form}${meta}${success}</div></div>${close}</div>`;
	else if (t === "banner")
		inner = `<div class="mr-box"><div class="mr-body"><div class="mr-banner">${headFor(true)}<div class="mr-act">${form}${meta}${success}</div></div></div>${close}</div>`;
	else
		inner = `<div class="mr-box"><div class="mr-body">${headFor(false)}${form}${meta}${success}</div>${close}</div>`;

	return [
		fontLink(d),
		`<div id="${root}" class="mr-signup mr-${t}"${layered && !o.preview ? " hidden" : ""}>`,
		`<style>${styles(root, { ...d, template: t === "bar" ? d.template : t }, display, !!o.preview)}</style>`,
		layered ? `<div class="mr-layer">${inner}</div>` : inner,
		"</div>",
	]
		.filter(Boolean)
		.join("\n");
}

type Behavior = { trigger: FormDesign["trigger"]; value: number; days: number };

/**
 * What the form does on a page: signs up without leaving it (posting JSON; without JavaScript it
 * posts and lands on the hosted "check your inbox" page), and for popups, slide-ins and bars,
 * when it shows, closing, and not showing again for a while (or ever, once they signed up).
 */
export function behaviorScript(root: string, display: Display, b: Behavior) {
	const cfg = JSON.stringify({ root, display, ...b });
	return `(function(c){var r=document.getElementById(c.root);if(!r||r.getAttribute("data-mr"))return;r.setAttribute("data-mr","1");var f=r.querySelector("form"),e=r.querySelector(".mr-error"),b=r.querySelector(".mr-submit"),k="mr:"+c.root;function get(x){try{return localStorage.getItem(k+x)}catch(_){return null}}function put(x,v){try{localStorage.setItem(k+x,v)}catch(_){}}function hide(){r.hidden=true;put(":closed",String(Date.now()))}if(c.display!=="inline"){var shown=false;var show=function(){if(shown)return;shown=true;r.hidden=false};var cl=r.querySelector(".mr-close");if(cl)cl.addEventListener("click",hide);var ly=r.querySelector(".mr-layer");if(c.display==="popup"&&ly)ly.addEventListener("click",function(v){if(v.target===ly)hide()});document.addEventListener("keydown",function(v){if(v.key==="Escape"&&!r.hidden)hide()});var last=Number(get(":closed")||0);var wait=get(":done")||(last&&c.days>0&&Date.now()-last<c.days*864e5);if(!wait){if(c.trigger==="scroll"){var on=function(){var h=document.documentElement;var p=(h.scrollTop||document.body.scrollTop)/Math.max(1,h.scrollHeight-h.clientHeight)*100;if(p>=c.value){show();window.removeEventListener("scroll",on)}};window.addEventListener("scroll",on,{passive:true});on()}else if(c.trigger==="exit"){document.addEventListener("mouseout",function(v){if(!v.relatedTarget&&v.clientY<=0)show()});setTimeout(show,45e3)}else setTimeout(show,c.value*1e3)}}if(!f||!window.fetch)return;f.addEventListener("submit",function(v){v.preventDefault();var m=f.querySelector("input[type=email]");if(m&&!m.checkValidity()){e.textContent="Enter a valid email address.";m.focus();return}b.disabled=true;f.classList.add("mr-busy");e.textContent="";var d={};new FormData(f).forEach(function(x,n){d[n]=String(x)});fetch(f.action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)}).then(function(x){return x.json()}).then(function(j){f.classList.remove("mr-busy");if(j.ok){put(":done","1");f.hidden=true;var h=r.querySelector(".mr-head");if(h&&!r.querySelector(".mr-banner"))h.hidden=true;["mr-meta","mr-text"].forEach(function(n){var x=r.querySelector("."+n);if(x)x.hidden=true});r.querySelector(".mr-done").hidden=false}else{e.textContent=j.message||"Something went wrong. Try again.";b.disabled=false;if(window.turnstile)try{window.turnstile.reset()}catch(_){}}}).catch(function(){b.disabled=false;f.classList.remove("mr-busy");f.submit()})})})(${cfg});`;
}

const turnstileTag =
	'<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>';

const behaviorOf = (f: RenderInput, d: FormDesign) =>
	behaviorScript(`mr-${f.id}`, d.display, {
		trigger: d.trigger,
		value: d.trigger_value,
		days: d.frequency_days,
	});

/** The form as HTML to paste: markup, its script, and Turnstile's when it has a widget. */
export function embedHtml(f: RenderInput, d: FormDesign, o: { sitekey?: string | null } = {}) {
	return [
		renderMarkup(f, d, { sitekey: o.sitekey }),
		`<script>${behaviorOf(f, d)}</script>`,
		o.sitekey ? turnstileTag : "",
	]
		.filter(Boolean)
		.join("\n");
}

/**
 * The self-updating embed (/subscribe/<id>.js): puts the form where the script tag is (or over
 * the page, for popups, slide-ins and bars), so design changes reach the website without pasting
 * the code again.
 */
export function embedScript(f: RenderInput, d: FormDesign, o: { sitekey?: string | null } = {}) {
	const markup = renderMarkup(f, d, { sitekey: o.sitekey });
	const loadTurnstile = o.sitekey
		? `if(window.turnstile){var ts=document.getElementById(id).querySelector(".cf-turnstile");if(ts)try{window.turnstile.render(ts)}catch(_){}}else if(!document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')){var t=document.createElement("script");t.src="https://challenges.cloudflare.com/turnstile/v0/api.js";t.async=true;document.head.appendChild(t)}`
		: "";
	return `(function(){var s=document.currentScript;var id=${JSON.stringify(`mr-${f.id}`)};if(document.getElementById(id))return;var w=document.createElement("div");w.innerHTML=${JSON.stringify(markup)};var at=${d.display === "inline" ? "s&&s.parentNode?s:null" : "null"};[].slice.call(w.childNodes).forEach(function(x){if(at)at.parentNode.insertBefore(x,at);else document.body.appendChild(x)});${behaviorOf(f, d)}${loadTurnstile}})();`;
}

/** The script tag that loads the self-updating embed. */
export const scriptTag = (src: string) => `<script src="${esc(src)}" async></script>`;

/** The hosted page: the form centered, inline, on a page that suits its colors. */
export function hostedPage(
	f: RenderInput,
	d: FormDesign,
	o: { sitekey?: string | null; nonce?: string } = {},
) {
	const page = isDark(d.background) ? "#09090b" : "#f4f4f5";
	const inline = { ...d, display: "inline" as const };
	const markup = renderMarkup(f, inline, { sitekey: o.sitekey });
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(f.title)}</title><style>html,body{margin:0}body{min-height:100vh;min-height:100dvh;box-sizing:border-box;padding:clamp(24px,10vh,112px) 16px 48px;background:${page};display:flex;flex-direction:column;align-items:center}body>.mr-signup{max-width:${maxWidth(d)}px}</style></head><body>${markup}<script${o.nonce ? ` nonce="${o.nonce}"` : ""}>${behaviorOf(f, inline)}</script>${o.sitekey ? turnstileTag : ""}</body></html>`;
}

/**
 * The dashboard's canvas: the form on a sketch of a website, where it would sit (in the content,
 * or over the page), in the given state.
 */
export function canvasPage(
	f: RenderInput,
	d: FormDesign,
	o: RenderOptions & { site?: "light" | "dark" },
) {
	const markup = renderMarkup(f, d, o);
	const darkSite = o.site === "dark";
	const ink = darkSite ? "rgba(255,255,255,.08)" : "rgba(9,9,11,.06)";
	const inkStrong = darkSite ? "rgba(255,255,255,.15)" : "rgba(9,9,11,.11)";
	const line = (w: string, h = 10) =>
		`<i style="display:block;height:${h}px;width:${w};border-radius:99px;background:${ink}"></i>`;
	const para = (ws: string[]) =>
		`<div style="display:flex;flex-direction:column;gap:10px">${ws.map((w) => line(w)).join("")}</div>`;
	const nav = `<header class="nav" style="display:flex;align-items:center;gap:24px;height:64px;padding:0 max(24px,calc((100% - 1040px)/2));border-bottom:1px solid ${ink}"><i style="display:block;width:28px;height:28px;border-radius:8px;background:${inkStrong}"></i>${line("72px")}<span style="flex:1"></span><span class="links" style="display:flex;gap:24px">${line("56px")}${line("56px")}${line("56px")}</span><i style="display:block;width:92px;height:34px;border-radius:8px;background:${inkStrong}"></i></header>`;
	const hero = `<section style="display:flex;flex-direction:column;gap:16px;padding:44px 0 36px">${line("58%", 26)}${line("40%", 26)}<div style="height:4px"></div>${para(["72%"])}</section>`;
	const cards = `<section class="cards" style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:8px 0 48px">${[
		0, 1, 2,
	]
		.map(
			() =>
				`<div style="display:flex;flex-direction:column;gap:12px"><i style="display:block;aspect-ratio:16/10;border-radius:12px;background:${ink}"></i>${line("80%")}${line("55%")}</div>`,
		)
		.join("")}</section>`;
	const inline = (o.display ?? d.display) === "inline";
	const body = `<main style="max-width:1040px;margin:0 auto;padding:0 24px">${hero}${inline ? `<section class="mr-slot" style="padding:4px 0 56px;display:flex;justify-content:${d.align === "center" || d.template === "spotlight" ? "center" : "flex-start"}">${markup}</section>` : ""}${cards}${para(["92%", "86%", "90%", "64%"])}<div style="height:120px"></div></main>`;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}body{min-height:100vh;background:${darkSite ? "#0b0b0c" : "#ffffff"};font-family:system-ui,sans-serif}main>section>.mr-signup{max-width:${maxWidth(d)}px;transition:max-width .35s cubic-bezier(.2,.8,.2,1)}@media (max-width:600px){.cards{grid-template-columns:1fr!important}.links{display:none!important}}</style></head><body>${nav}${body}${inline ? "" : markup}</body></html>`;
}

/** A template's thumbnail: the form alone, centered, at its natural size. */
export function thumbnailPage(f: RenderInput, d: FormDesign) {
	const page = isDark(d.background) ? "#18181b" : "#f4f4f5";
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;padding:28px;box-sizing:border-box;background:${page};overflow:hidden}body>.mr-signup{max-width:${maxWidth(d)}px}</style></head><body>${renderMarkup(f, { ...d, display: "inline" }, { preview: "form", display: "inline" })}</body></html>`;
}
