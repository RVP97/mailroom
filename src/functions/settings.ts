import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { findBimi } from "@/lib/bimi";
import { explainBounce } from "@/lib/bounces";
import { findDmarc, txtRecords } from "@/lib/dmarc";
import { maskDigits } from "@/lib/roles";
import { logAccess } from "@/server/access-log";
import { createKey, deleteKey } from "@/server/api-keys";
import { brandIds, brandIn, viewScope } from "@/server/brands";
import { db, schema } from "@/server/db";
import { sendsReportsHere, withReportsAddress } from "@/server/dmarc-address";
import { dmarcSummary } from "@/server/dmarc-reports";
import { dnsHelp } from "@/server/domain-connect";
import { baseUrl } from "@/server/env";
import { ApiError } from "@/server/errors";
import { can, orgMiddleware } from "@/server/middleware";
import { setOrgLogo, setOrgLogoBackground } from "@/server/org-logos";
import { postmasterTokens } from "@/server/postmaster";
import {
	addDomain,
	dnsRecords,
	refreshTenantStatus,
	removeDomain,
	setBimiLogo,
	setDomainPaused,
	setDomainPurpose,
	setDomainSending,
	setUpOrganization,
	verifyDomain,
} from "@/server/provision";
import {
	emailEvents,
	getEmail,
	inScope,
	listEmails,
	listSuppressions,
	SUPPRESSION_REASONS,
	suppressionCounts,
	suppressionsOf,
} from "@/server/queries";
import { createSmtpCredentials, deleteSmtpCredentials, smtpCredentials } from "@/server/smtp";
import { addSuppression, removeSuppression } from "@/server/suppressions";
import {
	addTrackingHost,
	checkTrackingHost,
	customTrackingConfigured,
	ownTracking,
	removeTrackingHost,
	setTracking,
	trackingTarget,
} from "@/server/tracking";
import { listUnsubscribes, resubscribe, unsubscribeGroups } from "@/server/unsubscribes";
import { createWebhook, deleteWebhook, updateWebhook } from "@/server/webhook-admin";
import { replayDelivery, replayFailed, sendTestEvent, WEBHOOK_EVENTS } from "@/server/webhooks";
import type { EventData } from "./emails";

/** Domains, API keys, webhooks, suppressions and each brand's SES setup. */

/** The brand a dashboard call names (one of the organization's), or the organization's own. */
const brandOr = (organizationId: string, brand?: string | null) =>
	brand ? apiCall(() => brandIn(organizationId, brand)) : Promise.resolve(organizationId);

/** The brand a domain is in, when it's one of the organization's brands. */
async function domainBrand(organizationId: string, id: string) {
	const d = await db
		.select({ brand: schema.domains.organization_id })
		.from(schema.domains)
		.where(eq(schema.domains.id, id))
		.get();
	if (!d || !(await brandIds(organizationId)).includes(d.brand))
		throw new Response("Domain not found", { status: 404 });
	return d.brand;
}

async function apiCall<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ApiError) throw new Response(error.message, { status: error.status });
		if (error instanceof z.ZodError)
			throw new Response(error.issues[0]?.message ?? "Invalid", { status: 422 });
		throw error;
	}
}

// ── Domains ──

export const listDomainsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ brand: z.string().nullish() }).default({}))
	.handler(async ({ data, context }) => {
		const { scope } = await viewScope(context.organizationId, data.brand);
		const rows = await db
			.select()
			.from(schema.domains)
			.where(inScope(schema.domains.organization_id, scope))
			.orderBy(desc(schema.domains.created_at));
		const tokens = await postmasterTokens(rows.map((r) => r.id));
		// The logo itself stays out of the list: the page shows it from its public URL.
		return rows.map(({ bimi_logo, ...d }) => {
			const token = tokens.get(d.id);
			return {
				...d,
				has_logo: !!bimi_logo,
				records: [
					...dnsRecords({ ...d, bimi_logo }),
					// Gmail Postmaster Tools checks this TXT record (src/server/postmaster.ts).
					...(token
						? [
								{
									record: "Gmail" as const,
									type: "TXT" as const,
									name: d.name,
									value: `"${token}"`,
									status: "PENDING",
									optional: true,
								},
							]
						: []),
				],
			};
		});
	});

