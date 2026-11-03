#!/usr/bin/env node
/**
 * Checks that every page's skeleton is the page: opens each one with its server calls held, measures
 * every element of the skeleton, lets the data in, measures again, and fails when anything moved or
 * changed size, or when a skeleton shows text the page doesn't (a stand-in leaking through).
 *
 *   bun run dev                              # another terminal; sign-in codes print there
 *   bun run check:skeletons -- --log dev.log # or --state <Playwright storage state>
 *
 * Options: --base http://localhost:3000, --email you@example.com (an admin in .dev.vars),
 * --log <file with the dev server's output>, --state <storage state JSON>, --paths /,/emails,
 * --widths 1280,390, --out .skeletons (screenshots of each skeleton and page). Two ways in per page:
 * the first paint (the whole dashboard loading, as a returning visitor) and a click from another page.
 *
 * What counts: each element is matched by its place in the page (tag and position among its
 * siblings); nothing may change its top, nor anything outside a data spot (inside [data-ph]) its
 * left, by more than 1 px. Rows only one side has (the skeleton drew 8,
 * the page has 3) are listed, not failed. Growing taller in place isn't a
 * failure by itself (a code block with more lines than its stand-in); anything it pushes down is.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.join(" ")
		.split(/\s*--/)
		.filter(Boolean)
		.map((a) => {
			const [k, ...v] = a.split(/\s+/);
			return [k, v.join(" ") || "1"];
		}),
);
const base = args.base ?? "http://localhost:3000";
const email = args.email ?? "test@example.com";
const widths = (args.widths ?? "1280,390").split(",").map(Number);
const out = args.out ?? ".skeletons";
const TOLERANCE = 1;
const DETAIL = /^\/(emails|received|domains|logs|brands|webhooks|suppressions)\/[^/?#]+$/;

fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function signIn() {
	if (args.state) return JSON.parse(fs.readFileSync(args.state, "utf8"));
	if (!args.log)
		throw new Error("Pass --log <dev server output> (for the sign-in code) or --state");
	const ctx = await browser.newContext({ baseURL: base });
	const before = fs.readFileSync(args.log, "utf8").length;
	const headers = { origin: base };
	await ctx.request.post("/api/auth/email-otp/send-verification-otp", {
		data: { email, type: "sign-in" },
		headers,
	});
	let otp;
	for (let i = 0; i < 40 && !otp; i++) {
		await new Promise((r) => setTimeout(r, 250));
		otp = fs
			.readFileSync(args.log, "utf8")
			.slice(before)
			.match(/\b(\d{6})\b/)?.[1];
	}
	if (!otp) throw new Error(`No sign-in code for ${email} in ${args.log}`);
	const r = await ctx.request.post("/api/auth/sign-in/email-otp", {
		data: { email, otp },
		headers,
	});
	if (!r.ok()) throw new Error(`Sign-in failed: ${r.status()}`);
	const state = await ctx.storageState();
	await ctx.close();
	return state;
}

/** Every element's box and own text, keyed by its place in the page. Runs in the browser. */
function measure() {
	const rows = {};
	const visible = (el) => {
		const s = getComputedStyle(el);
		return s.display !== "none" && s.visibility !== "hidden";
	};
	const kids = (el) =>
		[...el.children].flatMap((c) =>
			getComputedStyle(c).display === "contents" ? kids(c) : [c],
		);
	const walk = (el, key) => {
		const counts = {};
		for (const c of kids(el)) {
			const tag = c.tagName.toLowerCase();
			counts[tag] = (counts[tag] ?? 0) + 1;
			const k = `${key}/${tag}${counts[tag]}`;
			if (!visible(c) || ["script", "style", "template"].includes(tag)) continue;
			// Libraries' off-screen helpers (Recharts measures text in a hidden span).
			if (c.id?.startsWith("recharts")) continue;
			const r = c.getBoundingClientRect();
			if (r.width === 0 && r.height === 0 && c.children.length === 0) continue;
			const text = [...c.childNodes]
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent)
				.join("")
				.trim();
			rows[k] = {
				x: r.left + scrollX,
				y: r.top + scrollY,
				w: r.width,
				h: r.height,
				ph: !!c.closest("[data-ph]") || !!c.querySelector("[data-ph]"),
				text: text.slice(0, 80),
			};
			// A data spot's insides differ by design (a placeholder hides them).
			if (!c.matches("[data-ph]")) walk(c, k);
		}
	};
	walk(document.body, "body");
	return rows;
}

