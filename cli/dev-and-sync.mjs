import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/**
 * CLI extras:
 *  - `mailroom templates pull/push`: Git-versioned local sync for Mailroom email templates.
 *  - `mailroom dev`: zero-dependency local email catcher + live web inbox UI (Mailpit-style).
 */

const slug = (s) =>
	String(s || "template")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60) || "template";

export async function pullTemplates(api, dir) {
	await mkdir(dir, { recursive: true });
	const list = await api("GET", "/templates");
	const items = list.data ?? [];
	const pulled = [];
	for (const item of items) {
		const full = await api("GET", `/templates/${encodeURIComponent(item.id)}`);
		const fileBase = slug(full.alias || full.name || full.id);
		const html = full.html ?? full.draft?.html ?? "";
		const meta = {
			id: full.id,
			name: full.name,
			alias: full.alias ?? null,
			subject: full.subject ?? full.draft?.subject ?? null,
			from: full.from ?? full.draft?.from ?? null,
			reply_to: full.reply_to ?? full.draft?.reply_to ?? null,
			text: full.text ?? full.draft?.text ?? null,
			variables: full.variables ?? full.draft?.variables ?? [],
		};
		await writeFile(join(dir, `${fileBase}.html`), html, "utf8");
		await writeFile(
			join(dir, `${fileBase}.json`),
			`${JSON.stringify(meta, null, 2)}\n`,
			"utf8",
		);
		pulled.push({ file: fileBase, id: full.id, name: full.name, alias: full.alias ?? null });
	}
	return { dir, count: pulled.length, templates: pulled };
}

