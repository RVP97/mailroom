import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { maskDigits } from "@/lib/roles";
import { fill, htmlToText } from "@/lib/template-fill";
import { logActivity } from "@/server/activity";
import { brandIn, viewScope } from "@/server/brands";
import { broadcastReport } from "@/server/broadcast-report";
import {
	audienceSize,
	broadcastStats,
	broadcastView,
	cancelBroadcast,
	createBroadcast,
	deleteBroadcast,
	duplicateBroadcast,
	getBroadcast,
	listBroadcasts,
	resendBroadcast,
	runBroadcasts,
	sendBroadcast,
	updateBroadcast,
	variantStats,
} from "@/server/broadcasts";
import { campaignView, listCampaigns } from "@/server/campaigns";
import {
	listProperties,
	listSegments,
	listTopics,
	segmentView,
	topicView,
} from "@/server/contacts";
import { kickDispatcher, rateGate } from "@/server/dispatcher";
import { baseUrl } from "@/server/env";
import { getKit } from "@/server/library";
import { can, orgMiddleware } from "@/server/middleware";
import { listNewsletters, newsletterView, webUrl } from "@/server/newsletters";
import { orgContext } from "@/server/org";
import { peopleNames } from "@/server/people";
import { pollResults, votersToSegment } from "@/server/polls";
import { approvalRequired, contentHash } from "@/server/reviews";
import { brandForSend, createEmails, parseSend } from "@/server/send";
import { brandLooks, logoBackgrounds } from "@/server/signup-forms";
import { listTemplates, templateView } from "@/server/templates";
import { recordVersion, snapshotOf } from "@/server/versions";
import { call } from "./call";

/** The Broadcasts pages. */

/** Every brand the organization has (or only its own). */
async function brandsOf(organizationId: string) {
	const { brands } = await viewScope(organizationId);
	return { brands, ids: brands.length ? brands.map((b) => b.id) : [organizationId] };
}

export const listBroadcastsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { brands, ids } = await brandsOf(context.organizationId);
		const scope = data.brand
			? [await call(() => brandIn(context.organizationId, data.brand as string))]
			: ids;
		const [rows, segments] = await Promise.all([
			listBroadcasts(scope, { limit: 200 }),
			Promise.all(scope.map((b) => listSegments(b))),
		]);
		const segmentName = new Map(segments.flat().map((s) => [s.id, s.name]));
		const brandName = new Map(brands.map((b) => [b.id, b.name]));
		return {
			brands,
			broadcasts: rows.map((x) => ({
				id: x.id,
				name: x.name,
				subject: x.subject,
				status: x.status,
				brand: brandName.get(x.organization_id) ?? null,
				segment: x.segment_id ? (segmentName.get(x.segment_id) ?? null) : null,
				queued: x.queued,
				scheduled_at: x.scheduled_at,
				started_at: x.started_at,
				created_at: x.created_at,
			})),
		};
	});