/** The DMARC record that covers a domain (Mailroom looks it up itself: SES doesn't check it). */
export const dmarcFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ name: z.string().max(253) }))
	.handler(({ data }) => findDmarc(data.name, txtRecords));

/** The BIMI record that covers a domain, looked up in DNS. */
export const bimiFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ name: z.string().max(253) }))
	.handler(({ data }) => findBimi(data.name, txtRecords));

/**
 * The domain's DNS host (name, logo, DNS page) and, when the host runs Domain Connect with
 * Mailroom's template, a one-click link that adds what it still needs. Best effort: null parts
 * when DNS doesn't answer.
 */
/**
 * What providers' DMARC reports say about mail From a domain (last 30 days), and whether its
 * record sends them to Mailroom yet, with the record to set if not.
 */
export const dmarcReportsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const brand = await domainBrand(context.organizationId, data.id);
		const d = await db
			.select({ name: schema.domains.name })
			.from(schema.domains)
			.where(and(eq(schema.domains.id, data.id), eq(schema.domains.organization_id, brand)))
			.get();
		if (!d) throw new Response("Domain not found", { status: 404 });
		const [summary, dmarc] = await Promise.all([
			dmarcSummary(d.name),
			findDmarc(d.name, txtRecords).catch(() => null),
		]);
		// An inherited record is the parent's: the subdomain gets its own, with the address.
		const own = dmarc?.found && !dmarc.inherited ? dmarc.record : null;
		return {
			...summary,
			receiving: sendsReportsHere(dmarc?.record),
			// Without its own record, the one to add is already in the DNS records above.
			own: !!own,
			inheritedFrom: dmarc?.found && dmarc.inherited ? dmarc.at : null,
			record: {
				name: `_dmarc.${d.name}`,
				value: withReportsAddress(own ?? `v=DMARC1; p=${dmarc?.policy ?? "none"};`),
			},
		};
	});

export const dnsHelpFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const brand = await domainBrand(context.organizationId, data.id);
		const d = await db
			.select()
			.from(schema.domains)
			.where(and(eq(schema.domains.id, data.id), eq(schema.domains.organization_id, brand)))
			.get();
		if (!d) throw new Response("Domain not found", { status: 404 });
		const [dmarc, bimi] = await Promise.all([
			findDmarc(d.name, txtRecords).catch(() => null),
			d.bimi_logo ? findBimi(d.name, txtRecords).catch(() => null) : null,
		]);
		const records = dnsRecords(d);
		const bimiRecord = records.find((r) => r.record === "BIMI");
		return dnsHelp(
			d,
			{
				// Unknown counts as there: never offer to write over a record we couldn't read.
				dmarc: dmarc?.found ?? true,
				// Any BIMI record counts, even one with another logo: Cloudflare would add ours
				// next to it rather than replace it, and two BIMI records break both.
				bimi: !bimiRecord || !bimi || bimi.found,
			},
			`${baseUrl()}/domains/${d.id}?connected=1`,
		);
	});

/** Open and click tracking for a domain, and where its links go. */
export const trackingFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async () => ({
		/** Mailroom tracks opens and clicks itself (else SES still does, on awstrack.me). */
		own: await ownTracking(),
		/** links.<domain> can be turned on (this deployment has Cloudflare for SaaS set up). */
		customHost: customTrackingConfigured(),
		target: trackingTarget(),
		base: baseUrl(),
	}));

export const setTrackingFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({ id: z.string(), open: z.boolean().optional(), click: z.boolean().optional() }),
	)
	.handler(({ data, context }) =>
		apiCall(async () => {
			await setTracking(await domainBrand(context.organizationId, data.id), data.id, data);
			return { ok: true };
		}),
	);

/** Mailroom receives the domain's email (src/server/inbound.ts). */
export const setDomainReceivingFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			id: z.string(),
			on: z.boolean(),
			replaceMx: z.boolean().optional(),
			prefix: z.string().optional(),
		}),
	)
	.handler(({ data, context }) =>
		apiCall(async () => {
			const { setDomainReceiving } = await import("@/server/inbound");
			const d = await setDomainReceiving(
				await domainBrand(context.organizationId, data.id),
				data.id,
				data.on,
				{ replaceMx: data.replaceMx, prefix: data.prefix },
			);
			return { receiving: d.receiving, status: d.receiving_status, host: d.receiving_host };
		}),
	);

