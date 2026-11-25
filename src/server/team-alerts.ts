import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
	ALERT_EVENT_LABELS,
	ALERT_EVENTS,
	ALERT_KINDS,
	type AlertChannelKind,
	type AlertEvent,
} from "../lib/team-alerts";
import { db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { decryptSecret, encryptSecret, organizationOf } from "./org-aws";
import { appLink } from "./org-handles";
import { iso } from "./time";

export { ALERT_EVENT_LABELS, ALERT_EVENTS, ALERT_KINDS, type AlertChannelKind, type AlertEvent };

/**
 * Real-time team notification channels (Slack, Discord, generic JSON webhooks) for
 * Inbox events (new live chat, new inbound email, SLA warnings/breaches, @mentions)
 * and sending reputation alerts. Webhook URLs are encrypted at rest with AES-GCM.
 */

export type AlertChannelRow = typeof schema.orgAlertChannels.$inferSelect;

const channelInput = z.object({
	id: z.string().optional(),
	kind: z.enum(ALERT_KINDS).optional(),
	name: z.string().trim().min(1, "name: give the channel a name").max(80),
	webhook_url: z.string().trim().max(2000).optional(),
	events: z.array(z.enum(ALERT_EVENTS)).min(1, "Pick at least one event").max(20),
	enabled: z.boolean().optional(),
});

function validateWebhookUrl(raw: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw validation("webhook_url: enter a valid https:// webhook URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
		throw validation("webhook_url: must use https://");
	const host = parsed.hostname.toLowerCase();
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host === "0.0.0.0" ||
		host.endsWith(".local") ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host)
	)
		throw validation("webhook_url: private or local addresses are not allowed");
	return parsed;
}

export function detectAlertKind(url: string): AlertChannelKind {
	const lower = url.toLowerCase();
	if (lower.includes("hooks.slack.com") || lower.includes("hooks.slack-gov.com")) return "slack";
	if (lower.includes("discord.com/api/webhooks") || lower.includes("discordapp.com/api/webhooks"))
		return "discord";
	return "webhook";
}

function maskUrl(parsed: URL): string {
	const tail = parsed.pathname.slice(-6);
	return `${parsed.host}/…${tail}`;
}

