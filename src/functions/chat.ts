import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { viewScope } from "@/server/brands";
import { conversationFor } from "@/server/conversations";
import { db, schema } from "@/server/db";
import { inboxFor, inboxView, logInbox, personOf } from "@/server/inboxes";
import { can, orgMiddleware } from "@/server/middleware";
import { call } from "./call";

/** Website chats (src/server/chat.ts) for people: an inbox's chat settings, and files and
 * deleting in a chat conversation. */

type Ctx = Parameters<typeof personOf>[0];

async function managed(context: Ctx, id: string) {
	const actor = await personOf(context);
	return { actor, inbox: await inboxFor(actor, id) };
}

/** An inbox's website chat: its settings, the code, and what the preview needs. */
export const getChatSettingsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ inbox: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { inbox } = await managed(context, data.inbox).catch(() => {
				throw new Response("Inbox not found", { status: 404 });
			});
			const chat = await import("@/server/chat");
			const { baseUrl, inboundRetentionDays } = await import("@/server/env");
			const { turnstileConfigured } = await import("@/server/turnstile");
			const widget = await chat.getChatWidget(inbox.id);
			const [brands, turnstile, preview, stats] = await Promise.all([
				viewScope(context.organizationId).then((v) => v.brands),
				db
					.select()
					.from(schema.turnstileWidgets)
					.where(eq(schema.turnstileWidgets.organization_id, inbox.organization_id))
					.get(),
				widget
					? (async () => {
							const { publicConfig } = await import("@/server/chat-public");
							return publicConfig({ widget, inbox });
						})()
					: null,
				widget ? chat.chatStats(inbox.id) : null,
			]);
			const brand = brands.find((b) => b.id === inbox.organization_id) ?? null;
			const org = await db
				.select({ name: schema.organization.name })
				.from(schema.organization)
				.where(eq(schema.organization.id, inbox.organization_id))
				.get();
			return {
				inbox: inboxView(inbox),
				brand,
				/** The header's title when none is set (as the widget shows it). */
				brand_name: org?.name ?? brand?.name ?? inbox.name,
				widget: widget ? chat.chatWidgetView(widget) : null,
				retention_days: inbox.retention_days,
				default_retention: inboundRetentionDays(),
				preview,
				stats,
				turnstile: {
					configured: turnstileConfigured(),
					on: !!turnstile?.sitekey && !!turnstile.secret,
					error: turnstile?.error ?? null,
					domains: turnstile?.domains ?? [],
				},
				defaults: chat.DESIGN_DEFAULTS,
				me: context.email,
				base: baseUrl(),
			};
		}),
	);

/** Turns the chat on for an inbox, or saves its settings. */
export const saveChatSettingsFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string(), settings: z.record(z.string(), z.unknown()) }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.inbox);
			const { chatWidgetView, getChatWidget, saveChatWidget } = await import("@/server/chat");
			const before = await getChatWidget(inbox.id);
			// A new chat keeps its conversations 90 days unless told otherwise.
			const settings =
				!before &&
				data.settings.retention_days === undefined &&
				inbox.retention_days == null
					? { ...data.settings, retention_days: 90 }
					: data.settings;
			const { widget, turnstile } = await saveChatWidget(inbox, settings, {
				userId: context.userId,
				email: context.email,
			});
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: before ? "chat.updated" : "chat.created",
			});
			return { widget: chatWidgetView(widget), turnstile };
		}),
	);

/** A new public key: the old snippet stops working at once. */
export const rotateChatKeyFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.inbox);
			const { chatWidgetView, rotateChatKey } = await import("@/server/chat");
			const row = await rotateChatKey(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "chat.key_rotated",
			});
			return chatWidgetView(row);
		}),
	);

/**
 * Identity verification: a new secret (shown this once; the old one stops at once), or none
 * (which also lets visitors chat without signing in again).
 */
export const setChatIdentitySecretFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string(), make: z.boolean() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.inbox);
			const { chatWidgetView, setIdentitySecret } = await import("@/server/chat");
			const { widget, secret } = await setIdentitySecret(inbox, data.make);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: data.make ? "chat.identity_secret_made" : "chat.identity_secret_removed",
			});
			return { widget: chatWidgetView(widget), secret };
		}),
	);

/** Removes the chat from the inbox (its conversations stay, as they are). */
export const deleteChatWidgetFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:agents")])
	.validator(z.object({ inbox: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { actor, inbox } = await managed(context, data.inbox);
			const { deleteChatWidget } = await import("@/server/chat");
			await deleteChatWidget(inbox);
			await logInbox(actor, {
				brandId: inbox.organization_id,
				inboxId: inbox.id,
				action: "chat.deleted",
			});
			return { ok: true };
		}),
	);

/** A file (and optionally a message with it) from the team in a chat, as a data URL. */
export const sendChatFileFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			conversation: z.string(),
			filename: z.string().max(300),
			data: z.string().max(14_500_000),
			text: z.string().max(4000).optional(),
			client_id: z.string().max(80).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const actor = await personOf(context);
			const { c: x } = await conversationFor(actor, data.conversation);
			const chat = await import("@/server/chat");
			if (x.channel !== "chat")
				throw new Response("Files go in website chats only", { status: 422 });
			const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(data.data);
			if (!m) throw new Response("file: not a data URL", { status: 422 });
			const bytes = Uint8Array.from(atob(m[2] ?? ""), (ch) => ch.charCodeAt(0));
			const a = await chat.storeChatFile(x, {
				filename: data.filename,
				content_type: m[1] ?? "",
				bytes,
			});
			const line = await chat.teamSays(actor, x, {
				text: data.text ?? "",
				via: "dashboard",
				attachments: [a],
				client_id: data.client_id ?? null,
			});
			return { id: line.id };
		}),
	);

/** Deletes a conversation now, with its files (instead of waiting for its retention). */
export const deleteConversationNowFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { deleteConversationNow } = await import("@/server/chat");
			await deleteConversationNow(await personOf(context), data.id);
			return { ok: true };
		}),
	);