export const getBroadcastFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands, ids } = await brandsOf(context.organizationId);
			const x = await getBroadcast(ids, data.id);
			const brand = x.organization_id;
			const [stats, segments, topics, templates, ctx, audience, logos, properties] =
				await Promise.all([
					broadcastStats(x.id),
					listSegments(brand),
					listTopics(brand),
					listTemplates(context.organizationId),
					orgContext(brand),
					x.status === "draft" || x.status === "scheduled" ? audienceSize(x) : null,
					brandLooks([brand]),
					listProperties(brand),
				]);
			const sent = x.status === "sent";
			const went = !["draft", "scheduled"].includes(x.status);
			const [variants, nonOpeners, report, newsletters, campaigns, polls] = await Promise.all(
				[
					x.ab_test ? variantStats(x.id) : [],
					sent ? audienceSize({ ...x, resend_of: x.id }) : null,
					went ? broadcastReport(x.id, x.started_at) : null,
					listNewsletters([brand]),
					listCampaigns([brand]),
					went ? pollResults(x.id, x.design) : [],
				],
			);
			const newsletter = newsletters.find((n) => n.id === x.newsletter_id) ?? null;
			const [needsApproval, kit, people, logoBg] = await Promise.all([
				approvalRequired(context.organizationId),
				getKit(brand),
				peopleNames([x.review_requested_by, x.reviewed_by, x.created_by, x.updated_by]),
				logoBackgrounds([brand]),
			]);
			return {
				broadcast: broadcastView(x),
				/** Every broadcast here needs approval before it goes. */
				needs_approval: needsApproval,
				/** Whether its approval still holds for what it says now. */
				approved: x.review === "approved" && x.review_hash === (await contentHash(x)),
				people,
				created_by: x.created_by,
				updated_by: x.updated_by,
				kit,
				brand: brands.find((b) => b.id === brand) ?? null,
				/** For the email editor's logo block. */
				look: {
					logo: emailLogo(logos[brand] ?? null),
					logoBackground: logoBg[brand] ?? null,
					name: brands.find((b) => b.id === brand)?.name ?? "",
				},
				/** Contact property keys (variables in the email). */
				properties: properties.map((p) => p.key),
				stats,
				variants,
				newsletters: newsletters.map((n) => newsletterView(n)),
				campaigns: campaigns.map(campaignView),
				polls,
				/** The replies it got: support's to answer (they're in the inbox too). */
				replies: went
					? await import("@/server/conversations").then(async (m) => {
							const r = await m.broadcastReplies(x.id);
							return {
								count: r.count,
								latest: r.latest.map((l) => ({
									...l,
									from: context.masked ? maskDigits(l.from) : l.from,
								})),
							};
						})
					: { count: 0, latest: [] },
				/** Its web version (an issue's archive page once sent). */
				web_url: went ? webUrl(x, newsletter) : null,
				/** For a sent one: how many didn't open it (a resend's audience). */
				nonOpeners,
				report,
				audience,
				/** About how many of the segment quiet mode and the frequency cap leave out now. */
				held_out:
					audience !== null && x.segment_id
						? await import("@/server/marketing-rules").then(async (m) =>
								m.heldOutCount(
									brand,
									x.segment_id as string,
									await m.marketingRules(brand),
								),
							)
						: 0,
				segments: segments.map((s) => segmentView(s, s.contacts)),
				topics: topics.map(topicView),
				templates: templates
					.map(templateView)
					.filter((t) => t.status === "published")
					.map((t) => ({ id: t.id, name: t.name, alias: t.alias })),
				domains: ctx.domains
					.filter((d) => d.verified)
					.map((d) => ({ name: d.name, purpose: d.purpose })),
			};
		}),
	);

/** A logo inboxes can show (not an SVG, which most don't). */
export const emailLogo = (url: string | null) => (url && !/\.svg(\?|$)/i.test(url) ? url : null);

export const createBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(
		z.object({
			brand: z.string().nullish(),
			newsletter: z.string().nullish(),
			campaign: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			const segments = await listSegments(brand);
			const n = data.newsletter
				? (await listNewsletters([brand])).find((x) => x.id === data.newsletter)
				: null;
			const x = await createBroadcast(
				context.organizationId,
				brand,
				{
					name: n ? `${n.name} issue` : "Untitled broadcast",
					html: "",
					segment_id: n?.segment_id ?? (segments.length === 1 ? segments[0]?.id : null),
					...(n
						? { newsletter_id: n.id, topic_id: n.topic_id, from: n.from || null }
						: {}),
					...(data.campaign ? { campaign_id: data.campaign } : {}),
				},
				Date.now(),
				context.userId,
			);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.created",
				subject: { type: "broadcast", id: x.id, name: x.name },
			});
			return { id: x.id };
		}),
	);

const fields = z.object({
	name: z.string(),
	segment_id: z.string().nullable(),
	topic_id: z.string().nullable(),
	from: z.string(),
	subject: z.string(),
	reply_to: z.string(),
	preview_text: z.string(),
	html: z.string(),
	text: z.string().nullable(),
	design: z.unknown().nullable().optional(),
	newsletter_id: z.string().nullable().optional(),
	web: z.boolean().optional(),
	campaign_id: z.string().nullable().optional(),
	campaign_dedupe: z.boolean().optional(),
});

const fromForm = (f: z.infer<typeof fields>) => ({
	name: f.name.trim() || "Untitled broadcast",
	segment_id: f.segment_id || null,
	topic_id: f.topic_id || null,
	from: f.from.trim(),
	subject: f.subject,
	reply_to: f.reply_to.trim()
		? f.reply_to
				.split(/[,;\s]+/)
				.map((a) => a.trim())
				.filter(Boolean)
		: null,
	preview_text: f.preview_text.trim() || null,
	html: f.html,
	text: f.text?.trim() ? f.text : null,
	...(f.design !== undefined ? { design: f.design } : {}),
	...(f.newsletter_id !== undefined ? { newsletter_id: f.newsletter_id || null } : {}),
	...(f.web !== undefined ? { web: f.web } : {}),
	...(f.campaign_id !== undefined ? { campaign_id: f.campaign_id || null } : {}),
	...(f.campaign_dedupe !== undefined ? { campaign_dedupe: f.campaign_dedupe } : {}),
});

async function ownBroadcast(organizationId: string, id: string) {
	const { ids } = await brandsOf(organizationId);
	return getBroadcast(ids, id);
}

