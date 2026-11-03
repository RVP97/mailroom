/**
 * Emails built from blocks (the visual editor): the document, cleaning it, and turning it into
 * HTML that inboxes show alike (tables, inline styles, a 600 px column that stacks on phones).
 * Pure: the dashboard renders its preview with it and the server renders what's sent.
 */

export type Align = "left" | "center" | "right";

type Base = { id: string };
export type LeafBlock = Base &
	(
		| { type: "logo"; src: string; alt: string; width: number; align: Align; href: string }
		| { type: "heading"; html: string; level: 1 | 2 | 3; align: Align }
		| { type: "text"; html: string; align: Align }
		| {
				type: "button";
				label: string;
				url: string;
				align: Align;
				full: boolean;
				color: string | null;
		  }
		| { type: "image"; src: string; alt: string; href: string; width: number; align: Align }
		| { type: "quote"; html: string }
		| { type: "divider" }
		| { type: "spacer"; height: number }
		| { type: "social"; links: { label: string; url: string }[]; align: Align }
		| { type: "footer"; html: string; unsubscribe: string }
		| { type: "html"; html: string }
		/** One-click answers (broadcasts only): each button links to {{{POLL_URL}}}/<id>/<answer>. */
		| { type: "poll"; question: string; options: string[]; align: Align }
	);
export type ColumnsBlock = Base & {
	type: "columns";
	ratio: "1-1" | "1-2" | "2-1";
	columns: [LeafBlock[], LeafBlock[]];
};
export type Block = LeafBlock | ColumnsBlock;
export type BlockType = Block["type"];

export const FONTS = {
	modern: {
		label: "Modern sans",
		stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
	},
	inter: {
		label: "Inter",
		stack: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
		google: "Inter:wght@400;600;700",
	},
	helvetica: { label: "Helvetica", stack: "'Helvetica Neue',Helvetica,Arial,sans-serif" },
	georgia: { label: "Georgia", stack: "Georgia,'Times New Roman',Times,serif" },
	book: {
		label: "Book serif",
		stack: "'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif",
	},
	mono: { label: "Mono", stack: "'SF Mono',Menlo,Consolas,'Courier New',monospace" },
} as const;
export type FontKey = keyof typeof FONTS;

export type Theme = {
	/** Behind the email. */
	background: string;
	/** The email's own box. */
	surface: string;
	text: string;
	heading: string;
	/** Links and buttons. */
	accent: string;
	/** Text on buttons. */
	button_text: string;
	font: FontKey;
	heading_font: FontKey;
	width: number;
	/** Corners of the box, images and buttons. */
	radius: number;
	/** Room either side of the content. */
	padding: number;
	/** 15, 16 or 17 px body text. */
	size: number;
	/** A brand kit's own web font over `font` (src/lib/brand-kit.ts); null: none. */
	font_face?: FontFace | null;
	heading_face?: FontFace | null;
};

/** A web font file; inboxes without web fonts show the theme's font instead. */
export type FontFace = { family: string; url: string };

const faceStack = (face: FontFace | null | undefined, key: FontKey) =>
	face ? `'${face.family}',${FONTS[key].stack}` : FONTS[key].stack;
export const bodyStack = (t: Theme) => faceStack(t.font_face, t.font);
export const headingStack = (t: Theme) => faceStack(t.heading_face, t.heading_font);

/** The @font-face rules of a theme's web fonts (empty without any). */
export const fontFaceCss = (t: Theme) =>
	[t.font_face, t.heading_face]
		.filter((f, i, all): f is FontFace => !!f && all.findIndex((g) => g?.family === f.family) === i)
		.map(
			(f) =>
				`@font-face{font-family:'${f.family}';src:url('${f.url}') format('${/\.woff(\?|$)/i.test(f.url) ? "woff" : "woff2"}');font-display:swap}`,
		)
		.join("\n");

export type EmailDoc = { version: 1; theme: Theme; blocks: Block[] };

export const DEFAULT_THEME: Theme = {
	background: "#f4f4f5",
	surface: "#ffffff",
	text: "#3f3f46",
	heading: "#18181b",
	accent: "#18181b",
	button_text: "#ffffff",
	font: "modern",
	heading_font: "modern",
	width: 600,
	radius: 12,
	padding: 40,
	size: 16,
};