export function alertChannelView(row: AlertChannelRow) {
	return {
		id: row.id,
		kind: row.kind as AlertChannelKind,
		name: row.name,
		url_hint: row.url_hint,
		events: (row.events ?? []) as AlertEvent[],
		enabled: row.enabled,
		last_sent_at: row.last_sent_at,
		last_error: row.last_error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function listAlertChannels(organizationId: string) {
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.orgAlertChannels)
		.where(eq(schema.orgAlertChannels.organization_id, org))
		.orderBy(desc(schema.orgAlertChannels.created_at));
	return rows.map(alertChannelView);
}

export async function saveAlertChannel(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = channelInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const existing = v.id
		? await db
				.select()
				.from(schema.orgAlertChannels)
				.where(
					and(
						eq(schema.orgAlertChannels.id, v.id),
						eq(schema.orgAlertChannels.organization_id, org),
					),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("Alert channel");

	let encrypted = existing?.webhook_url_encrypted ?? "";
	let hint = existing?.url_hint ?? "";
	let kind: AlertChannelKind = v.kind ?? (existing?.kind as AlertChannelKind) ?? "slack";

	if (v.webhook_url) {
		const parsed = validateWebhookUrl(v.webhook_url);
		encrypted = await encryptSecret(parsed.toString());
		hint = maskUrl(parsed);
		if (!v.kind) kind = detectAlertKind(parsed.toString());
	} else if (!existing) {
		throw validation("webhook_url: paste a Slack, Discord or webhook URL");
	}

	const row = {
		id: existing?.id ?? `alc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: org,
		kind,
		name: v.name,
		webhook_url_encrypted: encrypted,
		url_hint: hint,
		events: [...new Set(v.events)],
		enabled: v.enabled ?? existing?.enabled ?? true,
		last_sent_at: existing?.last_sent_at ?? null,
		last_error: v.webhook_url ? null : (existing?.last_error ?? null),
		created_by: existing?.created_by ?? userId,
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};

	if (existing) {
		await db
			.update(schema.orgAlertChannels)
			.set(row)
			.where(eq(schema.orgAlertChannels.id, existing.id));
	} else {
		await db.insert(schema.orgAlertChannels).values(row);
	}
	return alertChannelView(row);
}

export async function deleteAlertChannel(organizationId: string, id: string) {
	const org = await organizationOf(organizationId);
	const [removed] = await db
		.delete(schema.orgAlertChannels)
		.where(
			and(
				eq(schema.orgAlertChannels.id, id),
				eq(schema.orgAlertChannels.organization_id, org),
			),
		)
		.returning({ id: schema.orgAlertChannels.id });
	if (!removed) throw notFound("Alert channel");
	return { deleted: true, id: removed.id };
}

// ── Payload formatting & delivery ────────────────────────────────────────────

export interface TeamAlertPayload {
	title: string;
	body?: string;
	/** Relative app path (e.g. "/received/conv_123") or full URL. */
	path?: string;
	fields?: { label: string; value: string }[];
	severity?: "info" | "warning" | "danger";
}

export function formatChannelPayload(
	kind: AlertChannelKind,
	event: AlertEvent,
	payload: TeamAlertPayload,
	link: string | null,
) {
	const colorHex =
		payload.severity === "danger"
			? "#dc2626"
			: payload.severity === "warning"
				? "#d97706"
				: "#2563eb";
	const colorInt = Number.parseInt(colorHex.slice(1), 16);

	if (kind === "slack") {
		const blocks: Record<string, unknown>[] = [
			{
				type: "header",
				text: { type: "plain_text", text: payload.title.slice(0, 150), emoji: true },
			},
		];
		if (payload.body) {
			blocks.push({
				type: "section",
				text: { type: "mrkdwn", text: payload.body.slice(0, 2800) },
			});
		}
		if (payload.fields?.length) {
			blocks.push({
				type: "section",
				fields: payload.fields.slice(0, 10).map((f) => ({
					type: "mrkdwn",
					text: `*${f.label}*\n${f.value}`,
				})),
			});
		}
		if (link) {
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Open in Mailroom" },
						url: link,
					},
				],
			});
		}
		return {
			text: `${payload.title}${payload.body ? ` — ${payload.body.slice(0, 200)}` : ""}`,
			blocks,
		};
	}

	if (kind === "discord") {
		return {
			embeds: [
				{
					title: payload.title.slice(0, 250),
					description: payload.body?.slice(0, 3500),
					url: link ?? undefined,
					color: colorInt,
					fields: payload.fields?.slice(0, 10).map((f) => ({
						name: f.label.slice(0, 200),
						value: f.value.slice(0, 1000),
						inline: true,
					})),
					footer: { text: `Mailroom · ${ALERT_EVENT_LABELS[event] ?? event}` },
					timestamp: new Date().toISOString(),
				},
			],
		};
	}

	return {
		event,
		title: payload.title,
		body: payload.body ?? null,
		fields: payload.fields ?? [],
		severity: payload.severity ?? "info",
		url: link,
		at: new Date().toISOString(),
	};
}

async function sendToChannel(
	row: AlertChannelRow,
	event: AlertEvent,
	payload: TeamAlertPayload,
	link: string | null,
	now = Date.now(),
) {
	const url = await decryptSecret(row.webhook_url_encrypted);
	const body = formatChannelPayload(row.kind as AlertChannelKind, event, payload, link);
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", "user-agent": "Mailroom-Alerts/1.0" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const msg = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`;
		await db
			.update(schema.orgAlertChannels)
			.set({ last_error: msg, updated_at: iso(now) })
			.where(eq(schema.orgAlertChannels.id, row.id));
		throw new Error(msg);
	}
	await db
		.update(schema.orgAlertChannels)
		.set({ last_sent_at: iso(now), last_error: null, updated_at: iso(now) })
		.where(eq(schema.orgAlertChannels.id, row.id));
}

export async function testAlertChannel(organizationId: string, id: string, now = Date.now()) {
	const org = await organizationOf(organizationId);
	const row = await db
		.select()
		.from(schema.orgAlertChannels)
		.where(
			and(
				eq(schema.orgAlertChannels.id, id),
				eq(schema.orgAlertChannels.organization_id, org),
			),
		)
		.get();
	if (!row) throw notFound("Alert channel");
	const link = await appLink(org, "/received").catch(() => null);
	try {
		await sendToChannel(
			row,
			"chat.started",
			{
				title: "Mailroom test notification",
				body: `Connected to *${row.name}*. You'll get alerts here for ${(row.events ?? []).map((e) => ALERT_EVENT_LABELS[e as AlertEvent] ?? e).join(", ")}.`,
				severity: "info",
			},
			link,
			now,
		);
		return { ok: true };
	} catch (error) {
		throw new ApiError(
			502,
			"alert_delivery_failed",
			error instanceof Error ? error.message : "Could not reach the webhook",
		);
	}
}

/**
 * Best-effort fanout to all enabled org alert channels subscribed to `event`.
 * Never throws so callers (inbound email, live chat, SLA cron, sending alerts) are never blocked.
 */
export async function dispatchTeamAlert(
	brandOrOrgId: string,
	event: AlertEvent,
	payload: TeamAlertPayload,
	now = Date.now(),
) {
	try {
		const org = await organizationOf(brandOrOrgId);
		const channels = await db
			.select()
			.from(schema.orgAlertChannels)
			.where(
				and(
					eq(schema.orgAlertChannels.organization_id, org),
					eq(schema.orgAlertChannels.enabled, true),
				),
			);
		const matching = channels.filter((ch) => (ch.events ?? []).includes(event));
		if (!matching.length) return 0;
		const link = payload.path
			? /^https?:\/\//.test(payload.path)
				? payload.path
				: await appLink(brandOrOrgId, payload.path).catch(() => null)
			: null;
		let sent = 0;
		await Promise.allSettled(
			matching.map(async (ch) => {
				try {
					await sendToChannel(ch, event, payload, link, now);
					sent++;
				} catch (err) {
					console.error("team-alerts: delivery failed", ch.id, err);
				}
			}),
		);
		return sent;
	} catch {
		return 0;
	}
}
