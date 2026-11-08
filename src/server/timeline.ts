import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { type ContactEvent, eventView } from "./contact-events";
import type { Contact } from "./contacts";
import { batch, db, raw, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

/**
 * One person, everywhere: everything a brand knows about a contact, newest first, from every
 * part of Mailroom: their app's events (and Mailroom's own: poll answers, referral
 * milestones), the emails sent to them with what they did with them, their conversations and
 * chats with their ratings, the automations they went through, the friends they brought, and
 * when they joined and left. Conversations join on the address (conversations.contact_address),
 * so a chat or an email someone wrote before they were a contact shows too.
 */

export type TimelineItem =
	| { kind: "joined"; at: string; source: string | null; detail: string | null }
	| { kind: "unsubscribed"; at: string }
	| ({ kind: "event"; at: string } & ReturnType<typeof eventView>)
	| {
			kind: "email";
			at: string;
			id: string;
			subject: string;
			status: string;
			source: string;
			broadcast_id: string | null;
			template_id: string | null;
			opened_at: string | null;
			clicked_at: string | null;
	  }
	| {
			kind: "conversation";
			at: string;
			id: string;
			subject: string;
			channel: "email" | "chat";
			status: string;
			messages: number;
			inbox_id: string | null;
			rating: number | null;
			page_url: string | null;
	  }
	| {
			kind: "automation";
			at: string;
			id: string;
			automation_id: string;
			name: string;
			status: string;
	  }
	| {
			kind: "referred";
			at: string;
			id: string;
			email: string;
			name: string | null;
	  };

const PAGE = 30;

/** The contact's timeline before `before` (an ISO time; null: from now). */
export async function contactTimeline(
	brand: string,
	contact: Contact,
	o: { before?: string | null; limit?: number } = {},
) {
	const limit = Math.min(Math.max(o.limit ?? PAGE, 1), 100);
	const before = o.before ?? iso(Date.now() + 60_000);
	const address = contact.email.toLowerCase();
	const ev = schema.contactEvents;
	const em = schema.emails;
	const cv = schema.conversations;
	const ar = schema.automationRuns;
	const au = schema.automations;
	const ct = schema.contacts;
	const [events, emails, conversations, runs, referred] = await Promise.all([
		db
			.select()
			.from(ev)
			.where(and(eq(ev.contact_id, contact.id), lt(ev.created_at, before)))
			.orderBy(desc(ev.created_at))
			.limit(limit),
		db
			.select({
				id: em.id,
				subject: em.subject,
				status: em.status,
				last_event: em.last_event,
				source: em.source,
				broadcast_id: em.broadcast_id,
				template_id: em.template_id,
				opened_at: em.opened_at,
				clicked_at: em.clicked_at,
				created_at: em.created_at,
			})
			.from(em)
			.where(
				and(
					eq(em.organization_id, brand),
					eq(em.recipient, address),
					lt(em.created_at, before),
				),
			)
			.orderBy(desc(em.created_at))
			.limit(limit),
		db
			.select()
			.from(cv)
			.where(
				and(
					eq(cv.organization_id, brand),
					eq(cv.contact_address, address),
					lt(cv.created_at, before),
				),
			)
			.orderBy(desc(cv.created_at))
			.limit(limit),
		db
			.select({
				id: ar.id,
				automation_id: ar.automation_id,
				name: au.name,
				status: ar.status,
				created_at: ar.created_at,
			})
			.from(ar)
			.innerJoin(au, eq(au.id, ar.automation_id))
			.where(
				and(
					eq(ar.organization_id, brand),
					eq(ar.contact_id, contact.id),
					lt(ar.created_at, before),
				),
			)
			.orderBy(desc(ar.created_at))
			.limit(limit),
		db
			.select({
				id: ct.id,
				email: ct.email,
				first_name: ct.first_name,
				last_name: ct.last_name,
				created_at: ct.created_at,
			})
			.from(ct)
			.where(
				and(
					eq(ct.organization_id, brand),
					eq(ct.referred_by, contact.id),
					lt(ct.created_at, before),
				),
			)
			.orderBy(desc(ct.created_at))
			.limit(limit),
	]);
	const items: TimelineItem[] = [
		...events.map((x: ContactEvent) => ({
			kind: "event" as const,
			at: x.created_at,
			...eventView(x),
		})),
		...emails.map((x) => ({
			kind: "email" as const,
			at: x.created_at,
			id: x.id,
			subject: x.subject,
			status: (x.last_event ?? x.status).replace(/^email\./, ""),
			source: x.source,
			broadcast_id: x.broadcast_id,
			template_id: x.template_id,
			opened_at: x.opened_at,
			clicked_at: x.clicked_at,
		})),
		...conversations.map((x) => ({
			kind: "conversation" as const,
			at: x.created_at,
			id: x.id,
			subject: x.subject,
			channel: (x.channel === "chat" ? "chat" : "email") as "chat" | "email",
			status: x.status,
			messages: x.messages,
			inbox_id: x.inbox_id,
			rating: x.csat_rating,
			page_url: x.page_url,
		})),
		...runs.map((x) => ({
			kind: "automation" as const,
			at: x.created_at,
			id: x.id,
			automation_id: x.automation_id,
			name: x.name,
			status: x.status,
		})),
		...referred.map((x) => ({
			kind: "referred" as const,
			at: x.created_at,
			id: x.id,
			email: x.email,
			name: [x.first_name, x.last_name].filter(Boolean).join(" ") || null,
		})),
	];
	if (contact.created_at < before)
		items.push({
			kind: "joined",
			at: contact.created_at,
			source: contact.source,
			detail: contact.source_detail,
		});
	if (contact.unsubscribed_at && contact.unsubscribed_at < before)
		items.push({ kind: "unsubscribed", at: contact.unsubscribed_at });
	items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
	const page = items.slice(0, limit);
	// More may be older than the page in any of the sources that filled a whole page.
	const full = [events, emails, conversations, runs, referred].some((x) => x.length === limit);
	return {
		object: "list" as const,
		data: page,
		next: items.length > limit || full ? (page.at(-1)?.at ?? null) : null,
	};
}

/**
 * Who wrote in, for the team beside a conversation or chat: the brand's contact of that address
 * (or none yet), and what Mailroom knows about them: their segments and topics, the newsletters
 * they get, their last broadcasts and whether they opened them, their latest events, other
 * conversations and the last rating they gave, and whether they can get email at all.
 */
export async function personPanel(brand: string, address: string, conversationId?: string) {
	const a = address.trim().toLowerCase();
	const ct = schema.contacts;
	const cv = schema.conversations;
	const contact = await db
		.select()
		.from(ct)
		.where(and(eq(ct.organization_id, brand), eq(ct.email, a)))
		.get();
	const [others, suppressed, broadcasts] = await Promise.all([
		db
			.select({
				id: cv.id,
				subject: cv.subject,
				status: cv.status,
				channel: cv.channel,
				last_message_at: cv.last_message_at,
				csat: cv.csat_rating,
			})
			.from(cv)
			.where(
				and(
					eq(cv.organization_id, brand),
					eq(cv.contact_address, a),
					conversationId ? sql`${cv.id} <> ${conversationId}` : undefined,
				),
			)
			.orderBy(desc(cv.last_message_at))
			.limit(6),
		db
			.select({ reason: schema.suppressions.reason })
			.from(schema.suppressions)
			.where(
				and(
					eq(schema.suppressions.organization_id, brand),
					eq(schema.suppressions.address, a),
				),
			)
			.get(),
		db
			.select({
				id: schema.emails.id,
				subject: schema.emails.subject,
				broadcast_id: schema.emails.broadcast_id,
				opened_at: schema.emails.opened_at,
				clicked_at: schema.emails.clicked_at,
				created_at: schema.emails.created_at,
			})
			.from(schema.emails)
			.where(
				and(
					eq(schema.emails.organization_id, brand),
					eq(schema.emails.recipient, a),
					sql`${schema.emails.broadcast_id} IS NOT NULL`,
				),
			)
			.orderBy(desc(schema.emails.created_at))
			.limit(5),
	]);
	const rating = await db
		.select({ rating: cv.csat_rating, at: cv.csat_at })
		.from(cv)
		.where(
			and(
				eq(cv.organization_id, brand),
				eq(cv.contact_address, a),
				sql`${cv.csat_rating} IS NOT NULL`,
			),
		)
		.orderBy(desc(cv.csat_at))
		.get();
	const { personHolds } = await import("./marketing-rules");
	const base = {
		email: a,
		suppressed: suppressed ? suppressed.reason : null,
		broadcasts,
		others,
		last_rating: rating?.rating ? { rating: rating.rating, at: rating.at } : null,
		/** Quiet mode or the frequency cap holds them out of broadcasts now. */
		holds: await personHolds(brand, a),
	};
	if (!contact) return { ...base, contact: null };
	const { engagementOf } = await import("./engagement");
	const { segmentsOfContact, topicsOfContact } = await import("./contacts");
	const [engagement, segments, topics, events, newsletters] = await Promise.all([
		engagementOf(brand, [contact]).then((m) => m.get(contact.id) ?? null),
		segmentsOfContact(contact.id),
		topicsOfContact(brand, contact.id),
		db
			.select()
			.from(schema.contactEvents)
			.where(eq(schema.contactEvents.contact_id, contact.id))
			.orderBy(desc(schema.contactEvents.created_at))
			.limit(5),
		newslettersOf(brand, contact.id),
	]);
	return {
		...base,
		contact: {
			id: contact.id,
			first_name: contact.first_name,
			last_name: contact.last_name,
			unsubscribed: contact.unsubscribed,
			created_at: contact.created_at,
			source: contact.source,
			properties: contact.properties ?? {},
			referrals: contact.referrals,
		},
		engagement,
		segments: segments.map((s) => ({ id: s.id, name: s.name })),
		topics: topics.map((t) => ({ id: t.id, name: t.name, subscription: t.subscription })),
		newsletters,
		events: events.map(eventView),
	};
}

/**
 * Folds `drop` (the same person under another address) into `keep`: its segments, topic
 * choices `keep` hasn't made, properties `keep` lacks, names, events, poll answers, automation
 * runs and the friends it brought move over, then `drop` is deleted. Emails and conversations
 * stay under their own address (they're what was really sent and received).
 */
export async function mergeContacts(brand: string, keepRef: string, dropRef: string) {
	const { getContact } = await import("./contacts");
	const keep = await getContact(brand, keepRef);
	const drop = await getContact(brand, dropRef);
	if (keep.id === drop.id) throw validation("Pick two different contacts");
	const now = iso(Date.now());
	const properties = { ...(drop.properties ?? {}), ...(keep.properties ?? {}) };
	await batch([
		raw(
			`INSERT OR IGNORE INTO contact_segments (contact_id, segment_id, created_at)
			SELECT ?1, segment_id, created_at FROM contact_segments WHERE contact_id = ?2`,
			keep.id,
			drop.id,
		),
		raw(
			`INSERT OR IGNORE INTO contact_topics (contact_id, topic_id, subscription, updated_at)
			SELECT ?1, topic_id, subscription, updated_at FROM contact_topics WHERE contact_id = ?2`,
			keep.id,
			drop.id,
		),
		raw(
			`INSERT OR IGNORE INTO poll_votes (broadcast_id, poll_id, contact_id, answer, created_at)
			SELECT broadcast_id, poll_id, ?1, answer, created_at FROM poll_votes WHERE contact_id = ?2`,
			keep.id,
			drop.id,
		),
		raw("UPDATE contact_events SET contact_id = ?1 WHERE contact_id = ?2", keep.id, drop.id),
		raw(
			"UPDATE automation_runs SET contact_id = ?1 WHERE contact_id = ?2 AND organization_id = ?3",
			keep.id,
			drop.id,
			brand,
		),
		raw(
			"UPDATE contacts SET referred_by = ?1 WHERE referred_by = ?2 AND organization_id = ?3",
			keep.id,
			drop.id,
			brand,
		),
		db
			.update(schema.contacts)
			.set({
				first_name: keep.first_name ?? drop.first_name,
				last_name: keep.last_name ?? drop.last_name,
				properties,
				timezone: keep.timezone ?? drop.timezone,
				referred_by:
					keep.referred_by ?? (drop.referred_by !== keep.id ? drop.referred_by : null),
				referrals: keep.referrals + drop.referrals,
				updated_at: now,
			})
			.where(eq(schema.contacts.id, keep.id)),
		db.delete(schema.contacts).where(eq(schema.contacts.id, drop.id)),
	]);
	return { kept: keep.id, merged: drop.id, email: keep.email, merged_email: drop.email };
}

/** The brand's newsletters a contact gets: in its segment, and not out of its topic. */
async function newslettersOf(brand: string, contactId: string) {
	const nl = schema.newsletters;
	const list = await db
		.select({ id: nl.id, name: nl.name, segment_id: nl.segment_id, topic_id: nl.topic_id })
		.from(nl)
		.where(eq(nl.organization_id, brand));
	if (!list.length) return [];
	const segs = [...new Set(list.map((n) => n.segment_id).filter(Boolean))] as string[];
	const [inSegs, topics] = await Promise.all([
		segs.length
			? db
					.select({ id: schema.contactSegments.segment_id })
					.from(schema.contactSegments)
					.where(
						and(
							eq(schema.contactSegments.contact_id, contactId),
							inArray(schema.contactSegments.segment_id, segs),
						),
					)
			: [],
		import("./contacts").then((m) => m.topicsOfContact(brand, contactId)),
	]);
	const member = new Set(inSegs.map((s) => s.id));
	const out = new Map(topics.map((t) => [t.id, t.subscription]));
	return list
		.filter((n) => n.segment_id && member.has(n.segment_id))
		.filter((n) => !n.topic_id || out.get(n.topic_id) !== "opt_out")
		.map((n) => ({ id: n.id, name: n.name }));
}
