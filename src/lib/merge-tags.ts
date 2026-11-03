/**
 * Variables ({{{FIRST_NAME|there}}}) as the editors show them: chips with a plain name, which
 * keep the tag itself (key and fallback) in their data. The stored text never changes shape.
 */

/** {{{KEY}}} or {{{KEY|fallback}}}, as src/lib/template-fill.ts fills them. */
export const TAG = /\{\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(?:\|([^}]*))?\}\}\}/g;

export type Variable = { key: string; label: string; fallback?: string; hint?: string };
export type VariableGroup = { label: string; items: Variable[] };

export const CONTACT_VARIABLES: Variable[] = [
	{ key: "FIRST_NAME", label: "First name", fallback: "there", hint: "Ana" },
	{ key: "LAST_NAME", label: "Last name", hint: "García" },
	{ key: "EMAIL", label: "Email", hint: "ana@example.com" },
];

/** What a preview shows for each variable: Ana's values, else the fallback, else the name. */
export const SAMPLE_VALUES: Record<string, string> = {
	FIRST_NAME: "Ana",
	LAST_NAME: "García",
	EMAIL: "ana@example.com",
	UNSUBSCRIBE_URL: "#",
	WEB_VERSION_URL: "#",
	REFERRAL_URL: "#",
	REFERRAL_PAGE_URL: "#",
	REFERRAL_COUNT: "3",
	POLL_URL: "#poll",
	"contact.first_name": "Ana",
	"contact.last_name": "García",
	"contact.email": "ana@example.com",
};

export function sampleFill(source: string, values: Record<string, string> = SAMPLE_VALUES) {
	return source.replace(TAG, (_, key: string, fb?: string) => {
		const v = values[key];
		if (v !== undefined) return v;
		return fb?.trim() || labelOf(key);
	});
}

const KNOWN: Record<string, string> = {
	FIRST_NAME: "First name",
	LAST_NAME: "Last name",
	EMAIL: "Email",
	UNSUBSCRIBE_URL: "Unsubscribe link",
	WEB_VERSION_URL: "Web version link",
	REFERRAL_URL: "Referral link",
	REFERRAL_PAGE_URL: "Referral page",
	REFERRAL_COUNT: "Referrals",
	POLL_URL: "Poll link",
	"contact.email": "Email",
	"contact.first_name": "First name",
	"contact.last_name": "Last name",
};

const words = (s: string) => {
	const w = s.replace(/[_.]+/g, " ").trim().toLowerCase();
	return w.charAt(0).toUpperCase() + w.slice(1);
};

/** A variable's name for people: First name, City, Event room… */
export function labelOf(key: string, groups?: VariableGroup[]) {
	for (const g of groups ?? []) {
		const v = g.items.find((x) => x.key === key);
		if (v) return v.label;
	}
	if (KNOWN[key]) return KNOWN[key];
	if (key.startsWith("contact.")) return words(key.slice(8));
	if (key.startsWith("event.")) return `Event ${words(key.slice(6)).toLowerCase()}`;
	return words(key);
}

/** The tag for a key (a fallback can't hold braces). */
export const tagOf = (key: string, fallback?: string | null) => {
	const f = (fallback ?? "").replace(/[{}]/g, "").trim();
	return `{{{${key}${f ? `|${f}` : ""}}}}`;
};

/** The groups an editor offers: the contact's, their properties, and any of its own. */
export function contactGroups(properties: string[] = [], own?: VariableGroup): VariableGroup[] {
	return [
		...(own?.items.length ? [own] : []),
		{
			label: "Contact",
			items: [
				...CONTACT_VARIABLES,
				...properties.map((k) => ({ key: `contact.${k}`, label: words(k) })),
			],
		},
	];
}

// ── In the DOM ──────────────────────────────────────────────────────────────

export const CHIP = "mt-chip";

/** A chip: not editable inside, its tag in its data. */
export function chipNode(doc: Document, key: string, fallback: string | undefined, label: string) {
	const el = doc.createElement("span");
	el.className = CHIP;
	el.contentEditable = "false";
	el.dataset.key = key;
	if (fallback) el.dataset.fallback = fallback;
	el.textContent = label;
	el.title = fallback ? `${label}, or “${fallback}” when missing` : label;
	return el;
}

/** Text with its tags as chips (for a single-line field). */
export function textNodes(doc: Document, text: string, groups?: VariableGroup[]) {
	const out: Node[] = [];
	let i = 0;
	for (const m of text.matchAll(TAG)) {
		if (m.index > i) out.push(doc.createTextNode(text.slice(i, m.index)));
		const key = m[1] as string;
		out.push(chipNode(doc, key, m[2]?.trim() || undefined, labelOf(key, groups)));
		i = m.index + m[0].length;
	}
	if (i < text.length) out.push(doc.createTextNode(text.slice(i)));
	return out;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");

/** HTML with the tags in its text (not inside its tags' attributes) as chips. */
export function chipsHtml(html: string, groups?: VariableGroup[]) {
	return html
		.split(/(<[^>]*>)/)
		.map((part) =>
			part.startsWith("<")
				? part
				: part.replace(TAG, (_, key: string, fb?: string) => {
						const f = fb?.trim();
						const label = labelOf(key, groups);
						return `<span class="${CHIP}" contenteditable="false" data-key="${escAttr(key)}"${f ? ` data-fallback="${escAttr(f)}"` : ""} title="${escAttr(f ? `${label}, or “${f}” when missing` : label)}">${escText(label)}</span>`;
					}),
		)
		.join("");
}

const tagOfChip = (el: HTMLElement) => tagOf(el.dataset.key ?? "", el.dataset.fallback);

/** An editable element's HTML, its chips back as tags. */
export function htmlWithTags(el: HTMLElement) {
	const copy = el.cloneNode(true) as HTMLElement;
	for (const c of copy.querySelectorAll<HTMLElement>(`.${CHIP}`))
		c.replaceWith(copy.ownerDocument.createTextNode(tagOfChip(c)));
	return copy.innerHTML;
}

/** A single-line field's text, its chips back as tags. */
export function textWithTags(el: Node): string {
	let s = "";
	for (const n of el.childNodes) {
		if (n.nodeType === 3) s += n.nodeValue ?? "";
		else if (n instanceof HTMLElement && n.classList.contains(CHIP)) s += tagOfChip(n);
		else if (n instanceof HTMLElement && n.tagName === "BR") continue;
		else s += textWithTags(n);
	}
	return s.replace(/ /g, " ").replace(/​/g, "");
}
