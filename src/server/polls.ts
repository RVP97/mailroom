import { and, eq, sql } from "drizzle-orm";
import type { Block, EmailDoc } from "../lib/email-doc";
import { lookOf } from "../lib/newsletter-look";
import { esc } from "../lib/signup-form-render";
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
	const { segmentOf } = await import("./contacts");
	await segmentOf(brand, segmentId);
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
.mine .row span:first-child::after{content:"Your answer";margin-left:8px;font:500 11px/1 var(--font);color:var(--on-accent);background:var(--accent);padding:3px 7px;border-radius:999px;vertical-align:2px}
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

const results = (
	p: { question: string; options: { label: string; votes: number }[]; total: number },
	mine: number | null,
	link: (i: number) => string | null,
) =>
	`<h1>${esc(p.question)}</h1><p>${mine === null ? "Pick an answer." : "Thanks, your answer is in. Here's how everyone answered so far."}</p><ol>${p.options
		.map((o, i) => {
			const pct = p.total ? Math.round((o.votes / p.total) * 100) : 0;
			const inner = `<span class="bar" style="width:${mine === null ? 0 : pct}%"></span><span class="row"><span>${esc(o.label)}</span>${mine === null ? "" : `<span>${pct}%</span>`}</span>`;
			const href = link(i);
			return `<li>${href ? `<a href="${esc(href)}" class="${i === mine ? "mine" : ""}">${inner}</a>` : `<div class="${i === mine ? "mine" : ""}">${inner}</div>`}</li>`;
		})
		.join(
			"",
		)}</ol>${mine !== null ? '<p class="note">Changed your mind? Pick another answer.</p>' : ""}`;

/** /poll/<broadcast>/<contact>/<signature>/<poll>/<answer>, and /poll/web/<broadcast> (the web version's). */
export async function handlePoll(request: Request, now = Date.now()): Promise<Response> {
	const u = new URL(request.url);
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
			"Answer from your email",
			`<h1>Answer from your email</h1><p>This poll counts answers from the email it came in: open it there and pick your answer.</p>${d.subscribe && d.home ? `<a class="mrw-btn" href="${esc(d.home)}#subscribe">Subscribe to ${esc(d.name)}</a>` : ""}`,
		);
	}
	const m =
		/^\/poll\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{10,40})\/([\w-]{1,40})(?:\/(\d{1,2}))?$/.exec(
			u.pathname,
		);
	const bad = () =>
		page(
			plain(),
			"Poll not found",
			"<h1>This poll isn't available</h1><p>The link may be incomplete.</p>",
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
		.select({ id: schema.contacts.id })
		.from(schema.contacts)
		.where(
			and(
				eq(schema.contacts.id, contactId as string),
				eq(schema.contacts.organization_id, x.organization_id),
			),
		)
		.get();
	if (!contact) return bad();
	const base = `${publicUrl()}/poll/${broadcastId}/${contactId}/${signature}/${pollId}`;
	let mine: number | null = null;
	const answer = raw === undefined ? null : Number(raw);
	if (
		answer !== null &&
		answer >= 0 &&
		answer < poll.options.length &&
		request.method === "GET"
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
	return page(
		d,
		poll.question,
		results(counted, mine, (i) => `${base}/${i}`),
		200,
		`<a class="back" href="${esc(issue)}">Read the issue online</a>`,
	);
}
