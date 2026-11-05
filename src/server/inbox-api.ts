import { eq } from "drizzle-orm";
import type { KeyAuth } from "./api-keys";
import { brandIds, brandIn } from "./brands";
import {
	type ConversationFilter,
	deleteDraft,
	draftFor,
	getAttachment,
	getConversation,
	getMessage,
	listConversations,
	type Sender,
	saveDraft,
	searchMessages,
	sendReply,
	updateConversation,
} from "./conversations";
import { db, schema } from "./db";
import { kickDispatcher, rateGate } from "./dispatcher";
import { ApiError, validation } from "./errors";
import {
	ALL_INBOX_PERMISSIONS,
	activityView,
	createCredential,
	createInbox,
	credentialView,
	deleteInbox,
	getCredential,
	type InboxActor,
	inboxActivity,
	inboxFor,
	inboxView,
	listCredentials,
	listInboxes,
	logInbox,
	revokeCredential,
	rotateCredential,
	updateCredential,
	updateInbox,
} from "./inboxes";
import { createEmails, parseSend, type SendOptions } from "./send";

/**
 * The API's inbox paths (src/server/api.ts hands them over). An agent's credential (Bearer
 * mri_…) reaches only `agentRoutes`, and in them only its inbox; a full API key reaches them for
 * every inbox of its organization (or of the brand it acts on), and also `adminRoutes`, which
 * make inboxes and hand out credentials.
 */

type Handler = (
	req: Request,
	actor: InboxActor,
	params: Record<string, string>,
	url: URL,
) => Promise<Response>;
type AdminHandler = (
	req: Request,
	auth: KeyAuth,
	params: Record<string, string>,
	url: URL,
) => Promise<Response>;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function body(req: Request): Promise<Record<string, unknown>> {
	const text = await req.text();
	if (!text.trim()) return {};
	try {
		return (JSON.parse(text) ?? {}) as Record<string, unknown>;
	} catch {
		throw validation("The body must be JSON");
	}
}

const flag = (url: URL, name: string) => {
	const v = url.searchParams.get(name);
	return v === null ? null : v === "true" || v === "1";
};
const num = (url: URL, name: string) => Number(url.searchParams.get(name)) || undefined;

/** Sends through the brand's queue and limits, like any email of the API's. */
export const sender = (o: Pick<SendOptions, "source" | "apiKeyId">): Sender => ({
	send: async (brand, input) => {
		const [r] = await createEmails(brand, [parseSend(input)], {
			...o,
			kick: kickDispatcher,
			gate: rateGate,
		});
		if (!r) throw validation("Nothing to send");
		if (r.error) throw r.error;
		return r.id;
	},
});

const senderOf = (actor: InboxActor) =>
	sender({
		source: actor.type === "agent" ? "agent" : "api",
		apiKeyId: actor.type === "api" ? actor.id : null,
	});

/** A full key as an inbox actor: every inbox of its brands, every permission. */
export async function keyActor(auth: KeyAuth): Promise<InboxActor> {
	const key = await db
		.select({ name: schema.apiKeys.name })
		.from(schema.apiKeys)
		.where(eq(schema.apiKeys.id, auth.id))
		.get();
	return {
		organizationId: auth.organizationId,
		brands: auth.brandId ? [auth.brandId] : await brandIds(auth.organizationId),
		inboxId: null,
		permissions: ALL_INBOX_PERMISSIONS,
		sendScope: "anyone",
		type: "api",
		id: auth.id,
		name: key?.name ?? "API key",
		reader: null,
	};
}

export const agentRoutes: [string, RegExp, Handler][] = [
	[
		"GET",
		/^\/inboxes$/,
		async (_req, actor) =>
			json({
				object: "list",
				has_more: false,
				data: (await listInboxes(actor)).map(inboxView),
			}),
	],
	[
		"GET",
		/^\/inboxes\/(?<id>[^/]+)$/,
		async (_req, actor, p) => json(inboxView(await inboxFor(actor, p.id as string))),
	],
	[
		"GET",
		/^\/inboxes\/(?<id>[^/]+)\/conversations$/,
		async (_req, actor, p, url) => {
			const inbox = await inboxFor(actor, p.id as string);
			return json({
				object: "list",
				...(await listConversations(actor, filters(url, inbox.id))),
			});
		},
	],
	[
		"GET",
		/^\/conversations$/,
		async (_req, actor, _p, url) =>
			json({
				object: "list",
				...(await listConversations(actor, filters(url, url.searchParams.get("inbox")))),
			}),
	],
	[
		"GET",
		/^\/conversations\/(?<id>[^/]+)$/,
		async (_req, actor, p, url) =>
			json(
				await getConversation(actor, p.id as string, {
					html: flag(url, "html") ?? false,
					markRead: flag(url, "mark_read") ?? false,
				}),
			),
	],
	[
		"PATCH",
		/^\/conversations\/(?<id>[^/]+)$/,
		async (req, actor, p) =>
			json(await updateConversation(actor, p.id as string, await body(req))),
	],
	[
		"POST",
		/^\/conversations\/(?<id>[^/]+)\/drafts$/,
		async (req, actor, p) => json(await saveDraft(actor, p.id as string, await body(req)), 201),
	],
	[
		"POST",
		/^\/conversations\/(?<id>[^/]+)\/reply$/,
		async (req, actor, p) =>
			json(await sendReply(actor, p.id as string, await body(req), senderOf(actor)), 201),
	],
	[
		"PATCH",
		/^\/drafts\/(?<id>[^/]+)$/,
		async (req, actor, p) => {
			const d = await draftFor(actor, p.id as string);
			return json(
				await saveDraft(actor, d.conversation_id, await body(req), { draftId: d.id }),
			);
		},
	],
	[
		"DELETE",
		/^\/drafts\/(?<id>[^/]+)$/,
		async (_req, actor, p) => {
			await deleteDraft(actor, p.id as string);
			return json({ object: "draft", id: p.id, deleted: true });
		},
	],
	[
		"POST",
		/^\/drafts\/(?<id>[^/]+)\/send$/,
		async (req, actor, p) => {
			const d = await draftFor(actor, p.id as string);
			return json(
				await sendReply(actor, d.conversation_id, await body(req), senderOf(actor), {
					draftId: d.id,
				}),
				201,
			);
		},
	],
	[
		"GET",
		/^\/messages$/,
		async (_req, actor, _p, url) =>
			json({
				object: "list",
				...(await searchMessages(actor, {
					inbox: url.searchParams.get("inbox"),
					query: url.searchParams.get("q"),
					from: url.searchParams.get("from"),
					since: url.searchParams.get("since"),
					has_attachments: flag(url, "has_attachments"),
					after: url.searchParams.get("after"),
					limit: num(url, "limit"),
				})),
			}),
	],
	[
		"GET",
		/^\/messages\/(?<id>[^/]+)$/,
		async (_req, actor, p) => json(await getMessage(actor, p.id as string)),
	],
	[
		"GET",
		/^\/messages\/(?<id>[^/]+)\/attachments\/(?<attachment>[^/]+)$/,
		async (_req, actor, p, url) =>
			json(
				await getAttachment(actor, p.id as string, p.attachment as string, {
					content: flag(url, "content") ?? false,
				}),
			),
	],
	[
		"GET",
		/^\/inboxes\/(?<id>[^/]+)\/activity$/,
		async (_req, actor, p, url) => {
			const inbox = await inboxFor(actor, p.id as string);
			const rows = await inboxActivity({
				inboxId: inbox.id,
				before: url.searchParams.get("before") ?? undefined,
				limit: num(url, "limit"),
			});
			return json({ object: "list", data: rows.map(activityView) });
		},
	],
];

