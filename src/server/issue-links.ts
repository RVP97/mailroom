import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { notFound, validation } from "./errors";
import { decryptSecret, encryptSecret, organizationOf } from "./org-aws";
import { iso } from "./time";

/**
 * Conversation <-> GitHub / Linear issue links + inbound webhook handlers:
 *  - Link any GitHub issue, Linear issue, or external ticket URL to an Inbox conversation.
 *  - Inbound POST /hooks/issues/:orgId/:provider verifies GitHub (X-Hub-Signature-256) or Linear
 *    (Linear-Signature) webhooks: when an issue is closed/completed, marks linked rows closed,
 *    posts an internal note on each linked conversation, and reopens it so support notifies the customer.
 *  - Inbound POST /hooks/slack/:orgId verifies X-Slack-Signature (v0=HMAC-SHA256) and routes
 *    two-way Slack replies referencing a conversation id (conv_...) straight back into Mailroom!
 */

export type IssueLinkRow = typeof schema.conversationIssues.$inferSelect;
export type IntegrationKind = "github" | "linear" | "slack" | "whatsapp";

const linkInput = z.object({
	url: z.string().trim().url("url: paste a valid GitHub, Linear, or issue URL").max(500),
	title: z.string().trim().max(200).optional(),
	reopen_on_close: z.boolean().optional(),
});

export function parseIssueUrl(rawUrl: string): {
	provider: "github" | "linear" | "url";
	external_id: string;
	defaultTitle: string;
} {
	const gh = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/i.exec(rawUrl);
	if (gh?.[1] && gh[2]) {
		const ext = `${gh[1].toLowerCase()}#${gh[2]}`;
		return { provider: "github", external_id: ext, defaultTitle: `${gh[1]} #${gh[2]}` };
	}
	const lin = /^https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z0-9]+-\d+)/i.exec(rawUrl);
	if (lin?.[1]) {
		const ext = lin[1].toUpperCase();
		return { provider: "linear", external_id: ext, defaultTitle: ext };
	}
	return {
		provider: "url",
		external_id: rawUrl.slice(0, 200),
		defaultTitle: rawUrl.slice(0, 80),
	};
}

export async function listConversationIssues(conversationId: string) {
	return db
		.select()
		.from(schema.conversationIssues)
		.where(eq(schema.conversationIssues.conversation_id, conversationId))
		.orderBy(desc(schema.conversationIssues.created_at));
}

