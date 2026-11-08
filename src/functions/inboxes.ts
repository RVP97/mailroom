import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { maskDigits } from "@/lib/roles";
import { brandIn, viewScope } from "@/server/brands";
import {
	addressOf,
	claimConversation,
	composeDefaults,
	conversationFor,
	deleteDraft,
	getConversation,
	listConversations,
	markMessage,
	saveDraft,
	sendReply,
	unsendReply,
	updateConversation,
} from "@/server/conversations";
import { db, schema } from "@/server/db";
import { inboundAddresses } from "@/server/inbound";
import { sender } from "@/server/inbox-api";
import {
	addNote,
	assignees,
	deleteNote,
	listSavedReplies,
	PRIORITIES,
	savedReplyView,
	settingsOf,
	VARIABLES,
} from "@/server/inbox-workflow";
import {
	activityView,
	createCredential,
	createInbox,
	credentialView,
	deleteInbox,
	getCredential,
	inboxActivity,
	inboxFor,
	inboxView,
	listCredentials,
	listInboxes,
	logInbox,
	personOf,
	revokeCredential,
	rotateCredential,
	updateCredential,
	updateInbox,
} from "@/server/inboxes";
import { can, orgMiddleware } from "@/server/middleware";
import { createWebhook } from "@/server/webhook-admin";
import { INBOX_EVENTS } from "@/server/webhooks";
import { call } from "./call";

/** Conversations (the Received pages) and agent inboxes (their own pages), for people. */

type Ctx = Parameters<typeof personOf>[0];

const lite = (i: typeof schema.inboxes.$inferSelect) => ({
	id: i.id,
	name: i.name,
	address: i.address,
	brand_id: i.organization_id,
});

// ── Conversations ──────────────────────────────────────────────────────────

export const listConversationsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			brand: z.string().nullish(),
			inbox: z.string().nullish(),
			status: z.enum(["open", "snoozed", "resolved", "all"]).nullish(),
			unread: z.boolean().nullish(),
			assignee: z.string().max(80).nullish(),
			tag: z.string().max(40).nullish(),
			priority: z.enum(PRIORITIES).nullish(),
			sla: z.enum(["due", "breached"]).nullish(),
			held: z.boolean().nullish(),
			search: z.string().max(200).nullish(),
			after: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const { scope, brands } = await viewScope(context.organizationId, data.brand);
			const person = await personOf(context);
			const actor = typeof scope === "string" ? { ...person, brands: [scope] } : person;
			const own = typeof scope === "string" ? scope : context.organizationId;
			const [page, inboxes, addresses, views, people] = await Promise.all([
				listConversations(actor, {
					inbox: data.inbox,
					status: data.status ?? "open",
					unread: data.unread,
					assignee: data.assignee,
					tag: data.tag,
					priority: data.priority,
					sla: data.sla,
					held: data.held,
					search: data.search,
					after: data.after,
					limit: 50,
				}),
				listInboxes(actor),
				inboundAddresses(own),
				queueCounts(actor, data.inbox),
				assignees(context.organizationId, null),
			]);
			// The tags to filter by: the inboxes' own, and those in use on this page.
			const tags = new Map<string, string>();
			for (const i of inboxes)
				for (const t of settingsOf(i).tags) tags.set(t.name.toLowerCase(), t.color);
			for (const r of page.data)
				for (const t of r.tags) if (!tags.has(t)) tags.set(t, "gray");
			return {
				...page,
				brands,
				inboxes: inboxes.map(lite),
				address: addresses.own ?? addresses.fallback,
				addresses,
				addressBrand: own,
				me: `user:${context.userId}`,
				views,
				tags: [...tags.entries()].map(([name, color]) => ({ name, color })),
				people: people.map(({ email: _e, ...p }) => p),
			};
		}),
	);

