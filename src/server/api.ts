import { waitUntil } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { checkContent } from "../lib/content-check";
import { EMAIL_FILTERS, type EmailFilterValue } from "../lib/email-status";
import { PROVIDERS, type Provider } from "../lib/providers";
import { keyName, logAccess } from "./access-log";
import { authenticate, createKey, deleteKey, type KeyAuth } from "./api-keys";
import {
	ARCHIVE_KINDS,
	type ArchiveKind,
	archiveEnabled,
	archiveResponse,
	brandOfKey,
	listArchive,
} from "./archive";
import {
	automationRuns,
	automationView,
	createAutomation,
	deleteAutomation,
	getAutomation,
	listAutomations,
	recordEvent,
	updateAutomation,
} from "./automations";
import {
	brandIds,
	brandIn,
	createBrand,
	getBrand,
	listBrands,
	orgOf,
	removeBrand,
	renameBrand,
	sendingStatus,
	setBrandPaused,
} from "./brands";
import {
	broadcastStats,
	broadcastView,
	cancelBroadcast,
	createBroadcast,
	deleteBroadcast,
	getBroadcast,
	listBroadcasts,
	resendBroadcast,
	runBroadcasts,
	sendBroadcast,
	updateBroadcast,
} from "./broadcasts";
import {
	addToSegment,
	contactView,
	createProperty,
	createSegment,
	createTopic,
	deleteContact,
	deleteProperty,
	deleteSegment,
	deleteTopic,
	getContact,
	listContacts,
	listProperties,
	listSegments,
	listTopics,
	propertyView,
	removeFromSegment,
	renameSegment,
	segmentOf,
	segmentsOfContact,
	segmentView,
	setTopics,
	topicOf,
	topicsOfContact,
	topicView,
	updateContact,
	updateProperty,
	updateTopic,
	upsertContact,
} from "./contacts";
import { db, schema } from "./db";
import { checkDomainHealth, domainHealth, healthView } from "./deliverability";
import { kickDispatcher, rateGate } from "./dispatcher";
import { ApiError, notFound, validation } from "./errors";
import { getFirewall, setFirewall } from "./firewall";
import {
	attachmentsView,
	getReceived,
	listReceived,
	RECEIVING_PREFIX_RE,
	receivedView,
	setDomainReceiving,
} from "./inbound";
import { createRule, deleteRule, getRule, listRules, ruleView, updateRule } from "./inbound-rules";
import { adminRoutes, agentRoutes, forbiddenForAgents, keyActor } from "./inbox-api";
import { authenticateInbox } from "./inboxes";
import { lookupRecipient } from "./lookup";
import {
	addDomain,
	dnsRecords,
	removeDomain,
	setDomainPaused,
	setDomainPurpose,
	setDomainSending,
	verifyDomain,
} from "./provision";
import {
	dailyStats,
	emailEvents,
	getEmail,
	inScope,
	listEmails,
	listSuppressions,
	type Scope,
	SUPPRESSION_REASONS,
	type SuppressionReason,
	statsByProvider,
	suppressionsOf,
} from "./queries";
import { limitIp, limitKey } from "./rate-limit";
import { recordRequest, track } from "./request-logs";
import { brandForSend, createEmails, parseSend, storedContent } from "./send";
import {
	createForm,
	deleteForm,
	formEmbed,
	formView,
	getForm,
	listForms,
	type SignupForm,
	updateForm,
} from "./signup-forms";
import { addSuppression, removeSuppression } from "./suppressions";
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
} from "./templates";
import { iso } from "./time";
import { addTrackingHost, removeTrackingHost, setTracking, TRACKING_PREFIX } from "./tracking";
import { brandWidget } from "./turnstile";
import { addUnsubscribe, GROUP, listUnsubscribes, resubscribe } from "./unsubscribes";
import { createWebhook, deleteWebhook, updateWebhook } from "./webhook-admin";
import { replayFailed } from "./webhooks";

/**
 * The public API at /api, compatible with Resend's for what both have (emails, batch, domains,
 * API keys), so Resend's SDKs work with `baseUrl` set to https://<mailroom>/api. Authenticated
 * with an organization's API key: Authorization: Bearer mr_….
 */

type Handler = (
	req: Request,
	auth: KeyAuth,
	params: Record<string, string>,
	url: URL,
) => Promise<Response>;

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function body<T = unknown>(req: Request): Promise<T> {
	try {
		return (await req.json()) as T;
	} catch {
		throw validation("The body must be JSON");
	}
}

const full = (auth: KeyAuth) => {
	if (auth.permission !== "full")
		throw new ApiError(401, "restricted_api_key", "This API key can only send emails");
};

/**
 * What a read covers: the brand the request acts on, `?brand=<id>`, or the whole organization
 * (every brand). `?organization=all` is the old spelling of the whole organization.
 */
async function readScope(auth: KeyAuth, url: URL): Promise<Scope> {
	if (auth.brandId) return auth.brandId;
	const pick = url.searchParams.get("brand");
	if (pick) return brandIn(auth.organizationId, pick);
	return { org: auth.organizationId };
}

/** The brand a write acts on: the request's, the body's `brand`, or the organization's own. */
async function writeBrand(auth: KeyAuth, named?: string | null): Promise<string> {
	if (auth.brandId) {
		if (named && (await brandIn(auth.organizationId, named)) !== auth.brandId)
			throw validation("`brand` names another brand than the request's");
		return auth.brandId;
	}
	return named ? brandIn(auth.organizationId, named) : auth.organizationId;
}

/** A domain of any of the organization's brands (or of the brand the request acts on). */
async function domainOf(auth: KeyAuth, id: string) {
	const d = await db.select().from(schema.domains).where(eq(schema.domains.id, id)).get();
	const ids = auth.brandId ? [auth.brandId] : await brandIds(auth.organizationId);
	if (!d || !ids.includes(d.organization_id)) throw notFound("Domain");
	return d;
}

/** Brands are the organization's: managed with its own key, not one acting on a brand. */
const orgLevel = (auth: KeyAuth) => {
	full(auth);
	if (auth.brandId)
		throw new ApiError(
			403,
			"invalid_access",
			"Manage brands without the Mailroom-Brand header",
		);
	return auth.organizationId;
};

/** A full key acting on one of its organization's brands (Mailroom-Brand: <id>). */
async function actFor(auth: KeyAuth, brand: string): Promise<KeyAuth> {
	if (auth.permission !== "full")
		throw new ApiError(401, "restricted_api_key", "This API key can only send emails");
	return { ...auth, brandId: await brandIn(auth.organizationId, brand) };
}

const domainView = (d: typeof schema.domains.$inferSelect) => ({
	object: "domain",
	id: d.id,
	name: d.name,
	brand_id: d.organization_id,
	purpose: d.purpose,
	/** Brands send from it (false: a domain only for receiving). */
	sending: d.sending,
	paused: d.paused_at ? { at: d.paused_at, reason: d.paused_reason } : null,
	status: d.status,
	region: d.region,
	created_at: d.created_at,
	open_tracking: d.open_tracking,
	click_tracking: d.click_tracking,
	/** Where tracked links point once it's live (links.<domain>), and whether it is. */
	tracking_domain: d.tracking_host ? { name: d.tracking_host, status: d.tracking_status } : null,
	/** Mailroom receives its email at `host` (reply.<domain> by default): "pending" until its MX
	 * points at SES. */
	receiving: d.receiving
		? { host: d.receiving_host ?? d.name, status: d.receiving_status ?? "pending" }
		: null,
	records: dnsRecords(d).map((r) => ({
		record: r.record,
		name: r.name,
		type: r.type,
		ttl: "Auto",
		value: r.value,
		...(r.priority !== undefined ? { priority: r.priority } : {}),
		status: r.optional
			? "optional"
			: r.status === "SUCCESS"
				? "verified"
				: (r.status?.toLowerCase() ?? "pending"),
	})),
});

