import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { db, raw, schema } from "./db";
import { validation } from "./errors";
import { iso } from "./time";

/**
 * Live segments: a segment whose members are whoever matches its rules, from anything Mailroom
 * knows about a contact: properties, topics, where they came from, when they joined, other
 * segments, how engaged they are, what they did with your emails, the events your app sent
 * (with their data), poll answers, referrals, conversations, support ratings and website chats.
 *
 * Members are kept in contact_segments like any segment's, so broadcasts, campaigns,
 * newsletters, counts and automations use them unchanged. They're worked out again every
 * 15 minutes by the cron, before a broadcast to the segment starts, and when someone opens it;
 * whoever starts matching joins it (and "joins a segment" automations start for them), whoever
 * stops matching leaves. Rules compile to one SQL query over the brand's contacts, except
 * engagement, which is scored in code and joined in after.
 */

const days = z.number().int().min(1).max(3650);
const KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export const LEVELS = ["champion", "engaged", "cooling", "cold", "new"] as const;

export const condition = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("property"),
		key: z.string().regex(KEY, "property: letters, numbers and _ . -"),
		op: z.enum(["is", "is_not", "contains", "set", "not_set", "gt", "lt"]),
		value: z.string().max(500).optional(),
	}),
	z.object({
		type: z.literal("email"),
		op: z.enum(["ends_with", "contains"]),
		value: z.string().trim().min(1).max(200),
	}),
	z.object({ type: z.literal("subscribed"), value: z.boolean() }),
	z.object({ type: z.literal("source"), value: z.string().trim().min(1).max(100) }),
	z.object({ type: z.literal("joined"), op: z.enum(["within", "before"]), days }),
	z.object({
		type: z.literal("topic"),
		topic_id: z.string().min(1),
		value: z.enum(["opt_in", "opt_out"]),
	}),
	z.object({ type: z.literal("segment"), segment_id: z.string().min(1), value: z.boolean() }),
	z.object({ type: z.literal("engagement"), levels: z.array(z.enum(LEVELS)).min(1) }),
	z.object({
		type: z.literal("email_activity"),
		action: z.enum(["received", "opened", "clicked"]),
		did: z.boolean(),
		days,
		min: z.number().int().min(1).max(1000).optional(),
		broadcast_id: z.string().nullish(),
	}),
	z.object({
		type: z.literal("event"),
		name: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "event: letters, numbers, _ . : and -"),
		did: z.boolean(),
		days: days.optional(),
		min: z.number().int().min(1).max(1000).optional(),
		key: z.string().regex(KEY).optional(),
		value: z.string().max(500).optional(),
	}),
	z.object({
		type: z.literal("poll"),
		broadcast_id: z.string().min(1),
		poll_id: z.string().optional(),
		answer: z.number().int().min(0).max(20),
	}),
	z.object({ type: z.literal("referrals"), min: z.number().int().min(1).max(100_000) }),
	z.object({
		type: z.literal("conversation"),
		status: z.enum(["open", "any"]),
		did: z.boolean(),
		days: days.optional(),
	}),
	z.object({
		type: z.literal("rating"),
		op: z.enum(["at_most", "at_least"]),
		value: z.number().int().min(1).max(5),
		days: days.optional(),
	}),
	z.object({
		type: z.literal("survey"),
		survey_id: z.string().min(1),
		/** any answer; an NPS group; a score at least/at most `value`; or the choice `value`. */
		answer: z.enum([
			"any",
			"promoter",
			"passive",
			"detractor",
			"at_least",
			"at_most",
			"choice",
		]),
		value: z.number().int().min(0).max(10).optional(),
		days: days.optional(),
	}),
	z.object({
		type: z.literal("chatted"),
		page: z.string().trim().max(500).optional(),
		days: days.optional(),
	}),
	/** Their lead score (src/server/lead-score.ts): at least or at most `value`, or a level. */
	z.object({
		type: z.literal("lead_score"),
		op: z.enum(["at_least", "at_most", "hot", "warm", "cold"]),
		value: z.number().int().min(-1000).max(100_000).optional(),
	}),
]);