function compare(sketch, real) {
	const moved = [];
	const leaked = [];
	let compared = 0;
	for (const [k, a] of Object.entries(sketch)) {
		const b = real[k];
		if (!b || (b.w === 0 && b.h === 0) || (!a.w && !b.w) || (!a.h && !b.h)) continue;
		compared++;
		const d = {
			x: Math.abs(a.x - b.x),
			y: Math.abs(a.y - b.y),
			w: Math.abs(a.w - b.w),
			h: Math.abs(a.h - b.h),
		};
		// Growing taller in place (a code block with more lines) moves nothing by itself: whatever it
		// pushes down is caught moving.
		// A box only getting wider or narrower (a label beside a longer title) moves nothing either.
		const bad = d.y > TOLERANCE || (!a.ph && !b.ph && d.x > TOLERANCE);
		if (bad) moved.push({ k, a, b, d });
		if (!a.ph && a.text && a.text !== b.text) leaked.push({ k, sketch: a.text, page: b.text });
	}
	// The elements that moved themselves, not just because something inside them did.
	const keys = new Set(moved.map((m) => m.k));
	const own = moved.filter((m) => ![...keys].some((k) => k !== m.k && k.startsWith(`${m.k}/`)));
	own.sort((m, n) => m.a.y - n.a.y);
	moved.length = 0;
	moved.push(...own);
	return {
		compared,
		moved,
		leaked,
		onlySketch: Object.keys(sketch).filter((k) => !real[k]).length,
		onlyPage: Object.keys(real).filter((k) => !sketch[k]).length,
	};
}

/**
 * The server's page, before the browser's code runs: the frame drawn as a skeleton (the page area
 * stays empty; the page's skeleton comes with the code). Compared with the loaded page.
 */
async function runServer(state, width, p) {
	const opts = { baseURL: base, viewport: { width, height: 900 } };
	// A returning visitor: loaded once (the browser keeps the menu's shape), in light, as the
	// server's page is before the theme's script runs.
	const ctx = await browser.newContext({ ...opts, storageState: state });
	await ctx.addInitScript(() => localStorage.setItem("theme", "light"));
	const real = await ctx.newPage();
	await real.goto(p);
	await real.waitForLoadState("networkidle").catch(() => {});
	await real.waitForFunction(
		() => !document.querySelector("[data-sketch],[aria-busy=true]"),
		null,
		{
			timeout: 15_000,
		},
	);
	await real.evaluate(() => document.fonts.ready);
	await real.waitForTimeout(400);
	const loaded = await real.evaluate(measure);
	const returning = await ctx.storageState();
	await ctx.close();
	const noJs = await browser.newContext({
		...opts,
		storageState: returning,
		javaScriptEnabled: false,
	});
	const page = await noJs.newPage();
	await page.goto(p);
	await page.evaluate(() => document.fonts.ready);
	const sketch = await page.evaluate(measure);
	await page.screenshot({ path: path.join(out, `${name(p)}-${width}-server-sketch.png`) });
	await noJs.close();
	return { sketch, real: loaded, cls: 0, links: [] };
}

