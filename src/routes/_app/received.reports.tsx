import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	CalendarRange,
	Download,
	RotateCcw,
	SlidersHorizontal,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { DatePicker } from "@/components/date-picker";
import { Avatar, PRIORITY, type Priority, TagChip } from "@/components/inbox-triage";
import { DayBars, Delta, TrendChart } from "@/components/metric-charts";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { inboxReportFn } from "@/functions/workflow";
import { downloadCsv } from "@/lib/csv";
import { formatDay, formatNumber, formatPercent } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
import { Ph, Sketch, SketchWhile, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** How the team does with the inboxes: volume, how fast it answers and resolves, the service
 * levels kept, ratings, agents' drafts, the busiest hours, and each inbox, person and tag. The
 * cards can be hidden and reordered; the choice stays in this browser. */
export const Route = createFileRoute("/_app/received/reports")({
	validateSearch: z.object({
		days: z.union([z.literal(7), z.literal(90)]).optional(),
		from: z.string().optional(),
		to: z.string().optional(),
		inbox: z.string().optional(),
		brand: z.string().optional(),
	}),
	loaderDeps: ({ search }) => search,
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) => {
		const span = rangeOf(deps);
		return inboxReportFn({
			data: { from: span.from, to: span.to, inbox: deps.inbox, brand: deps.brand },
		});
	},
	head: () => ({ meta: [{ title: "Inbox report · Mailroom" }] }),
	component: Reports,
	pendingComponent: ReportsSketch,
});

type Data = Awaited<ReturnType<typeof inboxReportFn>>;
type Totals = Data["totals"];

const iso = (d: Date) =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The days asked for: a custom range, or the last 7, 30 or 90. */
function rangeOf(s: { days?: number; from?: string; to?: string }) {
	if (s.from && s.to) return { from: s.from, to: s.to };
	const days = s.days ?? 30;
	const to = new Date();
	const from = new Date(to.getTime() - (days - 1) * 86_400_000);
	return { from: iso(from), to: iso(to) };
}

function ReportsSketch() {
	const empty: Totals = {
		conversations: 0,
		resolved: 0,
		replies: 0,
		replies_by: { agent: 0, agent_approved: 0, person: 0, api: 0 },
		first_response_minutes: { median: null, p90: null, count: 0 },
		resolution_minutes: { median: null, p90: null, count: 0 },
		unanswered: 0,
		sla: { met: 0, missed: 0, rate: null },
		csat: {
			average: null,
			satisfied: null,
			responses: 0,
			sent: 0,
			distribution: [0, 0, 0, 0, 0],
		},
		agent_drafts: { sent_unchanged: 0, edited: 0, discarded: 0 },
	};
	const { from, to } = rangeOf({});
	return (
		<Sketch
			data={
				{
					object: "inbox_report",
					from,
					to,
					days: 30,
					timezone: "UTC",
					inbox: null,
					inboxes: [],
					totals: empty,
					previous: empty,
					now: {
						open: 0,
						unassigned: 0,
						overdue: 0,
						snoozed: 0,
						held: 0,
						waiting: 0,
						oldest_waiting_at: null,
						agent_drafts_waiting: 0,
					},
					series: [],
					heatmap: Array.from({ length: 7 }, () => Array<number>(24).fill(0)),
					by_inbox: [],
					by_assignee: [],
					by_responder: [],
					by_tag: [],
					by_channel: [],
					by_priority: [],
					no_article: [],
					capped: false,
					brands: [],
				} satisfies Data
			}
		>
			<Reports />
		</Sketch>
	);
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Minutes as 12m, 3.5h or 2.1d. */
const duration = (m: number | null | undefined) => {
	if (m === null || m === undefined) return "—";
	if (m < 60) return `${Math.max(1, Math.round(m))}m`;
	if (m < 60 * 24) return `${+(m / 60).toFixed(m < 600 ? 1 : 0)}h`;
	return `${+(m / 1440).toFixed(1)}d`;
};
const pct = (v: number | null | undefined) =>
	v === null || v === undefined ? "—" : formatPercent(v, 0);

// ── Cards, and the layout people pick ──────────────────────────────────────

const CARDS = [
	{ id: "now", label: "Right now" },
	{ id: "kpis", label: "Key numbers" },
	{ id: "volume", label: "Conversations day by day" },
	{ id: "speed", label: "First response day by day" },
	{ id: "replies", label: "Replies: agents and people" },
	{ id: "agents", label: "Agents' drafts" },
	{ id: "csat", label: "Ratings" },
	{ id: "heatmap", label: "Busiest hours" },
	{ id: "team", label: "By teammate" },
	{ id: "inboxes", label: "By inbox" },
	{ id: "tags", label: "By tag" },
	{ id: "priority", label: "By priority and channel" },
	{ id: "articles", label: "Questions with no article" },
] as const;
type CardId = (typeof CARDS)[number]["id"];
type Layout = { order: CardId[]; hidden: CardId[] };
const DEFAULT_LAYOUT: Layout = { order: CARDS.map((c) => c.id), hidden: [] };
const LAYOUT_KEY = "mailroom:inbox-report-layout";

function useLayout() {
	const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
	useEffect(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Layout | null;
			if (!saved) return;
			const known = new Set<string>(DEFAULT_LAYOUT.order);
			const order = saved.order.filter((c) => known.has(c));
			// Cards added since stay, at the end.
			for (const c of DEFAULT_LAYOUT.order) if (!order.includes(c)) order.push(c);
			setLayout({ order, hidden: saved.hidden.filter((c) => known.has(c)) });
		} catch {}
	}, []);
	const save = (next: Layout) => {
		setLayout(next);
		try {
			localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
		} catch {}
	};
	return [layout, save] as const;
}

