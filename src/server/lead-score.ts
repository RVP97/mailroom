import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import {
	checkRules,
	compile,
	condition,
	describeCondition,
	type LeadScoreSql,
} from "./live-segments";
import { iso } from "./time";

/**
 * Lead scores, like HubSpot's: points for what each contact does (opens, clicks, the events your
 * app sends, purchases, chats, survey answers, anything a live segment can check), from the last
 * `days` days, never below 0. Hot and warm are thresholds the brand picks. Worked out in SQL when
 * asked, so they're never stale and live segments can pick hot leads.
 */

const points = z.number().int().min(-100).max(100);
const max = z.number().int().min(1).max(10_000).optional();
const label = z.string().trim().max(80).optional();

/** A rule can check anything a live segment can, except engagement and the lead score itself. */
const matchCondition = condition.refine(
	(c) => c.type !== "engagement" && c.type !== "lead_score",
	"A rule can't check engagement or the lead score",
);

export const scoringRule = z.discriminatedUnion("type", [
	/** Points for each marketing email they got, opened or clicked (up to `max`). */
	z.object({
		type: z.literal("email"),
		action: z.enum(["received", "opened", "clicked"]),
		points,
		max,
		label,
	}),
	/** Points each time your app sent this event (with this data, if set). */
	z.object({
		type: z.literal("event"),
		name: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/, "event: letters, numbers, _ . : and -"),
		key: z
			.string()
			.regex(/^[A-Za-z0-9_.-]{1,64}$/)
			.optional(),
		value: z.string().max(500).optional(),
		points,
		max,
		label,
	}),
	/** Points for each purchase (an event with a value). */
	z.object({ type: z.literal("purchase"), points, max, label }),
	/** Points once if they match (a property, a topic, a segment, a chat, a survey answer…). */
	z.object({ type: z.literal("match"), condition: matchCondition, points, label }),
]);

export type ScoringRule = z.infer<typeof scoringRule>;

export const scoringInput = z
	.object({
		rules: z.array(scoringRule).max(30),
		days: z.number().int().min(7).max(730).default(90),
		hot: z.number().int().min(1).max(100_000).default(50),
		warm: z.number().int().min(0).max(100_000).default(20),
	})
	.refine((s) => s.warm < s.hot, { message: "warm: below hot", path: ["warm"] });

export type Scoring = z.infer<typeof scoringInput>;

/** What a brand starts with. */
export const DEFAULT_SCORING: Scoring = {
	rules: [
		{ type: "email", action: "opened", points: 1, max: 10 },
		{ type: "email", action: "clicked", points: 3, max: 30 },
		{ type: "purchase", points: 15, max: 45 },
		{ type: "match", condition: { type: "chatted", days: 90 }, points: 10 },
		{
			type: "match",
			condition: { type: "conversation", status: "any", did: true, days: 90 },
			points: 5,
		},
		{ type: "match", condition: { type: "subscribed", value: false }, points: -20 },
	],
	days: 90,
	hot: 50,
	warm: 20,
};

export type Level = "hot" | "warm" | "cold";

export const levelOf = (score: number, s: Pick<Scoring, "hot" | "warm">): Level =>
	score >= s.hot ? "hot" : score >= s.warm ? "warm" : "cold";

/** A rule said plainly: "Clicked a marketing email: +3 each (up to 30)". */
export function ruleLabel(r: ScoringRule) {
	if (r.label) return r.label;
	switch (r.type) {
		case "email":
			return `${r.action === "received" ? "Got" : r.action === "opened" ? "Opened" : "Clicked"} a marketing email`;
		case "event":
			return `Did ${r.name}${r.key ? ` (${r.key} = ${r.value ?? ""})` : ""}`;
		case "purchase":
			return "Made a purchase";
		case "match": {
			const d = describeCondition(r.condition);
			return d.charAt(0).toUpperCase() + d.slice(1);
		}
	}
}

const ct = schema.contacts;

export async function getScoring(brand: string): Promise<Scoring & { custom: boolean }> {
	const row = await db
		.select()
		.from(schema.leadScoring)
		.where(eq(schema.leadScoring.organization_id, brand))
		.get();
	if (!row) return { ...DEFAULT_SCORING, custom: false };
	const parsed = scoringInput.safeParse({
		rules: row.rules,
		days: row.days,
		hot: row.hot,
		warm: row.warm,
	});
	// Rules saved before a rule kind changed: keep what still reads.
	if (!parsed.success)
		return {
			rules: (row.rules ?? []).flatMap((r) => {
				const one = scoringRule.safeParse(r);
				return one.success ? [one.data] : [];
			}),
			days: row.days,
			hot: row.hot,
			warm: Math.min(row.warm, row.hot - 1),
			custom: true,
		};
	return { ...parsed.data, custom: true };
}

export async function saveScoring(
	brand: string,
	raw: unknown,
	by: string | null,
	now = Date.now(),
) {
	const s = scoringInput.parse(raw);
	const conditions = s.rules.flatMap((r) => (r.type === "match" ? [r.condition] : []));
	if (conditions.length) await checkRules(brand, { match: "all", conditions });
	const row = {
		organization_id: brand,
		rules: s.rules,
		days: s.days,
		hot: s.hot,
		warm: s.warm,
		updated_by: by,
		updated_at: iso(now),
	};
	await db
		.insert(schema.leadScoring)
		.values(row)
		.onConflictDoUpdate({ target: schema.leadScoring.organization_id, set: row });
	return { ...s, custom: true };
}

/** Back to the default rules. */
export async function resetScoring(brand: string) {
	await db.delete(schema.leadScoring).where(eq(schema.leadScoring.organization_id, brand));
	return { ...DEFAULT_SCORING, custom: false };
}

