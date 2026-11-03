/**
 * The pre-send checklist's link check: every web link in an email, opened from here, so a typo or
 * a page that's gone shows before thousands of people click it. Placeholders ({{{…}}}) and
 * mailto:/tel: links are left out; a site that turns away robots (401, 403, 429) is a maybe.
 */

const MAX_LINKS = 40;
const TIMEOUT_MS = 6000;

export type LinkResult = {
	url: string;
	/** "ok", "broken" (4xx/5xx or unreachable), or "unsure" (it turns away checks like this). */
	state: "ok" | "broken" | "unsure";
	status: number | null;
	error?: string;
};

export function linksIn(html: string) {
	const out = new Set<string>();
	for (const m of html.matchAll(/<a\b[^>]*?\shref\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
		const href = (m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim();
		if (/^https?:\/\//i.test(href) && !/\{\{\{/.test(href)) out.add(href);
	}
	return [...out];
}

async function open(url: string, method: "HEAD" | "GET") {
	return fetch(url, {
		method,
		redirect: "follow",
		signal: AbortSignal.timeout(TIMEOUT_MS),
		headers: {
			"user-agent":
				"Mozilla/5.0 (compatible; MailroomLinkCheck/1.0; +https://github.com/RVP97/mailroom)",
			accept: "text/html,*/*;q=0.8",
		},
	});
}

async function checkOne(url: string): Promise<LinkResult> {
	try {
		let res = await open(url, "HEAD");
		// Many servers don't do HEAD: ask for the page itself.
		if (res.status === 405 || res.status === 404 || res.status === 403 || res.status >= 500) {
			res = await open(url, "GET");
			res.body?.cancel().catch(() => {});
		}
		const s = res.status;
		return {
			url,
			status: s,
			state:
				s < 400
					? "ok"
					: s === 401 || s === 403 || s === 429 || s === 999
						? "unsure"
						: "broken",
		};
	} catch (error) {
		const timeout =
			error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`);
		return {
			url,
			status: null,
			state: timeout ? "unsure" : "broken",
			error: timeout ? "It took too long to answer" : "It couldn't be reached",
		};
	}
}

/** Checks an email's links, a few at a time. */
export async function checkLinks(html: string) {
	const links = linksIn(html);
	const list = links.slice(0, MAX_LINKS);
	const out: LinkResult[] = [];
	for (let i = 0; i < list.length; i += 8)
		out.push(...(await Promise.all(list.slice(i, i + 8).map(checkOne))));
	return { checked: out, skipped: links.length - list.length };
}
