import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ArrowUp,
	Bot,
	Check,
	CheckCheck,
	FileText,
	Mail,
	MailOpen,
	Paperclip,
	PenLine,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { AnswerMenu } from "@/components/answer-menu";
import { Confirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { sendChatFileFn } from "@/functions/chat";
import type { getConversationFn } from "@/functions/inboxes";
import {
	deleteConversationDraftFn,
	sendConversationReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { Ph, useSketching } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * A website chat in the dashboard (src/server/chat.ts): the lines as bubbles, live over the
 * chat's room (/chat-live/<id>): the visitor's messages as they arrive, what they're typing,
 * whether they're on the site and have seen the answer. The team answers from the box below;
 * agents' drafts wait above it for approval.
 */

type Conversation = Awaited<ReturnType<typeof getConversationFn>>["conversation"];
type Item = Conversation["timeline"][number];
export type ChatLine = Extract<Item, { type: "chat" }>;
type Draft = Extract<Item, { type: "reply" | "draft" }>;
type Inbound = Extract<Item, { type: "inbound" }>;

type Pending = {
	client_id: string;
	text: string;
	file?: { name: string; preview: string | null };
	at: string;
	state: "sending" | "failed";
	/** The line it became (shown once that line is in). */
	id?: string;
	retry: () => void;
};

export type Live = {
	connected: boolean;
	visitorOnline: boolean;
	seenAt: string | null;
};

const uuid = () =>
	typeof crypto !== "undefined" && crypto.randomUUID
		? crypto.randomUUID()
		: `x${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

const MAX_FILE = 10 * 1024 * 1024;

const dayOf = (iso: string) => new Date(iso).toDateString();
const dayLabel = (iso: string) => {
	const d = new Date(iso);
	const today = new Date();
	const y = new Date(Date.now() - 86_400_000);
	if (d.toDateString() === today.toDateString()) return "Today";
	if (d.toDateString() === y.toDateString()) return "Yesterday";
	return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
};
const timeOf = (iso: string) =>
	new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
function Linked({ text }: { text: string }) {
	const parts = text.split(URL_RE);
	return (
		<>
			{parts.map((p, i) =>
				i % 2 ? (
					<a
						// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
						key={i}
						href={p}
						target="_blank"
						rel="noreferrer noopener"
						className="underline underline-offset-2"
					>
						{p}
					</a>
				) : (
					p
				),
			)}
		</>
	);
}

function useRoom(
	id: string,
	initial: { lines: ChatLine[]; seenAt: string | null },
	on: {
		line: (l: ChatLine) => void;
		status: () => void;
		deleted: () => void;
	},
) {
	const [live, setLive] = useState<Live>({
		connected: false,
		visitorOnline: false,
		seenAt: initial.seenAt,
	});
	const [typing, setTyping] = useState<{ text: string | null } | null>(null);
	const ws = useRef<WebSocket | null>(null);
	const handlers = useRef(on);
	handlers.current = on;
	useEffect(() => {
		if (typeof window === "undefined" || !window.WebSocket) return;
		let stop = false;
		let tries = 0;
		let ping: ReturnType<typeof setInterval> | undefined;
		let again: ReturnType<typeof setTimeout> | undefined;
		let clearTyping: ReturnType<typeof setTimeout> | undefined;
		const open = () => {
			const url = `${location.origin.replace(/^http/, "ws")}/chat-live/${id}`;
			const s = new WebSocket(url);
			ws.current = s;
			s.onopen = () => {
				tries = 0;
				setLive((l) => ({ ...l, connected: true }));
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
				if (ev.type === "hello")
					setLive((l) => ({ ...l, visitorOnline: ev.visitor_online === true }));
				else if (ev.type === "presence")
					setLive((l) => ({ ...l, visitorOnline: ev.visitor === true }));
				else if (ev.type === "seen" && typeof ev.at === "string")
					setLive((l) => ({ ...l, seenAt: ev.at as string }));
				else if (ev.type === "typing" && ev.role === "visitor") {
					clearTimeout(clearTyping);
					if (ev.on === true) {
						setTyping({ text: typeof ev.text === "string" ? ev.text : null });
						// Their tab closed mid-word: it goes away on its own.
						clearTyping = setTimeout(() => setTyping(null), 8000);
					} else setTyping(null);
				} else if (ev.type === "message" && ev.message) {
					const m = ev.message as ChatLine;
					if (m.author?.type === "visitor") setTyping(null);
					handlers.current.line(m);
				} else if (ev.type === "conversation") handlers.current.status();
				else if (ev.type === "deleted") handlers.current.deleted();
			};
			s.onclose = (e) => {
				clearInterval(ping);
				ws.current = null;
				setLive((l) => ({ ...l, connected: false }));
				if (stop || e.code === 4000 || e.code === 1008) return;
				tries++;
				again = setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(tries, 5)));
			};
		};
		open();
		return () => {
			stop = true;
			clearInterval(ping);
			clearTimeout(again);
			clearTimeout(clearTyping);
			ws.current?.close(1000);
		};
	}, [id]);
	const send = useCallback((event: unknown) => {
		const s = ws.current;
		if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(event));
	}, []);
	return { live, typing, send };
}

export function ChatThread({
	conversation: c,
	canReply,
	onLive,
}: {
	conversation: Conversation;
	canReply: boolean;
	onLive?: (live: Live) => void;
}) {
	const router = useRouter();
	const navigate = useNavigate();
	const sketching = useSketching();
	const fromProps = useMemo(
		() => c.timeline.filter((t): t is ChatLine => t.type === "chat"),
		[c.timeline],
	);
	const inbound = useMemo(
		() => c.timeline.filter((t): t is Inbound => t.type === "inbound"),
		[c.timeline],
	);

	const [lines, setLines] = useState<ChatLine[]>(fromProps);
	// The page's data came again (after a save, or coming back to it): merged in.
	useEffect(() => {
		setLines((now) => {
			const byId = new Map(now.map((l) => [l.id, l]));
			for (const l of fromProps) byId.set(l.id, l);
			return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
		});
	}, [fromProps]);
	const [pending, setPending] = useState<Pending[]>([]);

	const markRead = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const { live, typing, send } = useRoom(
		c.id,
		{ lines: fromProps, seenAt: c.visitor?.seen_at ?? null },
		{
			line: (l) => {
				setLines((now) =>
					now.some((x) => x.id === l.id)
						? now
						: [...now, l].sort((a, b) => a.at.localeCompare(b.at)),
				);
				// Read here while it's on screen: the team isn't emailed about it.
				if (l.author.type === "visitor" && document.visibilityState === "visible") {
					clearTimeout(markRead.current);
					markRead.current = setTimeout(() => {
						updateConversationFn({ data: { id: c.id, read: true } }).catch(() => {});
					}, 1500);
				}
			},
			status: () => void router.invalidate(),
			deleted: () => {
				toast("This chat was deleted");
				void navigate({ to: "/received" });
			},
		},
	);
	useEffect(() => onLive?.(live), [live, onLive]);
	useEffect(() => () => clearTimeout(markRead.current), []);

	// Scrolled to the newest, unless they scrolled up to read.
	const list = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const count = lines.length + pending.length + (typing ? 1 : 0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when something is added
	useLayoutEffect(() => {
		const el = list.current;
		if (el && pinned.current) el.scrollTop = el.scrollHeight;
	}, [count, typing?.text]);

	const lastTeam = [...lines]
		.reverse()
		.find((l) => l.author.type !== "visitor" && l.author.type !== "system");
	const seen = !!(lastTeam && live.seenAt && live.seenAt >= lastTeam.at);

	const items = useMemo(() => {
		const shown = new Set(lines.map((l) => l.id));
		const all: (
			| { kind: "line"; at: string; line: ChatLine }
			| { kind: "email"; at: string; email: Inbound }
			| { kind: "pending"; at: string; p: Pending }
		)[] = [
			...lines.map((line) => ({ kind: "line" as const, at: line.at, line })),
			...inbound.map((email) => ({ kind: "email" as const, at: email.at, email })),
			...pending
				.filter((p) => !p.id || !shown.has(p.id))
				.map((p) => ({ kind: "pending" as const, at: p.at, p })),
		];
		return all.sort((a, b) => a.at.localeCompare(b.at));
	}, [lines, inbound, pending]);

	const deliver = useCallback(
		(p: Omit<Pending, "state" | "retry" | "at" | "id">, run: () => Promise<{ id: string }>) => {
			const attempt = () => {
				setPending((now) => {
					const rest = now.filter((x) => x.client_id !== p.client_id);
					return [
						...rest,
						{ ...p, at: new Date().toISOString(), state: "sending", retry: attempt },
					];
				});
				run()
					.then((out) => {
						setPending((now) =>
							now.map((x) =>
								x.client_id === p.client_id ? { ...x, id: out.id } : x,
							),
						);
						// No live line: the page's data brings it.
						if (!live.connected) void router.invalidate();
						setTimeout(() => {
							setPending((now) => now.filter((x) => x.client_id !== p.client_id));
						}, 6000);
					})
					.catch(async (error) => {
						// Another Send of the same draft is still going: it lands on its own.
						if (
							error instanceof Response &&
							error.status === 409 &&
							p.client_id.startsWith("draft:")
						) {
							setTimeout(() => void router.invalidate(), 2500);
							setTimeout(() => {
								setPending((now) => now.filter((x) => x.client_id !== p.client_id));
							}, 6000);
							return;
						}
						toast.error(await errorMessage(error));
						setPending((now) =>
							now.map((x) =>
								x.client_id === p.client_id ? { ...x, state: "failed" } : x,
							),
						);
					});
			};
			attempt();
		},
		[live.connected, router],
	);

	// Drafts being sent from here: their card goes at once and can't be sent twice.
	const [sendingDrafts, setSendingDrafts] = useState<ReadonlySet<string>>(new Set());
	const sendText = (text: string, draft?: string) => {
		// A draft's send has one id, so a retry (or a lost answer) finds the line it already made.
		const client_id = draft ? `draft:${draft}` : uuid();
		if (draft) {
			if (sendingDrafts.has(draft)) return;
			setSendingDrafts((now) => new Set(now).add(draft));
		}
		deliver({ client_id, text }, async () => {
			const r = await sendConversationReplyFn({
				data: { conversation: c.id, text, client_id, ...(draft ? { draft } : {}) },
			});
			if (draft) void router.invalidate();
			return { id: r.id };
		});
	};

	const drafts = c.timeline.filter(
		(t): t is Draft => t.type === "draft" && !sendingDrafts.has(t.id),
	);

	const sendFile = (file: File) => {
		if (file.size > MAX_FILE) {
			toast.error("Files go up to 10 MB");
			return;
		}
		const client_id = uuid();
		const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
		deliver({ client_id, text: "", file: { name: file.name, preview } }, async () => {
			const data = await new Promise<string>((resolve, reject) => {
				const r = new FileReader();
				r.onload = () => resolve(String(r.result));
				r.onerror = () => reject(new Error("Couldn't read the file"));
				r.readAsDataURL(file);
			});
			return sendChatFileFn({
				data: { conversation: c.id, filename: file.name, data, client_id },
			});
		});
	};

	return (
		<Card className="relative gap-0 overflow-hidden p-0">
			<div className="flex h-11 items-center gap-2 border-b border-border/70 px-4 text-sm">
				<span
					className={cn(
						"size-2 rounded-full",
						live.visitorOnline ? "bg-emerald-500" : "bg-muted-foreground/40",
					)}
				/>
				<span className="font-medium">
					{live.visitorOnline ? "On the website now" : "Not on the website"}
				</span>
				{!live.visitorOnline && c.visitor?.email && (
					<span className="truncate text-muted-foreground">
						· answers also reach {c.visitor.email}
					</span>
				)}
				<span className="ml-auto text-xs text-muted-foreground">
					{sketching ? "" : live.connected ? "Live" : "Connecting…"}
				</span>
			</div>
			<div
				ref={list}
				onScroll={(e) => {
					const el = e.currentTarget;
					pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="flex h-[min(62vh,640px)] min-h-[360px] flex-col gap-1 overflow-y-auto px-4 py-5"
				aria-live="polite"
			>
				{items.length === 0 && (
					<p className="m-auto text-sm text-muted-foreground">No messages yet.</p>
				)}
				{items.map((it, i) => {
					const prev = items[i - 1];
					const newDay = !prev || dayOf(prev.at) !== dayOf(it.at);
					const who = (x: (typeof items)[number] | undefined) =>
						!x
							? null
							: x.kind === "line"
								? `${x.line.author.type}:${x.line.author.name}`
								: x.kind === "pending"
									? "me"
									: "email";
					const next = items[i + 1];
					const first = newDay || who(prev) !== who(it);
					const last = !next || who(next) !== who(it) || dayOf(next.at) !== dayOf(it.at);
					return (
						<div
							key={
								it.kind === "line"
									? it.line.id
									: it.kind === "email"
										? `e-${it.email.id}`
										: `p-${it.p.client_id}`
							}
							className="contents"
						>
							{newDay && (
								<div className="my-3 flex items-center gap-3 text-xs text-muted-foreground">
									<span className="h-px flex-1 bg-border" />
									{dayLabel(it.at)}
									<span className="h-px flex-1 bg-border" />
								</div>
							)}
							{it.kind === "line" ? (
								<Bubble
									line={it.line}
									first={first}
									last={last}
									seen={seen && lastTeam?.id === it.line.id}
								/>
							) : it.kind === "email" ? (
								<EmailIn email={it.email} />
							) : (
								<PendingBubble p={it.p} />
							)}
						</div>
					);
				})}
				{typing && (
					<div className="mt-2 flex max-w-[78%] flex-col items-start gap-1">
						<div className="rounded-2xl rounded-bl-md border border-dashed border-border bg-muted/50 px-3.5 py-2 text-sm text-muted-foreground">
							{typing.text ? (
								<span className="whitespace-pre-wrap break-words italic">
									{typing.text}
								</span>
							) : null}
							<span className="sr-only">Typing</span>
							<span
								className="ml-1 inline-flex gap-0.5 align-middle"
								aria-hidden="true"
							>
								{[0, 1, 2].map((d) => (
									<i
										key={d}
										className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
										style={{ animationDelay: `${d * 150}ms` }}
									/>
								))}
							</span>
						</div>
						<span className="px-1 text-[11px] text-muted-foreground">
							{typing.text ? "Writing (they haven't sent it yet)" : "Typing…"}
						</span>
					</div>
				)}
			</div>
			{drafts.length > 0 && (
				<div className="flex flex-col gap-2 border-t border-border/70 bg-brand/5 px-4 py-3">
					{drafts.map((d) => (
						<DraftRow
							key={d.id}
							draft={d}
							canReply={canReply}
							onSend={(text) => sendText(text, d.id)}
						/>
					))}
				</div>
			)}
			{canReply && (
				<ChatComposer
					disabled={sketching}
					resolved={c.status === "resolved"}
					onType={(on) => send({ type: "typing", on })}
					onText={(t) => sendText(t)}
					onFile={sendFile}
				/>
			)}
		</Card>
	);
}

function Avatar({ author }: { author: ChatLine["author"] }) {
	const initial =
		(author.name ?? (author.type === "visitor" ? "Visitor" : "?"))
			.trim()
			.charAt(0)
			.toUpperCase() || "?";
	return (
		<span
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
				author.type === "agent"
					? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
					: author.type === "visitor"
						? "bg-muted text-muted-foreground"
						: "bg-brand/15 text-brand",
			)}
			aria-hidden="true"
		>
			{author.type === "agent" ? <Bot className="size-3.5" /> : initial}
		</span>
	);
}

function Files({ files, mine }: { files: ChatLine["files"]; mine: boolean }) {
	if (!files.length) return null;
	return (
		<div className={cn("flex flex-wrap gap-2", mine ? "justify-end" : "justify-start")}>
			{files.map((f) =>
				f.image && f.url ? (
					<a
						key={f.id}
						href={f.url}
						target="_blank"
						rel="noreferrer"
						className="block overflow-hidden rounded-xl border border-border/70"
					>
						<img
							src={f.url}
							alt={f.filename}
							className="max-h-60 max-w-[260px] object-cover"
							loading="lazy"
						/>
					</a>
				) : (
					<a
						key={f.id}
						href={f.url ?? undefined}
						target="_blank"
						rel="noreferrer"
						className="flex max-w-[260px] items-center gap-2 rounded-xl border border-border/70 bg-background px-3 py-2 text-sm hover:bg-muted/60"
					>
						<FileText className="size-4 shrink-0 text-muted-foreground" />
						<span className="min-w-0 truncate">{f.filename}</span>
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
							{Math.max(1, Math.round(f.size / 1024))} KB
						</span>
					</a>
				),
			)}
		</div>
	);
}

function Bubble({
	line: l,
	first,
	last,
	seen,
}: {
	line: ChatLine;
	first: boolean;
	last: boolean;
	seen: boolean;
}) {
	if (l.author.type === "system")
		return (
			<p className="my-2 text-center text-xs text-muted-foreground">
				<Ph>{l.text}</Ph>
			</p>
		);
	const mine = l.author.type !== "visitor";
	const name =
		l.author.type === "visitor" ? (l.author.name ?? "Visitor") : (l.author.name ?? "Team");
	return (
		<div
			className={cn(
				"group/line flex items-end gap-2",
				mine ? "flex-row-reverse" : "flex-row",
				first && "mt-3",
			)}
		>
			<span className="w-7 shrink-0">{last && <Avatar author={l.author} />}</span>
			<div
				className={cn(
					"flex max-w-[78%] min-w-0 flex-col gap-1",
					mine ? "items-end" : "items-start",
				)}
			>
				{first && (
					<span className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
						<span className="font-medium text-foreground/80">{name}</span>
						{l.author.type === "agent" && (
							<Badge
								variant="secondary"
								className="h-4 px-1 text-[10px]"
							>
								Agent
							</Badge>
						)}
						{l.sent_by && <span>· approved by {l.sent_by}</span>}
					</span>
				)}
				{l.text && (
					<div
						title={formatDateTime(l.at)}
						className={cn(
							"rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words",
							mine
								? "bg-brand text-brand-foreground [&_a]:text-brand-foreground"
								: "bg-muted text-foreground",
							mine ? (last ? "rounded-br-md" : "") : last ? "rounded-bl-md" : "",
							l.author.type === "agent" && "bg-violet-600 text-white",
						)}
					>
						<Ph>
							<Linked text={l.text} />
						</Ph>
					</div>
				)}
				<Files
					files={l.files}
					mine={mine}
				/>
				{last && (
					<span className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground tabular-nums">
						{timeOf(l.at)}
						{l.via === "email" && (
							<span className="inline-flex items-center gap-0.5">
								· <Mail className="size-3" /> by email
							</span>
						)}
						{mine && l.emailed_at && (
							<span
								className="inline-flex items-center gap-0.5"
								title={`Emailed ${formatDateTime(l.emailed_at)}`}
							>
								· <MailOpen className="size-3" /> also emailed
							</span>
						)}
						{mine &&
							(seen ? (
								<CheckCheck className="size-3.5 text-brand" />
							) : (
								<Check className="size-3.5" />
							))}
						{mine && seen && <span>Seen</span>}
					</span>
				)}
			</div>
			{mine && l.text && (
				<AnswerMenu
					messageId={l.id}
					className="mb-1 opacity-0 transition-opacity group-hover/line:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
				/>
			)}
		</div>
	);
}

function PendingBubble({ p }: { p: Pending }) {
	return (
		<div className="mt-1 flex flex-row-reverse items-end gap-2">
			<span className="w-7 shrink-0" />
			<div className="flex max-w-[78%] flex-col items-end gap-1">
				{p.text && (
					<div
						className={cn(
							"rounded-2xl rounded-br-md bg-brand px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words text-brand-foreground",
							p.state === "sending" && "opacity-70",
							p.state === "failed" && "bg-destructive/90",
						)}
					>
						{p.text}
					</div>
				)}
				{p.file &&
					(p.file.preview ? (
						<img
							src={p.file.preview}
							alt={p.file.name}
							className={cn(
								"max-h-60 max-w-[260px] rounded-xl border border-border/70 object-cover",
								p.state === "sending" && "opacity-60",
							)}
						/>
					) : (
						<span className="flex items-center gap-2 rounded-xl border border-border/70 px-3 py-2 text-sm">
							<FileText className="size-4 text-muted-foreground" />
							{p.file.name}
						</span>
					))}
				<span className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
					{p.state === "sending" ? (
						<>
							<Spinner className="size-3" /> Sending…
						</>
					) : (
						<button
							type="button"
							onClick={p.retry}
							className="inline-flex items-center gap-1 text-destructive hover:underline"
						>
							<RotateCcw className="size-3" /> Not sent. Try again
						</button>
					)}
				</span>
			</div>
		</div>
	);
}

function EmailIn({ email: e }: { email: Inbound }) {
	return (
		<div className="my-2 flex justify-start">
			<Link
				to="/received/m/$id"
				params={{ id: e.id }}
				className="flex max-w-[78%] items-start gap-3 rounded-xl border border-dashed border-border px-3.5 py-2.5 text-sm hover:bg-muted/50"
			>
				<MailOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<span className="flex min-w-0 flex-col">
					<span className="truncate font-medium">
						<Ph>{e.from}</Ph> emailed
					</span>
					<span className="line-clamp-2 text-muted-foreground">
						<Ph>{e.text?.trim() || e.subject || "(no text)"}</Ph>
					</span>
					<span className="text-xs text-muted-foreground">{formatAgo(e.at)}</span>
				</span>
			</Link>
		</div>
	);
}

function DraftRow({
	draft: d,
	canReply,
	onSend,
}: {
	draft: Draft;
	canReply: boolean;
	onSend: (text: string) => void;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState(d.text ?? "");
	return (
		<div className="flex flex-col gap-2 rounded-xl border border-brand/30 bg-background px-3.5 py-2.5">
			<div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<PenLine className="size-3.5" />
				<span>
					<span className="font-medium text-foreground">
						{d.author.name ?? "An agent"}
					</span>{" "}
					wrote an answer for you to approve
				</span>
				<span className="ml-auto">{formatAgo(d.at)}</span>
			</div>
			{editing ? (
				<textarea
					aria-label="The draft"
					value={text}
					rows={3}
					onChange={(e) => setText(e.target.value)}
					className="w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
				/>
			) : (
				<p className="text-sm whitespace-pre-wrap break-words">
					<Ph>{d.text}</Ph>
				</p>
			)}
			{canReply && (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						disabled={!text.trim()}
						onClick={() => onSend(text)}
					>
						<ArrowUp />
						{editing ? "Send it" : "Approve and send"}
					</Button>
					{!editing && (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setEditing(true)}
						>
							<PenLine />
							Edit
						</Button>
					)}
					<Confirm
						trigger={
							<Button
								size="sm"
								variant="ghost"
							>
								<Trash2 />
								Discard
							</Button>
						}
						title="Discard this draft?"
						description="Nobody can send it afterwards."
						action="Discard"
						onConfirm={async () => {
							try {
								await deleteConversationDraftFn({ data: { id: d.id } });
								toast.success("Draft discarded");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							}
						}}
					/>
				</div>
			)}
		</div>
	);
}

function ChatComposer({
	disabled,
	resolved,
	onType,
	onText,
	onFile,
}: {
	disabled: boolean;
	resolved: boolean;
	onType: (on: boolean) => void;
	onText: (text: string) => void;
	onFile: (f: File) => void;
}) {
	const [text, setText] = useState("");
	const [drag, setDrag] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const file = useRef<HTMLInputElement>(null);
	const typingSent = useRef(0);
	const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: grows with what's written
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
	}, [text]);
	useEffect(() => () => clearTimeout(idle.current), []);
	const typed = (v: string) => {
		setText(v);
		const now = Date.now();
		if (v.trim() && now - typingSent.current > 2500) {
			typingSent.current = now;
			onType(true);
		}
		clearTimeout(idle.current);
		idle.current = setTimeout(() => {
			typingSent.current = 0;
			onType(false);
		}, 4000);
	};
	const submit = () => {
		const t = text.trim();
		if (!t) return;
		onText(t);
		setText("");
		clearTimeout(idle.current);
		typingSent.current = 0;
		onType(false);
		box.current?.focus();
	};
	const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		}
	};
	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const f = [...e.clipboardData.files][0];
		if (f) {
			e.preventDefault();
			onFile(f);
		}
	};
	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDrag(false);
		const f = [...e.dataTransfer.files][0];
		if (f) onFile(f);
	};
	return (
		<form
			className={cn(
				"relative flex flex-col gap-2 border-t border-border/70 px-3 py-3",
				drag && "bg-brand/5",
			)}
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
			onDragOver={(e) => {
				if ([...e.dataTransfer.types].includes("Files")) {
					e.preventDefault();
					setDrag(true);
				}
			}}
			onDragLeave={() => setDrag(false)}
			onDrop={onDrop}
		>
			{resolved && (
				<p className="px-1 text-xs text-muted-foreground">
					Resolved. Writing reopens it for the visitor.
				</p>
			)}
			{drag && (
				<div className="pointer-events-none absolute inset-1 flex items-center justify-center rounded-lg border-2 border-dashed border-brand/50 text-sm font-medium text-brand">
					Drop to send the file
				</div>
			)}
			<div className="flex items-end gap-2 rounded-xl border border-input bg-background px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
				<Button
					type="button"
					size="icon"
					variant="ghost"
					className="size-8 shrink-0 text-muted-foreground"
					aria-label="Send a file"
					title="Send a file (image, PDF or document, up to 10 MB)"
					disabled={disabled}
					onClick={() => file.current?.click()}
				>
					<Paperclip />
				</Button>
				<input
					ref={file}
					type="file"
					className="hidden"
					accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv"
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) onFile(f);
						e.target.value = "";
					}}
				/>
				<textarea
					ref={box}
					aria-label="Your answer"
					rows={1}
					value={text}
					disabled={disabled}
					placeholder="Write an answer… (Enter sends, Shift+Enter for a new line)"
					onChange={(e) => typed(e.target.value)}
					onKeyDown={onKey}
					onPaste={onPaste}
					className="max-h-[200px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground"
				/>
				{text && (
					<Button
						type="button"
						size="icon"
						variant="ghost"
						className="size-8 shrink-0 text-muted-foreground"
						aria-label="Clear"
						onClick={() => typed("")}
					>
						<X />
					</Button>
				)}
				<Button
					type="submit"
					size="icon"
					className="size-8 shrink-0 rounded-lg"
					aria-label="Send"
					disabled={disabled || !text.trim()}
				>
					<ArrowUp />
				</Button>
			</div>
		</form>
	);
}
