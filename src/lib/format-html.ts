/**
 * An email's HTML laid out to read, as Resend's HTML tab shows it: one element per line, children
 * indented, a tag whose attributes don't fit broken one attribute to a line, short inline content
 * kept on its parent's line, minified <style> opened up. Each line comes as coloured segments, so
 * the page highlights what it printed without parsing it twice. Only for reading: what's copied
 * and sent stays the original.
 */

export type HtmlKind = "punct" | "tag" | "attr" | "value" | "comment" | "doctype" | "text";
export type HtmlSeg = [HtmlKind, string];
export interface HtmlLine {
	depth: number;
	segs: HtmlSeg[];
}

type Attr = { name: string; value: string | null };
type El = {
	type: "el";
	name: string;
	key: string;
	attrs: Attr[];
	selfClosing: boolean;
	children: Node[];
	raw?: string;
};
type Node = El | { type: "text" | "comment" | "doctype" | "stray"; text: string };

/** Lines longer than this (counting their indent) break. */
const WIDTH = 100;

const VOID = new Set(
	"area base br col embed hr img input link meta param source track wbr".split(" "),
);
/** Elements whose content isn't HTML: kept as written (re-indented). */
const RAW = new Set(["script", "style", "textarea", "pre", "xmp"]);
const INLINE = new Set(
	"a abbr b bdi bdo br cite code data dfn em font i img kbd label mark q s samp small span strong sub sup time u var wbr".split(
		" ",
	),
);

