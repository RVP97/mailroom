import { eq } from "drizzle-orm";
import { chatRoom, openRoomSocket, pushToRoom } from "./chat-room";
import { db, schema } from "./db";
import { baseUrl } from "./env";
import { organizationOf } from "./org-aws";

/**
 * Organization-wide live inbox hub: reuses the hibernatable ChatRoom Durable Object keyed by
 * `org:<organizationId>`. Dashboard tabs connect over `/inbox-live` for:
 *   - instant list & sidebar unread updates when emails, chats, replies or triage changes land
 *   - real-time teammate collision detection ("Ana is viewing" / "Ana is replying")
 */

const hubId = (organizationId: string) => `org:${organizationId}`;

export async function handleInboxLive(request: Request): Promise<Response> {
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
		return new Response("Expected a WebSocket", { status: 426 });
	const origin = request.headers.get("origin");
	if (!origin || origin !== new URL(baseUrl()).origin)
		return new Response("Forbidden", { status: 403 });
	const { auth } = await import("./auth");
	const session = await auth().api.getSession({ headers: request.headers });
	if (!session) return new Response("Sign in again", { status: 401 });
	const m = schema.member;
	const { requestedOrg, resolveOrgRef } = await import("./org-handles");
	const named = requestedOrg(request);
	const requested = named ? await resolveOrgRef(named) : named;
	const active =
		requested === undefined ? (session.session.activeOrganizationId ?? null) : requested;
	const rows = await db
		.select({ organizationId: m.organizationId })
		.from(m)
		.where(eq(m.userId, session.user.id));
	const org =
		rows.find((r) => r.organizationId === active) ??
		(requested === undefined ? rows[0] : undefined);
	if (!org) return new Response("Not found", { status: 404 });
	const id = hubId(org.organizationId);
	if (!chatRoom(id)) return new Response("Live updates aren't available", { status: 503 });
	const { memberAccess } = await import("./access");
	const access = await memberAccess(org.organizationId, session.user.id);
	const displayName =
		(session.user.name ?? "").trim() || session.user.email.split("@")[0] || "Teammate";
	return openRoomSocket(
		id,
		new Request(request.url, {
			headers: {
				upgrade: "websocket",
				"x-chat-role": "team",
				"x-chat-user": session.user.id,
				"x-chat-masked": access.can("emails:unmasked") ? "0" : "1",
				"x-chat-name": encodeURIComponent(displayName),
				"x-chat-avatar": /^https:\/\//.test(session.user.image ?? "")
					? (session.user.image as string)
					: "",
				"x-chat-conversation": "",
			},
		}),
	);
}

/**
 * Best-effort push to connected dashboard tabs of a brand's organization.
 * Never throws: D1 already has the write, and tabs refresh on reconnect.
 */
export async function notifyInboxChange(
	brandId: string,
	detail: {
		kind:
			| "inbound"
			| "chat"
			| "reply"
			| "note"
			| "updated"
			| "started"
			| "merged"
			| "bulk"
			| "deleted";
		conversation_id?: string;
		channel?: string;
		subject?: string | null;
		contact?: string | null;
		unread?: boolean;
	},
) {
	try {
		const orgId = await organizationOf(brandId);
		if (!orgId) return;
		await pushToRoom(hubId(orgId), { type: "inbox.changed", ...detail });
		if (detail.unread && (detail.kind === "chat" || detail.kind === "inbound")) {
			const hasAlert = await hasAlertChannel(orgId);
			if (hasAlert) {
				const { dispatchTeamAlert } = await import("./team-alerts");
				const event = detail.kind === "chat" ? "chat.started" : "inbox.inbound";
				await dispatchTeamAlert(brandId, event, {
					title:
						detail.kind === "chat"
							? `New live chat${detail.contact ? ` from ${detail.contact}` : ""}`
							: `New email: ${detail.subject || "(no subject)"}`,
					body:
						detail.kind === "chat"
							? detail.subject || "A visitor sent a message in live chat."
							: detail.contact
								? `From ${detail.contact}`
								: undefined,
					path: detail.conversation_id
						? `/received/${detail.conversation_id}`
						: "/received",
					severity: "info",
				});
			}
		}
	} catch {
		// Best effort: never fail the caller after the write succeeded.
	}
}

/** Fast check so inbound email/chat skips importing team-alerts.ts when no channel exists. */
async function hasAlertChannel(orgId: string): Promise<boolean> {
	try {
		const row = await db
			.select({ id: schema.orgAlertChannels.id })
			.from(schema.orgAlertChannels)
			.where(eq(schema.orgAlertChannels.organization_id, orgId))
			.get();
		return Boolean(row);
	} catch {
		return false;
	}
}

/** Fast check before lazily importing ai.ts on inbound email/chat arrival. */
export async function hasAutoAi(brandId: string): Promise<boolean> {
	try {
		const orgId = await organizationOf(brandId);
		if (!orgId) return false;
		const row = await db
			.select({
				mode: schema.orgAiSettings.auto_mode,
				key: schema.orgAiSettings.api_key_encrypted,
			})
			.from(schema.orgAiSettings)
			.where(eq(schema.orgAiSettings.organization_id, orgId))
			.get();
		return Boolean(row?.key && row.mode !== "off");
	} catch {
		return false;
	}
}
