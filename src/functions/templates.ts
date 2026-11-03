import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { kickDispatcher, rateGate } from "@/server/dispatcher";
import { can, orgMiddleware } from "@/server/middleware";
import { brandForSend, createEmails, parseSend } from "@/server/send";
import {
	applyTemplate,
	createTemplate,
	deleteTemplate,
	duplicateTemplate,
	getTemplate,
	listTemplates,
	publishTemplate,
	templateView,
	updateTemplate,
} from "@/server/templates";
import { logActivity } from "@/server/activity";
import { recordVersion, snapshotOf } from "@/server/versions";
import { call } from "./call";

/** The Templates pages. */

export const listTemplatesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const rows = await listTemplates(context.organizationId);
		return rows.map((t) => {
			const v = templateView(t);
			return {
				id: v.id,
				name: v.name,
				alias: v.alias,
				status: v.status,
				has_unpublished_changes: v.has_unpublished_changes,
				subject: v.subject,
				variables: v.variables.length,
				updated_at: v.updated_at,
			};
		});
	});

export const getTemplateFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => templateView(await getTemplate(context.organizationId, data.id))),
	);

const fields = z.object({
	name: z.string(),
	alias: z.string().nullable(),
	from: z.string().nullable(),
	subject: z.string().nullable(),
	reply_to: z.string().nullable(),
	html: z.string(),
	text: z.string().nullable(),
	design: z.unknown().nullable().optional(),
	variables: z.array(
		z.object({
			key: z.string(),
			type: z.enum(["string", "number"]),
			fallback_value: z.union([z.string(), z.number()]).nullable().optional(),
		}),
	),
});

/** The dashboard's form: empty fields are no value. */
const fromForm = (f: z.infer<typeof fields>) => ({
	name: f.name,
	alias: f.alias?.trim() || null,
	from: f.from?.trim() || null,
	subject: f.subject || null,
	reply_to: f.reply_to?.trim()
		? f.reply_to
				.split(/[,;\s]+/)
				.map((a) => a.trim())
				.filter(Boolean)
		: null,
	html: f.html,
	text: f.text?.trim() ? f.text : null,
	...(f.design !== undefined ? { design: f.design } : {}),
	variables: f.variables.map((v) => ({
		key: v.key.trim(),
		type: v.type,
		fallback_value:
			v.fallback_value === "" || v.fallback_value === undefined ? null : v.fallback_value,
	})),
});

export const createTemplateFn = createServerFn({ method: "POST" })
	.middleware([can("templates:edit")])
	.validator(z.object({ name: z.string().optional() }).default({}))
	.handler(({ data, context }) =>
		call(async () => {
			const t = await createTemplate(context.organizationId, {
				name: data.name?.trim() || "Untitled template",
				subject: "",
				// Empty: the page offers designs to start from.
				html: "",
				variables: [{ key: "PRODUCT", type: "string", fallback_value: "Mailroom" }],
			});
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "template.created",
				subject: { type: "template", id: t.id, name: t.name },
			});
			return { id: t.id };
		}),
	);

export const saveTemplateFn = createServerFn({ method: "POST" })
	.middleware([can("templates:edit")])
	.validator(z.object({ id: z.string(), fields, publish: z.boolean().optional() }))
	.handler(({ data, context }) =>
		call(async () => {
			let t = await updateTemplate(context.organizationId, data.id, fromForm(data.fields));
			await recordVersion({
				organizationId: context.organizationId,
				type: "template",
				id: t.id,
				userId: context.userId,
				snapshot: snapshotOf({ ...t.draft, design: t.draft.design ?? null }),
			});
			if (data.publish) t = await publishTemplate(context.organizationId, t.id);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: data.publish ? "template.published" : "template.edited",
				subject: { type: "template", id: t.id, name: t.name },
			});
			return templateView(t);
		}),
	);

export const duplicateTemplateFn = createServerFn({ method: "POST" })
	.middleware([can("templates:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => ({ id: (await duplicateTemplate(context.organizationId, data.id)).id })),
	);

export const deleteTemplateFn = createServerFn({ method: "POST" })
	.middleware([can("templates:edit")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const t = await getTemplate(context.organizationId, data.id);
			await deleteTemplate(context.organizationId, data.id);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "template.deleted",
				subject: { type: "template", id: t.id, name: t.name },
			});
			return { ok: true };
		}),
	);

/** The published template, sent to someone (the person by default) with sample values. */
export const sendTemplateTestFn = createServerFn({ method: "POST" })
	.middleware([can("templates:edit")])
	.validator(
		z.object({
			id: z.string(),
			to: z.string(),
			from: z.string().optional(),
			variables: z.record(z.string(), z.union([z.string(), z.number()])),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const input = parseSend(
				await applyTemplate(context.organizationId, {
					to: data.to
						.split(/[,;\s]+/)
						.map((a) => a.trim())
						.filter(Boolean),
					...(data.from?.trim() ? { from: data.from.trim() } : {}),
					template: { id: data.id, variables: data.variables },
				}),
			);
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
