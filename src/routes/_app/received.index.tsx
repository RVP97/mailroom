import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	AlertTriangle,
	BarChart3,
	Bot,
	CheckCheck,
	CircleCheck,
	Clock,
	Filter,
	Inbox,
	Mail,
	MailOpen,
	MessageCircle,
	PenLine,
	Plus,
	Route as RouteIcon,
	Search,
	ShieldAlert,
	SlidersHorizontal,
	UserCheck,
	UserX,
	X,
	Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { type ConversationData, ConversationPane } from "@/components/inbox/conversation-pane";
import { NewConversationDialog } from "@/components/inbox/inbox-dialogs";
import { InboxNotificationToggle, SavedViewsSection } from "@/components/inbox/saved-views-rail";
import { broadcastUnreadCount, useInboxLive } from "@/components/inbox/use-inbox-live";
import { Avatar, PriorityFlag, SlaText, Stars, TagChip } from "@/components/inbox-triage";
import { CopyText, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	bulkUpdateConversationsFn,
	getConversationFn,
	listConversationsFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { usePendingSearch } from "@/lib/pending";
import { allows } from "@/lib/permissions";
import { rememberOrder } from "@/lib/received-order";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	SketchWhile,
	sample,
	useListed,
	usePage,
	useRememberRows,
	useSketching,
} from "@/lib/sketch";
import { cn } from "@/lib/utils";

const STATUSES = ["open", "resolved", "all"] as const;
const VIEWS = [
	"open",
	"mine",
	"unassigned",
	"snoozed",
	"overdue",
	"held",
	"resolved",
	"all",
] as const;
type View = (typeof VIEWS)[number];
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;

const viewQuery = (view: View) =>
	({
		open: { status: "open" as const },
		mine: { status: "open" as const, assignee: "me" },
		unassigned: { status: "open" as const, assignee: "none" },
		snoozed: { status: "snoozed" as const },
		overdue: { status: "open" as const, sla: "breached" as const },
		held: { status: "all" as const, held: true },
		resolved: { status: "resolved" as const },
		all: { status: "all" as const },
	})[view];

export const Route = createFileRoute("/_app/received/")({
	validateSearch: z.object({
		q: z.string().optional(),
		brand: z.string().optional(),
		inbox: z.string().optional(),
		view: z.enum(VIEWS).optional(),
		status: z.enum(STATUSES).optional(),
		unread: z.boolean().optional(),
		tag: z.string().optional(),
		priority: z.enum(PRIORITIES).optional(),
		assignee: z.string().optional(),
		after: z.string().optional(),
		/** Active conversation in the 3-pane desktop Inbox split view. */
		c: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({
		q: search.q,
		brand: search.brand,
		inbox: search.inbox,
		view: search.view,
		status: search.status,
		unread: search.unread,
		tag: search.tag,
		priority: search.priority,
		assignee: search.assignee,
		after: search.after,
	}),
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) => {
		const q = viewQuery(deps.view ?? deps.status ?? "open");
		return listConversationsFn({
			data: {
				search: deps.q,
				brand: deps.brand,
				inbox: deps.inbox,
				unread: deps.unread,
				tag: deps.tag,
				priority: deps.priority,
				...q,
				assignee: "assignee" in q ? q.assignee : deps.assignee,
				after: deps.after,
			},
		});
	},
	head: () => ({ meta: [{ title: "Inbox · Mailroom" }] }),
	component: InboxWorkspace,
	pendingComponent: InboxSketch,
});

type Row = Awaited<ReturnType<typeof listConversationsFn>>["data"][number];

const senderName = (from: string) =>
	/^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

function InboxSketch() {
	return (
		<Sketch
			data={{
				has_more: rememberedRows("received:more", 0) > 0,
				address: rememberedRows("received:address", 1)
					? "brand-name@in.mailroom.example.com"
					: null,
				addresses: null,
				addressBrand: "",
				brands: sample(rememberedRows("received:brands", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
				})),
				inboxes: sample(rememberedRows("received:inboxes", 0), (i) => ({
					id: `inbox-${i}`,
					name: "Inbox",
					address: "support@example.com",
					brand_id: "",
				})),
				data: sample(
					rememberedRows("received", 8),
					(i): Row => ({
						object: "conversation",
						id: `sketch-${i}`,
						brand_id: "",
						inbox_id: null,
						channel: "email",
						subject: pick(i, [
							"Re: Your booking",
							"Question about check-in",
							"Invoice",
						]),
						contact: pick(i, ["Ana López <ana@example.com>", "guest@example.org"]),
						status: "open",
						unread: false,
						messages: 1,
						drafts: 0,
						snippet: "Hello, I wanted to ask about",
						last_message_at: ago(i * 45),
						last_inbound_at: ago(i * 45),
						last_reply_at: null,
						replied_by: null,
						resolved_at: null,
						created_at: ago(i * 45),
						assignee: null,
						tags: [],
						priority: "normal",
						snoozed_until: null,
						first_reply_at: null,
						sla: { reply_due_at: null, resolve_due_at: null, breached: [] },
						csat: null,
						held: false,
						held_at: null,
					}),
				),
				me: "",
				views: { open: 0, mine: 0, unassigned: 0, snoozed: 0, overdue: 0, held: 0 },
				tags: [],
				people: [],
			}}
		>
			<InboxWorkspace />
		</Sketch>
	);
}