async function emailView(scope: Scope, id: string) {
	const row = await getEmail(scope, id);
	if (!row) throw notFound("Email");
	const [stored, events] = await Promise.all([storedContent(id), emailEvents(id)]);
	return {
		object: "email",
		id: row.id,
		brand_id: row.organization_id,
		from: row.from,
		to: row.to,
		cc: row.cc,
		bcc: row.bcc,
		reply_to: row.reply_to,
		subject: row.subject,
		html: stored?.content.html ?? null,
		text: stored?.content.text ?? null,
		status: row.status,
		last_event: row.last_event ?? row.status,
		scheduled_at: row.status === "scheduled" ? row.send_at : null,
		created_at: row.created_at,
		tags: row.tags,
		unsubscribe_group: row.unsubscribe_group ?? null,
		error: row.error,
		dropped_recipients: row.dropped,
		events: events.map((ev) => ({
			type: ev.type,
			at: ev.at,
			recipient: ev.recipient,
			data: ev.data,
		})),
	};
}

/** A received email of the organization's brands (or of the brand the request acts on). */
async function receivedOf(auth: KeyAuth, id: string) {
	const row = await getReceived(auth.brandId ?? { org: auth.organizationId }, id);
	if (!row) throw notFound("Email");
	return row;
}

const sendEmail: Handler = async (req, auth) => {
	const input = parseSend(await applyTemplate(auth.organizationId, await body(req)));
	const brand = auth.brandId
		? await writeBrand(auth, input.brand)
		: await brandForSend(auth.organizationId, [input]);
	const [result] = await createEmails(brand, [input], {
		sandbox: input.sandbox,
		source: "api",
		apiKeyId: auth.id,
		onlyDomainId: auth.domainId,
		idempotencyKey: req.headers.get("idempotency-key"),
		kick: kickDispatcher,
		gate: rateGate,
	});
	if (!result) throw validation("Nothing to send");
	if (result.sandbox)
		return json({
			object: "sandbox",
			brand_id: brand,
			would_send:
				result.sandbox.to.length + result.sandbox.cc.length + result.sandbox.bcc.length > 0,
			recipients: { to: result.sandbox.to, cc: result.sandbox.cc, bcc: result.sandbox.bcc },
			dropped_recipients: result.sandbox.dropped,
		});
	if (result.error) {
		const res = result.error.toResponse();
		return Response.json(
			{ ...((await res.json()) as object), id: result.id },
			{ status: res.status },
		);
	}
	return json({ id: result.id });
};

const sendBatch: Handler = async (req, auth) => {
	const raw = await body<unknown[]>(req);
	if (!Array.isArray(raw) || !raw.length || raw.length > 100)
		throw validation("The body must be an array of 1 to 100 emails");
	const filled = await Promise.all(
		raw.map((item, i) => applyTemplate(auth.organizationId, item, `[${i}].`)),
	);
	const inputs = filled.map((item, i) => {
		const input = parseSend(item, `[${i}].`);
		if (input.attachments?.length)
			throw validation(`[${i}].attachments: batch emails can't have attachments`);
		if (input.scheduled_at || input.scheduledAt)
			throw validation(`[${i}].scheduled_at: batch emails can't be scheduled`);
		if (input.sandbox) throw validation(`[${i}].sandbox: only single sends take sandbox`);
		return input;
	});
	const named = inputs.find((i) => i.brand)?.brand;
	const brand = auth.brandId
		? await writeBrand(auth, named)
		: await brandForSend(auth.organizationId, inputs);
	const results = await createEmails(brand, inputs, {
		source: "api",
		apiKeyId: auth.id,
		onlyDomainId: auth.domainId,
		idempotencyKey: req.headers.get("idempotency-key"),
		queue: true,
		kick: kickDispatcher,
	});
	return json({ data: results.map((r) => ({ id: r.id })) });
};

/** The brand a contacts call acts on: the request's, `?brand=`, the body's, or the organization's. */
async function listBrand(auth: KeyAuth, url: URL, named?: unknown) {
	full(auth);
	return writeBrand(
		auth,
		url.searchParams.get("brand") ?? (typeof named === "string" ? named : null),
	);
}