const TOKEN =
	/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/\s*([a-zA-Z][\w:.-]*)[^>]*>|<([a-zA-Z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function parseAttrs(source: string): Attr[] {
	return [...source.matchAll(ATTR)].map((m) => ({
		name: m[1] as string,
		value: m[2] ?? null,
	}));
}

export function parseHtml(html: string): Node[] {
	const root: El = {
		type: "el",
		name: "",
		key: "",
		attrs: [],
		selfClosing: false,
		children: [],
	};
	const stack: El[] = [root];
	const top = () => stack[stack.length - 1] as El;
	const lower = html.toLowerCase();
	const re = new RegExp(TOKEN.source, "g");
	let last = 0;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		if (m.index > last) top().children.push({ type: "text", text: html.slice(last, m.index) });
		last = re.lastIndex;
		const [all, close, open, rest = ""] = m;
		if (close) {
			const key = close.toLowerCase();
			let at = stack.length - 1;
			while (at > 0 && stack[at]?.key !== key) at--;
			if (at > 0) stack.length = at;
			else top().children.push({ type: "stray", text: all });
			continue;
		}
		if (open) {
			const key = open.toLowerCase();
			const selfClosing = /\/\s*$/.test(rest);
			const el: El = {
				type: "el",
				name: open,
				key,
				attrs: parseAttrs(rest.replace(/\/\s*$/, "")),
				selfClosing,
				children: [],
			};
			top().children.push(el);
			if (RAW.has(key) && !selfClosing) {
				const end = lower.indexOf(`</${key}`, last);
				el.raw = html.slice(last, end < 0 ? html.length : end);
				const after = end < 0 ? html.length : html.indexOf(">", end) + 1 || html.length;
				re.lastIndex = last = after;
			} else if (!selfClosing && !VOID.has(key)) stack.push(el);
			continue;
		}
		top().children.push({ type: all.startsWith("<!--") ? "comment" : "doctype", text: all });
	}
	if (last < html.length) top().children.push({ type: "text", text: html.slice(last) });
	return root.children;
}

const collapse = (text: string) => text.replace(/\s+/g, " ");
const width = (segs: HtmlSeg[]) => segs.reduce((n, s) => n + s[1].length, 0);

function attrSegs(a: Attr): HtmlSeg[] {
	return a.value == null
		? [["attr", a.name]]
		: [
				["attr", a.name],
				["punct", "="],
				["value", a.value],
			];
}

function openSegs(el: El): HtmlSeg[] {
	return [
		["punct", "<"],
		["tag", el.name],
		...el.attrs.flatMap((a): HtmlSeg[] => [["text", " "], ...attrSegs(a)]),
		["punct", el.selfClosing ? " />" : ">"],
	];
}

const closeSegs = (el: El): HtmlSeg[] => [
	["punct", "</"],
	["tag", el.name],
	["punct", ">"],
];

/** Whether an element (and all it holds) reads inline, so it can share its parent's line. */
function inline(node: Node): boolean {
	if (node.type === "text") return true;
	if (node.type === "comment") return !node.text.includes("\n");
	if (node.type !== "el") return false;
	return INLINE.has(node.key) && node.children.every(inline);
}

/** A node on one line (only called for inline content). */
function flat(node: Node): HtmlSeg[] {
	if (node.type === "text") return [["text", collapse(node.text)]];
	if (node.type === "comment") return [["comment", node.text]];
	if (node.type !== "el") return [["text", node.text]];
	if (node.selfClosing || VOID.has(node.key)) return openSegs(node);
	return [...openSegs(node), ...node.children.flatMap(flat), ...closeSegs(node)];
}

/** Trims the spaces at both ends of a run of segments. */
function trim(segs: HtmlSeg[]): HtmlSeg[] {
	const out = segs.map((s): HtmlSeg => [s[0], s[1]]);
	const first = out[0];
	if (first?.[0] === "text") first[1] = first[1].trimStart();
	const end = out[out.length - 1];
	if (end?.[0] === "text") end[1] = end[1].trimEnd();
	return out.filter((s) => s[1] !== "");
}

/** Minified CSS opened up: one rule and one declaration to a line. */
function css(source: string): string[] {
	if (source.includes("\n") || /url\(|["']/.test(source)) return source.split("\n");
	const out: string[] = [];
	let depth = 0;
	let line = "";
	const push = (text: string, d: number) => {
		if (text.trim()) out.push(`${"  ".repeat(d)}${text.trim()}`);
	};
	for (const ch of source) {
		if (ch === "{") {
			push(`${line.trim()} {`, depth);
			depth++;
			line = "";
		} else if (ch === "}") {
			push(line, depth);
			depth = Math.max(0, depth - 1);
			push("}", depth);
			line = "";
		} else if (ch === ";") {
			push(`${line};`, depth);
			line = "";
		} else line += ch;
	}
	push(line, depth);
	return out;
}

/** Lines of raw content, without the indent they all share. */
function rawLines(el: El): string[] {
	const source = el.raw ?? "";
	const lines = (el.key === "style" ? css(source.trim()) : source.split("\n")).map((l) =>
		l.trimEnd(),
	);
	while (lines.length && !lines[0]?.trim()) lines.shift();
	while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
	const shared = Math.min(
		...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0),
	);
	return lines.map((l) => l.slice(Number.isFinite(shared) ? shared : 0));
}

function print(node: Node, depth: number, out: HtmlLine[]) {
	if (node.type === "text") {
		const text = collapse(node.text).trim();
		if (text) out.push({ depth, segs: [["text", text]] });
		return;
	}
	if (node.type === "comment") {
		for (const line of node.text.split("\n"))
			if (line.trim()) out.push({ depth, segs: [["comment", line.trim()]] });
		return;
	}
	if (node.type !== "el") {
		out.push({ depth, segs: [[node.type === "doctype" ? "doctype" : "text", node.text]] });
		return;
	}
	const open = openSegs(node);
	const indent = depth * 2;
	const pushOpen = () => {
		if (indent + width(open) <= WIDTH || node.attrs.length < 2) {
			out.push({ depth, segs: open });
			return;
		}
		out.push({
			depth,
			segs: [
				["punct", "<"],
				["tag", node.name],
			],
		});
		for (const a of node.attrs) out.push({ depth: depth + 1, segs: attrSegs(a) });
		out.push({ depth, segs: [["punct", node.selfClosing ? "/>" : ">"]] });
	};
	if (node.selfClosing || VOID.has(node.key)) {
		pushOpen();
		return;
	}
	if (node.raw !== undefined) {
		const lines = rawLines(node);
		if (lines.length === 0) {
			out.push({ depth, segs: [...open, ...closeSegs(node)] });
			return;
		}
		pushOpen();
		for (const line of lines) out.push({ depth: depth + 1, segs: [["text", line]] });
		out.push({ depth, segs: closeSegs(node) });
		return;
	}
	if (node.children.every(inline)) {
		const one = [...open, ...trim(node.children.flatMap(flat)), ...closeSegs(node)];
		if (indent + width(one) <= WIDTH) {
			out.push({ depth, segs: one });
			return;
		}
	}
	pushOpen();
	printChildren(node.children, depth + 1, out);
	out.push({ depth, segs: closeSegs(node) });
}

/** Block children one to a line; a run of text and inline elements between them on one line
 * (it wraps on screen rather than splitting a sentence at every <strong>). */
function printChildren(nodes: Node[], depth: number, out: HtmlLine[]) {
	let run: Node[] = [];
	const flush = () => {
		const segs = trim(run.flatMap(flat));
		if (segs.length) out.push({ depth, segs });
		run = [];
	};
	for (const node of nodes) {
		if (node.type !== "comment" && inline(node)) run.push(node);
		else {
			flush();
			print(node, depth, out);
		}
	}
	flush();
}

export function formatHtml(html: string): HtmlLine[] {
	const out: HtmlLine[] = [];
	printChildren(parseHtml(html), 0, out);
	return out;
}

/** The formatted HTML as text (two spaces per level). */
export const htmlText = (lines: HtmlLine[]) =>
	lines.map((l) => `${"  ".repeat(l.depth)}${l.segs.map((s) => s[1]).join("")}`).join("\n");