async function run(state, width, p, how) {
	if (how === "server") return runServer(state, width, p);
	const ctx = await browser.newContext({
		baseURL: base,
		storageState: state,
		viewport: { width, height: 900 },
		reducedMotion: "reduce",
	});
	const page = await ctx.newPage();
	let hold = false;
	const held = [];
	await page.route(/\/_serverFn\//, async (route) => {
		if (hold) await new Promise((r) => held.push(r));
		await route.continue().catch(() => {});
	});
	const settle = async () => {
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForFunction(
			() => !document.querySelector("[data-sketch],[aria-busy=true]"),
			null,
			{ timeout: 15_000 },
		);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);
	};
	if (how === "click") {
		// Seen before (the browser remembers its rows), then from another page, with the idle
		// preloading finished and forgotten, so the click has to wait.
		await page.goto(p);
		await settle();
		// A record opens from its list (which hands its row to the skeleton); a page from another.
		const list = p.match(/^\/[^/]+(?=\/.)/)?.[0];
		await page.goto(list ?? (p === "/account" ? "/settings" : "/account"));
		await settle();
		await page.waitForTimeout(1200);
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.evaluate(() => window.__TSR_ROUTER__.clearCache());
		hold = true;
		await page.evaluate((to) => void window.__TSR_ROUTER__.navigate({ href: to }), p);
	} else {
		// A returning visitor: the browser remembers the menu and how many rows each list had.
		await page.goto(p);
		await settle();
		hold = true;
		await page.reload({ waitUntil: "commit" });
	}
	let sketch = null;
	try {
		// The browser's own skeleton (the server's first paint has the frame only: "server").
		await page.waitForFunction(
			() =>
				window.__TSR_ROUTER__ &&
				// The page's own skeleton, not only the frame's (its code may still be on its way).
				document.querySelector("[data-app-frame] [data-sketch]"),
			null,
			{ timeout: 8000 },
		);
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(250);
		sketch = await page.evaluate(measure);
		await page.screenshot({
			path: path.join(out, `${name(p)}-${width}-${how}-sketch.png`),
			fullPage: true,
		});
	} catch {}
	hold = false;
	for (const r of held.splice(0)) r();
	await settle();
	// Layout shifts after the data arrived (late images, fonts, charts sizing themselves).
	const cls = await page.evaluate(
		() =>
			new Promise((resolve) => {
				let sum = 0;
				new PerformanceObserver((l) => {
					for (const e of l.getEntries()) if (!e.hadRecentInput) sum += e.value;
				}).observe({ type: "layout-shift", buffered: false });
				setTimeout(() => resolve(sum), 800);
			}),
	);
	const real = await page.evaluate(measure);
	await page.screenshot({
		path: path.join(out, `${name(p)}-${width}-${how}-page.png`),
		fullPage: true,
	});
	const links =
		how === "load"
			? await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")))
			: [];
	await ctx.close();
	return { sketch, real, cls, links };
}

const name = (p) => p.replace(/[^\w]+/g, "_").replace(/^_|_$/g, "") || "overview";

const state = await signIn();
const paths = args.paths
	? args.paths.split(",")
	: [
			"/",
			"/emails",
			"/received",
			"/domains",
			"/logs",
			"/api-keys",
			"/webhooks",
			"/suppressions",
			"/recipients",
			"/brands",
			"/settings",
			"/docs",
			"/account",
			"/admin",
		];
let failed = 0;
const seen = new Set(paths);
for (let i = 0; i < paths.length; i++) {
	const p = paths[i];
	for (const width of widths) {
		for (const how of ["server", "load", "click"]) {
			const r = await run(state, width, p, how);
			if (!args.paths && how === "load" && width === widths[0])
				for (const l of r.links) {
					const kind = l?.match(DETAIL)?.[1];
					if (kind && ![...seen].some((s) => s.startsWith(`/${kind}/`))) {
						seen.add(l);
						paths.push(l);
					}
				}
			const label = `${p} @${width} ${how}`;
			if (!r.sketch) {
				console.log(`·  ${label}: no skeleton showed (the data was already here)`);
				continue;
			}
			const c = compare(r.sketch, r.real);
			const ok = c.moved.length === 0 && c.leaked.length === 0 && r.cls < 0.001;
			if (!ok) failed++;
			console.log(
				`${ok ? "✓" : "✗"}  ${label}: ${c.compared} elements, ${c.moved.length} changed, ${c.leaked.length} stand-in texts, CLS ${r.cls.toFixed(4)}` +
					(c.onlySketch || c.onlyPage
						? ` (only in skeleton ${c.onlySketch}, only in page ${c.onlyPage})`
						: ""),
			);
			for (const m of c.moved.slice(0, args.verbose ? 40 : 4))
				console.log(
					`     moved ${m.k.replace(/^body/, "")}\n       skeleton ${fmt(m.a)}  page ${fmt(m.b)}${m.b.text ? `  "${m.b.text}"` : ""}`,
				);
			if (args.verbose)
				for (const k of Object.keys(r.real)
					.filter((k) => !r.sketch[k])
					.slice(0, 30))
					console.log(
						`     only in page ${k.replace(/^body/, "")} ${fmt(r.real[k])} "${r.real[k].text}"`,
					);
			for (const l of c.leaked.slice(0, 4))
				console.log(
					`     text  ${l.k.replace(/^body/, "")}: skeleton "${l.sketch}", page "${l.page}"`,
				);
		}
	}
}
await browser.close();
console.log(
	failed
		? `\n${failed} checks failed. Screenshots in ${out}/`
		: `\nEvery skeleton matches its page. Screenshots in ${out}/`,
);
process.exit(failed ? 1 : 0);

function fmt(r) {
	return `${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}×${r.h.toFixed(0)}`;
}
