import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { brandIn, viewScope } from "@/server/brands";
import {
	assignees,
	deleteRule,
	deleteSavedReply,
	listRules,
	listSavedReplies,
	orderRules,
	RULE_ACTIONS,
	RULE_FIELDS,
	RULE_OPS,
	ruleView,
	savedReplyFor,
	savedReplyView,
	saveRule,
	saveSavedReply,
	settingsOf,
	updateSettings,
	VARIABLES,
} from "@/server/inbox-workflow";
import { inboxFor, inboxView, listInboxes, logInbox, personOf } from "@/server/inboxes";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

/** An inbox's workflow (assignment, SLA, CSAT, rules…), saved replies and the inbox report. */

// ── An inbox's workflow ────────────────────────────────────────────────────

export const getWorkflowFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inbox = await inboxFor(actor, data.id).catch(() => {
				throw new Response("Inbox not found", { status: 404 });
			});
			const { listSegments } = await import("@/server/contacts");
			const { listSurveys } = await import("@/server/surveys");
			const [rules, people, saved, brands, segments, surveys] = await Promise.all([
				listRules(inbox.id),
				assignees(context.organizationId, inbox),
				listSavedReplies(actor, { inbox: inbox.id }),
				viewScope(context.organizationId).then((v) => v.brands),
				listSegments(inbox.organization_id),
				listSurveys([inbox.organization_id]),
			]);
			const { timezone } = await import("@/server/env");
			return {
				inbox: inboxView(inbox),
				settings: settingsOf(inbox),
				rules: rules.map(ruleView),
				people: people.map(({ email: _e, ...p }) => p),
				saved: saved.map(savedReplyView),
				segments: segments.map((s) => ({ id: s.id, name: s.name, live: !!s.rules })),
				surveys: surveys.map((s) => ({
					id: s.id,
					name: s.name,
					kind: s.kind,
					question: s.question,
					enabled: s.enabled,
				})),
				brand: brands.find((b) => b.id === inbox.organization_id) ?? null,
				timezone: timezone(),
				catalog: {
					fields: [...RULE_FIELDS],
					ops: [...RULE_OPS],
					actions: [...RULE_ACTIONS],
				},
			};
		}),
	);

export const saveWorkflowFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ id: z.string(), settings: z.record(z.string(), z.unknown()) }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inbox = await inboxFor(actor, data.id);
			const next = await updateSettings(inbox, data.settings);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.workflow_updated",
				detail: { changed: Object.keys(data.settings) },
			});
			return next;
		}),
	);

export const saveRuleFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(
		z.object({
			inbox: z.string(),
			id: z.string().optional(),
			rule: z.object({}).passthrough(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inbox = await inboxFor(actor, data.inbox);
			const row = await saveRule(inbox, data.rule, { id: data.id });
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: data.id ? "rule.updated" : "rule.created",
				detail: { rule: row.name },
			});
			return ruleView(row);
		}),
	);

export const deleteRuleFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string(), id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inbox = await inboxFor(actor, data.inbox);
			await deleteRule(inbox, data.id);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "rule.deleted",
			});
			return { ok: true };
		}),
	);

export const orderRulesFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string(), ids: z.array(z.string()).max(200) }))
	.handler(({ data, context }) =>
		call(async () => {
			const inbox = await inboxFor(await personOf(context), data.inbox);
			await orderRules(inbox, data.ids);
			return { ok: true };
		}),
	);

// ── Saved replies ──────────────────────────────────────────────────────────

export const listSavedRepliesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) =>
		call(async () => {
			const actor = await personOf(context);
			const [saved, inboxes, { brands }] = await Promise.all([
				listSavedReplies(actor),
				listInboxes(actor),
				viewScope(context.organizationId),
			]);
			return {
				saved: saved.map(savedReplyView),
				inboxes: inboxes.map((i) => ({
					id: i.id,
					name: i.name,
					brand_id: i.organization_id,
				})),
				brands,
				own: context.organizationId,
				variables: VARIABLES.map((v) => ({ ...v })),
				/** Published help center articles, to link from a reply. */
				articles: await (async () => {
					const hc = await import("@/server/help-center");
					const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
					const rows = await hc.listArticles(ids, { status: "published" });
					const centers = new Map(
						await Promise.all(
							[...new Set(rows.map((r) => r.organization_id))].map(
								async (id) => [id, await hc.helpCenterOf(id)] as const,
							),
						),
					);
					return rows
						.map((a) => {
							const c = centers.get(a.organization_id) ?? null;
							return {
								id: a.id,
								title: a.title,
								brand_id: a.organization_id,
								url: c?.enabled ? hc.articleUrl(c, a) : null,
							};
						})
						.filter((a): a is typeof a & { url: string } => !!a.url);
				})(),
			};
		}),
	);

export const saveSavedReplyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			id: z.string().optional(),
			brand: z.string().nullish(),
			reply: z.object({}).passthrough(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inboxId = (data.reply as { inbox_id?: string | null }).inbox_id;
			const brand = data.id
				? (await savedReplyFor(actor, data.id)).organization_id
				: inboxId
					? (await inboxFor(actor, inboxId)).organization_id
					: data.brand
						? await brandIn(context.organizationId, data.brand)
						: context.organizationId;
			const row = await saveSavedReply(brand, data.reply, {
				id: data.id,
				userId: context.userId,
			});
			return savedReplyView(row);
		}),
	);

export const deleteSavedReplyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			await deleteSavedReply(actor.brands, data.id);
			return { ok: true };
		}),
	);

// ── The report ─────────────────────────────────────────────────────────────

export const inboxReportFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			from: z.string().nullish(),
			to: z.string().nullish(),
			inbox: z.string().nullish(),
			brand: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const { scope, brands } = await viewScope(context.organizationId, data.brand);
			const person = await personOf(context);
			const actor = typeof scope === "string" ? { ...person, brands: [scope] } : person;
			const { inboxReport } = await import("@/server/inbox-reports");
			const report = await inboxReport(actor, {
				from: data.from,
				to: data.to,
				inbox: data.inbox,
			});
			return { ...report, brands };
		}),
	);