export async function pushTemplates(api, dir, { publish = false } = {}) {
	const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	const existing = (await api("GET", "/templates")).data ?? [];
	const byId = new Map(existing.map((t) => [t.id, t]));
	const byAlias = new Map(existing.filter((t) => t.alias).map((t) => [t.alias, t]));
	const results = [];
	for (const file of files) {
		const base = file.slice(0, -5);
		const meta = JSON.parse(await readFile(join(dir, file), "utf8"));
		const html = await readFile(join(dir, `${base}.html`), "utf8").catch(() => "");
		const payload = {
			name: meta.name || base,
			...(meta.alias ? { alias: meta.alias } : {}),
			...(meta.subject ? { subject: meta.subject } : {}),
			...(meta.from ? { from: meta.from } : {}),
			...(meta.reply_to ? { reply_to: meta.reply_to } : {}),
			...(meta.text ? { text: meta.text } : {}),
			...(Array.isArray(meta.variables) ? { variables: meta.variables } : {}),
			html,
		};
		const match = (meta.id && byId.get(meta.id)) || (meta.alias && byAlias.get(meta.alias));
		let id;
		let action;
		if (match) {
			await api("PATCH", `/templates/${encodeURIComponent(match.id)}`, payload);
			id = match.id;
			action = "updated";
		} else {
			const created = await api("POST", "/templates", { ...payload, publish });
			id = created.id;
			action = "created";
			meta.id = id;
			await writeFile(join(dir, file), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
		}
		if (publish && action === "updated") {
			await api("POST", `/templates/${encodeURIComponent(id)}/publish`);
			action = "updated+published";
		}
		results.push({ file: base, id, name: payload.name, action });
	}
	return { dir, count: results.length, templates: results };
}

const DEV_UI = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mailroom Dev Inbox</title>
<style>
  *{box-sizing:border-box} body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#f4f4f5;color:#18181b;display:flex;height:100vh}
  aside{width:340px;background:#fff;border-right:1px solid #e4e4e7;display:flex;flex-direction:column}
  header{padding:14px 16px;border-bottom:1px solid #e4e4e7;display:flex;justify-content:space-between;align-items:center}
  header h1{font-size:15px;margin:0} header button{font:12px inherit;padding:4px 10px;border:1px solid #d4d4d8;background:#fff;border-radius:6px;cursor:pointer}
  #list{flex:1;overflow:auto}
  .row{padding:12px 16px;border-bottom:1px solid #f4f4f5;cursor:pointer}
  .row:hover,.row.on{background:#eff6ff}
  .row b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .row span{display:block;font-size:12px;color:#71717a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  main{flex:1;display:flex;flex-direction:column;min-width:0}
  #meta{background:#fff;border-bottom:1px solid #e4e4e7;padding:14px 20px;font-size:13px}
  #meta h2{margin:0 0 6px;font-size:16px}
  #meta div{color:#52525b}
  iframe{flex:1;border:0;background:#fff;width:100%}
  .empty{margin:auto;color:#71717a;text-align:center;max-width:360px;padding:24px}
  code{background:#e4e4e7;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<aside>
  <header><h1>Mailroom Dev</h1><button id="clear">Clear</button></header>
  <div id="list"></div>
</aside>
<main id="main"><div class="empty"><h3>Waiting for local emails</h3><p>Point your app at <code>MAILROOM_URL=http://localhost:__PORT__</code> or <code>RESEND_BASE_URL=http://localhost:__PORT__/api</code>. Every email is captured here and never leaves your machine.</p></div></main>
<script>
let items = [], active = null;
const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function refresh() {
  const r = await fetch('/api/emails'); const d = await r.json();
  items = d.data || [];
  if (!active && items[0]) active = items[0].id;
  render();
}
function render() {
  const el = document.getElementById('list');
  el.innerHTML = items.length ? items.map(e =>
    '<div class="row'+(e.id===active?' on':'')+'" data-id="'+esc(e.id)+'"><b>'+esc(e.subject||'(no subject)')+'</b><span>To: '+esc((e.to||[]).join(', '))+' · '+new Date(e.created_at).toLocaleTimeString()+'</span></div>'
  ).join('') : '<div class="empty" style="padding:24px 16px">No emails captured yet.</div>';
  el.querySelectorAll('.row').forEach(r => r.onclick = () => { active = r.dataset.id; render(); });
  const cur = items.find(x => x.id === active);
  const main = document.getElementById('main');
  if (!cur) return;
  const html = cur.html || '<pre style="font:14px monospace;padding:20px;white-space:pre-wrap">'+esc(cur.text||'')+'</pre>';
  main.innerHTML = '<div id="meta"><h2>'+esc(cur.subject||'(no subject)')+'</h2><div><b>From:</b> '+esc(cur.from)+' &nbsp; <b>To:</b> '+esc((cur.to||[]).join(', '))+'</div></div><iframe sandbox=""></iframe>';
  main.querySelector('iframe').srcdoc = html;
}
document.getElementById('clear').onclick = async () => { await fetch('/api/_clear',{method:'POST'}); active=null; refresh(); };
refresh(); setInterval(refresh, 1500);
</script>
</body></html>`;

/** Pure request handler for the local Mailroom-compatible email sandbox. */
export function createDevHandler({ port = 4025 } = {}) {
	const captured = [];

	const record = (payload) => {
		const id = `dev_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const to = Array.isArray(payload.to) ? payload.to : payload.to ? [payload.to] : [];
		const item = {
			id,
			from: payload.from ?? "dev@localhost",
			to,
			cc: payload.cc ?? [],
			bcc: payload.bcc ?? [],
			subject: payload.subject ?? "(no subject)",
			html: payload.html ?? null,
			text: payload.text ?? null,
			tags: payload.tags ?? [],
			status: "delivered",
			last_event: "delivered",
			created_at: new Date().toISOString(),
		};
		captured.unshift(item);
		if (captured.length > 200) captured.length = 200;
		return item;
	};

	const handle = (method, pathname, body) => {
		if (method === "GET" && pathname === "/") {
			return {
				status: 200,
				contentType: "text/html; charset=utf-8",
				body: DEV_UI.replace(/__PORT__/g, String(port)),
			};
		}
		const json = (status, data) => ({
			status,
			contentType: "application/json; charset=utf-8",
			body: JSON.stringify(data),
		});
		if (method === "GET" && pathname === "/api/status")
			return json(200, { mode: "dev-sandbox", captured: captured.length });
		if (method === "POST" && pathname === "/api/_clear") {
			captured.length = 0;
			return json(200, { ok: true });
		}
		if (method === "GET" && pathname === "/api/emails")
			return json(200, { object: "list", data: captured });
		if (method === "POST" && pathname === "/api/emails") {
			const item = record(body ?? {});
			return json(200, { id: item.id });
		}
		if (method === "POST" && pathname === "/api/emails/batch") {
			const items = (Array.isArray(body) ? body : []).map(record);
			return json(200, { data: items.map((i) => ({ id: i.id })) });
		}
		const one = /^\/api\/emails\/([^/]+)$/.exec(pathname);
		if (method === "GET" && one) {
			const found = captured.find((e) => e.id === one[1]);
			return found ? json(200, found) : json(404, { message: "Not found" });
		}
		return json(404, { message: "Not found" });
	};

	return { handle, captured };
}

/** Starts a local Mailroom-compatible HTTP email sandbox server. */
export function startDevServer({ port = 4025 } = {}) {
	const { handle, captured } = createDevHandler({ port });
	const readJson = (req) =>
		new Promise((resolve, reject) => {
			let data = "";
			req.on("data", (chunk) => {
				data += chunk;
				if (data.length > 10_000_000) reject(new Error("Payload too large"));
			});
			req.on("end", () => {
				try {
					resolve(data ? JSON.parse(data) : {});
				} catch (err) {
					reject(err);
				}
			});
			req.on("error", reject);
		});

	const server = createServer(async (req, res) => {
		const url = new URL(req.url || "/", `http://localhost:${port}`);
		try {
			const body =
				req.method === "POST" || req.method === "PATCH" ? await readJson(req) : undefined;
			const out = handle(req.method || "GET", url.pathname, body);
			if (req.method === "POST" && url.pathname.startsWith("/api/emails") && captured[0]) {
				const latest = captured[0];
				console.log(
					`[mailroom dev] ${latest.id}  ${latest.from} -> ${latest.to.join(", ")}  "${latest.subject}"`,
				);
			}
			res.writeHead(out.status, { "content-type": out.contentType });
			res.end(out.body);
		} catch (error) {
			res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
			res.end(
				JSON.stringify({
					message: error instanceof Error ? error.message : "Bad request",
				}),
			);
		}
	});

	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => resolve({ server, captured, port }));
	});
}
