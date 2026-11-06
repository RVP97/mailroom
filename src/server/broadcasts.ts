import { and, asc, desc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { parseDoc, renderEmail } from "../lib/email-doc";
import { fill, htmlToText } from "../lib/template-fill";
import { LOCAL, localSpan, validZone, zonedInstant } from "../lib/zoned";
import { bareAddress } from "./aws/mime";
import {
	ALL_BROADCASTS_GROUP,
	type Contact,
	contactValues,
	segmentOf,
	topicGroup,
	topicOf,
} from "./contacts";
import { batch, db, schema } from "./db";
import type { BroadcastStatus } from "./db/schema";
import { timezone } from "./env";
import { ApiError, notFound, validation } from "./errors";
import { domainFor, orgContext } from "./org";
import type { StoredContent } from "./send";
import { designFilled, getTemplate, variableValues } from "./templates";
import { iso } from "./time";

/**
 * Broadcasts, as Resend's: one email to a segment of a brand's contacts, now or at a time. Sending
 * turns it into one queued email per contact, CHUNK at a time (the cron goes on each minute), and
 * the Dispatcher sends them at the account's rate like any batch. Their content isn't stored per
 * email: it's the broadcast's, with each contact's {{{FIRST_NAME}}}, {{{contact.<key>}}}… filled
 * in when it goes. Left out: unsubscribed contacts, those out of the broadcast's topic and
 * suppressed addresses. The unsubscribe link leaves the topic (or every broadcast, without one).
 */

const CHUNK = 1000;
/** Emails a statement inserts (D1 takes 100 parameters a statement; an email takes 18 with its defaults). */
const PER_INSERT = 5;

export type Broadcast = typeof schema.broadcasts.$inferSelect;
const b = schema.broadcasts;
const ct = schema.contacts;

const addresses = z
	.union([z.string().max(320), z.array(z.string().max(320)).max(50)])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export const broadcastInput = z.object({
	name: z.string().trim().max(200).nullish(),
	segment_id: z.string().nullish(),
	segmentId: z.string().nullish(),
	audience_id: z.string().nullish(),
	audienceId: z.string().nullish(),
	topic_id: z.string().nullish(),
	topicId: z.string().nullish(),
	from: z.string().trim().max(320).nullish(),
	subject: z.string().max(998).nullish(),
	reply_to: addresses.nullish(),
	replyTo: addresses.nullish(),
	preview_text: z.string().max(300).nullish(),
	previewText: z.string().max(300).nullish(),
	html: z.string().max(512_000).nullish(),
	text: z.string().max(512_000).nullish(),
	/** Blocks from the visual editor (src/lib/email-doc.ts): html is made from them. */
	design: z.unknown().nullish(),
	template: z
		.object({ id: z.string(), variables: z.record(z.string(), z.unknown()).optional() })
		.nullish(),
	scheduled_at: z.string().nullish(),
	scheduledAt: z.string().nullish(),
	/** An issue of this newsletter (null: a one-off campaign). */
	newsletter_id: z.string().max(100).nullish(),
	/** An issue is on the newsletter's public archive once sent (true unless set false). */
	web: z.boolean().optional(),
	/** One of this campaign's emails. */
	campaign_id: z.string().max(100).nullish(),
	/** Leave out contacts another email of the campaign already went to. */
	campaign_dedupe: z.boolean().optional(),
	/** Send (or schedule) right away instead of keeping a draft. */
	send: z.boolean().optional(),
});

export const broadcastView = (x: Broadcast) => ({
	object: "broadcast",
	id: x.id,
	brand_id: x.organization_id,
	name: x.name,
	segment_id: x.segment_id,
	/** Resend's older name. */
	audience_id: x.segment_id,
	topic_id: x.topic_id,
	from: x.from,
	subject: x.subject,
	reply_to: x.reply_to,
	preview_text: x.preview_text,
	html: x.html,
	text: x.text,
	design: x.design ?? null,
	ab_test: x.ab_test ?? null,
	test_ends_at: x.test_ends_at,
	local_time: x.local_time,
	resend_of: x.resend_of,
	template_id: x.template_id,
	newsletter_id: x.newsletter_id,
	web: x.web,
	slug: x.slug,
	campaign_id: x.campaign_id,
	campaign_dedupe: x.campaign_dedupe,
	status: x.status,
	scheduled_at: x.scheduled_at,
	sent_at: x.started_at,
	completed_at: x.completed_at,
	queued: x.queued,
	error: x.error,
	/** Its review: "requested" | "approved" | "changes" | null (src/server/reviews.ts). */
	review: x.review ?? null,
	review_requested_by: x.review_requested_by ?? null,
	reviewed_by: x.reviewed_by ?? null,
	reviewed_at: x.reviewed_at ?? null,
	created_at: x.created_at,
	updated_at: x.updated_at,
});

export async function getBroadcast(brands: string | string[], id: string): Promise<Broadcast> {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(b)
		.where(and(eq(b.id, id), inArray(b.organization_id, list)))
		.get();
	if (!row) throw notFound("Broadcast");
	return row;
}

export async function listBroadcasts(brands: string[], o: { limit?: number } = {}) {
	return db
		.select()
		.from(b)
		.where(inArray(b.organization_id, brands))
		.orderBy(desc(b.created_at))
		.limit(Math.min(o.limit ?? 100, 200));
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const preheader = (text: string) =>
	`<div style="display:none;max-height:0;overflow:hidden;mso-hide:all" aria-hidden="true">${text.replace(/[<>&]/g, "")}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;

/** The fields a create or a change sets, with a template's content copied in. */
async function fieldsOf(organizationId: string, brand: string, v: z.output<typeof broadcastInput>) {
	const out: Partial<Broadcast> = {};
	const segment = v.segment_id ?? v.segmentId ?? v.audience_id ?? v.audienceId;
	if (segment !== undefined) {
		if (segment) await segmentOf(brand, segment);
		out.segment_id = segment || null;
	}
	const topic = v.topic_id ?? v.topicId;
	if (topic !== undefined) {
		if (topic) await topicOf(brand, topic);
		out.topic_id = topic || null;
	}
	if (v.template) {
		if (v.html != null || v.text != null)
			throw validation("template: html and text come from the template; leave them out");
		const t = await getTemplate(organizationId, v.template.id).catch(() => {
			throw validation(`template.id: no template ${v.template?.id}`);
		});
		if (!t.published) throw validation(`template.id: ${t.name} isn't published yet`);
		const p = t.published;
		// The template's own variables now; the contact's ({{{FIRST_NAME}}}…) as each email goes.
		const values = variableValues(p.variables, v.template.variables);
		out.template_id = t.id;
		out.html = fill(p.html, values);
		out.design = p.design ? designFilled(p.design, values) : null;
		if (out.design) out.html = renderEmail(out.design);
		out.text = p.text ? fill(p.text, values) : p.text === "" ? "" : null;
		if (p.subject) out.subject = fill(p.subject, values);
		if (p.from) out.from = p.from;
		if (p.reply_to) out.reply_to = p.reply_to;
	}
	if (v.newsletter_id !== undefined) {
		if (v.newsletter_id) {
			const n = await db
				.select({ id: schema.newsletters.id })
				.from(schema.newsletters)
				.where(
					and(
						eq(schema.newsletters.id, v.newsletter_id),
						eq(schema.newsletters.organization_id, brand),
					),
				)
				.get();
			if (!n) throw validation("newsletter_id: no such newsletter in this brand");
		}
		out.newsletter_id = v.newsletter_id || null;
	}
	if (v.web !== undefined) out.web = v.web;
	if (v.campaign_id !== undefined) {
		if (v.campaign_id) {
			const { getCampaign } = await import("./campaigns");
			await getCampaign(brand, v.campaign_id).catch(() => {
				throw validation("campaign_id: no such campaign in this brand");
			});
		}
		out.campaign_id = v.campaign_id || null;
		if (!v.campaign_id) out.campaign_dedupe = false;
	}
	if (v.campaign_dedupe !== undefined) out.campaign_dedupe = v.campaign_dedupe;
	if (v.name !== undefined) out.name = v.name || "";
	if (v.from != null) out.from = v.from;
	if (v.subject != null) out.subject = v.subject;
	const replyTo = v.reply_to ?? v.replyTo;
	if (replyTo !== undefined) out.reply_to = replyTo?.length ? replyTo : null;
	const pre = v.preview_text ?? v.previewText;
	if (pre !== undefined) out.preview_text = pre || null;
	if (v.html != null) {
		out.html = v.html;
		// HTML set by itself no longer matches a design.
		if (v.design === undefined) out.design = null;
	}
	if (v.design !== undefined && !v.template) {
		const doc = v.design === null ? null : parseDoc(v.design);
		if (v.design !== null && !doc) throw validation("design: not a design from the editor");
		out.design = doc;
		if (doc) out.html = renderEmail(doc);
	}
	if (v.text !== undefined && !v.template) out.text = v.text;
	return out;
}