function filters(url: URL, inbox: string | null): ConversationFilter {
	const status = url.searchParams.get("status");
	return {
		inbox,
		status: status === "resolved" || status === "all" ? status : "open",
		unread: flag(url, "unread"),
		search: url.searchParams.get("search") ?? url.searchParams.get("q"),
		after: url.searchParams.get("after"),
		limit: num(url, "limit"),
	};
}

/** Making inboxes and their credentials: full keys only (api.ts checks). */
export const adminRoutes: [string, RegExp, AdminHandler][] = [
	[
		"POST",
		/^\/inboxes$/,
		async (req, auth) => {
			const b = await body(req);
			const named = typeof b.brand === "string" ? b.brand : null;
			if (
				auth.brandId &&
				named &&
				(await brandIn(auth.organizationId, named)) !== auth.brandId
			)
				throw validation("`brand` names another brand than the request's");
			const brand =
				auth.brandId ??
				(named ? await brandIn(auth.organizationId, named) : auth.organizationId);
			const actor = await keyActor(auth);
			const inbox = await createInbox(brand, b);
			await logInbox(actor, {
				brandId: brand,
				inboxId: inbox.id,
				action: "inbox.created",
				detail: { address: inbox.address },
			});
			return json(inboxView(inbox), 201);
		},
	],
	[
		"PATCH",
		/^\/inboxes\/(?<id>[^/]+)$/,
		async (req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			const row = await updateInbox(inbox, await body(req));
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.updated",
			});
			return json(inboxView(row));
		},
	],
	[
		"DELETE",
		/^\/inboxes\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			await deleteInbox(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "inbox.deleted",
				detail: { address: inbox.address },
			});
			return json({ object: "inbox", id: inbox.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/inboxes\/(?<id>[^/]+)\/credentials$/,
		async (_req, auth, p) => {
			const inbox = await inboxFor(await keyActor(auth), p.id as string);
			return json({
				object: "list",
				data: (await listCredentials(inbox)).map(credentialView),
			});
		},
	],
	[
		"POST",
		/^\/inboxes\/(?<id>[^/]+)\/credentials$/,
		async (req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			const { credential, token } = await createCredential(inbox, await body(req));
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.created",
				detail: {
					credential_id: credential.id,
					name: credential.name,
					permissions: credential.permissions,
					send_scope: credential.send_scope,
				},
			});
			return json({ ...credentialView(credential), token }, 201);
		},
	],
	[
		"PATCH",
		/^\/inboxes\/(?<id>[^/]+)\/credentials\/(?<cid>[^/]+)$/,
		async (req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			const c = await updateCredential(
				await getCredential(inbox, p.cid as string),
				await body(req),
			);
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
			return json(credentialView(c));
		},
	],
	[
		"POST",
		/^\/inboxes\/(?<id>[^/]+)\/credentials\/(?<cid>[^/]+)\/rotate$/,
		async (_req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			const { credential, token } = await rotateCredential(
				await getCredential(inbox, p.cid as string),
			);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.rotated",
				detail: { credential_id: credential.id },
			});
			return json({ ...credentialView(credential), token });
		},
	],
	[
		"DELETE",
		/^\/inboxes\/(?<id>[^/]+)\/credentials\/(?<cid>[^/]+)$/,
		async (_req, auth, p) => {
			const actor = await keyActor(auth);
			const inbox = await inboxFor(actor, p.id as string);
			const c = await revokeCredential(await getCredential(inbox, p.cid as string));
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "credential.revoked",
				detail: { credential_id: c.id },
			});
			return json(credentialView(c));
		},
	],
];

export const forbiddenForAgents = () =>
	new ApiError(
		403,
		"inbox_credential",
		"An inbox credential only reaches its inbox's paths (/inboxes, /conversations, /messages, /drafts)",
	);
