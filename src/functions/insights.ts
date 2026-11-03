import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIds, viewScope } from "@/server/brands";
import { mailroomAddress } from "@/server/inbound";
import { insightDetail, KINDS, parseSubject, subjectTitle } from "@/server/insight-detail";
import { statsByStream, statsByTag, statsByTemplate, timeToInbox } from "@/server/insights";
import { orgMiddleware } from "@/server/middleware";
import { connection, postmasterView } from "@/server/postmaster";

export const getInsights = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			days: z.number().int().min(1).max(90).default(30),
			brand: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const now = Date.now();
		const own = typeof scope === "string" ? scope : context.organizationId;
		const ids = typeof scope === "string" ? [scope] : await brandIds(context.organizationId);
		const [byTemplate, byTag, byStream, latency, testAddress, gmail, google] =
			await Promise.all([
				statsByTemplate(scope, data.days, now),
				statsByTag(scope, data.days, now),
				statsByStream(scope, data.days, now),
				timeToInbox(scope, data.days, now),
				mailroomAddress(own),
				postmasterView(ids, data.days, now),
				connection(),
			]);
		return {
			byTemplate,
			byTag,
			byStream,
			latency,
			/** Where to send an email to get its deliverability report (the brand's Mailroom address). */
			testAddress,
			/** Gmail Postmaster Tools, per sending domain; null until an admin connects Google. */
			gmail: google.connected ? gmail : null,
			brands,
			brand: typeof scope === "string" && brands.length ? scope : null,
		};
	});

/** One template, tag or mailbox provider of Insights up close. */
export const getInsightDetail = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			kind: z.enum(KINDS),
			key: z.string().min(1).max(300),
			days: z.number().int().min(1).max(90).default(30),
			brand: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const subject = parseSubject(data.kind, data.key);
		if (!subject) throw new Response("Nothing to show for this", { status: 404 });
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const [detail, title] = await Promise.all([
			insightDetail(scope, subject, data.days),
			subjectTitle(scope, subject),
		]);
		return {
			...detail,
			...title,
			kind: data.kind,
			key: data.key,
			brands,
			brand: typeof scope === "string" && brands.length ? scope : null,
		};
	});
