import { Link } from "@tanstack/react-router";
import {
	ArrowUp,
	Bold,
	BookOpen,
	ChevronDown,
	CircleCheck,
	Clock,
	Eye,
	Italic,
	Link2,
	List,
	Paperclip,
	PenLine,
	Send,
	Sparkles,
	StickyNote,
	Wand2,
	X,
	Zap,
} from "lucide-react";
import {
	type ClipboardEvent,
	type DragEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { MacrosPopover } from "@/components/inbox/macros-popover";
import { Avatar, PickMoment } from "@/components/inbox-triage";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { aiDraftReplyFn, aiPolishFn } from "@/functions/ai";
import type { getConversationFn } from "@/functions/inboxes";
import {
	addNoteFn,
	saveConversationDraftFn,
	sendConversationReplyFn,
	unsendReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { fillVariables } from "@/lib/reply-variables";
import { cn } from "@/lib/utils";

type Data = Awaited<ReturnType<typeof getConversationFn>>;
type Conversation = Data["conversation"];
type Item = Conversation["timeline"][number];
type Draft = Extract<Item, { type: "reply" | "draft" }>;
type Saved = Data["saved"][number];
type Article = Data["articles"][number];

const at9 = (days: number) => {
	const d = new Date(Date.now() + days * 86_400_000);
	d.setHours(9, 0, 0, 0);
	return d;
};
const nextMonday = () => {
	const d = at9(0);
	d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
	return d;
};
const shortDate = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
});

/** Convert lightweight reply markdown (**bold**, *italic*, [label](url), bullet lists) to clean HTML. */
function markdownToEmailHtml(raw: string): string | undefined {
	if (!/(\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\(https?:\/\/[^)]+\)|^-\s)/m.test(raw))
		return undefined;
	const esc = (s: string) =>
		s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	const inline = (line: string) =>
		esc(line)
			.replace(
				/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
				'<a href="$2" style="color:#2563eb">$1</a>',
			)
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/\*([^*]+)\*/g, "<em>$1</em>");
	const blocks = raw.split(/\n{2,}/);
	const htmlBlocks = blocks.map((block) => {
		const lines = block.split("\n");
		if (lines.every((l) => /^-\s+/.test(l.trim()))) {
			const items = lines
				.map((l) => `<li>${inline(l.trim().replace(/^-\s+/, ""))}</li>`)
				.join("");
			return `<ul style="margin:0 0 12px;padding-left:20px">${items}</ul>`;
		}
		return `<p style="margin:0 0 12px">${lines.map(inline).join("<br>")}</p>`;
	});
	return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#18181b">${htmlBlocks.join("")}</div>`;
}

/** Triggers at caret: @mention in note, /saved-reply or #help-article in reply. */
function triggerAt(text: string, caret: number, mode: "reply" | "note") {
	const before = text.slice(0, caret);
	if (mode === "note") {
		const m = /(?:^|\s)@([^\s@]{0,30})$/.exec(before);
		if (!m) return null;
		return {
			kind: "mention" as const,
			q: (m[1] ?? "").toLowerCase(),
			start: caret - (m[1]?.length ?? 0) - 1,
			end: caret,
		};
	}
	const slash = /(?:^|\n|\s)\/([\w-]{0,30})$/.exec(before);
	if (slash)
		return {
			kind: "saved" as const,
			q: (slash[1] ?? "").toLowerCase(),
			start: caret - (slash[1]?.length ?? 0) - 1,
			end: caret,
		};
	const hash = /(?:^|\s)#([^\s#]{0,40})$/.exec(before);
	if (hash)
		return {
			kind: "article" as const,
			q: (hash[1] ?? "").toLowerCase(),
			start: caret - (hash[1]?.length ?? 0) - 1,
			end: caret,
		};
	return null;
}

export function announceSend(
	reply: { id: string; scheduled_for?: string | null },
	later: boolean,
	undoSeconds: number,
	reload: () => Promise<void> | void,
) {
	if (!reply.scheduled_for) {
		toast.success("Reply sent");
		return;
	}
	const undo = {
		label: "Undo",
		onClick: async () => {
			try {
				await unsendReplyFn({ data: { id: reply.id } });
				toast.success("Called back: it's a draft again");
				await reload();
			} catch (error) {
				toast.error(await errorMessage(error));
			}
		},
	};
	if (later)
		toast.success(`Scheduled for ${formatDateTime(reply.scheduled_for)}`, {
			description: "It waits in the conversation until then.",
			action: undo,
		});
	else
		toast(`Sending in ${undoSeconds} seconds…`, {
			duration: Math.max(3, undoSeconds) * 1000,
			action: undo,
		});
}

