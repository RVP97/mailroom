import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { logActivity } from "@/server/activity";
import { brandIds, brandIn, viewScope } from "@/server/brands";
import { getBroadcast, updateBroadcast } from "@/server/broadcasts";
import { contentCalendar } from "@/server/calendar";
import { listCampaigns } from "@/server/campaigns";
import { can, orgMiddleware } from "@/server/middleware";
import { listNewsletters } from "@/server/newsletters";
import { call } from "./call";

/** The content calendar page. */
export const calendarFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ from: z.string(), to: z.string(), brand: z.string().nullish() }))
	.handler(({ data, context }) =>
		call(async () => {
			const [ids, { brands }] = await Promise.all([
				brandIds(context.organizationId),
				viewScope(context.organizationId),
			]);
			const scope = data.brand ? [await brandIn(context.organizationId, data.brand)] : ids;
			const [cal, newsletters, campaigns] = await Promise.all([
				contentCalendar({
					brands: scope,
					names: new Map(brands.map((b) => [b.id, b.name])),
					from: data.from,
					to: data.to,
				}),
				listNewsletters(scope),
				listCampaigns(scope),
			]);
			return {
				...cal,
				brands: brands.map((b) => ({ id: b.id, name: b.name })),
				newsletters: newsletters.map((n) => ({
					id: n.id,
					name: n.name,
					brand: n.organization_id,
				})),
				campaign_choices: campaigns.map((c) => ({
					id: c.id,
					name: c.name,
					brand: c.organization_id,
				})),
				canEdit: context.access.can("broadcasts:edit"),
			};
		}),
	);

/** Moves a draft to another day on the calendar (null takes it off). */
export const planBroadcastFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:edit")])
	.validator(z.object({ id: z.string(), planned_on: z.string().nullable() }))
	.handler(({ data, context }) =>
		call(async () => {
			const x = await getBroadcast(await brandIds(context.organizationId), data.id);
			const row = await updateBroadcast(
				context.organizationId,
				x.organization_id,
				x.id,
				{ planned_on: data.planned_on },
				Date.now(),
				context.userId,
			);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "broadcast.planned",
				subject: { type: "broadcast", id: row.id, name: row.name || row.subject },
			});
			return { id: row.id, planned_on: row.planned_on };
		}),
	);