const contactRoutes: [string, RegExp, Handler][] = [
	[
		"GET",
		/^\/contacts$/,
		async (_req, auth, _p, url) => {
			const brand = await listBrand(auth, url);
			const unsub = url.searchParams.get("unsubscribed");
			const page = await listContacts(brand, {
				segment: url.searchParams.get("segment_id") ?? url.searchParams.get("audience_id"),
				search: url.searchParams.get("search"),
				after: url.searchParams.get("after"),
				limit: Number(url.searchParams.get("limit")) || 50,
				unsubscribed: unsub === null ? null : unsub === "true",
			});
			return json({
				object: "list",
				has_more: page.has_more,
				next: page.next,
				data: page.data.map(contactView),
			});
		},
	],
	[
		"POST",
		/^\/contacts$/,
		async (req, auth, _p, url) => {
			const raw = await body<Record<string, unknown>>(req);
			const brand = await listBrand(auth, url, raw?.brand);
			const { brand: _b, ...rest } = raw ?? {};
			const { contact, created } = await upsertContact(brand, rest);
			return json({ object: "contact", id: contact.id, created }, created ? 201 : 200);
		},
	],
	[
		"GET",
		/^\/contacts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(contactView(await getContact(await listBrand(auth, url), p.id as string))),
	],
	[
		"PATCH",
		/^\/contacts\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const { brand: named, ...rest } = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, named);
			const c = await updateContact(brand, p.id as string, rest);
			return json({ object: "contact", id: c.id });
		},
	],
	[
		"DELETE",
		/^\/contacts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const c = await deleteContact(await listBrand(auth, url), p.id as string);
			return json({ object: "contact", id: c.id, contact: c.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/contacts\/(?<id>[^/]+)\/segments$/,
		async (_req, auth, p, url) => {
			const c = await getContact(await listBrand(auth, url), p.id as string);
			return json({
				object: "list",
				has_more: false,
				data: (await segmentsOfContact(c.id)).map((s) => segmentView(s)),
			});
		},
	],
	[
		"POST",
		/^\/contacts\/(?<id>[^/]+)\/segments\/(?<segment>[^/]+)$/,
		async (_req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const c = await getContact(brand, p.id as string);
			await addToSegment(brand, c.id, p.segment as string);
			return json({ id: p.segment, object: "segment" }, 201);
		},
	],
	[
		"DELETE",
		/^\/contacts\/(?<id>[^/]+)\/segments\/(?<segment>[^/]+)$/,
		async (_req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const c = await getContact(brand, p.id as string);
			await removeFromSegment(brand, c.id, p.segment as string);
			return json({ id: p.segment, object: "segment", deleted: true });
		},
	],
	[
		"GET",
		/^\/contacts\/(?<id>[^/]+)\/topics$/,
		async (_req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const c = await getContact(brand, p.id as string);
			return json({
				object: "list",
				has_more: false,
				data: await topicsOfContact(brand, c.id),
			});
		},
	],
	[
		"PATCH",
		/^\/contacts\/(?<id>[^/]+)\/topics$/,
		async (req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const c = await getContact(brand, p.id as string);
			const raw = await body<unknown>(req);
			const list = z
				.array(z.object({ id: z.string(), subscription: z.enum(["opt_in", "opt_out"]) }))
				.max(100)
				.parse(Array.isArray(raw) ? raw : (raw as { topics?: unknown })?.topics);
			await setTopics(brand, c.id, list);
			return json({ object: "contact", id: c.id });
		},
	],
	...(["segments", "audiences"] as const).flatMap((word): [string, RegExp, Handler][] => {
		const as = <T extends { object: string }>(v: T) =>
			word === "segments" ? v : { ...v, object: "audience" };
		return [
			[
				"GET",
				new RegExp(`^/${word}$`),
				async (_req, auth, _p, url) => {
					const rows = await listSegments(await listBrand(auth, url));
					return json({
						object: "list",
						has_more: false,
						data: rows.map((s) => as(segmentView(s, s.contacts))),
					});
				},
			],
			[
				"POST",
				new RegExp(`^/${word}$`),
				async (req, auth, _p, url) => {
					const raw = await body<Record<string, unknown>>(req);
					const s = await createSegment(await listBrand(auth, url, raw?.brand), raw);
					return json(as({ object: "segment", id: s.id, name: s.name }), 201);
				},
			],
			[
				"GET",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (_req, auth, p, url) => {
					const brand = await listBrand(auth, url);
					const s = await segmentOf(brand, p.id as string);
					const n = (await listSegments(brand)).find((x) => x.id === s.id)?.contacts ?? 0;
					return json(as(segmentView(s, n)));
				},
			],
			[
				"PATCH",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (req, auth, p, url) => {
					const s = await renameSegment(
						await listBrand(auth, url),
						p.id as string,
						await body(req),
					);
					return json(as(segmentView(s)));
				},
			],
			[
				"DELETE",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (_req, auth, p, url) => {
					const s = await deleteSegment(await listBrand(auth, url), p.id as string);
					return json(as({ object: "segment", id: s.id, deleted: true }));
				},
			],
		];
	}),
	// Resend's older shape: an audience's contacts.
	[
		"GET",
		/^\/audiences\/(?<audience>[^/]+)\/contacts$/,
		async (_req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			await segmentOf(brand, p.audience as string);
			const page = await listContacts(brand, {
				segment: p.audience,
				after: url.searchParams.get("after"),
				limit: Number(url.searchParams.get("limit")) || 50,
			});
			return json({
				object: "list",
				has_more: page.has_more,
				data: page.data.map(contactView),
			});
		},
	],
	[
		"POST",
		/^\/audiences\/(?<audience>[^/]+)\/contacts$/,
		async (req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const { contact } = await upsertContact(brand, {
				...(await body<Record<string, unknown>>(req)),
				segments: [p.audience],
			});
			return json({ object: "contact", id: contact.id }, 201);
		},
	],
	[
		"GET",
		/^\/audiences\/(?<audience>[^/]+)\/contacts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(contactView(await getContact(await listBrand(auth, url), p.id as string))),
	],
	[
		"PATCH",
		/^\/audiences\/(?<audience>[^/]+)\/contacts\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const c = await updateContact(
				await listBrand(auth, url),
				p.id as string,
				await body(req),
			);
			return json({ object: "contact", id: c.id });
		},
	],
	[
		"DELETE",
		/^\/audiences\/(?<audience>[^/]+)\/contacts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const brand = await listBrand(auth, url);
			const c = await getContact(brand, p.id as string);
			await removeFromSegment(brand, c.id, p.audience as string);
			return json({ object: "contact", id: c.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/topics$/,
		async (_req, auth, _p, url) => {
			const rows = await listTopics(await listBrand(auth, url));
			return json({ object: "list", has_more: false, data: rows.map(topicView) });
		},
	],
	[
		"POST",
		/^\/topics$/,
		async (req, auth, _p, url) => {
			const raw = await body<Record<string, unknown>>(req);
			const t = await createTopic(await listBrand(auth, url, raw?.brand), raw);
			return json({ object: "topic", id: t.id }, 201);
		},
	],
	[
		"GET",
		/^\/topics\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(topicView(await topicOf(await listBrand(auth, url), p.id as string))),
	],
	[
		"PATCH",
		/^\/topics\/(?<id>[^/]+)$/,
		async (req, auth, p, url) =>
			json(
				topicView(
					await updateTopic(await listBrand(auth, url), p.id as string, await body(req)),
				),
			),
	],
	[
		"DELETE",
		/^\/topics\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const t = await deleteTopic(await listBrand(auth, url), p.id as string);
			return json({ object: "topic", id: t.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/contact-properties$/,
		async (_req, auth, _p, url) => {
			const rows = await listProperties(await listBrand(auth, url));
			return json({ object: "list", has_more: false, data: rows.map(propertyView) });
		},
	],
	[
		"POST",
		/^\/contact-properties$/,
		async (req, auth, _p, url) => {
			const raw = await body<Record<string, unknown>>(req);
			const pr = await createProperty(await listBrand(auth, url, raw?.brand), raw);
			return json({ object: "contact_property", id: pr.id }, 201);
		},
	],
	[
		"GET",
		/^\/contact-properties\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const rows = await listProperties(await listBrand(auth, url));
			const pr = rows.find((r) => r.id === p.id || r.key === p.id);
			if (!pr) throw notFound("Contact property");
			return json(propertyView(pr));
		},
	],
	[
		"PATCH",
		/^\/contact-properties\/(?<id>[^/]+)$/,
		async (req, auth, p, url) =>
			json(
				propertyView(
					await updateProperty(
						await listBrand(auth, url),
						p.id as string,
						await body(req),
					),
				),
			),
	],
	[
		"DELETE",
		/^\/contact-properties\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const pr = await deleteProperty(await listBrand(auth, url), p.id as string);
			return json({ object: "contact_property", id: pr.id, deleted: true });
		},
	],
];

/** The brands a broadcasts call can see: the request's, `?brand=`, or every one of the organization's. */
async function broadcastBrands(auth: KeyAuth, url: URL) {
	full(auth);
	if (auth.brandId) return [auth.brandId];
	const pick = url.searchParams.get("brand");
	if (pick) return [await brandIn(auth.organizationId, pick)];
	return brandIds(auth.organizationId);
}

const broadcastRoutes: [string, RegExp, Handler][] = [
	[
		"GET",
		/^\/broadcasts$/,
		async (_req, auth, _p, url) => {
			const rows = await listBroadcasts(await broadcastBrands(auth, url), {
				limit: Number(url.searchParams.get("limit")) || 100,
			});
			return json({
				object: "list",
				has_more: false,
				// The content is left out of the list (GET /broadcasts/:id has it).
				data: rows.map((x) => {
					const { html: _h, text: _t, ...v } = broadcastView(x);
					return v;
				}),
			});
		},
	],
	[
		"POST",
		/^\/broadcasts$/,
		async (req, auth, _p, url) => {
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, raw.brand);
			const { brand: _b, ...rest } = raw;
			const x = await createBroadcast(auth.organizationId, brand, rest);
			if (x.status === "scheduled") waitUntil(runBroadcasts(Date.now(), x.id));
			return json({ object: "broadcast", id: x.id, status: x.status }, 201);
		},
	],
	[
		"GET",
		/^\/broadcasts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			return json({ ...broadcastView(x), stats: await broadcastStats(x.id) });
		},
	],
	[
		"PATCH",
		/^\/broadcasts\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			const { brand: _b, ...rest } = (await body<Record<string, unknown>>(req)) ?? {};
			const row = await updateBroadcast(auth.organizationId, x.organization_id, x.id, rest);
			return json({ object: "broadcast", id: row.id });
		},
	],
	[
		"DELETE",
		/^\/broadcasts\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			await deleteBroadcast(x.organization_id, x.id);
			return json({ object: "broadcast", id: x.id, deleted: true });
		},
	],
	[
		"POST",
		/^\/broadcasts\/(?<id>[^/]+)\/send$/,
		async (req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const at = raw.scheduled_at ?? raw.scheduledAt;
			const row = await sendBroadcast(
				x.organization_id,
				x.id,
				typeof at === "string" ? at : null,
				Date.now(),
				{
					ab_test: (raw.ab_test ?? raw.abTest) as never,
					local_time: (raw.local_time ?? raw.localTime) as never,
				},
			);
			waitUntil(runBroadcasts(Date.now(), row.id));
			return json({
				object: "broadcast",
				id: row.id,
				status: row.status,
				scheduled_at: row.scheduled_at,
			});
		},
	],
	[
		"POST",
		/^\/broadcasts\/(?<id>[^/]+)\/resend$/,
		async (req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const row = await resendBroadcast(x.organization_id, x.id, {
				subject: typeof raw.subject === "string" ? raw.subject : null,
				name: typeof raw.name === "string" ? raw.name : null,
			});
			return json(broadcastView(row), 201);
		},
	],
	[
		"POST",
		/^\/broadcasts\/(?<id>[^/]+)\/cancel$/,
		async (_req, auth, p, url) => {
			const x = await getBroadcast(await broadcastBrands(auth, url), p.id as string);
			const row = await cancelBroadcast(x.organization_id, x.id);
			return json({ object: "broadcast", id: row.id, status: row.status });
		},
	],
];