export const segmentRules = z.object({
	match: z.enum(["all", "any"]).default("all"),
	conditions: z.array(condition).min(1, "Add at least one rule").max(20),
});

export type SegmentCondition = z.infer<typeof condition>;
export type SegmentRules = z.infer<typeof segmentRules>;

const ct = schema.contacts;
const since = (d: number, now: number) => iso(now - d * 86_400_000);

/** What a lead_score rule compares: the brand's score as SQL and its levels. */
export type LeadScoreSql = { score: SQL; hot: number; warm: number };

/** One rule as SQL over `contacts`; null for engagement (scored in code). */
export function compile(
	brand: string,
	c: SegmentCondition,
	now: number,
	lead?: LeadScoreSql,
): SQL | null {
	switch (c.type) {
		case "lead_score": {
			if (!lead) throw validation("lead_score: not here");
			const s = lead.score;
			if (c.op === "hot") return sql`${s} >= ${lead.hot}`;
			if (c.op === "warm") return sql`(${s} >= ${lead.warm} AND ${s} < ${lead.hot})`;
			if (c.op === "cold") return sql`${s} < ${lead.warm}`;
			return c.op === "at_least"
				? sql`${s} >= ${c.value ?? 0}`
				: sql`${s} <= ${c.value ?? 0}`;
		}
		case "property": {
			const path = `$."${c.key}"`;
			const v = sql`json_extract(${ct.properties}, ${path})`;
			if (c.op === "set") return sql`(${v} IS NOT NULL AND ${v} <> '')`;
			if (c.op === "not_set") return sql`(${v} IS NULL OR ${v} = '')`;
			const value = c.value ?? "";
			if (c.op === "is") return sql`lower(CAST(${v} AS TEXT)) = lower(${value})`;
			if (c.op === "is_not")
				return sql`(${v} IS NULL OR lower(CAST(${v} AS TEXT)) <> lower(${value}))`;
			if (c.op === "contains")
				return sql`instr(lower(CAST(${v} AS TEXT)), lower(${value})) > 0`;
			const n = Number(value);
			if (!Number.isFinite(n)) throw validation(`${c.key}: "${value}" isn't a number`);
			return c.op === "gt" ? sql`CAST(${v} AS REAL) > ${n}` : sql`CAST(${v} AS REAL) < ${n}`;
		}
		case "email":
			return c.op === "ends_with"
				? sql`substr(${ct.email}, -${c.value.length}) = lower(${c.value})`
				: sql`instr(${ct.email}, lower(${c.value})) > 0`;
		case "subscribed":
			return eq(ct.unsubscribed, !c.value);
		case "source":
			return c.value === "form" ? sql`${ct.source} LIKE 'form:%'` : eq(ct.source, c.value);
		case "joined":
			return c.op === "within"
				? sql`${ct.created_at} >= ${since(c.days, now)}`
				: sql`${ct.created_at} < ${since(c.days, now)}`;
		case "topic":
			return sql`COALESCE(
				(SELECT subscription FROM contact_topics WHERE contact_id = ${ct.id} AND topic_id = ${c.topic_id}),
				(SELECT default_subscription FROM topics WHERE id = ${c.topic_id} AND organization_id = ${brand})
			) = ${c.value}`;
		case "segment": {
			const inIt = sql`EXISTS (SELECT 1 FROM contact_segments WHERE contact_id = ${ct.id} AND segment_id = ${c.segment_id})`;
			return c.value ? inIt : sql`NOT ${inIt}`;
		}
		case "engagement":
			return null;
		case "email_activity": {
			const col =
				c.action === "opened"
					? sql`AND opened_at IS NOT NULL`
					: c.action === "clicked"
						? sql`AND clicked_at IS NOT NULL`
						: sql``;
			const only = c.broadcast_id ? sql`AND broadcast_id = ${c.broadcast_id}` : sql``;
			const count = sql`(SELECT COUNT(*) FROM emails WHERE organization_id = ${brand} AND recipient = ${ct.email} AND created_at >= ${since(c.days, now)} ${col} ${only})`;
			return c.did ? sql`${count} >= ${c.min ?? 1}` : sql`${count} = 0`;
		}
		case "event": {
			const window = c.days ? sql`AND created_at >= ${since(c.days, now)}` : sql``;
			const data =
				c.key && c.value !== undefined
					? sql`AND lower(CAST(json_extract(data, ${`$."${c.key}"`}) AS TEXT)) = lower(${c.value})`
					: sql``;
			const count = sql`(SELECT COUNT(*) FROM contact_events WHERE contact_id = ${ct.id} AND name = ${c.name} ${window} ${data})`;
			return c.did ? sql`${count} >= ${c.min ?? 1}` : sql`${count} = 0`;
		}
		case "poll":
			return sql`EXISTS (SELECT 1 FROM poll_votes WHERE contact_id = ${ct.id} AND broadcast_id = ${c.broadcast_id} ${c.poll_id ? sql`AND poll_id = ${c.poll_id}` : sql``} AND answer = ${c.answer})`;
		case "referrals":
			return sql`${ct.referrals} >= ${c.min}`;
		case "conversation": {
			const status = c.status === "open" ? sql`AND status = 'open'` : sql``;
			const window = c.days ? sql`AND created_at >= ${since(c.days, now)}` : sql``;
			const has = sql`EXISTS (SELECT 1 FROM conversations WHERE organization_id = ${brand} AND contact_address = ${ct.email} ${status} ${window})`;
			return c.did ? has : sql`NOT ${has}`;
		}
		case "rating": {
			const window = c.days ? sql`AND csat_at >= ${since(c.days, now)}` : sql``;
			const cmp = c.op === "at_most" ? sql`<= ${c.value}` : sql`>= ${c.value}`;
			// Their latest rating.
			return sql`(SELECT csat_rating FROM conversations WHERE organization_id = ${brand} AND contact_address = ${ct.email} AND csat_rating IS NOT NULL ${window} ORDER BY csat_at DESC LIMIT 1) ${cmp}`;
		}
		case "survey": {
			const window = c.days ? sql`AND updated_at >= ${since(c.days, now)}` : sql``;
			const v = c.value ?? 0;
			const answer =
				c.answer === "promoter"
					? sql`AND score >= 9`
					: c.answer === "passive"
						? sql`AND score BETWEEN 7 AND 8`
						: c.answer === "detractor"
							? sql`AND score <= 6`
							: c.answer === "at_least"
								? sql`AND score >= ${v}`
								: c.answer === "at_most"
									? sql`AND score <= ${v}`
									: c.answer === "choice"
										? sql`AND score = ${v}`
										: sql``;
			// Their latest answer to it.
			return sql`EXISTS (SELECT 1 FROM survey_responses WHERE id = (SELECT id FROM survey_responses WHERE contact_id = ${ct.id} AND survey_id = ${c.survey_id} ORDER BY updated_at DESC LIMIT 1) ${answer} ${window})`;
		}
		case "chatted": {
			const window = c.days ? sql`AND created_at >= ${since(c.days, now)}` : sql``;
			const page = c.page ? sql`AND instr(lower(page_url), lower(${c.page})) > 0` : sql``;
			return sql`EXISTS (SELECT 1 FROM conversations WHERE organization_id = ${brand} AND contact_address = ${ct.email} AND channel = 'chat' ${window} ${page})`;
		}
	}
}

