import { and, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, schema } from "./db";
import { validation } from "./errors";
import { settingsOf } from "./inbox-workflow";
import { type InboxActor, inboxFor, listInboxes, need } from "./inboxes";
import { dayOf, dayRange, iso, lastDays } from "./time";

/**
 * The inbox report: how the team and its agents are doing over a range of days, against the
 * same number of days before. Volume, response and resolution times, the SLA, satisfaction,
 * who answered (agents or people), how agents' drafts fared, and the busiest hours. Read from
 * the conversations and replies themselves (nothing extra is counted on the way), so it covers
 * what's still kept (the inbox's retention).
 */

const c = schema.conversations;
const rp = schema.conversationReplies;
const a = schema.inboxActivity;

/** Rows read per question, at most (the report says when it hit it). */
const CAP = 20_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function quantile(sorted: number[], q: number) {
	if (!sorted.length) return null;
	const i = (sorted.length - 1) * q;
	const lo = Math.floor(i);
	const hi = Math.ceil(i);
	const a0 = sorted[lo] as number;
	const a1 = sorted[hi] as number;
	return Math.round(a0 + (a1 - a0) * (i - lo));
}

const minutesBetween = (from: string, to: string) =>
	Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

export interface ReportInput {
	from?: string | null;
	to?: string | null;
	/** An inbox's id or address; without it, every inbox the actor sees (and other addresses). */
	inbox?: string | null;
	now?: number;
}