const automationRoutes: [string, RegExp, Handler][] = [
	[
		"POST",
		/^\/events$/,
		async (req, auth, _p, url) => {
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, raw.brand);
			const { brand: _b, ...rest } = raw;
			return json(await recordEvent(brand, rest), 202);
		},
	],
	[
		"GET",
		/^\/automations$/,
		async (_req, auth, _p, url) =>
			json({
				object: "list",
				data: (await listAutomations(await broadcastBrands(auth, url))).map(automationView),
			}),
	],
	[
		"POST",
		/^\/automations$/,
		async (req, auth, _p, url) => {
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, raw.brand);
			const { brand: _b, ...rest } = raw;
			return json(automationView(await createAutomation(brand, rest)), 201);
		},
	],
	[
		"GET",
		/^\/automations\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(
				automationView(
					await getAutomation(await broadcastBrands(auth, url), p.id as string),
				),
			),
	],
	[
		"PATCH",
		/^\/automations\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const x = await getAutomation(await broadcastBrands(auth, url), p.id as string);
			const { brand: _b, ...rest } = (await body<Record<string, unknown>>(req)) ?? {};
			return json(automationView(await updateAutomation(x.organization_id, x.id, rest)));
		},
	],
	[
		"DELETE",
		/^\/automations\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const x = await getAutomation(await broadcastBrands(auth, url), p.id as string);
			await deleteAutomation(x.organization_id, x.id);
			return json({ object: "automation", id: x.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/automations\/(?<id>[^/]+)\/runs$/,
		async (_req, auth, p, url) => {
			const x = await getAutomation(await broadcastBrands(auth, url), p.id as string);
			const { counts, runs } = await automationRuns(x.id, 100);
			return json({ object: "list", counts, data: runs });
		},
	],
];

const ruleRoutes: [string, RegExp, Handler][] = [
	[
		"POST",
		/^\/emails\/check$/,
		async (req) => {
			const v = z
				.object({
					subject: z.string().max(998).default(""),
					html: z.string().max(2_000_000).nullish(),
					text: z.string().max(2_000_000).nullish(),
					marketing: z.boolean().optional(),
				})
				.parse((await body(req)) ?? {});
			const findings = checkContent(v);
			return json({
				object: "content_check",
				ok: !findings.some((f) => f.level === "warning"),
				findings,
			});
		},
	],
	[
		"GET",
		/^\/domains\/(?<id>[^/]+)\/health$/,
		async (_req, auth, p) => {
			full(auth);
			const d = await domainOf(auth, p.id as string);
			return json({ object: "domain_health", domain: d.name, ...(await domainHealth(d.id)) });
		},
	],
	[
		"POST",
		/^\/domains\/(?<id>[^/]+)\/health$/,
		async (_req, auth, p) => {
			full(auth);
			const d = await domainOf(auth, p.id as string);
			const row = await checkDomainHealth(d, { notify: false });
			return json({ object: "domain_health", domain: d.name, ...healthView(row as never) });
		},
	],
	[
		"GET",
		/^\/inbound-rules$/,
		async (_req, auth, _p, url) =>
			json({
				object: "list",
				data: (await listRules(await broadcastBrands(auth, url))).map(ruleView),
			}),
	],
	[
		"POST",
		/^\/inbound-rules$/,
		async (req, auth, _p, url) => {
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, raw.brand);
			const { brand: _b, ...rest } = raw;
			return json(ruleView(await createRule(brand, rest)), 201);
		},
	],
	[
		"GET",
		/^\/inbound-rules\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(ruleView(await getRule(await broadcastBrands(auth, url), p.id as string))),
	],
	[
		"PATCH",
		/^\/inbound-rules\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const x = await getRule(await broadcastBrands(auth, url), p.id as string);
			const { brand: _b, ...rest } = (await body<Record<string, unknown>>(req)) ?? {};
			return json(ruleView(await updateRule(x.organization_id, x.id, rest)));
		},
	],
	[
		"DELETE",
		/^\/inbound-rules\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const x = await getRule(await broadcastBrands(auth, url), p.id as string);
			await deleteRule(x.organization_id, x.id);
			return json({ object: "inbound_rule", id: x.id, deleted: true });
		},
	],
];

/** A form's view with its embed snippet (and its brand's Turnstile, when it has one). */
async function formWithSnippet(f: SignupForm) {
	const widget = await brandWidget(f.organization_id);
	return {
		...formView(f),
		...(await formEmbed(f, { sitekey: widget?.sitekey })),
		turnstile: !!widget,
	};
}

