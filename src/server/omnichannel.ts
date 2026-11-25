import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import type { VisitorSessionContext } from "./db/schema";
import { baseUrl } from "./env";
import { ApiError, validation } from "./errors";
import { decryptSecret, encryptSecret, organizationOf } from "./org-aws";
import { iso } from "./time";

/**
 * Omnichannel Shared Inbox bridges:
 *  - WhatsApp Business Cloud API (/hooks/whatsapp/:orgId): Meta hub.challenge verification +
 *    HMAC-SHA256 X-Hub-Signature-256 inbound webhook + Graph API outbound replies.
 *  - Telegram Bot API (/hooks/telegram/:orgId): X-Telegram-Bot-Api-Secret-Token verification +
 *    Bot API sendMessage outbound replies.
 * Both thread directly into the same 3-pane Inbox, Live Hub, SLA engine & Contact timeline.
 */

export type OmnichannelKind = "whatsapp" | "telegram";

interface WhatsAppSecrets {
	app_secret: string;
	access_token: string;
	verify_token: string;
	phone_number_id: string;
}

interface TelegramSecrets {
	bot_token: string;
	secret_token: string;
}

async function hmacHex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEq(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

const whatsappInput = z.object({
	phone_number_id: z.string().trim().min(4).max(80),
	verify_token: z.string().trim().min(4).max(200).optional(),
	app_secret: z.string().trim().min(6).max(300).optional(),
	access_token: z.string().trim().min(10).max(1000).optional(),
	enabled: z.boolean().optional(),
});

const telegramInput = z.object({
	bot_username: z.string().trim().max(80).optional(),
	bot_token: z.string().trim().min(10).max(300).optional(),
	secret_token: z.string().trim().min(6).max(256).optional(),
	enabled: z.boolean().optional(),
});

export async function listOmnichannelSettings(organizationId: string) {
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(eq(schema.orgWebhookIntegrations.organization_id, org));
	const base = baseUrl().replace(/\/$/, "");
	const wa = rows.find((r) => r.kind === "whatsapp");
	const tg = rows.find((r) => r.kind === "telegram");
	return {
		whatsapp: {
			configured: Boolean(wa?.secret_encrypted),
			enabled: Boolean(wa?.enabled && wa?.secret_encrypted),
			phone_number_id: wa?.config?.phone_number_id ?? "",
			verify_token_hint:
				wa?.config?.verify_token_hint ??
				(wa?.config?.verify_token ? `…${String(wa.config.verify_token).slice(-4)}` : null),
			secret_hint: wa?.secret_hint ?? null,
			webhook_url: `${base}/hooks/whatsapp/${org}`,
			updated_at: wa?.updated_at ?? null,
		},
		telegram: {
			configured: Boolean(tg?.secret_encrypted),
			enabled: Boolean(tg?.enabled && tg?.secret_encrypted),
			bot_username: tg?.config?.bot_username ?? "",
			secret_hint: tg?.secret_hint ?? null,
			webhook_url: `${base}/hooks/telegram/${org}`,
			updated_at: tg?.updated_at ?? null,
		},
	};
}

export async function saveWhatsAppSettings(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = whatsappInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const existing = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, org),
				eq(schema.orgWebhookIntegrations.kind, "whatsapp"),
			),
		)
		.get();
	const prevSecrets: Partial<WhatsAppSecrets> = existing?.secret_encrypted
		? (JSON.parse(await decryptSecret(existing.secret_encrypted)) as Partial<WhatsAppSecrets>)
		: {};
	const appSecret = v.app_secret ?? prevSecrets.app_secret;
	const accessToken = v.access_token ?? prevSecrets.access_token;
	const verifyToken = v.verify_token ?? prevSecrets.verify_token;
	if (!appSecret || !accessToken || !verifyToken)
		throw validation("WhatsApp requires Verify Token, App Secret, and Cloud API Access Token");

	const secrets: WhatsAppSecrets = {
		app_secret: appSecret,
		access_token: accessToken,
		verify_token: verifyToken,
		phone_number_id: v.phone_number_id,
	};
	const row = {
		organization_id: org,
		kind: "whatsapp",
		secret_encrypted: await encryptSecret(JSON.stringify(secrets)),
		secret_hint: `…${accessToken.slice(-4)}`,
		config: {
			phone_number_id: v.phone_number_id,
			verify_token_hint: `…${verifyToken.slice(-4)}`,
		},
		enabled: v.enabled ?? true,
		updated_by: userId,
		updated_at: iso(now),
	};
	await db
		.insert(schema.orgWebhookIntegrations)
		.values(row)
		.onConflictDoUpdate({
			target: [
				schema.orgWebhookIntegrations.organization_id,
				schema.orgWebhookIntegrations.kind,
			],
			set: row,
		});
	return (await listOmnichannelSettings(org)).whatsapp;
}

