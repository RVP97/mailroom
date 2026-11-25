import { and, eq, sql } from "drizzle-orm";
import type { Block, EmailDoc, PollAction } from "../lib/email-doc";
import { lookOf } from "../lib/newsletter-look";
import { type PollWords, pollWords, resolvePublicLocale } from "../lib/public-locale";
import { esc } from "../lib/signup-form-render";
import { fill } from "../lib/template-fill";
import { db, schema } from "./db";
import type { Dress } from "./newsletters";
import { dressBar, dressPage } from "./newsletters";
import { publicUrl } from "./public-host";
import { iso } from "./time";

/**
 * Polls in broadcasts: the editor's poll block is a question with one button per answer, each a
 * link to /poll/<broadcast>/<contact>/<signature>/<poll>/<answer>. A click records the answer
 * (a later click changes it), shows how everyone answered, and starts automations waiting for the
 * "poll.answered" event ({ broadcast_id, poll, question, answer }). The signature keeps anyone
 * from answering for someone else. The dashboard counts the answers and puts those who gave one
 * into a segment.
 */

const v = schema.pollVotes;

/** The start of a contact's poll links in one broadcast ({{{POLL_URL}}}). */
export async function pollBase(broadcastId: string, contactId: string) {
	const { sign } = await import("./inbound");
	return `${publicUrl()}/poll/${broadcastId}/${contactId}/${await sign(`poll:${broadcastId}:${contactId}`)}`;
}

type Poll = Extract<Block, { type: "poll" }>;

/** The poll blocks of a design (columns too). */
export function pollsIn(doc: EmailDoc | null | undefined): Poll[] {
	const out: Poll[] = [];
	for (const x of doc?.blocks ?? []) {
		if (x.type === "poll") out.push(x);
		if (x.type === "columns")
			for (const c of x.columns) for (const y of c) if (y.type === "poll") out.push(y);
	}
	return out;
}

/** Each poll of a broadcast with its answers counted. */
export async function pollResults(broadcastId: string, doc: EmailDoc | null | undefined) {
	const polls = pollsIn(doc);
	if (!polls.length) return [];
	const rows = await db
		.select({ poll: v.poll_id, answer: v.answer, n: sql<number>`COUNT(*)` })
		.from(v)
		.where(eq(v.broadcast_id, broadcastId))
		.groupBy(v.poll_id, v.answer);
	return polls.map((p) => {
		const counts = p.options.map((_, i) =>
			Number(rows.find((r) => r.poll === p.id && r.answer === i)?.n ?? 0),
		);
		return {
			id: p.id,
			question: p.question,
			options: p.options.map((label, i) => ({ label, votes: counts[i] ?? 0 })),
			total: counts.reduce((a, c) => a + c, 0),
		};
	});
}

/** Those who gave `answer` (or any, with null) to a poll, added to a segment. */
export async function votersToSegment(
	brand: string,
	broadcastId: string,
	pollId: string,
	answer: number | null,
	segmentId: string,
	now = Date.now(),
) {
	const { listSegmentOf } = await import("./contacts");
	await listSegmentOf(brand, segmentId);
	const res =
		await db.run(sql`INSERT OR IGNORE INTO contact_segments (contact_id, segment_id, created_at)
		SELECT pv.contact_id, ${segmentId}, ${iso(now)} FROM poll_votes pv
		JOIN contacts c ON c.id = pv.contact_id AND c.organization_id = ${brand}
		WHERE pv.broadcast_id = ${broadcastId} AND pv.poll_id = ${pollId}${answer === null ? sql`` : sql` AND pv.answer = ${answer}`}`);
	return { added: res.meta.changes ?? 0 };
}

