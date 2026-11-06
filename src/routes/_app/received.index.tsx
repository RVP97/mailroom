import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BarChart3,
	Bot,
	Inbox,
	MessageCircle,
	MessagesSquare,
	PenLine,
	Route as RouteIcon,
	Search,
	Zap,
} from "lucide-react";
import { useEffect } from "react";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { InboundAddress } from "@/components/inbound-address";
import { InboxMenu } from "@/components/inbox-menu";
import { Avatar, PriorityFlag, SlaText, Stars, TagChip } from "@/components/inbox-triage";
import { CopyText, Page, PageHeader, TableCard, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { listConversationsFn } from "@/functions/inboxes";
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
/** The queues: each a status and who has it, counted in the toggle. */
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

/** What a view asks the list for. */
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
		/** One brand; without it, every brand of the organization. */
		brand: z.string().optional(),
		/** An agent inbox's id, or "none" for the brand's other addresses. */
		inbox: z.string().optional(),
		view: z.enum(VIEWS).optional(),
		/** Older links: open, resolved or all. */
		status: z.enum(STATUSES).optional(),
		unread: z.boolean().optional(),
		tag: z.string().optional(),
		priority: z.enum(PRIORITIES).optional(),
		/** A reader ("user:…", "cred:…"), when the view doesn't say who. */
		assignee: z.string().optional(),
		after: z.string().optional(),
	}),
	loaderDeps: ({ search }) => search,
	// New filters keep the page up (and the search box focused): only the rows turn into skeletons.
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
	head: () => ({ meta: [{ title: "Received · Mailroom" }] }),
	component: Received,
	pendingComponent: ReceivedSketch,
});

type Row = Awaited<ReturnType<typeof listConversationsFn>>["data"][number];

function ReceivedSketch() {
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
			<Received />
		</Sketch>
	);
}

/** «Ana López <ana@…>» as «Ana López», or the bare address. */
const senderName = (from: string) =>
	/^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

