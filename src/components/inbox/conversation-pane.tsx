import { Link, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	ArrowUpRight,
	Bot,
	CircleCheck,
	Clock,
	Code2,
	Copy,
	Download,
	Ellipsis,
	FileText,
	GitMerge,
	History,
	Keyboard,
	Mail,
	MessageCircle,
	MessagesSquare,
	PanelRight,
	Paperclip,
	PenLine,
	RotateCcw,
	Send,
	Settings2,
	ShieldAlert,
	ShieldCheck,
	Sparkles,
	StickyNote,
	Trash2,
	Undo2,
	Workflow,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AnswerMenu } from "@/components/answer-menu";
import { ApiDrawer } from "@/components/api-drawer";
import { ChatThread, type Live } from "@/components/chat-thread";
import { Confirm } from "@/components/confirm";
import { EmailHtmlFrame } from "@/components/inbox/email-html-frame";
import { MergeConversationDialog } from "@/components/inbox/inbox-dialogs";
import { announceSend, UnifiedComposer } from "@/components/inbox/unified-composer";
import type { TeamViewer } from "@/components/inbox/use-inbox-live";
import {
	AssigneeMenu,
	Avatar,
	PriorityMenu,
	SlaBadge,
	SnoozeMenu,
	Stars,
	slaState,
	TagsMenu,
} from "@/components/inbox-triage";
import { CopyMenuItem, MoreMenu } from "@/components/more-menu";
import { PersonActions } from "@/components/person-actions";
import { PersonFacts } from "@/components/person-panel";
import { IdChip } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { aiSummarizeFn } from "@/functions/ai";
import { deleteConversationNowFn } from "@/functions/chat";
import {
	deleteConversationDraftFn,
	deleteNoteFn,
	type getConversationFn,
	markMessageFn,
	olderTimelineFn,
	sendConversationReplyFn,
	unsendReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatSeconds } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export type ConversationData = Awaited<ReturnType<typeof getConversationFn>>;
type Conversation = ConversationData["conversation"];
type Item = Conversation["timeline"][number];
type Draft = Extract<Item, { type: "reply" | "draft" }>;
type Note = Extract<Item, { type: "note" }>;

const ACTIVITY_KEY = "mailroom:inbox-activity";
const PANEL_KEY = "mailroom:inbox-panel";

type Patch = Omit<Parameters<typeof updateConversationFn>[0]["data"], "id">;

const nameOf = (from: string) => /^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

const reasonsOf = (items: Item[]) => [
	...new Set(
		items.flatMap((t) =>
			t.type === "inbound" && t.flags ? t.flags.reasons.map((r) => r.text) : [],
		),
	),
];

/**
 * Intercom-style active conversation workspace: fixed header with collision avatars & quick
 * triage, scrollable unified thread (inline HTML emails + clickable attachments + interleaved
 * amber internal notes + live chat), pinned sticky bottom composer, and collapsible right
 * context sidebar with contact details & previous conversations.
 */