const POLL_CSS = `
main{max-width:500px;margin:0 auto;padding:48px 16px 64px}
.box{background:var(--card);border:var(--bw) solid var(--line);border-radius:var(--r-card);padding:28px;box-shadow:var(--shadow)}
h1{margin:0 0 6px;font-size:22px;line-height:1.3;letter-spacing:-.01em}
.box>p{margin:0 0 20px;color:var(--soft);font-size:15px;line-height:1.55}
ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}
li a,li div{position:relative;display:block;overflow:hidden;border:1px solid var(--line);border-radius:var(--r-sm);padding:13px 16px;color:inherit;text-decoration:none;font-size:15px}
li a:hover{border-color:var(--mute)}
.bar{position:absolute;inset:0 auto 0 0;background:color-mix(in srgb,var(--accent) 14%,transparent);z-index:0;transition:width .6s ease}
.row{position:relative;z-index:1;display:flex;gap:12px;align-items:center}.row span:first-child{flex:1}
.row span:last-child{color:var(--soft);font-variant-numeric:tabular-nums;font-size:14px}
.mine{border-color:var(--accent)!important;font-weight:600}
.mine .row span:first-child::after{content:attr(data-yours);margin-left:8px;font:500 11px/1 var(--font);color:var(--on-accent);background:var(--accent);padding:3px 7px;border-radius:999px;vertical-align:2px}
.action-card{margin:0 0 20px;padding:18px;border-radius:var(--r-sm);background:color-mix(in srgb,var(--accent) 8%,transparent);border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);text-align:center}
.action-card p{margin:0 0 12px;color:inherit;font-size:15px;line-height:1.5;font-weight:500}
.action-card p:last-child{margin-bottom:0}
.box>p.note{margin:18px 0 0;font-size:13px;color:var(--mute)}
.back{display:block;margin-top:20px;text-align:center;font-size:14px;color:var(--soft)}`;

function page(d: Dress, title: string, body: string, status = 200, after = "") {
	return new Response(
		dressPage(d, {
			title,
			head: '<meta name="robots" content="noindex">',
			css: POLL_CSS,
			body: `${d.home ? dressBar(d) : ""}<main><div class="box">${body}</div>${after}</main>`,
		}),
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy":
					"default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:",
			},
		},
	);
}

/** A broadcast's newsletter's dress (or its brand's, for a one-off; plain when unknown). */
async function dressFor(x: { organization_id: string; newsletter_id: string | null } | null) {
	const { dressOf } = await import("./newsletters");
	if (!x) return plain();
	const n = x.newsletter_id
		? ((await db
				.select()
				.from(schema.newsletters)
				.where(eq(schema.newsletters.id, x.newsletter_id))
				.get()) ?? null)
		: null;
	return dressOf(n, x.organization_id);
}

const plain = (): Dress => ({
	look: lookOf(null),
	accent: null,
	logo: null,
	brand: "",
	name: "",
	home: null,
	subscribe: false,
});

const isPrefetch = (request: Request) => {
	const purpose = (
		request.headers.get("sec-purpose") ??
		request.headers.get("purpose") ??
		request.headers.get("x-purpose") ??
		request.headers.get("x-moz") ??
		""
	).toLowerCase();
	return purpose.includes("prefetch") || purpose.includes("preview");
};

function pollPlaceholders(
	contact: {
		email: string;
		first_name: string | null;
		last_name: string | null;
		properties: Record<string, string | number> | null;
	},
	encode = false,
): Record<string, string> {
	const enc = (v: string) => (encode ? encodeURIComponent(v) : v);
	const values: Record<string, string> = {
		EMAIL: enc(contact.email),
		FIRST_NAME: enc(contact.first_name ?? ""),
		LAST_NAME: enc(contact.last_name ?? ""),
	};
	for (const [k, val] of Object.entries(contact.properties ?? {}))
		values[`contact.${k}`] = enc(String(val ?? ""));
	return values;
}

