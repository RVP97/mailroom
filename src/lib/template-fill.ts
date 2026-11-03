/**
 * Filling a template's {{{placeholders}}}: shared by the server (sends) and the dashboard (the
 * editor's preview).
 */

type Variable = { key: string; type: "string" | "number"; fallback_value?: string | number | null };

/** {{{KEY}}}, {{{contact.first_name}}} or {{{KEY|fallback}}}. */
const PLACEHOLDER = /\{\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|([^}]*))?\}\}\}/g;

/**
 * Fills the {{{…}}} placeholders that `values` has (or whose inline fallback, `{{{NAME|there}}}`,
 * applies). Others stay as they are: Mailroom's own (the unsubscribe link) are filled later.
 * Values go in as given, as {{{triple braces}}} mean in Mustache: escape what isn't HTML.
 */
export function fill(source: string, values: Record<string, string | number | null | undefined>) {
	return source.replace(PLACEHOLDER, (whole, key: string, inline?: string) => {
		const v = values[key];
		if (v !== undefined && v !== null && v !== "") return String(v);
		if (inline !== undefined) return inline.trim();
		return key in values ? "" : whole;
	});
}

/** The keys a piece of content uses. */
export function usedKeys(...sources: (string | null | undefined)[]) {
	const keys = new Set<string>();
	for (const s of sources)
		for (const m of (s ?? "").matchAll(PLACEHOLDER)) keys.add(m[1] as string);
	return [...keys];
}

/** A plain-text version of an HTML body, for the text part when a template has none. */
export function htmlToText(html: string) {
	return html
		.replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
			const text = String(label)
				.replace(/<[^>]+>/g, "")
				.trim();
			return !text || text === href ? href : `${text} (${href})`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, "\n\n")
		.replace(/<li[^>]*>/gi, "- ")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Sample values for a preview: each variable's fallback, else its name. */
export function previewValues(variables: Variable[]) {
	return Object.fromEntries(
		variables.map((v) => [v.key, v.fallback_value ?? (v.type === "number" ? 0 : v.key)]),
	);
}