/** Checks the rules name things of this brand (topics, segments that aren't live). */
export async function checkRules(brand: string, raw: unknown, selfId?: string) {
	const rules = segmentRules.parse(raw);
	const segs = rules.conditions.filter((c) => c.type === "segment").map((c) => c.segment_id);
	const topics = rules.conditions.filter((c) => c.type === "topic").map((c) => c.topic_id);
	if (segs.length) {
		const rows = await db
			.select({ id: schema.segments.id, rules: schema.segments.rules })
			.from(schema.segments)
			.where(
				and(eq(schema.segments.organization_id, brand), inArray(schema.segments.id, segs)),
			);
		for (const id of segs) {
			const r = rows.find((x) => x.id === id);
			if (!r) throw validation("A rule names a segment this brand doesn't have");
			if (r.rules || id === selfId)
				throw validation("A rule can only name a list segment, not a live one");
		}
	}
	if (topics.length) {
		const rows = await db
			.select({ id: schema.topics.id })
			.from(schema.topics)
			.where(
				and(eq(schema.topics.organization_id, brand), inArray(schema.topics.id, topics)),
			);
		if (rows.length < new Set(topics).size)
			throw validation("A rule names a topic this brand doesn't have");
	}
	const surveys = rules.conditions.filter((c) => c.type === "survey").map((c) => c.survey_id);
	if (surveys.length) {
		const rows = await db
			.select({ id: schema.surveys.id })
			.from(schema.surveys)
			.where(
				and(eq(schema.surveys.organization_id, brand), inArray(schema.surveys.id, surveys)),
			);
		if (rows.length < new Set(surveys).size)
			throw validation("A rule names a survey this brand doesn't have");
	}
	return rules;
}