/** Placeholders the editor offers for text (filled per contact when it goes). */
export const MERGE_TAGS = [
	{ label: "First name", tag: "{{{FIRST_NAME|there}}}" },
	{ label: "Last name", tag: "{{{LAST_NAME}}}" },
	{ label: "Email", tag: "{{{EMAIL}}}" },
] as const;

/** Links Mailroom fills in broadcasts, offered for buttons and links. */
export const LINK_TAGS = [
	{ label: "Web version", tag: "{{{WEB_VERSION_URL}}}" },
	{ label: "Referral link", tag: "{{{REFERRAL_URL}}}" },
	{ label: "Referral page", tag: "{{{REFERRAL_PAGE_URL}}}" },
	{ label: "Unsubscribe", tag: "{{{UNSUBSCRIBE_URL}}}" },
] as const;

const HEX = /^#[0-9a-f]{6}$/i;
const color = (v: unknown, d: string) => {
	if (typeof v !== "string") return d;
	const s = v.trim().toLowerCase();
	if (HEX.test(s)) return s;
	if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((c) => c + c).join("")}`;
	return d;
};
const num = (v: unknown, d: number, min: number, max: number) => {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
};
const str = (v: unknown, max = 2000) => (typeof v === "string" ? v.slice(0, max) : "");
const align = (v: unknown, d: Align = "left"): Align =>
	v === "left" || v === "center" || v === "right" ? v : d;
const rid = () => `b${Math.random().toString(36).slice(2, 10)}`;
export const newId = rid;

/** An href an email may carry: web, mail, phone, a #fragment or a {{{placeholder}}}. */
export function safeUrl(v: unknown) {
	const s = str(v, 2000).trim();
	if (!s) return "";
	if (/^\{\{\{[^}]+\}\}\}$/.test(s)) return s;
	if (/^(https?:|mailto:|tel:)/i.test(s) || s.startsWith("#")) return s;
	if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
	return "";
}

const ALLOWED = new Set(["p", "br", "strong", "em", "u", "s", "a", "ul", "ol", "li"]);
const RENAME: Record<string, string> = { b: "strong", i: "em", div: "p", strike: "s", del: "s" };

/**
 * Rich text from the editor, kept to paragraphs, line breaks, bold, italic, underline, strike,
 * links and lists. Everything else goes, its text kept.
 */
export function cleanRich(html: string) {
	const src = str(html, 100_000)
		.replace(/<(script|style|head|title|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	let out = "";
	let i = 0;
	const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g;
	for (let m = tag.exec(src); m; m = tag.exec(src)) {
		out += src.slice(i, m.index).replace(/</g, "&lt;");
		i = m.index + m[0].length;
		const closing = m[1] === "/";
		const raw = (m[2] as string).toLowerCase();
		const name = RENAME[raw] ?? raw;
		if (!ALLOWED.has(name)) continue;
		if (name === "br") {
			out += "<br>";
			continue;
		}
		if (closing) {
			out += `</${name}>`;
			continue;
		}
		if (name === "a") {
			const href = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[3] ?? "");
			const url = safeUrl(decode(href?.[2] ?? href?.[3] ?? href?.[4] ?? ""));
			out += url ? `<a href="${attr(url)}">` : "<a>";
			continue;
		}
		out += `<${name}>`;
	}
	out += src.slice(i).replace(/</g, "&lt;");
	return out
		.replace(/<p>\s*(<br>)?\s*<\/p>\s*$/g, "")
		.replace(/<a>([\s\S]*?)<\/a>/g, "$1")
		.trim();
}

const decode = (s: string) =>
	s
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
export const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/&#38;#/g, "&#");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function leaf(raw: Record<string, unknown>): LeafBlock | null {
	const id = typeof raw.id === "string" && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : rid();
	switch (raw.type) {
		case "logo":
			return {
				id,
				type: "logo",
				src: safeUrl(raw.src),
				alt: str(raw.alt, 200),
				width: num(raw.width, 120, 24, 600),
				align: align(raw.align, "center"),
				href: safeUrl(raw.href),
			};
		case "heading":
			return {
				id,
				type: "heading",
				html: cleanRich(str(raw.html)),
				level: raw.level === 2 ? 2 : raw.level === 3 ? 3 : 1,
				align: align(raw.align),
			};
		case "text":
			return {
				id,
				type: "text",
				html: cleanRich(str(raw.html, 100_000)),
				align: align(raw.align),
			};
		case "button":
			return {
				id,
				type: "button",
				label: str(raw.label, 200),
				url: safeUrl(raw.url),
				align: align(raw.align),
				full: raw.full === true,
				color: raw.color ? color(raw.color, "") || null : null,
			};
		case "image":
			return {
				id,
				type: "image",
				src: safeUrl(raw.src),
				alt: str(raw.alt, 300),
				href: safeUrl(raw.href),
				width: num(raw.width, 100, 10, 100),
				align: align(raw.align, "center"),
			};
		case "quote":
			return { id, type: "quote", html: cleanRich(str(raw.html, 20_000)) };
		case "divider":
			return { id, type: "divider" };
		case "spacer":
			return { id, type: "spacer", height: num(raw.height, 24, 4, 160) };
		case "social": {
			const links = Array.isArray(raw.links) ? raw.links : [];
			return {
				id,
				type: "social",
				align: align(raw.align, "center"),
				links: links
					.slice(0, 12)
					.map((l) => ({
						label: str((l as { label?: unknown })?.label, 60),
						url: safeUrl((l as { url?: unknown })?.url),
					}))
					.filter((l) => l.label),
			};
		}
		case "footer":
			return {
				id,
				type: "footer",
				html: cleanRich(str(raw.html, 20_000)),
				unsubscribe: str(raw.unsubscribe, 80) || "Unsubscribe",
			};
		case "html":
			return { id, type: "html", html: str(raw.html, 200_000) };
		case "poll": {
			const options = (Array.isArray(raw.options) ? raw.options : [])
				.slice(0, 6)
				.map((o) => str(o, 120).trim())
				.filter(Boolean);
			return {
				id,
				type: "poll",
				question: str(raw.question, 300),
				options: options.length ? options : ["Yes", "No"],
				align: align(raw.align),
			};
		}
		default:
			return null;
	}
}

function block(raw: unknown): Block | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	if (r.type === "columns") {
		const cols = Array.isArray(r.columns) ? r.columns : [];
		const col = (c: unknown) =>
			(Array.isArray(c) ? c : [])
				.slice(0, 20)
				.map((x) =>
					x && typeof x === "object" ? leaf(x as Record<string, unknown>) : null,
				)
				.filter((x): x is LeafBlock => !!x);
		return {
			id: typeof r.id === "string" && /^[\w-]{1,40}$/.test(r.id) ? r.id : rid(),
			type: "columns",
			ratio: r.ratio === "1-2" || r.ratio === "2-1" ? r.ratio : "1-1",
			columns: [col(cols[0]), col(cols[1])],
		};
	}
	return leaf(r);
}

function face(v: unknown): FontFace | null {
	if (!v || typeof v !== "object") return null;
	const f = v as Record<string, unknown>;
	const family =
		typeof f.family === "string" ? f.family.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) : "";
	const url = typeof f.url === "string" && /^https?:\/\/[^\s"'()<>]+$/i.test(f.url) ? f.url : "";
	return family && url ? { family, url } : null;
}

/** A document as saved, cleaned: unknown blocks and fields go, values are kept in range. */
export function parseDoc(raw: unknown): EmailDoc | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as { theme?: Record<string, unknown>; blocks?: unknown };
	const t = r.theme ?? {};
	const d = DEFAULT_THEME;
	const font = (v: unknown, def: FontKey): FontKey =>
		typeof v === "string" && v in FONTS ? (v as FontKey) : def;
	const theme: Theme = {
		background: color(t.background, d.background),
		surface: color(t.surface, d.surface),
		text: color(t.text, d.text),
		heading: color(t.heading, d.heading),
		accent: color(t.accent, d.accent),
		button_text: color(t.button_text, d.button_text),
		font: font(t.font, d.font),
		heading_font: font(t.heading_font, font(t.font, d.heading_font)),
		width: num(t.width, d.width, 480, 720),
		radius: num(t.radius, d.radius, 0, 28),
		padding: num(t.padding, d.padding, 16, 64),
		size: num(t.size, d.size, 14, 18),
		font_face: face(t.font_face),
		heading_face: face(t.heading_face),
	};
	const blocks = (Array.isArray(r.blocks) ? r.blocks : [])
		.slice(0, 200)
		.map(block)
		.filter((x): x is Block => !!x);
	return { version: 1, theme, blocks };
}

/** Readable text on a color: white or near-black. */
export function onColor(hex: string) {
	const n = Number.parseInt(hex.slice(1), 16);
	const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#111111" : "#ffffff";
}

/** Rich text with each paragraph's, list's and link's look written on it, as inboxes need. */
function richHtml(html: string, t: Theme, o: { color: string; size: number; line: number }) {
	const font = bodyStack(t);
	const pStyle = `margin:0 0 ${Math.round(o.size * 0.9)}px;`;
	let s = cleanRich(html)
		.replace(/<p>/g, `<p style="${pStyle}">`)
		.replace(
			/<(ul|ol)>/g,
			`<$1 style="margin:0 0 ${Math.round(o.size * 0.9)}px;padding:0 0 0 24px;">`,
		)
		.replace(/<li>/g, `<li style="margin:0 0 6px;">`)
		.replace(/<a href=/g, `<a style="color:${t.accent};text-decoration:underline;" href=`);
	// The last paragraph or list ends the block: no room after it.
	const last = s.lastIndexOf(pStyle);
	if (last >= 0 && !/<(p|ul|ol)\b/.test(s.slice(last + pStyle.length)))
		s = `${s.slice(0, last)}margin:0;${s.slice(last + pStyle.length)}`;
	return `<div style="font-family:${font};font-size:${o.size}px;line-height:${o.line};color:${o.color};">${s || "&nbsp;"}</div>`;
}

const HEADING_SIZE = { 1: 30, 2: 24, 3: 19 } as const;

/** One block's inner HTML, without the room around it (shared by the editor's canvas). */
export function blockInner(b: Block, t: Theme, inner = t.width - t.padding * 2): string {
	const font = bodyStack(t);
	const r = t.radius;
	switch (b.type) {
		case "logo": {
			if (!b.src) return "";
			const img = `<img src="${attr(b.src)}" alt="${attr(b.alt)}" width="${Math.min(b.width, inner)}" style="display:inline-block;width:${Math.min(b.width, inner)}px;max-width:100%;height:auto;border:0;">`;
			return `<div style="text-align:${b.align};line-height:0;">${b.href ? `<a href="${attr(b.href)}">${img}</a>` : img}</div>`;
		}
		case "heading": {
			const size = HEADING_SIZE[b.level];
			return `<h${b.level} style="margin:0;font-family:${headingStack(t)};font-size:${size}px;line-height:1.25;font-weight:${b.level === 3 ? 600 : 700};letter-spacing:${b.level === 1 ? "-0.02em" : "-0.01em"};color:${t.heading};text-align:${b.align};">${
				cleanRich(b.html)
					.replace(/<\/?p>/g, (m) => (m === "</p>" ? "<br>" : ""))
					.replace(/(<br>)+$/, "") || "&nbsp;"
			}</h${b.level}>`;
		}
		case "text":
			return `<div style="text-align:${b.align};">${richHtml(b.html, t, { color: t.text, size: t.size, line: 1.65 })}</div>`;
		case "quote":
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:3px solid ${t.accent};padding:4px 0 4px 18px;">${richHtml(b.html, t, { color: t.heading, size: t.size + 2, line: 1.55 }).replace("font-family:", "font-style:italic;font-family:")}</td></tr></table>`;
		case "button": {
			const bg = b.color ?? t.accent;
			const fg = b.color ? onColor(b.color) : t.button_text;
			const label = esc(b.label || "Button");
			const rad = Math.min(r, 24);
			const a = `<a href="${attr(b.url || "#")}" style="display:${b.full ? "block" : "inline-block"};background:${bg};color:${fg};font-family:${font};font-size:${t.size}px;font-weight:600;line-height:1.2;text-decoration:none;padding:14px 26px;border-radius:${rad}px;mso-padding-alt:0;text-align:center;">${label}</a>`;
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="${b.align}" style="text-align:${b.align};"><table role="presentation" ${b.full ? 'width="100%" ' : ""}cellpadding="0" cellspacing="0" border="0" style="${b.full ? "width:100%;" : ""}display:${b.full ? "table" : "inline-table"};"><tr><td align="center" bgcolor="${bg}" style="border-radius:${rad}px;">${a}</td></tr></table></td></tr></table>`;
		}
		case "image": {
			if (!b.src)
				return `<div style="background:${t.background};border-radius:${r}px;padding:48px 16px;text-align:center;font-family:${font};font-size:13px;color:#a1a1aa;">Image</div>`;
			const w = Math.round((inner * b.width) / 100);
			const img = `<img src="${attr(b.src)}" alt="${attr(b.alt)}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;border-radius:${Math.min(r, 16)}px;${b.align === "center" ? "margin:0 auto;" : b.align === "right" ? "margin:0 0 0 auto;" : ""}">`;
			return b.href ? `<a href="${attr(b.href)}" style="display:block;">${img}</a>` : img;
		}
		case "divider":
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${mix(t.text, t.surface, 0.82)};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
		case "spacer":
			return `<div style="height:${b.height}px;line-height:${b.height}px;font-size:0;">&nbsp;</div>`;
		case "social": {
			const links = b.links.length ? b.links : [{ label: "Website", url: "" }];
			return `<div style="text-align:${b.align};font-family:${font};font-size:14px;line-height:1.6;">${links
				.map(
					(l) =>
						`<a href="${attr(l.url || "#")}" style="display:inline-block;margin:0 6px;color:${t.heading};font-weight:600;text-decoration:none;">${esc(l.label)}</a>`,
				)
				.join(
					`<span style="color:${mix(t.text, t.surface, 0.6)};">&middot;</span>`,
				)}</div>`;
		}
		case "footer": {
			const muted = mix(t.text, t.surface, 0.62);
			const body = cleanRich(b.html)
				? richHtml(b.html, { ...t, accent: muted }, { color: muted, size: 13, line: 1.6 })
				: "";
			return `<div style="text-align:center;">${body}<div style="font-family:${font};font-size:13px;line-height:1.6;color:${muted};${body ? "margin-top:10px;" : ""}"><a href="{{{UNSUBSCRIBE_URL}}}" style="color:${muted};text-decoration:underline;">${esc(b.unsubscribe)}</a></div></div>`;
		}
		case "html":
			return b.html;
		case "poll": {
			const rad = Math.min(r, 12);
			const border = mix(t.text, t.surface, 0.78);
			const q = b.question
				? `<p style="margin:0 0 14px;font-family:${headingStack(t)};font-size:${t.size + 2}px;line-height:1.4;font-weight:600;color:${t.heading};text-align:${b.align};">${esc(b.question)}</p>`
				: "";
			const opts = b.options
				.map(
					(o, i) =>
						`<tr><td style="padding:${i ? 8 : 0}px 0 0;"><a href="{{{POLL_URL}}}/${b.id}/${i}" style="display:block;border:1px solid ${border};border-radius:${rad}px;padding:12px 16px;font-family:${font};font-size:${t.size}px;line-height:1.3;font-weight:500;color:${t.heading};text-decoration:none;text-align:${b.align};">${esc(o)}</a></td></tr>`,
				)
				.join("");
			return `${q}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${opts}</table>`;
		}
		case "columns": {
			const [a, _c] = b.ratio === "1-2" ? [33, 67] : b.ratio === "2-1" ? [67, 33] : [50, 50];
			const gap = 24;
			const wa = Math.round(((inner - gap) * a) / 100);
			const wc = inner - gap - wa;
			const col = (list: LeafBlock[], w: number) =>
				list
					.map(
						(x, i) =>
							`<div style="${i ? `margin-top:${gapAbove(x)}px;` : ""}">${blockInner(x, t, w)}</div>`,
					)
					.join("");
			return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="mr-col" width="${wa}" valign="top" style="width:${wa}px;vertical-align:top;">${col(b.columns[0], wa)}</td><td class="mr-gap" width="${gap}" style="width:${gap}px;font-size:0;">&nbsp;</td><td class="mr-col" width="${wc}" valign="top" style="width:${wc}px;vertical-align:top;">${col(b.columns[1], wc)}</td></tr></table>`;
		}
	}
}

