#!/usr/bin/env node
/**
 * The Mailroom CLI: the API from a terminal, with no dependencies (Node 18 or later).
 *
 *   MAILROOM_API_KEY=mr_… MAILROOM_URL=https://mailroom.example.com node cli/mailroom.mjs help
 *
 * Every command takes --json (print the API's answer as it is) and --brand <slug or id> (act on
 * one brand with an organization's key).
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { parseCsv } from "./csv.mjs";

const HELP = `mailroom <command> [options]

  send        --from <addr> --to <addr,…> --subject <s> [--text <t>] [--html <file|html>]
              [--template <id or alias> --var key=value …] [--reply-to <addr>] [--tag name=value …]
              [--cc …] [--bcc …] [--at <ISO time or "in 1 hour">]
  emails      [--status <s>] [--search <q>] [--limit <n>]      the latest sent emails
  email       <id>                                               one email, with its events
  received    [--search <q>] [--limit <n>]                       the latest received emails
  tail        [--received] [--every <seconds>]                   new emails as they happen
  templates                                                      the templates
  contacts    [--search <q>] [--segment <id>] [--limit <n>]      contacts
  import      <file.csv> [--segment <id>] [--topic <id>]         add or update contacts from a CSV
  broadcasts                                                     broadcasts and their state
  check       --subject <s> [--html <file|html>] [--text <t>] [--marketing]
  status                                                         can it send right now
  archive     [--kind emails|bodies|received] [--get <key>]      the long-term archive in R2

Environment: MAILROOM_API_KEY (required), MAILROOM_URL (default http://localhost:3000).
The CSV's first row names the columns: email (required), first_name, last_name, unsubscribed,
and anything else goes to the contact's properties.`;

const { values: o, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		json: { type: "boolean" },
		brand: { type: "string" },
		from: { type: "string" },
		to: { type: "string" },
		cc: { type: "string" },
		bcc: { type: "string" },
		"reply-to": { type: "string" },
		subject: { type: "string" },
		text: { type: "string" },
		html: { type: "string" },
		template: { type: "string" },
		var: { type: "string", multiple: true },
		tag: { type: "string", multiple: true },
		at: { type: "string" },
		status: { type: "string" },
		search: { type: "string" },
		segment: { type: "string" },
		topic: { type: "string" },
		limit: { type: "string" },
		received: { type: "boolean" },
		every: { type: "string" },
		kind: { type: "string" },
		get: { type: "string" },
		marketing: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	},
});

const BASE = (process.env.MAILROOM_URL ?? "http://localhost:3000").replace(/\/$/, "");
const KEY = process.env.MAILROOM_API_KEY;

const die = (message) => {
	console.error(`mailroom: ${message}`);
	process.exit(1);
};

async function api(method, path, body, query = {}) {
	if (!KEY) die("set MAILROOM_API_KEY (an API key from Mailroom › API keys)");
	const url = new URL(`${BASE}/api${path}`);
	for (const [k, v] of Object.entries({ ...query, brand: o.brand }))
		if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		method,
		headers: {
			authorization: `Bearer ${KEY}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	if (path === "/archive/file" && res.ok) return res;
	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = { message: text };
	}
	if (!res.ok)
		throw new Error(`${res.status} ${data?.message ?? data?.error?.message ?? res.statusText}`);
	return data;
}

const list = (v) =>
	v
		?.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

const pairs = (vs = []) =>
	Object.fromEntries(
		vs.map((v) => {
			const i = v.indexOf("=");
			if (i < 1) die(`${v}: give name=value`);
			return [v.slice(0, i), v.slice(i + 1)];
		}),
	);

/** --html takes a file's path or the HTML itself. */
async function htmlOf(v) {
	if (!v) return undefined;
	if (/^\s*</.test(v)) return v;
	return readFile(v, "utf8").catch(() => die(`can't read ${v}`));
}

const pad = (s, n) => {
	const t = String(s ?? "");
	return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
};
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");

function table(rows, columns) {
	if (!rows.length) return console.log("Nothing yet.");
	for (const r of rows)
		console.log(
			columns
				.map(([f, n]) => pad(f(r), n))
				.join("  ")
				.trimEnd(),
		);
}

function print(data, fallback) {
	if (o.json) return console.log(JSON.stringify(data, null, 2));
	fallback(data);
}

