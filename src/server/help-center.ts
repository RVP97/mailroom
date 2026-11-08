import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { type EmailDoc, parseDoc, renderEmail } from "../lib/email-doc";
import { esc } from "../lib/signup-form-render";
import { htmlToText } from "../lib/template-fill";
import { db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { dressBar, dressCss, dressFonts, dressOf, dressPage, slugify } from "./newsletters";
import { publicUrl, shownHere } from "./public-host";
import { iso } from "./time";

/**
 * Each brand's help center: articles written in the email editor, on the same public host as its
 * newsletters (/help/<slug>). The website chat suggests them before a person answers, saved
 * replies link to them, agent credentials read them, and questions nobody's article answered are
 * kept (help_gaps) for the inbox report.
 */

const hc = schema.helpCenters;
const ha = schema.helpArticles;
export type HelpArticle = typeof ha.$inferSelect;
export type HelpCenter = typeof hc.$inferSelect;

// ── The help center ─────────────────────────────────────────────────────────

const slugText = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/, "slug: lowercase letters, numbers and dashes");

export const helpCenterInput = z.object({
	title: z.string().trim().min(1).max(80).optional(),
	intro: z.string().trim().max(300).nullish(),
	slug: slugText.optional(),
	enabled: z.boolean().optional(),
	accent: z
		.string()
		.trim()
		.regex(/^#[0-9a-fA-F]{6}$/, "accent: a color like #2563eb")
		.nullish(),
});

export const helpUrl = (slug: string) => `${publicUrl()}/help/${slug}`;

export const helpCenterView = (c: HelpCenter | null) =>
	c
		? {
				object: "help_center",
				brand_id: c.organization_id,
				title: c.title,
				intro: c.intro,
				slug: c.slug,
				enabled: c.enabled,
				accent: c.accent,
				url: helpUrl(c.slug),
				updated_at: c.updated_at,
			}
		: null;

export async function helpCenterOf(brand: string) {
	return (await db.select().from(hc).where(eq(hc.organization_id, brand)).get()) ?? null;
}

async function freeSlug(base: string) {
	for (let i = 0; i < 50; i++) {
		const s = i ? `${base}-${i + 1}` : base;
		const taken = await db
			.select({ id: hc.organization_id })
			.from(hc)
			.where(eq(hc.slug, s))
			.get();
		if (!taken) return s;
	}
	return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/** Turns it on (made the first time, named after the brand) or changes it. */
export async function saveHelpCenter(
	brand: string,
	raw: unknown,
	by: string | null = null,
	now = Date.now(),
) {
	const v = helpCenterInput.parse(raw ?? {});
	const was = await helpCenterOf(brand);
	if (v.slug && v.slug !== was?.slug) {
		const taken = await db
			.select({ id: hc.organization_id })
			.from(hc)
			.where(eq(hc.slug, v.slug))
			.get();
		if (taken) throw new ApiError(409, "slug_taken", `/help/${v.slug} is taken; pick another`);
	}
	if (was) {
		const [row] = await db
			.update(hc)
			.set({
				...(v.title !== undefined ? { title: v.title } : {}),
				...(v.intro !== undefined ? { intro: v.intro || null } : {}),
				...(v.slug !== undefined ? { slug: v.slug } : {}),
				...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
				...(v.accent !== undefined ? { accent: v.accent || null } : {}),
				updated_by: by,
				updated_at: iso(now),
			})
			.where(eq(hc.organization_id, brand))
			.returning();
		return row as HelpCenter;
	}
	const org = await db
		.select({ name: schema.organization.name })
		.from(schema.organization)
		.where(eq(schema.organization.id, brand))
		.get();
	const name = org?.name ?? "Help";
	const [row] = await db
		.insert(hc)
		.values({
			organization_id: brand,
			slug: v.slug ?? (await freeSlug(slugify(name, 40))),
			title: v.title ?? `${name} help center`,
			intro: v.intro || null,
			enabled: v.enabled ?? true,
			accent: v.accent || null,
			updated_by: by,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as HelpCenter;
}

// ── Articles ────────────────────────────────────────────────────────────────

export const articleInput = z.object({
	title: z.string().trim().min(1, "title: give it a title").max(160),
	description: z.string().trim().max(300).nullish(),
	category: z.string().trim().max(60).nullish(),
	slug: slugText.optional(),
	/** From the editor (the email builder), or HTML. */
	design: z.unknown().nullish(),
	html: z.string().max(500_000).optional(),
	status: z.enum(["draft", "published"]).optional(),
});

export function articleUrl(c: Pick<HelpCenter, "slug"> | null, a: Pick<HelpArticle, "slug">) {
	return c ? `${helpUrl(c.slug)}/${a.slug}` : null;
}

export const articleView = (a: HelpArticle, c: HelpCenter | null, full = true) => ({
	object: "help_article",
	id: a.id,
	brand_id: a.organization_id,
	title: a.title,
	description: a.description,
	category: a.category,
	slug: a.slug,
	status: a.status as "draft" | "published",
	url: a.status === "published" && c?.enabled ? articleUrl(c, a) : null,
	views: a.views,
	helpful: a.helpful,
	unhelpful: a.unhelpful,
	published_at: a.published_at,
	created_at: a.created_at,
	updated_at: a.updated_at,
	...(full ? { design: a.design ?? null, html: a.html, text: a.text } : {}),
});

export async function listArticles(
	brands: string[],
	o: { status?: "draft" | "published"; category?: string; q?: string } = {},
) {
	if (!brands.length) return [];
	const rows = await db
		.select()
		.from(ha)
		.where(
			and(
				inArray(ha.organization_id, brands),
				o.status ? eq(ha.status, o.status) : undefined,
				o.category ? eq(ha.category, o.category) : undefined,
			),
		)
		.orderBy(asc(ha.category), asc(ha.title));
	return o.q ? rank(rows, o.q).map((r) => r.a) : rows;
}

export async function getArticle(brands: string | string[], ref: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	if (!list.length) throw notFound("Article not found");
	const a = await db
		.select()
		.from(ha)
		.where(
			and(inArray(ha.organization_id, list), sql`(${ha.id} = ${ref} or ${ha.slug} = ${ref})`),
		)
		.get();
	if (!a) throw notFound("Article not found");
	return a;
}

/** Its HTML and words, from the editor's design or HTML. */
function contentOf(v: z.infer<typeof articleInput>, was?: HelpArticle) {
	let design: EmailDoc | null = was?.design ?? null;
	let html = was?.html ?? "";
	if (v.design !== undefined) {
		design = v.design === null ? null : parseDoc(v.design);
		if (v.design !== null && !design) throw validation("design: not a design from the editor");
		if (design)
			html = renderEmail({
				...design,
				blocks: design.blocks.filter((b) => b.type !== "footer"),
			});
	}
	if (v.html !== undefined && v.design === undefined) {
		html = v.html;
		design = null;
	}
	// An article has no reader to fill an email's {{{tags}}} with: they're left out.
	html = html.replace(/\{\{\{?[^{}]*\}?\}\}/g, "");
	return { design, html, text: htmlToText(html).replace(/\s+/g, " ").trim().slice(0, 20_000) };
}

async function freeArticleSlug(brand: string, base: string, self?: string) {
	for (let i = 0; i < 50; i++) {
		const s = i ? `${base}-${i + 1}` : base;
		const taken = await db
			.select({ id: ha.id })
			.from(ha)
			.where(and(eq(ha.organization_id, brand), eq(ha.slug, s)))
			.get();
		if (!taken || taken.id === self) return s;
	}
	return `${base}-${crypto.randomUUID().slice(0, 6)}`;
}

export async function createArticle(
	brand: string,
	raw: unknown,
	by: string | null = null,
	now = Date.now(),
) {
	const v = articleInput.parse(raw);
	const c = contentOf(v);
	const status = v.status ?? "draft";
	const [row] = await db
		.insert(ha)
		.values({
			id: `art_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: brand,
			slug: await freeArticleSlug(brand, v.slug ?? slugify(v.title, 60)),
			title: v.title,
			description: v.description || null,
			category: v.category || null,
			...c,
			status,
			published_at: status === "published" ? iso(now) : null,
			created_by: by,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	// The first article makes the help center (it can be renamed or turned off).
	if (!(await helpCenterOf(brand))) await saveHelpCenter(brand, {}, by, now);
	return row as HelpArticle;
}

export async function updateArticle(brand: string, ref: string, raw: unknown, now = Date.now()) {
	const was = await getArticle(brand, ref);
	const v = articleInput.partial().parse(raw ?? {});
	const c =
		v.design !== undefined || v.html !== undefined
			? contentOf({ title: was.title, ...v }, was)
			: {};
	const slug =
		v.slug && v.slug !== was.slug ? await freeArticleSlug(brand, v.slug, was.id) : undefined;
	if (slug && slug !== v.slug) throw new ApiError(409, "slug_taken", `${v.slug} is taken here`);
	const [row] = await db
		.update(ha)
		.set({
			...(v.title !== undefined ? { title: v.title } : {}),
			...(v.description !== undefined ? { description: v.description || null } : {}),
			...(v.category !== undefined ? { category: v.category || null } : {}),
			...(slug ? { slug } : {}),
			...c,
			...(v.status !== undefined
				? {
						status: v.status,
						published_at:
							v.status === "published"
								? (was.published_at ?? iso(now))
								: was.published_at,
					}
				: {}),
			updated_at: iso(now),
		})
		.where(eq(ha.id, was.id))
		.returning();
	return row as HelpArticle;
}

export async function deleteArticle(brand: string, ref: string) {
	const a = await getArticle(brand, ref);
	await db.delete(ha).where(eq(ha.id, a.id));
	return a;
}

export async function articleCategories(brands: string[]) {
	if (!brands.length) return [];
	const rows = await db
		.selectDistinct({ category: ha.category })
		.from(ha)
		.where(inArray(ha.organization_id, brands));
	return rows.map((r) => r.category).filter(Boolean) as string[];
}

// ── Search ──────────────────────────────────────────────────────────────────

const STOP = new Set(
	"a an and are as at be but by can do does for from has have how i if in into is it its me my no not of on or our so that the their them then there these they this to was we what when where which who why will with you your hi hello hey please thanks thank help need want get el la los las un una y o de del en que por para con como mi me se su es hola gracias quiero necesito puedo".split(
		" ",
	),
);

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The words that matter in a question: no accents, no little words, short plurals folded. */
export function wordsOf(s: string) {
	return [
		...new Set(
			fold(s)
				.split(/[^a-z0-9]+/)
				.filter((w) => w.length > 1 && !STOP.has(w))
				.map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
		),
	];
}

/** Articles by how well they match: the title counts most, then the summary, then the words. */
function rank(rows: HelpArticle[], q: string) {
	const words = wordsOf(q);
	if (!words.length) return [];
	return (
		rows
			.map((a) => {
				const title = ` ${wordsOf(a.title).join(" ")} `;
				const desc = ` ${wordsOf(`${a.description ?? ""} ${a.category ?? ""}`).join(" ")} `;
				const body = ` ${wordsOf(a.text.slice(0, 8000)).join(" ")} `;
				let score = 0;
				let hit = 0;
				for (const w of words) {
					const t = title.includes(` ${w}`) ? 5 : 0;
					const d = desc.includes(` ${w}`) ? 2 : 0;
					const b = body.includes(` ${w}`) ? 1 : 0;
					if (t || d || b) hit++;
					score += t + d + b;
				}
				return { a, score: score * (hit / words.length), share: hit / words.length };
			})
			// At least half the question's words, and more than a passing mention.
			.filter((r) => r.share >= 0.5 && r.score >= 2)
			.sort((x, y) => y.score - x.score)
	);
}

/**
 * The brand's published articles that best answer a question (the chat, the help center's search,
 * agents). With `gap`, a question nothing answered is kept for the inbox report.
 */
export async function searchArticles(
	brand: string,
	q: string,
	o: { limit?: number; gap?: "chat" | "search"; now?: number } = {},
) {
	const c = await helpCenterOf(brand);
	if (!c?.enabled) return { center: c, results: [] as HelpArticle[] };
	const rows = await db
		.select()
		.from(ha)
		.where(and(eq(ha.organization_id, brand), eq(ha.status, "published")));
	const results = rank(rows, q)
		.slice(0, o.limit ?? 5)
		.map((r) => r.a);
	if (!results.length && o.gap) await recordGap(brand, q, o.gap, o.now);
	return { center: c, results };
}

/** A question no article answered (counted once per wording, tidied). */
export async function recordGap(
	brand: string,
	q: string,
	source: "chat" | "search",
	now = Date.now(),
) {
	const words = wordsOf(q);
	if (words.length < 2 && q.trim().length < 12) return;
	const query = words.join(" ").slice(0, 200);
	await db
		.insert(schema.helpGaps)
		.values({
			organization_id: brand,
			query,
			example: q.trim().replace(/\s+/g, " ").slice(0, 300),
			source,
			last_at: iso(now),
		})
		.onConflictDoUpdate({
			target: [schema.helpGaps.organization_id, schema.helpGaps.query],
			set: { count: sql`${schema.helpGaps.count} + 1`, last_at: iso(now), source },
		});
}

/** The questions with no article yet, most asked first (the inbox report). */
export async function helpGaps(brands: string[], days = 30, now = Date.now(), limit = 20) {
	if (!brands.length) return [];
	const rows = await db
		.select()
		.from(schema.helpGaps)
		.where(
			and(
				inArray(schema.helpGaps.organization_id, brands),
				gte(schema.helpGaps.last_at, iso(now - days * 86_400_000)),
			),
		)
		.orderBy(desc(schema.helpGaps.count), desc(schema.helpGaps.last_at))
		.limit(limit);
	return rows.map((r) => ({
		question: r.example,
		times: r.count,
		source: r.source as "chat" | "search",
		last_at: r.last_at,
		brand_id: r.organization_id,
	}));
}

/** A question answered after all (an article was written for it): off the list. */
export async function dismissGap(brands: string[], question: string) {
	const query = wordsOf(question).join(" ").slice(0, 200);
	await db
		.delete(schema.helpGaps)
		.where(
			and(inArray(schema.helpGaps.organization_id, brands), eq(schema.helpGaps.query, query)),
		);
}

// ── Public pages ────────────────────────────────────────────────────────────

const CSP =
	"default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; form-action 'self'; base-uri 'none'";

const page = (body: string, status = 200, cache = "public, max-age=120") =>
	new Response(body, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": CSP,
			"cache-control": cache,
		},
	});

const missing = () =>
	page(
		'<!doctype html><title>Not found</title><p style="font:16px system-ui;padding:40px">This page isn\'t here.</p>',
		404,
		"public, max-age=60",
	);

async function dress(c: HelpCenter) {
	const d = await dressOf(null, c.organization_id);
	return {
		...d,
		name: c.title,
		home: helpUrl(c.slug),
		accent: c.accent ?? d.accent,
		subscribe: false,
	};
}

const CSS = `.hc{max-width:760px;margin:0 auto;padding:40px 16px 72px}
.hc h1{font-size:34px;line-height:1.15;margin:0 0 8px;color:var(--ink);letter-spacing:-.01em}
.hc .lead{color:var(--soft);font-size:17px;line-height:1.5;margin:0 0 24px}
.hc form.s{display:flex;gap:8px;margin:0 0 32px}
.hc form.s input{flex:1;min-width:0;height:48px;padding:0 16px;font:16px var(--font);color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:var(--r-btn)}
.hc form.s input:focus{outline:2px solid var(--accent);outline-offset:1px}
.hc h2{font:600 12px/1 var(--font);letter-spacing:.08em;text-transform:uppercase;color:var(--mute);margin:32px 0 6px}
.hc .list a{display:block;padding:14px 16px;margin:0 -16px;border-radius:12px;color:var(--ink);text-decoration:none}
.hc .list a:hover{background:var(--card)}
.hc .list b{display:block;font-size:16px;font-weight:600;line-height:1.35}
.hc .list span{display:block;color:var(--mute);font-size:14px;line-height:1.45;margin-top:2px}
.hc .none{color:var(--soft);padding:16px 0}
.hc .crumb{font-size:14px;margin-bottom:12px}.hc .crumb a{color:var(--link);text-decoration:none}
.hc .art{background:var(--card);border:var(--bw) solid var(--line);border-radius:var(--r-card);box-shadow:var(--shadow);overflow:hidden;margin-top:20px}
.hc .art iframe{display:block;width:100%;border:0;min-height:320px}
.hc .vote{margin-top:28px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;color:var(--soft);font-size:15px}
.hc .vote form{display:inline}
.hc .vote button{font:500 14px var(--font);color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:var(--r-btn);padding:8px 16px;cursor:pointer}
.hc .vote button:hover{border-color:var(--mute)}`;

function listHtml(c: HelpCenter, rows: HelpArticle[]) {
	return `<div class="list">${rows
		.map(
			(a) =>
				`<a href="${esc(articleUrl(c, a) ?? "#")}"><b>${esc(a.title)}</b>${a.description ? `<span>${esc(a.description)}</span>` : ""}</a>`,
		)
		.join("")}</div>`;
}

async function homePage(c: HelpCenter, q: string) {
	const d = await dress(c);
	const rows = await db
		.select()
		.from(ha)
		.where(and(eq(ha.organization_id, c.organization_id), eq(ha.status, "published")))
		.orderBy(asc(ha.category), asc(ha.title));
	let body: string;
	if (q) {
		const { results } = await searchArticles(c.organization_id, q, {
			limit: 20,
			gap: "search",
		});
		body = `<h2>${results.length ? `Results for “${esc(q)}”` : `Nothing for “${esc(q)}” yet`}</h2>${results.length ? listHtml(c, results) : `<p class="none">Try other words, or write to us.</p>`}`;
	} else {
		const groups = new Map<string, HelpArticle[]>();
		for (const a of rows) {
			const k = a.category ?? "";
			groups.set(k, [...(groups.get(k) ?? []), a]);
		}
		body = rows.length
			? [...groups]
					.sort(([x], [y]) => (x === "" ? 1 : y === "" ? -1 : x.localeCompare(y)))
					.map(([k, list]) => `<h2>${esc(k || "More")}</h2>${listHtml(c, list)}`)
					.join("")
			: `<p class="none">No articles yet.</p>`;
	}
	return dressPage(d, {
		title: c.title,
		head: `${c.intro ? `<meta name="description" content="${esc(c.intro)}">` : ""}<link rel="canonical" href="${esc(helpUrl(c.slug))}">`,
		css: CSS,
		body: `${dressBar(d)}<main class="hc"><h1>${esc(c.title)}</h1>${c.intro ? `<p class="lead">${esc(c.intro)}</p>` : ""}<form class="s" method="get" action="${esc(helpUrl(c.slug))}"><input type="search" name="q" value="${esc(q)}" placeholder="Search the articles" aria-label="Search the articles"><button class="mrw-btn" type="submit">Search</button></form>${body}</main>`,
	});
}

async function articlePage(c: HelpCenter, a: HelpArticle, voted: string | null) {
	const d = await dress(c);
	const url = articleUrl(c, a) ?? "";
	const vote =
		voted === "yes" || voted === "no"
			? `<div class="vote">Thanks for telling us.</div>`
			: `<div class="vote">Did this answer your question?<form method="post" action="${esc(url)}/vote"><input type="hidden" name="v" value="yes"><button type="submit">Yes</button></form><form method="post" action="${esc(url)}/vote"><input type="hidden" name="v" value="no"><button type="submit">No</button></form></div>`;
	const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.title)} · ${esc(c.title)}</title>${a.description ? `<meta name="description" content="${esc(a.description)}"><meta property="og:description" content="${esc(a.description)}">` : ""}<meta property="og:title" content="${esc(a.title)}"><meta property="og:type" content="article"><link rel="canonical" href="${esc(url)}">${dressFonts(d)}<style>${dressCss(d)}\n${CSS}\n.hc.top{padding-bottom:0}.hc.end{padding-top:0}</style>`;
	const top = `${dressBar(d)}<div class="mrw hc top"><div class="crumb"><a href="${esc(helpUrl(c.slug))}">${esc(c.title)}</a>${a.category ? ` · ${esc(a.category)}` : ""}</div><h1>${esc(a.title)}</h1>${a.description ? `<p class="lead">${esc(a.description)}</p>` : ""}</div>`;
	const end = `<div class="mrw hc end">${vote}</div>`;
	// The article is the email's own page (as a newsletter issue's web version is), with the help
	// center's bar, title and vote around it.
	let doc = a.html || "<p></p>";
	if (!/<html[\s>]/i.test(doc))
		doc = `<!doctype html><html><head></head><body>${doc}</body></html>`;
	if (!/<head[^>]*>/i.test(doc)) doc = doc.replace(/<html[^>]*>/i, (x) => `${x}<head></head>`);
	if (!/<body[^>]*>/i.test(doc)) doc = doc.replace(/<\/head>/i, "</head><body>") + "</body>";
	return doc
		.replace(/<title>[\s\S]*?<\/title>/i, "")
		.replace(/<head[^>]*>/i, (x) => `${x}${head}`)
		.replace(/<body([^>]*)>/i, (x) => `${x}${top}`)
		.replace(/<\/body>/i, `${end}</body>`);
}

/** /help/<center>[?q=], /help/<center>/<article> and its /vote. */
export async function handleHelpPage(request: Request): Promise<Response> {
	const u = new URL(request.url);
	const m = /^\/help\/([a-z0-9-]{1,64})(?:\/([a-z0-9-]{1,80})(\/vote)?)?\/?$/.exec(u.pathname);
	if (!m?.[1]) return missing();
	const c = await db.select().from(hc).where(eq(hc.slug, m[1])).get();
	if (!c?.enabled || !shownHere(c.organization_id)) return missing();
	if (!m[2]) {
		if (request.method !== "GET" && request.method !== "HEAD")
			return new Response("Method not allowed", { status: 405 });
		const q = (u.searchParams.get("q") ?? "").trim().slice(0, 200);
		return page(await homePage(c, q), 200, q ? "no-store" : "public, max-age=120");
	}
	const a = await db
		.select()
		.from(ha)
		.where(
			and(
				eq(ha.organization_id, c.organization_id),
				eq(ha.slug, m[2]),
				eq(ha.status, "published"),
			),
		)
		.get();
	if (!a) return missing();
	if (m[3]) {
		if (request.method !== "POST") return Response.redirect(articleUrl(c, a) ?? "/", 303);
		const form = await request.formData().catch(() => null);
		const v = form?.get("v");
		if (v === "yes" || v === "no")
			await db
				.update(ha)
				.set(
					v === "yes"
						? { helpful: sql`${ha.helpful} + 1` }
						: { unhelpful: sql`${ha.unhelpful} + 1` },
				)
				.where(eq(ha.id, a.id));
		return Response.redirect(`${articleUrl(c, a)}?voted=${v === "yes" ? "yes" : "no"}`, 303);
	}
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", { status: 405 });
	if (request.method === "GET" && !u.searchParams.get("voted"))
		await db
			.update(ha)
			.set({ views: sql`${ha.views} + 1` })
			.where(eq(ha.id, a.id));
	return page(await articlePage(c, a, u.searchParams.get("voted")), 200, "no-store");
}
