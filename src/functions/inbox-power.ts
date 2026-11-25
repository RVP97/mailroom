import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import {
	applyMacro,
	deleteInboxView,
	deleteMacro,
	listInboxViews,
	listMacros,
	saveInboxView,
	saveMacro,
} from "@/server/inbox-power";
import { PRIORITIES } from "@/server/inbox-workflow";
import { personOf } from "@/server/inboxes";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

export const listMacrosFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().optional(), inbox: z.string().optional() }).optional())
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			const scope = data?.brand ? [await brandIn(context.organizationId, data.brand)] : ids;
			return listMacros(scope, data?.inbox ?? null);
		}),
	);

export const saveMacroFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:rules")])
	.validator(
		z.object({
			brand: z.string().optional(),
			id: z.string().optional(),
			inbox_id: z.string().nullable().optional(),
			name: z.string().min(1).max(80),
			shortcut: z.string().max(32).nullable().optional(),
			reply_text: z.string().max(20_000).nullable().optional(),
			note_text: z.string().max(10_000).nullable().optional(),
			actions: z
				.object({
					add_tags: z.array(z.string()).optional(),
					remove_tags: z.array(z.string()).optional(),
					priority: z.enum(PRIORITIES).nullable().optional(),
					assignee: z.string().nullable().optional(),
					status: z.enum(["open", "resolved"]).nullable().optional(),
					snooze_hours: z.number().nullable().optional(),
				})
				.default({}),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			return saveMacro(brand, data, context.userId);
		}),
	);

export const deleteMacroFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:rules")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			return deleteMacro(ids, data.id);
		}),
	);

export const applyMacroFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ conversationId: z.string(), macroId: z.string() }))
	.handler(({ data, context }) =>
		call(async () => applyMacro(await personOf(context), data.conversationId, data.macroId)),
	);

export const listInboxViewsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) => call(() => listInboxViews(context.organizationId, context.userId)));

export const saveInboxViewFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			id: z.string().optional(),
			name: z.string().min(1).max(60),
			color: z.string().max(20).nullable().optional(),
			shared: z.boolean().optional(),
			filters: z.object({
				view: z.string().optional(),
				brand: z.string().optional(),
				inbox: z.string().optional(),
				tag: z.string().optional(),
				priority: z.string().optional(),
				assignee: z.string().optional(),
				unread: z.boolean().optional(),
				q: z.string().optional(),
			}),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveInboxView(context.organizationId, data, context.userId)),
	);

export const deleteInboxViewFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(() =>
			deleteInboxView(
				context.organizationId,
				data.id,
				context.userId,
				context.access.can("inbox:rules"),
			),
		),
	);