export async function createBroadcast(
	organizationId: string,
	brand: string,
	raw: unknown,
	now = Date.now(),
	by: string | null = null,
) {
	const v = broadcastInput.parse(raw);
	const fields = await fieldsOf(organizationId, brand, v);
	const row: Broadcast = {
		review: null,
		review_requested_by: null,
		review_requested_at: null,
		reviewed_by: null,
		reviewed_at: null,
		review_hash: null,
		created_by: by,
		updated_by: by,
		id: crypto.randomUUID(),
		organization_id: brand,
		name: fields.name || fields.subject || "Untitled broadcast",
		segment_id: fields.segment_id ?? null,
		topic_id: fields.topic_id ?? null,
		from: fields.from ?? "",
		subject: fields.subject ?? "",
		reply_to: fields.reply_to ?? null,
		preview_text: fields.preview_text ?? null,
		html: fields.html ?? "",
		text: fields.text ?? null,
		design: fields.design ?? null,
		ab_test: null,
		test_ends_at: null,
		local_time: null,
		resend_of: null,
		template_id: fields.template_id ?? null,
		newsletter_id: fields.newsletter_id ?? null,
		web: fields.web ?? true,
		slug: null,
		rss_items: null,
		campaign_id: fields.campaign_id ?? null,
		campaign_dedupe: fields.campaign_dedupe ?? false,
		status: "draft",
		scheduled_at: null,
		cursor: null,
		queued: 0,
		started_at: null,
		completed_at: null,
		error: null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(b).values(row);
	if (v.send) return sendBroadcast(brand, row.id, v.scheduled_at ?? v.scheduledAt, now);
	return row;
}

/** A new draft with another broadcast's content and audience (any status), not its sending. */
export async function duplicateBroadcast(
	brands: string | string[],
	id: string,
	now = Date.now(),
	by: string | null = null,
) {
	const x = await getBroadcast(brands, id);
	const row: Broadcast = {
		...x,
		id: crypto.randomUUID(),
		name: `${x.name || x.subject || "Untitled broadcast"} (copy)`.slice(0, 200),
		review: null,
		review_requested_by: null,
		review_requested_at: null,
		reviewed_by: null,
		reviewed_at: null,
		review_hash: null,
		created_by: by,
		updated_by: by,
		ab_test: null,
		test_ends_at: null,
		local_time: null,
		resend_of: null,
		slug: null,
		rss_items: null,
		status: "draft",
		scheduled_at: null,
		cursor: null,
		queued: 0,
		started_at: null,
		completed_at: null,
		error: null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(b).values(row);
	return row;
}

/** A draft's fields (a sent one can't change). */
export async function updateBroadcast(
	organizationId: string,
	brand: string,
	id: string,
	raw: unknown,
	now = Date.now(),
	by: string | null = null,
) {
	const x = await getBroadcast(brand, id);
	if (x.status !== "draft")
		throw new ApiError(409, "not_draft", "Only a draft broadcast can be changed");
	const v = broadcastInput.partial().parse(raw ?? {});
	const fields = await fieldsOf(organizationId, brand, v);
	// Only while it's still a draft: a send or schedule in between wins.
	const [row] = await db
		.update(b)
		.set({ ...fields, updated_at: iso(now), ...(by ? { updated_by: by } : {}) })
		.where(and(eq(b.id, id), eq(b.status, "draft")))
		.returning();
	if (!row) throw new ApiError(409, "not_draft", "Only a draft broadcast can be changed");
	const saved = row as Broadcast;
	// An approval holds for what was approved: a change to what people get asks again.
	const { contentHash } = await import("./reviews");
	if (saved.review === "approved" && (await contentHash(saved)) !== saved.review_hash) {
		const [again] = await db
			.update(b)
			.set({ review: null, review_hash: null })
			.where(eq(b.id, id))
			.returning();
		return again as Broadcast;
	}
	return saved;
}

export async function deleteBroadcast(brand: string, id: string) {
	const x = await getBroadcast(brand, id);
	if (x.status !== "draft" && x.status !== "scheduled")
		throw new ApiError(
			409,
			"already_sent",
			"Only a draft or scheduled broadcast can be deleted; cancel one that's sending",
		);
	// A scheduled one that started queueing in between is sending now: it stays.
	const gone = await db
		.delete(b)
		.where(and(eq(b.id, id), inArray(b.status, ["draft", "scheduled"])))
		.returning({ id: b.id });
	if (!gone.length)
		throw new ApiError(
			409,
			"already_sent",
			"Only a draft or scheduled broadcast can be deleted; cancel one that's sending",
		);
	return x;
}

/** Why a broadcast can't go yet, or null. */
async function notReady(x: Broadcast): Promise<string | null> {
	if (!x.segment_id) return "Pick a segment to send it to";
	if (!x.from.trim()) return "It needs a From address";
	if (!x.subject.trim()) return "It needs a subject";
	if (!x.html.trim() && !x.text?.trim()) return "It needs content";
	const ctx = await orgContext(x.organization_id);
	if (!ctx.ready) return "This brand isn't set up for sending yet (Brands › Set up sending)";
	const domain = domainFor(ctx, bareAddress(x.from).toLowerCase());
	if (!domain)
		return `${bareAddress(x.from).split("@")[1]} isn't one of this brand's sending domains`;
	if (!domain.verified) return `${domain.name} isn't verified yet`;
	return null;
}

export const abTestInput = z.object({
	subjects: z.array(z.string().trim().min(1).max(998)).min(1).max(2),
	metric: z.enum(["opens", "clicks"]).default("opens"),
	size: z.number().int().min(10).max(50).default(20),
	wait_minutes: z.number().int().min(30).max(2880).default(240),
});

export const sendOptions = z.object({
	/** Test other subject lines on part of the segment first; the winner goes to the rest. */
	ab_test: abTestInput.nullish(),
	/** Send at this wall-clock time (2026-11-10T09:00) in each contact's time zone. */
	local_time: z.string().regex(LOCAL, "local_time looks like 2026-11-10T09:00").nullish(),
});

/** Sends now, or at `at` (up to 30 days ahead); optionally as an A/B test or at local time. */
export async function sendBroadcast(
	brand: string,
	id: string,
	at?: string | null,
	now = Date.now(),
	options: z.input<typeof sendOptions> = {},
) {
	const x = await getBroadcast(brand, id);
	if (x.status !== "draft" && x.status !== "scheduled")
		throw new ApiError(409, "already_sent", "This broadcast was already sent");
	const why = await notReady(x);
	if (why) throw validation(why);
	// Every way of sending (dashboard, API, MCP, a newsletter's RSS) passes the approval check.
	const [{ assertApproved }, { orgOf }] = await Promise.all([
		import("./reviews"),
		import("./brands"),
	]);
	await assertApproved(await orgOf(x.organization_id), x);
	const o = sendOptions.parse(options);
	if (o.ab_test && o.local_time)
		throw validation("An A/B test can't also go at each contact's local time");
	if (o.ab_test && x.resend_of) throw validation("A resend can't be an A/B test");
	let when = now;
	if (o.local_time) {
		const { first, last } = localSpan(o.local_time);
		if (last < now) throw validation("local_time has already passed everywhere");
		when = first;
		if (when > now + 30 * 86_400_000) throw validation("local_time can be up to 30 days ahead");
	} else if (at) {
		when = Date.parse(at);
		if (Number.isNaN(when)) throw validation("scheduled_at must be an ISO 8601 date");
		if (when > now + 30 * 86_400_000)
			throw validation("scheduled_at can be up to 30 days ahead");
	}
	if (x.newsletter_id) {
		const { assignSlug } = await import("./newsletters");
		await assignSlug(x);
	}
	const [row] = await db
		.update(b)
		.set({
			status: "scheduled",
			scheduled_at: iso(Math.max(when, now)),
			ab_test: o.ab_test ? { ...o.ab_test, winner: null } : null,
			test_ends_at: null,
			local_time: o.local_time ?? null,
			updated_at: iso(now),
		})
		// Still a draft or not started: the cron may have begun queueing it in between.
		.where(and(eq(b.id, id), inArray(b.status, ["draft", "scheduled"])))
		.returning();
	if (!row) throw new ApiError(409, "already_sent", "This broadcast was already sent");
	return row as Broadcast;
}

/**
 * A new draft of the same email for those who didn't open (or click) this sent one, with
 * another subject: Kit's "resend to unopens".
 */
export async function resendBroadcast(
	brand: string,
	id: string,
	o: { subject?: string | null; name?: string | null } = {},
	now = Date.now(),
) {
	const x = await getBroadcast(brand, id);
	if (x.status !== "sent")
		throw new ApiError(409, "not_sent", "Only a broadcast that finished sending can be resent");
	const winner = x.ab_test?.winner;
	const subject =
		o.subject?.trim() || (winner ? x.ab_test?.subjects[winner - 1] : undefined) || x.subject;
	const row: Broadcast = {
		...x,
		id: crypto.randomUUID(),
		name: (o.name?.trim() || `${x.name} (to those who didn't open)`).slice(0, 200),
		subject,
		status: "draft",
		scheduled_at: null,
		cursor: null,
		queued: 0,
		started_at: null,
		completed_at: null,
		error: null,
		ab_test: null,
		test_ends_at: null,
		local_time: null,
		resend_of: x.id,
		// The issue is on the archive once, as the first send.
		web: false,
		// Those it goes to got the first send: leaving out the campaign's reached would leave out all.
		campaign_dedupe: false,
		slug: null,
		rss_items: null,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(b).values(row);
	return row;
}

/** Stops it: a scheduled one goes back to draft; one sending stops queueing and its queued emails are canceled. */
export async function cancelBroadcast(brand: string, id: string, now = Date.now()) {
	let x = await getBroadcast(brand, id);
	if (x.status === "scheduled") {
		// Only if nothing was queued yet: the cron may have just started it (then it's stopped below).
		const [row] = await db
			.update(b)
			.set({ status: "draft", scheduled_at: null, updated_at: iso(now) })
			.where(and(eq(b.id, id), eq(b.status, "scheduled")))
			.returning();
		if (row) return row as Broadcast;
		x = await getBroadcast(brand, id);
	}
	if (x.status !== "sending" && x.status !== "sent" && x.status !== "testing")
		throw new ApiError(409, "not_sending", "This broadcast isn't scheduled or sending");
	const e = schema.emails;
	// "sent" means every email is queued, not gone: one with none left waiting is done.
	if (x.status === "sent") {
		const waiting = await db
			.select({ id: e.id })
			.from(e)
			.where(and(eq(e.broadcast_id, id), inArray(e.status, ["queued", "scheduled"])))
			.get();
		if (!waiting)
			throw new ApiError(409, "already_sent", "Every email of this broadcast has gone out");
	}
	// The broadcast first, so a chunk being queued right now is refused by the Dispatcher.
	const [row] = await db
		.update(b)
		.set({ status: "canceled", completed_at: iso(now), updated_at: iso(now) })
		.where(and(eq(b.id, id), inArray(b.status, ["sending", "sent", "testing"])))
		.returning();
	if (!row) throw new ApiError(409, "not_sending", "This broadcast isn't scheduled or sending");
	await cancelQueued(id, now);
	return row as Broadcast;
}

/** A canceled (or deleted) broadcast's emails still waiting: canceled. */
async function cancelQueued(id: string, now: number) {
	const e = schema.emails;
	await db
		.update(e)
		.set({ status: "canceled", send_at: null, last_event: "canceled", last_event_at: iso(now) })
		.where(and(eq(e.broadcast_id, id), inArray(e.status, ["queued", "scheduled"])));
}

/** The next contacts it goes to, after `cursor` in id order. */
async function nextRecipients(x: Broadcast, limit: number) {
	const cs = schema.contactSegments;
	const ctp = schema.contactTopics;
	const s = schema.suppressions;
	const where = [
		eq(ct.organization_id, x.organization_id),
		eq(ct.unsubscribed, false),
		inArray(
			ct.id,
			db
				.select({ id: cs.contact_id })
				.from(cs)
				.where(eq(cs.segment_id, x.segment_id ?? "")),
		),
		notExists(
			db
				.select({ a: s.address })
				.from(s)
				.where(and(eq(s.organization_id, x.organization_id), eq(s.address, ct.email))),
		),
	];
	if (x.cursor) where.push(gt(ct.id, x.cursor));
	if (x.campaign_id && x.campaign_dedupe)
		where.push(
			sql`NOT EXISTS (SELECT 1 FROM emails AS o JOIN broadcasts AS ob ON ob.id = o.broadcast_id WHERE ob.campaign_id = ${x.campaign_id} AND ob.id <> ${x.id} AND o.status NOT IN ('canceled', 'failed', 'suppressed') AND lower(json_extract(o."to", '$[0]')) = ${ct.email})`,
		);
	if (x.resend_of)
		where.push(
			sql`EXISTS (SELECT 1 FROM emails AS r WHERE r.broadcast_id = ${x.resend_of} AND r.sent_at IS NOT NULL AND r.opened_at IS NULL AND r.clicked_at IS NULL AND lower(json_extract(r."to", '$[0]')) = ${ct.email})`,
		);
	if (x.topic_id) {
		const topic = await db
			.select()
			.from(schema.topics)
			.where(eq(schema.topics.id, x.topic_id))
			.get();
		const choice = (sub: "opt_in" | "opt_out") =>
			db
				.select({ id: ctp.contact_id })
				.from(ctp)
				.where(
					and(
						eq(ctp.topic_id, x.topic_id ?? ""),
						eq(ctp.contact_id, ct.id),
						eq(ctp.subscription, sub),
					),
				);
		where.push(
			topic?.default_subscription === "opt_in"
				? sql`EXISTS (${choice("opt_in")})`
				: notExists(choice("opt_out")),
		);
	}
	return db
		.select()
		.from(ct)
		.where(and(...where))
		.orderBy(asc(ct.id))
		.limit(limit);
}

/**
 * Queues the next chunk of a broadcast's emails. The cursor moves first (only one run can move
 * it from where it was), so two runs never queue the same contacts.
 */
async function advance(x: Broadcast, now: number) {
	const page = await nextRecipients(x, CHUNK);
	const ab = x.ab_test;
	// An A/B test goes first to its share of the segment; the rest wait for the winner.
	const testing = !!ab && ab.winner === null;
	const contacts = ab
		? page.filter((c) => fnv(`${x.id}:${c.id}`) % 100 < ab.size === testing)
		: page;
	const last = page.at(-1)?.id ?? x.cursor;
	const done = page.length < CHUNK;
	const claim = await db
		.update(b)
		.set({
			cursor: last,
			queued: sql`${b.queued} + ${contacts.length}`,
			status: done ? (testing ? "testing" : "sent") : "sending",
			test_ends_at:
				done && testing && ab ? iso(now + ab.wait_minutes * 60_000) : x.test_ends_at,
			started_at: x.started_at ?? iso(now),
			completed_at: done && !testing ? iso(now) : null,
			updated_at: iso(now),
		})
		.where(
			and(
				eq(b.id, x.id),
				x.cursor === null ? sql`${b.cursor} IS NULL` : eq(b.cursor, x.cursor),
				inArray(b.status, ["scheduled", "sending"]),
			),
		)
		.returning({ id: b.id });
	if (!claim.length) return 0;
	if (!contacts.length) return 0;
	const subjects = [x.subject, ...(ab?.subjects ?? [])];
	// The test's emails carry their version; the rest all get the winner's subject.
	const variants = contacts.map((c) =>
		testing ? fnv(`${c.id}:${x.id}:v`) % subjects.length : null,
	);
	const values = await subjectsFor(
		x,
		contacts,
		variants.map((v) => subjects[v ?? ab?.winner ?? 0] ?? x.subject),
	);
	const fallbackZone = timezone();
	const sendAt = (c: Contact) => {
		if (!x.local_time) return iso(now);
		const at = zonedInstant(x.local_time, validZone(c.timezone) ? c.timezone : fallbackZone);
		return iso(Number.isNaN(at) ? now : Math.max(now, at));
	};
	const group = x.topic_id ? topicGroup(x.topic_id) : ALL_BROADCASTS_GROUP;
	const rows = contacts.map((c, i) => ({
		id: crypto.randomUUID(),
		organization_id: x.organization_id,
		from: x.from,
		to: [c.email],
		reply_to: x.reply_to,
		subject: values[i] as string,
		tags: [{ name: "broadcast", value: x.id }],
		status: "queued" as const,
		source: "broadcast",
		send_at: sendAt(c),
		created_at: iso(now),
		unsubscribe_group: group,
		broadcast_id: x.id,
		template_id: x.template_id,
		variant: variants[i] ?? null,
	}));
	const statements = [];
	for (let i = 0; i < rows.length; i += PER_INSERT)
		statements.push(db.insert(schema.emails).values(rows.slice(i, i + PER_INSERT)));
	let inserted = 0;
	try {
		for (let i = 0; i < statements.length; i += 50) {
			await batch(statements.slice(i, i + 50));
			inserted = Math.min(rows.length, (i + 50) * PER_INSERT);
		}
	} catch (error) {
		console.error("broadcasts: queueing failed", x.id, error);
		// The cursor goes back to the last contact queued, so the next run queues the rest
		// instead of skipping them (each batch is all or nothing).
		await db
			.update(b)
			.set({
				cursor: inserted ? (contacts[inserted - 1]?.id ?? x.cursor) : x.cursor,
				queued: sql`${b.queued} - ${contacts.length - inserted}`,
				status: "sending",
				test_ends_at: x.test_ends_at,
				completed_at: null,
				error: `Queueing stopped: ${error instanceof Error ? error.message : error}`.slice(
					0,
					500,
				),
			})
			.where(
				and(
					eq(b.id, x.id),
					eq(b.cursor, last ?? ""),
					inArray(b.status, ["sending", "sent", "testing"]),
				),
			);
	}
	// Canceled while this chunk went in: its emails are canceled too.
	const after = await db.select({ status: b.status }).from(b).where(eq(b.id, x.id)).get();
	if (!after || after.status === "canceled") await cancelQueued(x.id, now);
	return inserted;
}

/** Each contact's subject (theirs, of an A/B test's versions), with their values in. */
async function subjectsFor(x: Broadcast, contacts: Contact[], subjects: string[]) {
	if (!subjects.some((t) => /\{\{\{/.test(t))) return subjects;
	const out: string[] = [];
	for (const [i, c] of contacts.entries())
		out.push(fill(subjects[i] ?? x.subject, await contactValues(x.organization_id, c)));
	return out;
}

/** FNV-1a: a stable number for a string (who's in a test, and which version they get). */
function fnv(s: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h;
}

/** How each version of a broadcast's A/B test did. */
export async function variantStats(id: string) {
	const e = schema.emails;
	const rows = await db
		.select({
			variant: e.variant,
			sent: sql<number>`SUM(CASE WHEN ${e.sent_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			opened: sql<number>`SUM(CASE WHEN ${e.opened_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			clicked: sql<number>`SUM(CASE WHEN ${e.clicked_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			total: sql<number>`COUNT(*)`,
		})
		.from(e)
		.where(and(eq(e.broadcast_id, id), sql`${e.variant} IS NOT NULL`))
		.groupBy(e.variant);
	return rows.map((r) => ({
		variant: Number(r.variant),
		total: Number(r.total),
		sent: Number(r.sent),
		opened: Number(r.opened),
		clicked: Number(r.clicked),
	}));
}

/** Tests that ran their time: the winner is picked (ties go to A) and the rest get it. */
async function decideTests(now: number) {
	const due = await db
		.select()
		.from(b)
		.where(and(eq(b.status, "testing"), sql`${b.test_ends_at} <= ${iso(now)}`))
		.limit(10);
	for (const x of due) {
		const ab = x.ab_test;
		if (!ab) continue;
		const stats = await variantStats(x.id);
		// Only the emails each version sent count, and the test's own (not the rest's).
		let winner = 0;
		let best = -1;
		for (let v = 0; v <= ab.subjects.length; v++) {
			const s = stats.find((r) => r.variant === v);
			const rate = s?.sent ? (ab.metric === "clicks" ? s.clicked : s.opened) / s.sent : 0;
			if (rate > best) {
				best = rate;
				winner = v;
			}
		}
		await db
			.update(b)
			.set({
				ab_test: { ...ab, winner },
				status: "sending",
				cursor: null,
				updated_at: iso(now),
			})
			.where(and(eq(b.id, x.id), eq(b.status, "testing")));
	}
}

/**
 * The cron's turn (every minute) and a send's first: broadcasts due get their next chunk queued.
 * Returns how many emails were queued.
 */
export async function runBroadcasts(now = Date.now(), only?: string) {
	await decideTests(now);
	const due = await db
		.select()
		.from(b)
		.where(
			and(
				inArray(b.status, ["scheduled", "sending"]),
				sql`${b.scheduled_at} <= ${iso(now)}`,
				only ? eq(b.id, only) : undefined,
			),
		)
		.orderBy(asc(b.scheduled_at))
		.limit(10);
	let queued = 0;
	for (const x of due) queued += await advance(x, now);
	if (queued) {
		const { kickDispatcher } = await import("./dispatcher");
		await kickDispatcher().catch((e) => console.error("broadcasts: kick failed", e));
	}
	return queued;
}

/** Broadcasts and their brand's property list, kept for one Dispatcher run. */
const cache = new Map<string, { at: number; value: Broadcast | null }>();

/** A broadcast email's content, for the contact it goes to (null: not a broadcast email). */
export async function broadcastContent(email: {
	broadcast_id: string | null;
	organization_id: string;
	to: string[];
}): Promise<StoredContent | null> {
	if (!email.broadcast_id) return null;
	let hit = cache.get(email.broadcast_id);
	if (!hit || hit.at < Date.now() - 30_000) {
		hit = {
			at: Date.now(),
			value: (await db.select().from(b).where(eq(b.id, email.broadcast_id)).get()) ?? null,
		};
		cache.set(email.broadcast_id, hit);
	}
	const x = hit.value;
	if (!x) return null;
	const address = bareAddress(email.to[0] ?? "").toLowerCase();
	const contact = await db
		.select()
		.from(ct)
		.where(and(eq(ct.organization_id, email.organization_id), eq(ct.email, address)))
		.get();
	const { broadcastValues } = await import("./newsletters");
	const values = {
		...(contact
			? await contactValues(email.organization_id, contact)
			: { FIRST_NAME: "", LAST_NAME: "", EMAIL: address }),
		...(await broadcastValues(x, contact ?? null, `${x.html}\n${x.text ?? ""}`)),
	};
	const escaped = Object.fromEntries(
		Object.entries(values).map(([k, v]) => [k, v == null ? v : escapeHtml(String(v))]),
	);
	let html = x.html ? fill(x.html, escaped) : undefined;
	if (html && x.campaign_id) {
		const { tagLinks, utmOf } = await import("./campaigns");
		const utm = await utmOf(x.campaign_id);
		if (utm) html = tagLinks(html, utm);
	}
	if (html && x.preview_text)
		html = /<body[^>]*>/i.test(html)
			? html.replace(/<body[^>]*>/i, (m) => `${m}${preheader(x.preview_text ?? "")}`)
			: `${preheader(x.preview_text)}${html}`;
	const text =
		x.text === ""
			? undefined
			: x.text
				? fill(x.text, values)
				: html
					? htmlToText(html)
					: undefined;
	return { html, text };
}

const STAT_KEYS = [
	"queued",
	"sent",
	"delivered",
	"opened",
	"clicked",
	"bounced",
	"complained",
	"failed",
	"suppressed",
	"canceled",
] as const;

/** What happened to a broadcast's emails, counted. */
export async function broadcastStats(id: string) {
	const e = schema.emails;
	const rows = await db
		.select({
			total: sql<number>`COUNT(*)`,
			queued: sql<number>`SUM(CASE WHEN ${e.status} IN ('queued','sending') THEN 1 ELSE 0 END)`,
			sent: sql<number>`SUM(CASE WHEN ${e.sent_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			delivered: sql<number>`SUM(CASE WHEN ${e.delivered_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			opened: sql<number>`SUM(CASE WHEN ${e.opened_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			clicked: sql<number>`SUM(CASE WHEN ${e.clicked_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			bounced: sql<number>`SUM(CASE WHEN ${e.status} = 'bounced' THEN 1 ELSE 0 END)`,
			complained: sql<number>`SUM(CASE WHEN ${e.complained_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			failed: sql<number>`SUM(CASE WHEN ${e.status} = 'failed' THEN 1 ELSE 0 END)`,
			suppressed: sql<number>`SUM(CASE WHEN ${e.status} = 'suppressed' THEN 1 ELSE 0 END)`,
			canceled: sql<number>`SUM(CASE WHEN ${e.status} = 'canceled' THEN 1 ELSE 0 END)`,
		})
		.from(e)
		.where(eq(e.broadcast_id, id));
	const r = rows[0];
	const unsub = await db
		.select({ n: sql<number>`COUNT(*)` })
		.from(schema.emailEvents)
		.where(
			and(
				eq(schema.emailEvents.type, "email.unsubscribed"),
				inArray(
					schema.emailEvents.email_id,
					db.select({ id: e.id }).from(e).where(eq(e.broadcast_id, id)),
				),
			),
		)
		.get();
	const out: Record<(typeof STAT_KEYS)[number] | "total" | "unsubscribed", number> = {
		total: Number(r?.total ?? 0),
		unsubscribed: Number(unsub?.n ?? 0),
	} as never;
	for (const k of STAT_KEYS) out[k] = Number(r?.[k] ?? 0);
	return out;
}

/** How many contacts it would go to now (the send dialog's number). */
export async function audienceSize(
	x: Pick<Broadcast, "organization_id" | "segment_id" | "topic_id"> & {
		resend_of?: string | null;
	},
) {
	if (!x.segment_id) return 0;
	let n = 0;
	let cursor: string | null = null;
	// Counted the way it's sent, in chunks.
	for (let i = 0; i < 100; i++) {
		const page = await nextRecipients({ ...(x as Broadcast), cursor }, 5000);
		n += page.length;
		if (page.length < 5000) break;
		cursor = page.at(-1)?.id ?? null;
	}
	return n;
}

export const isLive = (s: BroadcastStatus) =>
	s === "sending" || s === "scheduled" || s === "testing";