/**
 * Unified sticky composer for BOTH Email and Website Chat conversations.
 * Supports Reply / Internal Note tabs, /saved-replies, #help-articles, @mentions,
 * formatting helpers, file attachments (drag & paste), Send & Resolve, and AI Copilot.
 */
export function UnifiedComposer({
	data,
	ctx,
	draft,
	lastInbound,
	ask,
	onReload,
	onDone,
	onTypingChange,
	onChatSendText,
	onChatSendFile,
	onChatTyping,
}: {
	data: Data;
	ctx: Parameters<typeof fillVariables>[1];
	draft?: Draft;
	lastInbound?: string;
	ask?: { mode: "reply" | "note"; n: number };
	onReload: () => Promise<void> | void;
	onDone?: () => void;
	onTypingChange?: (typing: boolean) => void;
	onChatSendText?: (text: string) => void;
	onChatSendFile?: (file: File) => void;
	onChatTyping?: (on: boolean) => void;
}) {
	const { conversation: c, compose, people, saved, articles, workflow, ai } = data;
	const me = useMe();
	const canManageMacros = allows(me.active?.access, "inbox:rules");
	const isChat = c.channel === "chat" || c.channel === "whatsapp" || c.channel === "telegram";
	const [mode, setMode] = useState<"reply" | "note">("reply");
	const [previewHtml, setPreviewHtml] = useState(false);
	const [from, setFrom] = useState(draft?.from ?? compose.from ?? "");
	const [to, setTo] = useState((draft?.to ?? compose.to).join(", "));
	const [cc, setCc] = useState((draft?.cc ?? []).join(", "));
	const [subject, setSubject] = useState(draft?.subject ?? compose.subject);
	const [text, setText] = useState(draft?.text ?? "");
	const [showHeaders, setShowHeaders] = useState(Boolean(draft) || (!isChat && !compose.from));
	const [busy, setBusy] = useState<"send" | "draft" | "note" | "ai" | null>(null);
	const [savedId, setSavedId] = useState<string | null>(null);
	const [signature, setSignature] = useState(true);
	const [mentions, setMentions] = useState<{ reader: string; name: string }[]>([]);
	const [aiSources, setAiSources] = useState<{ title: string; url: string | null }[]>([]);
	const [pickingTime, setPickingTime] = useState(false);
	const [drag, setDrag] = useState(false);
	const [menu, setMenu] = useState<{
		kind: "mention" | "saved" | "article";
		q: string;
		start: number;
		end: number;
	} | null>(null);
	const [menuIndex, setMenuIndex] = useState(0);
	const box = useRef<HTMLTextAreaElement>(null);
	const caret = useRef<number | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const lastChatTyping = useRef(0);

	const [files, setFiles] = useState<
		{ id: string; filename: string; size: number; content?: string; content_type?: string }[]
	>(() =>
		(draft?.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
	);

	// Focus when R or N shortcut triggers
	const asked = useRef(ask?.n ?? 0);
	useEffect(() => {
		if (!ask || ask.n === asked.current) return;
		asked.current = ask.n;
		setMode(ask.mode);
		setMenu(null);
		requestAnimationFrame(() => box.current?.focus());
	});

	useLayoutEffect(() => {
		if (caret.current === null || !box.current) return;
		box.current.focus();
		box.current.setSelectionRange(caret.current, caret.current);
		caret.current = null;
	});

	useEffect(() => () => clearTimeout(typingTimer.current), []);

	const notifyTyping = (val: string) => {
		const active = val.trim().length > 0;
		if (active) {
			onTypingChange?.(true);
			if (isChat && mode === "reply" && Date.now() - lastChatTyping.current > 2500) {
				lastChatTyping.current = Date.now();
				onChatTyping?.(true);
			}
		}
		clearTimeout(typingTimer.current);
		typingTimer.current = setTimeout(() => {
			onTypingChange?.(false);
			if (isChat) {
				lastChatTyping.current = 0;
				onChatTyping?.(false);
			}
		}, 4000);
	};

	const choices =
		menu === null
			? []
			: menu.kind === "mention"
				? people
						.filter((p) => p.type === "person" && p.name.toLowerCase().includes(menu.q))
						.slice(0, 6)
						.map((p) => ({
							key: p.reader,
							kind: "mention" as const,
							label: p.name,
							hint: "",
							pick: () => {
								setMentions((m) =>
									m.some((x) => x.reader === p.reader) ? m : [...m, p],
								);
								replaceRange(menu.start, menu.end, `@${p.name} `);
							},
						}))
				: menu.kind === "saved"
					? saved
							.filter(
								(s) =>
									(s.shortcut ?? "").toLowerCase().includes(menu.q) ||
									s.name.toLowerCase().includes(menu.q),
							)
							.slice(0, 6)
							.map((s) => ({
								key: s.id,
								kind: "saved" as const,
								label: s.name,
								hint: s.shortcut ? `/${s.shortcut}` : "",
								pick: () => insertSaved(s, menu),
							}))
					: articles
							.filter((a) =>
								`${a.title} ${a.category ?? ""}`.toLowerCase().includes(menu.q),
							)
							.slice(0, 6)
							.map((a) => ({
								key: a.id,
								kind: "article" as const,
								label: a.title,
								hint: a.category ?? "",
								pick: () => insertArticle(a, menu),
							}));

	const replaceRange = (start: number, end: number, insert: string) => {
		const next = text.slice(0, start) + insert + text.slice(end);
		setText(next);
		setMenu(null);
		caret.current = start + insert.length;
	};

	const insertSaved = (s: Saved, range?: { start: number; end: number } | null) => {
		const filled = fillVariables(s.text, ctx);
		setSavedId(s.id);
		if (range) replaceRange(range.start, range.end, filled);
		else {
			const pos = box.current?.selectionStart ?? text.length;
			replaceRange(pos, pos, filled);
		}
	};

	const insertArticle = (a: Article, range?: { start: number; end: number } | null) => {
		const snippet = a.url
			? isChat
				? `${a.title}: ${a.url}`
				: `[${a.title}](${a.url})`
			: a.title;
		if (range) replaceRange(range.start, range.end, snippet);
		else {
			const pos = box.current?.selectionStart ?? text.length;
			replaceRange(pos, pos, snippet);
		}
	};

	const wrapSelection = (before: string, after = before, placeholder = "text") => {
		const el = box.current;
		if (!el) return;
		const start = el.selectionStart ?? text.length;
		const end = el.selectionEnd ?? text.length;
		const selected = text.slice(start, end) || placeholder;
		const inserted = `${before}${selected}${after}`;
		setText(text.slice(0, start) + inserted + text.slice(end));
		caret.current = start + before.length + selected.length;
	};

	const addEmailFiles = async (list: FileList | File[] | null) => {
		const arr = list ? [...list] : [];
		if (!arr.length) return;
		if (isChat && mode === "reply") {
			for (const f of arr) onChatSendFile?.(f);
			if (fileInput.current) fileInput.current.value = "";
			return;
		}
		const added = await Promise.all(
			arr.map(
				(f) =>
					new Promise<(typeof files)[number]>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () =>
							resolve({
								id: crypto.randomUUID(),
								filename: f.name,
								size: f.size,
								content: String(reader.result).replace(/^data:[^,]*,/, ""),
								content_type: f.type || undefined,
							});
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(f);
					}),
			),
		);
		const next = [...files, ...added];
		if (next.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024)
			toast.error("Attachments: up to 20 MB together");
		else setFiles(next);
		if (fileInput.current) fileInput.current.value = "";
	};

	const clear = () => {
		if (!draft) {
			setText("");
			setFiles([]);
			setSavedId(null);
			setMentions([]);
			setAiSources([]);
		}
		onTypingChange?.(false);
		if (isChat) onChatTyping?.(false);
	};

	const emailPayload = () => {
		const html = markdownToEmailHtml(text);
		return {
			conversation: c.id,
			draft: draft?.id,
			from: from || undefined,
			to,
			cc,
			subject,
			text,
			...(html ? { html } : {}),
			...(savedId ? { saved_reply_id: savedId } : {}),
			...(workflow.signature && !signature ? { signature: false } : {}),
			...(lastInbound && lastInbound !== "sketch" ? { after_message: lastInbound } : {}),
			...(draft || files.length
				? {
						attachments: files.map((f) =>
							f.content
								? {
										filename: f.filename,
										content: f.content,
										...(f.content_type ? { content_type: f.content_type } : {}),
									}
								: { id: f.id },
						),
					}
				: {}),
		};
	};

	const send = async (o: { at?: Date; resolve?: boolean; snooze?: Date } = {}) => {
		if (!text.trim()) return;
		if (mode === "note") {
			setBusy("note");
			try {
				await addNoteFn({
					data: {
						conversation: c.id,
						text,
						mentions: mentions
							.filter((m) => text.includes(`@${m.name}`))
							.map((m) => m.reader),
					},
				});
				toast.success("Note added");
				clear();
				await onReload();
			} catch (error) {
				toast.error(await errorMessage(error));
			} finally {
				setBusy(null);
			}
			return;
		}
		if (isChat && !draft && !o.at && onChatSendText) {
			const msg = text.trim();
			clear();
			onChatSendText(msg);
			if (o.resolve) {
				await updateConversationFn({ data: { id: c.id, status: "resolved" } }).catch(
					() => {},
				);
				await onReload();
			} else if (o.snooze) {
				await updateConversationFn({
					data: { id: c.id, snooze_until: o.snooze.toISOString() },
				}).catch(() => {});
				toast.success(`Snoozed until ${shortDate.format(o.snooze)}`);
				await onReload();
			}
			return;
		}
		setBusy("send");
		try {
			const sent = await sendConversationReplyFn({
				data: { ...emailPayload(), ...(o.at ? { send_at: o.at.toISOString() } : {}) },
			});
			announceSend(sent, !!o.at, workflow.undo_seconds, onReload);
			if (o.resolve) await updateConversationFn({ data: { id: c.id, status: "resolved" } });
			else if (o.snooze) {
				await updateConversationFn({
					data: { id: c.id, snooze_until: o.snooze.toISOString() },
				});
			}
			clear();
			setPreviewHtml(false);
			onDone?.();
			await onReload();
		} catch (error) {
			const message = await errorMessage(error);
			if (error instanceof Response && error.status === 409 && /new message/i.test(message))
				toast.warning("They wrote again while you were writing", {
					description: "Your reply is still here. Read what they said, then send.",
					action: { label: "Refresh", onClick: () => void onReload() },
					duration: 12_000,
				});
			else toast.error(message);
		} finally {
			setBusy(null);
		}
	};

	const saveDraft = async () => {
		if (!text.trim()) return;
		setBusy("draft");
		try {
			await saveConversationDraftFn({ data: emailPayload() });
			toast.success("Draft saved");
			clear();
			onDone?.();
			await onReload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const runAiDraft = async () => {
		setBusy("ai");
		try {
			const res = await aiDraftReplyFn({ data: { conversation: c.id } });
			setMode("reply");
			setText(res.text);
			setAiSources(res.sources);
			toast.success("Draft ready — review before sending");
			requestAnimationFrame(() => box.current?.focus());
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const runAiPolish = async (tone: "clear" | "friendly" | "shorter" | "formal") => {
		if (!text.trim()) return;
		setBusy("ai");
		try {
			const res = await aiPolishFn({ data: { text, tone } });
			setText(res.text);
			toast.success("Reply polished");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const pasted = [...e.clipboardData.files];
		if (pasted.length) {
			e.preventDefault();
			void addEmailFiles(pasted);
		}
	};

	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setDrag(false);
		const dropped = [...e.dataTransfer.files];
		if (dropped.length) void addEmailFiles(dropped);
	};

	const isNote = mode === "note";

	return (
		<div
			className={cn(
				"relative shrink-0 border-t transition-colors",
				isNote ? "bg-amber-500/[0.06] border-amber-500/30" : "bg-background border-border",
				drag && "ring-2 ring-inset ring-brand/60",
			)}
			onDragOver={(e) => {
				if ([...e.dataTransfer.types].includes("Files")) {
					e.preventDefault();
					setDrag(true);
				}
			}}
			onDragLeave={() => setDrag(false)}
			onDrop={onDrop}
		>
			{drag && (
				<div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-brand/60 bg-background/85 text-sm font-medium text-brand">
					Drop to attach {isChat ? "in chat" : "to reply"}
				</div>
			)}

			<form
				className="flex flex-col"
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				{/* Mode switcher + headers toggle */}
				<div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5">
					{draft ? (
						<span className="text-xs font-medium text-brand">Editing draft</span>
					) : (
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => {
									setMode("reply");
									setMenu(null);
								}}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
									!isNote
										? "bg-muted text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<Send className="size-3" />
								Reply
							</button>
							<button
								type="button"
								onClick={() => {
									setMode("note");
									setMenu(null);
								}}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
									isNote
										? "bg-amber-500/20 text-amber-900 dark:text-amber-200"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								<StickyNote className="size-3" />
								Internal note
							</button>
						</div>
					)}

					{!isChat && !isNote && (
						<button
							type="button"
							className="ml-1 min-w-0 truncate text-xs text-muted-foreground hover:text-foreground"
							onClick={() => setShowHeaders((v) => !v)}
						>
							{showHeaders ? "Hide headers" : `To ${to || c.contact}`}
						</button>
					)}

					{isChat && c.status === "resolved" && !isNote && (
						<span className="text-xs text-muted-foreground">
							Resolved — replying reopens the chat
						</span>
					)}

					{/* Formatting buttons for email replies */}
					{!isChat && !isNote && (
						<div className="ml-auto hidden items-center gap-0.5 sm:flex">
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title="Bold"
								aria-label="Bold"
								onClick={() => wrapSelection("**", "**", "bold")}
							>
								<Bold className="size-3.5" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title="Italic"
								aria-label="Italic"
								onClick={() => wrapSelection("*", "*", "italic")}
							>
								<Italic className="size-3.5" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title="Link"
								aria-label="Insert link"
								onClick={() => wrapSelection("[", "](https://)", "link text")}
							>
								<Link2 className="size-3.5" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								title="Bulleted list"
								aria-label="Bulleted list"
								onClick={() => wrapSelection("- ", "", "item")}
							>
								<List className="size-3.5" />
							</Button>
							<Button
								type="button"
								variant={previewHtml ? "secondary" : "ghost"}
								size="icon-sm"
								title="Toggle formatted preview"
								aria-label="Toggle formatted preview"
								onClick={() => setPreviewHtml((v) => !v)}
							>
								<Eye className="size-3.5" />
							</Button>
						</div>
					)}
				</div>

				{/* Optional email From/To/Cc/Subject fields */}
				{showHeaders && !isChat && !isNote && (
					<div className="grid gap-2 border-b border-border/60 bg-muted/20 px-3 py-2.5 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor={`c-from-${c.id}`}>From</FieldLabel>
							<Input
								id={`c-from-${c.id}`}
								className="h-8 text-xs"
								value={from}
								placeholder="support@your-domain.com"
								onChange={(e) => setFrom(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`c-to-${c.id}`}>To</FieldLabel>
							<Input
								id={`c-to-${c.id}`}
								className="h-8 text-xs"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`c-cc-${c.id}`}>Cc</FieldLabel>
							<Input
								id={`c-cc-${c.id}`}
								className="h-8 text-xs"
								value={cc}
								onChange={(e) => setCc(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor={`c-sub-${c.id}`}>Subject</FieldLabel>
							<Input
								id={`c-sub-${c.id}`}
								className="h-8 text-xs"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
							/>
						</Field>
					</div>
				)}

				{/* Main textarea + autocomplete menu */}
				<div className="relative">
					<textarea
						ref={box}
						aria-label={isNote ? "Internal note" : "Reply"}
						rows={isChat ? 2 : 3}
						value={text}
						placeholder={
							isNote
								? "Write an internal note… Type @ to mention a teammate."
								: isChat
									? "Write a reply… (/ saved replies, # help articles, Enter sends)"
									: "Write a reply… (/ saved replies, # help articles, ⌘↵ sends)"
						}
						className={cn(
							"field-sizing-content block min-h-[48px] max-h-48 w-full resize-none border-0 bg-transparent px-3 py-2 text-[16px] leading-relaxed text-foreground placeholder:text-faint outline-none focus:outline-none focus-visible:outline-none sm:min-h-[76px] sm:max-h-56 sm:px-3.5 sm:py-2.5 md:text-sm",
							isNote &&
								"placeholder:text-amber-800/60 dark:placeholder:text-amber-200/50",
						)}
						onChange={(e) => {
							setText(e.target.value);
							setMenu(triggerAt(e.target.value, e.target.selectionStart, mode));
							setMenuIndex(0);
							notifyTyping(e.target.value);
						}}
						onClick={(e) => {
							setMenu(triggerAt(text, e.currentTarget.selectionStart, mode));
							setMenuIndex(0);
						}}
						onBlur={() => setTimeout(() => setMenu(null), 150)}
						onPaste={onPaste}
						onKeyDown={(e) => {
							if (choices.length) {
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									e.preventDefault();
									setMenuIndex(
										(i) =>
											(i +
												(e.key === "ArrowDown" ? 1 : -1) +
												choices.length) %
											choices.length,
									);
									return;
								}
								if (e.key === "Enter" || e.key === "Tab") {
									e.preventDefault();
									choices[menuIndex]?.pick();
									return;
								}
								if (e.key === "Escape") {
									setMenu(null);
									return;
								}
							}
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								void send();
								return;
							}
							if (
								isChat &&
								!isNote &&
								e.key === "Enter" &&
								!e.shiftKey &&
								!e.nativeEvent.isComposing
							) {
								e.preventDefault();
								void send();
							}
						}}
					/>

					{choices.length > 0 && (
						<ul className="absolute inset-x-3 bottom-full z-30 mb-1 overflow-hidden rounded-lg bg-popover p-1 text-sm shadow-lg ring-1 ring-border sm:right-auto sm:w-80">
							{choices.map((x, i) => (
								<li key={x.key}>
									<button
										type="button"
										className={cn(
											"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
											i === menuIndex ? "bg-muted" : "hover:bg-muted",
										)}
										onMouseDown={(e) => {
											e.preventDefault();
											x.pick();
										}}
									>
										{x.kind === "mention" ? (
											<Avatar name={x.label} />
										) : x.kind === "article" ? (
											<BookOpen className="size-3.5 shrink-0 text-brand" />
										) : (
											<Zap className="size-3.5 shrink-0 text-muted-foreground" />
										)}
										<span className="min-w-0 flex-1 truncate">{x.label}</span>
										{x.hint && (
											<span className="text-xs text-muted-foreground">
												{x.hint}
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				{/* AI source citations */}
				{aiSources.length > 0 && !isNote && (
					<div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 text-xs text-muted-foreground">
						<Sparkles className="size-3 text-brand" />
						<span>Grounded in:</span>
						{aiSources.map((s) =>
							s.url ? (
								<a
									key={s.title}
									href={s.url}
									target="_blank"
									rel="noreferrer"
									className="rounded bg-muted px-1.5 py-0.5 text-foreground hover:underline"
								>
									{s.title}
								</a>
							) : (
								<span
									key={s.title}
									className="rounded bg-muted px-1.5 py-0.5 text-foreground"
								>
									{s.title}
								</span>
							),
						)}
					</div>
				)}

				{/* Optional formatted email preview */}
				{previewHtml && !isChat && !isNote && text.trim().length > 0 && (
					<div className="mx-3 mt-2 rounded-md border border-border/70 bg-muted/20 p-2.5 text-sm">
						<p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
							Formatted preview
						</p>
						<div
							className="prose prose-sm max-w-none dark:prose-invert"
							// biome-ignore lint/security/noDangerouslySetInnerHtml: markdownToEmailHtml escapes all HTML entities before wrapping tags
							dangerouslySetInnerHTML={{
								__html:
									markdownToEmailHtml(text) ??
									`<p>${text
										.replace(/&/g, "&amp;")
										.replace(/</g, "&lt;")
										.replace(/>/g, "&gt;")
										.replace(/\n/g, "<br>")}</p>`,
							}}
						/>
					</div>
				)}

				{/* Attached files */}
				{files.length > 0 && !isNote && (
					<div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
						{files.map((f) => {
							const isImg =
								Boolean(f.content) && Boolean(f.content_type?.startsWith("image/"));
							return (
								<span
									key={f.id}
									className="inline-flex h-8 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
								>
									{isImg ? (
										<img
											src={`data:${f.content_type};base64,${f.content}`}
											alt={f.filename}
											className="size-5 rounded object-cover"
										/>
									) : (
										<Paperclip className="size-3 text-muted-foreground" />
									)}
									<span className="max-w-44 truncate">{f.filename}</span>
									<span className="text-muted-foreground tabular-nums">
										{Math.max(1, Math.round(f.size / 1024))} KB
									</span>
									<button
										type="button"
										aria-label={`Remove ${f.filename}`}
										onClick={() =>
											setFiles((l) => l.filter((x) => x.id !== f.id))
										}
										className="text-muted-foreground hover:text-foreground"
									>
										<X className="size-3" />
									</button>
								</span>
							);
						})}
					</div>
				)}

				<input
					ref={fileInput}
					type="file"
					multiple={!isChat}
					hidden
					onChange={(e) => void addEmailFiles(e.target.files)}
				/>

				{/* Bottom action bar */}
				<div className="flex flex-wrap items-center gap-1 px-2.5 pt-1.5 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:gap-1.5 sm:px-3 sm:py-2">
					{!isNote && (
						<>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label="Attach file"
								className="h-7 px-2 text-xs text-muted-foreground"
								disabled={busy !== null}
								onClick={() => fileInput.current?.click()}
							>
								<Paperclip className="size-3.5" />
								<span className="hidden sm:inline">Attach</span>
							</Button>

							<SavedPopover
								saved={saved}
								onPick={(s) => insertSaved(s)}
							/>

							<MacrosPopover
								brandId={c.brand_id}
								inboxId={c.inbox_id}
								conversationId={c.id}
								canManage={canManageMacros}
								onInsertReply={(reply) => {
									setMode("reply");
									setText((cur) => (cur.trim() ? `${cur}\n\n${reply}` : reply));
									requestAnimationFrame(() => box.current?.focus());
								}}
								onApplied={onReload}
							/>

							{articles.length > 0 && (
								<ArticlePopover
									articles={articles}
									onPick={(a) => insertArticle(a)}
								/>
							)}

							{/* AI Copilot trigger */}
							{ai.copilot ? (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label="AI Copilot"
											className="h-7 px-2 text-xs text-brand hover:text-brand"
											disabled={busy !== null}
										>
											{busy === "ai" ? (
												<Spinner className="size-3.5" />
											) : (
												<Sparkles className="size-3.5" />
											)}
											<span className="hidden sm:inline">Copilot</span>
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="start"
										className="w-52"
									>
										<DropdownMenuItem onSelect={() => void runAiDraft()}>
											<Sparkles />
											Draft reply from Help Center
										</DropdownMenuItem>
										{text.trim().length > 0 && (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuLabel>Polish draft</DropdownMenuLabel>
												<DropdownMenuItem
													onSelect={() => void runAiPolish("clear")}
												>
													<Wand2 />
													Make clearer
												</DropdownMenuItem>
												<DropdownMenuItem
													onSelect={() => void runAiPolish("friendly")}
												>
													<Wand2 />
													Make friendlier
												</DropdownMenuItem>
												<DropdownMenuItem
													onSelect={() => void runAiPolish("shorter")}
												>
													<Wand2 />
													Make shorter
												</DropdownMenuItem>
												<DropdownMenuItem
													onSelect={() => void runAiPolish("formal")}
												>
													<Wand2 />
													Make more formal
												</DropdownMenuItem>
											</>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							) : (
								<Popover>
									<PopoverTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											aria-label="AI Copilot"
											className="h-7 px-2 text-xs text-muted-foreground"
										>
											<Sparkles className="size-3.5" />
											<span className="hidden sm:inline">Copilot</span>
										</Button>
									</PopoverTrigger>
									<PopoverContent
										align="start"
										className="w-64 p-3 text-xs"
									>
										<p className="font-medium text-foreground">
											BYO-key AI Copilot
										</p>
										<p className="mt-1 text-muted-foreground">
											Add an Anthropic, OpenAI, or compatible API key to draft
											replies from your Help Center and summarize threads.
										</p>
										<Button
											asChild
											size="sm"
											variant="outline"
											className="mt-2.5 h-7 w-full text-xs"
										>
											<Link to="/settings">Set up in Settings</Link>
										</Button>
									</PopoverContent>
								</Popover>
							)}
						</>
					)}

					<div className="ml-auto flex items-center gap-2">
						{!isNote && !isChat && workflow.signature && (
							<label
								htmlFor={`sig-${c.id}`}
								className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
							>
								<Checkbox
									id={`sig-${c.id}`}
									checked={signature}
									onCheckedChange={(v) => setSignature(v === true)}
								/>
								Sig
							</label>
						)}

						{onDone && (
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={onDone}
							>
								Cancel
							</Button>
						)}

						{isNote ? (
							<Button
								type="submit"
								size="sm"
								disabled={busy !== null || !text.trim()}
							>
								{busy === "note" ? <Spinner /> : <StickyNote />}
								Add note
								<Kbd className="ml-1 hidden bg-primary-foreground/15 text-primary-foreground sm:inline-flex">
									⌘↵
								</Kbd>
							</Button>
						) : (
							<div className="flex">
								<Button
									type="submit"
									size="sm"
									className="rounded-r-none"
									disabled={busy !== null || !text.trim()}
								>
									{busy === "send" ? (
										<Spinner />
									) : isChat ? (
										<ArrowUp />
									) : (
										<Send />
									)}
									Send
								</Button>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											size="sm"
											className="rounded-l-none border-l border-primary-foreground/20 px-1.5"
											aria-label="More send options"
											disabled={busy !== null || !text.trim()}
										>
											<ChevronDown className="size-3.5" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent
										align="end"
										className="w-56"
									>
										{c.status === "open" && (
											<DropdownMenuItem
												onSelect={() => void send({ resolve: true })}
											>
												<CircleCheck />
												Send and resolve
											</DropdownMenuItem>
										)}
										<DropdownMenuSeparator />
										<DropdownMenuLabel>Send and snooze</DropdownMenuLabel>
										{[
											{
												label: "4 hours",
												at: new Date(Date.now() + 4 * 3_600_000),
											},
											{ label: "Tomorrow 9am", at: at9(1) },
											{ label: "Next Monday", at: nextMonday() },
										].map((s) => (
											<DropdownMenuItem
												key={s.label}
												onSelect={() => void send({ snooze: s.at })}
											>
												<Clock className="size-3.5 text-muted-foreground" />
												<span className="flex-1">{s.label}</span>
												<span className="text-xs text-muted-foreground">
													{shortDate.format(s.at)}
												</span>
											</DropdownMenuItem>
										))}
										{!isChat && (
											<>
												<DropdownMenuItem onSelect={() => void saveDraft()}>
													<PenLine />
													{draft ? "Update draft" : "Save as draft"}
												</DropdownMenuItem>
												<DropdownMenuSeparator />
												<DropdownMenuLabel>Send later</DropdownMenuLabel>
												{[
													{
														label: "In an hour",
														at: new Date(
															Math.ceil(
																(Date.now() + 3_600_000) / 900_000,
															) * 900_000,
														),
													},
													{ label: "Tomorrow morning", at: at9(1) },
													{ label: "Monday morning", at: nextMonday() },
												].map((p) => (
													<DropdownMenuItem
														key={p.label}
														onSelect={() => void send({ at: p.at })}
													>
														<span className="flex-1">{p.label}</span>
														<span className="text-xs text-muted-foreground">
															{shortDate.format(p.at)}
														</span>
													</DropdownMenuItem>
												))}
												<DropdownMenuItem
													onSelect={() => setPickingTime(true)}
												>
													Pick a time…
												</DropdownMenuItem>
											</>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						)}
					</div>
				</div>
			</form>

			<PickMoment
				open={pickingTime}
				onOpenChange={setPickingTime}
				title="Send later"
				description="The reply waits in the conversation and goes at this time."
				action="Schedule"
				onPick={(d) => void send({ at: d })}
			/>
		</div>
	);
}

function SavedPopover({ saved, onPick }: { saved: Saved[]; onPick: (s: Saved) => void }) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const shown = saved.filter((s) =>
		`${s.name} ${s.shortcut ?? ""} ${s.text}`.toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs text-muted-foreground"
					aria-label="Insert saved reply"
					title="Insert saved reply (/)"
				>
					<Zap className="size-3.5" />
					<span className="hidden sm:inline">Saved</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[min(20rem,calc(100vw-1.5rem))] p-2"
			>
				<Input
					autoFocus
					className="h-8 text-xs"
					placeholder="Search saved replies (or type /)"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
					{shown.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
								onClick={() => {
									onPick(s);
									setOpen(false);
								}}
							>
								<span className="flex items-center gap-2 text-xs">
									<span className="min-w-0 flex-1 truncate font-medium">
										{s.name}
									</span>
									{s.shortcut && (
										<span className="text-muted-foreground">/{s.shortcut}</span>
									)}
								</span>
								<span className="line-clamp-2 text-xs text-muted-foreground">
									{s.text}
								</span>
							</button>
						</li>
					))}
					{!shown.length && (
						<li className="px-2 py-1.5 text-xs text-muted-foreground">
							{saved.length ? "None match." : "No saved replies yet."}
						</li>
					)}
				</ul>
				<div className="mt-1 border-t pt-1.5">
					<Link
						to="/received/replies"
						className="block rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						Manage saved replies
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
}

function ArticlePopover({
	articles,
	onPick,
}: {
	articles: Article[];
	onPick: (a: Article) => void;
}) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const shown = articles.filter((a) =>
		`${a.title} ${a.category ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-xs text-muted-foreground"
					aria-label="Insert Help Center article"
					title="Insert Help Center article (#)"
				>
					<BookOpen className="size-3.5" />
					<span className="hidden sm:inline">Article</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-[min(20rem,calc(100vw-1.5rem))] p-2"
			>
				<Input
					autoFocus
					className="h-8 text-xs"
					placeholder="Search Help Center (or type #)"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
					{shown.map((a) => (
						<li key={a.id}>
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
								onClick={() => {
									onPick(a);
									setOpen(false);
								}}
							>
								<BookOpen className="size-3.5 shrink-0 text-brand" />
								<span className="min-w-0 flex-1 truncate font-medium">
									{a.title}
								</span>
								{a.category && (
									<span className="shrink-0 text-muted-foreground">
										{a.category}
									</span>
								)}
							</button>
						</li>
					))}
					{!shown.length && (
						<li className="px-2 py-1.5 text-xs text-muted-foreground">
							No matching articles.
						</li>
					)}
				</ul>
			</PopoverContent>
		</Popover>
	);
}