export async function saveTelegramSettings(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = telegramInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const existing = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, org),
				eq(schema.orgWebhookIntegrations.kind, "telegram"),
			),
		)
		.get();
	const prevSecrets: Partial<TelegramSecrets> = existing?.secret_encrypted
		? (JSON.parse(await decryptSecret(existing.secret_encrypted)) as Partial<TelegramSecrets>)
		: {};
	const botToken = v.bot_token ?? prevSecrets.bot_token;
	const secretToken = v.secret_token ?? prevSecrets.secret_token;
	if (!botToken || !secretToken)
		throw validation("Telegram requires both Bot Token and Webhook Secret Token");

	const secrets: TelegramSecrets = { bot_token: botToken, secret_token: secretToken };
	const row = {
		organization_id: org,
		kind: "telegram",
		secret_encrypted: await encryptSecret(JSON.stringify(secrets)),
		secret_hint: `…${botToken.slice(-4)}`,
		config: { bot_username: v.bot_username ?? existing?.config?.bot_username ?? "" },
		enabled: v.enabled ?? true,
		updated_by: userId,
		updated_at: iso(now),
	};
	await db
		.insert(schema.orgWebhookIntegrations)
		.values(row)
		.onConflictDoUpdate({
			target: [
				schema.orgWebhookIntegrations.organization_id,
				schema.orgWebhookIntegrations.kind,
			],
			set: row,
		});
	return (await listOmnichannelSettings(org)).telegram;
}

async function ingestOmnichannelMessage(o: {
	orgId: string;
	channel: OmnichannelKind;
	contactAddress: string;
	senderName: string;
	text: string;
	context: VisitorSessionContext;
	now: number;
}) {
	const at = iso(o.now);
	const snippet = o.text.trim().slice(0, 180);
	const existing = await db
		.select()
		.from(schema.conversations)
		.where(
			and(
				eq(schema.conversations.organization_id, o.orgId),
				eq(schema.conversations.channel, o.channel),
				eq(schema.conversations.contact_address, o.contactAddress),
			),
		)
		.orderBy(desc(schema.conversations.last_message_at))
		.get();

	let convId: string;
	let inboxId: string | null = existing?.inbox_id ?? null;
	if (!inboxId) {
		const defInbox = await db
			.select({ id: schema.inboxes.id })
			.from(schema.inboxes)
			.where(eq(schema.inboxes.organization_id, o.orgId))
			.limit(1)
			.get();
		inboxId = defInbox?.id ?? null;
	}
	if (existing) {
		convId = existing.id;
		await db
			.update(schema.conversations)
			.set({
				status: "open",
				snoozed_until: null,
				inbox_id: existing.inbox_id ?? inboxId,
				messages: sql`${schema.conversations.messages} + 1`,
				snippet,
				visitor_name: o.senderName || existing.visitor_name,
				visitor_context: {
					...(existing.visitor_context ?? {}),
					...o.context,
					updated_at: at,
				},
				last_message_at: at,
				last_inbound_at: at,
				updated_at: at,
			})
			.where(eq(schema.conversations.id, existing.id));
	} else {
		convId = `conv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
		await db.insert(schema.conversations).values({
			id: convId,
			organization_id: o.orgId,
			inbox_id: inboxId,
			channel: o.channel,
			subject: `${o.channel === "whatsapp" ? "WhatsApp" : "Telegram"} · ${o.senderName || o.contactAddress}`,
			contact: o.senderName ? `${o.senderName} <${o.contactAddress}>` : o.contactAddress,
			contact_address: o.contactAddress,
			visitor_name: o.senderName || null,
			visitor_context: { ...o.context, updated_at: at },
			status: "open",
			messages: 1,
			snippet,
			last_message_at: at,
			last_inbound_at: at,
			created_at: at,
			updated_at: at,
		});
	}

	const msgId = `cm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	await db.insert(schema.chatMessages).values({
		id: msgId,
		organization_id: o.orgId,
		conversation_id: convId,
		inbox_id: inboxId,
		author: "visitor",
		author_id: null,
		author_name: o.senderName || o.contactAddress,
		text: o.text.trim().slice(0, 8000),
		via: "widget",
		created_at: at,
	});

	const { notifyInboxChange } = await import("./inbox-live");
	await notifyInboxChange(o.orgId, { kind: "chat", conversation_id: convId });
	return { conversation_id: convId, message_id: msgId };
}

/** Public webhook handler: GET/POST /hooks/whatsapp/:orgId */
export async function handleWhatsAppWebhook(
	orgId: string,
	request: Request,
	now = Date.now(),
): Promise<Response> {
	const integration = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, orgId),
				eq(schema.orgWebhookIntegrations.kind, "whatsapp"),
				eq(schema.orgWebhookIntegrations.enabled, true),
			),
		)
		.get();
	if (!integration?.secret_encrypted) return new Response("Not configured", { status: 404 });
	const secrets = JSON.parse(
		await decryptSecret(integration.secret_encrypted),
	) as WhatsAppSecrets;

	// Meta webhook verification handshake
	if (request.method === "GET") {
		const url = new URL(request.url);
		const mode = url.searchParams.get("hub.mode");
		const token = url.searchParams.get("hub.verify_token") ?? "";
		const challenge = url.searchParams.get("hub.challenge") ?? "";
		if (mode === "subscribe" && safeEq(token, secrets.verify_token)) {
			return new Response(challenge, { status: 200 });
		}
		return new Response("Forbidden", { status: 403 });
	}

	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	const rawBody = await request.text();
	const got = (request.headers.get("x-hub-signature-256") ?? "")
		.replace(/^sha256=/i, "")
		.toLowerCase();
	const expected = await hmacHex(secrets.app_secret, rawBody);
	if (!got || !safeEq(expected, got)) return new Response("Invalid signature", { status: 401 });

	let payload: {
		entry?: {
			changes?: {
				value?: {
					contacts?: { wa_id?: string; profile?: { name?: string } }[];
					messages?: { from?: string; type?: string; text?: { body?: string } }[];
				};
			}[];
		}[];
	};
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}

	let ingested = 0;
	for (const entry of payload.entry ?? []) {
		for (const change of entry.changes ?? []) {
			const val = change.value;
			const names = new Map(
				(val?.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]),
			);
			for (const msg of val?.messages ?? []) {
				const phone = msg.from?.trim();
				const text = msg.text?.body?.trim();
				if (!phone || !text) continue;
				await ingestOmnichannelMessage({
					orgId,
					channel: "whatsapp",
					contactAddress: `wa:${phone}`,
					senderName: names.get(phone) || `+${phone}`,
					text,
					context: {
						external_channel: "whatsapp",
						external_phone: phone,
					},
					now,
				});
				ingested++;
			}
		}
	}
	return Response.json({ ok: true, ingested });
}

