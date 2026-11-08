import { createServerFn } from "@tanstack/react-start";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import { db, schema } from "@/server/db";
import { can, orgMiddleware } from "@/server/middleware";
import {
	createSurvey,
	deleteSurvey,
	getSurvey,
	listResponses,
	listSurveys,
	surveyResults,
	surveyView,
	updateSurvey,
} from "@/server/surveys";
import { iso } from "@/server/time";
import { call } from "./call";

/** The Surveys pages: a brand's surveys, one's results and answers, and the other answers
 * Mailroom collects (support ratings, email polls). */

async function scopeOf(organizationId: string, brand?: string | null) {
	const { brands } = await viewScope(organizationId);
	const ids = brands.length ? brands.map((b) => b.id) : [organizationId];
	const one = brand ? await call(() => brandIn(organizationId, brand)) : null;
	return { brands, ids, scope: one ? [one] : ids, one };
}

/** Support ratings and email polls of the last 90 days, beside the surveys. */
async function otherAnswers(scope: string[], now = Date.now()) {
	const c = schema.conversations;
	const since = iso(now - 90 * 86_400_000);
	const [ratings, polls] = await Promise.all([
		db
			.select({
				n: sql<number>`COUNT(*)`,
				avg: sql<number | null>`AVG(${c.csat_rating})`,
				happy: sql<number>`SUM(CASE WHEN ${c.csat_rating} >= 4 THEN 1 ELSE 0 END)`,
			})
			.from(c)
			.where(
				and(
					inArray(c.organization_id, scope),
					isNotNull(c.csat_rating),
					gte(c.csat_at, since),
				),
			)
			.get(),
		db
			.select({
				broadcasts: sql<number>`COUNT(DISTINCT ${schema.pollVotes.broadcast_id})`,
				answers: sql<number>`COUNT(*)`,
			})
			.from(schema.pollVotes)
			.innerJoin(schema.broadcasts, eq(schema.broadcasts.id, schema.pollVotes.broadcast_id))
			.where(
				and(
					inArray(schema.broadcasts.organization_id, scope),
					gte(schema.pollVotes.created_at, since),
				),
			)
			.get(),
	]);
	const n = Number(ratings?.n ?? 0);
	return {
		ratings: {
			count: n,
			average: n ? Math.round(Number(ratings?.avg ?? 0) * 10) / 10 : null,
			satisfied_pct: n ? Math.round((Number(ratings?.happy ?? 0) / n) * 100) : null,
		},
		polls: { broadcasts: Number(polls?.broadcasts ?? 0), answers: Number(polls?.answers ?? 0) },
	};
}

export const surveysPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, scope } = await scopeOf(context.organizationId, data.brand);
		const rows = await listSurveys(scope);
		const results = await Promise.all(
			rows.map(async (s) => {
				const full = await getSurvey(scope, s.id);
				return [s.id, await surveyResults(full, { days: 90 })] as const;
			}),
		);
		const byId = new Map(results);
		return {
			brands,
			surveys: rows.map((s) => ({
				...s,
				brand: brands.find((b) => b.id === s.brand_id)?.name ?? null,
				results: byId.get(s.id) ?? null,
			})),
			other: await otherAnswers(scope),
		};
	});

/** The surveys the editor's survey block and the chat can ask (every brand's, with its name). */
export const surveyChoicesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const { brands, ids } = await scopeOf(context.organizationId);
		return (await listSurveys(ids)).map((s) => ({
			id: s.id,
			name: s.name,
			kind: s.kind,
			question: s.question,
			options: s.options,
			low_label: s.low_label,
			high_label: s.high_label,
			enabled: s.enabled,
			brand_id: s.brand_id,
			brand:
				brands.length > 1 ? (brands.find((b) => b.id === s.brand_id)?.name ?? null) : null,
		}));
	});

export const surveyPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string(), days: z.number().int().min(1).max(3650).nullish() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids, brands } = await scopeOf(context.organizationId);
			const s = await getSurvey(ids, data.id);
			const days = data.days ?? undefined;
			const [results, responses] = await Promise.all([
				surveyResults(s, { days }),
				listResponses(s, { limit: 100, days }),
			]);
			return {
				survey: surveyView(s),
				brand: brands.find((b) => b.id === s.organization_id) ?? null,
				results,
				responses,
			};
		}),
	);

const surveyFields = z.object({
	name: z.string().optional(),
	kind: z.enum(["nps", "csat", "choice"]).optional(),
	question: z.string().optional(),
	options: z.array(z.string()).optional(),
	low_label: z.string().nullable().optional(),
	high_label: z.string().nullable().optional(),
	comment_prompt: z.string().nullable().optional(),
	thanks: z.string().optional(),
	enabled: z.boolean().optional(),
});

export const saveSurveyFn = createServerFn({ method: "POST" })
	.middleware([can("surveys:edit")])
	.validator(
		z.object({ brand: z.string().nullish(), id: z.string().optional(), fields: surveyFields }),
	)
	.handler(({ data, context }) =>
		call(async () => {
			if (data.id) {
				const { ids } = await scopeOf(context.organizationId);
				const s = await getSurvey(ids, data.id);
				return surveyView(await updateSurvey(s.organization_id, s.id, data.fields));
			}
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return surveyView(await createSurvey(brand, data.fields, context.userId));
		}),
	);

export const deleteSurveyFn = createServerFn({ method: "POST" })
	.middleware([can("surveys:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const x = await getSurvey(ids, data.id);
			const s = await deleteSurvey(x.organization_id, x.id);
			return { ok: true, id: s.id, name: s.name };
		}),
	);