const MAX_MEMBERS = 100_000;

/** The ids of the brand's contacts who match the rules now. */
export async function matching(brand: string, rules: SegmentRules, now = Date.now()) {
	const lead = rules.conditions.some((c) => c.type === "lead_score")
		? await (await import("./lead-score")).leadScoreSql(brand, now)
		: undefined;
	const parts = rules.conditions.map((c) => ({ c, q: compile(brand, c, now, lead) }));
	const sqlParts = parts.filter((p) => p.q).map((p) => p.q as SQL);
	const engagement = parts.filter((p) => !p.q).map((p) => p.c) as Extract<
		SegmentCondition,
		{ type: "engagement" }
	>[];
	const joiner = rules.match === "any" ? sql` OR ` : sql` AND `;
	const where = sqlParts.length ? sql`(${sql.join(sqlParts, joiner)})` : null;
	const select = (w: SQL | null) =>
		db
			.select({ id: ct.id, email: ct.email })
			.from(ct)
			.where(and(eq(ct.organization_id, brand), w ?? undefined))
			.limit(MAX_MEMBERS);
	if (!engagement.length) return (await select(where)).map((r) => r.id);
	// Engagement is scored in code: over the rule-matched contacts (all), or everyone (any).
	const base = rules.match === "all" ? await select(where) : await select(null);
	const { engagementOf } = await import("./engagement");
	const scored = new Map<string, string>();
	for (let i = 0; i < base.length; i += 2000) {
		const chunk = base.slice(i, i + 2000);
		const m = await engagementOf(brand, chunk);
		for (const [id, e] of m) scored.set(id, e.level);
	}
	const fits = (id: string) =>
		rules.match === "all"
			? engagement.every((e) => e.levels.includes(scored.get(id) as never))
			: engagement.some((e) => e.levels.includes(scored.get(id) as never));
	if (rules.match === "all") return base.filter((r) => fits(r.id)).map((r) => r.id);
	const byRules = where ? new Set((await select(where)).map((r) => r.id)) : new Set<string>();
	return base.filter((r) => byRules.has(r.id) || fits(r.id)).map((r) => r.id);
}

/** How many match, and a few of them, for the editor's preview. */
export async function previewRules(brand: string, raw: unknown, now = Date.now()) {
	const rules = await checkRules(brand, raw);
	const ids = await matching(brand, rules, now);
	const sample = ids.length
		? await db
				.select({
					id: ct.id,
					email: ct.email,
					first_name: ct.first_name,
					last_name: ct.last_name,
				})
				.from(ct)
				.where(inArray(ct.id, ids.slice(0, 8)))
		: [];
	return { count: ids.length, sample };
}

/**
 * Works a live segment's members out again: who matches now joins (and its "joins a segment"
 * automations start for them), who doesn't leaves. Returns how many joined and left.
 */
