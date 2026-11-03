/**
 * Approximations of how the big inboxes change an email, for the preview pane, and a short
 * report of what in an email they handle differently. Approximations only: real inboxes also
 * rewrite CSS in ways no preview reproduces, so a test send is still the final word.
 */

export type InboxClient = "default" | "gmail" | "outlook" | "apple";

export const CLIENTS: { id: InboxClient; label: string; hint: string }[] = [
	{ id: "default", label: "As written", hint: "The email as Mailroom sends it" },
	{ id: "gmail", label: "Gmail", hint: "No web fonts; clips emails over 102 KB" },
	{
		id: "outlook",
		label: "Outlook (Windows)",
		hint: "Square corners, no web fonts, background images or SVG",
	},
	{ id: "apple", label: "Apple Mail", hint: "Shows nearly everything as written" },
];

/** Gmail cuts the HTML off past about this size and links to the rest. */
export const GMAIL_CLIP_BYTES = 102 * 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

const inject = (html: string, css: string) => {
	const tag = `<style>${css}</style>`;
	return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : `${tag}${html}`;
};

const noWebFonts = (html: string) =>
	html
		.replace(/@font-face\s*\{[^}]*\}/gi, "")
		.replace(/<link\b[^>]*fonts\.googleapis\.com[^>]*>/gi, "");

const attr = (tag: string, name: string) =>
	new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")
		.exec(tag)
		?.slice(2)
		.find((v) => v !== undefined) ?? null;

const isSvg = (src: string | null) => !!src && /(^data:image\/svg|\.svg(\?|#|$))/i.test(src);

/** Each image as the box an inbox shows with images off: its alt text, or nothing. */
const imagesOff = (html: string) =>
	html.replace(/<img\b[^>]*>/gi, (tag) => {
		const alt = attr(tag, "alt") ?? "";
		const w = Number(attr(tag, "width")) || null;
		const style = `display:inline-block;box-sizing:border-box;${w ? `width:${w}px;max-width:100%;` : ""}min-height:24px;padding:6px 8px;border:1px dashed #b4b4b4;color:#6b6b6b;font:13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;text-align:center;`;
		return `<span style="${style}">${alt.replace(/</g, "&lt;")}</span>`;
	});

const hideSvg = (html: string) =>
	html.replace(/<img\b[^>]*>/gi, (tag) => (isSvg(attr(tag, "src")) ? "" : tag));

/** Phones' dark inboxes (Gmail, Outlook) invert light colors; images stay as they are. */
const DARK_INVERT =
	"html{filter:invert(1) hue-rotate(180deg);background:#fff}img,picture,video,[style*='background-image']{filter:invert(1) hue-rotate(180deg)}";

/** The email as that inbox would roughly show it. */
export function simulate(
	html: string,
	o: { client: InboxClient; dark: boolean; images: boolean },
): string {
	let out = html;
	if (o.client === "gmail" || o.client === "outlook") out = hideSvg(noWebFonts(out));
	if (o.client === "outlook")
		out = inject(
			out,
			"*{border-radius:0!important;box-shadow:none!important;background-image:none!important}",
		);
	if (!o.images) out = imagesOff(out);
	if (o.client === "gmail" && bytes(html) > GMAIL_CLIP_BYTES) {
		// Roughly where Gmail cuts: the first 102 KB of what was sent.
		let cut = out.slice(0, GMAIL_CLIP_BYTES);
		cut = cut.replace(/<[^>]*$/, "");
		out = `${cut}<div style="padding:16px;font:13px Arial,sans-serif;color:#5f6368">[Message clipped]&nbsp;&nbsp;<u style="color:#1a73e8">View entire message</u></div>`;
	}
	// Apple Mail keeps a light email light unless it has its own dark design; the others invert.
	if (o.dark && o.client !== "apple") out = inject(out, DARK_INVERT);
	return out;
}

export type InboxNote = { level: "warn" | "info"; title: string; detail: string };

/** What in this email the big inboxes show differently. */
export function inboxNotes(html: string): InboxNote[] {
	const notes: InboxNote[] = [];
	const size = bytes(html);
	if (size > GMAIL_CLIP_BYTES)
		notes.push({
			level: "warn",
			title: `Gmail will clip it (${Math.round(size / 1024)} KB)`,
			detail: 'Past about 102 KB Gmail shows a "View entire message" link instead of the rest, unsubscribe link included. Shorten it or split it.',
		});
	else if (size > GMAIL_CLIP_BYTES * 0.85)
		notes.push({
			level: "info",
			title: `Close to Gmail's 102 KB limit (${Math.round(size / 1024)} KB)`,
			detail: "A bit more and Gmail clips it.",
		});
	const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
	const noAlt = imgs.filter((t) => attr(t, "alt") === null).length;
	if (noAlt)
		notes.push({
			level: "warn",
			title: noAlt === 1 ? "An image has no alt text" : `${noAlt} images have no alt text`,
			detail: "Many inboxes block images until the reader allows them, and screen readers read alt text. Without it, nothing shows there.",
		});
	const svgs = imgs.filter((t) => isSvg(attr(t, "src"))).length;
	if (svgs)
		notes.push({
			level: "warn",
			title: svgs === 1 ? "An SVG image" : `${svgs} SVG images`,
			detail: "Gmail and Outlook don't show SVG. Use PNG or JPEG.",
		});
	if (/@font-face/i.test(html))
		notes.push({
			level: "info",
			title: "Brand fonts show in some inboxes",
			detail: "Apple Mail, iOS Mail, Samsung Mail and Thunderbird load them. Gmail and Outlook show the fallback font.",
		});
	if (/border-radius\s*:\s*[1-9]/i.test(html))
		notes.push({
			level: "info",
			title: "Rounded corners are square in Outlook for Windows",
			detail: "Its Word-based engine ignores border-radius. Everything else rounds them.",
		});
	if (/background-image\s*:|background\s*:[^;"]*url\(/i.test(html))
		notes.push({
			level: "info",
			title: "Background images don't show in Outlook for Windows",
			detail: "Its background color shows instead, so keep text readable on that color.",
		});
	if (
		imgs.length >= 3 &&
		html
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim().length < 200
	)
		notes.push({
			level: "warn",
			title: "Mostly images, little text",
			detail: "With images off it reads as almost empty, and spam filters distrust emails that are all images.",
		});
	return notes;
}