const formRoutes: [string, RegExp, Handler][] = [
	[
		"GET",
		/^\/signup-forms$/,
		async (_req, auth, _p, url) =>
			json({
				object: "list",
				data: (await listForms(await broadcastBrands(auth, url))).map(formView),
			}),
	],
	[
		"POST",
		/^\/signup-forms$/,
		async (req, auth, _p, url) => {
			const raw = (await body<Record<string, unknown>>(req)) ?? {};
			const brand = await listBrand(auth, url, raw.brand);
			const { brand: _b, ...rest } = raw;
			return json(await formWithSnippet(await createForm(brand, rest)), 201);
		},
	],
	[
		"GET",
		/^\/signup-forms\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) =>
			json(
				await formWithSnippet(
					await getForm(await broadcastBrands(auth, url), p.id as string),
				),
			),
	],
	[
		"PATCH",
		/^\/signup-forms\/(?<id>[^/]+)$/,
		async (req, auth, p, url) => {
			const x = await getForm(await broadcastBrands(auth, url), p.id as string);
			const { brand: _b, ...rest } = (await body<Record<string, unknown>>(req)) ?? {};
			return json(await formWithSnippet(await updateForm(x.organization_id, x.id, rest)));
		},
	],
	[
		"DELETE",
		/^\/signup-forms\/(?<id>[^/]+)$/,
		async (_req, auth, p, url) => {
			const x = await getForm(await broadcastBrands(auth, url), p.id as string);
			await deleteForm(x.organization_id, x.id);
			return json({ object: "signup_form", id: x.id, deleted: true });
		},
	],
];

const archiveRoutes: [string, RegExp, Handler][] = [
	[
		"GET",
		/^\/archive$/,
		async (_req, auth, _p, url) => {
			const brand = await listBrand(auth, url);
			const kind = url.searchParams.get("kind");
			if (kind && !ARCHIVE_KINDS.includes(kind as ArchiveKind))
				throw validation("kind: emails, bodies or received");
			const r = await listArchive(brand, {
				...(kind ? { kind: kind as ArchiveKind } : {}),
				...(url.searchParams.get("cursor")
					? { cursor: url.searchParams.get("cursor") as string }
					: {}),
				limit: Number(url.searchParams.get("limit")) || 100,
			});
			return json({
				object: "list",
				/** Whether the organization archives what retention takes (Settings › Archive). */
				enabled: r.enabled && (await archiveEnabled(await orgOf(brand))),
				has_more: r.has_more,
				cursor: r.cursor,
				data: r.data.map((f) => ({ object: "archive_file", ...f })),
			});
		},
	],
	[
		"GET",
		/^\/archive\/file$/,
		async (_req, auth, _p, url) => {
			const key = url.searchParams.get("key") ?? "";
			if (!(await broadcastBrands(auth, url)).includes(brandOfKey(key)))
				throw notFound("Archive file");
			return archiveResponse(key);
		},
	],
];

