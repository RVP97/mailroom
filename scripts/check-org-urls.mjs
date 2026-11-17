// An organization's pages live at /<handle>/… (src/lib/org-handle.ts). Run in the build: it fails
// when APP_SECTIONS / PERSON_PAGES (src/lib/org-path.ts) and src/routes/_app/ differ (a new page
// that would get no handle, or an old link that would no longer redirect), and when a public path
// (a route outside the dashboard, a file in public/, a path the Worker serves itself) is shaped
// like a handle, which would hide that organization's pages.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HANDLE = /^(?=[a-z]*[0-9])[a-z0-9]{6}$/;

/** The first URL segment of a route file's name (`contacts.forms.$id.tsx` → `contacts`). */
export function firstSegment(name) {
	const base = name.replace(/\.(tsx|ts)$/, "");
	return (base.split(".")[0] ?? "").replace(/\[|\]/g, "").replace(/_$/, "");
}

/** A `export const NAME … = new Set([...])` list's words, from a source file's text. */
export function listIn(source, name) {
	const body = (source.split(`export const ${name}`)[1] ?? "").split("]);")[0] ?? "";
	return new Set([...body.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]));
}

/**
 * What's wrong, as lines (none: fine). `appFiles`: the names in src/routes/_app/; `publicPaths`:
 * every other first segment the deployment answers.
 */
export function problems({ appFiles, publicPaths, appSections, personPages }) {
	const out = [];
	const sections = new Set(
		appFiles.map(firstSegment).filter((s) => s && s !== "index" && !personPages.has(s)),
	);
	const missing = [...sections].filter((s) => !appSections.has(s));
	const extra = [...appSections].filter((s) => !sections.has(s));
	const both = [...appSections].filter((s) => personPages.has(s));
	if (missing.length)
		out.push(
			`pages missing from APP_SECTIONS (or PERSON_PAGES, if they're about the person): ${missing.join(", ")}`,
		);
	if (extra.length) out.push(`APP_SECTIONS lists what isn't a page: ${extra.join(", ")}`);
	if (both.length) out.push(`in both APP_SECTIONS and PERSON_PAGES: ${both.join(", ")}`);
	const shaped = [...new Set([...publicPaths, ...appSections, ...personPages])].filter((s) =>
		HANDLE.test(s),
	);
	if (shaped.length)
		out.push(
			`shaped like an organization's handle (6 letters and digits with a digit), which would hide its pages; rename: ${shaped.join(", ")}`,
		);
	return out;
}

/** The first segments of the paths the Worker answers itself (src/server.ts). */
export function serverPaths(source) {
	const found = new Set();
	for (const m of source.matchAll(/["'`]\/([a-z0-9][a-z0-9-]*)/g)) found.add(m[1]);
	for (const m of source.matchAll(/\^\\\/([a-z0-9][a-z0-9-]*)/g)) found.add(m[1]);
	return found;
}

function run() {
	const routes = "src/routes";
	const appFiles = readdirSync(join(routes, "_app"));
	const publicPaths = new Set([
		...readdirSync(routes)
			.filter((n) => !n.startsWith("_") && !n.startsWith("$"))
			.map(firstSegment),
		...readdirSync("public").map((n) => n.split(".")[0]),
		...serverPaths(readFileSync("src/server.ts", "utf8")),
	]);
	const source = readFileSync("src/lib/org-path.ts", "utf8");
	const found = problems({
		appFiles,
		publicPaths: [...publicPaths],
		appSections: listIn(source, "APP_SECTIONS"),
		personPages: listIn(source, "PERSON_PAGES"),
	});
	if (found.length) {
		console.error(
			`check-org-urls: src/lib/org-path.ts and the routes disagree:\n${found.map((p) => `  ${p}`).join("\n")}`,
		);
		process.exit(1);
	}
	console.log("check-org-urls: ok");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
