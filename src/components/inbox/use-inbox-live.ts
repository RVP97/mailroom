import { useCallback, useEffect, useRef, useState } from "react";
import { ORG_PARAM, tabHandle } from "@/lib/tab-org";

export interface TeamViewer {
	userId: string;
	name: string;
	avatar: string | null;
	viewing: string | null;
	typingIn: string | null;
}

export interface InboxChangeEvent {
	kind: string;
	conversation_id?: string;
	channel?: string;
	subject?: string | null;
	contact?: string | null;
	unread?: boolean;
}

/**
 * Connects to `/inbox-live` for org-wide real-time updates (new emails/chats, triage changes)
 * and teammate collision detection ("Ana is viewing" / "Ana is replying").
 * Safe during SSR (WebSocket only opens inside useEffect).
 */
export function useInboxLive(
	opts: {
		enabled?: boolean;
		viewing?: string | null;
		onChange?: (ev: InboxChangeEvent) => void;
	} = {},
) {
	const { enabled = true, viewing = null, onChange } = opts;
	const [connected, setConnected] = useState(false);
	const [viewers, setViewers] = useState<TeamViewer[]>([]);
	const ws = useRef<WebSocket | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const viewingRef = useRef<string | null>(viewing);
	viewingRef.current = viewing;

	const send = useCallback((payload: unknown) => {
		const s = ws.current;
		if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(payload));
	}, []);

	useEffect(() => {
		if (!enabled || typeof window === "undefined" || !window.WebSocket) return;
		let stop = false;
		let tries = 0;
		let ping: ReturnType<typeof setInterval> | undefined;
		let again: ReturnType<typeof setTimeout> | undefined;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;

		const open = () => {
			const handle = tabHandle();
			const url = `${location.origin.replace(/^http/, "ws")}/inbox-live${handle ? `?${ORG_PARAM}=${handle}` : ""}`;
			const s = new WebSocket(url);
			ws.current = s;
			s.onopen = () => {
				tries = 0;
				setConnected(true);
				if (viewingRef.current)
					s.send(JSON.stringify({ type: "view", conversation: viewingRef.current }));
				ping = setInterval(() => {
					if (s.readyState === WebSocket.OPEN) s.send('{"type":"ping"}');
				}, 25_000);
			};
			s.onmessage = (e) => {
				let ev: Record<string, unknown>;
				try {
					ev = JSON.parse(String(e.data));
				} catch {
					return;
				}
				if (
					(ev.type === "hello" || ev.type === "presence.list") &&
					Array.isArray(ev.viewers)
				)
					setViewers(ev.viewers as TeamViewer[]);
				else if (ev.type === "inbox.changed") {
					const change = ev as unknown as InboxChangeEvent;
					if (change.unread) {
						window.dispatchEvent(
							new CustomEvent("mailroom:inbox-unread", { detail: { delta: 1 } }),
						);
					}
					clearTimeout(refreshTimer);
					refreshTimer = setTimeout(() => onChangeRef.current?.(change), 250);
				}
			};
			s.onclose = (e) => {
				clearInterval(ping);
				ws.current = null;
				setConnected(false);
				if (stop || e.code === 4000 || e.code === 1008) return;
				tries++;
				again = setTimeout(open, Math.min(30_000, 1500 * 2 ** Math.min(tries, 4)));
			};
		};
		open();
		return () => {
			stop = true;
			clearInterval(ping);
			clearTimeout(again);
			clearTimeout(refreshTimer);
			ws.current?.close(1000);
		};
	}, [enabled]);

	useEffect(() => {
		send({ type: "view", conversation: viewing ?? null });
	}, [viewing, send]);

	const setTyping = useCallback(
		(conversation: string | null, on: boolean) => {
			if (!conversation) return;
			send({ type: "typing", conversation, on });
		},
		[send],
	);

	return { connected, viewers, setTyping };
}

/** Update the sidebar Inbox unread badge immediately from any Inbox action. */
export function broadcastUnreadCount(count: number) {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent("mailroom:inbox-unread", { detail: { count } }));
}