/** How many are in each of the Received page's views (open ones). */
async function queueCounts(actor: Awaited<ReturnType<typeof personOf>>, inbox?: string | null) {
	const c = schema.conversations;
	const at = new Date().toISOString();
	const inboxId =
		inbox && inbox !== "none" ? (await inboxFor(actor, inbox).catch(() => null))?.id : null;
	const row = await db
		.select({
			open: sql<number>`sum(CASE WHEN ${c.status} = 'open' AND (${c.snoozed_until} IS NULL OR ${c.snoozed_until} <= ${at}) THEN 1 ELSE 0 END)`,
			mine: sql<number>`sum(CASE WHEN ${c.status} = 'open' AND ${c.assignee} = ${actor.reader} AND (${c.claimed_until} IS NULL OR ${c.claimed_until} > ${at}) AND (${c.snoozed_until} IS NULL OR ${c.snoozed_until} <= ${at}) THEN 1 ELSE 0 END)`,
			unassigned: sql<number>`sum(CASE WHEN ${c.status} = 'open' AND (${c.assignee} IS NULL OR ${c.claimed_until} <= ${at}) AND (${c.snoozed_until} IS NULL OR ${c.snoozed_until} <= ${at}) THEN 1 ELSE 0 END)`,
			snoozed: sql<number>`sum(CASE WHEN ${c.snoozed_until} > ${at} THEN 1 ELSE 0 END)`,
			overdue: sql<number>`sum(CASE WHEN ${c.status} = 'open' AND ${c.sla_breached} IS NOT NULL THEN 1 ELSE 0 END)`,
			held: sql<number>`sum(CASE WHEN ${c.held_at} IS NOT NULL THEN 1 ELSE 0 END)`,
		})
		.from(c)
		.where(
			and(
				inArray(c.organization_id, actor.brands.length ? actor.brands : [""]),
				inbox === "none"
					? isNull(c.inbox_id)
					: inboxId
						? eq(c.inbox_id, inboxId)
						: undefined,
			),
		)
		.get();
	return {
		open: Number(row?.open ?? 0),
		mine: Number(row?.mine ?? 0),
		unassigned: Number(row?.unassigned ?? 0),
		snoozed: Number(row?.snoozed ?? 0),
		overdue: Number(row?.overdue ?? 0),
		held: Number(row?.held ?? 0),
	};
}

export const getConversationFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			// An older link names a received email: its conversation.
			let id = data.id;
			const exists = await conversationFor(actor, id).catch(() => null);
			if (!exists) {
				const m = await db
					.select({ c: schema.receivedEmails.conversation_id })
					.from(schema.receivedEmails)
					.where(
						and(
							eq(schema.receivedEmails.id, id),
							inArray(schema.receivedEmails.organization_id, actor.brands),
						),
					)
					.get();
				if (!m?.c) throw new Response("Conversation not found", { status: 404 });
				id = m.c;
			}
			const conversation = await getConversation(actor, id, { html: true, markRead: true });
			const [inbox, brands] = await Promise.all([
				conversation.inbox_id
					? db
							.select()
							.from(schema.inboxes)
							.where(eq(schema.inboxes.id, conversation.inbox_id))
							.get()
					: null,
				viewScope(context.organizationId).then((v) => v.brands),
			]);
			const [activity, compose, people, saved, contact] = await Promise.all([
				inboxActivity({ conversationId: id, limit: 50 }),
				composeDefaults(actor, id),
				assignees(context.organizationId, inbox ?? null),
				listSavedReplies(actor, { inbox: conversation.inbox_id }),
				contactOf(conversation.brand_id, conversation.contact, id).then((c) =>
					c && actor.masked
						? {
								...c,
								others: c.others.map((o) => ({
									...o,
									subject: maskDigits(o.subject),
								})),
								broadcasts: c.broadcasts.map((b) => ({
									...b,
									subject: maskDigits(b.subject),
								})),
							}
						: c,
				),
			]);
			const settings = settingsOf(inbox);
			return {
				conversation,
				compose,
				inbox: inbox ? lite(inbox) : null,
				brand: brands.find((b) => b.id === conversation.brand_id) ?? null,
				activity: activity.map(activityView),
				me: `user:${context.userId}`,
				people: people.map(({ email: _e, ...p }) => p),
				saved: saved
					.filter((s) => !s.inbox_id || s.inbox_id === conversation.inbox_id)
					.map(savedReplyView),
				variables: VARIABLES.map((v) => ({ ...v })),
				workflow: {
					tags: settings.tags,
					undo_seconds: settings.undo_seconds,
					signature: !!settings.signature,
					sla: settings.sla.enabled,
				},
				contact,
			};
		}),
	);

/**
 * Who wrote in, for the panel beside the conversation (src/server/timeline.ts personPanel):
 * their contact (when the brand has one), with what Mailroom knows about them, and their other
 * conversations.
 */
async function contactOf(brandId: string, from: string, conversationId: string) {
	const address = addressOf(from);
	if (!address) return null;
	const { personPanel } = await import("@/server/timeline");
	const p = await personPanel(brandId, address, conversationId);
	return { ...p, record: p.contact };
}

