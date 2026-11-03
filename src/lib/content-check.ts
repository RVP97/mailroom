/**
 * Checks on an email's content before it goes, for what makes inboxes file mail as spam or cut it
 * short: shared by the dashboard's editors and the API (POST /emails/check). Each finding is a
 * warning (worth fixing) or a note (worth knowing); none stops a send.
 */

export interface ContentFinding {
	level: "warning" | "note";
	code: string;
	message: string;
}

export interface ContentInput {
	subject: string;
	html?: string | null;
	text?: string | null;
	/** Newsletters and broadcasts: they need an unsubscribe link. */
	marketing?: boolean;
}

/** Gmail cuts an email's HTML past this ("[Message clipped]"). */
const GMAIL_CLIP = 102 * 1024;

const SHORTENERS =
	/https?:\/\/(?:www\.)?(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|shorturl\.at)\//i;

/** Words spam filters weigh, in English and Spanish. */
const SPAMMY =
	/\b(100% free|act now|buy now|cash bonus|click here|earn \$|free money|guaranteed|no cost|risk[- ]free|winner|you have been selected|urgent|gratis total|gane dinero|haga clic aquí|dinero fácil|ganador)\b/i;

const UNSUBSCRIBE =
	/\{\{\{\s*(?:UNSUBSCRIBE_URL|RESEND_UNSUBSCRIBE_URL|MAILROOM_UNSUBSCRIBE_URL)\s*\}\}\}|unsubscribe|darse de baja|darme de baja/i;

export function checkContent(c: ContentInput): ContentFinding[] {
	const out: ContentFinding[] = [];
	const add = (level: ContentFinding["level"], code: string, message: string) =>
		out.push({ level, code, message });
	const subject = c.subject.trim();
	const html = c.html ?? "";
	const text = c.text ?? "";

	if (!subject) add("warning", "no_subject", "It has no subject.");
	else {
		const letters = subject.replace(/[^A-Za-zÀ-ÿ]/g, "");
		if (letters.length >= 8 && letters === letters.toUpperCase())
			add("warning", "caps_subject", "The subject is all capitals, which reads as spam.");
		if (/[!?]{2,}/.test(subject) || /\$\$|€€/.test(subject))
			add("warning", "loud_subject", "The subject repeats ! ? or $; spam filters weigh it.");
		if (subject.length > 90)
			add("note", "long_subject", "The subject is long: phones show about 40 characters.");
	}
	if (SPAMMY.test(`${subject} ${html} ${text}`))
		add(
			"note",
			"spammy_words",
			"It uses words spam filters weigh (like “click here” or “guaranteed”).",
		);

	if (html) {
		const bytes = new TextEncoder().encode(html).byteLength;
		if (bytes > GMAIL_CLIP)
			add(
				"warning",
				"gmail_clip",
				`The HTML is ${Math.round(bytes / 1024)} KB: Gmail cuts it past 102 KB, hiding the end (and the unsubscribe link).`,
			);
		const visible = html
			.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&[a-z#0-9]+;/gi, " ")
			.replace(/\s+/g, " ")
			.trim();
		const images = html.match(/<img\b[^>]*>/gi) ?? [];
		if (images.length && visible.length < 80)
			add(
				"warning",
				"image_only",
				"It's almost all images: filters distrust it, and with images off people see nothing.",
			);
		const noAlt = images.filter((i) => !/\balt\s*=\s*["'][^"']+["']/i.test(i)).length;
		if (noAlt)
			add("note", "img_alt", `${noAlt} image${noAlt === 1 ? " has" : "s have"} no alt text.`);
		if (SHORTENERS.test(html))
			add(
				"warning",
				"shortener",
				"It links through a URL shortener, which filters distrust.",
			);
		if (/href\s*=\s*["']http:\/\//i.test(html))
			add("note", "http_links", "Some links use http:// instead of https://.");
		const links = (html.match(/<a\b[^>]*href/gi) ?? []).length;
		if (links > 30)
			add("note", "many_links", `It has ${links} links; fewer reads less like spam.`);
		if (/<script\b/i.test(html) || /<form\b/i.test(html))
			add(
				"warning",
				"script_form",
				"Inboxes strip scripts and forms, and filters distrust them.",
			);
	}
	if (!html && !text) add("warning", "no_content", "It has no content.");

	if (c.marketing && !UNSUBSCRIBE.test(`${html} ${text}`))
		add(
			"note",
			"no_unsubscribe_link",
			"There's no unsubscribe link in the body; Mailroom adds one at the bottom (and the List-Unsubscribe header).",
		);
	return out;
}