export const trackingHostFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			id: z.string(),
			action: z.enum(["add", "check", "remove"]),
			prefix: z.string().max(32).optional(),
		}),
	)
	.handler(({ data, context }) =>
		apiCall(async () => {
			if (data.action === "remove") {
				await removeTrackingHost(
					await domainBrand(context.organizationId, data.id),
					data.id,
				);
				return { status: null };
			}
			const d =
				data.action === "add"
					? await addTrackingHost(
							await domainBrand(context.organizationId, data.id),
							data.id,
							data.prefix,
						)
					: await checkTrackingHost(
							await domainBrand(context.organizationId, data.id),
							data.id,
						);
			return { status: d.tracking_status };
		}),
	);

/** Sets a domain's brand logo (an SVG's text), or removes it with null. */
export const setBimiLogoFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			id: z.string(),
			svg: z
				.string()
				.max(512 * 1024)
				.nullable(),
		}),
	)
	.handler(({ data, context }) =>
		apiCall(async () => {
			await setBimiLogo(
				await domainBrand(context.organizationId, data.id),
				data.id,
				data.svg,
			);
			return { ok: true };
		}),
	);

/** Sets the organization's own logo (a data: URL of a small square image), or removes it. */
export const setOrgLogoFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(
		z.object({
			image: z
				.string()
				.max(300 * 1024)
				.nullable(),
		}),
	)
	.handler(({ data, context }) =>
		apiCall(async () => ({ url: await setOrgLogo(context.organizationId, data.image) })),
	);

/** Sets what shows behind the organization's logo: "white", "black", "#rrggbb" or null. */
export const setOrgLogoBackgroundFn = createServerFn({ method: "POST" })
	.middleware([can("settings:manage")])
	.validator(z.object({ background: z.string().max(20).nullable() }))
	.handler(({ data, context }) =>
		apiCall(async () => ({
			background: await setOrgLogoBackground(context.organizationId, data.background),
		})),
	);

export const addDomainFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			name: z.string(),
			brand: z.string().nullish(),
			purpose: z.enum(["transactional", "marketing"]).default("transactional"),
			sending: z.boolean().default(true),
			receiving: z.boolean().default(false),
			replaceMx: z.boolean().optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		const brand = await brandOr(context.organizationId, data.brand);
		return apiCall(async () => ({
			id: (
				await addDomain(brand, data.name, data.purpose, {
					sending: data.sending,
					receiving: data.receiving,
					replaceMx: data.replaceMx,
				})
			).id,
		}));
	});

/** Transactional or Marketing, and paused or not. */
export const updateDomainFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(
		z.object({
			id: z.string(),
			purpose: z.enum(["transactional", "marketing"]).optional(),
			paused: z.boolean().optional(),
			sending: z.boolean().optional(),
		}),
	)
	.handler(async ({ data, context }) => {
		const brand = await domainBrand(context.organizationId, data.id);
		return apiCall(async () => {
			if (data.purpose) await setDomainPurpose(brand, data.id, data.purpose);
			if (data.paused !== undefined)
				await setDomainPaused(brand, data.id, data.paused, "you", Date.now(), {
					isAdmin: context.isAdmin,
				});
			if (data.sending !== undefined) await setDomainSending(brand, data.id, data.sending);
			return { ok: true };
		});
	});

export const verifyDomainFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		apiCall(async () => {
			const d = await verifyDomain(
				await domainBrand(context.organizationId, data.id),
				data.id,
			);
			// The tracking host's CNAME is checked at Cloudflare, not SES.
			if (
				d.tracking_hostname_id &&
				d.tracking_status !== "active" &&
				customTrackingConfigured()
			)
				await checkTrackingHost(
					await domainBrand(context.organizationId, data.id),
					data.id,
				).catch(() => null);
			return { status: d.status };
		}),
	);

export const removeDomainFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		apiCall(async () => {
			await removeDomain(await domainBrand(context.organizationId, data.id), data.id);
			return { ok: true };
		}),
	);

