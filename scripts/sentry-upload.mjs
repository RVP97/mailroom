#!/usr/bin/env node
/**
 * Source maps for Sentry, in two steps around the deploy (package.json's build and deploy):
 *
 * `prepare`, after `vite build`: gives each built file and its source map a debug id (so Sentry
 * matches an error's frames to their map, the browser's and the Worker's alike), keeps a copy of
 * the browser's files and maps in dist/sentry-client and deletes the maps from dist/client, so
 * they're never served.
 *
 * `upload`, after `wrangler deploy`: sends dist/sentry-client and dist/server to Sentry. The site
 * is already live by then, so a slow upload (Workers Builds' network to Sentry can take minutes)
 * doesn't hold up the deploy. It gets UPLOAD_TIMEOUT_MS and never fails the build.
 *
 * Needs SENTRY_AUTH_TOKEN (a build secret in Workers Builds) and SENTRY_ORG, the organization's
 * slug (SENTRY_PROJECT if it isn't "mailroom"); without the token, `prepare` only deletes
 * the browser's maps and `upload` does nothing. The maps keep the app's own source (Sentry shows
 * the code around each line) but not the dependencies' (their frames still show file and line).
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const UPLOAD_TIMEOUT_MS = Number(process.env.SENTRY_UPLOAD_TIMEOUT_MS) || 300_000;
const ORG = process.env.SENTRY_ORG ?? "";
const PROJECT = process.env.SENTRY_PROJECT || "mailroom";
const CLIENT = "dist/client";
const SERVER = "dist/server";
/** The browser's built files and maps, for the upload: outside dist/client, so never served. */
const CLIENT_COPY = "dist/sentry-client";

const cli = path.join("node_modules", ".bin", "sentry-cli");
// sentry-cli's own update check: a network call nothing here needs.
const env = { ...process.env, SENTRY_DISABLE_UPDATE_CHECK: "true" };
const token = Boolean(process.env.SENTRY_AUTH_TOKEN);
const since = (start) => `${((Date.now() - start) / 1000).toFixed(1)}s`;

function release() {
	if (process.env.WORKERS_CI_COMMIT_SHA) return process.env.WORKERS_CI_COMMIT_SHA;
	try {
		return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		return "";
	}
}

/** Every file under dir whose name ends with one of the suffixes. */
function files(dir, suffixes, out = []) {
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory()) files(p, suffixes, out);
		else if (suffixes.some((s) => entry.name.endsWith(s))) out.push(p);
	}
	return out;
}

/** Drops the dependencies' source from the maps (node_modules), keeping the app's. */
function slimMaps() {
	for (const file of [...files(CLIENT, [".map"]), ...files(SERVER, [".map"])]) {
		const map = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(map.sourcesContent)) continue;
		map.sourcesContent = map.sourcesContent.map((content, i) =>
			String(map.sources?.[i] ?? "").includes("node_modules") ? null : content,
		);
		fs.writeFileSync(file, JSON.stringify(map));
	}
}

/** Copies the browser's .js and .map files to CLIENT_COPY, then deletes the maps from CLIENT. */
function setAsideClientMaps() {
	fs.rmSync(CLIENT_COPY, { recursive: true, force: true });
	const maps = files(CLIENT, [".map"]);
	if (token) {
		for (const file of [...files(CLIENT, [".js"]), ...maps]) {
			const to = path.join(CLIENT_COPY, path.relative(CLIENT, file));
			fs.mkdirSync(path.dirname(to), { recursive: true });
			fs.copyFileSync(file, to);
		}
	}
	for (const file of maps) fs.rmSync(file);
	if (maps.length)
		console.log(`sentry: ${maps.length} browser source maps taken out of ${CLIENT}`);
}

function prepare() {
	if (token) {
		try {
			const start = Date.now();
			execSync(`${cli} sourcemaps inject --quiet ${CLIENT} ${SERVER}`, {
				stdio: "ignore",
				env,
			});
			slimMaps();
			console.log(`sentry: debug ids injected in ${since(start)}`);
		} catch (error) {
			console.warn(
				"sentry: debug ids not injected",
				error instanceof Error ? error.message : error,
			);
		}
	} else console.log("sentry: no SENTRY_AUTH_TOKEN, source maps won't be uploaded");
	setAsideClientMaps();
}

function upload() {
	if (!token) return console.log("sentry: no SENTRY_AUTH_TOKEN, source maps not uploaded");
	if (!ORG) return console.warn("sentry: no SENTRY_ORG, source maps not uploaded");
	if (!fs.existsSync(CLIENT_COPY))
		return console.warn(`sentry: no ${CLIENT_COPY}, run \`sentry-upload.mjs prepare\` first`);
	const args = ["sourcemaps", "upload", "--org", ORG, "--project", PROJECT];
	const name = release();
	if (name) args.push("--release", name);
	args.push(CLIENT_COPY, SERVER);
	const start = Date.now();
	console.log("sentry: uploading source maps");
	return new Promise((resolve) => {
		// Its own process group: node_modules/.bin/sentry-cli is a wrapper that starts the binary,
		// and stopping only the wrapper would leave the upload running.
		const child = spawn(cli, args, { stdio: "inherit", env, detached: true });
		const timer = setTimeout(() => {
			console.warn(`sentry: upload stopped after ${since(start)}, not finished`);
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, UPLOAD_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			console.warn("sentry: upload failed to start", error.message);
			resolve();
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) console.log(`sentry: source maps uploaded in ${since(start)}`);
			else if (code !== null)
				console.warn(`sentry: upload failed (exit ${code}) after ${since(start)}`);
			resolve();
		});
	});
}

const step = process.argv[2];
if (step === "prepare") prepare();
else if (step === "upload") await upload();
else {
	console.error("usage: node scripts/sentry-upload.mjs prepare|upload");
	process.exit(1);
}