const emailRow = [
	[(r) => when(r.created_at), 22],
	[(r) => r.last_event ?? r.status, 13],
	[(r) => (Array.isArray(r.to) ? r.to.join(", ") : r.to), 30],
	[(r) => r.subject, 50],
	[(r) => r.id, 40],
];
const receivedRow = [
	[(r) => when(r.created_at), 22],
	[(r) => r.from, 30],
	[(r) => (Array.isArray(r.to) ? r.to.join(", ") : r.to), 30],
	[(r) => r.subject, 50],
	[(r) => r.id, 40],
];

const commands = {
	async send() {
		if (!o.from || !o.to || !(o.subject || o.template))
			die("send needs --from, --to and --subject (or --template)");
		const body = {
			from: o.from,
			to: list(o.to),
			...(o.cc ? { cc: list(o.cc) } : {}),
			...(o.bcc ? { bcc: list(o.bcc) } : {}),
			...(o["reply-to"] ? { reply_to: list(o["reply-to"]) } : {}),
			...(o.subject ? { subject: o.subject } : {}),
			...(o.template
				? { template: { id: o.template, variables: pairs(o.var) } }
				: {
						...(o.text ? { text: o.text } : {}),
						...(o.html ? { html: await htmlOf(o.html) } : {}),
					}),
			...(o.tag?.length
				? { tags: Object.entries(pairs(o.tag)).map(([name, value]) => ({ name, value })) }
				: {}),
			...(o.at ? { scheduled_at: o.at } : {}),
		};
		if (!o.template && !body.text && !body.html) die("send needs --text or --html");
		const r = await api("POST", "/emails", body);
		print(r, () => console.log(`${o.at ? "Scheduled" : "Queued"}: ${r.id}`));
	},

	async emails() {
		const r = await api("GET", "/emails", null, {
			status: o.status,
			search: o.search,
			limit: o.limit ?? 20,
		});
		print(r, () => table(r.data, emailRow));
	},

	async email(id) {
		if (!id) die("email needs an id");
		const r = await api("GET", `/emails/${encodeURIComponent(id)}`);
		print(r, () => {
			console.log(`${r.subject}\n${r.from} → ${(r.to ?? []).join(", ")}`);
			console.log(`${r.last_event ?? r.status}, created ${when(r.created_at)}  (${r.id})`);
			for (const e of r.events ?? [])
				console.log(
					`  ${pad(when(e.at ?? e.created_at), 22)}  ${e.type}  ${e.recipient ?? ""}`,
				);
		});
	},

	async received() {
		const r = await api("GET", "/emails/receiving", null, {
			search: o.search,
			limit: o.limit ?? 20,
		});
		print(r, () => table(r.data, receivedRow));
	},

	async tail() {
		const path = o.received ? "/emails/receiving" : "/emails";
		const every = Math.max(Number(o.every) || 5, 2) * 1000;
		const seen = new Map();
		let first = true;
		console.error(`Watching ${o.received ? "received" : "sent"} emails (Ctrl-C to stop)…`);
		for (;;) {
			const r = await api("GET", path, null, { limit: 50 });
			for (const e of [...r.data].reverse()) {
				const state = e.last_event ?? e.status ?? "received";
				if (seen.get(e.id) === state) continue;
				seen.set(e.id, state);
				if (first) continue;
				if (o.json) console.log(JSON.stringify(e));
				else
					console.log(
						(o.received ? receivedRow : emailRow)
							.map(([f, n]) => pad(f(e), n))
							.join("  ")
							.trimEnd(),
					);
			}
			if (seen.size > 2000) for (const k of [...seen.keys()].slice(0, 1000)) seen.delete(k);
			first = false;
			await new Promise((r) => setTimeout(r, every));
		}
	},

	async templates() {
		const r = await api("GET", "/templates");
		print(r, () =>
			table(r.data, [
				[(t) => t.name, 30],
				[(t) => t.alias ?? "", 20],
				[(t) => (t.published_at || t.status === "published" ? "published" : "draft"), 10],
				[(t) => when(t.updated_at), 22],
				[(t) => t.id, 40],
			]),
		);
	},

	async contacts() {
		const r = await api("GET", "/contacts", null, {
			search: o.search,
			segment_id: o.segment,
			limit: o.limit ?? 50,
		});
		print(r, () =>
			table(r.data, [
				[(c) => c.email, 34],
				[(c) => [c.first_name, c.last_name].filter(Boolean).join(" "), 26],
				[(c) => (c.unsubscribed ? "unsubscribed" : ""), 13],
				[(c) => c.id, 40],
			]),
		);
	},

	async import(file) {
		if (!file) die("import needs a CSV file");
		const rows = parseCsv(await readFile(file, "utf8").catch(() => die(`can't read ${file}`)));
		const [head, ...data] = rows;
		const cols = (head ?? []).map((h) =>
			h
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_|_$/g, ""),
		);
		const at = cols.findIndex((c) => c === "email" || c === "email_address" || c === "correo");
		if (at < 0) die("the CSV needs an email column");
		const known = { first_name: "first_name", firstname: "first_name", nombre: "first_name" };
		const last = { last_name: "last_name", lastname: "last_name", apellido: "last_name" };
		// Columns that aren't contact properties yet become text properties.
		const have = new Set((await api("GET", "/contact-properties")).data.map((p) => p.key));
		const reserved = ["email", "first_name", "last_name", "unsubscribed", "id"];
		for (const c of cols)
			if (
				/^[a-z][a-z0-9_]{0,63}$/.test(c) &&
				cols.indexOf(c) !== at &&
				!known[c] &&
				!last[c] &&
				!reserved.includes(c) &&
				!have.has(c)
			) {
				await api("POST", "/contact-properties", { key: c, type: "string" });
				console.error(`Added the contact property ${c}.`);
			}
		let created = 0;
		let updated = 0;
		const failed = [];
		const work = data.map((r) => () => {
			const contact = { email: r[at]?.trim(), properties: {} };
			cols.forEach((c, i) => {
				const v = r[i]?.trim();
				if (i === at || !c || v === undefined || v === "") return;
				if (known[c]) contact.first_name = v;
				else if (last[c]) contact.last_name = v;
				else if (c === "unsubscribed")
					contact.unsubscribed = /^(1|true|yes|si|sí)$/i.test(v);
				else if (/^[a-z]/.test(c)) contact.properties[c] = v;
			});
			if (!Object.keys(contact.properties).length) delete contact.properties;
			if (o.segment) contact.segments = [o.segment];
			if (o.topic) contact.topics = [{ id: o.topic, subscription: "opt_in" }];
			return api("POST", "/contacts", contact)
				.then((x) => (x.created ? created++ : updated++))
				.catch((e) => failed.push(`${contact.email}: ${e.message}`));
		});
		// Five at a time: quick, and inside the API's rate limit.
		const runners = Array.from({ length: 5 }, async () => {
			for (let w = work.shift(); w; w = work.shift()) await w();
		});
		await Promise.all(runners);
		const summary = { created, updated, failed: failed.length };
		print(summary, () => {
			console.log(`${basename(file)}: ${created} added, ${updated} updated.`);
			for (const f of failed) console.log(`  ${f}`);
		});
	},

	async broadcasts() {
		const r = await api("GET", "/broadcasts");
		print(r, () =>
			table(r.data, [
				[(b) => b.name ?? b.subject, 34],
				[(b) => b.status, 11],
				[(b) => when(b.sent_at ?? b.scheduled_at ?? b.created_at), 22],
				[(b) => b.id, 40],
			]),
		);
	},

	async check() {
		const r = await api("POST", "/emails/check", {
			subject: o.subject ?? "",
			html: await htmlOf(o.html),
			text: o.text,
			marketing: !!o.marketing,
		});
		print(r, () => {
			const findings = r.data ?? r.findings ?? [];
			if (!findings.length) return console.log("Nothing to fix.");
			for (const f of findings)
				console.log(`${f.level === "warning" ? "!" : "·"} ${f.message}`);
		});
	},

	async status() {
		const r = await api("GET", "/status");
		print(r, () => console.log(JSON.stringify(r, null, 2)));
	},

	async archive() {
		if (o.get) {
			const res = await api("GET", "/archive/file", null, { key: o.get });
			const name = o.get.split("/").slice(1).join("-");
			await writeFile(name, Buffer.from(await res.arrayBuffer()));
			return console.log(`Saved ${name}`);
		}
		const r = await api("GET", "/archive", null, { kind: o.kind, limit: o.limit ?? 100 });
		print(r, () => {
			if (!r.enabled && !r.data.length)
				return console.log(
					"The archive is off: turn it on in Mailroom › Settings › Archive.",
				);
			table(r.data, [
				[(f) => f.day, 11],
				[(f) => f.kind, 9],
				[(f) => (f.count ? `${f.count}` : ""), 7],
				[(f) => `${Math.ceil(f.size / 1024)} KB`, 9],
				[(f) => f.key, 90],
			]);
		});
	},
};

const [name, ...rest] = positionals;
if (o.help || !name || name === "help") console.log(HELP);
else if (!commands[name]) die(`no command ${name}; see mailroom help`);
else await commands[name](...rest).catch((e) => die(e.message));
