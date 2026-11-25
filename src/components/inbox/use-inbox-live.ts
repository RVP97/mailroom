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
						notifyBrowserOfInboxEvent(change);
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

const NOTIFY_KEY = "mailroom:inbox-notify";
const SOUND_KEY = "mailroom:inbox-sound";

export function readNotificationPrefs() {
	if (typeof window === "undefined") return { desktop: false, sound: false };
	try {
		return {
			desktop: localStorage.getItem(NOTIFY_KEY) === "1",
			sound: localStorage.getItem(SOUND_KEY) === "1",
		};
	} catch {
		return { desktop: false, sound: false };
	}
}

export function writeNotificationPrefs(prefs: { desktop?: boolean; sound?: boolean }) {
	if (typeof window === "undefined") return;
	try {
		if (prefs.desktop !== undefined)
			localStorage.setItem(NOTIFY_KEY, prefs.desktop ? "1" : "0");
		if (prefs.sound !== undefined) localStorage.setItem(SOUND_KEY, prefs.sound ? "1" : "0");
	} catch {}
}

function playChime() {
	try {
		const Ctx =
			window.AudioContext ||
			(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctx) return;
		const ctx = new Ctx();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.setValueAtTime(660, ctx.currentTime);
		osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.09);
		gain.gain.setValueAtTime(0.06, ctx.currentTime);
		gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start();
		osc.stop(ctx.currentTime + 0.23);
		setTimeout(() => void ctx.close(), 350);
	} catch {}
}

function notifyBrowserOfInboxEvent(ev: InboxChangeEvent) {
	if (typeof window === "undefined") return;
	if (ev.kind !== "chat" && ev.kind !== "inbound") return;
	const prefs = readNotificationPrefs();
	if (prefs.sound) playChime();
	if (
		prefs.desktop &&
		typeof Notification !== "undefined" &&
		Notification.permission === "granted" &&
		document.hidden
	) {
		const title =
			ev.kind === "chat"
				? `New live chat${ev.contact ? ` · ${ev.contact}` : ""}`
				: `New email${ev.contact ? ` · ${ev.contact}` : ""}`;
		const n = new Notification(title, {
			body: ev.subject || "Open Mailroom Inbox to reply",
			tag: ev.conversation_id ? `mr:${ev.conversation_id}` : "mr:inbox",
		});
		n.onclick = () => {
			window.focus();
			if (ev.conversation_id) {
				window.dispatchEvent(
					new CustomEvent("mailroom:inbox-select", {
						detail: { conversationId: ev.conversation_id },
					}),
				);
			}
			n.close();
		};
	}
}
