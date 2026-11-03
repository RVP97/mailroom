import { createServerFn } from "@tanstack/react-start";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { EMAIL_FILTERS } from "@/lib/email-status";
import { maskDigits } from "@/lib/roles";
import { viewScope } from "@/server/brands";
import { db, schema } from "@/server/db";
import { kickDispatcher, rateGate } from "@/server/dispatcher";
import { ApiError } from "@/server/errors";
import { can, orgMiddleware } from "@/server/middleware";
import {
	dailyStats,
	emailEvents,
	getEmail,
	inScope,
	listEmails,
	recentTags,
	statsByDomain,
	statsByOrganization,
	statsByProvider,
	summarizeEmails,
} from "@/server/queries";
import { requestOfEmail } from "@/server/request-logs";
import {
	brandForSend,
	createEmails,
	inlineImagesOf,
	parseSend,
	storedContent,
} from "@/server/send";
import { iso } from "@/server/time";

const asResponse = (error: unknown): never => {
	if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
	throw error;
};

/**
 * An organization with several brands sees them all: every brand's emails added up, plus each
 * one's numbers. `brand` narrows it to one of them.
 */
const scopeInput = { brand: z.string().nullish() };

/** The Emails list's filters (Overview's charts link to them). */
const filterInput = {
	status: z.enum(EMAIL_FILTERS).nullish(),
	search: z.string().max(200).nullish(),
	key: z.string().nullish(),
	/** A tag, "name:value" (or "name" for any value). */
	tag: z.string().max(300).nullish(),
	/** Made from this template (Insights links here). */
	template: z.string().max(100).nullish(),
	days: z.number().int().min(1).max(365).nullish(),
	day: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullish(),
	domain: z.string().max(253).nullish(),
	provider: z.enum(["gmail", "outlook", "yahoo", "icloud", "other"]).nullish(),
	...scopeInput,
};

export const getOverview = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			days: z.number().int().min(1).max(90).default(30),
			/** One sending domain; without it, all of them. */
			domain: z.string().max(253).nullish(),
			...scopeInput,
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const own = typeof scope === "string" ? scope : context.organizationId;
		const now = Date.now();
		const domain = data.domain?.toLowerCase() || null;
		const [stats, previous, week, sending, byBrand, byProvider, byDomain] = await Promise.all([
			dailyStats(scope, data.days, now, { domain }),
			dailyStats(scope, data.days, now, { domain, offset: data.days }),
			dailyStats(scope, 7, now, { domain }),
			db
				.select()
				.from(schema.orgSending)
				.where(eq(schema.orgSending.organization_id, own))
				.get(),
			typeof scope === "string" ? [] : statsByOrganization(data.days, now, scope),
			statsByProvider(scope, data.days, now),
			statsByDomain(scope, data.days, now),
		]);
		const domains = await db
			.select({
				id: schema.domains.id,
				name: schema.domains.name,
				status: schema.domains.status,
			})
			.from(schema.domains)
			.where(inScope(schema.domains.organization_id, scope));
		const counted = new Map(byBrand.map((r) => [r.organization_id, r]));
		return {
			...stats,
			/** The same length of time just before, for the changes. */
			previous: previous.totals,
			previousSeries: previous.series,
			week: { totals: week.totals, health: week.health },
			sending: sending ?? null,
			domains,
			domain,
			/** Gmail, Outlook, Yahoo, iCloud and the rest, busiest first. */
			byProvider,
			/** Each sending domain's numbers over the range, busiest first. */
			byDomain,
			/** The brands to pick from (empty with only one), and whose numbers these are. */
			brands,
			brand: typeof scope === "string" && brands.length ? scope : null,
			/** With every brand shown: each one's numbers over the range, busiest first. */
			byBrand: (typeof scope === "string" ? [] : brands)
				.map((o) => {
					const r = counted.get(o.id);
					return {
						id: o.id,
						name: o.name,
						sent: r?.sent ?? 0,
						delivered: r?.delivered ?? 0,
						bounced: r?.bounced ?? 0,
						complained: r?.complained ?? 0,
						bounceRate: r?.bounceRate ?? 0,
						complaintRate: r?.complaintRate ?? 0,
						bounce: r?.bounce ?? "ok",
						complaint: r?.complaint ?? "ok",
					};
				})
				.sort((a, b) => b.sent - a.sent || a.name.localeCompare(b.name)),
		};
	});

/** What the timeline reads from an event (SES puts strings, numbers and nested objects there). */
// biome-ignore lint/suspicious/noExplicitAny: SES event payloads are arbitrary JSON
export type EventData = Record<string, any>;