// ── API keys ──

export const listKeysFn = createServerFn({ method: "GET" })
	.middleware([can("developers:keys")])
	.handler(({ context }) =>
		db
			.select({
				id: schema.apiKeys.id,
				name: schema.apiKeys.name,
				start: schema.apiKeys.start,
				permission: schema.apiKeys.permission,
				domain_id: schema.apiKeys.domain_id,
				created_at: schema.apiKeys.created_at,
				last_used_at: schema.apiKeys.last_used_at,
			})
			.from(schema.apiKeys)
			.where(eq(schema.apiKeys.organization_id, context.organizationId))
			.orderBy(desc(schema.apiKeys.created_at)),
	);

export const createKeyFn = createServerFn({ method: "POST" })
	.middleware([can("developers:keys")])
	.validator(
		z.object({
			name: z.string().min(1).max(100),
			permission: z.enum(["full", "sending"]),
			domainId: z.string().nullish(),
		}),
	)
	.handler(({ data, context }) =>
		createKey({
			organizationId: context.organizationId,
			name: data.name,
			permission: data.permission,
			domainId: data.domainId,
			createdBy: context.userId,
		}),
	);

export const deleteKeyFn = createServerFn({ method: "POST" })
	.middleware([can("developers:keys")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => ({
		ok: await deleteKey(context.organizationId, data.id),
	}));

// ── Webhooks ──

export const listWebhooksFn = createServerFn({ method: "GET" })
	.middleware([can("developers:webhooks")])
	.handler(async ({ context }) => {
		const hooks = await db
			.select()
			.from(schema.webhooks)
			.where(eq(schema.webhooks.organization_id, context.organizationId))
			.orderBy(desc(schema.webhooks.created_at));
		return { hooks, events: WEBHOOK_EVENTS };
	});

export const webhookDeliveriesFn = createServerFn({ method: "GET" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		db
			.select()
			.from(schema.webhookDeliveries)
			.where(
				and(
					eq(schema.webhookDeliveries.webhook_id, data.id),
					eq(schema.webhookDeliveries.organization_id, context.organizationId),
				),
			)
			.orderBy(desc(schema.webhookDeliveries.created_at))
			.limit(100),
	);

export const createWebhookFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ url: z.string(), events: z.array(z.string()) }))
	.handler(({ data, context }) => apiCall(() => createWebhook(context.organizationId, data)));

export const updateWebhookFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(
		z.object({
			id: z.string(),
			url: z.string().optional(),
			events: z.array(z.string()).optional(),
			enabled: z.boolean().optional(),
		}),
	)
	.handler(({ data: { id, ...rest }, context }) =>
		apiCall(() => updateWebhook(context.organizationId, id, rest)),
	);

export const deleteWebhookFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		apiCall(async () => {
			await deleteWebhook(context.organizationId, data.id);
			return { ok: true };
		}),
	);

export const testWebhookFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => ({
		ok: await sendTestEvent(context.organizationId, data.id),
	}));

/** Every delivery given up in the last 7 days, sent again (by the cron, oldest first). */
export const replayFailedFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => ({
		replayed: await replayFailed(context.organizationId, data.id),
	}));

export const replayDeliveryFn = createServerFn({ method: "POST" })
	.middleware([can("developers:webhooks")])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => ({
		ok: await replayDelivery(context.organizationId, data.id),
	}));

// ── Suppressions ──

export const listSuppressionsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			search: z.string().nullish(),
			reason: z.enum(SUPPRESSION_REASONS).nullish(),
			offset: z.number().int().min(0).default(0),
			brand: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const [page, counts] = await Promise.all([
			listSuppressions(scope, {
				search: data.search,
				reason: data.reason,
				offset: data.offset,
				limit: 100,
			}),
			suppressionCounts(scope),
		]);
		return { ...page, counts, brands };
	});

/** Every suppressed address (up to 10,000), for a CSV. */
export const exportSuppressionsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({ reason: z.enum(SUPPRESSION_REASONS).nullish(), brand: z.string().nullish() }),
	)
	.handler(async ({ data, context }) => {
		const { scope } = await viewScope(context.organizationId, data.brand);
		return listSuppressions(scope, { reason: data.reason, limit: 10_000 });
	});