const routes: [string, RegExp, Handler][] = [
	...contactRoutes,
	...broadcastRoutes,
	...automationRoutes,
	...ruleRoutes,
	...archiveRoutes,
	...formRoutes,
	["POST", /^\/emails$/, sendEmail],
	["POST", /^\/emails\/batch$/, sendBatch],
	[
		"GET",
		/^\/emails$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const status = url.searchParams.get("status");
			const provider = url.searchParams.get("provider");
			const page = await listEmails(await readScope(auth, url), {
				status:
					status && (EMAIL_FILTERS as readonly string[]).includes(status)
						? (status as EmailFilterValue)
						: null,
				day: url.searchParams.get("day"),
				domain: url.searchParams.get("domain"),
				provider:
					provider && (PROVIDERS as string[]).includes(provider)
						? (provider as Provider)
						: null,
				search: url.searchParams.get("search"),
				tag: url.searchParams.get("tag"),
				after: url.searchParams.get("after"),
				limit: Number(url.searchParams.get("limit")) || 20,
			});
			return json({
				object: "list",
				has_more: page.has_more,
				data: page.data.map((r) => ({
					...r,
					last_event: r.last_event ?? r.status,
					scheduled_at: r.status === "scheduled" ? r.send_at : null,
				})),
			});
		},
	],
	// Received emails, Resend's paths (src/server/inbound.ts).
	[
		"GET",
		/^\/emails\/receiving$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const page = await listReceived(await readScope(auth, url), {
				search: url.searchParams.get("search"),
				domain: url.searchParams.get("domain"),
				after: url.searchParams.get("after"),
				limit: Number(url.searchParams.get("limit")) || 20,
			});
			return json({
				object: "list",
				has_more: page.has_more,
				data: await Promise.all(page.data.map((r) => receivedView(r, false))),
			});
		},
	],
	[
		"GET",
		/^\/emails\/receiving\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			return json(await receivedView(await receivedOf(auth, p.id as string)));
		},
	],
	[
		"GET",
		/^\/emails\/receiving\/(?<id>[^/]+)\/attachments$/,
		async (_req, auth, p) => {
			full(auth);
			const row = await receivedOf(auth, p.id as string);
			return json({ object: "list", has_more: false, data: await attachmentsView(row) });
		},
	],
	[
		"GET",
		/^\/emails\/receiving\/(?<id>[^/]+)\/attachments\/(?<attachment>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			const row = await receivedOf(auth, p.id as string);
			const one = (await attachmentsView(row)).find((a) => a.id === p.attachment);
			if (!one) throw notFound("Attachment");
			return json(one);
		},
	],
	[
		"GET",
		/^\/emails\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			return json(
				await emailView(auth.brandId ?? { org: auth.organizationId }, p.id as string),
			);
		},
	],
	[
		"PATCH",
		/^\/emails\/(?<id>[^/]+)$/,
		async (req, auth, p) => {
			full(auth);
			const { scheduled_at } = z.object({ scheduled_at: z.string() }).parse(await body(req));
			const at = Date.parse(scheduled_at);
			if (Number.isNaN(at) || at < Date.now())
				throw validation("scheduled_at must be a future ISO 8601 date");
			const [row] = await db
				.update(schema.emails)
				.set({ send_at: iso(at) })
				.where(
					and(
						eq(schema.emails.id, p.id as string),
						inScope(
							schema.emails.organization_id,
							auth.brandId ?? { org: auth.organizationId },
						),
						eq(schema.emails.status, "scheduled"),
					),
				)
				.returning({ id: schema.emails.id });
			if (!row)
				throw new ApiError(
					409,
					"not_scheduled",
					"Only a scheduled email can be rescheduled",
				);
			await kickDispatcher();
			return json({ object: "email", id: row.id });
		},
	],
	[
		"POST",
		/^\/emails\/(?<id>[^/]+)\/cancel$/,
		async (_req, auth, p) => {
			full(auth);
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
						eq(schema.emails.id, p.id as string),
						inScope(
							schema.emails.organization_id,
							auth.brandId ?? { org: auth.organizationId },
						),
						eq(schema.emails.status, "scheduled"),
					),
				)
				.returning({ id: schema.emails.id });
			if (!row)
				throw new ApiError(409, "not_scheduled", "Only a scheduled email can be canceled");
			return json({ object: "email", id: row.id });
		},
	],
	// Brands, and /organizations: their first name (apps that came before brands still call it that).
	...(["brands", "organizations"] as const).flatMap((word): [string, RegExp, Handler][] => {
		// The old name answers with object "organization", as it always did.
		const as = <T extends { object: string }>(b: T) =>
			word === "brands" ? b : { ...b, object: "organization" };
		return [
			[
				"POST",
				new RegExp(`^/${word}$`),
				async (req, auth) => {
					const org = orgLevel(auth);
					const input = z
						.object({
							name: z.string().trim().min(1).max(80),
							external_id: z.string().trim().min(1).max(200).optional(),
						})
						.parse(await body(req));
					const { brand, created } = await createBrand(org, {
						name: input.name,
						externalId: input.external_id,
					});
					return json(as(brand), created ? 201 : 200);
				},
			],
			[
				"GET",
				new RegExp(`^/${word}$`),
				async (_req, auth) => {
					const org = orgLevel(auth);
					const all = await listBrands(org);
					// The old list was only the brands an app made, not the organization's own.
					const data = word === "brands" ? all : all.filter((b) => !b.default);
					return json({ object: "list", data: data.map(as) });
				},
			],
			[
				"GET",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (_req, auth, p) => json(as(await getBrand(orgLevel(auth), p.id as string))),
			],
			[
				"PATCH",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (req, auth, p) => {
					const org = orgLevel(auth);
					const input = z
						.object({
							name: z.string().trim().min(1).max(80).optional(),
							paused: z.boolean().optional(),
						})
						.parse(await body(req));
					let b = await getBrand(org, p.id as string);
					if (input.name) b = await renameBrand(org, b.id, input.name);
					if (input.paused !== undefined)
						b = await setBrandPaused(org, b.id, input.paused);
					return json(as(b));
				},
			],
			[
				"DELETE",
				new RegExp(`^/${word}/(?<id>[^/]+)$`),
				async (req, auth, p, url) => {
					const org = orgLevel(auth);
					const moveTo =
						url.searchParams.get("move_domains_to") ??
						(req.headers.get("content-type")?.includes("json")
							? z
									.object({ move_domains_to: z.string().optional() })
									.parse(await body(req)).move_domains_to
							: undefined) ??
						org;
					const r = await removeBrand(org, p.id as string, moveTo);
					return json({ object: as({ object: "brand" }).object, ...r, deleted: true });
				},
			],
		];
	}),
	[
		"GET",
		/^\/domains$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const rows = await db
				.select()
				.from(schema.domains)
				.where(inScope(schema.domains.organization_id, await readScope(auth, url)))
				.orderBy(desc(schema.domains.created_at));
			return json({
				object: "list",
				data: rows.map((d) => ({
					id: d.id,
					name: d.name,
					brand_id: d.organization_id,
					purpose: d.purpose,
					paused: !!d.paused_at,
					status: d.status,
					created_at: d.created_at,
					region: d.region,
				})),
			});
		},
	],
	[
		"POST",
		/^\/domains$/,
		async (req, auth) => {
			full(auth);
			const input = z
				.object({
					name: z.string(),
					brand: z.string().optional(),
					purpose: z.enum(["transactional", "marketing"]).optional(),
					// What it's for: sending (the default), receiving, or both.
					sending: z.boolean().optional(),
					receiving: z.boolean().optional(),
					replace_mx: z.boolean().optional(),
				})
				.parse(await body(req));
			const brand = await writeBrand(auth, input.brand);
			return json(
				domainView(
					(await addDomain(brand, input.name, input.purpose, {
						sending: input.sending,
						receiving: input.receiving,
						replaceMx: input.replace_mx,
					})) as typeof schema.domains.$inferSelect,
				),
				201,
			);
		},
	],
	[
		"GET",
		/^\/domains\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			return json(domainView(await domainOf(auth, p.id as string)));
		},
	],
	[
		"PATCH",
		/^\/domains\/(?<id>[^/]+)$/,
		async (req, auth, p) => {
			full(auth);
			const input = z
				.object({
					open_tracking: z.boolean().optional(),
					click_tracking: z.boolean().optional(),
					// links.<domain> as the tracking host (its CNAME then shows in `records`); null stops it.
					tracking_subdomain: z.string().regex(TRACKING_PREFIX).nullable().optional(),
					purpose: z.enum(["transactional", "marketing"]).optional(),
					paused: z.boolean().optional(),
					// Brands send from it (false: only for receiving).
					sending: z.boolean().optional(),
					// Mailroom receives the domain's email (its MX then shows in `records`).
					receiving: z.boolean().optional(),
					// Where: <prefix>.<domain> (reply by default); "" for the domain itself.
					receiving_prefix: z
						.union([z.string().regex(RECEIVING_PREFIX_RE), z.literal("")])
						.optional(),
					// Receive even though that host's MX sends its mail elsewhere today.
					replace_mx: z.boolean().optional(),
				})
				.parse(await body(req));
			const id = p.id as string;
			const brand = (await domainOf(auth, id)).organization_id;
			if (input.purpose) await setDomainPurpose(brand, id, input.purpose);
			if (input.paused !== undefined) await setDomainPaused(brand, id, input.paused);
			// Sending on first and off last: a domain always keeps one of the two.
			if (input.sending === true) await setDomainSending(brand, id, true);
			if (input.receiving !== undefined || input.receiving_prefix !== undefined)
				await setDomainReceiving(brand, id, input.receiving ?? true, {
					replaceMx: input.replace_mx,
					prefix: input.receiving_prefix,
				});
			if (input.sending === false) await setDomainSending(brand, id, false);
			let d = await setTracking(brand, id, {
				open: input.open_tracking,
				click: input.click_tracking,
			});
			if (input.tracking_subdomain === null) {
				await removeTrackingHost(brand, id);
				d = await setTracking(brand, id, {});
			} else if (input.tracking_subdomain) {
				await addTrackingHost(brand, id, input.tracking_subdomain);
				d = await setTracking(brand, id, {});
			}
			return json(domainView(d));
		},
	],
	[
		"POST",
		/^\/domains\/(?<id>[^/]+)\/verify$/,
		async (_req, auth, p) => {
			full(auth);
			const d = await domainOf(auth, p.id as string);
			return json(domainView(await verifyDomain(d.organization_id, d.id)));
		},
	],
	[
		"DELETE",
		/^\/domains\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			const d = await domainOf(auth, p.id as string);
			await removeDomain(d.organization_id, d.id);
			return json({ object: "domain", id: p.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/api-keys$/,
		async (_req, auth) => {
			full(auth);
			const rows = await db
				.select({
					id: schema.apiKeys.id,
					name: schema.apiKeys.name,
					permission: schema.apiKeys.permission,
					created_at: schema.apiKeys.created_at,
					last_used_at: schema.apiKeys.last_used_at,
				})
				.from(schema.apiKeys)
				.where(eq(schema.apiKeys.organization_id, auth.organizationId));
			return json({ object: "list", data: rows });
		},
	],
	[
		"POST",
		/^\/api-keys$/,
		async (req, auth) => {
			full(auth);
			const input = z
				.object({
					name: z.string().min(1).max(100),
					permission: z.enum(["full_access", "sending_access"]).default("full_access"),
					domain_id: z.string().optional(),
				})
				.parse(await body(req));
			const key = await createKey({
				organizationId: auth.organizationId,
				name: input.name,
				permission: input.permission === "sending_access" ? "sending" : "full",
				domainId: input.domain_id,
			});
			return json(key, 201);
		},
	],
	[
		"DELETE",
		/^\/api-keys\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			if (!(await deleteKey(auth.organizationId, p.id as string))) throw notFound("API key");
			return new Response(null, { status: 200 });
		},
	],
	[
		"GET",
		/^\/webhooks$/,
		async (_req, auth) => {
			full(auth);
			const rows = await db
				.select()
				.from(schema.webhooks)
				.where(eq(schema.webhooks.organization_id, auth.organizationId));
			return json({ object: "list", data: rows.map(({ secret: _s, ...r }) => r) });
		},
	],
	[
		"POST",
		/^\/webhooks$/,
		async (req, auth) => {
			full(auth);
			return json(await createWebhook(auth.organizationId, await body(req)), 201);
		},
	],
	[
		"PATCH",
		/^\/webhooks\/(?<id>[^/]+)$/,
		async (req, auth, p) => {
			full(auth);
			return json(await updateWebhook(auth.organizationId, p.id as string, await body(req)));
		},
	],
	[
		"DELETE",
		/^\/webhooks\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			await deleteWebhook(auth.organizationId, p.id as string);
			return json({ object: "webhook", id: p.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/suppressions$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const reason = url.searchParams.get("reason");
			const page = await listSuppressions(await readScope(auth, url), {
				search: url.searchParams.get("search"),
				reason: (SUPPRESSION_REASONS as readonly string[]).includes(reason ?? "")
					? (reason as SuppressionReason)
					: null,
				limit: Number(url.searchParams.get("limit")) || 100,
				offset: Number(url.searchParams.get("offset")) || 0,
			});
			return json({
				object: "list",
				has_more: page.has_more,
				data: page.data.map(({ organization_id, ...r }) => ({
					...r,
					brand_id: organization_id,
				})),
			});
		},
	],
	[
		"POST",
		/^\/suppressions$/,
		async (req, auth) => {
			full(auth);
			const { email, reason, brand } = z
				.object({
					email: z.string().email(),
					reason: z.string().max(200).optional(),
					brand: z.string().optional(),
				})
				.parse(await body(req));
			const id = await writeBrand(auth, brand);
			await addSuppression(id, email, reason);
			return json({ object: "suppression", email: email.toLowerCase(), brand_id: id }, 201);
		},
	],
	[
		"GET",
		/^\/suppressions\/(?<email>[^/]+)$/,
		async (_req, auth, p, url) => {
			full(auth);
			// One a brand: the newest, unless `brand` picks one.
			const [row] = await suppressionsOf(
				await readScope(auth, url),
				decodeURIComponent(p.email as string),
			);
			if (!row) throw notFound("Suppression");
			const { organization_id, ...r } = row;
			return json({ object: "suppression", ...r, brand_id: organization_id });
		},
	],
	[
		"DELETE",
		/^\/suppressions\/(?<email>[^/]+)$/,
		async (_req, auth, p, url) => {
			full(auth);
			const email = decodeURIComponent(p.email as string);
			// Without a brand: off every brand's list (the person asked to get emails again).
			const pick = url.searchParams.get("brand");
			const ids = auth.brandId
				? [auth.brandId]
				: pick
					? [await brandIn(auth.organizationId, pick)]
					: await brandIds(auth.organizationId);
			for (const id of ids) await removeSuppression(id, email);
			await logAccess({
				organizationId: auth.organizationId,
				action: "suppression_removed",
				subject: email,
				channel: "api",
				actor: await keyName(auth.id),
			});
			return json({ object: "suppression", email, deleted: true });
		},
	],
	[
		"GET",
		/^\/unsubscribes$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const page = await listUnsubscribes(await readScope(auth, url), {
				group: url.searchParams.get("group"),
				search: url.searchParams.get("search"),
				limit: Math.min(Number(url.searchParams.get("limit")) || 100, 100),
				offset: Number(url.searchParams.get("offset")) || 0,
			});
			return json({
				object: "list",
				has_more: page.has_more,
				data: page.data.map((r) => ({
					object: "unsubscribe",
					email: r.address,
					group: r.group,
					brand_id: r.organization_id,
					email_id: r.email_id,
					created_at: r.created_at,
				})),
			});
		},
	],
	[
		"POST",
		/^\/unsubscribes$/,
		async (req, auth) => {
			full(auth);
			// Someone who asked the app itself (by phone, in its own settings).
			const { email, group, brand } = z
				.object({
					email: z.string().email(),
					group: z.string().regex(GROUP),
					brand: z.string().optional(),
				})
				.parse(await body(req));
			const id = await writeBrand(auth, brand);
			await addUnsubscribe(id, group, email);
			return json(
				{ object: "unsubscribe", email: email.toLowerCase(), group, brand_id: id },
				201,
			);
		},
	],
	[
		"DELETE",
		/^\/unsubscribes\/(?<group>[^/]+)\/(?<email>[^/]+)$/,
		async (_req, auth, p, url) => {
			full(auth);
			const group = decodeURIComponent(p.group as string);
			const email = decodeURIComponent(p.email as string);
			const pick = url.searchParams.get("brand");
			const ids = auth.brandId
				? [auth.brandId]
				: pick
					? [await brandIn(auth.organizationId, pick)]
					: await brandIds(auth.organizationId);
			for (const id of ids) await resubscribe(id, group, email);
			await logAccess({
				organizationId: auth.organizationId,
				action: "unsubscribe_removed",
				subject: email,
				channel: "api",
				actor: await keyName(auth.id),
			});
			return json({ object: "unsubscribe", email, group, deleted: true });
		},
	],
	[
		"GET",
		/^\/recipients\/(?<email>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			return json(
				await lookupRecipient(auth.organizationId, decodeURIComponent(p.email as string), {
					channel: "api",
					actor: await keyName(auth.id),
				}),
			);
		},
	],
	[
		"GET",
		/^\/firewall$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const id = await writeBrand(auth, url.searchParams.get("brand"));
			const { updated_at, ...fw } = await getFirewall(id);
			return json({ object: "firewall", brand_id: id, ...fw, updated_at });
		},
	],
	[
		"PATCH",
		/^\/firewall$/,
		async (req, auth) => {
			full(auth);
			const { brand, ...patch } = z
				.object({
					brand: z.string().optional(),
					block_disposable: z.boolean().optional(),
					block_free: z.boolean().optional(),
					block_plus: z.boolean().optional(),
					never: z.array(z.string().max(320)).max(1000).optional(),
					always: z.array(z.string().max(320)).max(1000).optional(),
				})
				.parse(await body(req));
			const id = await writeBrand(auth, brand);
			return json({ object: "firewall", brand_id: id, ...(await setFirewall(id, patch)) });
		},
	],
	[
		"POST",
		/^\/webhooks\/(?<id>[^/]+)\/replay_failed$/,
		async (_req, auth, p) => {
			full(auth);
			const replayed = await replayFailed(auth.organizationId, p.id as string);
			return json({ object: "webhook", id: p.id, replayed });
		},
	],
	[
		"GET",
		/^\/templates$/,
		async (_req, auth) => {
			full(auth);
			const rows = await listTemplates(auth.organizationId);
			return json({
				object: "list",
				has_more: false,
				data: rows.map((t) => {
					const { html: _h, text: _t, variables: _v, ...rest } = templateView(t);
					return rest;
				}),
			});
		},
	],
	[
		"POST",
		/^\/templates$/,
		async (req, auth) => {
			full(auth);
			const raw = await body<Record<string, unknown>>(req);
			const t = await createTemplate(auth.organizationId, raw, { publish: !!raw?.publish });
			return json({ id: t.id, object: "template" }, 201);
		},
	],
	[
		"GET",
		/^\/templates\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			return json(
				templateView(
					await getTemplate(auth.organizationId, decodeURIComponent(p.id as string)),
				),
			);
		},
	],
	[
		"PATCH",
		/^\/templates\/(?<id>[^/]+)$/,
		async (req, auth, p) => {
			full(auth);
			const t = await updateTemplate(
				auth.organizationId,
				decodeURIComponent(p.id as string),
				await body(req),
			);
			return json({ id: t.id, object: "template" });
		},
	],
	[
		"POST",
		/^\/templates\/(?<id>[^/]+)\/publish$/,
		async (_req, auth, p) => {
			full(auth);
			const t = await publishTemplate(
				auth.organizationId,
				decodeURIComponent(p.id as string),
			);
			return json({ id: t.id, object: "template" });
		},
	],
	[
		"POST",
		/^\/templates\/(?<id>[^/]+)\/duplicate$/,
		async (_req, auth, p) => {
			full(auth);
			const t = await duplicateTemplate(
				auth.organizationId,
				decodeURIComponent(p.id as string),
			);
			return json({ id: t.id, object: "template" }, 201);
		},
	],
	[
		"DELETE",
		/^\/templates\/(?<id>[^/]+)$/,
		async (_req, auth, p) => {
			full(auth);
			const t = await deleteTemplate(auth.organizationId, decodeURIComponent(p.id as string));
			return json({ object: "template", id: t.id, deleted: true });
		},
	],
	[
		"GET",
		/^\/status$/,
		async (_req, auth) => {
			// Any key may ask: can this organization send right now, and if not, why not.
			return json(await sendingStatus(auth.organizationId, auth.brandId));
		},
	],
	[
		"GET",
		/^\/stats$/,
		async (_req, auth, _p, url) => {
			full(auth);
			const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 90);
			const scope = await readScope(auth, url);
			const [stats, providers] = await Promise.all([
				dailyStats(scope, days),
				statsByProvider(scope, days),
			]);
			return json({ object: "stats", ...stats, by_provider: providers });
		},
	],
];

