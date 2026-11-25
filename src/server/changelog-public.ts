import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { webUrl } from "./newsletters";
import { publicUrl } from "./public-host";

/**
 * Standalone Public Changelog page (/changelog/<slug>), RSS 2.0 feed (/changelog/<slug>/feed.xml),
 * and emoji reaction endpoint (POST /changelog/<slug>/react).
 * Powered directly by a brand's published web broadcasts — zero extra authoring surface needed.
 */

const REACTION_EMOJIS = ["🎉", "❤️", "🔥", "👍"] as const;
const REACTION_SET = new Set<string>(REACTION_EMOJIS);

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const xmlEsc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

async function resolveBrand(slug: string) {
	const clean = slug.trim().toLowerCase();
	if (!clean) return null;
	const org =
		(await db
			.select({
				id: schema.organization.id,
				name: schema.organization.name,
				slug: schema.organization.slug,
			})
			.from(schema.organization)
			.where(eq(schema.organization.slug, clean))
			.get()) ??
		(await db
			.select({
				id: schema.organization.id,
				name: schema.organization.name,
				slug: schema.organization.slug,
			})
			.from(schema.organization)
			.where(eq(schema.organization.id, slug))
			.get()) ??
		null;
	return org;
}

async function listChangelogEntries(organizationId: string, q?: string) {
	const rows = await db
		.select({
			id: schema.broadcasts.id,
			subject: schema.broadcasts.subject,
			preview_text: schema.broadcasts.preview_text,
			slug: schema.broadcasts.slug,
			completed_at: schema.broadcasts.completed_at,
			created_at: schema.broadcasts.created_at,
		})
		.from(schema.broadcasts)
		.where(
			and(
				eq(schema.broadcasts.organization_id, organizationId),
				eq(schema.broadcasts.status, "sent"),
				eq(schema.broadcasts.web, true),
			),
		)
		.orderBy(desc(schema.broadcasts.completed_at), desc(schema.broadcasts.created_at))
		.limit(40);

	const needle = q?.trim().toLowerCase();
	const filtered = needle
		? rows.filter(
				(r) =>
					r.subject.toLowerCase().includes(needle) ||
					(r.preview_text ?? "").toLowerCase().includes(needle),
			)
		: rows;

	const ids = filtered.map((r) => r.id);
	const reacts = ids.length
		? await db
				.select()
				.from(schema.changelogReactions)
				.where(inArray(schema.changelogReactions.broadcast_id, ids))
		: [];
	const reactMap = new Map<string, Record<string, number>>();
	for (const r of reacts) {
		const bag = reactMap.get(r.broadcast_id) ?? {};
		bag[r.emoji] = r.count;
		reactMap.set(r.broadcast_id, bag);
	}

	return filtered.map((r) => ({
		id: r.id,
		title: r.subject,
		summary: r.preview_text,
		published_at: r.completed_at ?? r.created_at,
		url: webUrl({ id: r.id, slug: r.slug, web: true }, null),
		reactions: reactMap.get(r.id) ?? {},
	}));
}

export async function handleChangelogPage(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const match = /^\/changelog\/([A-Za-z0-9_-]{1,80})(?:\/(feed\.xml|react))?\/?$/.exec(
		url.pathname,
	);
	if (!match?.[1]) return new Response("Not found", { status: 404 });
	const slug = match[1];
	const sub = match[2] ?? null;

	const org = await resolveBrand(slug);
	if (!org) return new Response("Changelog not found", { status: 404 });

	// POST /changelog/<slug>/react -> increment emoji reaction
	if (sub === "react") {
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
		let body: { id?: string; emoji?: string };
		try {
			body = (await request.json()) as { id?: string; emoji?: string };
		} catch {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		if (!body.id || !body.emoji || !REACTION_SET.has(body.emoji)) {
			return Response.json({ error: "Invalid reaction" }, { status: 422 });
		}
		const bc = await db
			.select({ id: schema.broadcasts.id })
			.from(schema.broadcasts)
			.where(
				and(
					eq(schema.broadcasts.id, body.id),
					eq(schema.broadcasts.organization_id, org.id),
					eq(schema.broadcasts.status, "sent"),
					eq(schema.broadcasts.web, true),
				),
			)
			.get();
		if (!bc) return Response.json({ error: "Update not found" }, { status: 404 });

		await db
			.insert(schema.changelogReactions)
			.values({
				broadcast_id: bc.id,
				emoji: body.emoji,
				count: 1,
			})
			.onConflictDoUpdate({
				target: [schema.changelogReactions.broadcast_id, schema.changelogReactions.emoji],
				set: {
					count: sql`${schema.changelogReactions.count} + 1`,
				},
			});
		const row = await db
			.select({ count: schema.changelogReactions.count })
			.from(schema.changelogReactions)
			.where(
				and(
					eq(schema.changelogReactions.broadcast_id, bc.id),
					eq(schema.changelogReactions.emoji, body.emoji),
				),
			)
			.get();
		return Response.json({ ok: true, id: bc.id, emoji: body.emoji, count: row?.count ?? 1 });
	}

	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}

	const q = url.searchParams.get("q") ?? undefined;
	const entries = await listChangelogEntries(org.id, q);
	const base = publicUrl().replace(/\/$/, "");
	const pageUrl = `${base}/changelog/${encodeURIComponent(org.slug ?? slug)}`;
	const feedUrl = `${pageUrl}/feed.xml`;

	// GET /changelog/<slug>/feed.xml -> RSS 2.0
	if (sub === "feed.xml") {
		const items = entries
			.map(
				(e) => `    <item>
      <title>${xmlEsc(e.title)}</title>
      <link>${xmlEsc(e.url)}</link>
      <guid isPermaLink="false">${xmlEsc(e.id)}</guid>
      <pubDate>${new Date(e.published_at).toUTCString()}</pubDate>
      <description>${xmlEsc(e.summary ?? e.title)}</description>
    </item>`,
			)
			.join("\n");
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xmlEsc(org.name)} — Changelog</title>
    <link>${xmlEsc(pageUrl)}</link>
    <atom:link href="${xmlEsc(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>Product updates and release notes from ${xmlEsc(org.name)}</description>
${items}
  </channel>
</rss>`;
		return new Response(xml, {
			headers: {
				"content-type": "application/rss+xml; charset=utf-8",
				"cache-control": "public, max-age=300",
			},
		});
	}

	// GET /changelog/<slug> -> Branded standalone HTML timeline
	const cards = entries.length
		? entries
				.map((e) => {
					const dateLabel = new Date(e.published_at).toLocaleDateString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
					const reacts = REACTION_EMOJIS.map((em) => {
						const count = e.reactions[em] ?? 0;
						return `<button type="button" class="rx" data-id="${esc(e.id)}" data-emoji="${esc(em)}">${esc(em)}${count > 0 ? ` <span>${count}</span>` : " <span></span>"}</button>`;
					}).join("");
					return `<article class="entry">
  <div class="meta"><time datetime="${esc(e.published_at)}">${esc(dateLabel)}</time></div>
  <div class="body">
    <h2><a href="${esc(e.url)}">${esc(e.title)}</a></h2>
    ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ""}
    <div class="foot">
      <div class="rxs">${reacts}</div>
      <a class="read" href="${esc(e.url)}">Read full update →</a>
    </div>
  </div>
