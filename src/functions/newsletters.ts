import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import { broadcastView } from "@/server/broadcasts";
import {
	campaignBroadcasts,
	campaignCounts,
	campaignReport,
	campaignView,
	createCampaign,
	deleteCampaign,
	getCampaign,
	listCampaigns,
	updateCampaign,
} from "@/server/campaigns";
import { listSegments, listTopics, segmentView, topicView } from "@/server/contacts";
import { growth, growthInput } from "@/server/growth";
import { can, orgMiddleware } from "@/server/middleware";
import {
	checkFeed,
	createNewsletter,
	deleteNewsletter,
	getNewsletter,
	issueCounts,
	issuesOf,
	listNewsletters,
	newsletterView,
	previewArchive,
	updateNewsletter,
	webUrl,
} from "@/server/newsletters";
import { orgContext } from "@/server/org";
import { leaderboard, referralTotals } from "@/server/referrals";
import { brandLooks, listForms } from "@/server/signup-forms";
import { listTemplates, templateView } from "@/server/templates";
import { call } from "./call";

/** The Newsletters, Campaigns and Growth pages. */

async function scopeOf(organizationId: string, brand?: string | null) {
	const { brands } = await viewScope(organizationId);
	const ids = brands.length ? brands.map((b) => b.id) : [organizationId];
	const scope = brand ? [await call(() => brandIn(organizationId, brand))] : ids;
	return { brands, ids, scope };
}

const brandName = (brands: { id: string; name: string }[], id: string) =>
	brands.find((b) => b.id === id)?.name ?? null;

// ── Newsletters ──────────────────────────────────────────────────────────────

export const newslettersPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, scope } = await scopeOf(context.organizationId, data.brand);
		const rows = await listNewsletters(scope);
		const counts = await issueCounts(rows.map((r) => r.id));
		const ctxs = new Map(
			await Promise.all(
				[...new Set(rows.map((r) => r.organization_id))].map(
					async (id) => [id, await orgContext(id)] as const,
				),
			),
		);
		return {
			brands,
			newsletters: rows.map((n) => ({
				...newsletterView(n, ctxs.get(n.organization_id)),
				brand: brandName(brands, n.organization_id),
				issues: counts.get(n.id) ?? 0,
			})),
		};
	});

export const newsletterPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands, ids } = await scopeOf(context.organizationId);
			const n = await getNewsletter(ids, data.id);
			const brand = n.organization_id;
			const [segments, topics, forms, ctx, templates, issues, board, totals, looks] =
				await Promise.all([
					listSegments(brand),
					listTopics(brand),
					listForms([brand]),
					orgContext(brand),
					listTemplates(context.organizationId),
					issuesOf(n.id),
					leaderboard(brand),
					referralTotals(brand),
					brandLooks([brand]),
				]);
			return {
				newsletter: newsletterView(n, ctx),
				brand: brands.find((b) => b.id === brand) ?? null,
				segments: segments.map((s) => segmentView(s, s.contacts)),
				topics: topics.map(topicView),
				forms: forms.map((f) => ({ id: f.id, name: f.name, enabled: f.enabled })),
				domains: ctx.domains.filter((d) => d.verified).map((d) => d.name),
				templates: templates
					.map(templateView)
					.filter((t) => t.status === "published")
					.map((t) => ({ id: t.id, name: t.name })),
				issues: issues.map((x) => ({
					id: x.id,
					name: x.name,
					subject: x.subject,
					status: x.status,
					web: x.web,
					started_at: x.started_at,
					queued: x.queued,
					url: webUrl(x, n),
				})),
				leaderboard: board,
				referrals: totals,
				brand_logo: !!looks[brand],
			};
		}),
	);

const newsletterFields = z.object({
	name: z.string(),
	slug: z.string().optional(),
	description: z.string().nullable().optional(),
	segment_id: z.string().nullable().optional(),
	topic_id: z.string().nullable().optional(),
	from: z.string().nullable().optional(),
	form_id: z.string().nullable().optional(),
	public: z.boolean().optional(),
	accent: z.string().nullable().optional(),
	rss_url: z.string().nullable().optional(),
	rss_mode: z.enum(["draft", "send"]).optional(),
	rss_style: z.enum(["full", "compact", "titles"]).optional(),
	rss_intro: z.string().nullable().optional(),
	// Checked in full by the server's own schema.
	look: z.record(z.string(), z.unknown()).nullable().optional(),
	referrals: z.boolean().optional(),
	referral_rewards: z
		.array(
			z.object({
				count: z.number(),
				reward: z.string(),
				template_id: z.string().nullable().optional(),
			}),
		)
		.optional(),
});