function Received() {
	const { data: page, search: current } = usePage(Route);
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:rules");
	const canAgents = allows(me.active?.access, "inbox:agents");
	const { search, loading } = usePendingSearch(current);
	useRememberRows("received", loading ? undefined : page.data.length);
	useRememberRows("received:more", loading ? undefined : page.has_more ? 1 : 0);
	useRememberRows("received:brands", page.brands.length);
	useRememberRows("received:inboxes", page.inboxes.length);
	useRememberRows("received:address", page.address ? 1 : 0);
	useListed("received", page.data);
	const sketching = useSketching();
	useEffect(() => {
		if (!loading && !sketching)
			rememberOrder({ ids: page.data.map((r) => r.id), search: current });
	}, [loading, sketching, page.data, current]);
	const navigate = Route.useNavigate();
	const names = new Map(page.brands.map((o) => [o.id, o.name]));
	const inboxes = new Map(page.inboxes.map((i) => [i.id, i]));
	const now = Date.now();
	const view: View = search.view ?? search.status ?? "open";
	const filtered = Boolean(
		search.q ||
			search.inbox ||
			search.unread ||
			search.tag ||
			search.priority ||
			search.assignee ||
			view !== "open",
	);
	const people = new Map(page.people.map((p) => [p.reader, p]));
	const counted = (v: keyof typeof page.views, label: string) => (
		<>
			{label}
			{page.views[v] > 0 && (
				<span className="text-xs text-muted-foreground tabular-nums">{page.views[v]}</span>
			)}
		</>
	);
	const to = (patch: Partial<typeof search>) =>
		navigate({ search: { ...search, ...patch, after: undefined } });
	return (
		<Page>
			<PageHeader
				title="Received"
				description={
					<>
						Conversations with whoever writes to your domains with receiving on, your
						agent inboxes{page.address ? " and the brand's Mailroom address:" : "."}
						{page.address && (
							<span className="mt-1 flex flex-col items-start gap-0.5 text-sm">
								<Ph>
									<CopyText
										value={page.address}
										className="text-sm"
									/>
								</Ph>
								<span className="text-muted-foreground">
									Already receiving, and so does anything+{"…"} at it
									{page.addresses?.own && page.addresses.fallback && (
										<>; {page.addresses.fallback} works too</>
									)}
								</span>
								{page.addresses?.picked && !page.addresses.own && (
									<span className="text-warning">
										{page.addresses.picked} isn't used while its domain doesn't
										receive.
									</span>
								)}
								{canManage && page.addresses && (
									<InboundAddress
										brand={page.addressBrand}
										addresses={page.addresses}
									/>
								)}
							</span>
						)}
					</>
				}
				actions={
					<>
						<Button
							variant="outline"
							asChild
						>
							<Link to="/received/inboxes">
								<Bot />
								{canAgents ? "Agent inboxes" : "Inboxes"}
							</Link>
						</Button>
						<Button
							variant="outline"
							asChild
						>
							<Link to="/received/rules">
								<RouteIcon />
								Rules
							</Link>
						</Button>
						<Button
							variant="outline"
							asChild
						>
							<Link to="/received/replies">
								<Zap />
								<span className="hidden sm:inline">Saved replies</span>
							</Link>
						</Button>
						<Button
							variant="outline"
							asChild
						>
							<Link to="/received/reports">
								<BarChart3 />
								<span className="hidden sm:inline">Reports</span>
							</Link>
						</Button>
						<ApiDrawer
							title="Conversations in the API"
							description="With a full-access key, or an agent inbox's own credential (mri_…), which reaches only its inbox."
							calls={[
								{
									title: "List open conversations",
									method: "GET",
									path: "/conversations?status=open",
								},
								{
									title: "Read one whole (messages, replies, drafts)",
									method: "GET",
									path: `/conversations/${page.data[0]?.id ?? "<id>"}?mark_read=true`,
								},
								{
									title: "Reply in the same thread",
									method: "POST",
									path: `/conversations/${page.data[0]?.id ?? "<id>"}/reply`,
									body: { text: "Thanks, here it is." },
								},
								{
									title: "Resolve it",
									method: "PATCH",
									path: `/conversations/${page.data[0]?.id ?? "<id>"}`,
									body: { status: "resolved" },
								},
								{
									title: "Received emails, Resend's paths",
									method: "GET",
									path: "/emails/receiving",
								},
							]}
						/>
					</>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<ToggleGroup
					type="single"
					variant="outline"
					value={view}
					className="max-w-full overflow-x-auto"
					onValueChange={(v) =>
						v &&
						to({
							view: v === "open" ? undefined : (v as View),
							status: undefined,
							...(v === "mine" || v === "unassigned" ? { assignee: undefined } : {}),
						})
					}
				>
					<ToggleGroupItem value="open">{counted("open", "Open")}</ToggleGroupItem>
					<ToggleGroupItem value="mine">{counted("mine", "Mine")}</ToggleGroupItem>
					<ToggleGroupItem value="unassigned">
						{counted("unassigned", "Unassigned")}
					</ToggleGroupItem>
					<ToggleGroupItem value="snoozed">
						{counted("snoozed", "Snoozed")}
					</ToggleGroupItem>
					{(page.views.overdue > 0 || view === "overdue") && (
						<ToggleGroupItem value="overdue">
							{counted("overdue", "Overdue")}
						</ToggleGroupItem>
					)}
					{(page.views.held > 0 || view === "held") && (
						<ToggleGroupItem value="held">{counted("held", "Held")}</ToggleGroupItem>
					)}
					<ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
					<ToggleGroupItem value="all">All</ToggleGroupItem>
				</ToggleGroup>
				<ToggleGroup
					type="single"
					variant="outline"
					value={search.unread ? "unread" : ""}
					onValueChange={(v) => to({ unread: v === "unread" ? true : undefined })}
				>
					<ToggleGroupItem value="unread">Unread</ToggleGroupItem>
				</ToggleGroup>
				{page.inboxes.length > 0 && (
					<Select
						value={search.inbox ?? "all"}
						onValueChange={(v) => to({ inbox: v === "all" ? undefined : v })}
					>
						<SelectTrigger
							aria-label="Inbox"
							className="flex-1 sm:w-56 sm:flex-none"
						>
							<SelectValue>
								{search.inbox === "none"
									? "Other addresses"
									: (inboxes.get(search.inbox ?? "")?.name ?? "All inboxes")}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="start">
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
							<SelectSeparator />
							<SelectItem value="none">Other addresses</SelectItem>
						</SelectContent>
					</Select>
				)}
				{(() => {
					// The inbox picked: its settings, workflow and website chat, one click away.
					const picked = inboxes.get(search.inbox ?? "");
					return picked && canAgents ? (
						<InboxMenu
							inbox={picked}
							here="conversations"
						/>
					) : null;
				})()}
				<BrandFilter
					brands={page.brands}
					value={search.brand}
					onChange={(brand) => to({ brand, inbox: undefined })}
				/>
				{page.tags.length > 0 && (
					<Select
						value={search.tag ?? "all"}
						onValueChange={(v) => to({ tag: v === "all" ? undefined : v })}
					>
						<SelectTrigger
							aria-label="Tag"
							className="w-auto min-w-32"
						>
							<SelectValue>
								{search.tag ? (
									<TagChip
										tag={search.tag}
										catalog={page.tags}
									/>
								) : (
									"Any tag"
								)}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="start">
							<SelectItem value="all">Any tag</SelectItem>
							<SelectSeparator />
							{page.tags.map((t) => (
								<SelectItem
									key={t.name}
									value={t.name}
								>
									<TagChip
										tag={t.name}
										catalog={page.tags}
									/>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<Select
					value={search.priority ?? "all"}
					onValueChange={(v) =>
						to({
							priority: v === "all" ? undefined : (v as (typeof PRIORITIES)[number]),
						})
					}
				>
					<SelectTrigger
						aria-label="Priority"
						className="w-auto min-w-32"
					>
						<SelectValue>
							{search.priority ? (
								<PriorityFlag
									priority={search.priority}
									label
								/>
							) : (
								"Any priority"
							)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="start">
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
				{view !== "mine" && view !== "unassigned" && page.people.length > 1 && (
					<Select
						value={search.assignee ?? "all"}
						onValueChange={(v) => to({ assignee: v === "all" ? undefined : v })}
					>
						<SelectTrigger
							aria-label="Assigned to"
							className="w-auto min-w-36"
						>
							<SelectValue>
								{search.assignee
									? (people.get(search.assignee)?.name ?? "Someone")
									: "Anyone's"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="start">
							<SelectItem value="all">Anyone's</SelectItem>
							<SelectSeparator />
							{page.people.map((p) => (
								<SelectItem
									key={p.reader}
									value={p.reader}
								>
									<Avatar
										name={p.name}
										agent={p.type === "agent"}
									/>
									{p.name}
									{p.reader === page.me ? " (you)" : ""}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
				<SearchBox
					value={search.q ?? ""}
					onChange={(q) => to({ q: q || undefined })}
					placeholder="Search senders or subjects"
					className="w-full sm:ml-auto sm:w-64"
				/>
			</div>
			<TableCard>
				<SketchWhile loading={loading && page.data.length > 0}>
					{loading && page.data.length === 0 ? (
						<RowsPending />
					) : page.data.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									{filtered ? <Search /> : <Inbox />}
								</EmptyMedia>
								<EmptyTitle>
									{filtered ? "No conversations match" : "Nothing waiting"}
								</EmptyTitle>
								<EmptyDescription>
									{filtered
										? "Try another filter or search."
										: "Open conversations show here. Turn on receiving on a domain's page (then add its MX record), or give an agent its own inbox."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table className="table-fixed">
							<TableBody>
								{page.data.map((r) => {
									const inbox = r.inbox_id ? inboxes.get(r.inbox_id) : null;
									return (
										<TableRow
											key={r.id}
											className="relative"
										>
											<TableCell className="w-36 py-3 align-top sm:w-56">
												<span className="flex items-center gap-2">
													<span
														className={cn(
															"size-2 shrink-0 rounded-full",
															r.unread
																? "bg-brand"
																: "bg-transparent",
														)}
													>
														{r.unread && (
															<span className="sr-only">Unread</span>
														)}
													</span>
													<Link
														to="/received/$id"
														params={{ id: r.id }}
														title={r.contact}
														className={cn(
															"block truncate outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset",
															r.unread
																? "font-semibold"
																: "font-medium",
														)}
													>
														<Ph>{senderName(r.contact)}</Ph>
													</Link>
													{r.messages > 1 && (
														<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
															<Ph>{r.messages}</Ph>
														</span>
													)}
												</span>
											</TableCell>
											<TableCell className="py-3">
												{/* On phones the badges wrap under the subject instead of squeezing it. */}
												<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
													<PriorityFlag
														priority={r.priority}
														label={false}
													/>
													<span
														className={cn(
															"max-w-full truncate",
															r.unread && "font-semibold",
														)}
													>
														<Ph>{r.subject || "(no subject)"}</Ph>
													</span>
													{r.channel === "chat" && (
														<Badge variant="secondary">
															<MessageCircle />
															Chat
														</Badge>
													)}
													{r.drafts > 0 && (
														<Badge variant="brand">
															<PenLine />
															Draft
														</Badge>
													)}
													{r.replied_by === "agent" && (
														<Badge variant="secondary">
															<Bot />
															Agent replied
														</Badge>
													)}
													{r.status === "resolved" && (
														<Badge variant="outline">Resolved</Badge>
													)}
													{r.held && <StatusBadge status="held" />}
													{r.snoozed_until && (
														<span
															className="inline-flex"
															title={formatDateTime(r.snoozed_until)}
														>
															<StatusBadge
																status="snoozed"
																label={`Back ${formatAgo(r.snoozed_until, now)}`}
															/>
														</span>
													)}
													{r.csat?.rating ? (
														<Stars rating={r.csat.rating} />
													) : null}
													{r.tags.map((t) => (
														<TagChip
															key={t}
															tag={t}
															catalog={page.tags}
														/>
													))}
												</span>
												<span className="mt-0.5 block truncate text-sm text-muted-foreground">
													<Ph>
														{inbox ? `${inbox.name} · ` : ""}
														{names.size > 1 && names.get(r.brand_id)
															? `${names.get(r.brand_id)} · `
															: ""}
														{r.snippet ?? ""}
													</Ph>
												</span>
											</TableCell>
											<TableCell
												className="w-32 py-3 text-right align-top text-muted-foreground tabular-nums"
												title={formatDateTime(r.last_message_at)}
											>
												<span className="flex items-center justify-end gap-2">
													{r.assignee && (
														<span
															title={
																r.assignee.reader === page.me
																	? "You have it"
																	: `${r.assignee.name} has it`
															}
														>
															<Avatar
																name={r.assignee.name}
																agent={r.assignee.type === "agent"}
																className={cn(
																	r.assignee.reader === page.me &&
																		"ring-2 ring-brand/40",
																)}
															/>
														</span>
													)}
													<Ph>{formatAgo(r.last_message_at, now)}</Ph>
												</span>
												<span className="mt-1 flex justify-end">
													<SlaText
														sla={r.sla}
														status={r.status}
													/>
												</span>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}
					{(page.has_more || search.after) && (
						<TablePager
							label={`${page.data.length} ${page.data.length === 1 ? "conversation" : "conversations"}${search.after ? ", older page" : ""}`}
							previousLabel="Newest"
							nextLabel="Older"
							onPrevious={
								search.after
									? () => navigate({ search: { ...search, after: undefined } })
									: undefined
							}
							onNext={
								page.has_more
									? () =>
											navigate({
												search: { ...search, after: page.data.at(-1)?.id },
											})
									: undefined
							}
						/>
					)}
				</SketchWhile>
			</TableCard>
			<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
				<MessagesSquare className="size-4" />
				Messages join a conversation by their Message-ID, In-Reply-To and References
				headers, never by subject. Unread is yours alone; resolved is for everyone.
			</p>
		</Page>
	);
}