/** Request bodies bigger than this aren't copied for the log. */
const MAX_LOGGED_REQUEST = 1_000_000;

export async function handleApi(req: Request): Promise<Response> {
	const started = Date.now();
	const url = new URL(req.url);
	const requested = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
	// /api/brands/<id>/… acts on that brand, like the Mailroom-Brand header, so an SDK only needs
	// a different base URL for each. /organizations/<id>/… and Mailroom-Organization are their
	// first names.
	const nested = /^\/(?:brands|organizations)\/([^/]+)(\/.+)$/.exec(requested);
	const path = nested?.[2] ?? requested;
	const acting =
		nested?.[1] ??
		(req.headers.get("mailroom-brand") ?? req.headers.get("mailroom-organization"))?.trim() ??
		null;
	// Read before the handler takes it, for the log; a big one (attachments) isn't copied, to
	// stay well inside the Worker's memory.
	const size = Number(req.headers.get("content-length") ?? 0);
	const requestBody =
		req.method === "GET" || req.method === "HEAD"
			? null
			: size > MAX_LOGGED_REQUEST
				? Promise.resolve(`(${Math.round(size / 1024)} KB, too big to keep)`)
				: req.clone().text();
	let caller: KeyAuth | null = null;
	const res = await route(req, url, path, acting, (a) => {
		caller = a;
	});
	const durationMs = Date.now() - started;
	const auth = caller as KeyAuth | null;
	// Cloned now: once the response is returned, its body is the client's.
	const responseBody = auth ? res.clone().text() : null;
	if (auth)
		waitUntil(
			track(async () =>
				recordRequest({
					organizationId: auth.organizationId,
					apiKeyId: auth.id,
					method: req.method,
					path,
					query: url.search.slice(1),
					status: res.status,
					userAgent: req.headers.get("user-agent"),
					requestBody: (await requestBody?.catch(() => null)) ?? null,
					responseBody: (await responseBody?.catch(() => null)) ?? null,
					durationMs,
					at: started,
				}),
			),
		);
	return res;
}