function renderActionCard(
	action: PollAction | null | undefined,
	contact: {
		email: string;
		first_name: string | null;
		last_name: string | null;
		properties: Record<string, string | number> | null;
	},
	w: PollWords,
): string {
	if (!action) return "";
	const msg = action.message ? fill(action.message, pollPlaceholders(contact, false)).trim() : "";
	const rawUrl = action.cta_url
		? fill(action.cta_url, pollPlaceholders(contact, true)).trim()
		: "";
	const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
	const label = action.cta_label
		? fill(action.cta_label, pollPlaceholders(contact, false)).trim()
		: w.openLink;
	if (!msg && !safeUrl) return "";
	return `<div class="action-card">${msg ? `<p>${esc(msg)}</p>` : ""}${safeUrl ? `<a class="mrw-btn" href="${esc(safeUrl)}">${esc(label || w.openLink)}</a>` : ""}</div>`;
}

const results = (
	p: { question: string; options: { label: string; votes: number }[]; total: number },
	mine: number | null,
	link: (i: number) => string | null,
	w: PollWords = pollWords("en"),
	actionCard = "",
) =>
	`${actionCard}<h1>${esc(p.question)}</h1><p>${esc(mine === null ? w.pick : w.thanks)}</p><ol>${p.options
		.map((o, i) => {
			const pct = p.total ? Math.round((o.votes / p.total) * 100) : 0;
			const inner = `<span class="bar" style="width:${mine === null ? 0 : pct}%"></span><span class="row"><span data-yours="${esc(w.yourAnswer)}">${esc(o.label)}</span>${mine === null ? "" : `<span>${pct}%</span>`}</span>`;
			const href = link(i);
			return `<li>${href ? `<a href="${esc(href)}" class="${i === mine ? "mine" : ""}">${inner}</a>` : `<div class="${i === mine ? "mine" : ""}">${inner}</div>`}</li>`;
		})
		.join("")}</ol>${mine !== null ? `<p class="note">${esc(w.changed)}</p>` : ""}`;