export const saveNewsletterFn = createServerFn({ method: "POST" })
	.middleware([can("newsletters:edit")])
	.validator(
		z.object({
			brand: z.string().nullish(),
			id: z.string().optional(),
			fields: newsletterFields,
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			if (data.id) {
				const { ids } = await scopeOf(context.organizationId);
				const n = await getNewsletter(ids, data.id);
				const row = await updateNewsletter(n.organization_id, n.id, data.fields);
				return newsletterView(row);
			}
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return newsletterView(await createNewsletter(brand, data.fields));
		}),
	);

/** The public page as it would look with these (unsaved) settings, for the dashboard's preview. */
export const previewNewsletterFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string(), fields: newsletterFields.partial() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const n = await getNewsletter(ids, data.id);
			return { html: await previewArchive(n, data.fields) };
		}),
	);

export const deleteNewsletterFn = createServerFn({ method: "POST" })
	.middleware([can("newsletters:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const n = await getNewsletter(ids, data.id);
			await deleteNewsletter(n.organization_id, n.id);
			return { ok: true };
		}),
	);

/** Reads the feed now (a first read only notes what's there). */
export const checkFeedFn = createServerFn({ method: "POST" })
	.middleware([can("newsletters:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const n = await getNewsletter(ids, data.id);
			const made = await checkFeed(n);
			const after = await getNewsletter(ids, data.id);
			return {
				broadcast_id: made,
				error: after.rss_error,
				seen: after.rss_seen?.length ?? 0,
			};
		}),
	);

// ── Growth ───────────────────────────────────────────────────────────────────

export const growthPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish(), ...growthInput.shape }))
	.handler(async ({ data, context }) => {
		const { brands } = await viewScope(context.organizationId);
		const brand = data.brand
			? await call(() => brandIn(context.organizationId, data.brand as string))
			: context.organizationId;
		const [g, totals] = await Promise.all([
			growth(brand, { days: data.days }),
			referralTotals(brand),
		]);
		return { brand, brands, growth: g, referrals: totals };
	});

// ── Campaigns ────────────────────────────────────────────────────────────────

export const campaignsPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, scope } = await scopeOf(context.organizationId, data.brand);
		const rows = await listCampaigns(scope);
		const counts = await campaignCounts(rows.map((r) => r.id));
		return {
			brands,
			campaigns: rows.map((x) => ({
				...campaignView(x),
				brand: brandName(brands, x.organization_id),
				broadcasts: counts.get(x.id)?.total ?? 0,
				sent: counts.get(x.id)?.sent ?? 0,
			})),
		};
	});

export const campaignPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands, ids } = await scopeOf(context.organizationId);
			const x = await getCampaign(ids, data.id);
			const [list, report, segments] = await Promise.all([
				campaignBroadcasts(x.id),
				campaignReport(x.id),
				listSegments(x.organization_id),
			]);
			const segmentName = new Map(segments.map((s) => [s.id, s.name]));
			return {
				campaign: campaignView(x),
				brand: brands.find((b) => b.id === x.organization_id) ?? null,
				broadcasts: list.map((b) => ({
					...broadcastView(b),
					segment: b.segment_id ? (segmentName.get(b.segment_id) ?? null) : null,
					stats: report.by_broadcast[b.id] ?? null,
				})),
				totals: report.totals,
			};
		}),
	);

const campaignFields = z.object({
	name: z.string(),
	description: z.string().nullable().optional(),
	utm_campaign: z.string().nullable().optional(),
	starts_on: z.string().nullable().optional(),
	ends_on: z.string().nullable().optional(),
});

export const saveCampaignFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(
		z.object({
			brand: z.string().nullish(),
			id: z.string().optional(),
			fields: campaignFields,
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			if (data.id) {
				const { ids } = await scopeOf(context.organizationId);
				const x = await getCampaign(ids, data.id);
				return campaignView(await updateCampaign(x.organization_id, x.id, data.fields));
			}
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return campaignView(await createCampaign(brand, data.fields));
		}),
	);

export const deleteCampaignFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await scopeOf(context.organizationId);
			const x = await getCampaign(ids, data.id);
			await deleteCampaign(x.organization_id, x.id);
			return { ok: true };
		}),
	);