export const addSuppressionFn = createServerFn({ method: "POST" })
	.middleware([can("recipients:block")])
	.validator(z.object({ address: z.string(), brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		// Without a brand: every brand never sends to it.
		const ids = data.brand
			? [await brandOr(context.organizationId, data.brand)]
			: await brandIds(context.organizationId);
		return apiCall(async () => {
			for (const id of ids) await addSuppression(id, data.address, "Added in the dashboard");
			return { ok: true };
		});
	});

/** Off the list of one brand (`brand`) or of every brand; Support can do it too. Logged. */
export const removeSuppressionFn = createServerFn({ method: "POST" })
	.middleware([can("recipients:unblock")])
	.validator(z.object({ address: z.string(), brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const ids = data.brand
			? [await brandOr(context.organizationId, data.brand)]
			: await brandIds(context.organizationId);
		for (const id of ids) await removeSuppression(id, data.address);
		await logAccess({
			organizationId: context.organizationId,
			action: "suppression_removed",
			subject: data.address,
			channel: "dashboard",
			userId: context.userId,
			actor: context.email,
		});
		return { ok: true };
	});

/**
 * One address on the list (`brand` picks whose, else the newest), with what put it there: the
 * email, SES's bounce or complaint, the other brands that skip it too and what was sent to it.
 * Null when nobody in the organization suppresses it.
 */
export const getSuppressionFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ address: z.string().max(320), brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId);
		const all = await suppressionsOf(scope, data.address);
		const s = data.brand ? all.find((r) => r.organization_id === data.brand) : all[0];
		if (!s) return null;
		const [email, events, sent, unsubscribed] = await Promise.all([
			s.email_id ? getEmail(s.organization_id, s.email_id) : null,
			s.email_id ? emailEvents(s.email_id) : [],
			listEmails(s.organization_id, { search: s.address, limit: 25 }),
			db
				.select()
				.from(schema.unsubscribes)
				.where(
					and(
						eq(schema.unsubscribes.organization_id, s.organization_id),
						eq(schema.unsubscribes.address, s.address),
					),
				)
				.orderBy(desc(schema.unsubscribes.created_at)),
		]);
		const dots = context.masked;
		const subject = (t: string) => (dots ? maskDigits(t) : t);
		// SES's own word on it: the bounce or complaint event of that email for this address.
		const event = events.find(
			(e) =>
				(e.type === "email.bounced" ||
					e.type === "email.complained" ||
					e.type === "email.suppressed") &&
				(!e.recipient || e.recipient === s.address),
		);
		// Only emails really to this address (the search also matches a part of one).
		const mine = sent.data.filter((e) =>
			[...e.to, ...(e.cc ?? []), ...(e.bcc ?? [])].some((x) => x.toLowerCase() === s.address),
		);
		return {
			suppression: s,
			brand: brands.find((b) => b.id === s.organization_id) ?? null,
			/** The other brands that skip it too. */
			also: all
				.filter((r) => r !== s)
				.map((r) => ({
					...r,
					brand: brands.find((b) => b.id === r.organization_id)?.name ?? null,
				})),
			email: email
				? {
						id: email.id,
						subject: subject(email.subject),
						from: email.from,
						status: email.status,
						bounce_type: email.bounce_type,
						error: email.error,
						created_at: email.created_at,
					}
				: null,
			event: event
				? {
						type: event.type,
						at: event.at,
						data: event.data as EventData | null,
					}
				: null,
			explanation:
				s.reason === "bounce"
					? explainBounce({
							type: "Permanent",
							subType: email?.bounce_type?.split("/")[1] ?? null,
							message: s.detail,
							recipient: s.address,
						})
					: null,
			emails: mine.slice(0, 10).map((e) => ({
				id: e.id,
				subject: subject(e.subject),
				status: e.status,
				last_event: e.last_event,
				dropped: e.dropped,
				open_count: e.open_count,
				click_count: e.click_count,
				created_at: e.created_at,
			})),
			unsubscribed: unsubscribed.map((u) => ({ group: u.group, created_at: u.created_at })),
		};
	});