/** Room above a block (between it and the one before). */
export function gapAbove(b: Block) {
	switch (b.type) {
		case "heading":
			return b.level === 1 ? 28 : 24;
		case "spacer":
			return 0;
		case "divider":
			return 28;
		case "button":
		case "image":
		case "columns":
		case "quote":
		case "poll":
			return 24;
		case "footer":
			return 32;
		default:
			return 16;
	}
}

/** Blends a toward b (0: a, 1: b). */
export function mix(a: string, b: string, k: number) {
	const p = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
	const [x, y] = [p(a), p(b)];
	return `#${x
		.map((v, i) =>
			Math.round(v + ((y[i] as number) - v) * k)
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** The whole email. */
export function renderEmail(doc: EmailDoc, o: { title?: string } = {}) {
	const t = doc.theme;
	const fonts = [...new Set([t.font, t.heading_font])]
		.map((k) => (FONTS[k] as { google?: string }).google)
		.filter(Boolean);
	const faces = fontFaceCss(t);
	const rows = doc.blocks
		.map((b, i) => {
			const first = i === 0;
			const last = i === doc.blocks.length - 1;
			const top = first ? t.padding : gapAbove(b);
			const bottom = last ? t.padding : 0;
			const footer = b.type === "footer";
			return `<tr><td class="mr-pad" style="padding:${top}px ${t.padding}px ${bottom}px;${footer ? "" : ""}">${blockInner(b, t)}</td></tr>`;
		})
		.join("\n");
	return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(o.title ?? "")}</title>
${fonts.length ? `<link href="https://fonts.googleapis.com/css2?${fonts.map((f) => `family=${f}`).join("&")}&display=swap" rel="stylesheet">` : ""}
<style>
${faces}
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table{border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
a{color:${t.accent}}
h1,h2,h3{margin:0}
@media (max-width:${t.width + 20}px){
.mr-outer{padding:0!important}
.mr-box{border-radius:0!important}
.mr-pad{padding-left:24px!important;padding-right:24px!important}
.mr-col{display:block!important;width:100%!important}
.mr-col+.mr-gap{display:block!important;width:100%!important;height:20px!important}
}
</style>
</head>
<body style="margin:0;padding:0;background:${t.background};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${t.background}" style="background:${t.background};">
<tr><td class="mr-outer" align="center" style="padding:32px 12px;">
<table role="presentation" class="mr-box" width="${t.width}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${t.width}px;background:${t.surface};border-radius:${t.radius}px;font-family:${bodyStack(t)};">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Emails to start from. */
export function starter(
	kind: "newsletter" | "announcement" | "letter" | "blank",
	o: { logo?: string | null; name?: string } = {},
): EmailDoc {
	const id = rid;
	const logo: LeafBlock[] = o.logo
		? [
				{
					id: id(),
					type: "logo",
					src: o.logo,
					alt: o.name ?? "",
					width: 120,
					align: "center",
					href: "",
				},
			]
		: [];
	const footer: LeafBlock = {
		id: id(),
		type: "footer",
		html: `<p>You're getting this because you subscribed to ${esc(o.name ?? "our")} news.</p>`,
		unsubscribe: "Unsubscribe",
	};
	const theme = { ...DEFAULT_THEME };
	if (kind === "blank")
		return {
			version: 1,
			theme,
			blocks: [{ id: id(), type: "text", html: "", align: "left" }, footer],
		};
	if (kind === "letter")
		return {
			version: 1,
			theme: {
				...theme,
				background: "#ffffff",
				radius: 0,
				font: "georgia",
				heading_font: "georgia",
				text: "#27272a",
				size: 17,
			},
			blocks: [
				...logo.map((l) => ({ ...l, align: "left" as const, width: 96 })),
				{
					id: id(),
					type: "text",
					html: "<p>Hi {{{FIRST_NAME|there}}},</p><p>Write to your readers the way you'd write to a friend. Short paragraphs read best on a phone.</p><p>Thanks for reading,<br>The team</p>",
					align: "left",
				},
				{ ...footer, html: "" },
			],
		};
	if (kind === "announcement")
		return {
			version: 1,
			theme: { ...theme, background: "#eef2ff", accent: "#4f46e5", heading: "#1e1b4b" },
			blocks: [
				...logo,
				{
					id: id(),
					type: "image",
					src: "",
					alt: "",
					href: "",
					width: 100,
					align: "center",
				},
				{
					id: id(),
					type: "heading",
					html: "Introducing something new",
					level: 1,
					align: "center",
				},
				{
					id: id(),
					type: "text",
					html: "<p>One or two sentences on what it is and why your readers will care. Keep it short; the button does the rest.</p>",
					align: "center",
				},
				{
					id: id(),
					type: "button",
					label: "Take a look",
					url: "",
					align: "center",
					full: false,
					color: null,
				},
				{ id: id(), type: "divider" },
				footer,
			],
		};
	return {
		version: 1,
		theme,
		blocks: [
			...logo,
			{ id: id(), type: "heading", html: "This month's news", level: 1, align: "left" },
			{
				id: id(),
				type: "text",
				html: "<p>Hi {{{FIRST_NAME|there}}}, here's what happened this month.</p>",
				align: "left",
			},
			{ id: id(), type: "image", src: "", alt: "", href: "", width: 100, align: "center" },
			{ id: id(), type: "heading", html: "The main story", level: 2, align: "left" },
			{
				id: id(),
				type: "text",
				html: "<p>Tell the story in a few short paragraphs, and link to the rest.</p>",
				align: "left",
			},
			{
				id: id(),
				type: "button",
				label: "Read more",
				url: "",
				align: "left",
				full: false,
				color: null,
			},
			{ id: id(), type: "divider" },
			{
				id: id(),
				type: "columns",
				ratio: "1-1",
				columns: [
					[
						{ id: id(), type: "heading", html: "Also new", level: 3, align: "left" },
						{
							id: id(),
							type: "text",
							html: "<p>A shorter item, with a link.</p>",
							align: "left",
						},
					],
					[
						{ id: id(), type: "heading", html: "Coming up", level: 3, align: "left" },
						{
							id: id(),
							type: "text",
							html: "<p>What's next, and when.</p>",
							align: "left",
						},
					],
				],
			},
			{ id: id(), type: "divider" },
			footer,
		],
	};
}