async function route(
	req: Request,
	url: URL,
	path: string,
	acting: string | null,
	identified: (auth: KeyAuth) => void,
): Promise<Response> {
	try {
		const header = req.headers.get("authorization");
		// An agent inbox's credential: its inbox's paths only, nothing else of the API.
		if (/^Bearer\s+mri_/.test(header ?? "")) {
			const agent = await authenticateInbox(header);
			if (!agent) {
				await limitIp(req);
				throw new ApiError(
					401,
					"invalid_credential",
					"Missing, revoked or invalid inbox credential",
				);
			}
			await limitKey(agent.id as string);
			if (acting)
				throw new ApiError(
					403,
					"invalid_access",
					"An inbox credential acts on its inbox only",
				);
			for (const [method, pattern, handler] of agentRoutes) {
				const m = pattern.exec(path);
				if (m && method === req.method)
					return await handler(
						req,
						agent,
						(m.groups ?? {}) as Record<string, string>,
						url,
					);
			}
			throw forbiddenForAgents();
		}
		const key = await authenticate(header);
		if (!key) await limitIp(req);
		else await limitKey(key.id);
		if (!key)
			throw new ApiError(
				401,
				req.headers.get("authorization") ? "invalid_api_key" : "missing_api_key",
				"Missing or invalid API key (Authorization: Bearer mr_…)",
			);
		const auth = acting ? await actFor(key, acting) : key;
		identified(auth);
		for (const [method, pattern, handler] of routes) {
			const m = pattern.exec(path);
			if (m && method === req.method)
				return await handler(req, auth, (m.groups ?? {}) as Record<string, string>, url);
		}
		// Agent inboxes with a full key: every inbox of its brands, and making them.
		for (const [method, pattern, handler] of adminRoutes) {
			const m = pattern.exec(path);
			if (m && method === req.method) {
				full(auth);
				return await handler(req, auth, (m.groups ?? {}) as Record<string, string>, url);
			}
		}
		for (const [method, pattern, handler] of agentRoutes) {
			const m = pattern.exec(path);
			if (m && method === req.method) {
				full(auth);
				return await handler(
					req,
					await keyActor(auth),
					(m.groups ?? {}) as Record<string, string>,
					url,
				);
			}
		}
		const known = [...routes, ...adminRoutes, ...agentRoutes].some(([, pattern]) =>
			pattern.test(path),
		);
		throw known
			? new ApiError(405, "method_not_allowed", "Method not allowed")
			: notFound("Route");
	} catch (error) {
		if (error instanceof ApiError) return error.toResponse();
		if (error instanceof z.ZodError)
			return validation(
				`${error.issues[0]?.path.join(".") || "body"}: ${error.issues[0]?.message}`,
			).toResponse();
		console.error("api: unexpected error", error);
		return new ApiError(
			500,
			"internal_server_error",
			"Something went wrong on our side",
		).toResponse();
	}
}