export async function refreshSegment(
	s: { id: string; organization_id: string; rules: SegmentRules | null },
	now = Date.now(),
) {
	if (!s.rules) return { joined: 0, left: 0 };
	const want = new Set(await matching(s.organization_id, s.rules, now));
	const cs = schema.contactSegments;
	const have = new Set(
		(await db.select({ id: cs.contact_id }).from(cs).where(eq(cs.segment_id, s.id))).map(
			(r) => r.id,
		),
	);
	const joined = [...want].filter((id) => !have.has(id));
	const left = [...have].filter((id) => !want.has(id));
	const at = iso(now);
	for (let i = 0; i < joined.length; i += 50)
		await db
			.insert(cs)
			.values(
				joined
					.slice(i, i + 50)
					.map((contact_id) => ({ contact_id, segment_id: s.id, created_at: at })),
			)
			.onConflictDoNothing();
	for (let i = 0; i < left.length; i += 90)
		await db
			.delete(cs)
			.where(and(eq(cs.segment_id, s.id), inArray(cs.contact_id, left.slice(i, i + 90))));
	await db.update(schema.segments).set({ refreshed_at: at }).where(eq(schema.segments.id, s.id));
	if (joined.length) {
		const { onSegmentJoined } = await import("./automations");
		// Only when someone set an automation on it: most live segments have none.
		const hasAutomation = await db
			.select({ id: schema.automations.id })
			.from(schema.automations)
			.where(
				and(
					eq(schema.automations.organization_id, s.organization_id),
					eq(schema.automations.status, "active"),
					sql`json_extract(${schema.automations.trigger}, '$.segment_id') = ${s.id}`,
				),
			)
			.get();
		if (hasAutomation)
			for (const id of joined.slice(0, 5000))
				await onSegmentJoined(s.organization_id, id, s.id, now);
	}
	return { joined: joined.length, left: left.length };
}

/** A segment by id, refreshed first when it's live and older than `maxAgeMs`. */
export async function freshSegment(brand: string, id: string, maxAgeMs = 60_000, now = Date.now()) {
	const s = await db
		.select()
		.from(schema.segments)
		.where(and(eq(schema.segments.id, id), eq(schema.segments.organization_id, brand)))
		.get();
	if (s?.rules && (!s.refreshed_at || Date.parse(s.refreshed_at) < now - maxAgeMs))
		await refreshSegment(s, now);
	return s;
}

/** The cron: every live segment not refreshed in the last 15 minutes, oldest first. */
export async function refreshLiveSegments(now = Date.now(), max = 25) {
	const due = await db
		.select()
		.from(schema.segments)
		.where(
			and(
				isNotNull(schema.segments.rules),
				sql`(${schema.segments.refreshed_at} IS NULL OR ${schema.segments.refreshed_at} < ${iso(now - 14 * 60_000)})`,
			),
		)
		.orderBy(sql`${schema.segments.refreshed_at} IS NOT NULL, ${schema.segments.refreshed_at}`)
		.limit(max);
	for (const s of due)
		await refreshSegment(s, now).catch((e) =>
			console.error("live segments: refresh failed", s.id, e),
		);
	return due.length;
}

/**
 * What rules can pick from: the brand's event names, sign-up forms, topics, list segments and
 * the polls in its recent broadcasts (with their answers).
 */