export async function inboxReport(actor: InboxActor, o: ReportInput = {}) {
	need(actor, "read");
	const now = o.now ?? Date.now();
	const today = dayOf(now);
	const to = o.to && DAY_RE.test(o.to) ? o.to : today;
	const from = o.from && DAY_RE.test(o.from) ? o.from : (lastDays(30, now)[0] as string);
	if (from > to) throw validation("from: on or before to");
	const span =
		Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) +
		1;
	if (span > 366) throw validation("Up to a year at a time");
	const days = Array.from({ length: span }, (_, i) =>
		new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10),
	);
	const start = dayRange(from)[0];
	const end = dayRange(to)[1];
	const prevStart = iso(Date.parse(start) - (Date.parse(end) - Date.parse(start)));

	const inboxes = await listInboxes(actor);
	const one = o.inbox ? await inboxFor(actor, o.inbox) : null;
	const scope = and(
		inArray(c.organization_id, actor.brands.length ? actor.brands : [""]),
		one
			? eq(c.inbox_id, one.id)
			: actor.inboxIds
				? inArray(c.inbox_id, actor.inboxIds)
				: undefined,
	);
	const slaInboxes = new Set(
		(one ? [one] : inboxes).filter((i) => settingsOf(i).sla.enabled).map((i) => i.id),
	);

	// Conversations that started in the range (and in the one before, for the deltas).
	const started = await db
		.select({
			id: c.id,
			inbox: c.inbox_id,
			channel: c.channel,
			created_at: c.created_at,
			first_reply_at: c.first_reply_at,
			resolved_at: c.resolved_at,
			status: c.status,
			assignee: c.assignee,
			assignee_name: c.assignee_name,
			tags: c.tags,
			priority: c.priority,
			breached: c.sla_breached,
			csat: c.csat_rating,
			csat_sent: c.csat_sent_at,
		})
		.from(c)
		.where(and(scope, gte(c.created_at, prevStart), lt(c.created_at, end)))
		.limit(CAP);
	const cur = started.filter((x) => x.created_at >= start);
	const prev = started.filter((x) => x.created_at < start);

	// Resolved in the range: resolution times.
	const resolvedRows = await db
		.select({
			id: c.id,
			created_at: c.created_at,
			resolved_at: c.resolved_at,
			inbox: c.inbox_id,
			assignee: c.assignee,
		})
		.from(c)
		.where(and(scope, gte(c.resolved_at, prevStart), lt(c.resolved_at, end)))
		.limit(CAP);

	// Replies sent in the range: who answered.
	const replyScope = and(
		inArray(rp.organization_id, actor.brands.length ? actor.brands : [""]),
		one
			? eq(rp.inbox_id, one.id)
			: actor.inboxIds
				? inArray(rp.inbox_id, actor.inboxIds)
				: undefined,
	);
	const replies = await db
		.select({
			at: rp.sent_at,
			author_type: rp.author_type,
			author_name: rp.author_name,
			author_id: rp.author_id,
			sent_by: rp.sent_by,
			review: rp.review,
			inbox: rp.inbox_id,
		})
		.from(rp)
		.where(
			and(replyScope, eq(rp.status, "sent"), gte(rp.sent_at, prevStart), lt(rp.sent_at, end)),
		)
		.limit(CAP);

	// Agents' drafts: discarded ones are only in the activity.
	const discarded = await db
		.select({ at: a.created_at, detail: a.detail })
		.from(a)
		.where(
			and(
				inArray(a.organization_id, actor.brands.length ? actor.brands : [""]),
				one ? eq(a.inbox_id, one.id) : undefined,
				eq(a.action, "draft.discarded"),
				gte(a.created_at, prevStart),
				lt(a.created_at, end),
			),
		)
		.limit(CAP);
	const waiting = await db
		.select({ n: sql<number>`count(*)` })
		.from(rp)
		.where(and(replyScope, eq(rp.status, "draft"), eq(rp.author_type, "agent")))
		.get();

	// Messages that came in (email), for the busiest hours.
	const re = schema.receivedEmails;
	const inbound = await db
		.select({ at: re.created_at })
		.from(re)
		.where(
			and(
				inArray(re.organization_id, actor.brands.length ? actor.brands : [""]),
				one
					? eq(re.inbox_id, one.id)
					: actor.inboxIds
						? inArray(re.inbox_id, actor.inboxIds)
						: undefined,
				gte(re.created_at, start),
				lt(re.created_at, end),
			),
		)
		.limit(CAP);

	// Right now.
	const at = iso(now);
	const openNow = await db
		.select({
			n: sql<number>`count(*)`,
			unassigned: sql<number>`sum(CASE WHEN ${c.assignee} IS NULL OR ${c.claimed_until} <= ${at} THEN 1 ELSE 0 END)`,
			overdue: sql<number>`sum(CASE WHEN (${c.sla_first_due_at} IS NOT NULL AND ${c.sla_first_due_at} < ${at}) OR (${c.sla_resolve_due_at} IS NOT NULL AND ${c.sla_resolve_due_at} < ${at}) THEN 1 ELSE 0 END)`,
			snoozed: sql<number>`sum(CASE WHEN ${c.snoozed_until} > ${at} THEN 1 ELSE 0 END)`,
			held: sql<number>`sum(CASE WHEN ${c.held_at} IS NOT NULL THEN 1 ELSE 0 END)`,
			waiting: sql<number>`sum(CASE WHEN ${c.last_inbound_at} > coalesce(${c.last_reply_at}, '') THEN 1 ELSE 0 END)`,
		})
		.from(c)
		.where(and(scope, eq(c.status, "open")))
		.get();
	const oldestWaiting = await db
		.select({ at: sql<string | null>`min(${c.last_inbound_at})` })
		.from(c)
		.where(
			and(
				scope,
				eq(c.status, "open"),
				or(isNull(c.snoozed_until), sql`${c.snoozed_until} <= ${at}`),
				sql`${c.last_inbound_at} > coalesce(${c.last_reply_at}, '')`,
			),
		)
		.get();

	const summarize = (
		rows: typeof started,
		res: typeof resolvedRows,
		reps: typeof replies,
		dis: typeof discarded,
	) => {
		const frt = rows
			.flatMap((x) =>
				x.first_reply_at ? [minutesBetween(x.created_at, x.first_reply_at)] : [],
			)
			.sort((p, q) => p - q);
		const ttr = res
			.flatMap((x) => (x.resolved_at ? [minutesBetween(x.created_at, x.resolved_at)] : []))
			.sort((p, q) => p - q);
		const withSla = rows.filter((x) => x.inbox && slaInboxes.has(x.inbox));
		const missed = withSla.filter((x) => (x.breached ?? "").includes("reply")).length;
		const met = withSla.filter(
			(x) => x.first_reply_at && !(x.breached ?? "").includes("reply"),
		).length;
		const rated = rows.filter((x) => x.csat);
		const agentDrafts = reps.filter((r) => r.author_type === "agent" && r.sent_by);
		const discardedAgent = dis.filter(
			(d) => (d.detail as { author_type?: string } | null)?.author_type === "agent",
		).length;
		return {
			conversations: rows.length,
			resolved: res.length,
			replies: reps.length,
			replies_by: {
				agent: reps.filter((r) => r.author_type === "agent" && !r.sent_by).length,
				agent_approved: agentDrafts.length,
				person: reps.filter((r) => r.author_type === "person").length,
				api: reps.filter((r) => r.author_type === "api").length,
			},
			first_response_minutes: {
				median: quantile(frt, 0.5),
				p90: quantile(frt, 0.9),
				count: frt.length,
			},
			resolution_minutes: {
				median: quantile(ttr, 0.5),
				p90: quantile(ttr, 0.9),
				count: ttr.length,
			},
			unanswered: rows.filter((x) => !x.first_reply_at).length,
			sla: { met, missed, rate: met + missed ? met / (met + missed) : null },
			csat: {
				average: rated.length
					? Math.round(
							(rated.reduce((s, x) => s + (x.csat ?? 0), 0) / rated.length) * 100,
						) / 100
					: null,
				/** Share of 4 and 5 answers. */
				satisfied: rated.length
					? rated.filter((x) => (x.csat ?? 0) >= 4).length / rated.length
					: null,
				responses: rated.length,
				sent: rows.filter((x) => x.csat_sent).length,
				distribution: [1, 2, 3, 4, 5].map((n) => rated.filter((x) => x.csat === n).length),
			},
			agent_drafts: {
				sent_unchanged: agentDrafts.filter((r) => r.review !== "edited").length,
				edited: agentDrafts.filter((r) => r.review === "edited").length,
				discarded: discardedAgent,
			},
		};
	};

	const inRange = <T>(rows: T[], key: (r: T) => string | null, from: string, until: string) =>
		rows.filter((r) => {
			const v = key(r);
			return v !== null && v >= from && v < until;
		});
	const now_ = summarize(
		cur,
		inRange(resolvedRows, (r) => r.resolved_at, start, end),
		inRange(replies, (r) => r.at, start, end),
		inRange(discarded, (r) => r.at, start, end),
	);
	const before = summarize(
		prev,
		inRange(resolvedRows, (r) => r.resolved_at, prevStart, start),
		inRange(replies, (r) => r.at, prevStart, start),
		inRange(discarded, (r) => r.at, prevStart, start),
	);

	// Day by day.
	const series = days.map((day) => ({
		day,
		conversations: 0,
		resolved: 0,
		agent: 0,
		person: 0,
		first_response: null as number | null,
		_frt: [] as number[],
	}));
	const byDay = new Map(series.map((s) => [s.day, s]));
	for (const x of cur) {
		const d = byDay.get(dayOf(x.created_at));
		if (!d) continue;
		d.conversations++;
		if (x.first_reply_at) d._frt.push(minutesBetween(x.created_at, x.first_reply_at));
	}
	for (const x of inRange(resolvedRows, (r) => r.resolved_at, start, end)) {
		const d = byDay.get(dayOf(x.resolved_at as string));
		if (d) d.resolved++;
	}
	for (const r of inRange(replies, (r) => r.at, start, end)) {
		const d = byDay.get(dayOf(r.at as string));
		if (!d) continue;
		if (r.author_type === "agent") d.agent++;
		else d.person++;
	}
	for (const d of series)
		d.first_response = quantile(
			[...d._frt].sort((p, q) => p - q),
			0.5,
		);

	// The busiest hours (when mail comes in): weekday × hour in the deployment's time zone.
	const heat = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
	const tz = (await import("./env")).timezone();
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "2-digit",
		hourCycle: "h23",
	});
	const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	for (const m of inbound) {
		const parts = fmt.formatToParts(new Date(m.at));
		const wd = WD.indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
		const h = Number(parts.find((p) => p.type === "hour")?.value);
		const line = heat[wd];
		if (line && h >= 0 && h < 24) line[h] = (line[h] ?? 0) + 1;
	}

	// By inbox, by who has it, by tag, by channel.
	const names = new Map(inboxes.map((i) => [i.id, i.name]));
	const groups = <K extends string>(rows: typeof cur, key: (x: (typeof cur)[number]) => K[]) => {
		const out = new Map<K, typeof cur>();
		for (const x of rows) for (const k of key(x)) out.set(k, [...(out.get(k) ?? []), x]);
		return out;
	};
	const row = (rows: typeof cur) => {
		const frt = rows
			.flatMap((x) =>
				x.first_reply_at ? [minutesBetween(x.created_at, x.first_reply_at)] : [],
			)
			.sort((p, q) => p - q);
		const rated = rows.filter((x) => x.csat);
		return {
			conversations: rows.length,
			resolved: rows.filter((x) => x.status === "resolved").length,
			open: rows.filter((x) => x.status === "open").length,
			first_response_median: quantile(frt, 0.5),
			sla_missed: rows.filter((x) => (x.breached ?? "").includes("reply")).length,
			csat: rated.length
				? Math.round((rated.reduce((s, x) => s + (x.csat ?? 0), 0) / rated.length) * 100) /
					100
				: null,
		};
	};
	const curReplies = inRange(replies, (r) => r.at, start, end);
	const byInbox = [...groups(cur, (x) => [x.inbox ?? "none"]).entries()]
		.map(([id, rows]) => ({
			id,
			name: id === "none" ? "Other addresses" : (names.get(id) ?? "Deleted inbox"),
			...row(rows),
			replies: curReplies.filter((r) => (r.inbox ?? "none") === id).length,
		}))
		.sort((p, q) => q.conversations - p.conversations);
	const people = new Map<
		string,
		{ name: string; type: string; replies: number; approved: number }
	>();
	for (const r of curReplies) {
		const key = r.sent_by
			? `approver:${r.sent_by}`
			: `${r.author_type}:${r.author_id ?? r.author_name}`;
		const name = r.sent_by ?? r.author_name;
		const p = people.get(key) ?? {
			name,
			type: r.sent_by ? "person" : r.author_type,
			replies: 0,
			approved: 0,
		};
		p.replies++;
		if (r.sent_by && r.author_type === "agent") p.approved++;
		people.set(key, p);
	}
	const assigned = groups(cur, (x) => (x.assignee ? [x.assignee] : []));
	const byAssignee = [...assigned.entries()]
		.map(([reader, rows]) => ({
			reader,
			name: rows[0]?.assignee_name ?? "Someone",
			type: reader.startsWith("cred:") ? "agent" : "person",
			...row(rows),
		}))
		.sort((p, q) => q.conversations - p.conversations);
	const byTag = [...groups(cur, (x) => x.tags ?? []).entries()]
		.map(([tag, rows]) => ({ tag, ...row(rows) }))
		.sort((p, q) => q.conversations - p.conversations)
		.slice(0, 30);
	const byChannel = [
		...groups(cur, (x) => [x.channel === "chat" ? "chat" : "email"]).entries(),
	].map(([channel, rows]) => ({ channel, ...row(rows) }));
	const byPriority = [...groups(cur, (x) => [x.priority ?? "normal"]).entries()].map(
		([priority, rows]) => ({
			priority,
			...row(rows),
		}),
	);

	return {
		object: "inbox_report",
		from,
		to,
		days: span,
		timezone: tz,
		inbox: one ? { id: one.id, name: one.name } : null,
		inboxes: inboxes.map((i) => ({
			id: i.id,
			name: i.name,
			sla: settingsOf(i).sla.enabled,
			csat: settingsOf(i).csat.enabled,
		})),
		totals: now_,
		previous: before,
		now: {
			open: Number(openNow?.n ?? 0),
			unassigned: Number(openNow?.unassigned ?? 0),
			overdue: Number(openNow?.overdue ?? 0),
			snoozed: Number(openNow?.snoozed ?? 0),
			held: Number(openNow?.held ?? 0),
			waiting: Number(openNow?.waiting ?? 0),
			oldest_waiting_at: oldestWaiting?.at ?? null,
			agent_drafts_waiting: Number(waiting?.n ?? 0),
		},
		series: series.map(({ _frt, ...s }) => s),
		heatmap: heat,
		by_inbox: byInbox,
		by_assignee: byAssignee,
		by_responder: [...people.values()].sort((p, q) => q.replies - p.replies),
		by_tag: byTag,
		by_channel: byChannel,
		by_priority: byPriority,
		/** It read CAP rows of something: older or busier data may be left out. */
		capped: [started, resolvedRows, replies, inbound].some((r) => r.length >= CAP),
	};
}

export type InboxReport = Awaited<ReturnType<typeof inboxReport>>;
