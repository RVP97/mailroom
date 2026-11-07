import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Bot,
	ChevronDown,
	ChevronRight,
	ChevronUp,
	CircleCheck,
	Clock,
	Copy,
	Ellipsis,
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
	Star,
	StickyNote,
	Trash2,
	Undo2,
	User,
	Workflow,
	X,
	Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { ChatThread, type Live } from "@/components/chat-thread";
import { Confirm } from "@/components/confirm";
import { CopyValue } from "@/components/copy";
import {
	AssigneeMenu,
	Avatar,
	PickMoment,
	PriorityMenu,
	SlaBadge,
	SnoozeMenu,
	Stars,
	slaState,
	TagsMenu,
} from "@/components/inbox-triage";
import { CopyMenuItem, MoreMenu } from "@/components/more-menu";
import { Page, Section } from "@/components/page";
import { IdChip, RecordHeader } from "@/components/record";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteConversationNowFn } from "@/functions/chat";
import {
	addNoteFn,
	deleteConversationDraftFn,
	deleteNoteFn,
	getConversationFn,
	markMessageFn,
	olderTimelineFn,
	saveConversationDraftFn,
	sendConversationReplyFn,
	unsendReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatSeconds } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { neighbors } from "@/lib/received-order";
import { fillVariables } from "@/lib/reply-variables";
import { ago, listedRow, Ph, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** One conversation: everything in it in order (what came in, our replies, open drafts, the
 * team's notes), who has it and how it's triaged, and the reply box. A received message whole
 * (preview, headers, report) is received.m.$id.tsx. */
export const Route = createFileRoute("/_app/received/$id")({
	loader: ({ params }) => getConversationFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.conversation.subject || "Conversation"} · Mailroom` }],
	}),
	component: ConversationPage,
	pendingComponent: ConversationSketch,
});

type Data = Awaited<ReturnType<typeof getConversationFn>>;
type Item = Data["conversation"]["timeline"][number];
type Conversation = Data["conversation"];

function ConversationSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("conversation-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<ConversationPage />
			</Sketch>
		);
	const listed = listedRow<{ subject: string; contact: string; last_message_at: string }>(
		"received",
		params.id,
	);
	const at = listed?.last_message_at ?? ago(30);
	const data: Data = {
		conversation: {
			object: "conversation",
			id: params.id ?? "",
			brand_id: "",
			inbox_id: null,
			channel: "email",
			subject: listed?.subject ?? "Question about my booking",
			contact: listed?.contact ?? "guest@example.com",
			status: "open",
			unread: false,
			messages: 1,
			drafts: 0,
			snippet: null,
			last_message_at: at,
			last_inbound_at: at,
			last_reply_at: null,
			replied_by: null,
			resolved_at: null,
			created_at: at,
			assignee: null,
			tags: [],
			priority: "normal",
			snoozed_until: null,
			first_reply_at: null,
			sla: { reply_due_at: null, resolve_due_at: null, breached: [] },
			csat: null,
			held: false,
			held_at: null,
			has_more: false,
			before: null,
			timeline: [
				{
					type: "inbound",
					id: "sketch",
					at,
					unread: false,
					from: listed?.contact ?? "guest@example.com",
					to: ["support@example.com"],
					cc: [],
					reply_to: [],
					subject: listed?.subject ?? "Question",
					message_id: null,
					text: "Hello, I wanted to ask about my booking for next week.",
					new_text: "Hello, I wanted to ask about my booking for next week.",
					quoted: false,
					attachments: [],
					spam: false,
					verdicts: {
						spam: "PASS",
						virus: "PASS",
						spf: "PASS",
						dkim: "PASS",
						dmarc: "PASS",
					},
					flags: null,
					held: false,
				},
			],
		},
		compose: { from: null, to: [], subject: "", fixed_from: false },
		inbox: null,
		brand: null,
		activity: [],
		me: "",
		people: [],
		saved: [],
		variables: [],
		workflow: { tags: [], undo_seconds: 0, signature: false, sla: false },
		contact: null,
	};
	return (
		<Sketch data={data}>
			<ConversationPage />
		</Sketch>
	);
}

const ACTIONS: Record<string, string> = {
	"conversation.read": "read the conversation",
	"conversation.resolved": "resolved it",
	"conversation.reopened": "reopened it",
	"conversation.assigned": "assigned it",
	"conversation.unassigned": "unassigned it",
	"conversation.claimed": "started working on it",
	"conversation.released": "let go of it",
	"conversation.tagged": "changed its tags",
	"conversation.prioritized": "changed its priority",
	"conversation.snoozed": "snoozed it",
	"conversation.woke": "brought it back from a snooze",
	"conversation.released_to_agents": "let agents see the held mail",
	"draft.created": "wrote a draft",
	"draft.updated": "edited a draft",
	"draft.deleted": "discarded a draft",
	"draft.discarded": "discarded a draft",
	"reply.sent": "sent a reply",
	"reply.unsent": "called a reply back",
	"reply.failed": "couldn't send a reply (it's open again)",
	"note.created": "added a note",
	"note.deleted": "deleted a note",
	"message.held": "held a message for a person",
	"rule.matched": "ran a rule",
	"sla.breached": "missed the SLA",
	"csat.sent": "sent the rating survey",
	"csat.received": "got a rating",
	"attachment.downloaded": "downloaded an attachment",
	"message.read": "read a message",
	"chat.started": "opened the chat (the visitor's first message)",
	"chat.ended": "closed it: the visitor ended the chat",
	"chat.handed_off": "handed the chat from its agent to the team",
};

type Patch = Omit<Parameters<typeof updateConversationFn>[0]["data"], "id">;

function ConversationPage() {
	const data = usePage(Route).data;
	const router = useRouter();
	const me = useMe();
	const canReply = allows(me.active?.access, "inbox:reply");
	const { conversation: c, inbox, brand, activity, compose, workflow, people } = data;
	useOpened(
		"conversation-page",
		useMemo(() => ({ ...data, id: c.id, activity: [] }), [data, c.id]),
	);
	const [busy, setBusy] = useState<string | null>(null);
	const reload = () => router.invalidate();
	// Where it sits in the list the person came from (read after the first paint: sessionStorage).
	const [nav, setNav] = useState<ReturnType<typeof neighbors>>(() => ({
		index: -1,
		total: 0,
		prev: null,
		next: null,
		search: null,
	}));
	useEffect(() => setNav(neighbors(c.id)), [c.id]);
	const go = (id: string | null) =>
		id ? router.navigate({ to: "/received/$id", params: { id } }) : undefined;
	const back = () => router.navigate({ to: "/received", search: nav.search ?? {} });
	const update = async (patch: Patch, key: string, done?: string) => {
		setBusy(key);
		try {
			await updateConversationFn({ data: { id: c.id, ...patch } });
			if (patch.read === false) {
				toast.success("Marked unread");
				await back();
				return;
			}
			if (done) toast.success(done);
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	/** Resolve it and move on to the next one in the list, as a queue. */
	const resolve = async () => {
		await update(
			{ status: "resolved" },
			"status",
			nav.next ? "Resolved, on to the next one" : "Resolved",
		);
		if (nav.next) await go(nav.next);
	};
	const [panel, setPanel] = useState(false);
	const [menu, setMenu] = useState<"assignee" | "priority" | "tags" | "snooze" | null>(null);
	const [keysOpen, setKeysOpen] = useState(false);
	const [ask, setAsk] = useState<{ mode: "reply" | "note"; n: number }>({ mode: "reply", n: 0 });
	const [showActivity, setShowActivity] = useState(true);
	useEffect(() => {
		try {
			setShowActivity(localStorage.getItem(ACTIVITY_KEY) !== "hidden");
		} catch {}
	}, []);
	const toggleActivity = () => {
		setShowActivity((v) => {
			try {
				localStorage.setItem(ACTIVITY_KEY, v ? "hidden" : "shown");
			} catch {}
			return !v;
		});
	};
	// One-key shortcuts (not while typing, nor with a menu or dialog open).
	const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
	// «G» then a letter goes to a page (the command menu's): that letter isn't ours.
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
		const open = (m: NonNullable<typeof menu>) => {
			if (!canReply) return;
			setPanel(true);
			setMenu(m);
		};
		const act: Record<string, () => void> = {
			j: () => void go(nav.next),
			k: () => void go(nav.prev),
			r: () => canReply && !chat && setAsk((a) => ({ mode: "reply", n: a.n + 1 })),
			n: () => canReply && setAsk((a) => ({ mode: "note", n: a.n + 1 })),
			e: () =>
				canReply &&
				(c.status === "open"
					? void resolve()
					: void update({ status: "open" }, "status", "Reopened")),
			u: () => void update({ read: false }, "unread"),
			a: () => open("assignee"),
			p: () => open("priority"),
			t: () => open("tags"),
			s: () => c.status === "open" && open("snooze"),
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
	// Older messages fold to a line each; the newest (and what's unread) stay open.
	const [unfolded, setUnfolded] = useState<{ for: string; ids: Set<string>; all: boolean }>({
		for: c.id,
		ids: new Set(),
		all: false,
	});
	if (unfolded.for !== c.id) setUnfolded({ for: c.id, ids: new Set(), all: false });
	const [editing, setEditing] = useState<string | null>(null);
	// Older pages, added on "Load older" (the loader brings the newest).
	const [older, setOlder] = useState<{
		items: Item[];
		more: boolean;
		before: string | null;
		busy: boolean;
		for: string;
	}>({ items: [], more: c.has_more, before: c.before, busy: false, for: c.id });
	if (older.for !== c.id)
		setOlder({ items: [], more: c.has_more, before: c.before, busy: false, for: c.id });
	const timeline = [...older.items, ...c.timeline];
	const firstUnread = timeline.find((t) => t.type === "inbound" && t.unread)?.id;
	const lastInbound = timeline.findLast((t) => t.type === "inbound")?.id;
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
	const chat = c.channel === "chat";
	const [live, setLive] = useState<Live | null>(null);
	const canDelete = allows(me.active?.access, "inbox:reply");
	const [deletingNow, setDeletingNow] = useState(false);
	const held = timeline.filter((t) => t.type === "inbound" && t.held);
	const nameOfReader = (reader: string) => people.find((p) => p.reader === reader)?.name;
	const notes = timeline.filter((t) => t.type === "note");
	const ctx = {
		contact: chat ? (c.visitor?.name ?? c.visitor?.email ?? "") : c.contact,
		agent: me.user.name || me.user.email,
		inbox: inbox?.name ?? null,
		subject: c.subject,
	};
	const pending = timeline.filter(
		(t) => t.type === "draft" || (t.type === "reply" && t.scheduled_for),
	);
	const shown = timeline.filter((t) => t.type !== "chat" && !pending.includes(t));
	const rows = threadRows(
		shown,
		showActivity ? eventsOf(activity, older.more ? shown[0]?.at : undefined) : [],
		(t, i) => {
			if (unfolded.all || shown.length <= 4 || i >= shown.length - 2) return true;
			// What they last wrote stays open: it's what a reply answers.
			if (t.id === lastInbound) return true;
			if (unfolded.ids.has(`${t.type}-${t.id}`)) return true;
			const unreadAt = firstUnread ? shown.findIndex((x) => x.id === firstUnread) : -1;
			return unreadAt >= 0 && i >= unreadAt;
		},
	);
	const unfold = (keys: string[]) =>
		setUnfolded((u) => ({ ...u, ids: new Set([...u.ids, ...keys]) }));
	const contactName = chat
		? c.visitor?.name || c.visitor?.email || "the visitor"
		: nameOf(c.contact);
	return (
		<Page className="gap-6">
			<div className="flex flex-col gap-4">
				<div className="flex items-center justify-between gap-3">
					<nav
						aria-label="Breadcrumb"
						className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
					>
						<Link
							to="/received"
							search={nav.search ?? {}}
							className="rounded-sm transition-colors hover:text-foreground"
						>
							Received
						</Link>
						{inbox && (
							<>
								<ChevronRight className="size-3.5 shrink-0 text-faint" />
								<Link
									to="/received"
									search={{ inbox: inbox.id }}
									className="truncate rounded-sm transition-colors hover:text-foreground"
								>
									{inbox.name}
								</Link>
							</>
						)}
					</nav>
					{nav.total > 1 && (
						<div className="flex shrink-0 items-center gap-1">
							<span className="mr-1 text-sm text-muted-foreground tabular-nums">
								{nav.index + 1} of {nav.total}
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Previous conversation"
										disabled={!nav.prev}
										onClick={() => void go(nav.prev)}
									>
										<ChevronUp />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									Previous <Kbd>K</Kbd>
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label="Next conversation"
										disabled={!nav.next}
										onClick={() => void go(nav.next)}
									>
										<ChevronDown />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									Next <Kbd>J</Kbd>
								</TooltipContent>
							</Tooltip>
						</div>
					)}
				</div>
				<RecordHeader
					icon={chat ? MessageCircle : MessagesSquare}
					tone={c.status === "resolved" ? "gray" : c.snoozed_until ? "amber" : "blue"}
					kind={
						chat
							? c.status === "resolved"
								? "Resolved website chat"
								: "Open website chat"
							: c.status === "resolved"
								? "Resolved conversation"
								: c.snoozed_until
									? "Snoozed conversation"
									: "Open conversation"
					}
					title={c.subject || "(no subject)"}
					actions={
						<>
							<Button
								variant="outline"
								aria-label="Mark unread"
								disabled={busy !== null}
								onClick={() => update({ read: false }, "unread")}
							>
								{busy === "unread" ? <Spinner /> : <Mail />}
								<span className="hidden sm:inline">Mark unread</span>
							</Button>
							<Button
								variant="outline"
								className="lg:hidden"
								aria-expanded={panel}
								onClick={() => setPanel((p) => !p)}
							>
								<PanelRight />
								Details
							</Button>
							{c.status === "open" ? (
								<Button
									disabled={busy !== null}
									title="Resolve (E)"
									onClick={() => void resolve()}
								>
									{busy === "status" ? <Spinner /> : <CircleCheck />}
									Resolve
								</Button>
							) : (
								<Button
									variant="outline"
									disabled={busy !== null}
									onClick={() => update({ status: "open" }, "status", "Reopened")}
								>
									{busy === "status" ? <Spinner /> : <RotateCcw />}
									Reopen
								</Button>
							)}
							{chat && canDelete && (
								<Confirm
									open={deletingNow}
									onOpenChange={setDeletingNow}
									title="Delete this chat now?"
									description="The messages and files go for good, and the visitor's chat ends. It doesn't wait for the inbox's retention."
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
							<ApiDrawer
								title="This conversation in the API"
								description="With a full-access key, or the inbox's own credential (mri_…)."
								calls={[
									{
										title: "Read it whole",
										method: "GET",
										path: `/conversations/${c.id}?mark_read=true`,
									},
									{
										title: "Claim it while an agent works on it",
										method: "POST",
										path: `/conversations/${c.id}/claim`,
										body: { minutes: 15 },
									},
									{
										title: "Write a draft for review",
										method: "POST",
										path: `/conversations/${c.id}/drafts`,
										body: {
											text: "Thanks for writing…",
											after_message: lastInbound ?? null,
										},
									},
									{
										title: "Reply in the same thread",
										method: "POST",
										path: `/conversations/${c.id}/reply`,
										body: { text: "Thanks for writing…" },
									},
									{
										title: "Leave a note for the team",
										method: "POST",
										path: `/conversations/${c.id}/notes`,
										body: { text: "Checked the booking: it's paid." },
									},
									{
										title: "Triage it",
										method: "PATCH",
										path: `/conversations/${c.id}`,
										body: { add_tags: ["billing"], priority: "high" },
									},
								]}
							/>
							<Button
								variant="ghost"
								size="icon"
								className="hidden lg:inline-flex"
								aria-label="Keyboard shortcuts"
								title="Keyboard shortcuts (?)"
								onClick={() => setKeysOpen(true)}
							>
								<Keyboard />
							</Button>
							<MoreMenu>
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
												Workflow
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
								{chat && canDelete && (
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
						</>
					}
				/>
			</div>

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
				{/* On phones it opens under the header (Details); beside the thread on wide screens. */}
				<aside
					aria-label="Details"
					className={cn(
						"flex-col gap-6 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:flex",
						panel ? "flex" : "hidden",
					)}
				>
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
									update(
										{ assignee: reader },
										"assignee",
										reader
											? reader === data.me
												? "It's yours"
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
								onChange={(priority) => update({ priority }, "priority")}
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
								onChange={(tags) => update({ tags }, "tags")}
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
										update(
											{ snooze_until: until },
											"snooze",
											until
												? `Snoozed until ${formatDateTime(until)}`
												: "Back in the open list",
										)
									}
								/>
							</Detail>
						)}
						{slaState(c.sla, c.status) && (
							<Detail label="Due">
								<SlaBadge
									sla={c.sla}
									status={c.status}
								/>
							</Detail>
						)}
					</dl>

					<ContactCard
						data={data}
						live={live}
					/>

					<dl className="flex flex-col gap-1 border-t pt-5">
						<Detail label="Inbox">
							{inbox ? (
								<Link
									to="/received/inboxes/$id"
									params={{ id: inbox.id }}
									className="block truncate text-sm underline-offset-2 hover:underline"
									title={inbox.address}
								>
									{inbox.name}
								</Link>
							) : (
								<span className="text-sm text-muted-foreground">
									A domain address
								</span>
							)}
						</Detail>
						{brand && (
							<Detail label="Brand">
								<span className="block truncate text-sm">{brand.name}</span>
							</Detail>
						)}
						<Detail label="Started">
							<span
								className="text-sm"
								title={formatDateTime(c.created_at)}
							>
								{formatDateTime(c.created_at)}
							</span>
						</Detail>
						<Detail label="First reply">
							{c.first_reply_at ? (
								<span
									className="text-sm"
									title={formatDateTime(c.first_reply_at)}
								>
									after{" "}
									{formatSeconds(
										Math.max(
											0,
											(Date.parse(c.first_reply_at) -
												Date.parse(c.created_at)) /
												1000,
										),
									)}
								</span>
							) : (
								<span className="text-sm text-muted-foreground">Not yet</span>
							)}
						</Detail>
						{c.csat && (
							<Detail label="Rating">
								{c.csat.rating ? (
									<span
										className="flex items-center gap-2"
										title={c.csat.comment ? `“${c.csat.comment}”` : undefined}
									>
										<Stars rating={c.csat.rating} />
									</span>
								) : (
									<span className="text-sm text-muted-foreground">
										Asked, no answer
									</span>
								)}
							</Detail>
						)}
						<Detail label="Id">
							<IdChip value={c.id} />
						</Detail>
					</dl>
				</aside>

				<div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1">
					{c.held && (
						<Alert variant="warning">
							<ShieldAlert />
							<AlertTitle>Held for a person</AlertTitle>
							<AlertDescription className="flex flex-col gap-3">
								<span>
									Agents don't see{" "}
									{held.length === 1
										? "one message"
										: `${held.length || "some"} messages`}{" "}
									here until someone checks {held.length === 1 ? "it" : "them"}
									{reasonsOf(held).length
										? `: ${reasonsOf(held).join("; ")}.`
										: "."}
								</span>
								<span className="flex flex-wrap gap-2">
									<Button
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onClick={() =>
											update(
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
										It's fine, let agents see it
									</Button>
								</span>
							</AlertDescription>
						</Alert>
					)}

					{chat && (
						<ChatThread
							conversation={c}
							canReply={canReply}
							onLive={setLive}
						/>
					)}

					{chat && (notes.length > 0 || canReply) && (
						<Section
							title="Team notes"
							description="Only your team sees these, never the visitor."
						>
							<ol className="flex flex-col gap-3">
								{notes.map((t) => (
									<li key={`note-${t.id}`}>
										<TimelineItem
											conversation={c.id}
											item={t}
											canReply={canReply}
											me={data.me}
											onEdit={() => {}}
										/>
									</li>
								))}
							</ol>
							{canReply && (
								<Composer
									conversation={c}
									compose={compose}
									data={data}
									ctx={ctx}
									notesOnly
									key={`${c.id}-notes`}
								/>
							)}
						</Section>
					)}

					{!chat && (
						<div className="flex items-center justify-between gap-3">
							<h2 className="eyebrow">
								{c.messages} {c.messages === 1 ? "message" : "messages"} with{" "}
								{contactName}
							</h2>
							<Button
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								aria-pressed={showActivity}
								onClick={toggleActivity}
							>
								<History />
								{showActivity ? "Hide activity" : "Show activity"}
							</Button>
						</div>
					)}

					<ol className={cn("flex flex-col gap-3", chat && "hidden")}>
						{older.more && (
							<li className="flex justify-center">
								<Button
									variant="outline"
									size="sm"
									disabled={older.busy}
									onClick={loadOlder}
								>
									{older.busy && <Spinner />}
									Load older
								</Button>
							</li>
						)}
						{rows.map((r) => {
							if (r.kind === "events")
								return (
									<li key={`events-${r.key}`}>
										<EventLines events={r.events} />
									</li>
								);
							if (r.kind === "folded")
								return (
									<li key={`folded-${r.items[0]?.id}`}>
										<button
											type="button"
											className="flex w-full items-center gap-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
											onClick={() =>
												unfold(r.items.map((t) => `${t.type}-${t.id}`))
											}
										>
											<span
												aria-hidden="true"
												className="h-px flex-1 bg-border"
											/>
											<span className="flex items-center gap-2">
												<span className="flex -space-x-1">
													{r.items.slice(0, 3).map((t) => (
														<Avatar
															key={`${t.type}-${t.id}`}
															name={whoOf(t).name}
															agent={whoOf(t).agent}
															className="ring-2 ring-background"
														/>
													))}
												</span>
												{r.items.length} more messages
											</span>
											<span
												aria-hidden="true"
												className="h-px flex-1 bg-border"
											/>
										</button>
									</li>
								);
							const t = r.item;
							return (
								<li key={`${t.type}-${t.id}`}>
									{t.id === firstUnread && (
										<div className="mb-3 flex items-center gap-3 text-xs font-medium text-brand">
											<span
												aria-hidden="true"
												className="h-px flex-1 bg-brand/40"
											/>
											New since you last read
											<span
												aria-hidden="true"
												className="h-px flex-1 bg-brand/40"
											/>
										</div>
									)}
									{r.folded ? (
										<FoldedItem
											item={t}
											onOpen={() => unfold([`${t.type}-${t.id}`])}
										/>
									) : (
										<TimelineItem
											conversation={c.id}
											item={t}
											canReply={canReply}
											me={data.me}
											onEdit={() => {}}
										/>
									)}
								</li>
							);
						})}
					</ol>

					{/* What's next: drafts to approve and replies waiting to go, just above the reply box. */}
					{pending.length > 0 && !chat && (
						<ol className="flex flex-col gap-3">
							{pending.map((t) => (
								<li key={`${t.type}-${t.id}`}>
									{t.type === "draft" && editing === t.id ? (
										<Composer
											conversation={c}
											compose={compose}
											data={data}
											ctx={ctx}
											draft={t}
											lastInbound={lastInbound}
											onDone={() => setEditing(null)}
										/>
									) : (
										<TimelineItem
											conversation={c.id}
											item={t}
											canReply={canReply}
											me={data.me}
											onEdit={() => setEditing(t.id)}
										/>
									)}
								</li>
							))}
						</ol>
					)}

					{canReply && !editing && !chat && (
						<Composer
							conversation={c}
							compose={compose}
							data={data}
							ctx={ctx}
							lastInbound={lastInbound}
							ask={ask}
							recipient={contactName}
							key={c.id}
						/>
					)}
				</div>
			</div>

			<Shortcuts
				open={keysOpen}
				onOpenChange={setKeysOpen}
			/>
		</Page>
	);
}

/** Why held messages wait, each reason once. */
const reasonsOf = (items: Item[]) => [
	...new Set(
		items.flatMap((t) =>
			t.type === "inbound" ? (t.flags?.reasons ?? []).map((r) => r.text) : [],
		),
	),
];

/** A page's address without the scheme: harborinn.com/rooms. */
const pageOf = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
	} catch {
		return url;
	}
};

/** «Ana López <ana@…>» as «Ana López», or the bare address. */
const nameOf = (from: string) => /^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

const ACTIVITY_KEY = "mailroom:conversation-activity";

/** A label and its value, one line of the details panel. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-h-8 grid-cols-[5rem_minmax(0,1fr)] items-center gap-3">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0">{children}</dd>
		</div>
	);
}

/** Who wrote in: their name and address, their contact, and their other conversations. */
function ContactCard({ data, live }: { data: Data; live: Live | null }) {
	const c = data.conversation;
	const chat = c.channel === "chat";
	const person = data.contact?.record ?? null;
	const name = chat
		? c.visitor?.name || c.visitor?.email || "Anonymous visitor"
		: (person && [person.first_name, person.last_name].filter(Boolean).join(" ")) ||
			nameOf(c.contact);
	const email = chat ? (c.visitor?.email ?? null) : (data.contact?.email ?? c.contact);
	const others = data.contact?.others ?? [];
	return (
		<section
			aria-label="Who wrote"
			className="flex flex-col gap-4 border-t pt-5"
		>
			<div className="flex min-w-0 items-center gap-3">
				<Avatar
					name={name}
					className="size-9 text-xs"
				/>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium">
						<Ph>{name}</Ph>
					</p>
					{email && (
						<CopyValue
							value={email}
							className="text-sm text-muted-foreground"
						/>
					)}
				</div>
			</div>
			{chat && (
				<dl className="flex flex-col gap-1">
					{c.visitor?.verified && (
						<Detail label="Signed in">
							<span
								className="text-sm"
								title="The website signed who this is (identity verification)"
							>
								<StatusBadge
									status="success"
									label="Verified"
								/>
								{c.visitor.user_id && (
									<span className="ml-2 font-mono text-xs text-muted-foreground">
										<Ph>{c.visitor.user_id}</Ph>
									</span>
								)}
							</span>
						</Detail>
					)}
					{Object.entries(c.visitor?.attributes ?? {}).map(([k, x]) => (
						<Detail
							key={k}
							label={k}
						>
							<span className="block truncate text-sm">
								<Ph>{String(x)}</Ph>
							</span>
						</Detail>
					))}
					{c.visitor?.page_url && (
						<Detail label="Wrote from">
							<a
								href={c.visitor.page_url}
								target="_blank"
								rel="noreferrer"
								className="block truncate text-sm underline-offset-2 hover:underline"
								title={c.visitor.page_url}
							>
								{pageOf(c.visitor.page_url)}
							</a>
						</Detail>
					)}
					<Detail label="On the site">
						{live?.visitorOnline ? (
							<StatusBadge
								status="success"
								label="Now"
							/>
						) : c.visitor?.seen_at ? (
							<span
								className="text-sm"
								title={formatDateTime(c.visitor.seen_at)}
							>
								{formatAgo(c.visitor.seen_at)}
							</span>
						) : (
							<span className="text-sm text-muted-foreground">Not lately</span>
						)}
					</Detail>
				</dl>
			)}
			{person && (
				<Link
					to="/contacts/$id"
					params={{ id: person.id }}
					className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60"
				>
					<User className="size-4 shrink-0 text-muted-foreground" />
					<span className="min-w-0 flex-1 truncate">
						A contact since {formatDateTime(person.created_at).replace(/,? \d.*$/, "")}
						{person.unsubscribed ? ", unsubscribed" : ""}
					</span>
					<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
				</Link>
			)}
			{others.length > 0 && (
				<div className="flex flex-col gap-1">
					<h3 className="eyebrow mb-1">Earlier conversations</h3>
					<ul className="flex flex-col">
						{others.map((o) => (
							<li key={o.id}>
								<Link
									to="/received/$id"
									params={{ id: o.id }}
									className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60"
								>
									<StatusDot
										status={o.status === "resolved" ? "sent" : "scheduled"}
									/>
									<span className="min-w-0 flex-1 truncate">
										{o.subject || "(no subject)"}
									</span>
									{o.csat ? (
										<span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
											<Star className="size-3 fill-warning text-warning" />
											{o.csat}
										</span>
									) : null}
									<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
										{formatAgo(o.last_message_at)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}

type Event = Data["activity"][number];
type Row =
	| { kind: "item"; item: Item; folded: boolean }
	| { kind: "folded"; items: Item[] }
	| { kind: "events"; key: string; events: Event[] };

/** Activity that the thread already shows (a reply, a note) or that's noise (who read it). */
const QUIET = new Set([
	"reply.sent",
	"draft.created",
	"draft.updated",
	"draft.deleted",
	"draft.discarded",
	"note.created",
	"note.deleted",
	"conversation.read",
	"message.read",
	"attachment.downloaded",
	"chat.started",
]);

/** The activity worth a line in the thread, oldest first (from `since`, when older isn't shown). */
function eventsOf(activity: Event[], since?: string) {
	return activity
		.filter((a) => !QUIET.has(a.action) && (!since || a.created_at >= since))
		.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The thread in order, with activity between the messages and older messages folded away. */
function threadRows(items: Item[], events: Event[], open: (t: Item, i: number) => boolean) {
	const out: Row[] = [];
	let e = 0;
	let run: Item[] = [];
	const flush = () => {
		const [only] = run;
		if (run.length === 1 && only) out.push({ kind: "item", item: only, folded: true });
		else if (run.length) out.push({ kind: "folded", items: run });
		run = [];
	};
	const take = (until: string | null) => {
		const batch: Event[] = [];
		while (e < events.length) {
			const ev = events[e];
			if (!ev || (until !== null && ev.created_at > until)) break;
			batch.push(ev);
			e++;
		}
		return batch;
	};
	items.forEach((t, i) => {
		if (!open(t, i)) {
			// What happened among folded messages folds with them.
			take(t.at);
			run.push(t);
			return;
		}
		const batch = take(t.at);
		flush();
		if (batch.length && batch[0]) out.push({ kind: "events", key: batch[0].id, events: batch });
		out.push({ kind: "item", item: t, folded: false });
	});
	flush();
	const rest = take(null);
	if (rest.length && rest[0]) out.push({ kind: "events", key: rest[0].id, events: rest });
	return out;
}

const PRIORITY_WORD: Record<string, string> = {
	urgent: "urgent",
	high: "high",
	normal: "normal",
	low: "low",
};

/** One activity line, in words, with what changed when the record says. */
function describe(a: Event) {
	const d = (a.detail ?? {}) as Record<string, unknown>;
	const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
	switch (a.action) {
		case "conversation.assigned":
			if (typeof d.to !== "string") return "assigned it";
			return d.to === a.actor.name ? "took it" : `assigned it to ${d.to}`;
		case "conversation.tagged": {
			const added = list(d.added);
			const removed = list(d.removed);
			const parts = [
				added.length ? `added ${added.join(", ")}` : "",
				removed.length ? `removed ${removed.join(", ")}` : "",
			].filter(Boolean);
			return parts.length ? `${parts.join(" and ")} as tags` : "changed its tags";
		}
		case "conversation.prioritized":
			return typeof d.priority === "string"
				? `set the priority to ${PRIORITY_WORD[d.priority] ?? d.priority}`
				: "changed its priority";
		case "conversation.snoozed":
			return typeof d.until === "string"
				? `snoozed it until ${formatDateTime(d.until)}`
				: "snoozed it";
		case "rule.matched":
			return typeof d.rule === "string" ? `ran the rule “${d.rule}”` : "ran a rule";
		case "csat.received":
			return typeof d.rating === "number" ? `rated it ${d.rating} of 5` : "rated it";
		case "chat.handed_off":
			return `handed the chat to ${typeof d.to === "string" ? d.to : "the team"}${d.by === "visitor" ? " (the visitor asked for a person)" : ""}`;
		case "chat.started":
			return typeof d.popup === "string"
				? `opened the chat from the pop-up “${d.popup}”`
				: typeof d.topic === "string"
					? `opened the chat about “${d.topic}”`
					: (ACTIONS[a.action] ?? a.action);
		case "sla.breached":
			return d.what === "resolve" ? "missed the resolve target" : "missed the reply target";
		default:
			return ACTIONS[a.action] ?? a.action.replace(/[._]/g, " ");
	}
}

/** A run of activity between two messages: small gray lines, the long ones folded. */
function EventLines({ events }: { events: Event[] }) {
	const [all, setAll] = useState(false);
	const shown = all || events.length <= 3 ? events : events.slice(-2);
	return (
		<ul className="flex flex-col gap-1.5 py-1 pl-4">
			{shown.length < events.length && (
				<li>
					<button
						type="button"
						className="text-xs text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => setAll(true)}
					>
						{events.length - shown.length} earlier updates
					</button>
				</li>
			)}
			{shown.map((a) => (
				<li
					key={a.id}
					className="flex items-center gap-2 text-xs text-muted-foreground"
				>
					{a.actor.type === "agent" ? (
						<Bot className="size-3.5 shrink-0" />
					) : a.actor.type === "system" ? (
						<Zap className="size-3.5 shrink-0" />
					) : (
						<User className="size-3.5 shrink-0" />
					)}
					<span className="min-w-0 truncate">
						<span className="font-medium text-foreground/80">
							{a.actor.name ?? (a.actor.type === "system" ? "Mailroom" : "Someone")}
						</span>{" "}
						{describe(a)}
					</span>
					<span
						className="ml-auto shrink-0 tabular-nums"
						title={formatDateTime(a.created_at)}
					>
						{formatAgo(a.created_at)}
					</span>
				</li>
			))}
		</ul>
	);
}

/** Who a thread item is from, for its avatar and its folded line. */
function whoOf(t: Item): { name: string; agent: boolean } {
	if (t.type === "inbound") return { name: nameOf(t.from), agent: false };
	if (t.type === "reply" || t.type === "draft" || t.type === "note")
		return { name: t.author.name ?? "Agent", agent: t.author.type === "agent" };
	return { name: "You", agent: false };
}

/** An older message as one line: who, the start of what they wrote, when. */
function FoldedItem({ item: t, onOpen }: { item: Item; onOpen: () => void }) {
	const who = whoOf(t);
	const text =
		t.type === "inbound"
			? t.new_text || t.text
			: t.type === "origin"
				? `We sent ${t.subject || "an email"}`
				: "text" in t
					? t.text
					: "";
	return (
		<button
			type="button"
			className="flex w-full items-center gap-3 rounded-xl px-4 py-2.5 text-left text-sm shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-muted/40"
			onClick={onOpen}
		>
			<Avatar
				name={who.name}
				agent={who.agent}
				className="size-6"
			/>
			<span className="w-32 shrink-0 truncate font-medium sm:w-40">
				<Ph>{who.name}</Ph>
			</span>
			{t.type === "note" && (
				<StickyNote className="size-3.5 shrink-0 text-muted-foreground" />
			)}
			<span className="min-w-0 flex-1 truncate text-muted-foreground">
				<Ph>{(text ?? "").replace(/\s+/g, " ").trim()}</Ph>
			</span>
			<span
				className="shrink-0 text-xs text-muted-foreground tabular-nums"
				title={formatDateTime(t.at)}
			>
				{formatAgo(t.at)}
			</span>
		</button>
	);
}

const KEYS: { title: string; keys: [string[], string][] }[] = [
	{
		title: "Move",
		keys: [
			[["J"], "Next conversation"],
			[["K"], "Previous conversation"],
		],
	},
	{
		title: "Write",
		keys: [
			[["R"], "Reply"],
			[["N"], "Note for the team"],
			[["⌘", "↵"], "Send"],
			[["Esc"], "Close an empty reply box"],
		],
	},
	{
		title: "Triage",
		keys: [
			[["E"], "Resolve, then open the next"],
			[["A"], "Assign"],
			[["P"], "Priority"],
			[["T"], "Tags"],
			[["S"], "Snooze"],
			[["U"], "Mark unread"],
		],
	},
];

function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent
				className="sm:max-w-md"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Keyboard shortcuts</DialogTitle>
					<DialogDescription>
						On a conversation, while you're not typing. <Kbd>?</Kbd> opens this.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-5">
					{KEYS.map((group) => (
						<section
							key={group.title}
							className="flex flex-col gap-1"
						>
							<h3 className="eyebrow mb-1">{group.title}</h3>
							<ul className="flex flex-col">
								{group.keys.map(([keys, what]) => (
									<li
										key={what}
										className="flex h-8 items-center justify-between gap-4 text-sm"
									>
										<span>{what}</span>
										<span className="flex gap-1">
											{keys.map((k) => (
												<Kbd key={k}>{k}</Kbd>
											))}
										</span>
									</li>
								))}
							</ul>
						</section>
					))}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

const kb = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

function Files({
	list,
	onRemove,
}: {
	list: { id: string; filename: string; size: number }[];
	onRemove?: (id: string) => void;
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{list.map((a) => (
				<span
					key={a.id}
					className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
				>
					<Paperclip className="size-3 text-muted-foreground" />
					{a.filename}
					<span className="text-muted-foreground tabular-nums">{kb(a.size)}</span>
					{onRemove && (
						<button
							type="button"
							aria-label={`Remove ${a.filename}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => onRemove(a.id)}
						>
							<X className="size-3" />
						</button>
					)}
				</span>
			))}
		</div>
	);
}