/** Public webhook handler: POST /hooks/telegram/:orgId */
export async function handleTelegramWebhook(
	orgId: string,
	request: Request,
	now = Date.now(),
): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	const integration = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, orgId),
				eq(schema.orgWebhookIntegrations.kind, "telegram"),
				eq(schema.orgWebhookIntegrations.enabled, true),
			),
		)
		.get();
	if (!integration?.secret_encrypted) return new Response("Not configured", { status: 404 });
	const secrets = JSON.parse(
		await decryptSecret(integration.secret_encrypted),
	) as TelegramSecrets;

	const got = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (!got || !safeEq(got, secrets.secret_token)) {
		return new Response("Invalid secret token", { status: 401 });
	}

	let update: {
		message?: {
			text?: string;
			chat?: { id?: number | string };
			from?: { first_name?: string; last_name?: string; username?: string };
		};
	};
	try {
		update = (await request.json()) as typeof update;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}

	const msg = update.message;
	const chatId = msg?.chat?.id != null ? String(msg.chat.id) : "";
	const text = msg?.text?.trim() ?? "";
	if (!chatId || !text) return Response.json({ ok: true, ingested: 0 });

	const senderName =
		[msg?.from?.first_name, msg?.from?.last_name].filter(Boolean).join(" ") ||
		(msg?.from?.username ? `@${msg.from.username}` : `Telegram ${chatId}`);

	const out = await ingestOmnichannelMessage({
		orgId,
		channel: "telegram",
		contactAddress: `tg:${chatId}`,
		senderName,
		text,
		context: {
			external_channel: "telegram",
			external_chat_id: chatId,
			external_username: msg?.from?.username,
		},
		now,
	});
	return Response.json({ ok: true, ingested: 1, ...out });
}

/** Deliver an outbound agent reply to WhatsApp Cloud API or Telegram Bot API. */
export async function sendOmnichannelReply(
	orgId: string,
	channel: OmnichannelKind,
	context: VisitorSessionContext | null | undefined,
	contactAddress: string,
	text: string,
): Promise<boolean> {
	const org = await organizationOf(orgId);
	const integration = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, org),
				eq(schema.orgWebhookIntegrations.kind, channel),
				eq(schema.orgWebhookIntegrations.enabled, true),
			),
		)
		.get();
	if (!integration?.secret_encrypted) return false;

	if (channel === "whatsapp") {
		const secrets = JSON.parse(
			await decryptSecret(integration.secret_encrypted),
		) as WhatsAppSecrets;
		const phone = context?.external_phone || contactAddress.replace(/^wa:/, "");
		if (!phone) return false;
		const res = await fetch(
			`https://graph.facebook.com/v21.0/${encodeURIComponent(secrets.phone_number_id)}/messages`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${secrets.access_token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					messaging_product: "whatsapp",
					to: phone,
					type: "text",
					text: { body: text },
				}),
			},
		);
		if (!res.ok) {
			const msg = await res.text().catch(() => res.statusText);
			throw new ApiError(
				502,
				"whatsapp_send_failed",
				`WhatsApp API ${res.status}: ${msg.slice(0, 200)}`,
			);
		}
		return true;
	}

	const secrets = JSON.parse(
		await decryptSecret(integration.secret_encrypted),
	) as TelegramSecrets;
	const chatId = context?.external_chat_id || contactAddress.replace(/^tg:/, "");
	if (!chatId) return false;
	const res = await fetch(`https://api.telegram.org/bot${secrets.bot_token}/sendMessage`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text }),
	});
	if (!res.ok) {
		const msg = await res.text().catch(() => res.statusText);
		throw new ApiError(
			502,
			"telegram_send_failed",
			`Telegram API ${res.status}: ${msg.slice(0, 200)}`,
		);
	}
	return true;
}
