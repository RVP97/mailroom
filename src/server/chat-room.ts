import { DurableObject, env } from "cloudflare:workers";

/**
 * One website chat's live line (src/server/chat.ts): the open WebSockets of the visitor's tabs
 * and of the team's dashboards. The Worker writes every message to D1 first and then tells the
 * room, which pushes it to whoever is connected; the sockets themselves only carry "typing…" and
 * "seen". It stores nothing (D1 is the record), and idle sockets hibernate, so a chat left open
 * costs nothing while nobody writes.
 */

export type ChatRole = "visitor" | "team";

interface Attached {
	role: ChatRole;
	/** Who it is, for "Ana is typing…" (a team member's first name; the visitor's own name). */
	name: string;
	conversation: string;
	/** A team member without emails:unmasked: runs of 4+ digits in text arrive as dots. */
	masked?: boolean;
}

const dots = (s: string) => s.replace(/\d{4,}/g, (m) => "•".repeat(m.length));

/** The event as a masked member gets it: the message's and the typing preview's text dotted. */
function maskedEvent(event: unknown): unknown {
	if (!event || typeof event !== "object") return event;
	const e = event as Record<string, unknown>;
	const out: Record<string, unknown> = { ...e };
	if (typeof e.text === "string") out.text = dots(e.text);
	if (e.message && typeof e.message === "object") {
		const m = { ...(e.message as Record<string, unknown>) };
		if (typeof m.text === "string") m.text = dots(m.text);
		if (typeof m.html === "string") m.html = null;
		out.message = m;
	}
	return out;
}

export type RoomEvent =
	| { type: "message"; message: unknown; team?: unknown }
	| { type: "conversation"; status: string }
	| { type: "deleted" }
	| { type: string; [k: string]: unknown };

const PING = '{"type":"ping"}';
const PONG = '{"type":"pong"}';

export class ChatRoom extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Keep-alives are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
	}

	private sockets(role?: ChatRole, except?: WebSocket) {
		return this.ctx
			.getWebSockets(role)
			.filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN);
	}

	private send(list: WebSocket[], event: unknown) {
		const data = JSON.stringify(event);
		let dotted: string | undefined;
		for (const ws of list) {
			try {
				const me = ws.deserializeAttachment() as Attached | null;
				if (me?.masked) {
					dotted ??= JSON.stringify(maskedEvent(event));
					ws.send(dotted);
				} else ws.send(data);
			} catch {}
		}
	}

	/** A socket of the visitor's or the team's (the Worker checked who it is). */
	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response("Expected a WebSocket", { status: 426 });
		const role = request.headers.get("x-chat-role") === "team" ? "team" : "visitor";
		const attached: Attached = {
			role,
			name: (() => {
				const raw = request.headers.get("x-chat-name") ?? "";
				try {
					return decodeURIComponent(raw).slice(0, 80);
				} catch {
					return raw.slice(0, 80);
				}
			})(),
			conversation: request.headers.get("x-chat-conversation") ?? "",
			masked: role === "team" && request.headers.get("x-chat-masked") !== "0",
		};
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server, [role]);
		server.serializeAttachment(attached);
		server.send(
			JSON.stringify({
				type: "hello",
				visitor_online: this.sockets("visitor", server).length > 0,
				team_online: this.sockets("team", server).length > 0,
			}),
		);
		if (role === "visitor")
			this.send(this.sockets("team"), { type: "presence", visitor: true });
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Pushes an event: the visitor's view to the visitor, the team's to the team. */
	async broadcast(event: RoomEvent, teamEvent?: RoomEvent) {
		this.send(this.sockets("visitor"), event);
		this.send(this.sockets("team"), teamEvent ?? event);
	}

	/** Who is connected now. */
	async presence() {
		return { visitor: this.sockets("visitor").length, team: this.sockets("team").length };
	}

	/** Closes every socket (the chat was deleted, or its key rotated). */
	async closeAll(reason = "closed") {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(4000, reason);
			} catch {}
		}
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== "string" || message.length > 2000) return;
		let m: { type?: unknown; on?: unknown; text?: unknown };
		try {
			m = JSON.parse(message);
		} catch {
			return;
		}
		const me = ws.deserializeAttachment() as Attached | null;
		if (!me) return;
		const other: ChatRole = me.role === "visitor" ? "team" : "visitor";
		if (m.type === "typing") {
			this.send(this.sockets(other), {
				type: "typing",
				role: me.role,
				name: me.name || null,
				on: m.on === true,
				// The team sees what the visitor is writing as they write it (Intercom-style).
				...(me.role === "visitor" && typeof m.text === "string"
					? { text: m.text.slice(0, 500) }
					: {}),
			});
			return;
		}
		if (m.type === "seen" && me.role === "visitor" && me.conversation) {
			const { markVisitorSeen } = await import("./chat");
			const at = await markVisitorSeen(me.conversation).catch(() => null);
			if (at) this.send(this.sockets("team"), { type: "seen", at });
		}
	}

	async webSocketClose(ws: WebSocket, code: number, reason: string) {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
		const me = ws.deserializeAttachment() as Attached | null;
		if (me?.role === "visitor") {
			const still = this.sockets("visitor", ws).length > 0;
			this.send(this.sockets("team"), { type: "presence", visitor: still });
			if (!still)
				this.send(this.sockets("team"), { type: "typing", role: "visitor", on: false });
		}
	}

	async webSocketError(ws: WebSocket) {
		await this.webSocketClose(ws, 1011, "error");
	}
}

/** The chat's room; null where the binding isn't (some tests). */
export function chatRoom(conversationId: string) {
	const ns = (env as unknown as { CHAT_ROOM?: DurableObjectNamespace<ChatRoom> }).CHAT_ROOM;
	return ns ? ns.get(ns.idFromName(conversationId)) : null;
}

/** Tells whoever is connected; never fails the caller (D1 already has it). */
export async function pushToRoom(conversationId: string, event: RoomEvent, teamEvent?: RoomEvent) {
	try {
		await chatRoom(conversationId)?.broadcast(event, teamEvent);
	} catch (error) {
		console.error("chat: room not told", error);
	}
}