export async function segmentOptions(brand: string) {
	const { eventNames } = await import("./contact-events");
	const { pollsIn } = await import("./polls");
	const b = schema.broadcasts;
	const [events, forms, topics, segments, recent, props, surveys] = await Promise.all([
		eventNames(brand),
		db
			.select({ id: schema.signupForms.id, name: schema.signupForms.name })
			.from(schema.signupForms)
			.where(eq(schema.signupForms.organization_id, brand)),
		db
			.select({ id: schema.topics.id, name: schema.topics.name })
			.from(schema.topics)
			.where(eq(schema.topics.organization_id, brand)),
		db
			.select({
				id: schema.segments.id,
				name: schema.segments.name,
				rules: schema.segments.rules,
			})
			.from(schema.segments)
			.where(eq(schema.segments.organization_id, brand)),
		db
			.select({ id: b.id, name: b.name, subject: b.subject, design: b.design })
			.from(b)
			.where(and(eq(b.organization_id, brand), sql`${b.design} LIKE '%"poll"%'`))
			.orderBy(sql`${b.created_at} DESC`)
			.limit(30),
		db
			.select({ key: schema.contactProperties.key, type: schema.contactProperties.type })
			.from(schema.contactProperties)
			.where(eq(schema.contactProperties.organization_id, brand)),
		db
			.select({
				id: schema.surveys.id,
				name: schema.surveys.name,
				kind: schema.surveys.kind,
				options: schema.surveys.options,
			})
			.from(schema.surveys)
			.where(eq(schema.surveys.organization_id, brand)),
	]);
	return {
		events,
		forms,
		topics,
		properties: props,
		surveys,
		segments: segments.filter((s) => !s.rules).map(({ rules: _r, ...s }) => s),
		polls: recent.flatMap((x) =>
			pollsIn(x.design).map((p) => ({
				broadcast_id: x.id,
				broadcast: x.name || x.subject,
				poll_id: p.id,
				question: p.question,
				options: p.options,
			})),
		),
	};
}

/** Used by tests: raw count of a segment's members. */
export const memberCount = async (segmentId: string) =>
	Number(
		(
			await raw(
				"SELECT COUNT(*) AS n FROM contact_segments WHERE segment_id = ?1",
				segmentId,
			).first<{ n: number }>()
		)?.n ?? 0,
	);

/** What a rule says, in a few words (lists, the assistant). */
export function describeCondition(c: SegmentCondition): string {
	switch (c.type) {
		case "property":
			return c.op === "set"
				? `${c.key} is set`
				: c.op === "not_set"
					? `${c.key} is empty`
					: `${c.key} ${({ is: "is", is_not: "isn't", contains: "contains", gt: ">", lt: "<" } as const)[c.op]} ${c.value ?? ""}`;
		case "email":
			return `email ${c.op === "ends_with" ? "ends with" : "contains"} ${c.value}`;
		case "subscribed":
			return c.value ? "subscribed" : "unsubscribed";
		case "source":
			return `came from ${c.value}`;
		case "joined":
			return c.op === "within"
				? `joined in the last ${c.days} days`
				: `joined over ${c.days} days ago`;
		case "topic":
			return `${c.value === "opt_in" ? "in" : "out of"} a topic`;
		case "segment":
			return `${c.value ? "in" : "not in"} a segment`;
		case "engagement":
			return `engagement: ${c.levels.join(", ")}`;
		case "email_activity":
			return `${c.did ? c.action : `not ${c.action}`}${c.min && c.min > 1 ? ` ${c.min}+` : ""} in ${c.days} days`;
		case "event":
			return `${c.did ? "did" : "didn't do"} ${c.name}${c.key ? ` (${c.key} = ${c.value})` : ""}${c.days ? ` in ${c.days} days` : ""}`;
		case "poll":
			return "answered a poll";
		case "referrals":
			return `referred ${c.min}+`;
		case "conversation":
			return `${c.did ? "has" : "has no"} ${c.status === "open" ? "open " : ""}conversation`;
		case "rating":
			return `rated ${c.op === "at_most" ? "≤" : "≥"} ${c.value}`;
		case "survey":
			return c.answer === "any"
				? "answered a survey"
				: c.answer === "at_least" || c.answer === "at_most"
					? `survey score ${c.answer === "at_most" ? "≤" : "≥"} ${c.value ?? 0}`
					: c.answer === "choice"
						? "picked a survey answer"
						: `a survey ${c.answer}`;
		case "chatted":
			return `chatted${c.page ? ` on ${c.page}` : ""}`;
		case "lead_score":
			return c.op === "at_least" || c.op === "at_most"
				? `lead score ${c.op === "at_most" ? "≤" : "≥"} ${c.value ?? 0}`
				: `a ${c.op} lead`;
	}
}