function Customize({ layout, onChange }: { layout: Layout; onChange: (l: Layout) => void }) {
	const move = (i: number, by: number) => {
		const order = [...layout.order];
		const [x] = order.splice(i, 1);
		if (x) order.splice(i + by, 0, x);
		onChange({ ...layout, order });
	};
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button variant="outline">
					<SlidersHorizontal />
					<span className="hidden sm:inline">Customize</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-72 p-2"
			>
				<p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
					Show the cards you use, in your order. Kept in this browser.
				</p>
				<ul className="flex flex-col">
					{layout.order.map((id, i) => {
						const card = CARDS.find((c) => c.id === id);
						const shown = !layout.hidden.includes(id);
						return (
							<li
								key={id}
								className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted"
							>
								<Checkbox
									id={`card-${id}`}
									checked={shown}
									onCheckedChange={(v) =>
										onChange({
											...layout,
											hidden: v
												? layout.hidden.filter((h) => h !== id)
												: [...layout.hidden, id],
										})
									}
								/>
								<label
									htmlFor={`card-${id}`}
									className={cn(
										"flex-1 text-sm",
										!shown && "text-muted-foreground",
									)}
								>
									{card?.label}
								</label>
								<Button
									size="icon"
									variant="ghost"
									className="size-7"
									aria-label={`Move ${card?.label} up`}
									disabled={i === 0}
									onClick={() => move(i, -1)}
								>
									<ArrowUp />
								</Button>
								<Button
									size="icon"
									variant="ghost"
									className="size-7"
									aria-label={`Move ${card?.label} down`}
									disabled={i === layout.order.length - 1}
									onClick={() => move(i, 1)}
								>
									<ArrowDown />
								</Button>
							</li>
						);
					})}
				</ul>
				<div className="mt-1 border-t pt-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onChange(DEFAULT_LAYOUT)}
					>
						<RotateCcw />
						Reset
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}

// ── The page ───────────────────────────────────────────────────────────────