export const claimConversationFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			id: z.string(),
			release: z.boolean().optional(),
			force: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () =>
			claimConversation(await personOf(context), data.id, {
				release: data.release,
				force: data.force,
			}),
		),
	);

export const addNoteFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			conversation: z.string(),
			text: z.string().max(10_000),
			mentions: z.array(z.string()).max(20).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const { c } = await conversationFor(actor, data.conversation);
			return addNote(actor, c, { text: data.text, mentions: data.mentions });
		}),
	);

export const deleteNoteFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ conversation: z.string(), id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const { c } = await conversationFor(actor, data.conversation);
			await deleteNote(actor, c, data.id);
			return { ok: true };
		}),
	);

export const unsendReplyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => unsendReply(await personOf(context), data.id)),
	);

/** An older page of a conversation's timeline ("Load older"). */
export const olderTimelineFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string(), before: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const c = await getConversation(await personOf(context), data.id, {
				html: true,
				before: data.before,
			});
			return { timeline: c.timeline, has_more: c.has_more, before: c.before };
		}),
	);

/** One received message read or unread, for the person only. */
export const markMessageFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string(), read: z.boolean() }))
	.handler(({ data, context }) =>
		call(async () => markMessage(await personOf(context), data.id, data.read)),
	);

export const updateConversationFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			id: z.string(),
			status: z.enum(["open", "resolved"]).optional(),
			read: z.boolean().optional(),
			tags: z.array(z.string()).max(20).optional(),
			add_tags: z.array(z.string()).max(20).optional(),
			remove_tags: z.array(z.string()).max(20).optional(),
			priority: z.enum(PRIORITIES).optional(),
			snooze_until: z.string().nullable().optional(),
			assignee: z.string().nullable().optional(),
			release_held: z.literal(true).optional(),
			held_seen: z.string().optional(),
		}),
	)
	.handler(({ data: { id, ...rest }, context }) =>
		call(async () => updateConversation(await personOf(context), id, rest)),
	);

const replyFields = z.object({
	conversation: z.string(),
	draft: z.string().optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	cc: z.string().optional(),
	subject: z.string().optional(),
	text: z.string().max(100_000).optional(),
	/** Checked by the server's own reply input (new files, kept ones, received ones). */
	attachments: z.array(z.object({}).passthrough()).max(20).optional(),
	after_message: z.string().max(80).optional(),
	send_at: z.string().max(40).optional(),
	saved_reply_id: z.string().max(80).optional(),
	signature: z.boolean().optional(),
});

export const saveConversationDraftFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(replyFields)
	.handler(({ data: { conversation, draft, ...fields }, context }) =>
		call(async () =>
			saveDraft(await personOf(context), conversation, fields, { draftId: draft }),
		),
	);

export const deleteConversationDraftFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteDraft(await personOf(context), data.id);
			return { ok: true };
		}),
	);

export const sendConversationReplyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(replyFields.extend({ client_id: z.string().max(80).optional() }))
	.handler(({ data: { conversation, draft, client_id, ...fields }, context }) =>
		call(async () =>
			sendReply(
				await personOf(context),
				conversation,
				fields,
				sender({ source: "dashboard" }),
				{
					draftId: draft,
					clientId: client_id,
				},
			),
		),
	);

// ── Inboxes ────────────────────────────────────────────────────────────────

