import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { iso } from "./time";

/**
 * A brand's list growth: who joined and who left each day, and where the new ones came from (which
 * sign-up form, referrals, imports, the API…, and the utm_source or website of a sign-up). From
 * the contacts themselves (created_at, unsubscribed_at, source), so it needs nothing of its own;
 * a deleted contact drops out of it.
 */

const ct = schema.contacts;

export const growthInput = z.object({ days: z.number().int().min(7).max(365).default(30) });

export type SourceKind =
	| "form"
	| "referral"
	| "import"
	| "api"
	| "dashboard"
	| "mcp"
	| "event"
	| "unknown";

const day = (s: string) => s.slice(0, 10);

export async function growth(brand: string, o: { days?: number } = {}, now = Date.now()) {
	const days = o.days ?? 30;
	// From the start of the first day, in UTC.
	const startMs = Date.UTC(
		new Date(now).getUTCFullYear(),
		new Date(now).getUTCMonth(),
		new Date(now).getUTCDate() - (days - 1),
	);
	const start = iso(startMs);
	const [joinedRows, leftRows, totals, sources, details] = await Promise.all([
		db
			.select({ day: sql<string>`substr(${ct.created_at}, 1, 10)`, n: sql<number>`COUNT(*)` })
			.from(ct)
			.where(and(eq(ct.organization_id, brand), gte(ct.created_at, start)))
			.groupBy(sql`1`),
		db
			.select({
				day: sql<string>`substr(${ct.unsubscribed_at}, 1, 10)`,
				n: sql<number>`COUNT(*)`,
			})
			.from(ct)
			.where(
				and(
					eq(ct.organization_id, brand),
					isNotNull(ct.unsubscribed_at),
					gte(ct.unsubscribed_at, start),
				),
			)
			.groupBy(sql`1`),
		db
			.select({
				subscribed: sql<number>`SUM(CASE WHEN ${ct.unsubscribed} = 0 THEN 1 ELSE 0 END)`,
				total: sql<number>`COUNT(*)`,
			})
			.from(ct)
			.where(eq(ct.organization_id, brand))
			.get(),
		db
			.select({
				source: ct.source,
				joined: sql<number>`COUNT(*)`,
				stayed: sql<number>`SUM(CASE WHEN ${ct.unsubscribed} = 0 THEN 1 ELSE 0 END)`,
			})
			.from(ct)
			.where(and(eq(ct.organization_id, brand), gte(ct.created_at, start)))
			.groupBy(ct.source),
		db
			.select({ detail: ct.source_detail, joined: sql<number>`COUNT(*)` })
			.from(ct)
			.where(
				and(
					eq(ct.organization_id, brand),
					gte(ct.created_at, start),
					isNotNull(ct.source_detail),
				),
			)
			.groupBy(ct.source_detail)
			.orderBy(sql`2 DESC`)
			.limit(10),
	]);
	const joinedBy = new Map(joinedRows.map((r) => [r.day, Number(r.n)]));
	const leftBy = new Map(leftRows.map((r) => [r.day, Number(r.n)]));
	const series = Array.from({ length: days }, (_, i) => {
		const d = day(iso(startMs + i * 86_400_000));
		const joined = joinedBy.get(d) ?? 0;
		const left = leftBy.get(d) ?? 0;
		return { day: d, joined, left, net: joined - left };
	});
	const joined = series.reduce((a, s) => a + s.joined, 0);
	const left = series.reduce((a, s) => a + s.left, 0);
	const subscribed = Number(totals?.subscribed ?? 0);
	// Subscribed when the period began: today's, less what changed since.
	const before = Math.max(0, subscribed - joined + left);
	let running = before;
	const withTotal = series.map((s) => {
		running += s.net;
		return { ...s, subscribed: running };
	});

	const formIds = sources
		.map((s) => s.source)
		.filter((s): s is string => !!s?.startsWith("form:"))
		.map((s) => s.slice(5));
	const forms = formIds.length
		? await db
				.select({ id: schema.signupForms.id, name: schema.signupForms.name })
				.from(schema.signupForms)
				.where(inArray(schema.signupForms.id, formIds))
		: [];
	const formName = new Map(forms.map((f) => [f.id, f.name]));
	const bySource = sources
		.map((s) => {
			const raw = s.source ?? "";
			const kind: SourceKind = raw.startsWith("form:")
				? "form"
				: ((["referral", "import", "api", "dashboard", "mcp", "event"] as const).find(
						(k) => k === raw,
					) ?? "unknown");
			const label =
				kind === "form"
					? `Form: ${formName.get(raw.slice(5)) ?? "deleted form"}`
					: {
							referral: "Referrals",
							import: "Imports",
							api: "API",
							dashboard: "Added in the dashboard",
							mcp: "Added by Claude",
							event: "App events",
							unknown: "Before sources were kept",
							form: "",
						}[kind];
			const joined = Number(s.joined);
			const stayed = Number(s.stayed);
			return { source: raw || null, kind, label, joined, stayed };
		})
		.sort((a, b) => b.joined - a.joined);

	return {
		days,
		start: day(start),
		subscribed,
		total: Number(totals?.total ?? 0),
		joined,
		left,
		net: joined - left,
		/** Net change against the list when the period began (null when it started empty). */
		growth_rate: before ? (joined - left) / before : null,
		/** Those who left against the list when the period began plus those who joined. */
		churn_rate: before + joined ? left / (before + joined) : null,
		series: withTotal,
		sources: bySource,
		details: details.map((d) => ({ detail: d.detail as string, joined: Number(d.joined) })),
	};
}

export type Growth = Awaited<ReturnType<typeof growth>>;
