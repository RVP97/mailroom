import type { ReactNode } from "react";

/**
 * A small syntax highlighter for the snippets Mailroom shows (cURL, Node, Python, PHP, JSON).
 * One regex per language, read left to right; anything it doesn't know stays plain. Enough for
 * short examples, without shipping a grammar engine.
 */

export type Lang = "bash" | "js" | "python" | "php" | "json" | "text";

type Kind = "comment" | "string" | "key" | "keyword" | "number" | "fn" | "variable" | "punct";

const STRINGS = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\]|\\.)*'`;
const NUMBER = String.raw`\b\d+(?:\.\d+)?\b`;

const KEYWORDS: Record<Exclude<Lang, "text" | "json">, string> = {
	js: "import|from|export|const|let|var|await|async|function|return|new|if|else|true|false|null|undefined",
	python: "import|from|as|def|return|if|else|for|in|print|True|False|None|with",
	php: "new|return|if|else|true|false|null|use|function",
	bash: "curl",
};

/** Each pattern's groups, in order, are the kinds below. */
const RULES: Record<Exclude<Lang, "text">, [RegExp, Kind[]]> = {
	json: [
		new RegExp(
			`(${STRINGS})(?=\\s*:)|(${STRINGS})|(${NUMBER}|true|false|null)|([{}\\[\\],:])`,
			"g",
		),
		["key", "string", "number", "punct"],
	],
	js: [
		new RegExp(
			`(\\/\\/[^\\n]*)|(${STRINGS}|\`(?:[^\`\\\\]|\\\\.)*\`)(?=\\s*:)|(${STRINGS}|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b([A-Za-z_$][\\w$]*)(?=\\s*:(?!:))|\\b(${KEYWORDS.js})\\b|(${NUMBER})|\\b([A-Za-z_$][\\w$]*)(?=\\()`,
			"g",
		),
		// Object keys before keywords, so `from:` in an object reads as a key.
		["comment", "key", "string", "key", "keyword", "number", "fn"],
	],
	python: [
		new RegExp(
			`(#[^\\n]*)|(f?(?:${STRINGS}))(?=\\s*:)|(f?(?:${STRINGS}))|\\b(${KEYWORDS.python})\\b|(${NUMBER})|\\b([A-Za-z_]\\w*)(?=\\s*=(?!=))|\\b([A-Za-z_]\\w*)(?=\\()`,
			"g",
		),
		["comment", "key", "string", "keyword", "number", "variable", "fn"],
	],
	php: [
		new RegExp(
			`(\\/\\/[^\\n]*)|(${STRINGS})(?=\\s*=>)|(${STRINGS})|\\b(${KEYWORDS.php})\\b|(${NUMBER})|(\\$[A-Za-z_]\\w*)|\\b([A-Za-z_]\\w*)(?=\\()`,
			"g",
		),
		["comment", "key", "string", "keyword", "number", "variable", "fn"],
	],
	bash: [
		new RegExp(
			`((?:^|(?<=\\s))#[^\\n]*)|(${STRINGS})|^(${KEYWORDS.bash}|\\w[\\w-]*)\\b|((?<=\\s)--?[A-Za-z][\\w-]*)|(\\$[A-Za-z_]\\w*)`,
			"gm",
		),
		["comment", "string", "fn", "keyword", "variable"],
	],
};

/** The colour of each kind, on the dark code well. */
export const TOKEN: Record<Kind, string> = {
	comment: "text-white/40 italic",
	string: "text-[oklch(0.83_0.11_150)]",
	key: "text-[oklch(0.82_0.09_230)]",
	keyword: "text-[oklch(0.78_0.12_305)]",
	number: "text-[oklch(0.83_0.12_65)]",
	fn: "text-[oklch(0.86_0.1_265)]",
	variable: "text-[oklch(0.84_0.1_20)]",
	punct: "text-white/50",
};

export function highlight(code: string, lang: Lang = "text"): ReactNode[] {
	if (lang === "text") return [code];
	const [pattern, kinds] = RULES[lang];
	const out: ReactNode[] = [];
	let last = 0;
	for (const m of code.matchAll(new RegExp(pattern))) {
		const i = m.slice(1).findIndex((g) => g !== undefined);
		if (i < 0 || !m[0]) continue;
		const at = m.index + m[0].indexOf(m[i + 1] as string);
		if (at > last) out.push(code.slice(last, at));
		const text = m[i + 1] as string;
		// A JSON body in a shell command (curl -d '{…}') reads as JSON, not as one long string.
		if (lang === "bash" && kinds[i] === "string" && /^'\s*[{[]/.test(text)) {
			out.push(
				<span key={at}>
					<span className={TOKEN.string}>'</span>
					{highlight(text.slice(1, -1), "json")}
					<span className={TOKEN.string}>'</span>
				</span>,
			);
			last = at + text.length;
			continue;
		}
		out.push(
			<span
				key={at}
				className={TOKEN[kinds[i] as Kind]}
			>
				{m[i + 1]}
			</span>,
		);
		last = at + (m[i + 1] as string).length;
	}
	if (last < code.length) out.push(code.slice(last));
	return out;
}
