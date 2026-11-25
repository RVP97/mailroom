import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { BILLING_PROVIDERS, type BillingProvider } from "../lib/billing-providers";
import { domainFromEmail, upsertCompany } from "./companies";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { notFound, validation } from "./errors";
import { decryptSecret, encryptSecret } from "./org-aws";
import { iso } from "./time";

/**
 * Native Stripe, Polar & Lemon Squeezy webhook connectors.
 * Paste a provider webhook signing secret once -> Mailroom verifies every webhook signature,
 * syncs the customer into Contacts & B2B Companies (plan, MRR), and fires normalized
 * billing.* contact events with revenue attribution so Automations run with zero glue code.
 */

export type BillingConnectorRow = typeof schema.billingConnectors.$inferSelect;

const connectorInput = z.object({
	id: z.string().optional(),
	provider: z.enum(BILLING_PROVIDERS),
	name: z.string().trim().min(1, "name: give the connector a name").max(80),
	signing_secret: z.string().trim().min(6).max(500).optional(),
	enabled: z.boolean().optional(),
});

export function connectorWebhookUrl(id: string) {
	return `${baseUrl().replace(/\/$/, "")}/hooks/billing/${id}`;
}

export function billingConnectorView(row: BillingConnectorRow) {
	return {
		id: row.id,
		brand_id: row.organization_id,
		provider: row.provider as BillingProvider,
		name: row.name,
		secret_hint: row.secret_hint,
		webhook_url: connectorWebhookUrl(row.id),
		enabled: row.enabled,
		events_processed: row.events_processed,
		last_event_at: row.last_event_at,
		last_error: row.last_error,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

export async function listBillingConnectors(brands: string[]) {
	if (!brands.length) return [];
	const rows = await db
		.select()
		.from(schema.billingConnectors)
		.where(inArray(schema.billingConnectors.organization_id, brands))
		.orderBy(desc(schema.billingConnectors.created_at));
	return rows.map(billingConnectorView);
}

export async function saveBillingConnector(
	brandId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = connectorInput.parse(raw ?? {});
	const existing = v.id
		? await db
				.select()
				.from(schema.billingConnectors)
				.where(
					and(
						eq(schema.billingConnectors.id, v.id),
						eq(schema.billingConnectors.organization_id, brandId),
					),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("Billing connector");

	let encrypted = existing?.secret_encrypted ?? "";
	let hint = existing?.secret_hint ?? "";
	if (v.signing_secret) {
		encrypted = await encryptSecret(v.signing_secret);
		hint = `…${v.signing_secret.slice(-4)}`;
	} else if (!existing) {
		throw validation(
			"signing_secret: paste the webhook signing secret from your billing provider",
		);
	}

	const row: BillingConnectorRow = {
		id: existing?.id ?? `bil_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: brandId,
		provider: v.provider,
		name: v.name,
		secret_encrypted: encrypted,
		secret_hint: hint,
		enabled: v.enabled ?? existing?.enabled ?? true,
		events_processed: existing?.events_processed ?? 0,
		last_event_at: existing?.last_event_at ?? null,
		last_error: v.signing_secret ? null : (existing?.last_error ?? null),
		created_by: existing?.created_by ?? userId,
		created_at: existing?.created_at ?? iso(now),
		updated_at: iso(now),
	};
	if (existing) {
		await db
			.update(schema.billingConnectors)
			.set(row)
			.where(eq(schema.billingConnectors.id, existing.id));
	} else {
		await db.insert(schema.billingConnectors).values(row);
	}
	return billingConnectorView(row);
}

export async function deleteBillingConnector(brands: string[], id: string) {
	if (!brands.length) throw notFound("Billing connector");
	const [removed] = await db
		.delete(schema.billingConnectors)
		.where(
			and(
				eq(schema.billingConnectors.id, id),
				inArray(schema.billingConnectors.organization_id, brands),
			),
		)
		.returning({ id: schema.billingConnectors.id });
	if (!removed) throw notFound("Billing connector");
	return { deleted: true, id: removed.id };
}

// ── HMAC signature verification ──────────────────────────────────────────────

async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacBase64(secretBytes: Uint8Array, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		secretBytes as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	let bin = "";
	for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
	return btoa(bin);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function verifyBillingSignature(
	provider: BillingProvider,
	secret: string,
	rawBody: string,
	headers: Headers,
): Promise<boolean> {
	if (provider === "stripe") {
		const header = headers.get("stripe-signature") ?? "";
		const parts = Object.fromEntries(
			header.split(",").map((p) => {
				const i = p.indexOf("=");
				return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
			}),
		);
		if (!parts.t || !parts.v1) return false;
		const expected = await hmacHex(secret, `${parts.t}.${rawBody}`);
		return timingSafeEqual(expected, parts.v1);
	}
	if (provider === "lemonsqueezy") {
		const sig = (headers.get("x-signature") ?? "").trim().toLowerCase();
		if (!sig) return false;
		const expected = await hmacHex(secret, rawBody);
		return timingSafeEqual(expected, sig);
	}
	// Polar uses Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature: "v1,<b64>")
	const id = headers.get("webhook-id") ?? "";
	const ts = headers.get("webhook-timestamp") ?? "";
	const sigHeader = headers.get("webhook-signature") ?? "";
	if (!id || !ts || !sigHeader) return false;
	const rawSecret = secret.startsWith("polar_whs_")
		? secret.slice("polar_whs_".length)
		: secret.startsWith("whsec_")
			? secret.slice("whsec_".length)
			: secret;
	let secretBytes: Uint8Array;
	try {
		const bin = atob(rawSecret);
		secretBytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	} catch {
		secretBytes = new TextEncoder().encode(secret);
	}
	const expected = await hmacBase64(secretBytes, `${id}.${ts}.${rawBody}`);
	return sigHeader
		.split(/\s+/)
		.map((s) => s.replace(/^v1,/, ""))
		.some((cand) => timingSafeEqual(expected, cand));
}

// ── Event normalization ──────────────────────────────────────────────────────

export interface NormalizedBillingEvent {
	event: string;
	email: string;
	first_name?: string;
	last_name?: string;
	plan?: string;
	mrr?: number;
	value?: number;
	currency?: string;
	data: Record<string, unknown>;
}

function splitName(full: string | null | undefined) {
	const clean = (full ?? "").trim();
	if (!clean) return {};
	const parts = clean.split(/\s+/);
	return { first_name: parts[0], last_name: parts.slice(1).join(" ") || undefined };
}

export function normalizeBillingPayload(
	provider: BillingProvider,
	payload: Record<string, unknown>,
): NormalizedBillingEvent | null {
	if (provider === "stripe") {
		const type = String(payload.type ?? "");
		const obj = ((payload.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<
			string,
			unknown
		>;
		const details = (obj.customer_details ?? {}) as Record<string, unknown>;
		const email = String(obj.customer_email ?? details.email ?? obj.receipt_email ?? "")
			.trim()
			.toLowerCase();
		if (!email?.includes("@")) return null;
		const map: Record<string, string> = {
			"checkout.session.completed": "billing.checkout_completed",
			"invoice.payment_succeeded": "billing.payment_succeeded",
			"invoice.payment_failed": "billing.payment_failed",
			"customer.subscription.created": "billing.subscription_started",
			"customer.subscription.updated": "billing.subscription_updated",
			"customer.subscription.deleted": "billing.subscription_canceled",
			"customer.subscription.trial_will_end": "billing.trial_ending",
		};
		const event = map[type] ?? `billing.${type.replace(/[^a-z0-9]+/gi, "_")}`;
		const cents = Number(obj.amount_paid ?? obj.amount_total ?? obj.amount_due ?? 0);
		const currency = obj.currency ? String(obj.currency).toUpperCase() : "USD";
		const value = Number.isFinite(cents) && cents > 0 ? cents / 100 : undefined;
		const planObj = (obj.plan ?? {}) as Record<string, unknown>;
		const plan =
			String(
				planObj.nickname ??
					planObj.id ??
					(obj.metadata as Record<string, unknown> | undefined)?.plan ??
					"",
			).trim() || undefined;
		return {
			event,
			email,
			...splitName(String(details.name ?? obj.customer_name ?? "")),
			plan,
			mrr: value && type.includes("subscription") ? value : undefined,
			value,
			currency,
			data: { provider: "stripe", stripe_type: type, object_id: obj.id ?? null },
		};
	}

	if (provider === "polar") {
		const type = String(payload.type ?? "");
		const d = (payload.data ?? {}) as Record<string, unknown>;
		const customer = (d.customer ?? d.user ?? {}) as Record<string, unknown>;
		const email = String(customer.email ?? d.customer_email ?? "")
			.trim()
			.toLowerCase();
		if (!email?.includes("@")) return null;
		const map: Record<string, string> = {
			"order.paid": "billing.payment_succeeded",
			"order.created": "billing.checkout_completed",
			"subscription.active": "billing.subscription_started",
			"subscription.updated": "billing.subscription_updated",
			"subscription.canceled": "billing.subscription_canceled",
			"subscription.revoked": "billing.subscription_canceled",
		};
		const event = map[type] ?? `billing.${type.replace(/[^a-z0-9]+/gi, "_")}`;
		const cents = Number(d.amount ?? d.total_amount ?? 0);
		const value = Number.isFinite(cents) && cents > 0 ? cents / 100 : undefined;
		const currency = d.currency ? String(d.currency).toUpperCase() : "USD";
		const product = (d.product ?? {}) as Record<string, unknown>;
		const plan = String(product.name ?? "").trim() || undefined;
		return {
			event,
			email,
			...splitName(String(customer.name ?? "")),
			plan,
			mrr: value && type.startsWith("subscription") ? value : undefined,
			value,
			currency,
			data: { provider: "polar", polar_type: type, object_id: d.id ?? null },
		};
	}

	// Lemon Squeezy
	const meta = (payload.meta ?? {}) as Record<string, unknown>;
	const type = String(meta.event_name ?? "");
	const attrs = ((payload.data as Record<string, unknown> | undefined)?.attributes ??
		{}) as Record<string, unknown>;
	const email = String(attrs.user_email ?? "")
		.trim()
		.toLowerCase();
	if (!email?.includes("@")) return null;
	const map: Record<string, string> = {
		order_created: "billing.checkout_completed",
		subscription_created: "billing.subscription_started",
		subscription_payment_success: "billing.payment_succeeded",
		subscription_payment_failed: "billing.payment_failed",
		subscription_cancelled: "billing.subscription_canceled",
	};
	const event = map[type] ?? `billing.${type.replace(/[^a-z0-9]+/gi, "_")}`;
	const cents = Number(attrs.total ?? attrs.subtotal ?? 0);
	const value = Number.isFinite(cents) && cents > 0 ? cents / 100 : undefined;
	const currency = attrs.currency ? String(attrs.currency).toUpperCase() : "USD";
	const plan = String(attrs.variant_name ?? attrs.product_name ?? "").trim() || undefined;
	return {
		event,
		email,
		...splitName(String(attrs.user_name ?? "")),
		plan,
		mrr: value && type.startsWith("subscription") ? value : undefined,
		value,
		currency,
		data: { provider: "lemonsqueezy", ls_type: type },
	};
}

/** Public webhook handler mounted at POST /hooks/billing/:id. */
export async function handleBillingWebhook(
	id: string,
	request: Request,
	now = Date.now(),
): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	const connector = await db
		.select()
		.from(schema.billingConnectors)
		.where(eq(schema.billingConnectors.id, id))
		.get();
	if (!connector?.enabled) return new Response("Not found", { status: 404 });

	const rawBody = await request.text();
	const secret = await decryptSecret(connector.secret_encrypted);
	const ok = await verifyBillingSignature(
		connector.provider as BillingProvider,
		secret,
		rawBody,
		request.headers,
	);
	if (!ok) {
		await db
			.update(schema.billingConnectors)
			.set({ last_error: "Invalid webhook signature", updated_at: iso(now) })
			.where(eq(schema.billingConnectors.id, connector.id));
		return new Response("Invalid signature", { status: 401 });
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(rawBody) as Record<string, unknown>;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}

	const norm = normalizeBillingPayload(connector.provider as BillingProvider, parsed);
	if (norm) {
		const [{ upsertContact }, { recordEvent }] = await Promise.all([
			import("./contacts"),
			import("./automations"),
		]);
		await upsertContact(connector.organization_id, {
			email: norm.email,
			...(norm.first_name ? { first_name: norm.first_name } : {}),
			...(norm.last_name ? { last_name: norm.last_name } : {}),
		});
		const dom = domainFromEmail(norm.email);
		if (dom && (norm.plan || norm.mrr)) {
			const name = dom.split(".")[0] ?? dom;
			await upsertCompany(
				connector.organization_id,
				{
					name: name.charAt(0).toUpperCase() + name.slice(1),
					domain: dom,
					...(norm.plan ? { plan: norm.plan } : {}),
					...(norm.mrr ? { mrr: norm.mrr } : {}),
				},
				{ now },
			).catch(() => {});
		}
		await recordEvent(
			connector.organization_id,
			{
				event: norm.event,
				email: norm.email,
				data: {
					...norm.data,
					...(norm.plan ? { plan: norm.plan } : {}),
					...(norm.value ? { value: norm.value, currency: norm.currency } : {}),
				},
			},
			now,
		);
	}

	await db
		.update(schema.billingConnectors)
		.set({
			events_processed: sql`${schema.billingConnectors.events_processed} + 1`,
			last_event_at: iso(now),
			last_error: null,
			updated_at: iso(now),
		})
		.where(eq(schema.billingConnectors.id, connector.id));

	return Response.json({ received: true, event: norm?.event ?? null });
}