/** /poll/<broadcast>/<contact>/<signature>/<poll>/<answer>, and /poll/web/<broadcast> (the web version's). */
export async function handlePoll(request: Request, now = Date.now()): Promise<Response> {
	const u = new URL(request.url);
	const acceptLang = request.headers.get("accept-language");
	const defaultWords = pollWords(resolvePublicLocale(null, acceptLang));
	const web = /^\/poll\/web\/([0-9a-f-]{36})(?:\/|$)/.exec(u.pathname);
	if (web) {
		const x = await db
			.select({
				organization_id: schema.broadcasts.organization_id,
				newsletter_id: schema.broadcasts.newsletter_id,
			})
			.from(schema.broadcasts)
			.where(eq(schema.broadcasts.id, web[1] as string))
			.get();
		const d = await dressFor(x ?? null);
		return page(
			d,
			defaultWords.fromEmailTitle,
			`<h1>${esc(defaultWords.fromEmailTitle)}</h1><p>${esc(defaultWords.fromEmailBody)}</p>${d.subscribe && d.home ? `<a class="mrw-btn" href="${esc(d.home)}#subscribe">Subscribe to ${esc(d.name)}</a>` : ""}`,
		);
	}
	const m =
		/^\/poll\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{10,40})\/([\w-]{1,40})(?:\/(\d{1,2}))?$/.exec(
			u.pathname,
		);
	const bad = () =>
		page(
			plain(),
			defaultWords.notFoundTitle,
			`<h1>${esc(defaultWords.notFoundTitle)}</h1><p>${esc(defaultWords.notFoundBody)}</p>`,
			404,
		);
	if (!m) return bad();
	const [, broadcastId, contactId, signature, pollId, raw] = m as unknown as string[];
	const { sign } = await import("./inbound");
	const expected = await sign(`poll:${broadcastId}:${contactId}`);
	let diff = expected.length ^ (signature as string).length;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ ((signature as string).charCodeAt(i) || 0);
	if (diff) return bad();
	const x = await db
		.select({
			id: schema.broadcasts.id,
			organization_id: schema.broadcasts.organization_id,
			newsletter_id: schema.broadcasts.newsletter_id,
			slug: schema.broadcasts.slug,
			web: schema.broadcasts.web,
			design: schema.broadcasts.design,
		})
		.from(schema.broadcasts)
		.where(eq(schema.broadcasts.id, broadcastId as string))
		.get();
	const poll = pollsIn(x?.design).find((p) => p.id === pollId);
	if (!x || !poll) return bad();
	const contact = await db
		.select({
			id: schema.contacts.id,
			email: schema.contacts.email,
			first_name: schema.contacts.first_name,
			last_name: schema.contacts.last_name,
			properties: schema.contacts.properties,
		})
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.id, contactId as string),
				eq(schema.contacts.organization_id, x.organization_id),
			),
		)
		.get();
	if (!contact) return bad();
	const w = pollWords(
		resolvePublicLocale(contact.properties?.lang ?? contact.properties?.locale, acceptLang),
	);
	const base = `${publicUrl()}/poll/${broadcastId}/${contactId}/${signature}/${pollId}`;
	let mine: number | null = null;
	const answer = raw === undefined ? null : Number(raw);
	if (
		answer !== null &&
		answer >= 0 &&
		answer < poll.options.length &&
		request.method === "GET" &&
		!isPrefetch(request)
	) {
		const before = await db
			.select({ answer: v.answer })
			.from(v)
			.where(
				and(eq(v.broadcast_id, x.id), eq(v.poll_id, poll.id), eq(v.contact_id, contact.id)),
			)
			.get();
		await db
			.insert(v)
			.values({
				broadcast_id: x.id,
				poll_id: poll.id,
				contact_id: contact.id,
				answer,
				created_at: iso(now),
			})
			.onConflictDoUpdate({
				target: [v.broadcast_id, v.poll_id, v.contact_id],
				set: { answer, created_at: iso(now) },
			});
		mine = answer;
		// Optional explicit contact property mapping (quoted JSON path so keys stay safe).
		if (poll.save_property && /^[a-z][a-z0-9_]{0,63}$/.test(poll.save_property)) {
			const label = poll.options[answer] ?? String(answer);
			const path = `$."${poll.save_property}"`;
			await db
				.insert(schema.contactProperties)
				.values({
					id: crypto.randomUUID(),
					organization_id: x.organization_id,
					key: poll.save_property,
					type: "string",
					fallback_value: null,
					created_at: iso(now),
				})
				.onConflictDoNothing()
				.catch(() => {});
			await db
				.update(schema.contacts)
				.set({
					properties: sql`json_set(coalesce(${schema.contacts.properties}, '{}'), ${path}, ${label})`,
					updated_at: iso(now),
				})
				.where(eq(schema.contacts.id, contact.id))
				.catch((e) => console.error("polls: property update failed", e));
			contact.properties = { ...(contact.properties ?? {}), [poll.save_property]: label };
		}
		if (before?.answer !== answer) {
			const { recordEvent } = await import("./automations");
			await recordEvent(
				x.organization_id,
				{
					event: "poll.answered",
					contact_id: contact.id,
					create_contact: false,
					data: {
						broadcast_id: x.id,
						poll: poll.id,
						question: poll.question,
						answer: poll.options[answer],
					},
				},
				now,
				"mailroom",
			).catch((e) => console.error("polls: event failed", e));
		}
	} else {
		const had = await db
			.select({ answer: v.answer })
			.from(v)
			.where(
				and(eq(v.broadcast_id, x.id), eq(v.poll_id, poll.id), eq(v.contact_id, contact.id)),
			)
			.get();
		mine = had?.answer ?? null;
	}
	const [counted] = (await pollResults(x.id, {
		version: 1,
		theme: {} as never,
		blocks: [poll],
	})) as [Awaited<ReturnType<typeof pollResults>>[number]];
	const d = await dressFor(x);
	const { webUrl } = await import("./newsletters");
	const issue = webUrl(x, d.home ? { slug: d.home.split("/n/")[1] ?? "", public: true } : null);
	const actionCard = mine !== null ? renderActionCard(poll.actions?.[mine], contact, w) : "";
	return page(
		d,
		poll.question,
		results(counted, mine, (i) => `${base}/${i}`, w, actionCard),
		200,
		`<a class="back" href="${esc(issue)}">${esc(w.readOnline)}</a>`,
	);
}
