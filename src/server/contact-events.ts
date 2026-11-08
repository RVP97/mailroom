import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, raw, schema } from "./db";
import { eventRetentionDays } from "./env";
import { iso } from "./time";

/**
 * Events kept on the contact (POST /api/events, the assistant's send_event): what the person
 * did in the brand's app, with what the app sent. Their timeline shows them, live segments
 * match on them ("did `purchase` 2 times in 30 days") and goals count them. Past
 * EVENT_RETENTION_DAYS (395 by default) the cron deletes them.
 */

const e = schema.contactEvents;
export type ContactEvent = typeof e.$inferSelect;

/** Who sent it: the app's API key, the assistant, the dashboard, or Mailroom itself (a poll
 * answered, a referral milestone). */
export type EventSource = "api" | "assistant" | "dashboard" | "mailroom";

export async function storeEvent(
	brand: string,
	contactId: string,
	name: string,
	data: Record<string, unknown> | null,
	source: EventSource,
	now = Date.now(),
	/** A purchase (src/server/revenue.ts): its amount and what gets the credit. */
	purchase?: {
		value: number;
		currency: string | null;
		credit: { type: string; id: string; email_id: string | null } | null;
	} | null,
) {
	const row = {
		id: crypto.randomUUID(),
		organization_id: brand,
		contact_id: contactId,
		name,
		data,
		source,
		value: purchase?.value ?? null,
		currency: purchase?.currency ?? null,
		credit_type: purchase?.credit?.type ?? null,
		credit_id: purchase?.credit?.id ?? null,
		credit_email_id: purchase?.credit?.email_id ?? null,
		created_at: iso(now),
	};
	await db.insert(e).values(row);
	return row as ContactEvent;
}

/** What JSON holds (an event's data came in as JSON). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const eventView = (x: ContactEvent) => ({
	object: "event" as const,
	id: x.id,
	event: x.name,
	contact_id: x.contact_id,
	data: (x.data ?? {}) as Record<string, Json>,
	source: x.source,
	/** A purchase's amount, and what got the credit for it (a broadcast, automation or chat). */
	value: x.value ?? null,
	currency: x.currency ?? null,
	credit: x.credit_id
		? { type: x.credit_type as string, id: x.credit_id, email_id: x.credit_email_id ?? null }
		: null,
	created_at: x.created_at,
});

/** A contact's events (or the brand's, of one name), newest first. */
export async function listContactEvents(
	brand: string,
	o: { contact?: string | null; name?: string | null; before?: string | null; limit?: number },
) {
	const limit = Math.min(Math.max(o.limit ?? 50, 1), 100);
	const rows = await db
		.select()
		.from(e)
		.where(
			and(
				eq(e.organization_id, brand),
				o.contact ? eq(e.contact_id, o.contact) : undefined,
				o.name ? eq(e.name, o.name) : undefined,
				o.before ? lt(e.created_at, o.before) : undefined,
			),
		)
		.orderBy(desc(e.created_at))
		.limit(limit + 1);
	return {
		data: rows.slice(0, limit),
		next: rows.length > limit ? (rows[limit - 1]?.created_at ?? null) : null,
	};
}

/** The brand's event names, with how many and when last (the last 90 days), most used first. */
export async function eventNames(brand: string, now = Date.now()) {
	const since = iso(now - 90 * 86_400_000);
	const rows = await db
		.select({
			name: e.name,
			count: sql<number>`count(*)`,
			last: sql<string>`max(${e.created_at})`,
		})
		.from(e)
		.where(and(eq(e.organization_id, brand), sql`${e.created_at} >= ${since}`))
		.groupBy(e.name)
		.orderBy(desc(sql`count(*)`))
		.limit(200);
	return rows.map((r) => ({ name: r.name, count: Number(r.count), last_at: r.last }));
}

/** Deletes events past retention, a batch at a time. */
export async function purgeEvents(now = Date.now(), rounds = 10) {
	const before = iso(now - eventRetentionDays() * 86_400_000);
	let gone = 0;
	for (let i = 0; i < rounds; i++) {
		const res = await raw(
			"DELETE FROM contact_events WHERE id IN (SELECT id FROM contact_events WHERE created_at < ?1 LIMIT 500)",
			before,
		).run();
		const n = res.meta?.changes ?? 0;
		gone += n;
		if (n < 500) break;
	}
	return gone;
}