export const listEmailsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			...filterInput,
			after: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		// A drill-down from Overview (a day, domain or provider) says how many of each it holds.
		const summary =
			(data.day || data.domain || data.provider) && !data.after
				? summarizeEmails(scope, { ...data, status: null, apiKeyId: data.key })
				: Promise.resolve(null);
		const [page, keys, tags, template] = await Promise.all([
			listEmails(scope, { ...data, apiKeyId: data.key, limit: 50 }).then((p) =>
				context.masked
					? { ...p, data: p.data.map((e) => ({ ...e, subject: maskDigits(e.subject) })) }
					: p,
			),
			db
				.select({ id: schema.apiKeys.id, name: schema.apiKeys.name })
				.from(schema.apiKeys)
				.where(eq(schema.apiKeys.organization_id, context.organizationId)),
			data.after ? Promise.resolve([]) : recentTags(scope),
			data.template
				? db
						.select({ name: schema.templates.name })
						.from(schema.templates)
						.where(
							and(
								eq(schema.templates.id, data.template),
								inScope(schema.templates.organization_id, scope),
							),
						)
						.get()
				: Promise.resolve(undefined),
		]);
		return {
			...page,
			keys,
			tags,
			brands,
			summary: await summary,
			/** The template filter's name, for its chip. */
			templateName: data.template ? (template?.name ?? "Deleted template") : null,
		};
	});

/** The emails a filter finds (up to 5,000), for a CSV. */
export const exportEmailsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object(filterInput))
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const page = await listEmails(scope, { ...data, apiKeyId: data.key, limit: 5000 }, 5000);
		return { ...page, brands };
	});

export const getEmailFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId);
		const email = await getEmail(scope, data.id);
		if (!email) throw new Response("Email not found", { status: 404 });
		const own = email.organization_id === context.organizationId;
		const [stored, events, key, log, replies] = await Promise.all([
			storedContent(email.id),
			emailEvents(email.id),
			email.api_key_id
				? db
						.select({
							name: schema.apiKeys.name,
							permission: schema.apiKeys.permission,
						})
						.from(schema.apiKeys)
						.where(
							and(
								eq(schema.apiKeys.id, email.api_key_id),
								eq(schema.apiKeys.organization_id, context.organizationId),
							),
						)
						.get()
				: null,
			// The Logs page is the organization's own, so a platform viewing its group's email
			// gets no link to it.
			own && email.source === "api"
				? requestOfEmail(email.organization_id, email.id, email.created_at)
				: null,
			// Answers to it that came back (their In-Reply-To is its Message-ID).
			db
				.select({
					id: schema.receivedEmails.id,
					from: schema.receivedEmails.from,
					subject: schema.receivedEmails.subject,
					created_at: schema.receivedEmails.created_at,
				})
				.from(schema.receivedEmails)
				.where(eq(schema.receivedEmails.answers_email_id, email.id))
				.limit(20),
		]);
		const { idempotency_key: _k, request_hash: _h, locked_until: _l, ...rest } = email;
		// Viewer and Support see codes and card numbers as dots (in the HTML, only its text).
		const dots = context.masked;
		const html = stored?.content.html ?? null;
		const text = stored?.content.text ?? null;
		return {
			email: dots ? { ...rest, subject: maskDigits(rest.subject) } : rest,
			html:
				dots && html
					? html.replace(/>([^<]+)</g, (_, t: string) => `>${maskDigits(t)}<`)
					: html,
			text: dots && text ? maskDigits(text) : text,
			headers: stored?.content.headers ?? null,
			attachments: stored?.attachments ?? [],
			inline: await inlineImagesOf(email.organization_id, stored?.attachments ?? []),
			/** The brand it's from, when the organization has several. */
			brand: brands.find((o) => o.id === email.organization_id) ?? null,
			apiKey: key ?? null,
			/** The API call that created it, when its log is still kept. */
			log,
			replies: replies.map((r) => ({
				...r,
				subject: dots ? maskDigits(r.subject) : r.subject,
			})),
			events: events.map((e) => ({
				id: e.id,
				type: e.type,
				at: e.at,
				recipient: e.recipient,
				data: e.data as EventData | null,
			})),
		};
	});

/** «Send test email» from the dashboard: one email to anyone, so only for those who may send. */
export const sendEmailFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:send")])
	.validator(
		z.object({
			from: z.string(),
			to: z.string(),
			subject: z.string(),
			html: z.string().optional(),
			text: z.string().optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		try {
			const input = parseSend({ ...data, to: data.to.split(/[,;\s]+/).filter(Boolean) });
			const brand = await brandForSend(context.organizationId, [input]);
			const [r] = await createEmails(brand, [input], {
				source: "dashboard",
				kick: kickDispatcher,
				gate: rateGate,
			});
			if (r?.error) throw r.error;
			return { id: r?.id ?? null, status: r?.status ?? null };
		} catch (error) {
			return asResponse(error);
		}
	});

export const cancelEmailFn = createServerFn({ method: "POST" })
	.middleware([can("broadcasts:send")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const [row] = await db
			.update(schema.emails)
			.set({
				status: "canceled",
				send_at: null,
				last_event: "canceled",
				last_event_at: iso(),
			})
			.where(
				and(
					eq(schema.emails.id, data.id),
					inScope(schema.emails.organization_id, { org: context.organizationId }),
					eq(schema.emails.status, "scheduled"),
				),
			)
			.returning({ id: schema.emails.id });
		if (!row) throw new Response("Only a scheduled email can be canceled", { status: 409 });
		return { ok: true };
	});