export async function linkConversationIssue(
	brandId: string,
	conversationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = linkInput.parse(raw ?? {});
	const parsed = parseIssueUrl(v.url);
	const row: IssueLinkRow = {
		id: `isl_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
		organization_id: brandId,
		conversation_id: conversationId,
		provider: parsed.provider,
		external_id: parsed.external_id,
		title: v.title?.trim() || parsed.defaultTitle,
		url: v.url,
		status: "open",
		reopen_on_close: v.reopen_on_close ?? true,
		created_by: userId,
		created_at: iso(now),
		updated_at: iso(now),
	};
	await db.insert(schema.conversationIssues).values(row);
	return row;
}

export async function unlinkConversationIssue(conversationId: string, id: string) {
	const [removed] = await db
		.delete(schema.conversationIssues)
		.where(
			and(
				eq(schema.conversationIssues.id, id),
				eq(schema.conversationIssues.conversation_id, conversationId),
			),
		)
		.returning({ id: schema.conversationIssues.id });
	if (!removed) throw notFound("Issue link");
	return { deleted: true, id: removed.id };
}

// ── Inbound webhook integration secrets ──────────────────────────────────────

export async function listOrgWebhookIntegrations(organizationId: string) {
	const org = await organizationOf(organizationId);
	const rows = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(eq(schema.orgWebhookIntegrations.organization_id, org));
	const base = baseUrl().replace(/\/$/, "");
	return (["github", "linear", "slack"] as const).map((kind) => {
		const row = rows.find((r) => r.kind === kind);
		return {
			kind,
			configured: Boolean(row?.secret_encrypted),
			secret_hint: row?.secret_hint ?? null,
			enabled: row?.enabled ?? false,
			webhook_url:
				kind === "slack"
					? `${base}/hooks/slack/${org}`
					: `${base}/hooks/issues/${org}/${kind}`,
			updated_at: row?.updated_at ?? null,
		};
	});
}

export async function saveOrgWebhookIntegration(
	organizationId: string,
	raw: {
		kind: IntegrationKind;
		secret?: string;
		enabled?: boolean;
		config?: Record<string, string>;
	},
	userId: string | null = null,
	now = Date.now(),
) {
	const org = await organizationOf(organizationId);
	const existing = await db
		.select()
		.from(schema.orgWebhookIntegrations)
		.where(
			and(
				eq(schema.orgWebhookIntegrations.organization_id, org),
				eq(schema.orgWebhookIntegrations.kind, raw.kind),
			),
		)
		.get();
	let encrypted = existing?.secret_encrypted ?? null;
	let hint = existing?.secret_hint ?? null;
	if (raw.secret?.trim()) {
		if (raw.secret.trim().length < 6) throw validation("secret: must be at least 6 characters");
		encrypted = await encryptSecret(raw.secret.trim());
		hint = `…${raw.secret.trim().slice(-4)}`;
	}
	const row = {
		organization_id: org,
		kind: raw.kind,
		secret_encrypted: encrypted,
		secret_hint: hint,
		config: raw.config ?? existing?.config ?? null,
		enabled: raw.enabled ?? existing?.enabled ?? Boolean(encrypted),
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
	return {
		kind: row.kind,
		configured: Boolean(row.secret_encrypted),
		secret_hint: row.secret_hint,
		enabled: row.enabled,
	};
}

// ── Signature verification & inbound handlers ────────────────────────────────

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

function safeEq(a: string, b: string) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** POST /hooks/issues/:orgId/:provider (github | linear). */
export async function handleIssueWebhook(
	orgId: string,
	provider: "github" | "linear",
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
				eq(schema.orgWebhookIntegrations.kind, provider),
				eq(schema.orgWebhookIntegrations.enabled, true),
			),
		)
		.get();
	if (!integration?.secret_encrypted) return new Response("Not configured", { status: 404 });

	const rawBody = await request.text();
	const secret = await decryptSecret(integration.secret_encrypted);
	const expected = await hmacHex(secret, rawBody);
	const got =
		provider === "github"
			? (request.headers.get("x-hub-signature-256") ?? "")
					.replace(/^sha256=/i, "")
					.toLowerCase()
			: (request.headers.get("linear-signature") ?? "").toLowerCase();
	if (!got || !safeEq(expected, got)) return new Response("Invalid signature", { status: 401 });

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(rawBody) as Record<string, unknown>;
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}

	let externalId: string | null = null;
	let closed = false;
	let title = "";

	if (provider === "github") {
		const action = String(payload.action ?? "");
		const repo = String(
			(payload.repository as Record<string, unknown> | undefined)?.full_name ?? "",
		).toLowerCase();
		const issue = (payload.issue ?? payload.pull_request) as
			| Record<string, unknown>
			| undefined;
		if (repo && issue?.number) {
			externalId = `${repo}#${issue.number}`;
			title = String(issue.title ?? externalId);
			closed = action === "closed";
		}
	} else {
		const data = (payload.data ?? {}) as Record<string, unknown>;
		const stateType = String(
			(data.state as Record<string, unknown> | undefined)?.type ?? "",
		).toLowerCase();
		if (data.identifier) {
			externalId = String(data.identifier).toUpperCase();
			title = String(data.title ?? externalId);
			closed = stateType === "completed" || stateType === "canceled";
		}
	}

	if (!externalId || !closed) return Response.json({ ok: true, updated: 0 });

	const { brandIds } = await import("./brands");
	const brands = await brandIds(orgId);
	const links = await db
		.select()
		.from(schema.conversationIssues)
		.where(
			and(
				eq(schema.conversationIssues.provider, provider),
				eq(schema.conversationIssues.external_id, externalId),
			),
		);
	const matching = links.filter((l) => brands.includes(l.organization_id));
	let updated = 0;

	const { notifyInboxChange } = await import("./inbox-live");
	for (const link of matching) {
		await db
			.update(schema.conversationIssues)
			.set({ status: "closed", updated_at: iso(now) })
			.where(eq(schema.conversationIssues.id, link.id));

		await db.insert(schema.conversationNotes).values({
			id: `nt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: link.organization_id,
			conversation_id: link.conversation_id,
			author_type: "agent",
			author_id: null,
			author_name: provider === "github" ? "GitHub" : "Linear",
			text: `Linked ${provider === "github" ? "GitHub" : "Linear"} issue ${link.external_id} ("${title || link.title}") was closed. Ready to notify the customer!\n${link.url}`,
			mentions: null,
			created_at: iso(now),
			updated_at: iso(now),
		});

		if (link.reopen_on_close) {
			await db
				.update(schema.conversations)
				.set({ status: "open", snoozed_until: null, updated_at: iso(now) })
				.where(eq(schema.conversations.id, link.conversation_id));
		}
		await notifyInboxChange(link.organization_id, {
			kind: "updated",
			conversation_id: link.conversation_id,
		});
		updated++;
	}

	return Response.json({ ok: true, external_id: externalId, updated });
}

/**
 * POST /hooks/slack/:orgId: Slack Events API receiver for two-way thread replies.
 * Verifies X-Slack-Signature (v0=HMAC-SHA256) and posts messages containing a conversation id
 * (`conv_...` or explicit conversation reference) as an internal note or reply.
 */
export async function handleSlackInboundWebhook(
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
				eq(schema.orgWebhookIntegrations.kind, "slack"),
				eq(schema.orgWebhookIntegrations.enabled, true),
			),
		)
		.get();
	if (!integration?.secret_encrypted) return new Response("Not configured", { status: 404 });

	const rawBody = await request.text();
	const ts = request.headers.get("x-slack-request-timestamp") ?? "";
	const sig = request.headers.get("x-slack-signature") ?? "";
	if (!ts || !sig) return new Response("Missing Slack signature", { status: 401 });

	const secret = await decryptSecret(integration.secret_encrypted);
	const expected = `v0=${await hmacHex(secret, `v0:${ts}:${rawBody}`)}`;
	if (!safeEq(expected, sig)) return new Response("Invalid signature", { status: 401 });

	const payload = JSON.parse(rawBody) as {
		type?: string;
		challenge?: string;
		event?: {
			type?: string;
			bot_id?: string;
			text?: string;
			user?: string;
		};
	};
	if (payload.type === "url_verification" && payload.challenge) {
		return Response.json({ challenge: payload.challenge });
	}

	const ev = payload.event;
	if (!ev || ev.type !== "message" || ev.bot_id || !ev.text) {
		return Response.json({ ok: true, ignored: true });
	}

	// Support `/reply conv_xxx Hello!` or `conv_xxx: Hello!` from Slack
	const match = /(?:^|\s)(conv_[a-zA-Z0-9_-]{6,40})[:\s]+([\s\S]+)$/.exec(ev.text.trim());
	if (!match?.[1] || !match[2]?.trim()) {
		return Response.json({ ok: true, ignored: true });
	}
	const convId = match[1];
	const replyText = match[2].trim();

	const { brandIds } = await import("./brands");
	const brands = await brandIds(orgId);
	const conv = await db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, convId))
		.get();
	if (!conv || !brands.includes(conv.organization_id)) {
		return Response.json({ ok: true, found: false });
	}

	// Note: if prefixed with "note:", save as internal note; otherwise save as a team note/draft or chat reply
	const isNote = /^note:\s*/i.test(replyText);
	const cleanText = replyText.replace(/^note:\s*/i, "").trim();
	const { notifyInboxChange } = await import("./inbox-live");

	if (isNote || conv.channel === "email") {
		await db.insert(schema.conversationNotes).values({
			id: `nt_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: conv.organization_id,
			conversation_id: conv.id,
			author_type: "person",
			author_id: null,
			author_name: `Slack (${ev.user ?? "teammate"})`,
			text: cleanText,
			mentions: null,
			created_at: iso(now),
			updated_at: iso(now),
		});
		await notifyInboxChange(conv.organization_id, { kind: "note", conversation_id: conv.id });
		return Response.json({ ok: true, mode: "note", conversation_id: conv.id });
	}

	// Website chat: send straight to the live visitor!
	const { teamSays } = await import("./chat");
	await teamSays(
		{
			type: "person",
			id: null,
			name: `Slack (${ev.user ?? "Team"})`,
			organizationId: orgId,
			permissions: new Set(["read", "triage", "notes", "send"]),
			reader: `slack:${ev.user ?? "team"}`,
		},
		conv,
		{ text: cleanText, via: "api" },
		now,
	);
	return Response.json({ ok: true, mode: "chat_reply", conversation_id: conv.id });
}