export const listInboxesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) =>
		call(async () => {
			const actor = await personOf(context);
			const [inboxes, { brands }] = await Promise.all([
				listInboxes(actor),
				viewScope(context.organizationId),
			]);
			const ids = inboxes.map((i) => i.id);
			const [creds, open, chats] = ids.length
				? await Promise.all([
						db
							.select({
								inbox: schema.inboxCredentials.inbox_id,
								revoked: schema.inboxCredentials.revoked_at,
								used: schema.inboxCredentials.last_used_at,
							})
							.from(schema.inboxCredentials)
							.where(inArray(schema.inboxCredentials.inbox_id, ids)),
						db
							.select({ inbox: schema.conversations.inbox_id })
							.from(schema.conversations)
							.where(
								and(
									inArray(schema.conversations.inbox_id, ids),
									eq(schema.conversations.status, "open"),
								),
							),
						db
							.select({
								inbox: schema.chatWidgets.inbox_id,
								enabled: schema.chatWidgets.enabled,
								origins: schema.chatWidgets.origins,
							})
							.from(schema.chatWidgets)
							.where(inArray(schema.chatWidgets.inbox_id, ids)),
					])
				: [[], [], []];
			// Where a new inbox can live: each brand's receiving domains.
			const hosts = await db
				.select({
					id: schema.domains.id,
					brand: schema.domains.organization_id,
					host: schema.domains.receiving_host,
					sending: schema.domains.sending,
				})
				.from(schema.domains)
				.where(
					and(
						inArray(schema.domains.organization_id, actor.brands),
						eq(schema.domains.receiving, true),
					),
				);
			const slugs = await db
				.select({ id: schema.organization.id, slug: schema.organization.slug })
				.from(schema.organization)
				.where(inArray(schema.organization.id, actor.brands));
			const { inboundDomain } = await import("@/server/env");
			return {
				brands,
				own: context.organizationId,
				slugs: Object.fromEntries(slugs.map((s) => [s.id, s.slug ?? ""])),
				mailroomDomain: inboundDomain(),
				hosts: hosts.flatMap((h) => (h.host ? [{ ...h, host: h.host }] : [])),
				inboxes: inboxes.map((i) => ({
					...inboxView(i),
					credentials: creds.filter((c) => c.inbox === i.id && !c.revoked).length,
					last_used_at:
						creds
							.filter((c) => c.inbox === i.id && c.used)
							.map((c) => c.used as string)
							.sort()
							.at(-1) ?? null,
					open: open.filter((o) => o.inbox === i.id).length,
					// Its website chat, when it has one.
					chat: chats.find((c) => c.inbox === i.id) ?? null,
				})),
			};
		}),
	);

export const getInboxFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const inbox = await inboxFor(actor, data.id).catch(() => {
				throw new Response("Inbox not found", { status: 404 });
			});
			const [credentials, hooks, activity, brands, siblings, chat] = await Promise.all([
				listCredentials(inbox),
				db
					.select()
					.from(schema.webhooks)
					.where(eq(schema.webhooks.inbox_id, inbox.id))
					.orderBy(desc(schema.webhooks.created_at)),
				inboxActivity({ inboxId: inbox.id, limit: 50 }),
				viewScope(context.organizationId).then((v) => v.brands),
				// The brand's inboxes, for a credential's reach.
				listInboxes({ brands: [inbox.organization_id], inboxIds: null }),
				import("@/server/chat").then(async (m) => {
					const w = await m.getChatWidget(inbox.id);
					return w
						? {
								enabled: w.enabled,
								origins: w.origins,
								stats: await m.chatStats(inbox.id),
							}
						: null;
				}),
			]);
			const { baseUrl } = await import("@/server/env");
			return {
				inbox: inboxView(inbox),
				inboxes: siblings.map(lite),
				chat,
				retention_days: inbox.retention_days,
				brand: brands.find((b) => b.id === inbox.organization_id) ?? null,
				credentials: credentials.map(credentialView),
				webhooks: hooks.map(({ secret: _s, ...h }) => h),
				activity: activity.map(activityView),
				events: [...INBOX_EVENTS],
				base: baseUrl(),
			};
		}),
	);

const inboxFields = z.object({
	name: z.string(),
	reply_from: z.string().nullish(),
	send_allow: z.array(z.string()).nullish(),
	send_block: z.array(z.string()).nullish(),
	description: z.string().nullish(),
});

export const createInboxFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(
		inboxFields.extend({
			brand: z.string().nullish(),
			local_part: z.string(),
			domain: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = data.brand
				? await brandIn(context.organizationId, data.brand)
				: context.organizationId;
			const inbox = await createInbox(brand, data, { userId: context.userId });
			await logInbox(await personOf(context), {
				brandId: brand,
				inboxId: inbox.id,
				action: "inbox.created",
				detail: { address: inbox.address },
			});
			return inboxView(inbox);
		}),
	);

async function managed(context: Ctx, id: string) {
	const actor = await personOf(context);
	return { actor, inbox: await inboxFor(actor, id) };
}

export const updateInboxFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(inboxFields.partial().extend({ id: z.string() }))
	.handler(({ data: { id, ...fields }, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, id);
			const row = await updateInbox(inbox, fields);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.updated",
			});
			return inboxView(row);
		}),
	);

export const deleteInboxFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.id);
			await deleteInbox(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.deleted",
				detail: { address: inbox.address },
			});
			return { ok: true };
		}),
	);

const permissions = z.array(z.enum(["read", "attachments", "triage", "notes", "draft", "send"]));

