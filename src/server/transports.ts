import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRANSPORT_PROVIDERS, type TransportProvider } from "../lib/transports";
import { db, schema } from "./db";
import { ApiError, validation } from "./errors";
import { decryptSecret, encryptSecret } from "./org-aws";
import { iso } from "./time";

/**
 * Optional pluggable sending transport per brand: Amazon SES is always the default ($0.10/1k),
 * but new self-hosted installs can plug in a Resend or Postmark API key to start sending in
 * 2 minutes while waiting for AWS SES production access approval.
 */

export type BrandTransportRow = typeof schema.brandTransports.$inferSelect;

const transportInput = z.object({
	provider: z.enum(TRANSPORT_PROVIDERS),
	api_key: z.string().trim().min(6).max(500).optional(),
	clear_key: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export function transportView(row: BrandTransportRow | null) {
	return {
		provider: (row?.provider ?? "ses") as TransportProvider,
		configured: Boolean(row?.api_key_encrypted),
		api_key_hint: row?.api_key_hint ?? null,
		enabled: Boolean(row?.enabled && row.provider !== "ses" && row.api_key_encrypted),
		updated_at: row?.updated_at ?? null,
	};
}

export async function getBrandTransport(brandId: string) {
	const row =
		(await db
			.select()
			.from(schema.brandTransports)
			.where(eq(schema.brandTransports.organization_id, brandId))
			.get()) ?? null;
	return row;
}

export async function saveBrandTransport(
	brandId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = transportInput.parse(raw ?? {});
	const prev = await getBrandTransport(brandId);

	let encrypted = prev?.api_key_encrypted ?? null;
	let hint = prev?.api_key_hint ?? null;
	if (v.clear_key || v.provider === "ses") {
		if (v.clear_key) {
			encrypted = null;
			hint = null;
		}
	} else if (v.api_key) {
		encrypted = await encryptSecret(v.api_key);
		hint = `…${v.api_key.slice(-4)}`;
	}

	const enabled =
		v.provider === "ses" ? false : (v.enabled ?? (v.api_key ? true : (prev?.enabled ?? false)));
	if (enabled && !encrypted)
		throw validation(`api_key: paste your ${v.provider} API key to enable this transport`);

	const row: BrandTransportRow = {
		organization_id: brandId,
		provider: v.provider,
		api_key_encrypted: encrypted,
		api_key_hint: hint,
		enabled,
		updated_by: userId,
		updated_at: iso(now),
	};
	await db.insert(schema.brandTransports).values(row).onConflictDoUpdate({
		target: schema.brandTransports.organization_id,
		set: row,
	});
	return transportView(row);
}

export interface ExternalSendPayload {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	reply_to?: string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
}

/**
 * If the brand has an active non-SES transport (Resend or Postmark), sends via its HTTP API
 * and returns the provider's message id. Otherwise returns null so the caller uses Amazon SES.
 */
export async function sendViaExternalTransport(
	brandId: string,
	payload: ExternalSendPayload,
): Promise<string | null> {
	const row = await getBrandTransport(brandId);
	if (!row?.enabled || row.provider === "ses" || !row.api_key_encrypted) return null;

	const apiKey = await decryptSecret(row.api_key_encrypted);
	if (row.provider === "resend") {
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				from: payload.from,
				to: payload.to,
				...(payload.cc?.length ? { cc: payload.cc } : {}),
				...(payload.bcc?.length ? { bcc: payload.bcc } : {}),
				...(payload.reply_to?.length ? { reply_to: payload.reply_to } : {}),
				subject: payload.subject,
				...(payload.html ? { html: payload.html } : {}),
				...(payload.text ? { text: payload.text } : {}),
				...(payload.headers && Object.keys(payload.headers).length
					? { headers: payload.headers }
					: {}),
			}),
		});
		if (!res.ok) {
			const msg = await res.text().catch(() => res.statusText);
			throw new ApiError(
				502,
				"transport_error",
				`Resend HTTP ${res.status}: ${msg.slice(0, 240)}`,
			);
		}
		const data = (await res.json()) as { id?: string };
		return `resend:${data.id ?? crypto.randomUUID()}`;
	}

	if (row.provider === "postmark") {
		const res = await fetch("https://api.postmarkapp.com/email", {
			method: "POST",
			headers: {
				accept: "application/json",
				"content-type": "application/json",
				"x-postmark-server-token": apiKey,
			},
			body: JSON.stringify({
				From: payload.from,
				To: payload.to.join(", "),
				...(payload.cc?.length ? { Cc: payload.cc.join(", ") } : {}),
				...(payload.bcc?.length ? { Bcc: payload.bcc.join(", ") } : {}),
				...(payload.reply_to?.[0] ? { ReplyTo: payload.reply_to[0] } : {}),
				Subject: payload.subject,
				...(payload.html ? { HtmlBody: payload.html } : {}),
				...(payload.text ? { TextBody: payload.text } : {}),
				...(payload.headers && Object.keys(payload.headers).length
					? {
							Headers: Object.entries(payload.headers).map(([Name, Value]) => ({
								Name,
								Value,
							})),
						}
					: {}),
			}),
		});
		if (!res.ok) {
			const msg = await res.text().catch(() => res.statusText);
			throw new ApiError(
				502,
				"transport_error",
				`Postmark HTTP ${res.status}: ${msg.slice(0, 240)}`,
			);
		}
		const data = (await res.json()) as { MessageID?: string };
		return `postmark:${data.MessageID ?? crypto.randomUUID()}`;
	}

	return null;
}