/** A removed suppression put back as it was (the «Undo» after removing one). */
export const restoreSuppressionFn = createServerFn({ method: "POST" })
	.middleware([can("recipients:unblock")])
	.validator(
		z.object({
			brand: z.string(),
			address: z.string().max(320),
			reason: z.enum(SUPPRESSION_REASONS),
			detail: z.string().max(300).nullish(),
			email_id: z.string().nullish(),
			created_at: z.string(),
		}),
	)
	.handler(async ({ data: { brand, ...row }, context }) => {
		const organization_id = await brandOr(context.organizationId, brand);
		// The email it links to must be this brand's: the suppression page shows its events.
		const email = row.email_id
			? await db
					.select({ id: schema.emails.id })
					.from(schema.emails)
					.where(
						and(
							eq(schema.emails.id, row.email_id),
							eq(schema.emails.organization_id, organization_id),
						),
					)
					.get()
			: null;
		await db
			.insert(schema.suppressions)
			.values({
				...row,
				organization_id,
				address: row.address.trim().toLowerCase(),
				detail: row.detail ?? null,
				email_id: email?.id ?? null,
			})
			.onConflictDoNothing();
		return { ok: true };
	});

// ── Unsubscribes (by group) ──

export const listUnsubscribesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			search: z.string().nullish(),
			group: z.string().nullish(),
			offset: z.number().int().min(0).default(0),
			brand: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const [page, groups] = await Promise.all([
			listUnsubscribes(scope, {
				search: data.search,
				group: data.group,
				offset: data.offset,
				limit: 100,
			}),
			unsubscribeGroups(scope),
		]);
		return { ...page, groups, brands };
	});

export const resubscribeFn = createServerFn({ method: "POST" })
	.middleware([can("recipients:unblock")])
	.validator(z.object({ group: z.string(), address: z.string(), brand: z.string().nullish() }))
	.handler(async ({ data, context }) => {
		const ids = data.brand
			? [await brandOr(context.organizationId, data.brand)]
			: await brandIds(context.organizationId);
		let ok = false;
		for (const id of ids) ok = (await resubscribe(id, data.group, data.address)) || ok;
		await logAccess({
			organizationId: context.organizationId,
			action: "unsubscribe_removed",
			subject: data.address,
			channel: "dashboard",
			userId: context.userId,
			actor: context.email,
		});
		return { ok };
	});

// ── Each brand's SES setup ──

const brandInput = z.object({ brand: z.string().nullish() }).default({});

export const sendingStatusFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(brandInput)
	.handler(async ({ data, context }) => {
		const row = await refreshTenantStatus(await brandOr(context.organizationId, data.brand));
		return row ?? null;
	});

/** The brand's SMTP username, if it has credentials (the password is never kept). */
export const smtpCredentialsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(brandInput)
	.handler(async ({ data, context }) => {
		const row = await smtpCredentials(await brandOr(context.organizationId, data.brand));
		return row
			? { username: row.access_key_id, region: row.region, created_at: row.created_at }
			: null;
	});

/** New SMTP credentials (replacing any): the password comes back this once. */
export const createSmtpCredentialsFn = createServerFn({ method: "POST" })
	.middleware([can("developers:keys")])
	.validator(brandInput)
	.handler(async ({ data, context }) => {
		const brand = await brandOr(context.organizationId, data.brand);
		return apiCall(async () => {
			const c = await createSmtpCredentials(brand, context.userId);
			return { username: c.access_key_id, password: c.password, region: c.region };
		});
	});

export const deleteSmtpCredentialsFn = createServerFn({ method: "POST" })
	.middleware([can("developers:keys")])
	.validator(brandInput)
	.handler(async ({ data, context }) => {
		const brand = await brandOr(context.organizationId, data.brand);
		return apiCall(async () => {
			await deleteSmtpCredentials(brand);
			return { ok: true };
		});
	});

export const setUpSendingFn = createServerFn({ method: "POST" })
	.middleware([can("domains:manage")])
	.validator(brandInput)
	.handler(async ({ data, context }) => {
		const brand = await brandOr(context.organizationId, data.brand);
		return apiCall(async () => {
			await setUpOrganization(brand);
			return { ok: true };
		});
	});
