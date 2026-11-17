#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook (.claude/settings.json): before a `git push`, runs the fast checks
 * that would otherwise only fail once main deploys: check-org-urls (the first step of `build` and
 * `deploy`) and Biome on the files the push carries. A step in CLAUDE.md gets skipped; a hook
 * doesn't. Budget: under 10 s.
 *
 * Typecheck, `bun run test` and `bun run check:skeletons` (Playwright against a running dev
 * server) stay the agent's job before pushing (CLAUDE.md).
 *
 * Exit 2 blocks the push and shows Claude why. To push anyway (a check is wrong, not the code),
 * prefix the command with SKIP_PUSH_CHECKS="<reason>"; the reason is printed so it's on record.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let input = {};
try {
	input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}
const command = String(input?.tool_input?.command ?? "");
if (!/(^|[\s;&|(])git\s+(-C\s+\S+\s+)?push\b/.test(command)) process.exit(0);

const skip = command.match(/SKIP_PUSH_CHECKS=("[^"]+"|'[^']+'|\S+)/);
if (skip) {
	console.error(`Push checks skipped: ${skip[1]}`);
	process.exit(0);
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const git = (...args) => {
	try {
		return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};
// The files this push carries: commits not yet on the remote, plus anything uncommitted.
const base = git("merge-base", "HEAD", "origin/main") || "HEAD";
const changed = [
	...new Set(
		[
			git("diff", "--name-only", "--diff-filter=d", base, "HEAD"),
			git("diff", "--name-only", "--diff-filter=d", "HEAD"),
		]
			.join("\n")
			.split("\n")
			.filter(Boolean),
	),
];

const failures = [];
const run = (label, cmd, args) => {
	const started = Date.now();
	const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (result.status !== 0)
		failures.push(
			`✗ ${label} (${seconds} s)\n${`${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-3000)}`,
		);
};

run("check-org-urls", process.execPath, ["scripts/check-org-urls.mjs"]);

const lintable = changed.filter(
	(f) => /\.(m?[jt]sx?|json|jsonc|css)$/.test(f) && existsSync(resolve(root, f)),
);
const biome = resolve(root, "node_modules/@biomejs/biome/bin/biome");
if (lintable.length && existsSync(biome))
	run("biome check (changed files)", process.execPath, [
		biome,
		"check",
		"--no-errors-on-unmatched",
		"--files-ignore-unknown=true",
		...lintable,
	]);

if (failures.length) {
	console.error(
		`Push blocked: these checks fail.\n\n${failures.join("\n\n")}\n\nFix the code, not the check. If a check itself is wrong, fix the check in its own commit.`,
	);
	process.exit(2);
}