export function ConversationPane({
	data,
	viewers = [],
	embedded = false,
	onReload,
	onSelectConversation,
	onBack,
	onAfterResolve,
	onTypingChange,
}: {
	data: ConversationData;
	viewers?: TeamViewer[];
	/** Inside the 3-pane desktop Inbox split view. */
	embedded?: boolean;
	onReload: () => Promise<void> | void;
	onSelectConversation?: (id: string) => void;
	onBack?: () => void;
	onAfterResolve?: () => void;
	onTypingChange?: (typing: boolean) => void;
}) {
	const router = useRouter();
	const me = useMe();
	const canReply = allows(me.active?.access, "inbox:reply");
	const { conversation: c, inbox, brand, people, workflow } = data;
	const isChat = c.channel === "chat";

	const [busy, setBusy] = useState<string | null>(null);
	const [showPanel, setShowPanel] = useState(true);
	const [menu, setMenu] = useState<"assignee" | "priority" | "tags" | "snooze" | null>(null);
	const [keysOpen, setKeysOpen] = useState(false);
	const [mergeOpen, setMergeOpen] = useState(false);
	const [deletingNow, setDeletingNow] = useState(false);
	const [ask, setAsk] = useState<{ mode: "reply" | "note"; n: number }>({ mode: "reply", n: 0 });
	const [editingDraft, setEditingDraft] = useState<string | null>(null);
	const [live, setLive] = useState<Live | null>(null);
	const [showActivity, setShowActivity] = useState(false);
	const [summary, setSummary] = useState<{
		forId: string;
		summary: string;
		bullets: string[];
		sentiment: "positive" | "neutral" | "frustrated";
	} | null>(null);
	const [summarizing, setSummarizing] = useState(false);

	useEffect(() => {
		try {
			setShowActivity(localStorage.getItem(ACTIVITY_KEY) === "shown");
			if (localStorage.getItem(PANEL_KEY) === "hidden") setShowPanel(false);
		} catch {}
	}, []);

	const togglePanel = () => {
		setShowPanel((v) => {
			try {
				localStorage.setItem(PANEL_KEY, v ? "hidden" : "shown");
			} catch {}
			return !v;
		});
	};

	const toggleActivity = () => {
		setShowActivity((v) => {
			try {
				localStorage.setItem(ACTIVITY_KEY, v ? "hidden" : "shown");
			} catch {}
			return !v;
		});
	};

	// Older timeline pagination
	const [older, setOlder] = useState<{
		forId: string;
		items: Item[];
		more: boolean;
		before: string | null;
		busy: boolean;
	}>({ forId: c.id, items: [], more: c.has_more, before: c.before, busy: false });
	if (older.forId !== c.id)
		setOlder({ forId: c.id, items: [], more: c.has_more, before: c.before, busy: false });

	const timeline = [...older.items, ...c.timeline];
	const notes = timeline.filter((t): t is Note => t.type === "note");
	const pending = timeline.filter(
		(t): t is Draft => t.type === "draft" || (t.type === "reply" && Boolean(t.scheduled_for)),
	);
	const shownEmail = timeline.filter((t) => t.type !== "chat" && !pending.includes(t as Draft));
	const lastInbound = timeline.findLast((t) => t.type === "inbound")?.id;
	const firstUnread = timeline.find((t) => t.type === "inbound" && t.unread)?.id;
	const held = timeline.filter((t) => t.type === "inbound" && t.held);

	// Other teammates viewing/typing in this exact conversation
	const othersHere = viewers.filter(
		(v) => v.userId !== me.user.id && (v.viewing === c.id || v.typingIn === c.id),
	);

	const nameOfReader = (reader: string) => people.find((p) => p.reader === reader)?.name;
	const contactName = isChat
		? c.visitor?.name || c.visitor?.email || "Visitor"
		: nameOf(c.contact);

	const ctx = {
		contact: isChat ? (c.visitor?.name ?? c.visitor?.email ?? "") : c.contact,
		agent: me.user.name || me.user.email,
		inbox: inbox?.name ?? null,
		subject: c.subject,
	};

	const update = async (patch: Patch, key: string, done?: string) => {
		setBusy(key);
		try {
			await updateConversationFn({ data: { id: c.id, ...patch } });
			if (patch.read === false) {
				toast.success("Marked unread");
				await onReload();
				onBack?.();
				return;
			}
			if (done) toast.success(done);
			await onReload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const resolve = async () => {
		await update({ status: "resolved" }, "status", "Resolved");
		onAfterResolve?.();
	};

	const loadOlder = async () => {
		if (!older.before) return;
		setOlder((o) => ({ ...o, busy: true }));
		try {
			const r = await olderTimelineFn({ data: { id: c.id, before: older.before } });
			setOlder((o) => ({
				...o,
				items: [...r.timeline, ...o.items],
				more: r.has_more,
				before: r.before,
				busy: false,
			}));
		} catch (error) {
			toast.error(await errorMessage(error));
			setOlder((o) => ({ ...o, busy: false }));
		}
	};

	const runSummarize = async () => {
		setSummarizing(true);
		try {
			const r = await aiSummarizeFn({ data: { conversation: c.id } });
			setSummary({ forId: c.id, ...r });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setSummarizing(false);
		}
	};

	// Keyboard shortcuts inside conversation
	const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
	const lastG = useRef(0);
	onKey.current = (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		if (e.key === "g") {
			lastG.current = Date.now();
			return;
		}
		if (Date.now() - lastG.current < 1000) return;
		const el = e.target as HTMLElement | null;
		if (el?.closest("input, textarea, select, [contenteditable=true]")) return;
		if (
			document.querySelector(
				"[role=dialog], [role=menu], [data-radix-popper-content-wrapper]",
			)
		)
			return;
		const openMenu = (m: NonNullable<typeof menu>) => {
			if (!canReply) return;
			setShowPanel(true);
			setMenu(m);
		};
		const act: Record<string, () => void> = {
			r: () => canReply && setAsk((a) => ({ mode: "reply", n: a.n + 1 })),
			n: () => canReply && setAsk((a) => ({ mode: "note", n: a.n + 1 })),
			e: () =>
				canReply &&
				(c.status === "open"
					? void resolve()
					: void update({ status: "open" }, "status", "Reopened")),
			u: () => void update({ read: false }, "unread"),
			a: () => openMenu("assignee"),
			p: () => openMenu("priority"),
			t: () => openMenu("tags"),
			s: () => c.status === "open" && openMenu("snooze"),
			"?": () => setKeysOpen(true),
		};
		const run = act[e.key];
		if (!run || busy) return;
		e.preventDefault();
		run();
	};
	useEffect(() => {
		const handler = (e: KeyboardEvent) => onKey.current(e);
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, []);

	const openOther = (id: string) => {
		if (onSelectConversation) onSelectConversation(id);
		else void router.navigate({ to: "/received/$id", params: { id } });
	};

	const activeSummary = summary?.forId === c.id ? summary : null;

	return (
		<div
			className={cn(
				"flex min-h-0 flex-1 flex-col bg-background",
				!embedded && "h-[calc(100svh-3rem)] lg:h-[calc(100svh-1rem)]",
			)}
		>
			{/* Fixed Top Header */}
			<header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
				{!embedded && (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Back to Inbox"
						asChild
					>
						<Link to="/received">
							<ArrowLeft className="size-4" />
						</Link>
					</Button>
				)}

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"flex size-6 shrink-0 items-center justify-center rounded-md",
								isChat
									? "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
									: "bg-brand/12 text-brand",
							)}
						>
							{isChat ? (
								<MessageCircle className="size-3.5" />
							) : (
								<MessagesSquare className="size-3.5" />
							)}
						</span>
						<h1 className="truncate text-sm font-semibold">
							<Ph>{c.subject || "(no subject)"}</Ph>
						</h1>
						{c.status === "resolved" && (
							<Badge
								variant="outline"
								className="h-5 text-[11px]"
							>
								Resolved
							</Badge>
						)}
						{c.snoozed_until && (
							<StatusBadge
								status="snoozed"
								label={`Back ${formatAgo(c.snoozed_until)}`}
							/>
						)}
					</div>
					<p className="mt-0.5 truncate text-xs text-muted-foreground">
						<Ph>{contactName}</Ph>
						{inbox ? ` · ${inbox.name}` : ""}
						{brand ? ` · ${brand.name}` : ""}
					</p>
				</div>

				{/* Real-time teammate collision avatars */}
				{othersHere.length > 0 && (
					<div className="hidden items-center gap-1.5 rounded-full border border-amber-500/35 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-900 dark:text-amber-200 sm:flex">
						<span className="flex -space-x-1">
							{othersHere.slice(0, 3).map((v) => (
								<Avatar
									key={v.userId}
									name={v.name}
									className="size-5 text-[10px] ring-2 ring-background"
								/>
							))}
						</span>
						<span className="max-w-36 truncate font-medium">
							{othersHere.some((v) => v.typingIn === c.id)
								? `${othersHere.find((v) => v.typingIn === c.id)?.name} is replying…`
								: othersHere.length === 1
									? `${othersHere[0]?.name} viewing`
									: `${othersHere.length} viewing`}
						</span>
					</div>
				)}

				<div className="flex shrink-0 items-center gap-1">
					{data.ai.copilot && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Summarize conversation"
									disabled={summarizing}
									onClick={() => void runSummarize()}
								>
									{summarizing ? (
										<Spinner className="size-3.5" />
									) : (
										<Sparkles className="size-4 text-brand" />
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>AI summary</TooltipContent>
						</Tooltip>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Mark unread"
								disabled={busy !== null}
								onClick={() => void update({ read: false }, "unread")}
							>
								{busy === "unread" ? <Spinner /> : <Mail className="size-4" />}
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							Mark unread <Kbd>U</Kbd>
						</TooltipContent>
					</Tooltip>

					{c.status === "open" ? (
						<Button
							size="sm"
							disabled={busy !== null}
							title="Resolve (E)"
							onClick={() => void resolve()}
						>
							{busy === "status" ? <Spinner /> : <CircleCheck className="size-3.5" />}
							<span className="hidden sm:inline">Resolve</span>
						</Button>
					) : (
						<Button
							size="sm"
							variant="outline"
							disabled={busy !== null}
							onClick={() => void update({ status: "open" }, "status", "Reopened")}
						>
							{busy === "status" ? <Spinner /> : <RotateCcw className="size-3.5" />}
							<span className="hidden sm:inline">Reopen</span>
						</Button>
					)}

					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant={showPanel ? "secondary" : "ghost"}
								size="icon-sm"
								aria-label="Toggle details sidebar"
								aria-pressed={showPanel}
								onClick={togglePanel}
							>
								<PanelRight className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Contact &amp; details</TooltipContent>
					</Tooltip>

					<MoreMenu>
						{canReply && (
							<DropdownMenuItem onSelect={() => setMergeOpen(true)}>
								<GitMerge />
								Merge another conversation…
							</DropdownMenuItem>
						)}
						{!isChat && (
							<DropdownMenuItem onSelect={toggleActivity}>
								<History />
								{showActivity ? "Hide activity log" : "Show activity log"}
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onSelect={() => setKeysOpen(true)}>
							<Keyboard />
							Keyboard shortcuts
						</DropdownMenuItem>
						<CopyMenuItem
							icon={Copy}
							label="Copy conversation id"
							value={c.id}
						/>
						{inbox && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuLabel className="truncate text-xs font-normal text-muted-foreground">
									{inbox.name}
								</DropdownMenuLabel>
								<DropdownMenuItem asChild>
									<Link
										to="/received/inboxes/$id"
										params={{ id: inbox.id }}
									>
										<Settings2 />
										Inbox settings
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<Link
										to="/received/workflow/$id"
										params={{ id: inbox.id }}
									>
										<Workflow />
										Workflow &amp; SLA
									</Link>
								</DropdownMenuItem>
								<DropdownMenuItem asChild>
									<Link
										to="/received/chat/$id"
										params={{ id: inbox.id }}
									>
										<MessageCircle />
										Website chat
									</Link>
								</DropdownMenuItem>
							</>
						)}
						{isChat && canReply && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onSelect={() => setDeletingNow(true)}
								>
									<Trash2 />
									Delete chat now
								</DropdownMenuItem>
							</>
						)}
					</MoreMenu>
				</div>
			</header>

			{/* Body: Center Thread + Collapsible Right Context Rail */}
			<div className="flex min-h-0 flex-1 overflow-hidden">
				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					{/* AI Summary Card */}
					{activeSummary && (
						<div className="shrink-0 border-b border-brand/20 bg-brand/[0.04] px-4 py-3 text-sm">
							<div className="flex items-start gap-2">
								<Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-xs font-semibold uppercase tracking-wide text-brand">
											AI Summary
										</span>
										<Badge
											variant={
												activeSummary.sentiment === "frustrated"
													? "destructive"
													: activeSummary.sentiment === "positive"
														? "brand"
														: "secondary"
											}
											className="h-4.5 text-[10px] capitalize"
										>
											{activeSummary.sentiment}
										</Badge>
									</div>
									<p className="mt-1 text-sm">{activeSummary.summary}</p>
									{activeSummary.bullets.length > 0 && (
										<ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
											{activeSummary.bullets.map((b) => (
												<li key={b}>{b}</li>
											))}
										</ul>
									)}
								</div>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="Dismiss summary"
									onClick={() => setSummary(null)}
								>
									<X className="size-3.5" />
								</Button>
							</div>
						</div>
					)}

					{/* Suspicious / Held banner */}
					{c.held && (
						<div className="shrink-0 border-b px-4 py-3">
							<Alert variant="warning">
								<ShieldAlert />
								<AlertTitle>Held for a person</AlertTitle>
								<AlertDescription className="flex flex-wrap items-center justify-between gap-2">
									<span>
										Agents don't see{" "}
										{held.length === 1
											? "one message"
											: `${held.length || "some"} messages`}{" "}
										until reviewed
										{reasonsOf(held).length
											? `: ${reasonsOf(held).join("; ")}.`
											: "."}
									</span>
									<Button
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onClick={() =>
											void update(
												{
													release_held: true,
													held_seen: c.held_at ?? undefined,
												},
												"release",
												"Agents can see it now",
											)
										}
									>
										{busy === "release" ? <Spinner /> : <ShieldCheck />}
										Release to agents
									</Button>
								</AlertDescription>
							</Alert>
						</div>
					)}

					{/* Website Chat Thread (interleaved notes + unified sticky composer!) */}
					{isChat ? (
						<ChatThread
							conversation={c}
							canReply={canReply}
							embedded
							notes={notes}
							onLive={setLive}
							onDeleteNote={async (noteId) => {
								try {
									await deleteNoteFn({
										data: { conversation: c.id, id: noteId },
									});
									toast.success("Note deleted");
									await onReload();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
							renderComposer={({ sendText, sendFile, onType }) => (
								<UnifiedComposer
									key={c.id}
									data={data}
									ctx={ctx}
									ask={ask}
									onReload={onReload}
									onTypingChange={onTypingChange}
									onChatSendText={sendText}
									onChatSendFile={sendFile}
									onChatTyping={onType}
								/>
							)}
						/>
					) : (
						<>
							{/* Scrollable Email + Interleaved Notes Timeline */}
							<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
								<div className="mx-auto flex max-w-3xl flex-col gap-3">
									{older.more && (
										<div className="flex justify-center">
											<Button
												variant="outline"
												size="sm"
												disabled={older.busy}
												onClick={() => void loadOlder()}
											>
												{older.busy && <Spinner />}
												Load older messages
											</Button>
										</div>
									)}

									{shownEmail.map((item) => (
										<div key={`${item.type}-${item.id}`}>
											{item.id === firstUnread && (
												<div className="mb-3 flex items-center gap-3 text-xs font-medium text-brand">
													<span className="h-px flex-1 bg-brand/40" />
													New since you last read
													<span className="h-px flex-1 bg-brand/40" />
												</div>
											)}
											<EmailTimelineCard
												conversationId={c.id}
												item={item}
												canReply={canReply}
												onReload={onReload}
											/>
										</div>
									))}

									{showActivity && data.activity.length > 0 && (
										<div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
											<p className="mb-1 font-medium text-foreground">
												Recent activity
											</p>
											<ul className="space-y-0.5">
												{data.activity.slice(0, 10).map((ev) => (
													<li
														key={ev.id}
														className="flex justify-between gap-2"
													>
														<span className="truncate">
															{ev.actor.name ?? "System"} ·{" "}
															{ev.action}
														</span>
														<span className="shrink-0 tabular-nums">
															{formatAgo(ev.created_at)}
														</span>
													</li>
												))}
											</ul>
										</div>
									)}

									{/* Pending drafts & scheduled replies */}
									{pending.map((item) =>
										item.type === "draft" && editingDraft === item.id ? (
											<Card
												key={item.id}
												className="overflow-hidden p-0"
											>
												<UnifiedComposer
													data={data}
													ctx={ctx}
													draft={item}
													lastInbound={lastInbound}
													onReload={onReload}
													onDone={() => setEditingDraft(null)}
												/>
											</Card>
										) : (
											<PendingCard
												key={`${item.type}-${item.id}`}
												conversationId={c.id}
												item={item}
												canReply={canReply}
												undoSeconds={workflow.undo_seconds}
												onEdit={() => setEditingDraft(item.id)}
												onReload={onReload}
											/>
										),
									)}
								</div>
							</div>

							{/* Sticky Bottom Email Composer */}
							{canReply && !editingDraft && (
								<UnifiedComposer
									key={c.id}
									data={data}
									ctx={ctx}
									lastInbound={lastInbound}
									ask={ask}
									onReload={onReload}
									onTypingChange={onTypingChange}
								/>
							)}
						</>
					)}
				</div>

				{/* Collapsible Right Context Rail (Triage + Person + Previous Conversations + Metadata) */}
				{showPanel && (
					<aside
						aria-label="Conversation details"
						className="hidden w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-border bg-muted/10 p-4 md:flex xl:w-80"
					>
						{/* Triage controls */}
						<dl className="flex flex-col gap-1">
							<Detail label="Owner">
								<AssigneeMenu
									row
									open={menu === "assignee"}
									onOpenChange={(o) => setMenu(o ? "assignee" : null)}
									holder={c.assignee}
									people={people}
									me={data.me}
									disabled={!canReply || busy !== null}
									onChange={(reader) =>
										void update(
											{ assignee: reader },
											"assignee",
											reader
												? reader === data.me
													? "Assigned to you"
													: `Assigned to ${nameOfReader(reader) ?? "them"}`
												: "Unassigned",
										)
									}
								/>
							</Detail>
							<Detail label="Priority">
								<PriorityMenu
									row
									open={menu === "priority"}
									onOpenChange={(o) => setMenu(o ? "priority" : null)}
									priority={c.priority}
									disabled={!canReply || busy !== null}
									onChange={(priority) => void update({ priority }, "priority")}
								/>
							</Detail>
							<Detail label="Tags">
								<TagsMenu
									row
									open={menu === "tags"}
									onOpenChange={(o) => setMenu(o ? "tags" : null)}
									tags={c.tags}
									catalog={workflow.tags}
									disabled={!canReply || busy !== null}
									onChange={(tags) => void update({ tags }, "tags")}
								/>
							</Detail>
							{c.status === "open" && (
								<Detail label="Snooze">
									<SnoozeMenu
										row
										open={menu === "snooze"}
										onOpenChange={(o) => setMenu(o ? "snooze" : null)}
										until={c.snoozed_until}
										disabled={!canReply || busy !== null}
										onChange={(until) =>
											void update(
												{ snooze_until: until },
												"snooze",
												until
													? `Snoozed until ${formatDateTime(until)}`
													: "Unsnoozed",
											)
										}
									/>
								</Detail>
							)}
							{slaState(c.sla, c.status) && (
								<Detail label="SLA">
									<SlaBadge
										sla={c.sla}
										status={c.status}
									/>
								</Detail>
							)}
						</dl>

						{/* Contact + PersonPanel + Previous conversations */}
						<div className="flex flex-col gap-4 border-t border-border pt-4">
							<div className="flex items-start justify-between gap-2">
								<div className="flex min-w-0 items-center gap-2.5">
									<Avatar
										name={contactName}
										className="size-8 text-xs"
									/>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">
											<Ph>{contactName}</Ph>
										</p>
										<p className="truncate text-xs text-muted-foreground">
											<Ph>
												{isChat
													? (c.visitor?.email ??
														(live?.visitorOnline
															? "Online now"
															: "Website visitor"))
													: c.contact}
											</Ph>
										</p>
									</div>
								</div>
								{data.contact?.contact && (
									<Button
										variant="ghost"
										size="icon-sm"
										asChild
										title="Open contact"
									>
										<Link
											to="/contacts/$id"
											params={{ id: data.contact.contact.id }}
											search={{ brand: c.brand_id }}
										>
											<ArrowUpRight className="size-3.5" />
										</Link>
									</Button>
								)}
							</div>

							{canReply && (
								<PersonActions
									conversationId={c.id}
									isContact={Boolean(data.contact?.contact)}
									inSegments={
										data.contact && "segments" in data.contact
											? data.contact.segments.map((s) => s.id)
											: []
									}
									inNewsletters={
										data.contact && "newsletters" in data.contact
											? data.contact.newsletters.map((n) => n.id)
											: []
									}
								/>
							)}

							{data.contact && (
								<PersonFacts
									p={data.contact}
									brand={c.brand_id}
								/>
							)}

							{/* Previous conversations by this person (Intercom-style history) */}
							{data.contact && data.contact.others.length > 0 && (
								<div className="flex flex-col gap-1.5 border-t border-border pt-4">
									<h3 className="eyebrow">
										Other conversations ({data.contact.others.length})
									</h3>
									<ul className="flex flex-col gap-0.5">
										{data.contact.others.map((o) => (
											<li key={o.id}>
												<button
													type="button"
													onClick={() => openOther(o.id)}
													className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/70"
												>
													{o.channel === "chat" ? (
														<MessageCircle className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
													) : (
														<Mail className="size-3.5 shrink-0 text-muted-foreground" />
													)}
													<span className="min-w-0 flex-1 truncate font-medium">
														{o.subject || "(no subject)"}
													</span>
													<span className="shrink-0 text-muted-foreground tabular-nums">
														{formatAgo(o.last_message_at)}
													</span>
												</button>
											</li>
										))}
									</ul>
								</div>
							)}
						</div>

						{/* Conversation metadata */}
						<dl className="flex flex-col gap-1 border-t border-border pt-4 text-xs">
							{inbox && (
								<Detail label="Inbox">
									<Link
										to="/received/inboxes/$id"
										params={{ id: inbox.id }}
										className="truncate text-xs hover:underline"
									>
										{inbox.name}
									</Link>
								</Detail>
							)}
							<Detail label="Started">
								<span className="text-xs">{formatDateTime(c.created_at)}</span>
							</Detail>
							<Detail label="First reply">
								<span className="text-xs">
									{c.first_reply_at
										? `after ${formatSeconds(
												Math.max(
													0,
													(Date.parse(c.first_reply_at) -
														Date.parse(c.created_at)) /
														1000,
												),
											)}`
										: "Not yet"}
								</span>
							</Detail>
							{c.csat && (
								<Detail label="Rating">
									{c.csat.rating ? (
										<Stars rating={c.csat.rating} />
									) : (
										<span className="text-xs text-muted-foreground">
											Asked, no answer
										</span>
									)}
								</Detail>
							)}
							<Detail label="ID">
								<IdChip value={c.id} />
							</Detail>
							<div className="pt-2">
								<ApiDrawer
									title="Conversation API"
									description="Access this conversation with a full-access key or inbox credential."
									calls={[
										{
											title: "Get conversation",
											method: "GET",
											path: `/conversations/${c.id}?mark_read=true`,
										},
										{
											title: "Send reply",
											method: "POST",
											path: `/conversations/${c.id}/reply`,
											body: { text: "Thanks for writing!" },
										},
										{
											title: "Update triage",
											method: "PATCH",
											path: `/conversations/${c.id}`,
											body: { status: "resolved" },
										},
									]}
								/>
							</div>
						</dl>
					</aside>
				)}
			</div>

			{/* Dialogs */}
			<MergeConversationDialog
				open={mergeOpen}
				onOpenChange={setMergeOpen}
				keepId={c.id}
				keepSubject={c.subject}
				candidates={data.contact?.others ?? []}
				onMerged={onReload}
			/>

			{isChat && canReply && (
				<Confirm
					open={deletingNow}
					onOpenChange={setDeletingNow}
					title="Delete this chat now?"
					description="The messages and files go for good, and the visitor's chat ends."
					action="Delete now"
					onConfirm={async () => {
						try {
							await deleteConversationNowFn({ data: { id: c.id } });
							toast.success("Chat deleted");
							await router.navigate({ to: "/received" });
						} catch (error) {
							toast.error(await errorMessage(error));
						}
					}}
				/>
			)}

			<Dialog
				open={keysOpen}
				onOpenChange={setKeysOpen}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Inbox shortcuts</DialogTitle>
						<DialogDescription>Press anywhere outside a text field.</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
							{[
								["J / K", "Next / previous conversation"],
								["R", "Focus reply composer"],
								["N", "Switch to internal note"],
								["E", "Resolve / reopen"],
								["U", "Mark unread"],
								["A", "Assign owner"],
								["P", "Set priority"],
								["T", "Edit tags"],
								["S", "Snooze"],
								["/ or #", "Insert saved reply or Help article"],
							].map(([k, desc]) => (
								<div
									key={k}
									className="contents"
								>
									<dt>
										<Kbd>{k}</Kbd>
									</dt>
									<dd className="text-muted-foreground">{desc}</dd>
								</div>
							))}
						</dl>
					</DialogBody>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-h-7 grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-2">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</div>
	);
}

/** One item in the email timeline: inbound message (inline HTML + clickable downloads), team reply, origin email, or amber internal note. */
function EmailTimelineCard({
	conversationId,
	item: t,
	canReply,
	onReload,
}: {
	conversationId: string;
	item: Item;
	canReply: boolean;
	onReload: () => Promise<void> | void;
}) {
	const router = useRouter();
	const [showQuoted, setShowQuoted] = useState(false);
	const [preferHtml, setPreferHtml] = useState(
		t.type === "inbound" && Boolean(t.html) && !(t.new_text || t.text)?.trim(),
	);

	if (t.type === "origin") {
		return (
			<Card className="flex-row items-center gap-3 bg-muted/30 px-4 py-2.5 text-xs shadow-none">
				<Send className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate">
					Started as a reply to <span className="font-medium">{t.subject}</span>
				</span>
				<Link
					to="/emails/$id"
					params={{ id: t.email_id }}
					className="shrink-0 text-brand hover:underline"
				>
					Open email
				</Link>
			</Card>
		);
	}

	if (t.type === "note") {
		return (
			<div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] px-4 py-3 text-sm">
				<div className="mb-1.5 flex items-center gap-2 text-xs text-amber-900/80 dark:text-amber-200/80">
					<StickyNote className="size-3.5 shrink-0" />
					<span className="font-medium">{t.author.name ?? "Teammate"}</span>
					<span>· internal note</span>
					<span className="ml-auto tabular-nums">{formatAgo(t.at)}</span>
					{canReply && (
						<button
							type="button"
							aria-label="Delete note"
							onClick={async () => {
								try {
									await deleteNoteFn({
										data: { conversation: conversationId, id: t.id },
									});
									toast.success("Note deleted");
									await onReload();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
							className="rounded p-0.5 hover:bg-amber-500/15"
						>
							<Trash2 className="size-3.5" />
						</button>
					)}
				</div>
				<p className="whitespace-pre-wrap break-words text-foreground">
					<Ph>{t.text}</Ph>
				</p>
			</div>
		);
	}

	if (t.type === "inbound") {
		const textBody = showQuoted ? t.text : (t.new_text ?? t.text);
		const htmlBody = "html" in t ? (t.html ?? null) : null;
		const atts = (t.attachments ?? []) as {
			id: string;
			filename?: string | null;
			content_type?: string | null;
			size?: number | null;
			download_url?: string;
		}[];
		return (
			<Card className="gap-3 px-4 py-3.5">
				<div className="flex items-start gap-2.5">
					<Avatar
						name={nameOf(t.from)}
						className="mt-0.5 size-7 text-[11px]"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="truncate text-sm font-medium">
								<Ph>{nameOf(t.from)}</Ph>
							</span>
							{t.spam && (
								<Badge
									variant="destructive"
									className="h-4.5 text-[10px]"
								>
									Spam
								</Badge>
							)}
							{t.held && (
								<StatusBadge
									status="held"
									label="Held"
								/>
							)}
						</div>
						<p className="truncate text-xs text-muted-foreground">
							to {t.to.join(", ")}
							{t.cc?.length ? ` · cc ${t.cc.join(", ")}` : ""}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
						<span
							className="mr-1 tabular-nums"
							title={formatDateTime(t.at)}
						>
							{formatAgo(t.at)}
						</span>
						{htmlBody && (
							<Button
								size="icon-sm"
								variant={preferHtml ? "secondary" : "ghost"}
								title={preferHtml ? "Show plain text" : "Show rich HTML"}
								aria-label="Toggle HTML view"
								onClick={() => setPreferHtml((v) => !v)}
							>
								<Code2 className="size-3.5" />
							</Button>
						)}
						<Button
							size="icon-sm"
							variant="ghost"
							title="Mark this message unread"
							aria-label="Mark unread"
							onClick={async () => {
								try {
									await markMessageFn({ data: { id: t.id, read: false } });
									toast.success("Marked unread");
									await router.navigate({ to: "/received" });
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						>
							<Mail className="size-3.5" />
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							asChild
						>
							<Link
								to="/received/m/$id"
								params={{ id: t.id }}
								title="Inspect headers, SPF/DKIM/DMARC & original email"
								aria-label="Full message details"
							>
								<ArrowUpRight className="size-3.5" />
							</Link>
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-3 sm:pl-9">
					{preferHtml && htmlBody ? (
						<EmailHtmlFrame
							html={htmlBody}
							title={t.subject || "Inbound email"}
						/>
					) : (
						<>
							<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
								<Ph>
									{textBody?.trim() ||
										(htmlBody
											? "HTML-only message."
											: "Message body expired past retention.")}
								</Ph>
							</p>
							{t.quoted && (
								<button
									type="button"
									className="flex w-fit items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
									aria-expanded={showQuoted}
									onClick={() => setShowQuoted((w) => !w)}
								>
									<Ellipsis className="size-3.5" />
									{showQuoted ? "Hide quoted text" : "Show quoted text"}
								</button>
							)}
						</>
					)}

					{atts.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{atts.map((a) => {
								const isImg =
									a.download_url &&
									(a.content_type?.startsWith("image/") ||
										/\.(png|jpe?g|gif|webp)$/i.test(a.filename ?? ""));
								if (isImg) {
									return (
										<a
											key={a.id}
											href={a.download_url}
											target="_blank"
											rel="noreferrer"
											className="group relative block overflow-hidden rounded-lg border border-border"
										>
											<img
												src={a.download_url}
												alt={a.filename ?? "Attachment"}
												className="max-h-40 max-w-52 object-cover"
												loading="lazy"
											/>
											<span className="block truncate bg-muted/80 px-2 py-0.5 text-[11px] text-muted-foreground">
												{a.filename}
											</span>
										</a>
									);
								}
								return a.download_url ? (
									<a
										key={a.id}
										href={a.download_url}
										target="_blank"
										rel="noreferrer"
										className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 text-xs font-medium transition-colors hover:bg-muted"
									>
										<FileText className="size-3.5 text-muted-foreground" />
										<span className="max-w-44 truncate">
											{a.filename ?? a.id}
										</span>
										{a.size ? (
											<span className="text-muted-foreground tabular-nums">
												{Math.max(1, Math.round(a.size / 1024))} KB
											</span>
										) : null}
										<Download className="size-3 text-muted-foreground" />
									</a>
								) : (
									<span
										key={a.id}
										className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
									>
										<Paperclip className="size-3 text-muted-foreground" />
										{a.filename ?? a.id}
									</span>
								);
							})}
						</div>
					)}
				</div>
			</Card>
		);
	}

	if (t.type === "reply") {
		return (
			<Card className="gap-2.5 border-brand/20 bg-brand/[0.03] px-4 py-3.5">
				<div className="flex items-start gap-2.5">
					<Avatar
						name={t.author.name ?? "Team"}
						agent={t.author.type === "agent"}
						className="mt-0.5 size-7 text-[11px]"
					/>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-1.5">
							<span className="truncate text-sm font-medium">
								{t.author.name ?? "Team"}
							</span>
							{t.author.type === "agent" && (
								<Badge
									variant="secondary"
									className="h-4.5 text-[10px]"
								>
									<Bot className="size-3" />
									Agent
								</Badge>
							)}
							{t.sent_by && (
								<span className="text-xs text-muted-foreground">
									approved by {t.sent_by}
								</span>
							)}
							{t.delivery && (
								<Badge
									variant="outline"
									className="h-4.5 text-[10px]"
								>
									{t.delivery.replace(/^email\./, "")}
								</Badge>
							)}
						</div>
						<p className="truncate text-xs text-muted-foreground">
							to {t.to.join(", ")}
							{t.cc?.length ? ` · cc ${t.cc.join(", ")}` : ""}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<span
							className="tabular-nums"
							title={formatDateTime(t.at)}
						>
							{formatAgo(t.at)}
						</span>
						<AnswerMenu messageId={t.id} />
					</div>
				</div>
				<p className="text-sm leading-relaxed whitespace-pre-wrap break-words sm:pl-9">
					<Ph>{t.text}</Ph>
				</p>
			</Card>
		);
	}

	return null;
}

function PendingCard({
	conversationId,
	item: t,
	canReply,
	undoSeconds,
	onEdit,
	onReload,
}: {
	conversationId: string;
	item: Draft;
	canReply: boolean;
	undoSeconds: number;
	onEdit: () => void;
	onReload: () => Promise<void> | void;
}) {
	const [busy, setBusy] = useState(false);

	if (t.type === "reply" && t.scheduled_for) {
		return (
			<Card className="flex-row items-center gap-3 border border-dashed border-border-strong bg-transparent px-4 py-3 shadow-none">
				<Clock className="size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<p className="text-sm">
						<span className="font-medium">{t.author.name ?? "Reply"}</span>{" "}
						<span className="text-muted-foreground">
							scheduled for {formatDateTime(t.scheduled_for)}
						</span>
					</p>
					<p className="truncate text-xs text-muted-foreground">
						{(t.text ?? "").replace(/\s+/g, " ")}
					</p>
				</div>
				{canReply && (
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await unsendReplyFn({ data: { id: t.id } });
								toast.success("Called back: back to draft");
								await onReload();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<Undo2 className="size-3.5" />
						Undo
					</Button>
				)}
			</Card>
		);
	}

	return (
		<Card className="gap-3 border-brand/30 bg-brand/[0.04] px-4 py-3.5">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<PenLine className="size-3.5 text-brand" />
				<span>
					<span className="font-medium text-foreground">
						{t.author.name ?? "An agent"}
					</span>{" "}
					drafted a reply for review
				</span>
				<span className="ml-auto tabular-nums">{formatAgo(t.at)}</span>
			</div>
			<p className="text-sm whitespace-pre-wrap break-words">
				<Ph>{t.text}</Ph>
			</p>
			{canReply && (
				<div className="flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								const sent = await sendConversationReplyFn({
									data: { conversation: conversationId, draft: t.id },
								});
								announceSend(sent, false, undoSeconds, onReload);
								await onReload();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? <Spinner /> : <Send className="size-3.5" />}
						Approve and send
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={onEdit}
					>
						<PenLine className="size-3.5" />
						Edit
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await deleteConversationDraftFn({ data: { id: t.id } });
								toast.success("Draft discarded");
								await onReload();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<Trash2 className="size-3.5" />
						Discard
					</Button>
				</div>
			)}
		</Card>
	);
}