/** A note's text with its @mentions drawn as chips. */
function NoteText({ text, names }: { text: string; names: string[] }) {
	if (!names.length) return <>{text}</>;
	const escaped = names
		.sort((a, b) => b.length - a.length)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const parts = text.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
	return (
		<>
			{parts.map((p, i) =>
				p.startsWith("@") && names.includes(p.slice(1)) ? (
					<span
						key={i}
						className="font-medium text-brand"
					>
						{p}
					</span>
				) : (
					p
				),
			)}
		</>
	);
}

function TimelineItem({
	conversation,
	item: t,
	canReply,
	me,
	onEdit,
}: {
	conversation: string;
	item: Item;
	canReply: boolean;
	me: string;
	onEdit: () => void;
}) {
	const router = useRouter();
	const [whole, setWhole] = useState(false);
	if (t.type === "origin")
		return (
			<Card className="gap-1 border-dashed px-5 py-4 text-sm">
				<span className="flex items-center gap-2">
					<Send className="size-4 text-muted-foreground" />
					<span className="min-w-0 truncate">
						We sent{" "}
						<Link
							to="/emails/$id"
							params={{ id: t.email_id }}
							className="font-medium underline-offset-2 hover:underline"
						>
							{t.subject || "(no subject)"}
						</Link>{" "}
						to {t.to.join(", ")}
					</span>
					<span className="ml-auto shrink-0 text-muted-foreground">
						{formatDateTime(t.at)}
					</span>
				</span>
			</Card>
		);
	if (t.type === "note") {
		const mine = `${t.author.type === "agent" ? "cred" : "user"}:${t.author.id}` === me;
		const names = t.mentions.map((m) => m.name);
		return (
			<Card className="gap-2 border border-dashed border-border-strong bg-transparent px-5 py-4 shadow-none">
				<ItemHead
					who={whoOf(t)}
					title={t.author.name ?? "Agent"}
					sub={
						<span className="flex items-center gap-1.5">
							<StickyNote className="size-3.5" />
							Note, only your team sees it
						</span>
					}
					right={
						<>
							<span title={formatDateTime(t.at)}>{formatAgo(t.at)}</span>
							{canReply && mine && (
								<Confirm
									trigger={
										<Button
											size="sm"
											variant="ghost"
											aria-label="Delete the note"
										>
											<Trash2 />
										</Button>
									}
									title="Delete this note?"
									description="Your team won't see it any more."
									action="Delete"
									onConfirm={async () => {
										try {
											await deleteNoteFn({
												data: { conversation, id: t.id },
											});
											await router.invalidate();
										} catch (error) {
											toast.error(await errorMessage(error));
										}
									}}
								/>
							)}
						</>
					}
				/>
				<p className="text-sm leading-relaxed whitespace-pre-wrap break-words sm:pl-10">
					<Ph>
						<NoteText
							text={t.text}
							names={names}
						/>
					</Ph>
				</p>
			</Card>
		);
	}
	if (t.type === "inbound") {
		const body = whole || !t.quoted ? t.text : t.new_text;
		const flagged = (t.flags?.score ?? 0) > 0;
		return (
			<Card className="gap-3 px-5 py-4">
				<ItemHead
					who={whoOf(t)}
					title={nameOf(t.from)}
					sub={
						<span title={t.from}>
							to {t.to.join(", ")}
							{t.cc.length ? `, cc ${t.cc.join(", ")}` : ""}
						</span>
					}
					badges={
						<>
							{t.spam && (
								<Badge variant="destructive">
									<ShieldAlert />
									Spam
								</Badge>
							)}
							{flagged && t.flags && (
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="inline-flex">
											<StatusBadge
												status="held"
												label={t.held ? "Held from agents" : "Looks off"}
											/>
										</span>
									</TooltipTrigger>
									<TooltipContent className="max-w-xs">
										<ul className="flex flex-col gap-1">
											{t.flags.reasons.map((r) => (
												<li key={r.code}>{r.text}</li>
											))}
										</ul>
									</TooltipContent>
								</Tooltip>
							)}
						</>
					}
					right={
						<>
							<span
								className="mr-1"
								title={formatDateTime(t.at)}
							>
								{formatAgo(t.at)}
							</span>
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="Mark this message unread"
								title="Mark this message unread (for you)"
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
								<Mail />
							</Button>
							<Button
								size="icon-sm"
								variant="ghost"
								asChild
							>
								<Link
									to="/received/m/$id"
									params={{ id: t.id }}
									aria-label="The whole message"
									title="The whole message: headers, checks, the original"
								>
									<ArrowUpRight />
								</Link>
							</Button>
						</>
					}
				/>
				<div className="flex flex-col gap-3 sm:pl-10">
					<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
						<Ph>
							{body?.trim() ||
								(t.html
									? "No plain-text part: open the message to see it."
									: "No longer kept (past its retention).")}
						</Ph>
					</p>
					{t.quoted && (
						<button
							type="button"
							className="flex w-fit items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
							aria-expanded={whole}
							onClick={() => setWhole((w) => !w)}
						>
							<Ellipsis className="size-3.5" />
							{whole ? "Hide what it quotes" : "Show what it quotes"}
						</button>
					)}
					{(t.attachments ?? []).length > 0 && (
						<div className="flex flex-wrap gap-2">
							{t.attachments.map((a) => (
								<span
									key={a.id}
									className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
								>
									<Paperclip className="size-3 text-muted-foreground" />
									{a.filename ?? a.id}
								</span>
							))}
						</div>
					)}
				</div>
			</Card>
		);
	}
	// A website chat's lines are drawn by ChatThread.
	if (t.type === "chat") return null;
	const draft = t.type === "draft";
	const waiting = !draft && t.scheduled_for;
	const who = whoOf(t);
	const to = `to ${t.to.join(", ")}${t.cc.length ? `, cc ${t.cc.join(", ")}` : ""}`;
	if (waiting)
		return (
			<Card className="flex-row items-center gap-3 border border-dashed border-border-strong bg-transparent px-4 py-3 shadow-none">
				<Clock className="size-4 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<p className="text-sm">
						<span className="font-medium">
							{t.author.name ?? "A reply"}
							{t.author.name ? "'s reply" : ""}
						</span>{" "}
						<span
							className="text-muted-foreground"
							title={formatDateTime(t.scheduled_for)}
						>
							{Date.parse(t.scheduled_for ?? "") - Date.now() < 90_000
								? "goes in a moment"
								: `goes ${formatAgo(t.scheduled_for)}, ${formatDateTime(t.scheduled_for)}`}
						</span>
					</p>
					<p className="truncate text-sm text-muted-foreground">
						<Ph>{(t.text ?? "").replace(/\s+/g, " ")}</Ph>
					</p>
				</div>
				{canReply && (
					<Button
						size="sm"
						variant="outline"
						className="shrink-0"
						onClick={async () => {
							try {
								await unsendReplyFn({ data: { id: t.id } });
								toast.success("Called back: it's a draft again");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							}
						}}
					>
						<Undo2 />
						<span className="hidden sm:inline">Don't send</span>
					</Button>
				)}
			</Card>
		);
	return (
		<Card
			className={cn(
				"gap-3 px-5 py-4",
				draft ? "border-brand/40 bg-brand/5" : "bg-muted/40 shadow-none",
			)}
		>
			<ItemHead
				who={who}
				title={
					draft
						? t.author.type === "agent"
							? `${who.name} suggests a reply`
							: `${who.name}'s draft`
						: who.name
				}
				sub={draft ? to : `${t.sent_by ? `Approved by ${t.sent_by}, ` : ""}${to}`}
				badges={
					<>
						{draft && t.author.type === "agent" && (
							<StatusBadge
								status="scheduled"
								label="Needs review"
							/>
						)}
						{!draft && t.author.type === "agent" && t.review && (
							<Badge variant="secondary">
								{t.review === "edited"
									? "Edited before sending"
									: "Sent as written"}
							</Badge>
						)}
					</>
				}
				right={
					<>
						{!draft && t.delivery && <StatusBadge status={t.delivery} />}
						<span
							className="mx-1"
							title={formatDateTime(t.at)}
						>
							{formatAgo(t.at)}
						</span>
						{!draft && t.email_id && (
							<Button
								size="icon-sm"
								variant="ghost"
								asChild
							>
								<Link
									to="/emails/$id"
									params={{ id: t.email_id }}
									aria-label="The sent email"
									title="The sent email: delivery, opens, the original"
								>
									<ArrowUpRight />
								</Link>
							</Button>
						)}
					</>
				}
			/>
			<div className="flex flex-col gap-3 sm:pl-10">
				<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
					<Ph>{t.text}</Ph>
				</p>
				{/* Pages kept in this browser before replies had files lack the list. */}
				{(t.attachments ?? []).length > 0 && <Files list={t.attachments} />}
				{draft && canReply && (
					<div className="flex flex-wrap gap-2">
						<SendDraft
							conversation={conversation}
							draft={t.id}
							onSent={() => router.invalidate()}
						/>
						<Button
							variant="outline"
							size="sm"
							onClick={onEdit}
						>
							<PenLine />
							Edit
						</Button>
						<Confirm
							trigger={
								<Button
									variant="ghost"
									size="sm"
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
									await deleteConversationDraftFn({ data: { id: t.id } });
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
		</Card>
	);
}

/** A thread item's head: who (avatar and name), a line under it, and its time and links. */
function ItemHead({
	who,
	title,
	sub,
	badges,
	right,
}: {
	who: { name: string; agent: boolean };
	title: ReactNode;
	sub?: ReactNode;
	badges?: ReactNode;
	right?: ReactNode;
}) {
	return (
		<div className="flex items-start gap-3">
			<Avatar
				name={who.name}
				agent={who.agent}
				className="mt-0.5 size-7 text-[11px]"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="truncate font-medium">
						<Ph>{title}</Ph>
					</span>
					{badges}
				</div>
				{sub && <p className="truncate text-sm text-muted-foreground">{sub}</p>}
			</div>
			<div className="flex shrink-0 items-center gap-0.5 text-sm text-muted-foreground">
				{right}
			</div>
		</div>
	);
}

/** After a send: Undo while it waits (the undo window, or a time picked to send it). */
function announce(
	reply: { id: string },
	later: boolean,
	undoSeconds: number,
	reload: () => Promise<void>,
) {
	// A website chat's line has no wait.
	const sent = { scheduled_for: null as string | null, ...reply };
	if (!sent.scheduled_for) {
		toast.success("Reply sent");
		return;
	}
	const undo = {
		label: "Undo",
		onClick: async () => {
			try {
				await unsendReplyFn({ data: { id: sent.id } });
				toast.success("Called back: it's a draft again");
				await reload();
			} catch (error) {
				toast.error(await errorMessage(error));
			}
		},
	};
	if (later)
		toast.success(`Goes ${formatDateTime(sent.scheduled_for)}`, {
			description: "It waits in the conversation until then.",
			action: undo,
		});
	else
		toast(`Sending in ${undoSeconds} seconds…`, {
			duration: Math.max(3, undoSeconds) * 1000,
			action: undo,
		});
}

/** Sends a draft as it is: the person approving it is recorded as who sent it. */
function SendDraft({
	conversation,
	draft,
	onSent,
}: {
	conversation: string;
	draft: string;
	onSent: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const undo = usePage(Route).data.workflow.undo_seconds;
	return (
		<Button
			size="sm"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const sent = await sendConversationReplyFn({
						data: { conversation, draft },
					});
					announce(sent, false, undo, onSent);
					await onSent();
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : <Send />}
			Approve and send
		</Button>
	);
}

/** A reply or draft (one shape, told apart by `type`). */
type Draft = Extract<Item, { type: "reply" | "draft" }>;
type Saved = Data["saved"][number];

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
const short = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
});

/** What's typed just before the caret that opens a menu: @someone in a note, /shortcut in a reply. */
function triggerAt(text: string, caret: number, mode: "reply" | "note") {
	const before = text.slice(0, caret);
	const m =
		mode === "note"
			? /(?:^|\s)@([^\s@]{0,30})$/.exec(before)
			: /(?:^|\n)\/([\w-]{0,30})$/.exec(before);
	if (!m) return null;
	return { q: (m[1] ?? "").toLowerCase(), start: caret - (m[1]?.length ?? 0) - 1, end: caret };
}

function Composer({
	conversation: c,
	compose,
	data,
	ctx,
	draft,
	lastInbound,
	notesOnly,
	onDone,
	ask,
	recipient,
}: {
	conversation: Conversation;
	compose: Data["compose"];
	data: Data;
	ctx: Parameters<typeof fillVariables>[1];
	draft?: Draft;
	lastInbound?: string;
	notesOnly?: boolean;
	onDone?: () => void;
	/** Opens it (in this mode) each time `n` changes: the R and N shortcuts. */
	ask?: { mode: "reply" | "note"; n: number };
	/** Who a reply goes to, for the folded box. */
	recipient?: string;
}) {
	const router = useRouter();
	const { people, saved, workflow } = data;
	const [mode, setMode] = useState<"reply" | "note">(notesOnly ? "note" : "reply");
	// The reply box starts as one line; a draft being edited or the chat's notes start open.
	const [open, setOpen] = useState(Boolean(draft) || Boolean(notesOnly) || !recipient);
	const card = useRef<HTMLDivElement>(null);
	const openAs = (m: "reply" | "note") => {
		setMode(m);
		setMenu(null);
		setOpen(true);
		caret.current = box.current?.value.length ?? 0;
		requestAnimationFrame(() =>
			card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
		);
	};
	const asked = useRef(ask?.n ?? 0);
	useEffect(() => {
		if (!ask || ask.n === asked.current) return;
		asked.current = ask.n;
		openAs(ask.mode);
	});
	const [from, setFrom] = useState(draft?.from ?? compose.from ?? "");
	const [to, setTo] = useState((draft?.to ?? compose.to).join(", "));
	const [cc, setCc] = useState((draft?.cc ?? []).join(", "));
	const [subject, setSubject] = useState(draft?.subject ?? compose.subject);
	const [text, setText] = useState(draft?.text ?? "");
	const [more, setMore] = useState(Boolean(draft) || !compose.from);
	const [busy, setBusy] = useState<"send" | "draft" | "note" | null>(null);
	const [savedId, setSavedId] = useState<string | null>(null);
	const [signature, setSignature] = useState(true);
	const [mentions, setMentions] = useState<{ reader: string; name: string }[]>([]);
	const [picking, setPicking] = useState(false);
	const [menu, setMenu] = useState<{ q: string; start: number; end: number } | null>(null);
	const [index, setIndex] = useState(0);
	const box = useRef<HTMLTextAreaElement>(null);
	// Where the caret goes after a pick (set once the new text is on screen).
	const caret = useRef<number | null>(null);
	useLayoutEffect(() => {
		if (caret.current === null || !box.current) return;
		box.current.focus();
		box.current.setSelectionRange(caret.current, caret.current);
		caret.current = null;
	});
	// The draft's files (kept by id) and new ones (sent as base64).
	const [files, setFiles] = useState<
		{ id: string; filename: string; size: number; content?: string; content_type?: string }[]
	>(() =>
		(draft?.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
	);
	const fileInput = useRef<HTMLInputElement>(null);
	const addFiles = async (list: FileList | null) => {
		const added = await Promise.all(
			[...(list ?? [])].map(
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

	// The menu under the box: people for @, saved replies for /.
	const choices =
		menu === null
			? []
			: mode === "note"
				? people
						.filter((p) => p.type === "person" && p.name.toLowerCase().includes(menu.q))
						.slice(0, 6)
						.map((p) => ({
							key: p.reader,
							label: p.name,
							hint: "",
							pick: () => mention(p),
						}))
				: saved
						.filter(
							(s) =>
								(s.shortcut ?? "").toLowerCase().includes(menu.q) ||
								s.name.toLowerCase().includes(menu.q),
						)
						.slice(0, 6)
						.map((s) => ({
							key: s.id,
							label: s.name,
							hint: s.shortcut ? `/${s.shortcut}` : "",
							pick: () => insertSaved(s, menu),
						}));
	const look = (value: string, caret: number) => {
		const t = triggerAt(value, caret, mode);
		setMenu(t);
		setIndex(0);
	};
	const replaceRange = (start: number, end: number, insert: string) => {
		const next = text.slice(0, start) + insert + text.slice(end);
		setText(next);
		setMenu(null);
		caret.current = start + insert.length;
	};
	const mention = (p: { reader: string; name: string }) => {
		if (!menu) return;
		setMentions((m) => (m.some((x) => x.reader === p.reader) ? m : [...m, p]));
		replaceRange(menu.start, menu.end, `@${p.name} `);
	};
	const insertSaved = (s: Saved, range?: { start: number; end: number } | null) => {
		const filled = fillVariables(s.text, ctx);
		setSavedId(s.id);
		if (range) replaceRange(range.start, range.end, filled);
		else if (!text.trim()) replaceRange(0, text.length, filled);
		else {
			const caret = box.current?.selectionStart ?? text.length;
			replaceRange(caret, caret, filled);
		}
	};

	const fields = {
		conversation: c.id,
		draft: draft?.id,
		from: from || undefined,
		to,
		cc,
		subject,
		text,
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
	const reload = () => router.invalidate();
	const clear = () => {
		if (!draft) {
			setText("");
			setFiles([]);
			setSavedId(null);
			setMentions([]);
			if (recipient) setOpen(false);
		}
	};
	const send = async (o: { at?: Date; resolve?: boolean } = {}) => {
		setBusy("send");
		try {
			const sent = await sendConversationReplyFn({
				data: { ...fields, ...(o.at ? { send_at: o.at.toISOString() } : {}) },
			});
			announce(sent, !!o.at, workflow.undo_seconds, reload);
			if (o.resolve) await updateConversationFn({ data: { id: c.id, status: "resolved" } });
			clear();
			onDone?.();
			await reload();
		} catch (error) {
			const message = await errorMessage(error);
			if (error instanceof Response && error.status === 409 && /new message/i.test(message))
				toast.warning("They wrote again while you were writing", {
					description: "Your reply is still here. Read what they said, then send.",
					action: { label: "Show it", onClick: () => void reload() },
					duration: 12_000,
				});
			else toast.error(message);
		} finally {
			setBusy(null);
		}
	};
	const saveDraft = async () => {
		setBusy("draft");
		try {
			await saveConversationDraftFn({ data: fields });
			toast.success("Draft saved");
			clear();
			onDone?.();
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const addNote = async () => {
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
			setText("");
			setMentions([]);
			if (recipient) setOpen(false);
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const note = mode === "note";
	if (!open)
		return (
			<Card
				ref={card}
				className="flex-row items-center gap-1 p-1.5"
			>
				<button
					type="button"
					className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
					onClick={() => openAs("reply")}
				>
					<Send className="size-4 shrink-0" />
					<span className="truncate">Reply to {recipient}…</span>
					<Kbd className="ml-auto hidden sm:inline-flex">R</Kbd>
				</button>
				<Button
					variant="ghost"
					className="h-9 text-muted-foreground"
					onClick={() => openAs("note")}
				>
					<StickyNote />
					Note
					<Kbd className="hidden sm:inline-flex">N</Kbd>
				</Button>
			</Card>
		);
	return (
		<Card
			ref={card}
			className={cn(
				"gap-4 px-5 py-4",
				note && "border border-dashed border-border-strong shadow-none",
			)}
		>
			<form
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					if (note) void addNote();
					else void send();
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					{draft ? (
						<h2 className="font-medium">Edit the draft</h2>
					) : notesOnly ? (
						<h2 className="font-medium">Add a note</h2>
					) : (
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={mode}
							onValueChange={(v) => {
								if (!v) return;
								setMode(v as "reply" | "note");
								setMenu(null);
							}}
						>
							<ToggleGroupItem value="reply">
								<Send />
								Reply
							</ToggleGroupItem>
							<ToggleGroupItem value="note">
								<StickyNote />
								Note
							</ToggleGroupItem>
						</ToggleGroup>
					)}
					{!more && !note && (
						<button
							type="button"
							className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
							onClick={() => setMore(true)}
						>
							From {from} to {to}
						</button>
					)}
				</div>
				{more && !note && (
					<div className="grid gap-3 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="c-from">From</FieldLabel>
							<Input
								id="c-from"
								value={from}
								placeholder="you@your-domain.com"
								onChange={(e) => setFrom(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-to">To</FieldLabel>
							<Input
								id="c-to"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-cc">Cc</FieldLabel>
							<Input
								id="c-cc"
								value={cc}
								onChange={(e) => setCc(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-subject">Subject</FieldLabel>
							<Input
								id="c-subject"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
							/>
						</Field>
					</div>
				)}
				<div className="relative">
					<Textarea
						ref={box}
						aria-label={note ? "Note" : "Message"}
						rows={note ? 3 : 6}
						value={text}
						placeholder={
							note
								? "A note for your team. Type @ to mention someone: they get an email."
								: saved.length
									? "Write a reply, or type / for a saved reply. It goes in the same thread in their mailbox."
									: "Write a reply. It goes in the same thread in their mailbox."
						}
						onChange={(e) => {
							setText(e.target.value);
							look(e.target.value, e.target.selectionStart);
						}}
						onClick={(e) => look(text, e.currentTarget.selectionStart)}
						onBlur={() => setTimeout(() => setMenu(null), 150)}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								if (text.trim()) e.currentTarget.form?.requestSubmit();
								return;
							}
							if (
								e.key === "Escape" &&
								!choices.length &&
								!text.trim() &&
								recipient
							) {
								setOpen(false);
								return;
							}
							if (!choices.length) return;
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								setIndex(
									(i) =>
										(i + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
										choices.length,
								);
							} else if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								choices[index]?.pick();
							} else if (e.key === "Escape") setMenu(null);
						}}
					/>
					{choices.length > 0 && (
						<ul className="absolute top-full left-0 z-20 mt-1 w-72 overflow-hidden rounded-lg bg-popover p-1 text-sm shadow-lg ring-1 ring-border">
							{choices.map((x, i) => (
								<li key={x.key}>
									<button
										type="button"
										className={cn(
											"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
											i === index ? "bg-muted" : "hover:bg-muted",
										)}
										onMouseDown={(e) => {
											e.preventDefault();
											x.pick();
										}}
									>
										{note ? (
											<Avatar name={x.label} />
										) : (
											<Zap className="size-4 shrink-0 text-muted-foreground" />
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
				{files.length > 0 && !note && (
					<Files
						list={files}
						onRemove={(id) => setFiles((l) => l.filter((f) => f.id !== id))}
					/>
				)}
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => void addFiles(e.target.files)}
				/>
				{note ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="submit"
							disabled={busy !== null || !text.trim()}
						>
							{busy === "note" ? <Spinner /> : <StickyNote />}
							Add note
						</Button>
						<span className="text-xs text-muted-foreground">
							Never sent to {c.channel === "chat" ? "the visitor" : "them"}.
						</span>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex">
							<Button
								type="submit"
								className="rounded-r-none"
								disabled={busy !== null || !text.trim()}
							>
								{busy === "send" ? <Spinner /> : <Send />}
								Send
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										className="rounded-l-none border-l border-primary-foreground/20 px-2"
										aria-label="More ways to send"
										disabled={busy !== null || !text.trim()}
									>
										<ChevronDown />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									align="start"
									className="w-60"
								>
									{c.status === "open" && (
										<>
											<DropdownMenuItem
												onSelect={() => void send({ resolve: true })}
											>
												<CircleCheck />
												Send and resolve
											</DropdownMenuItem>
											<DropdownMenuSeparator />
										</>
									)}
									<DropdownMenuLabel>Send later</DropdownMenuLabel>
									{[
										{
											label: "In an hour",
											at: new Date(
												Math.ceil((Date.now() + 3_600_000) / 900_000) *
													900_000,
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
												{short.format(p.at)}
											</span>
										</DropdownMenuItem>
									))}
									<DropdownMenuItem onSelect={() => setPicking(true)}>
										Pick a time…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={busy !== null || !text.trim()}
							onClick={() => void saveDraft()}
						>
							{busy === "draft" ? <Spinner /> : <PenLine />}
							{draft ? "Save draft" : "Save as draft"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							disabled={busy !== null}
							onClick={() => fileInput.current?.click()}
						>
							<Paperclip />
							Attach
						</Button>
						<SavedPicker
							saved={saved}
							onPick={(s) => insertSaved(s)}
						/>
						{onDone && (
							<Button
								type="button"
								variant="ghost"
								onClick={onDone}
							>
								Cancel
							</Button>
						)}
						<span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
							{workflow.signature && (
								<span className="flex items-center gap-1.5">
									<Checkbox
										id={`sig-${c.id}`}
										checked={signature}
										onCheckedChange={(v) => setSignature(v === true)}
									/>
									<label htmlFor={`sig-${c.id}`}>Signature</label>
								</span>
							)}
							<span className="hidden items-center gap-1 sm:flex">
								<Kbd>⌘</Kbd>
								<Kbd>↵</Kbd>
							</span>
						</span>
					</div>
				)}
			</form>
			<PickMoment
				open={picking}
				onOpenChange={setPicking}
				title="Send later"
				description="The reply waits in the conversation and goes at this time (your time zone). Until then you can call it back."
				action="Schedule"
				onPick={(d) => void send({ at: d })}
			/>
		</Card>
	);
}

/** The saved replies, found by name or shortcut. */
function SavedPicker({ saved, onPick }: { saved: Saved[]; onPick: (s: Saved) => void }) {
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
				>
					<Zap />
					Saved replies
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 p-2"
			>
				<Input
					autoFocus
					className="h-8"
					placeholder="Find a saved reply"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<ul className="mt-2 flex max-h-72 flex-col overflow-y-auto">
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
								<span className="flex items-center gap-2 text-sm">
									<span className="min-w-0 flex-1 truncate font-medium">
										{s.name}
									</span>
									{s.shortcut && (
										<span className="text-xs text-muted-foreground">
											/{s.shortcut}
										</span>
									)}
								</span>
								<span className="line-clamp-2 text-xs text-muted-foreground">
									{s.text}
								</span>
							</button>
						</li>
					))}
					{!shown.length && (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							{saved.length ? "None match." : "No saved replies yet."}
						</li>
					)}
				</ul>
				<div className="mt-1 border-t pt-2">
					<Link
						to="/received/replies"
						className="block rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						Manage saved replies
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
}