export const saveBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string(), fields }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const row = await updateBroadcast(
				context.organizationId,
				x.organization_id,
				x.id,
				fromForm(data.fields),
				Date.now(),
				context.userId,
			);
			await recordVersion({
				organizationId: context.organizationId,
				type: "broadcast",
				id: row.id,
				userId: context.userId,
				snapshot: snapshotOf(row),
			});
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.edited",
				subject: { type: "broadcast", id: row.id, name: row.name || row.subject },
			});
			return broadcastView(row);
		}),
	);

/** A published template's content into the draft (its own variables filled with their fallbacks). */
export const applyTemplateFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string(), template: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			await updateBroadcast(context.organizationId, x.organization_id, x.id, {
				template: { id: data.template },
			});
			return { ok: true };
		}),
	);

export const sendBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:send")])
	.validator(
		z.object({
			id: z.string(),
			at: z.string().nullish(),
			ab_test: z
				.object({
					subjects: z.array(z.string()),
					metric: z.enum(["opens", "clicks"]),
					size: z.number(),
					wait_minutes: z.number(),
				})
				.nullish(),
			local_time: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const row = await sendBroadcast(x.organization_id, x.id, data.at, Date.now(), {
				ab_test: data.ab_test,
				local_time: data.local_time,
			});
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: row.status === "scheduled" ? "broadcast.scheduled" : "broadcast.sent",
				subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
				detail: row.scheduled_at ? { at: row.scheduled_at } : undefined,
			});
			// Now: the first contacts are queued before the page comes back.
			if (!data.at && !data.local_time) await runBroadcasts(Date.now(), row.id);
			return { status: row.status };
		}),
	);

/** A new draft for those who didn't open a sent broadcast. */
export const resendBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:send")])
	.validator(z.object({ id: z.string(), subject: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const row = await resendBroadcast(x.organization_id, x.id, { subject: data.subject });
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.created",
				subject: { type: "broadcast", id: row.id, name: row.name },
				detail: { resend_of: x.id },
			});
			return { id: row.id };
		}),
	);

export const cancelBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:send")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const row = await cancelBroadcast(x.organization_id, x.id);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.canceled",
				subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
			});
			return { status: row.status };
		}),
	);

export const deleteBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			await deleteBroadcast(x.organization_id, x.id);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.deleted",
				subject: { type: "broadcast", id: x.id, name: x.name || x.subject },
			});
			return { ok: true };
		}),
	);

export const duplicateBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { ids } = await brandsOf(context.organizationId);
			const x = await duplicateBroadcast(ids, data.id, Date.now(), context.userId);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.created",
				subject: { type: "broadcast", id: x.id, name: x.name },
			});
			return { id: x.id };
		}),
	);

/** The saved broadcast to a test address, with sample contact values. */
export const sendBroadcastTestFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string(), to: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const to = data.to
				.split(/[,;\s]+/)
				.map((a) => a.trim())
				.filter(Boolean);
			const values = {
				FIRST_NAME: "",
				LAST_NAME: "",
				EMAIL: to[0] ?? "",
				WEB_VERSION_URL: `${baseUrl()}/view/${x.id}`,
				REFERRAL_URL: "#referral-link",
				REFERRAL_PAGE_URL: "#referral-page",
				REFERRAL_COUNT: 0,
				POLL_URL: `${baseUrl()}/poll/web/${x.id}`,
			};
			const html = x.html ? fill(x.html, values) : undefined;
			const input = parseSend({
				brand: x.organization_id,
				from: x.from,
				to,
				subject: `[Test] ${fill(x.subject, values)}`,
				reply_to: x.reply_to ?? undefined,
				html,
				text: x.text ? fill(x.text, values) : html ? htmlToText(html) : undefined,
			});
			const brand = await brandForSend(context.organizationId, [input]);
			const [r] = await createEmails(brand, [input], {
				source: "dashboard",
				kick: kickDispatcher,
				gate: rateGate,
			});
			if (r?.error) throw r.error;
			return { id: r?.id ?? null };
		}),
	);

/** The pre-send checklist's link check: each web link in the saved draft, opened. */
export const checkLinksFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			const { checkLinks } = await import("@/server/link-check");
			return checkLinks(x.html);
		}),
	);

/** Those who answered a poll (one answer, or any) into a segment. */
export const pollToSegmentFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(
		z.object({
			id: z.string(),
			poll: z.string(),
			answer: z.number().int().nullable(),
			segment_id: z.string(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const x = await ownBroadcast(context.organizationId, data.id);
			return votersToSegment(
				x.organization_id,
				x.id,
				data.poll,
				data.answer,
				data.segment_id,
			);
		}),
	);