</article>`;
				})
				.join("\n")
		: `<div class="empty">No published updates${q ? ` matching “${esc(q)}”` : ""} yet.</div>`;

	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(org.name)} · Changelog</title>
<link rel="alternate" type="application/rss+xml" title="${esc(org.name)} Changelog" href="${esc(feedUrl)}">
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#111215;--muted:#63666f;--line:rgba(17,18,21,.09);--accent:#3b5bdb}
@media(prefers-color-scheme:dark){:root{--bg:#0e0f12;--card:#15161b;--fg:#f4f5f7;--muted:#989ca8;--line:rgba(255,255,255,.09);--accent:#6b8cff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:780px;margin:0 auto;padding:48px 20px 80px}
header{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px;padding-bottom:24px;border-bottom:1px solid var(--line)}
header h1{margin:0;font-size:28px;letter-spacing:-.025em;line-height:1.15}
header p{margin:6px 0 0;color:var(--muted);font-size:14.5px}
.tools{display:flex;gap:8px;align-items:center}
.tools input{height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:13.5px;width:200px}
.rss{display:inline-flex;align-items:center;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);text-decoration:none;font-size:13px;font-weight:500}
.rss:hover{border-color:var(--accent);color:var(--accent)}
.feed{margin-top:32px;display:flex;flex-direction:column;gap:24px}
.entry{display:grid;grid-template-columns:130px 1fr;gap:20px;align-items:start}
@media(max-width:640px){.entry{grid-template-columns:1fr;gap:6px}}
.meta{font-size:13px;color:var(--muted);padding-top:16px;font-variant-numeric:tabular-nums}
.body{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}
.body h2{margin:0;font-size:18px;letter-spacing:-.015em;line-height:1.3}
.body h2 a{color:inherit;text-decoration:none}
.body h2 a:hover{color:var(--accent)}
.summary{margin:8px 0 0;color:var(--muted);font-size:14.5px}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.rxs{display:flex;gap:6px;flex-wrap:wrap}
.rx{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:99px;border:1px solid var(--line);background:transparent;color:var(--fg);font:12.5px inherit;cursor:pointer;transition:border-color .15s}
.rx:hover,.rx.on{border-color:var(--accent)}
.rx span:empty{display:none}
.read{font-size:13px;font-weight:500;color:var(--accent);text-decoration:none}
.read:hover{text-decoration:underline}
.empty{padding:48px 20px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:14px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>${esc(org.name)} Changelog</h1>
      <p>Latest product updates, launches, and improvements.</p>
    </div>
    <form class="tools" method="get" action="${esc(pageUrl)}">
      <input type="search" name="q" value="${esc(q ?? "")}" placeholder="Search updates…" aria-label="Search updates">
      <a class="rss" href="${esc(feedUrl)}">RSS</a>
    </form>
  </header>
  <main class="feed">
    ${cards}
  </main>
</div>
<script>
document.querySelectorAll(".rx").forEach(function(btn){
  btn.addEventListener("click",function(){
    var id=btn.dataset.id,em=btn.dataset.emoji,k="mr_cl_"+id+"_"+em;
    try{if(localStorage.getItem(k))return;localStorage.setItem(k,"1");}catch(_){}
    btn.classList.add("on");
    var sp=btn.querySelector("span");
    sp.textContent=String((Number(sp.textContent)||0)+1);
    fetch("${esc(pageUrl)}/react",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:id,emoji:em})}).catch(function(){});
  });
});
</script>
</body>
</html>`;
	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=60",
		},
	});
}
