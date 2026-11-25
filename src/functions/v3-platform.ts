import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	addKnowledgeSource,
	deleteAiAction,
	deleteKnowledgeSource,
	listAiActions,
	listKnowledgeSources,
	saveAiAction,
} from "@/server/ai-knowledge";
import { can, orgMiddleware } from "@/server/middleware";
import {
	listOmnichannelSettings,
	saveTelegramSettings,
	saveWhatsAppSettings,
} from "@/server/omnichannel";
import {
	COMPONENT_STATUSES,
	createStatusIncident,
	deleteStatusComponent,
	getStatusPageData,
	INCIDENT_IMPACTS,
	INCIDENT_STATUSES,
	postIncidentUpdate,
	savePublicPagesSettings,
	saveStatusComponent,
} from "@/server/status-page";
import { saveDomainWarmup } from "@/server/warmup";
import { call } from "./call";

// ── Omnichannel (WhatsApp & Telegram) ────────────────────────────────────────

export const listOmnichannelFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) => call(() => listOmnichannelSettings(context.organizationId)));

export const saveWhatsAppFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			phone_number_id: z.string().min(4).max(80),
			verify_token: z.string().min(4).max(200).optional(),
			app_secret: z.string().min(6).max(300).optional(),
			access_token: z.string().min(10).max(1000).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveWhatsAppSettings(context.organizationId, data, context.userId)),
	);

export const saveTelegramFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			bot_username: z.string().max(80).optional(),
			bot_token: z.string().min(10).max(300).optional(),
			secret_token: z.string().min(6).max(256).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => saveTelegramSettings(context.organizationId, data, context.userId)),
	);

// ── AI Knowledge Sources & Custom HTTP Actions ───────────────────────────────

export const listAiAgentExtrasFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) =>
		call(async () => {
			const [sources, actions] = await Promise.all([
				listKnowledgeSources(context.organizationId),
				listAiActions(context.organizationId),
			]);
			return { sources, actions };
		}),
	);

export const addKnowledgeSourceFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			kind: z.enum(["url", "sitemap", "markdown"]),
			title: z.string().min(1).max(160),
			url: z.string().url().max(1000).optional(),
			content: z.string().max(200_000).optional(),
		}),
	)
	.handler(({ data, context }) => call(() => addKnowledgeSource(context.organizationId, data)));

export const deleteKnowledgeSourceFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(() => deleteKnowledgeSource(context.organizationId, data.id)),
	);

export const saveAiActionFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			id: z.string().optional(),
			name: z.string().min(2).max(48),
			description: z.string().min(4).max(300),
			method: z.enum(["GET", "POST"]).default("GET"),
			url: z.string().url().max(1000),
			headers: z.record(z.string(), z.string()).optional(),
			body_template: z.string().max(8000).nullable().optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) => call(() => saveAiAction(context.organizationId, data)));

export const deleteAiActionFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) => call(() => deleteAiAction(context.organizationId, data.id)));

// ── Status Page & Outage Banners ─────────────────────────────────────────────

export const getStatusPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(({ context }) => call(() => getStatusPageData(context.organizationId)));

export const savePublicPagesFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			status_page_enabled: z.boolean().optional(),
			portal_enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => savePublicPagesSettings(context.organizationId, data)),
	);

export const saveStatusComponentFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			id: z.string().optional(),
			name: z.string().min(1).max(80),
			description: z.string().max(240).nullable().optional(),
			status: z.enum(COMPONENT_STATUSES).default("operational"),
			position: z.number().int().min(0).max(1000).optional(),
		}),
	)
	.handler(({ data, context }) => call(() => saveStatusComponent(context.organizationId, data)));

export const deleteStatusComponentFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(() => deleteStatusComponent(context.organizationId, data.id)),
	);

export const createStatusIncidentFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			title: z.string().min(2).max(160),
			impact: z.enum(INCIDENT_IMPACTS).default("minor"),
			status: z.enum(INCIDENT_STATUSES).default("investigating"),
			message: z.string().min(2).max(4000),
			component_ids: z.array(z.string()).max(20).optional(),
			component_status: z.enum(COMPONENT_STATUSES).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => createStatusIncident(context.organizationId, data, context.userId)),
	);

export const postIncidentUpdateFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			incident_id: z.string().min(1),
			status: z.enum(INCIDENT_STATUSES),
			message: z.string().min(2).max(4000),
			component_status: z.enum(COMPONENT_STATUSES).optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(() => postIncidentUpdate(context.organizationId, data, context.userId)),
	);

// ── Automated Domain Warm-Up Ramp ────────────────────────────────────────────

export const saveDomainWarmupFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			domain_id: z.string().min(1),
			enabled: z.boolean(),
			start_date: z
				.string()
				.regex(/^\d{4}-\d{2}-\d{2}$/)
				.optional(),
			daily_start: z.number().int().min(10).max(50_000).default(100),
			daily_max: z.number().int().min(50).max(5_000_000).default(25_000),
			ramp_days: z.number().int().min(3).max(90).default(14),
			pause_bounce_rate: z.number().min(0.005).max(0.2).default(0.03),
		}),
	)
	.handler(({ data, context }) =>
		call(() => {
			const { domain_id, ...rest } = data;
			return saveDomainWarmup(context.organizationId, domain_id, rest);
		}),
	);