/** Each rule's points for a contact, as SQL over `contacts`. */
function partsSql(brand: string, s: Scoring, now: number): SQL[] {
	const since = iso(now - s.days * 86_400_000);
	const capped = (p: number, cap: number | undefined, count: SQL) =>
		cap === undefined
			? sql`(${p} * ${count})`
			: p >= 0
				? sql`MIN(${cap}, ${p} * ${count})`
				: sql`MAX(${-cap}, ${p} * ${count})`;
	const one = (r: ScoringRule): SQL => {
		switch (r.type) {
			case "email": {
				const col =
					r.action === "opened"
						? sql`AND opened_at IS NOT NULL`
						: r.action === "clicked"
							? sql`AND clicked_at IS NOT NULL`
							: sql``;
				return capped(
					r.points,
					r.max,
					sql`(SELECT COUNT(*) FROM emails WHERE organization_id = ${brand} AND recipient = ${ct.email} AND created_at >= ${since} AND (broadcast_id IS NOT NULL OR source = 'automation') AND status NOT IN ('scheduled', 'queued', 'sending', 'failed', 'suppressed', 'canceled', 'bounced') ${col})`,
				);
			}
			case "event": {
				const data =
					r.key && r.value !== undefined
						? sql`AND lower(CAST(json_extract(data, ${`$."${r.key}"`}) AS TEXT)) = lower(${r.value})`
						: sql``;
				return capped(
					r.points,
					r.max,
					sql`(SELECT COUNT(*) FROM contact_events WHERE contact_id = ${ct.id} AND name = ${r.name} AND created_at >= ${since} ${data})`,
				);
			}
			case "purchase":
				return capped(
					r.points,
					r.max,
					sql`(SELECT COUNT(*) FROM contact_events WHERE contact_id = ${ct.id} AND value IS NOT NULL AND created_at >= ${since})`,
				);
			case "match": {
				const q = compile(brand, r.condition, now);
				return q ? sql`(CASE WHEN ${q} THEN ${r.points} ELSE 0 END)` : sql`0`;
			}
		}
	};
	return s.rules.map(one);
}

const total = (parts: SQL[]) => (parts.length ? sql`MAX(0, ${sql.join(parts, sql` + `)})` : sql`0`);

/** The brand's lead score as SQL over `contacts` (for live segments). */
export async function leadScoreSql(brand: string, now = Date.now()): Promise<LeadScoreSql> {
	const s = await getScoring(brand);
	return { score: total(partsSql(brand, s, now)), hot: s.hot, warm: s.warm };
}

/** A contact's score, level and what each rule gave. */
export async function contactLeadScore(brand: string, contactId: string, now = Date.now()) {
	const s = await getScoring(brand);
	const parts = partsSql(brand, s, now);
	const cols = Object.fromEntries(parts.map((p, i) => [`p${i}`, sql<number>`${p}`]));
	const row = parts.length
		? ((await db
				.select({ id: ct.id, ...cols })
				.from(ct)
				.where(and(eq(ct.organization_id, brand), eq(ct.id, contactId)))
				.get()) as Record<string, number> | undefined)
		: undefined;
	const breakdown = s.rules
		.map((r, i) => ({ rule: ruleLabel(r), points: Number(row?.[`p${i}`] ?? 0) }))
		.filter((x) => x.points !== 0);
	const score = Math.max(
		0,
		breakdown.reduce((n, x) => n + x.points, 0),
	);
	return { score, level: levelOf(score, s), hot: s.hot, warm: s.warm, days: s.days, breakdown };
}

/** The brand's contacts with the highest scores (above 0), or those of one level. */
export async function topLeads(
	brand: string,
	o: { limit?: number; level?: Level; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const s = await getScoring(brand);
	const score = total(partsSql(brand, s, now));
	const limit = Math.min(Math.max(o.limit ?? 50, 1), 200);
	const level =
		o.level === "hot"
			? sql`score >= ${s.hot}`
			: o.level === "warm"
				? sql`score >= ${s.warm} AND score < ${s.hot}`
				: o.level === "cold"
					? sql`score < ${s.warm}`
					: sql`score > 0`;
	const inner = db
		.select({
			id: ct.id,
			email: ct.email,
			first_name: ct.first_name,
			last_name: ct.last_name,
			unsubscribed: ct.unsubscribed,
			created_at: ct.created_at,
			score: sql<number>`${score}`.as("score"),
		})
		.from(ct)
		.where(eq(ct.organization_id, brand))
		.as("scored");
	const rows = await db.select().from(inner).where(level).orderBy(desc(inner.score)).limit(limit);
	const counts = await db
		.select({
			hot: sql<number>`SUM(CASE WHEN score >= ${s.hot} THEN 1 ELSE 0 END)`,
			warm: sql<number>`SUM(CASE WHEN score >= ${s.warm} AND score < ${s.hot} THEN 1 ELSE 0 END)`,
			scored: sql<number>`SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END)`,
			total: sql<number>`COUNT(*)`,
		})
		.from(inner)
		.get();
	return {
		scoring: s,
		counts: {
			hot: Number(counts?.hot ?? 0),
			warm: Number(counts?.warm ?? 0),
			scored: Number(counts?.scored ?? 0),
			total: Number(counts?.total ?? 0),
		},
		leads: rows.map((r) => ({
			id: r.id,
			email: r.email,
			name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
			unsubscribed: !!r.unsubscribed,
			created_at: r.created_at,
			score: Number(r.score),
			level: levelOf(Number(r.score), s),
		})),
	};
}