export const createInboxCredentialFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(
		z.object({
			id: z.string(),
			name: z.string(),
			permissions,
			send_scope: z.enum(["replies", "anyone"]),
			scope: z.enum(["inbox", "inboxes", "brand"]).optional(),
			inbox_ids: z.array(z.string()).optional(),
		}),
	)
	.handler(({ data: { id, ...fields }, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, id);
			const { credential, token } = await createCredential(inbox, fields, {
				userId: context.userId,
			});
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.created",
				detail: {
					credential_id: credential.id,
					name: credential.name,
					permissions: credential.permissions,
					send_scope: credential.send_scope,
					scope: credential.scope,
				},
			});
			return { credential: credentialView(credential), token };
		}),
	);

export const updateInboxCredentialFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(
		z.object({
			id: z.string(),
			credential: z.string(),
			permissions: permissions.optional(),
			send_scope: z.enum(["replies", "anyone"]).optional(),
			scope: z.enum(["inbox", "inboxes", "brand"]).optional(),
			inbox_ids: z.array(z.string()).optional(),
		}),
	)
	.handler(({ data: { id, credential: cid, ...fields }, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, id);
			const c = await updateCredential(await getCredential(inbox, cid), fields);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.updated",
				detail: {
					credential_id: c.id,
					permissions: c.permissions,
					send_scope: c.send_scope,
				},
			});
			return credentialView(c);
		}),
	);

export const rotateInboxCredentialFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ id: z.string(), credential: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.id);
			const { credential, token } = await rotateCredential(
				await getCredential(inbox, data.credential),
			);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.rotated",
				detail: { credential_id: credential.id },
			});
			return { credential: credentialView(credential), token };
		}),
	);

export const revokeInboxCredentialFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ id: z.string(), credential: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.id);
			const c = await revokeCredential(await getCredential(inbox, data.credential));
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.revoked",
				detail: { credential_id: c.id },
			});
			return credentialView(c);
		}),
	);

export const createInboxWebhookFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ id: z.string(), url: z.string(), events: z.array(z.string()).min(1) }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.id);
			const hook = await createWebhook(context.organizationId, {
				url: data.url,
				events: data.events,
				inbox_id: inbox.id,
			});
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "webhook.created",
				detail: { webhook_id: hook.id, url: hook.url, events: hook.events },
			});
			return hook;
		}),
	);

const personAction = z.discriminatedUnion("type", [
	z.object({ type: z.literal("contact") }),
	z.object({
		type: z.literal("segment"),
		segment_id: z.string(),
		action: z.enum(["add", "remove"]),
	}),
	z.object({
		type: z.literal("newsletter"),
		newsletter_id: z.string(),
		action: z.enum(["subscribe", "unsubscribe"]),
	}),
	z.object({ type: z.literal("automation"), automation_id: z.string() }),
]);

/** What the person panel can put someone in: list segments, newsletters, automations that are on. */
export const personActionOptionsFn = createServerFn({ method: "GET" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ conversation_id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { c } = await conversationFor(await personOf(context), data.conversation_id);
			const brand = c.organization_id;
			const [segments, newsletters, automations] = await Promise.all([
				db
					.select({
						id: schema.segments.id,
						name: schema.segments.name,
						rules: schema.segments.rules,
					})
					.from(schema.segments)
					.where(eq(schema.segments.organization_id, brand))
					.orderBy(schema.segments.name),
				db
					.select({ id: schema.newsletters.id, name: schema.newsletters.name })
					.from(schema.newsletters)
					.where(eq(schema.newsletters.organization_id, brand))
					.orderBy(schema.newsletters.name),
				db
					.select({ id: schema.automations.id, name: schema.automations.name })
					.from(schema.automations)
					.where(
						and(
							eq(schema.automations.organization_id, brand),
							eq(schema.automations.status, "active"),
						),
					)
					.orderBy(schema.automations.name),
			]);
			return {
				segments: segments.filter((s) => !s.rules).map((s) => ({ id: s.id, name: s.name })),
				newsletters,
				automations,
			};
		}),
	);

/** Does one of those for whoever the conversation is with (they become a contact first). */
export const personActionFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ conversation_id: z.string(), action: personAction }))
	.handler(({ data, context }) =>
		call(async () => {
			const { c } = await conversationFor(await personOf(context), data.conversation_id);
			if (!c.contact_address)
				throw new Response("This conversation has no email address", { status: 422 });
			const { actForPerson } = await import("@/server/automations");
			return actForPerson(c.organization_id, c.contact_address, data.action);
		}),
	);