/** A new block of a kind, as the editor adds it. */
export function newBlock(type: BlockType, o: { logo?: string | null; name?: string } = {}): Block {
	const id = rid();
	switch (type) {
		case "logo":
			return {
				id,
				type,
				src: o.logo ?? "",
				alt: o.name ?? "",
				width: 120,
				align: "center",
				href: "",
			};
		case "heading":
			return { id, type, html: "A heading", level: 2, align: "left" };
		case "text":
			return { id, type, html: "<p>Write something.</p>", align: "left" };
		case "button":
			return {
				id,
				type,
				label: "Read more",
				url: "",
				align: "left",
				full: false,
				color: null,
			};
		case "image":
			return { id, type, src: "", alt: "", href: "", width: 100, align: "center" };
		case "quote":
			return { id, type, html: "<p>A line worth repeating.</p>" };
		case "divider":
			return { id, type };
		case "spacer":
			return { id, type, height: 24 };
		case "social":
			return {
				id,
				type,
				align: "center",
				links: [
					{ label: "Instagram", url: "" },
					{ label: "LinkedIn", url: "" },
					{ label: "Website", url: "" },
				],
			};
		case "footer":
			return {
				id,
				type,
				html: `<p>You're getting this because you subscribed to ${esc(o.name ?? "our")} news.</p>`,
				unsubscribe: "Unsubscribe",
			};
		case "html":
			return { id, type, html: "<p>Your HTML</p>" };
		case "poll":
			return {
				id,
				type,
				question: "What should we write about next?",
				options: ["Travel tips", "Local events", "Special offers"],
				align: "left",
			};
		case "columns":
			return {
				id,
				type,
				ratio: "1-1",
				columns: [
					[{ id: rid(), type: "text", html: "<p>Left column.</p>", align: "left" }],
					[{ id: rid(), type: "text", html: "<p>Right column.</p>", align: "left" }],
				],
			};
	}
}

/** A copy with new ids (to duplicate a block). */
export function cloneBlock<T extends Block>(b: T): T {
	if (b.type === "columns")
		return {
			...b,
			id: rid(),
			columns: b.columns.map((c) => c.map((x) => ({ ...x, id: rid() }))),
		} as T;
	return { ...b, id: rid() };
}
