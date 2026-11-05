/** Emails built with the visual editor's blocks (src/lib/email-doc.ts), as the demo's team made them. */
import {
	type Block,
	DEFAULT_THEME,
	type EmailDoc,
	type LeafBlock,
	renderEmail,
	type Theme,
} from "@/lib/email-doc";

let n = 0;
const id = () => `blk_${(++n).toString(36)}`;

/** Where the demo's images are: next to the demo (demo/public/media), on the site (emails take
 * only absolute image URLs). */
export const MEDIA = `${process.env.DEMO_ORIGIN ?? "https://rvp97.github.io"}${(process.env.DEMO_BASE ?? "/mailroom/demo/").replace(/\/?$/, "/")}media`;
export const LOGO = `${MEDIA}/acme-logo.svg`;
export const JOURNAL_LOGO = `${MEDIA}/journal-logo.svg`;
export const SITE = "https://acme.example";

export const ACME: Theme = {
	...DEFAULT_THEME,
	background: "#f4f4f5",
	accent: "#4f46e5",
	heading: "#18181b",
	text: "#3f3f46",
	font: "inter",
	heading_font: "inter",
	radius: 12,
};

export const JOURNAL: Theme = {
	...DEFAULT_THEME,
	background: "#faf7f2",
	surface: "#ffffff",
	accent: "#b45309",
	heading: "#1c1917",
	text: "#292524",
	font: "georgia",
	heading_font: "book",
	radius: 4,
	size: 17,
};

export const logo = (src = LOGO, align: "left" | "center" = "left", width = 112): LeafBlock => ({
	id: id(),
	type: "logo",
	src,
	alt: "Acme",
	width,
	align,
	href: SITE,
});
export const h = (
	html: string,
	level: 1 | 2 | 3 = 1,
	align: "left" | "center" = "left",
): LeafBlock => ({
	id: id(),
	type: "heading",
	html,
	level,
	align,
});
export const p = (html: string, align: "left" | "center" = "left"): LeafBlock => ({
	id: id(),
	type: "text",
	html: html.startsWith("<") ? html : `<p>${html}</p>`,
	align,
});
export const button = (
	label: string,
	url: string,
	o: { align?: "left" | "center"; full?: boolean } = {},
): LeafBlock => ({
	id: id(),
	type: "button",
	label,
	url,
	align: o.align ?? "left",
	full: o.full ?? false,
	color: null,
});
export const image = (src: string, alt: string, href = ""): LeafBlock => ({
	id: id(),
	type: "image",
	src,
	alt,
	href,
	width: 100,
	align: "center",
});
export const divider = (): LeafBlock => ({ id: id(), type: "divider" });
export const spacer = (height = 16): LeafBlock => ({ id: id(), type: "spacer", height });
export const quote = (html: string): LeafBlock => ({
	id: id(),
	type: "quote",
	html: `<p>${html}</p>`,
});
export const social = (): LeafBlock => ({
	id: id(),
	type: "social",
	align: "center",
	links: [
		{ label: "LinkedIn", url: "https://www.linkedin.com/" },
		{ label: "YouTube", url: "https://www.youtube.com/" },
		{ label: "Website", url: SITE },
	],
});
export const footer = (html: string, unsubscribe = "Unsubscribe"): LeafBlock => ({
	id: id(),
	type: "footer",
	html: `<p>${html}</p>`,
	unsubscribe,
});
export const poll = (question: string, options: string[]): LeafBlock => ({
	id: id(),
	type: "poll",
	question,
	options,
	align: "left",
});
export const columns = (
	left: LeafBlock[],
	right: LeafBlock[],
	ratio: "1-1" | "1-2" | "2-1" = "1-1",
): Block => ({
	id: id(),
	type: "columns",
	ratio,
	columns: [left, right],
});

export const doc = (theme: Theme, blocks: Block[]): EmailDoc => ({ version: 1, theme, blocks });
export const html = (d: EmailDoc, title?: string) => renderEmail(d, { title });

/** The footer every transactional email has. */
export const appFooter = () =>
	footer(
		"Acme Inc. · 548 Market St, San Francisco, CA 94104<br>You're getting this because you have an Acme account.",
		"",
	);
