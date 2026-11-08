import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { zonedInstant } from "../lib/zoned";
import { db, schema } from "./db";
import { timezone } from "./env";
import { iso } from "./time";

/**
 * Today: what needs someone now, across sending, the audience and support. Broadcasts waiting for
 * an approval (or sent back to you), conversations about to miss or past their service level, the
 * ones assigned to you, notes that mention you, broadcasts going out today, unhappy survey
 * answers from the last day, and anything wrong with how the brand's email gets delivered.
 */

const b = schema.broadcasts;
const c = schema.conversations;

/** Midnight to midnight of today in the deployment's time zone. */
export function todaySpan(now = Date.now(), tz = timezone()) {
	const day = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(now));
	const start = zonedInstant(`${day}T00:00`, tz);
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
	const end = zonedInstant(`${next}T00:00`, tz);
	return { day, start, end, tz };
}

export async function today(
	o: {
		brands: string[];
		userId: string;
		canApprove: boolean;
		canReply: boolean;
		names: Map<string, string>;
	},
	now = Date.now(),
) {
	const { brands, userId } = o;
	const span = todaySpan(now);
	const soon = iso(now + 2 * 3_600_000);
	const reader = `user:${userId}`;
	const brandName = (id: string) => (brands.length > 1 ? (o.names.get(id) ?? null) : null);
	const [
		review,
		sentBack,
		late,
		mine,
		mineCount,
		unassigned,
		mentions,
		going,
		unhappy,
		sending,
		domains,
	] = await Promise.all([
		o.canApprove
			? db
					.select({
						id: b.id,
						organization_id: b.organization_id,
						name: b.name,
						subject: b.subject,
						by: b.review_requested_by,
						at: b.review_requested_at,
					})
					.from(b)
					.where(
						and(
							inArray(b.organization_id, brands),
							eq(b.review, "requested"),
							eq(b.status, "draft"),
							or(isNull(b.review_requested_by), ne(b.review_requested_by, userId)),
						),
					)
					.orderBy(asc(b.review_requested_at))
					.limit(10)
			: Promise.resolve([]),
		db
			.select({
				id: b.id,
				organization_id: b.organization_id,
				name: b.name,
				subject: b.subject,
				by: b.reviewed_by,
				at: b.reviewed_at,
			})
			.from(b)
			.where(
				and(
					inArray(b.organization_id, brands),
					eq(b.review, "changes"),
					eq(b.status, "draft"),
					eq(b.review_requested_by, userId),
				),
			)
			.orderBy(desc(b.reviewed_at))
			.limit(10),
		db
			.select({
				id: c.id,
				organization_id: c.organization_id,
				subject: c.subject,
				contact: c.contact,
				assignee_name: c.assignee_name,
				first_due: c.sla_first_due_at,
				resolve_due: c.sla_resolve_due_at,
				breached: c.sla_breached,
				priority: c.priority,
			})
			.from(c)
			.where(
				and(
					inArray(c.organization_id, brands),
					eq(c.status, "open"),
					or(
						isNotNull(c.sla_breached),
						lte(c.sla_first_due_at, soon),
						lte(c.sla_resolve_due_at, soon),
					),
				),
			)
			.orderBy(sql`COALESCE(${c.sla_first_due_at}, ${c.sla_resolve_due_at}) ASC`)
			.limit(10),
		db
			.select({
				id: c.id,
				organization_id: c.organization_id,
				subject: c.subject,
				contact: c.contact,
				last: c.last_message_at,
				priority: c.priority,
				channel: c.channel,
			})
			.from(c)
			.where(
				and(
					inArray(c.organization_id, brands),
					eq(c.status, "open"),
					eq(c.assignee, reader),
				),
			)
			.orderBy(desc(c.last_message_at))
			.limit(8),
		db
			.select({ n: sql<number>`COUNT(*)` })
			.from(c)
			.where(
				and(
					inArray(c.organization_id, brands),
					eq(c.status, "open"),
					eq(c.assignee, reader),
				),
			)
			.get(),
		db
			.select({ n: sql<number>`COUNT(*)` })
			.from(c)
			.where(
				and(inArray(c.organization_id, brands), eq(c.status, "open"), isNull(c.assignee)),
			)
			.get(),
		db
			.select({
				id: schema.conversationNotes.id,
				conversation_id: schema.conversationNotes.conversation_id,
				author: schema.conversationNotes.author_name,
				text: schema.conversationNotes.text,
				at: schema.conversationNotes.created_at,
				subject: c.subject,
			})
			.from(schema.conversationNotes)
			.innerJoin(c, eq(c.id, schema.conversationNotes.conversation_id))
			.where(
				and(
					inArray(schema.conversationNotes.organization_id, brands),
					gte(schema.conversationNotes.created_at, iso(now - 3 * 86_400_000)),
					sql`${schema.conversationNotes.mentions} LIKE ${`%"id":"${userId.replace(/["%_]/g, "")}"%`}`,
					eq(c.status, "open"),
				),
			)
			.orderBy(desc(schema.conversationNotes.created_at))
			.limit(5),
		db
			.select({
				id: b.id,
				organization_id: b.organization_id,
				name: b.name,
				subject: b.subject,
				status: b.status,
				scheduled_at: b.scheduled_at,
				queued: b.queued,
			})
			.from(b)
			.where(
				and(
					inArray(b.organization_id, brands),
					or(
						eq(b.status, "sending"),
						and(eq(b.status, "scheduled"), lte(b.scheduled_at, iso(span.end))),
					),
				),
			)
			.orderBy(asc(b.scheduled_at))
			.limit(10),
		db
			.select({
				id: schema.surveyResponses.id,
				survey_id: schema.surveyResponses.survey_id,
				survey: schema.surveys.name,
				kind: schema.surveys.kind,
				score: schema.surveyResponses.score,
				comment: schema.surveyResponses.comment,
				email: schema.surveyResponses.email,
				contact_id: schema.surveyResponses.contact_id,
				source: schema.surveyResponses.source,
				conversation_id: schema.surveyResponses.source_id,
				at: schema.surveyResponses.updated_at,
			})
			.from(schema.surveyResponses)
			.innerJoin(schema.surveys, eq(schema.surveys.id, schema.surveyResponses.survey_id))
			.where(
				and(
					inArray(schema.surveyResponses.organization_id, brands),
					gte(schema.surveyResponses.updated_at, iso(now - 86_400_000)),
					sql`((${schema.surveys.kind} = 'nps' AND ${schema.surveyResponses.score} <= 6) OR (${schema.surveys.kind} = 'csat' AND ${schema.surveyResponses.score} <= 2))`,
				),
			)
			.orderBy(desc(schema.surveyResponses.updated_at))
			.limit(8),
		db
			.select({
				organization_id: schema.orgSending.organization_id,
				status: schema.orgSending.status,
				tenant_status: schema.orgSending.tenant_status,
				alert_level: schema.orgSending.alert_level,
				marketing_alert_level: schema.orgSending.marketing_alert_level,
				alerted_at: schema.orgSending.alerted_at,
			})
			.from(schema.orgSending)
			.where(inArray(schema.orgSending.organization_id, brands)),
		db
			.select({
				id: schema.domains.id,
				organization_id: schema.domains.organization_id,
				name: schema.domains.name,
				status: schema.domains.status,
				paused_at: schema.domains.paused_at,
				paused_reason: schema.domains.paused_reason,
				checked_at: schema.domains.checked_at,
			})
			.from(schema.domains)
			.where(
				and(
					inArray(schema.domains.organization_id, brands),
					or(
						isNotNull(schema.domains.paused_at),
						inArray(schema.domains.status, ["failed", "temporary_failure"]),
					),
				),
			),
	]);
	// Who asked: the members' names.
	const people = [...review.map((r) => r.by), ...sentBack.map((r) => r.by)].filter(
		Boolean,
	) as string[];
	const users = people.length
		? await db
				.select({ id: schema.user.id, name: schema.user.name, email: schema.user.email })
				.from(schema.user)
				.where(inArray(schema.user.id, [...new Set(people)]))
		: [];
	const who = (id: string | null) => {
		const u = users.find((x) => x.id === id);
		return u ? u.name || u.email : null;
	};
	const deliverability = [
		...sending.flatMap((s) => {
			const out: {
				level: "warning" | "danger";
				brand: string | null;
				text: string;
				link: string;
			}[] = [];
			if (
				s.tenant_status &&
				!["ENABLED", "ACTIVE", "enabled", "active"].includes(s.tenant_status)
			)
				out.push({
					level: "danger",
					brand: brandName(s.organization_id),
					text: "Amazon SES paused this brand's sending (its reputation).",
					link: "/settings",
				});
			for (const [kind, level] of [
				["Transactional", s.alert_level],
				["Marketing", s.marketing_alert_level],
			] as const)
				if (level === "warning" || level === "danger" || level === "paused")
					out.push({
						level: level === "warning" ? "warning" : "danger",
						brand: brandName(s.organization_id),
						text: `${kind} email ${level === "paused" ? "is paused" : level === "danger" ? "crossed the bounce or complaint limit" : "is near the bounce or complaint limit"} over the last 7 days.`,
						link: "/insights",
					});
			return out;
		}),
		...domains.map((d) => ({
			level: (d.paused_at ? "danger" : "warning") as "warning" | "danger",
			brand: brandName(d.organization_id),
			text: d.paused_at
				? `${d.name} is paused${d.paused_reason ? `: ${d.paused_reason}` : ""}.`
				: `${d.name} failed its DNS check: its emails may not send.`,
			link: `/domains/${d.id}`,
		})),
	];
	const slaDue = (x: (typeof late)[number]) =>
		[x.first_due, x.resolve_due].filter(Boolean).sort()[0] ?? null;
	return {
		day: span.day,
		timezone: span.tz,
		approvals: review.map((r) => ({
			id: r.id,
			name: r.name || r.subject || "Untitled",
			brand: brandName(r.organization_id),
			requested_by: who(r.by),
			requested_at: r.at,
		})),
		sent_back: sentBack.map((r) => ({
			id: r.id,
			name: r.name || r.subject || "Untitled",
			brand: brandName(r.organization_id),
			reviewed_by: who(r.by),
			reviewed_at: r.at,
		})),
		sla: late.map((x) => ({
			id: x.id,
			subject: x.subject || "(no subject)",
			contact: x.contact,
			brand: brandName(x.organization_id),
			assignee: x.assignee_name,
			priority: x.priority,
			breached: !!x.breached,
			due_at: slaDue(x),
		})),
		mine: {
			count: Number(mineCount?.n ?? 0),
			conversations: mine.map((x) => ({
				id: x.id,
				subject: x.subject || "(no subject)",
				contact: x.contact,
				brand: brandName(x.organization_id),
				priority: x.priority,
				channel: x.channel,
				last_message_at: x.last,
			})),
		},
		unassigned: o.canReply ? Number(unassigned?.n ?? 0) : 0,
		mentions: mentions.map((m) => ({
			conversation_id: m.conversation_id,
			subject: m.subject || "(no subject)",
			author: m.author,
			text: m.text.slice(0, 200),
			at: m.at,
		})),
		going_out: going.map((x) => ({
			id: x.id,
			name: x.name || x.subject || "Untitled",
			brand: brandName(x.organization_id),
			status: x.status,
			scheduled_at: x.scheduled_at,
			queued: x.queued,
		})),
		unhappy: unhappy.map((r) => ({
			survey_id: r.survey_id,
			survey: r.survey,
			kind: r.kind,
			score: r.score,
			comment: r.comment,
			email: r.email,
			contact_id: r.contact_id,
			conversation_id: r.conversation_id || null,
			source: r.source,
			at: r.at,
		})),
		deliverability,
	};
}
