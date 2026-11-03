/**
 * Reading a blog's feed (RSS 2.0 or Atom) for RSS-to-email, without a DOM: Workers have none for
 * XML. Pure, so the tests read fixtures with it.
 */

export type FeedItem = {
	title: string;
	link: string;
	/** Plain text, at most 400 characters. */
	summary: string;
	image: string | null;
	published: string | null;
};

const decode = (s: string) =>
	s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
		.replace(/&amp;/g, "&");

const tag = (xml: string, name: string) => {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
	return m ? decode(m[1] ?? "").trim() : "";
};

const attrOf = (el: string, name: string) => {
	const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(el);
	return m ? decode(m[2] ?? m[3] ?? "") : "";
};

/** Text without tags or runs of space. */
export function plain(html: string) {
	return html
		.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const clip = (s: string, n: number) => {
	if (s.length <= n) return s;
	const cut = s.slice(0, n);
	const at = cut.lastIndexOf(" ");
	return `${(at > n * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,.;:]+$/, "")}…`;
};

const https = (u: string) => (/^https?:\/\//i.test(u) ? u.trim() : "");

function imageIn(item: string, body: string) {
	const media = /<media:(?:content|thumbnail)\b[^>]*>/i.exec(item)?.[0];
	if (media && https(attrOf(media, "url"))) return https(attrOf(media, "url"));
	const enc = /<enclosure\b[^>]*>/i.exec(item)?.[0];
	if (enc && /^image\//i.test(attrOf(enc, "type")) && https(attrOf(enc, "url")))
		return https(attrOf(enc, "url"));
	const img = /<img\b[^>]*>/i.exec(body)?.[0];
	return img ? https(attrOf(img, "src")) || null : null;
}

/** The feed's title and items, newest first as the feed lists them (up to 20). */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
	const atom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
	const blocks =
		xml.match(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) ?? [];
	const head = xml.slice(
		0,
		Math.max(0, xml.search(atom ? /<entry\b/i : /<item\b/i)) || xml.length,
	);
	const items: FeedItem[] = [];
	for (const b of blocks.slice(0, 20)) {
		let link = "";
		if (atom) {
			const links = b.match(/<link\b[^>]*>/gi) ?? [];
			const alt =
				links.find((l) => !/rel\s*=/i.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) ??
				links[0];
			link = alt ? attrOf(alt, "href") : "";
		} else link = tag(b, "link") || (/isPermaLink="true"/i.test(b) ? tag(b, "guid") : "");
		link = https(link);
		const title = plain(tag(b, "title"));
		if (!link || !title) continue;
		const body = atom
			? tag(b, "summary") || tag(b, "content")
			: tag(b, "description") || tag(b, "content:encoded");
		const date = atom ? tag(b, "published") || tag(b, "updated") : tag(b, "pubDate");
		const t = date ? Date.parse(date) : Number.NaN;
		items.push({
			title: clip(title, 200),
			link,
			summary: clip(plain(body), 400),
			image: imageIn(b, body),
			published: Number.isNaN(t) ? null : new Date(t).toISOString(),
		});
	}
	return { title: plain(tag(head, "title")), items };
}