/**
 * Full-bleed Intercom-style 3-pane Inbox workspace on desktop (Queue/Inbox rail + Live
 * conversation list with bulk actions + Active conversation pane with unified sticky composer)
 * and crisp mail-app list on phones.
 */
function InboxWorkspace() {
	const { data: page, search: current } = usePage(Route);
	const router = useRouter();
	const navigate = Route.useNavigate();
	const me = useMe();
	const canReply = allows(me.active?.access, "inbox:reply");
	const canAgents = allows(me.active?.access, "inbox:agents");
	const { search, loading } = usePendingSearch(current);
	const sketching = useSketching();

	useRememberRows("received", loading ? undefined : page.data.length);
	useRememberRows("received:more", loading ? undefined : page.has_more ? 1 : 0);
	useRememberRows("received:brands", page.brands.length);
	useRememberRows("received:inboxes", page.inboxes.length);
	useRememberRows("received:address", page.address ? 1 : 0);
	useListed("received", page.data);

	useEffect(() => {
		if (!loading && !sketching)
			rememberOrder({ ids: page.data.map((r) => r.id), search: current });
	}, [loading, sketching, page.data, current]);

	// Keep sidebar unread pill accurate
	useEffect(() => {
		if (loading || sketching) return;
		const view: View = current.view ?? current.status ?? "open";
		if (view === "open" && !current.q && !current.inbox && !current.brand && !current.tag) {
			const unreadCount = page.data.filter((r) => r.unread).length;
			if (!page.has_more) broadcastUnreadCount(unreadCount);
		}
	}, [loading, sketching, page.data, page.has_more, current]);

	const view: View = search.view ?? search.status ?? "open";
	const inboxes = useMemo(() => new Map(page.inboxes.map((i) => [i.id, i])), [page.inboxes]);
	const brandNames = useMemo(
		() => new Map(page.brands.map((b) => [b.id, b.name])),
		[page.brands],
	);
	const peopleMap = useMemo(() => new Map(page.people.map((p) => [p.reader, p])), [page.people]);

	// Active conversation in the desktop split pane
	const selectedId = current.c ?? page.data[0]?.id ?? null;
	const [active, setActive] = useState<{
		id: string;
		data: ConversationData | null;
		loading: boolean;
		error: string | null;
	}>({ id: "", data: null, loading: false, error: null });
	const [composeOpen, setComposeOpen] = useState(false);

	// Bulk selection
	const [checked, setChecked] = useState<Set<string>>(() => new Set());
	const [bulkBusy, setBulkBusy] = useState(false);

	const loadConversation = useCallback(async (id: string, silent = false) => {
		if (!id || id.startsWith("sketch-")) return;
		if (!silent)
			setActive((prev) => ({
				id,
				data: prev.id === id ? prev.data : null,
				loading: true,
				error: null,
			}));
		try {
			const data = await getConversationFn({ data: { id } });
			setActive((prev) =>
				prev.id === id || !prev.id ? { id, data, loading: false, error: null } : prev,
			);
		} catch (error) {
			const msg = await errorMessage(error);
			setActive((prev) =>
				prev.id === id ? { id, data: null, loading: false, error: msg } : prev,
			);
		}
	}, []);

	useEffect(() => {
		if (sketching || !selectedId || selectedId.startsWith("sketch-")) return;
		// Only fetch split-pane detail on desktop widths so mobile doesn't waste a request.
		if (typeof window !== "undefined" && window.innerWidth < 1024) return;
		void loadConversation(selectedId);
	}, [selectedId, sketching, loadConversation]);

	// Real-time org inbox hub: refreshes list + active thread and tracks teammate presence!
	const { connected, viewers, setTyping } = useInboxLive({
		enabled: !sketching,
		viewing: selectedId && !selectedId.startsWith("sketch-") ? selectedId : null,
		onChange: (ev) => {
			void router.invalidate();
			if (selectedId && (!ev.conversation_id || ev.conversation_id === selectedId)) {
				void loadConversation(selectedId, true);
			}
		},
	});

	const to = (patch: Partial<typeof search>) =>
		navigate({ search: { ...search, ...patch, after: undefined } });

	const selectRow = useCallback(
		(id: string) => {
			if (typeof window !== "undefined" && window.innerWidth < 1024) {
				void router.navigate({ to: "/received/$id", params: { id } });
				return;
			}
			void navigate({
				search: { ...search, c: id },
				replace: true,
				resetScroll: false,
			});
		},
		[navigate, router, search],
	);

	const reloadAll = useCallback(async () => {
		await router.invalidate();
		if (selectedId && !selectedId.startsWith("sketch-")) {
			await loadConversation(selectedId, true);
		}
	}, [router, selectedId, loadConversation]);

	// Keyboard j/k navigation across the conversation list on desktop
	const listRef = useRef(page.data);
	listRef.current = page.data;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const el = e.target as HTMLElement | null;
			if (el?.closest("input, textarea, select, [contenteditable=true]")) return;
			if (
				document.querySelector(
					"[role=dialog], [role=menu], [data-radix-popper-content-wrapper]",
				)
			)
				return;
			if (e.key !== "j" && e.key !== "k") return;
			const rows = listRef.current;
			if (!rows.length) return;
			const idx = rows.findIndex((r) => r.id === selectedId);
			const next =
				e.key === "j"
					? rows[Math.min(rows.length - 1, idx + 1)]
					: rows[Math.max(0, idx - 1)];
			if (next && next.id !== selectedId) {
				e.preventDefault();
				selectRow(next.id);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [selectedId, selectRow]);

	// Clicking a browser desktop notification selects that conversation immediately.
	useEffect(() => {
		const onSelect = (e: Event) => {
			const id = (e as CustomEvent<{ conversationId?: string }>).detail?.conversationId;
			if (id) selectRow(id);
		};
		window.addEventListener("mailroom:inbox-select", onSelect);
		return () => window.removeEventListener("mailroom:inbox-select", onSelect);
	}, [selectRow]);

	const toggleChecked = (id: string) => {
		setChecked((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const allChecked = page.data.length > 0 && page.data.every((r) => checked.has(r.id));
	const toggleAll = () => {
		if (allChecked) setChecked(new Set());
		else setChecked(new Set(page.data.map((r) => r.id)));
	};

	const runBulk = async (
		patch: Omit<Parameters<typeof bulkUpdateConversationsFn>[0]["data"], "ids">,
		label: string,
	) => {
		const ids = [...checked];
		if (!ids.length) return;
		setBulkBusy(true);
		try {
			const r = await bulkUpdateConversationsFn({ data: { ids, ...patch } });
			toast.success(`${label} (${r.updated})`);
			setChecked(new Set());
			await reloadAll();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBulkBusy(false);
		}
	};

	const quickResolve = async (row: Row) => {
		try {
			await updateConversationFn({
				data: { id: row.id, status: row.status === "open" ? "resolved" : "open" },
			});
			toast.success(row.status === "open" ? "Resolved" : "Reopened");
			await reloadAll();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};

	const quickToggleUnread = async (row: Row) => {
		try {
			await updateConversationFn({ data: { id: row.id, read: row.unread } });
			await reloadAll();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};

	const activeFilterCount =
		(search.unread ? 1 : 0) +
		(search.priority ? 1 : 0) +
		(search.tag ? 1 : 0) +
		(search.assignee ? 1 : 0) +
		(search.brand ? 1 : 0) +
		(search.inbox ? 1 : 0);

	const now = Date.now();
	const filtered = Boolean(search.q || activeFilterCount > 0 || view !== "open");

	const queues: {
		id: View;
		label: string;
		icon: typeof Inbox;
		count?: number;
		tone?: "danger" | "warn";
		hideWhenZero?: boolean;
	}[] = [
		{ id: "open", label: "All open", icon: Inbox, count: page.views.open },
		{ id: "mine", label: "Mine", icon: UserCheck, count: page.views.mine },
		{ id: "unassigned", label: "Unassigned", icon: UserX, count: page.views.unassigned },
		{ id: "snoozed", label: "Snoozed", icon: Clock, count: page.views.snoozed },
		{
			id: "overdue",
			label: "Overdue SLA",
			icon: AlertTriangle,
			count: page.views.overdue,
			tone: "danger",
			hideWhenZero: true,
		},
		{
			id: "held",
			label: "Held",
			icon: ShieldAlert,
			count: page.views.held,
			tone: "warn",
			hideWhenZero: true,
		},
		{ id: "resolved", label: "Resolved", icon: CircleCheck },
		{ id: "all", label: "All", icon: MailOpen },
	];

	return (
		<div className="flex min-h-[calc(100svh-3rem)] w-full overflow-hidden lg:h-[calc(100svh-1rem)] lg:rounded-xl">
			{/* PANE 1: Compact Queue / Inbox / Tag Rail (desktop xl+) */}
			<aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-muted/15 p-3 xl:flex">
				<div className="flex items-center justify-between gap-2 px-1 pb-2.5">
					<div className="flex items-center gap-1.5">
						<h1 className="text-base font-semibold tracking-tight">Inbox</h1>
						{!sketching && connected && (
							<span
								title="Live updates connected"
								className="size-1.5 rounded-full bg-emerald-500"
							/>
						)}
					</div>
					<div className="flex items-center gap-1">
						{!sketching && <InboxNotificationToggle />}
						{canReply && (
							<Button
								size="icon-sm"
								variant="outline"
								aria-label="New conversation"
								title="New conversation"
								onClick={() => setComposeOpen(true)}
							>
								<Plus className="size-3.5" />
							</Button>
						)}
					</div>
				</div>

				<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
					{/* Queues */}
					<div className="flex flex-col gap-0.5">
						{queues
							.filter((q) => !q.hideWhenZero || (q.count ?? 0) > 0 || view === q.id)
							.map((q) => {
								const activeQueue = view === q.id;
								return (
									<button
										key={q.id}
										type="button"
										onClick={() =>
											to({
												view: q.id === "open" ? undefined : q.id,
												status: undefined,
												...(q.id === "mine" || q.id === "unassigned"
													? { assignee: undefined }
													: {}),
											})
										}
										className={cn(
											"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
											activeQueue
												? "bg-background font-medium text-foreground shadow-button dark:bg-white/[0.08]"
												: "text-muted-foreground hover:bg-accent hover:text-foreground",
										)}
									>
										<q.icon
											className={cn(
												"size-3.5 shrink-0",
												q.tone === "danger"
													? "text-destructive"
													: q.tone === "warn"
														? "text-warning"
														: activeQueue
															? "text-foreground"
															: "text-faint",
											)}
										/>
										<span className="min-w-0 flex-1 truncate">{q.label}</span>
										{q.count !== undefined && q.count > 0 && (
											<span
												className={cn(
													"text-xs tabular-nums",
													q.tone === "danger"
														? "font-medium text-destructive"
														: "text-muted-foreground",
												)}
											>
												<Ph>{q.count}</Ph>
											</span>
										)}
									</button>
								);
							})}
					</div>

					{/* Custom saved views */}
					{!sketching && (
						<SavedViewsSection
							currentFilters={{
								view: view !== "open" ? view : undefined,
								brand: search.brand,
								inbox: search.inbox,
								tag: search.tag,
								priority: search.priority,
								assignee: search.assignee,
								unread: search.unread,
								q: search.q,
							}}
							hasActiveFilters={filtered}
							onApply={(f) =>
								to({
									view: (f.view as View | undefined) ?? undefined,
									status: undefined,
									brand: f.brand,
									inbox: f.inbox,
									tag: f.tag,
									priority: f.priority as (typeof PRIORITIES)[number] | undefined,
									assignee: f.assignee,
									unread: f.unread,
									q: f.q,
								})
							}
						/>
					)}

					{/* Inboxes */}
					{page.inboxes.length > 0 && (
						<div className="flex flex-col gap-0.5">
							<p className="eyebrow px-2 pb-1">Inboxes</p>
							<button
								type="button"
								onClick={() => to({ inbox: undefined })}
								className={cn(
									"flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
									!search.inbox
										? "bg-muted font-medium text-foreground"
										: "text-muted-foreground hover:bg-accent hover:text-foreground",
								)}
							>
								<span className="truncate">All inboxes</span>
							</button>
							{page.inboxes.map((i) => (
								<button
									key={i.id}
									type="button"
									onClick={() =>
										to({ inbox: search.inbox === i.id ? undefined : i.id })
									}
									className={cn(
										"flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors",
										search.inbox === i.id
											? "bg-muted font-medium text-foreground"
											: "text-muted-foreground hover:bg-accent hover:text-foreground",
									)}
								>
									<Bot className="size-3 shrink-0 text-faint" />
									<span className="min-w-0 flex-1 truncate">{i.name}</span>
								</button>
							))}
						</div>
					)}

					{/* Tags */}
					{page.tags.length > 0 && (
						<div className="flex flex-col gap-1">
							<p className="eyebrow px-2">Tags</p>
							<div className="flex flex-wrap gap-1 px-1">
								{page.tags.slice(0, 12).map((t) => (
									<button
										key={t.name}
										type="button"
										onClick={() =>
											to({ tag: search.tag === t.name ? undefined : t.name })
										}
										className={cn(
											"rounded-md transition-opacity",
											search.tag && search.tag !== t.name && "opacity-50",
										)}
									>
										<TagChip
											tag={t.name}
											catalog={page.tags}
										/>
									</button>
								))}
							</div>
						</div>
					)}
				</div>

				{/* Manage links neatly anchored at bottom */}
				<div className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2">
					<p className="eyebrow px-2 pb-1">Configure</p>
					{[
						{
							to: "/received/inboxes" as const,
							label: canAgents ? "Agent inboxes" : "Inboxes",
							icon: Bot,
						},
						{
							to: "/received/chat" as const,
							label: "Website chat",
							icon: MessageCircle,
						},
						{ to: "/received/rules" as const, label: "Rules", icon: RouteIcon },
						{ to: "/received/replies" as const, label: "Saved replies", icon: Zap },
						{ to: "/received/reports" as const, label: "Reports", icon: BarChart3 },
					].map((item) => (
						<Link
							key={item.to}
							to={item.to}
							className="flex h-7 items-center gap-2 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<item.icon className="size-3.5 shrink-0 text-faint" />
							<span className="truncate">{item.label}</span>
						</Link>
					))}
				</div>
			</aside>

			{/* PANE 2: Live Conversation List */}
			<section
				aria-label="Conversations"
				className="flex min-h-0 w-full shrink-0 flex-col border-border lg:w-80 lg:border-r xl:w-[22.5rem]"
			>
				{/* Top List Toolbar */}
				<div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
					<div className="flex items-center gap-2">
						{/* Mobile / narrow desktop queue selector */}
						<div className="flex items-center gap-2 xl:hidden">
							<Select
								value={view}
								onValueChange={(v) =>
									to({
										view: v === "open" ? undefined : (v as View),
										status: undefined,
									})
								}
							>
								<SelectTrigger className="h-8 w-auto min-w-28 text-xs font-medium">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{queues
										.filter(
											(q) =>
												!q.hideWhenZero ||
												(q.count ?? 0) > 0 ||
												view === q.id,
										)
										.map((q) => (
											<SelectItem
												key={q.id}
												value={q.id}
											>
												{q.label}
												{q.count ? ` (${q.count})` : ""}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						</div>

						<SearchBox
							value={search.q ?? ""}
							onChange={(q) => to({ q: q || undefined })}
							placeholder="Search inbox…"
							className="h-8 flex-1 text-xs"
						/>

						{/* Filters popover */}
						<Popover>
							<PopoverTrigger asChild>
								<Button
									variant={activeFilterCount > 0 ? "secondary" : "outline"}
									size="icon-sm"
									aria-label="Filters"
									title="Filters"
									className="relative shrink-0"
								>
									<SlidersHorizontal className="size-3.5" />
									{activeFilterCount > 0 && (
										<span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-brand-foreground">
											{activeFilterCount}
										</span>
									)}
								</Button>
							</PopoverTrigger>
							<PopoverContent
								align="end"
								className="flex w-72 flex-col gap-3 p-3"
							>
								<div className="flex items-center justify-between">
									<span className="flex items-center gap-1.5 text-xs font-semibold">
										<Filter className="size-3.5" />
										Filter conversations
									</span>
									{activeFilterCount > 0 && (
										<button
											type="button"
											onClick={() =>
												to({
													unread: undefined,
													priority: undefined,
													tag: undefined,
													assignee: undefined,
													brand: undefined,
													inbox: undefined,
												})
											}
											className="text-xs text-muted-foreground hover:text-foreground"
										>
											Reset
										</button>
									)}
								</div>
								<div className="flex items-center gap-2 text-xs">
									<Checkbox
										id="inbox-unread-only"
										checked={Boolean(search.unread)}
										onCheckedChange={(v) =>
											to({ unread: v === true ? true : undefined })
										}
									/>
									<label htmlFor="inbox-unread-only">Unread only</label>
								</div>
								<BrandFilter
									brands={page.brands}
									value={search.brand}
									onChange={(brand) => to({ brand, inbox: undefined })}
								/>
								{page.inboxes.length > 0 && (
									<Select
										value={search.inbox ?? "all"}
										onValueChange={(v) =>
											to({ inbox: v === "all" ? undefined : v })
										}
									>
										<SelectTrigger className="h-8 text-xs">
											<SelectValue placeholder="All inboxes" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">All inboxes</SelectItem>
											<SelectSeparator />
											{page.inboxes.map((i) => (
												<SelectItem
													key={i.id}
													value={i.id}
												>
													{i.name}
												</SelectItem>
											))}
											<SelectItem value="none">Other addresses</SelectItem>
										</SelectContent>
									</Select>
								)}
								<Select
									value={search.priority ?? "all"}
									onValueChange={(v) =>
										to({
											priority:
												v === "all"
													? undefined
													: (v as (typeof PRIORITIES)[number]),
										})
									}
								>
									<SelectTrigger className="h-8 text-xs">
										<SelectValue placeholder="Any priority" />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">Any priority</SelectItem>
										<SelectSeparator />
										{PRIORITIES.map((p) => (
											<SelectItem
												key={p}
												value={p}
											>
												<PriorityFlag
													priority={p}
													label
												/>
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{page.people.length > 1 && (
									<Select
										value={search.assignee ?? "all"}
										onValueChange={(v) =>
											to({ assignee: v === "all" ? undefined : v })
										}
									>
										<SelectTrigger className="h-8 text-xs">
											<SelectValue>
												{search.assignee
													? (peopleMap.get(search.assignee)?.name ??
														"Someone")
													: "Any owner"}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">Any owner</SelectItem>
											<SelectSeparator />
											{page.people.map((p) => (
												<SelectItem
													key={p.reader}
													value={p.reader}
												>
													{p.name}
													{p.reader === page.me ? " (you)" : ""}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							</PopoverContent>
						</Popover>

						{canReply && (
							<Button
								size="icon-sm"
								variant="outline"
								className="shrink-0 xl:hidden"
								aria-label="New conversation"
								onClick={() => setComposeOpen(true)}
							>
								<Plus className="size-3.5" />
							</Button>
						)}
					</div>

					{/* Sub-row: select-all + unread quick toggle + mobile config links */}
					<div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
						<div className="flex items-center gap-2">
							<Checkbox
								id="inbox-select-all"
								checked={allChecked}
								aria-label="Select all conversations"
								onCheckedChange={toggleAll}
							/>
							<label
								htmlFor="inbox-select-all"
								className="tabular-nums"
							>
								<Ph>{page.data.length}</Ph>{" "}
								{page.data.length === 1 ? "thread" : "threads"}
							</label>
						</div>
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => to({ unread: search.unread ? undefined : true })}
								className={cn(
									"rounded-md px-2 py-0.5 text-xs transition-colors",
									search.unread
										? "bg-brand/15 font-medium text-brand"
										: "hover:bg-muted hover:text-foreground",
								)}
							>
								Unread
							</button>
							<Link
								to="/received/inboxes"
								className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground xl:hidden"
							>
								Inboxes
							</Link>
							<Link
								to="/received/chat"
								className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground xl:hidden"
							>
								Chat
							</Link>
						</div>
					</div>
				</div>

				{/* Bulk Action Bar */}
				{checked.size > 0 && (
					<div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-brand/25 bg-brand/[0.06] px-3 py-2 text-xs">
						<span className="font-medium text-brand tabular-nums">
							{checked.size} selected
						</span>
						<div className="ml-auto flex flex-wrap items-center gap-1">
							{canReply && (
								<>
									<Button
										size="sm"
										variant="outline"
										className="h-6 px-2 text-xs"
										disabled={bulkBusy}
										onClick={() =>
											void runBulk({ status: "resolved" }, "Resolved")
										}
									>
										<CircleCheck className="size-3" />
										Resolve
									</Button>
									<Button
										size="sm"
										variant="outline"
										className="h-6 px-2 text-xs"
										disabled={bulkBusy}
										onClick={() =>
											void runBulk({ assignee: page.me }, "Assigned to you")
										}
									>
										Mine
									</Button>
								</>
							)}
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-xs"
								disabled={bulkBusy}
								onClick={() => void runBulk({ read: true }, "Marked read")}
							>
								<CheckCheck className="size-3" />
								Read
							</Button>
							<Button
								size="icon-sm"
								variant="ghost"
								className="size-6"
								aria-label="Clear selection"
								onClick={() => setChecked(new Set())}
							>
								<X className="size-3" />
							</Button>
						</div>
					</div>
				)}

				{/* Scrollable Conversation Rows */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					<SketchWhile loading={loading && page.data.length > 0}>
						{loading && page.data.length === 0 ? (
							<RowsPending />
						) : page.data.length === 0 ? (
							<div className="p-4">
								<Empty>
									<EmptyHeader>
										<EmptyMedia variant="icon">
											{filtered ? <Search /> : <Inbox />}
										</EmptyMedia>
										<EmptyTitle>
											{filtered ? "No conversations match" : "Inbox zero"}
										</EmptyTitle>
										<EmptyDescription>
											{filtered
												? "Try clearing a filter or changing your search."
												: "New emails and website chats will appear here live."}
										</EmptyDescription>
									</EmptyHeader>
								</Empty>
							</div>
						) : (
							<ul className="divide-y divide-border/70">
								{page.data.map((r) => {
									const isSelected = r.id === selectedId;
									const isChecked = checked.has(r.id);
									const rowInbox = r.inbox_id ? inboxes.get(r.inbox_id) : null;
									const rowViewers = viewers.filter(
										(v) =>
											v.userId !== me.user.id &&
											(v.viewing === r.id || v.typingIn === r.id),
									);
									return (
										<li
											key={r.id}
											className={cn(
												"group relative flex items-start gap-2.5 px-3 py-3 transition-colors",
												isSelected
													? "bg-brand/[0.07] dark:bg-white/[0.06]"
													: "hover:bg-muted/50",
											)}
										>
											{/* Selection checkbox / unread indicator */}
											<div className="mt-0.5 flex flex-col items-center gap-2">
												<Checkbox
													checked={isChecked}
													aria-label={`Select ${r.subject || "conversation"}`}
													onCheckedChange={() => toggleChecked(r.id)}
													className={cn(
														"transition-opacity",
														isChecked || checked.size > 0
															? "opacity-100"
															: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
													)}
												/>
												{r.unread && (
													<span
														className="size-2 rounded-full bg-brand"
														title="Unread"
													/>
												)}
											</div>

											{/* Clickable Row Body */}
											<button
												type="button"
												onClick={() => selectRow(r.id)}
												className="min-w-0 flex-1 text-left outline-none"
											>
												<div className="flex items-center gap-1.5">
													<span
														className={cn(
															"min-w-0 flex-1 truncate text-sm",
															r.unread
																? "font-semibold text-foreground"
																: "font-medium text-foreground/90",
														)}
													>
														<Ph>{senderName(r.contact)}</Ph>
													</span>
													{r.messages > 1 && (
														<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
															<Ph>{r.messages}</Ph>
														</span>
													)}
													<span
														className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
														title={formatDateTime(r.last_message_at)}
													>
														<Ph>{formatAgo(r.last_message_at, now)}</Ph>
													</span>
												</div>

												<div className="mt-0.5 flex items-center gap-1.5">
													<PriorityFlag
														priority={r.priority}
														label={false}
													/>
													{(r.channel === "chat" ||
														r.channel === "whatsapp" ||
														r.channel === "telegram") && (
														<MessageCircle className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
													)}
													<span
														className={cn(
															"min-w-0 flex-1 truncate text-xs",
															r.unread
																? "font-medium text-foreground"
																: "text-foreground/85",
														)}
													>
														<Ph>{r.subject || "(no subject)"}</Ph>
													</span>
												</div>

												<p className="mt-0.5 truncate text-xs text-muted-foreground">
													<Ph>
														{rowInbox ? `${rowInbox.name} · ` : ""}
														{brandNames.size > 1 &&
														brandNames.get(r.brand_id)
															? `${brandNames.get(r.brand_id)} · `
															: ""}
														{r.snippet ?? ""}
													</Ph>
												</p>

												{/* Badges, SLA, Assignee & Live Viewers */}
												{(r.drafts > 0 ||
													r.held ||
													r.snoozed_until ||
													r.tags.length > 0 ||
													r.assignee ||
													r.sla.breached.length > 0 ||
													r.csat?.rating ||
													rowViewers.length > 0) && (
													<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
														{r.drafts > 0 && (
															<Badge
																variant="brand"
																className="h-4.5 px-1.5 text-[10px]"
															>
																<PenLine className="size-2.5" />
																Draft
															</Badge>
														)}
														{r.held && <StatusBadge status="held" />}
														{r.snoozed_until && (
															<StatusBadge
																status="snoozed"
																label={`Back ${formatAgo(r.snoozed_until, now)}`}
															/>
														)}
														{r.csat?.rating ? (
															<Stars rating={r.csat.rating} />
														) : null}
														{r.tags.slice(0, 2).map((t) => (
															<TagChip
																key={t}
																tag={t}
																catalog={page.tags}
															/>
														))}
														<span className="ml-auto flex items-center gap-1.5">
															<SlaText
																sla={r.sla}
																status={r.status}
															/>
															{rowViewers.length > 0 && (
																<span
																	title={`${rowViewers.map((v) => v.name).join(", ")} viewing`}
																	className="flex -space-x-1"
																>
																	{rowViewers
																		.slice(0, 2)
																		.map((v) => (
																			<Avatar
																				key={v.userId}
																				name={v.name}
																				className="size-4 text-[9px] ring-2 ring-amber-400"
																			/>
																		))}
																</span>
															)}
															{r.assignee && (
																<Avatar
																	name={r.assignee.name}
																	agent={
																		r.assignee.type === "agent"
																	}
																	className={cn(
																		"size-4.5 text-[10px]",
																		r.assignee.reader ===
																			page.me &&
																			"ring-2 ring-brand/40",
																	)}
																/>
															)}
														</span>
													</div>
												)}
											</button>

											{/* Hover quick actions */}
											<div className="absolute top-2 right-2 hidden items-center gap-0.5 rounded-md border border-border bg-background/95 p-0.5 shadow-sm group-hover:flex">
												{canReply && (
													<button
														type="button"
														title={
															r.status === "open"
																? "Resolve"
																: "Reopen"
														}
														onClick={(e) => {
															e.stopPropagation();
															void quickResolve(r);
														}}
														className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
													>
														<CircleCheck className="size-3.5" />
													</button>
												)}
												<button
													type="button"
													title={r.unread ? "Mark read" : "Mark unread"}
													onClick={(e) => {
														e.stopPropagation();
														void quickToggleUnread(r);
													}}
													className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
												>
													{r.unread ? (
														<MailOpen className="size-3.5" />
													) : (
														<Mail className="size-3.5" />
													)}
												</button>
											</div>
										</li>
									);
								})}
							</ul>
						)}
					</SketchWhile>

					{(page.has_more || search.after) && (
						<div className="border-t border-border p-2">
							<TablePager
								label={`${page.data.length} shown`}
								previousLabel="Newest"
								nextLabel="Older"
								onPrevious={
									search.after
										? () =>
												navigate({
													search: { ...search, after: undefined },
												})
										: undefined
								}
								onNext={
									page.has_more
										? () =>
												navigate({
													search: {
														...search,
														after: page.data.at(-1)?.id,
													},
												})
										: undefined
								}
							/>
						</div>
					)}
				</div>
			</section>

			{/* PANE 3: Active Conversation Workspace (desktop lg+) */}
			<section
				aria-label="Active conversation"
				className="hidden min-h-0 min-w-0 flex-1 flex-col lg:flex"
			>
				{active.data && active.id === selectedId ? (
					<ConversationPane
						data={active.data}
						viewers={viewers}
						embedded
						onReload={reloadAll}
						onSelectConversation={selectRow}
						onAfterResolve={() => {
							const idx = page.data.findIndex((r) => r.id === selectedId);
							const next = page.data[idx + 1] ?? page.data[idx - 1];
							if (next) selectRow(next.id);
						}}
						onTypingChange={(on) => setTyping(selectedId, on)}
					/>
				) : active.loading && selectedId ? (
					<div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
						<Spinner />
						Loading conversation…
					</div>
				) : active.error ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
						<p>{active.error}</p>
						{selectedId && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => void loadConversation(selectedId)}
							>
								Try again
							</Button>
						)}
					</div>
				) : (
					<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
						<span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
							<Inbox className="size-6" />
						</span>
						<div className="max-w-sm">
							<h2 className="text-base font-semibold">
								{page.data.length === 0 ? "All caught up" : "Select a conversation"}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								{page.data.length === 0
									? "Incoming emails and website chats show up here in real time."
									: "Use J and K to move through your queue, R to reply, N for internal notes, and E to resolve."}
							</p>
						</div>
						{page.address && (
							<div className="mt-2 flex flex-col items-center gap-1 rounded-xl border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
								<span>Your brand's receiving address:</span>
								<Ph>
									<CopyText
										value={page.address}
										className="text-xs text-foreground"
									/>
								</Ph>
							</div>
						)}
						{canReply && (
							<Button
								size="sm"
								variant="outline"
								className="mt-1"
								onClick={() => setComposeOpen(true)}
							>
								<Plus className="size-3.5" />
								Start a new conversation
							</Button>
						)}
					</div>
				)}
			</section>

			<NewConversationDialog
				open={composeOpen}
				onOpenChange={setComposeOpen}
				defaultInbox={search.inbox && search.inbox !== "none" ? search.inbox : undefined}
				onCreated={(id) => {
					void router.invalidate();
					selectRow(id);
				}}
			/>
		</div>
	);
}