function Reports() {
	const { data, search: shown } = usePage(Route);
	const pending = usePendingSearch(shown);
	const { search } = pending;
	const navigate = Route.useNavigate();
	const [layout, setLayout] = useLayout();
	const to = (patch: Partial<typeof search>) =>
		navigate({ search: { ...search, ...patch }, replace: true });
	const custom = Boolean(search.from && search.to);
	const days = custom ? "custom" : String(search.days ?? 30);
	const t = data.totals;
	const rows = data.series.map((s) => ({ ...s, first_response: s.first_response ?? undefined }));
	const p = data.previous;
	const cards: Record<CardId, ReactNode> = {
		now: <NowStrip data={data} />,
		kpis: (
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Kpi
					label="Conversations"
					value={formatNumber(t.conversations)}
					delta={
						<Delta
							now={t.conversations}
							before={p.conversations}
							kind="count"
							goodWhen="neutral"
						/>
					}
					sub={`${formatNumber(t.unanswered)} still unanswered`}
				/>
				<Kpi
					label="Resolved"
					value={formatNumber(t.resolved)}
					delta={
						<Delta
							now={t.resolved}
							before={p.resolved}
							kind="count"
						/>
					}
					sub={`median ${duration(t.resolution_minutes.median)} to resolve`}
				/>
				<Kpi
					label="First response"
					value={duration(t.first_response_minutes.median)}
					delta={
						t.first_response_minutes.median !== null &&
						p.first_response_minutes.median ? (
							<Delta
								now={t.first_response_minutes.median}
								before={p.first_response_minutes.median}
								kind="count"
								goodWhen="down"
							/>
						) : null
					}
					sub={`median · 9 in 10 within ${duration(t.first_response_minutes.p90)}`}
				/>
				<Kpi
					label="Service levels met"
					value={pct(t.sla.rate)}
					delta={
						t.sla.rate !== null && p.sla.rate !== null ? (
							<Delta
								now={t.sla.rate}
								before={p.sla.rate}
								kind="rate"
							/>
						) : null
					}
					sub={
						t.sla.met + t.sla.missed
							? `${formatNumber(t.sla.missed)} missed of ${formatNumber(t.sla.met + t.sla.missed)}`
							: data.inboxes.some((i) => i.sla)
								? "None due in this range"
								: "Turn them on in an inbox's workflow"
					}
				/>
				<Kpi
					label="Rating"
					value={t.csat.average === null ? "—" : `${t.csat.average.toFixed(1)} / 5`}
					delta={
						t.csat.average !== null && p.csat.average !== null ? (
							<Delta
								now={t.csat.average}
								before={p.csat.average}
								kind="count"
							/>
						) : null
					}
					sub={
						t.csat.responses
							? `${pct(t.csat.satisfied)} happy · ${t.csat.responses} of ${Math.max(t.csat.sent, t.csat.responses)} answered`
							: t.csat.sent
								? `${t.csat.sent} asked, no answers yet`
								: "Turn the survey on in an inbox's workflow"
					}
				/>
				<Kpi
					label="Replies"
					value={formatNumber(t.replies)}
					delta={
						<Delta
							now={t.replies}
							before={p.replies}
							kind="count"
							goodWhen="neutral"
						/>
					}
					sub={`${t.replies ? pct((t.replies_by.agent + t.replies_by.agent_approved) / t.replies) : "—"} written by agents`}
				/>
				<Kpi
					label="Agents' drafts sent as written"
					value={pct(agentShare(t))}
					delta={
						agentShare(t) !== null && agentShare(p) !== null ? (
							<Delta
								now={agentShare(t) ?? 0}
								before={agentShare(p) ?? 0}
								kind="rate"
							/>
						) : null
					}
					sub={`${formatNumber(t.agent_drafts.edited)} edited, ${formatNumber(t.agent_drafts.discarded)} discarded`}
				/>
				<Kpi
					label="Handled by agents alone"
					value={formatNumber(t.replies_by.agent)}
					sub="replies sent without a person's approval"
				/>
			</div>
		),
		volume: (
			<Section
				title="Conversations day by day"
				description="New conversations, and those resolved each day."
			>
				<Card className="px-4 py-4">
					<DayBars
						data={rows}
						series={[
							{ key: "conversations", label: "New", color: "var(--chart-1)" },
							{ key: "resolved", label: "Resolved", color: "var(--success)" },
						]}
						format={formatNumber}
						footer={null}
						height={200}
					/>
				</Card>
			</Section>
		),
		speed: (
			<Section
				title="First response day by day"
				description="The median time to the first reply of the conversations started each day."
			>
				<Card className="px-4 py-4">
					<TrendChart
						data={data.series.map((s) => ({
							day: s.day,
							value: s.first_response ?? 0,
						}))}
						label="First response"
						color="var(--chart-2)"
						format={(v) => duration(v)}
						formatAxis={(v) => duration(v)}
						height={200}
					/>
				</Card>
			</Section>
		),
		replies: (
			<Section
				title="Replies: agents and people"
				description="Every reply sent, by who wrote it. An agent's draft a person approved counts as the agent's."
			>
				<Card className="px-4 py-4">
					<DayBars
						data={rows}
						series={[
							{ key: "person", label: "People", color: "var(--chart-1)" },
							{ key: "agent", label: "Agents", color: "var(--chart-3)" },
						]}
						format={formatNumber}
						footer={null}
						height={180}
						total={{
							label: "Replies",
							value: (r) => formatNumber(Number(r.person) + Number(r.agent)),
						}}
					/>
				</Card>
			</Section>
		),
		agents: (
			<AgentDrafts
				t={t}
				waiting={data.now.agent_drafts_waiting}
			/>
		),
		csat: <Ratings t={t} />,
		heatmap: (
			<Heatmap
				heat={data.heatmap}
				timezone={data.timezone}
			/>
		),
		team: <Team data={data} />,
		inboxes: <ByInbox data={data} />,
		tags: <ByTag data={data} />,
		priority: <ByPriority data={data} />,
		articles: <NoArticle data={data} />,
	};
	const exportCsv = () =>
		downloadCsv(`inbox-report-${data.from}-${data.to}.csv`, [
			[
				"day",
				"new conversations",
				"resolved",
				"replies by people",
				"replies by agents",
				"first response (min)",
			],
			...data.series.map((s) => [
				s.day,
				s.conversations,
				s.resolved,
				s.person,
				s.agent,
				s.first_response === null ? "" : Math.round(s.first_response),
			]),
		]);
	return (
		<Page>
			<nav
				aria-label="Breadcrumb"
				className="-mb-2 text-sm text-muted-foreground"
			>
				<Link
					to="/received"
					className="rounded-sm transition-colors hover:text-foreground"
				>
					Received
				</Link>
			</nav>
			<PageHeader
				title="Inbox report"
				description={
					<>
						How your team and agents are doing, {formatDay(data.from)} to{" "}
						{formatDay(data.to)}, against the same number of days before. Days and hours
						in {data.timezone}.
					</>
				}
				actions={
					<>
						<Customize
							layout={layout}
							onChange={setLayout}
						/>
						<Button
							variant="outline"
							onClick={exportCsv}
						>
							<Download />
							<span className="hidden sm:inline">CSV</span>
						</Button>
					</>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<ToggleGroup
					type="single"
					variant="outline"
					value={days}
					onValueChange={(v) => {
						if (!v || v === "custom") return;
						to({
							days: v === "30" ? undefined : (Number(v) as 7 | 90),
							from: undefined,
							to: undefined,
						});
					}}
				>
					<ToggleGroupItem value="7">7 days</ToggleGroupItem>
					<ToggleGroupItem value="30">30 days</ToggleGroupItem>
					<ToggleGroupItem value="90">90 days</ToggleGroupItem>
				</ToggleGroup>
				<CustomRange
					from={search.from ?? data.from}
					to={search.to ?? data.to}
					active={custom}
					onChange={(from, until) => to({ from, to: until, days: undefined })}
				/>
				{data.inboxes.length > 0 && (
					<Select
						value={search.inbox ?? "all"}
						onValueChange={(v) => to({ inbox: v === "all" ? undefined : v })}
					>
						<SelectTrigger
							aria-label="Inbox"
							className="w-auto min-w-40"
						>
							<SelectValue>
								{search.inbox === "none"
									? "Other addresses"
									: (data.inboxes.find((i) => i.id === search.inbox)?.name ??
										"All inboxes")}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="start">
							<SelectItem value="all">All inboxes</SelectItem>
							<SelectSeparator />
							{data.inboxes.map((i) => (
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
				<BrandFilter
					brands={data.brands}
					value={search.brand}
					onChange={(brand) => to({ brand, inbox: undefined })}
				/>
			</div>
			{data.capped && (
				<p className="flex items-center gap-2 text-sm text-warning">
					<TriangleAlert className="size-4" />A busy range: some of the oldest activity
					may be left out. Pick fewer days.
				</p>
			)}
			<SketchWhile loading={pending.loading}>
				{layout.order
					.filter((id) => !layout.hidden.includes(id))
					.map((id) => (
						<div key={id}>{cards[id]}</div>
					))}
			</SketchWhile>
		</Page>
	);
}

const agentShare = (t: Totals) => {
	const n = t.agent_drafts.sent_unchanged + t.agent_drafts.edited + t.agent_drafts.discarded;
	return n ? t.agent_drafts.sent_unchanged / n : null;
};

function CustomRange({
	from,
	to,
	active,
	onChange,
}: {
	from: string;
	to: string;
	active: boolean;
	onChange: (from: string, to: string) => void;
}) {
	const [a, setA] = useState(from);
	const [b, setB] = useState(to);
	const today = iso(new Date());
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					className={cn(active && "shadow-[0_0_0_1.5px_var(--brand)]")}
				>
					<CalendarRange />
					{active ? `${formatDay(from)} – ${formatDay(to)}` : "Custom"}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="flex w-auto flex-col gap-3 p-3"
			>
				<div className="grid gap-2 sm:grid-cols-2">
					<DatePicker
						value={a}
						max={b || today}
						onChange={setA}
					/>
					<DatePicker
						value={b}
						min={a}
						max={today}
						onChange={setB}
					/>
				</div>
				<Button
					disabled={!a || !b || a > b}
					onClick={() => onChange(a, b)}
				>
					Show these days
				</Button>
			</PopoverContent>
		</Popover>
	);
}

function Kpi({
	label,
	value,
	delta,
	sub,
}: {
	label: string;
	value: ReactNode;
	delta?: ReactNode;
	sub?: ReactNode;
}) {
	return (
		<Card className="gap-1 px-4 py-3.5">
			<p className="text-[13px] text-muted-foreground">{label}</p>
			<p className="flex items-center gap-2">
				<span className="text-2xl font-semibold tracking-tight tabular-nums">
					<Ph>{value}</Ph>
				</span>
				{delta}
			</p>
			{sub && (
				<p className="truncate text-xs text-faint">
					<Ph>{sub}</Ph>
				</p>
			)}
		</Card>
	);
}

/** What's waiting now, each a link to that view. */
function NowStrip({ data }: { data: Data }) {
	const n = data.now;
	const inbox = data.inbox?.id;
	const items: { label: string; value: ReactNode; view?: string; tone?: string }[] = [
		{ label: "Open", value: formatNumber(n.open) },
		{ label: "Unassigned", value: formatNumber(n.unassigned), view: "unassigned" },
		{
			label: "Waiting on you",
			value: formatNumber(n.waiting),
			tone: n.waiting ? undefined : "text-muted-foreground",
		},
		{
			label: "Overdue",
			value: formatNumber(n.overdue),
			view: "overdue",
			tone: n.overdue ? "text-destructive" : undefined,
		},
		{ label: "Snoozed", value: formatNumber(n.snoozed), view: "snoozed" },
		{
			label: "Held",
			value: formatNumber(n.held),
			view: "held",
			tone: n.held ? "text-warning" : undefined,
		},
		{ label: "Agents' drafts to review", value: formatNumber(n.agent_drafts_waiting) },
	];
	return (
		<Card className="gap-0 px-0 py-0">
			<div className="flex items-center justify-between gap-3 px-5 pt-3.5">
				<h2 className="text-sm font-semibold">Right now</h2>
				{n.oldest_waiting_at && (
					<span className="text-xs text-muted-foreground">
						The longest wait started{" "}
						{duration((Date.now() - Date.parse(n.oldest_waiting_at)) / 60_000)} ago
					</span>
				)}
			</div>
			<dl className="grid grid-cols-2 gap-y-3 px-5 py-3.5 sm:grid-cols-4 lg:grid-cols-7">
				{items.map((x) => {
					const body = (
						<>
							<dt className="text-xs text-faint">{x.label}</dt>
							<dd className={cn("mt-0.5 text-lg font-semibold tabular-nums", x.tone)}>
								<Ph>{x.value}</Ph>
							</dd>
						</>
					);
					return x.view ? (
						<Link
							key={x.label}
							to="/received"
							search={{ view: x.view as "overdue", inbox }}
							className="rounded-md hover:bg-muted/50"
						>
							{body}
						</Link>
					) : (
						<div key={x.label}>{body}</div>
					);
				})}
			</dl>
		</Card>
	);
}

function Bar({ value, max, className }: { value: number; max: number; className?: string }) {
	return (
		<span className="block h-1.5 w-full overflow-hidden rounded-full bg-muted">
			<span
				className={cn("block h-full rounded-full bg-chart-1", className)}
				style={{ width: `${max && value ? Math.max(2, (value / max) * 100) : 0}%` }}
			/>
		</span>
	);
}

function AgentDrafts({ t, waiting }: { t: Totals; waiting: number }) {
	const d = t.agent_drafts;
	const total = d.sent_unchanged + d.edited + d.discarded;
	const rows = [
		{ label: "Sent as the agent wrote it", n: d.sent_unchanged, color: "bg-success" },
		{ label: "Edited by a person, then sent", n: d.edited, color: "bg-chart-3" },
		{ label: "Discarded", n: d.discarded, color: "bg-destructive" },
	];
	return (
		<Section
			title="Agents' drafts"
			description="What people did with the drafts agents wrote for review: how often an agent gets it right. Agents with Send permission don't write drafts."
		>
			<Card className="gap-3 px-5 py-4">
				{total === 0 ? (
					<p className="text-sm text-muted-foreground">
						No agent drafts reviewed in this range.
						{waiting ? ` ${waiting} waiting for review now.` : ""}
					</p>
				) : (
					<>
						<div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
							{rows.map((r) => (
								<span
									key={r.label}
									className={r.color}
									style={{ width: `${(r.n / total) * 100}%` }}
								/>
							))}
						</div>
						<ul className="grid gap-2 text-sm sm:grid-cols-3">
							{rows.map((r) => (
								<li
									key={r.label}
									className="flex items-center gap-2"
								>
									<span className={cn("size-2 rounded-full", r.color)} />
									<span className="flex-1 text-muted-foreground">{r.label}</span>
									<span className="font-medium tabular-nums">
										<Ph>{formatNumber(r.n)}</Ph>
									</span>
									<span className="w-10 text-right text-xs text-faint tabular-nums">
										{pct(r.n / total)}
									</span>
								</li>
							))}
						</ul>
					</>
				)}
			</Card>
		</Section>
	);
}

const FACES = ["😞", "🙁", "😐", "🙂", "😄"];

function Ratings({ t }: { t: Totals }) {
	const max = Math.max(...t.csat.distribution, 1);
	return (
		<Section
			title="Ratings"
			description="What people answered to the survey sent after a conversation was resolved."
		>
			<Card className="gap-2 px-5 py-4">
				{t.csat.responses === 0 ? (
					<p className="text-sm text-muted-foreground">
						{t.csat.sent
							? `${t.csat.sent} surveys sent, none answered yet.`
							: "No ratings in this range. Turn the survey on in an inbox's workflow, under Ratings."}
					</p>
				) : (
					[...t.csat.distribution].reverse().map((n, j) => {
						const i = 4 - j;
						return (
							<div
								key={i}
								className="grid grid-cols-[1.5rem_1fr_3rem] items-center gap-3 text-sm"
							>
								<span className="text-lg leading-none">{FACES[i]}</span>
								<Bar
									value={n}
									max={max}
									className={
										i >= 3
											? "bg-success"
											: i === 2
												? "bg-chart-3"
												: "bg-destructive"
									}
								/>
								<span className="text-right tabular-nums">
									<Ph>{formatNumber(n)}</Ph>
								</span>
							</div>
						);
					})
				)}
			</Card>
		</Section>
	);
}

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Heatmap({ heat, timezone }: { heat: number[][]; timezone: string }) {
	const max = Math.max(1, ...heat.flat());
	// Monday first.
	const rows = [1, 2, 3, 4, 5, 6, 0];
	return (
		<Section
			title="Busiest hours"
			description={`When messages come in, by weekday and hour (${timezone}). Useful for business hours and shifts.`}
		>
			<Card className="overflow-x-auto px-5 py-4">
				<div className="grid min-w-[560px] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-[3px] text-[10px] text-faint">
					<span />
					{Array.from({ length: 24 }, (_, h) => (
						<span
							key={h}
							className="text-center"
						>
							{h % 3 === 0 ? h : ""}
						</span>
					))}
					{rows.map((d) => (
						<Row
							key={d}
							label={WEEK[d] ?? ""}
							line={heat[d] ?? []}
							max={max}
						/>
					))}
				</div>
			</Card>
		</Section>
	);
}

function Row({ label, line, max }: { label: string; line: number[]; max: number }) {
	return (
		<>
			<span className="self-center text-xs">{label}</span>
			{Array.from({ length: 24 }, (_, h) => {
				const n = line[h] ?? 0;
				return (
					<span
						key={h}
						title={`${label} ${h}:00 · ${n} ${n === 1 ? "message" : "messages"}`}
						className="aspect-square rounded-[3px] bg-chart-1"
						style={{ opacity: n ? 0.15 + (n / max) * 0.85 : 0.05 }}
					/>
				);
			})}
		</>
	);
}

/** One table of rows with the same columns: conversations, resolved, first response… */
function Breakdown({
	title,
	description,
	label,
	rows,
	empty,
	extra,
}: {
	title: string;
	description: string;
	label: string;
	rows: {
		key: string;
		name: ReactNode;
		conversations: number;
		resolved: number;
		first_response_median: number | null;
		sla_missed: number;
		csat: number | null;
		extra?: ReactNode;
	}[];
	empty: string;
	extra?: string;
}) {
	const max = Math.max(1, ...rows.map((r) => r.conversations));
	return (
		<Section
			title={title}
			description={description}
		>
			<TableCard>
				{rows.length === 0 ? (
					<p className="px-5 py-8 text-center text-sm text-muted-foreground">{empty}</p>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>{label}</TableHead>
								<TableHead className="w-28 text-right">Conversations</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Resolved
								</TableHead>
								<TableHead className="w-28 text-right">First response</TableHead>
								<TableHead className="hidden w-24 text-right md:table-cell">
									SLA missed
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									Rating
								</TableHead>
								{extra && (
									<TableHead className="hidden w-20 text-right lg:table-cell">
										{extra}
									</TableHead>
								)}
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((r) => (
								<TableRow key={r.key}>
									<TableCell>
										<span className="flex min-w-0 flex-col gap-1.5">
											<span className="truncate">{r.name}</span>
											<Bar
												value={r.conversations}
												max={max}
											/>
										</span>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Ph>{formatNumber(r.conversations)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">
										<Ph>{formatNumber(r.resolved)}</Ph>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Ph>{duration(r.first_response_median)}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden text-right tabular-nums md:table-cell",
											r.sla_missed > 0 && "text-destructive",
										)}
									>
										<Ph>{formatNumber(r.sla_missed)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right tabular-nums md:table-cell">
										<Ph>{r.csat === null ? "—" : r.csat.toFixed(1)}</Ph>
									</TableCell>
									{extra && (
										<TableCell className="hidden text-right tabular-nums lg:table-cell">
											{r.extra}
										</TableCell>
									)}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Section>
	);
}

function Team({ data }: { data: Data }) {
	const replies = new Map(data.by_responder.map((r) => [r.name, r]));
	return (
		<>
			<Breakdown
				title="By teammate"
				description="Conversations by who has them (assigned, or an agent's claim), and how each does. Replies counts what each sent or approved."
				label="Teammate"
				empty="Nobody had conversations assigned in this range. Assign them, or turn on round robin in an inbox's workflow."
				extra="Replies"
				rows={data.by_assignee.map((a) => ({
					...a,
					key: a.reader,
					name: (
						<span className="flex items-center gap-2">
							<Avatar
								name={a.name}
								agent={a.type === "agent"}
							/>
							<Ph>{a.name}</Ph>
						</span>
					),
					extra: <Ph>{formatNumber(replies.get(a.name)?.replies ?? 0)}</Ph>,
				}))}
			/>
			{data.by_responder.length > 0 && (
				<div className="mt-3 flex flex-wrap gap-2 text-sm">
					{data.by_responder.map((r) => (
						<span
							key={`${r.type}-${r.name}`}
							className="inline-flex items-center gap-2 rounded-full bg-muted px-2.5 py-1"
						>
							<Avatar
								name={r.name}
								agent={r.type === "agent"}
							/>
							<Ph>{r.name}</Ph>
							<span className="text-muted-foreground tabular-nums">
								{formatNumber(r.replies)} {r.replies === 1 ? "reply" : "replies"}
								{r.approved ? `, ${r.approved} agent drafts approved` : ""}
							</span>
						</span>
					))}
				</div>
			)}
		</>
	);
}

function ByInbox({ data }: { data: Data }) {
	return (
		<Breakdown
			title="By inbox"
			description="Each agent inbox, and the brand's other addresses."
			label="Inbox"
			empty="No conversations in this range."
			extra="Replies"
			rows={data.by_inbox.map((i) => ({
				...i,
				key: i.id,
				name:
					i.id === "none" ? (
						<span className="text-muted-foreground">{i.name}</span>
					) : (
						<Link
							to="/received/workflow/$id"
							params={{ id: i.id }}
							className="font-medium hover:underline"
						>
							<Ph>{i.name}</Ph>
						</Link>
					),
				extra: <Ph>{formatNumber(i.replies)}</Ph>,
			}))}
		/>
	);
}

function ByTag({ data }: { data: Data }) {
	return (
		<Breakdown
			title="By tag"
			description="Conversations by their tags (one with two tags counts in both)."
			label="Tag"
			empty="No tagged conversations in this range. Tag them by hand, or with an inbox rule."
			rows={data.by_tag.map((x) => ({
				key: x.tag,
				name: (
					<Link
						to="/received"
						search={{ tag: x.tag, view: "all" }}
					>
						<TagChip
							tag={x.tag}
							catalog={[]}
						/>
					</Link>
				),
				...x,
			}))}
		/>
	);
}

function NoArticle({ data }: { data: Data }) {
	return (
		<Card className="gap-3 px-5 py-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-medium">Questions with no article</h2>
					<p className="text-sm text-muted-foreground">
						What people asked the website chat or searched your help center for that no
						published article answered.
					</p>
				</div>
				<Link
					to="/articles"
					className="shrink-0 text-sm text-muted-foreground hover:text-foreground"
				>
					Help center
				</Link>
			</div>
			{data.no_article.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					None in this range. Every question found an article, or nobody asked yet.
				</p>
			) : (
				<ul className="divide-y">
					{data.no_article.map((g) => (
						<li
							key={`${g.brand_id}:${g.question}`}
							className="flex items-center gap-3 py-2 text-sm"
						>
							<span className="min-w-0 flex-1 truncate">“{g.question}”</span>
							<span className="shrink-0 text-muted-foreground tabular-nums">
								{g.times === 1 ? "once" : `${g.times}×`} ·{" "}
								{g.source === "chat" ? "chat" : "search"}
							</span>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

function ByPriority({ data }: { data: Data }) {
	const order = ["urgent", "high", "normal", "low"];
	return (
		<Breakdown
			title="By priority and channel"
			description="Whether urgent ones really are answered first, and email against website chat."
			label="Priority or channel"
			empty="No conversations in this range."
			rows={[
				...[...data.by_priority]
					.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority))
					.map((x) => ({
						key: `p-${x.priority}`,
						name: (
							<span
								className={cn(
									"font-medium",
									PRIORITY[x.priority as Priority]?.text,
								)}
							>
								{PRIORITY[x.priority as Priority]?.label ?? x.priority} priority
							</span>
						),
						...x,
					})),
				...data.by_channel.map((x) => ({
					key: `c-${x.channel}`,
					name: <span>{x.channel === "chat" ? "Website chat" : "Email"}</span>,
					...x,
				})),
			]}
		/>
	);
}
