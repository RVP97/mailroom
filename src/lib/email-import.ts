import {
	type Align,
	type Block,
	cleanRich,
	DEFAULT_THEME,
	type EmailDoc,
	newId,
	safeUrl,
	type Theme,
} from "./email-doc";

/**
 * Converts pasted MJML or standard email HTML into editable Mailroom EmailDoc blocks.
 * Pure & dependency-free so it runs in both the browser builder and server/CLI tools.
 */

function attrVal(attrs: string, name: string): string {
	const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
	return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function alignOf(attrs: string): Align {
	const v = attrVal(attrs, "align").toLowerCase();
	if (v === "center" || v === "right" || v === "left") return v;
	const style = attrVal(attrs, "style").toLowerCase();
	if (style.includes("text-align:center") || style.includes("text-align: center"))
		return "center";
	if (style.includes("text-align:right") || style.includes("text-align: right")) return "right";
	return "left";
}

function hexOf(s: string): string | null {
	const m = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(s);
	if (!m) return null;
	const h = m[1] as string;
	return h.length === 3 ? `#${[...h].map((c) => c + c).join("")}` : `#${h.toLowerCase()}`;
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse MJML tags (<mj-text>, <mj-button>, <mj-image>, <mj-divider>, <mj-spacer>). */
function parseMjml(source: string): Block[] {
	const blocks: Block[] = [];
	const tagRe =
		/<(mj-text|mj-button|mj-image|mj-divider|mj-spacer)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
	for (let m = tagRe.exec(source); m; m = tagRe.exec(source)) {
		const tag = (m[1] as string).toLowerCase();
		const attrs = m[2] ?? "";
		const inner = (m[3] ?? "").trim();
		const bg = hexOf(attrVal(attrs, "container-background-color"));
		if (tag === "mj-divider") {
			blocks.push({ id: newId(), type: "divider", ...(bg ? { bg } : {}) });
		} else if (tag === "mj-spacer") {
			const h = Number.parseInt(attrVal(attrs, "height"), 10);
			blocks.push({
				id: newId(),
				type: "spacer",
				height: Number.isFinite(h) ? Math.min(160, Math.max(4, h)) : 24,
			});
		} else if (tag === "mj-image") {
			const src = safeUrl(attrVal(attrs, "src"));
			if (!src) continue;
			blocks.push({
				id: newId(),
				type: "image",
				src,
				alt: attrVal(attrs, "alt"),
				href: safeUrl(attrVal(attrs, "href")),
				width: 100,
				align: alignOf(attrs),
				...(bg ? { bg } : {}),
			});
		} else if (tag === "mj-button") {
			const label = stripTags(inner) || "Read more";
			blocks.push({
				id: newId(),
				type: "button",
				label: label.slice(0, 200),
				url: safeUrl(attrVal(attrs, "href")),
				align: alignOf(attrs),
				full: attrVal(attrs, "width") === "100%",
				color: hexOf(attrVal(attrs, "background-color")),
				...(bg ? { bg } : {}),
			});
		} else if (tag === "mj-text") {
			const headingMatch = /^\s*<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>\s*$/i.exec(inner);
			if (headingMatch) {
				blocks.push({
					id: newId(),
					type: "heading",
					level: Number(headingMatch[1]) as 1 | 2 | 3,
					html: cleanRich(headingMatch[2] ?? ""),
					align: alignOf(attrs),
					...(bg ? { bg } : {}),
				});
			} else if (inner) {
				const cleaned = cleanRich(inner);
				if (cleaned) {
					blocks.push({
						id: newId(),
						type: "text",
						html: /<(p|ul|ol)\b/i.test(cleaned) ? cleaned : `<p>${cleaned}</p>`,
						align: alignOf(attrs),
						...(bg ? { bg } : {}),
					});
				}
			}
		}
	}
	return blocks;
}

/** Parse standard HTML email markup into Mailroom blocks. */
function parseHtmlToBlocks(source: string): Block[] {
	const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source);
	const cleanedSource = (bodyMatch?.[1] ?? source)
		.replace(/<(script|style|head|title|noscript)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");

	const blocks: Block[] = [];
	const re =
		/<(hr|img)\b([^>]*?)\/?>|<(h[1-3]|p|blockquote|ul|ol|a)\b([^>]*?)>([\s\S]*?)<\/\3>/gi;

	for (let m = re.exec(cleanedSource); m; m = re.exec(cleanedSource)) {
		const tag = ((m[1] ?? m[3]) as string).toLowerCase();
		const attrs = m[2] ?? m[4] ?? "";
		const inner = (m[5] ?? "").trim();

		if (tag === "hr") {
			blocks.push({ id: newId(), type: "divider" });
		} else if (tag === "img") {
			const src = safeUrl(attrVal(attrs, "src"));
			if (!src || /pixel|track|open\.gif|1x1/i.test(src)) continue;
			blocks.push({
				id: newId(),
				type: "image",
				src,
				alt: attrVal(attrs, "alt"),
				href: "",
				width: 100,
				align: alignOf(attrs),
			});
		} else if (tag === "h1" || tag === "h2" || tag === "h3") {
			const html = cleanRich(inner);
			if (!html) continue;
			blocks.push({
				id: newId(),
				type: "heading",
				level: Number(tag[1]) as 1 | 2 | 3,
				html,
				align: alignOf(attrs),
			});
		} else if (tag === "blockquote") {
			const html = cleanRich(inner);
			if (html) blocks.push({ id: newId(), type: "quote", html: `<p>${html}</p>` });
		} else if (tag === "ul" || tag === "ol") {
			const html = cleanRich(`<${tag}>${inner}</${tag}>`);
			if (html) blocks.push({ id: newId(), type: "text", html, align: "left" });
		} else if (tag === "a") {
			const style = attrVal(attrs, "style").toLowerCase();
			// Treat styled button links as native Mailroom buttons
			if (
				style.includes("background") ||
				style.includes("padding") ||
				/btn|button|cta/i.test(attrVal(attrs, "class"))
			) {
				const label = stripTags(inner);
				const url = safeUrl(attrVal(attrs, "href"));
				if (label && url) {
					blocks.push({
						id: newId(),
						type: "button",
						label: label.slice(0, 200),
						url,
						align: alignOf(attrs),
						full: false,
						color: hexOf(style),
					});
				}
			}
		} else if (tag === "p") {
			// Check if paragraph only wraps a single button-like anchor
			const singleBtn = /^\s*<a\b([^>]*)>([\s\S]*?)<\/a>\s*$/i.exec(inner);
			if (singleBtn) {
				const aStyle = attrVal(singleBtn[1] ?? "", "style").toLowerCase();
				if (aStyle.includes("background") && aStyle.includes("padding")) {
					const label = stripTags(singleBtn[2] ?? "");
					const url = safeUrl(attrVal(singleBtn[1] ?? "", "href"));
					if (label && url) {
						blocks.push({
							id: newId(),
							type: "button",
							label: label.slice(0, 200),
							url,
							align: alignOf(attrs),
							full: false,
							color: hexOf(aStyle),
						});
						continue;
					}
				}
			}
			const html = cleanRich(inner);
			if (html) {
				blocks.push({
					id: newId(),
					type: "text",
					html: `<p>${html}</p>`,
					align: alignOf(attrs),
				});
			}
		}
	}

	return blocks;
}

/**
 * Import MJML or HTML into a clean EmailDoc. Falls back to a single raw HTML block
 * if the markup uses exotic layout structures with no recognized elements.
 */
export function importMarkupToEmailDoc(
	markup: string,
	baseTheme: Theme = DEFAULT_THEME,
): { doc: EmailDoc; format: "mjml" | "html"; count: number } {
	const isMjml = /<mj-(?:body|section|column|text|button|image|divider|spacer)\b/i.test(markup);
	const parsed = isMjml ? parseMjml(markup) : parseHtmlToBlocks(markup);
	const blocks: Block[] = parsed.length
		? parsed
		: markup.trim()
			? [{ id: newId(), type: "html", html: markup.trim().slice(0, 200_000) }]
			: [];
	return {
		doc: { version: 1, theme: baseTheme, blocks },
		format: isMjml ? "mjml" : "html",
		count: blocks.length,
	};
}
