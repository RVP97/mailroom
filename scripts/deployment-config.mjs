#!/usr/bin/env node
/**
 * Your deployment's own values, kept out of the repo. `bun run deploy` runs this first.
 *
 * wrangler.jsonc in the repo is generic. Put what is yours (account_id, routes, the D1 and KV
 * ids, vars such as BETTER_AUTH_URL and ADMIN_EMAILS) in MAILROOM_WRANGLER_CONFIG, as JSON in
 * the shape of wrangler.jsonc: a Workers Builds variable (Settings › Build › Variables and
 * secrets) or an environment variable where you deploy. It is merged over wrangler.jsonc
 * (objects key by key, arrays and values replaced) and the result written to wrangler.jsonc,
 * which the build and Wrangler then read. In Workers Builds the checkout is thrown away; on
 * your own machine, don't commit the rewritten file (`git checkout wrangler.jsonc`).
 *
 * Without MAILROOM_WRANGLER_CONFIG, wrangler.jsonc is used as it is: edit it directly.
 * Either way, the deploy stops while BETTER_AUTH_URL is still the example's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const FILE = "wrangler.jsonc";

/** JSON with comments and trailing commas, as Wrangler reads it. */
function parse(name, text) {
	const { config, error } = ts.parseConfigFileTextToJson(name, text);
	if (error || !config || typeof config !== "object" || Array.isArray(config)) {
		const why = error
			? ts.flattenDiagnosticMessageText(error.messageText, "\n")
			: "not an object";
		throw new Error(`${name}: ${why}`);
	}
	return config;
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** `over` on top of `base`: nested objects merged, anything else replaced. */
export function merge(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over))
		out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
	return out;
}

function main() {
	const base = parse(FILE, readFileSync(FILE, "utf8"));
	const raw = process.env.MAILROOM_WRANGLER_CONFIG?.trim();
	let config = base;
	if (raw) {
		config = merge(base, parse("MAILROOM_WRANGLER_CONFIG", raw));
		writeFileSync(
			FILE,
			`// Written by scripts/deployment-config.mjs: the repo's wrangler.jsonc with MAILROOM_WRANGLER_CONFIG over it.\n${JSON.stringify(config, null, "\t")}\n`,
		);
		console.log(
			`deployment-config: merged MAILROOM_WRANGLER_CONFIG (${Object.keys(parse("", raw)).join(", ")}) into ${FILE}`,
		);
	} else console.log(`deployment-config: no MAILROOM_WRANGLER_CONFIG, ${FILE} as it is`);

	const url = config.vars?.BETTER_AUTH_URL ?? "";
	if (!url || /\bexample\.com\b/.test(url)) {
		console.error(
			`deployment-config: BETTER_AUTH_URL is "${url}". Set it (and ADMIN_EMAILS) in ${FILE} or MAILROOM_WRANGLER_CONFIG before deploying; see the README's Deploy section.`,
		);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) main();
