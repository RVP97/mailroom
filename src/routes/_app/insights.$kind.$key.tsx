import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { type CSSProperties, type ReactNode, useState } from "react";
import { z } from "zod";
import { DayBars, Delta, TrendChart } from "@/components/metric-charts";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getInsightDetail } from "@/functions/insights";
import type { EmailFilterValue } from "@/lib/email-status";
import { formatAgo, formatNumber, formatPercent, formatSeconds } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
import { PROVIDERS, type Provider } from "@/lib/providers";
import {
	Ph,
	PhBox,
	pick,
	rememberedRows,
	Sketch,
	SketchWhile,
	sample,
	usePage,
	useRememberRows,
} from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * One row of Insights up close (a template, a tag or a mailbox provider): its numbers against
 * the period before, day by day, how fast it arrives, where it goes, why some didn't arrive,
 * when people open it and its latest emails. Every count links to the emails behind it.
 */
export const Route = createFileRoute("/_app/insights/$kind/$key")({
	validateSearch: z.object({
		days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
		brand: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({ days: search.days ?? 30, brand: search.brand }),
	loader: ({ params, deps }) =>
		getInsightDetail({
			data: {
				kind: params.kind as "template" | "tag" | "provider",
				key: params.key,
				days: deps.days,
				brand: deps.brand,
			},
		}),
	pendingMs: Number.POSITIVE_INFINITY,
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.title ?? "Insights"} · Insights · Mailroom` }],
	}),
	component: Detail,
	pendingComponent: DetailSketch,
});

type Data = Awaited<ReturnType<typeof getInsightDetail>>;
type Kind = Data["kind"];

const KIND_LABEL: Record<Kind, string> = {
	template: "Templates",
	tag: "Tags",
	provider: "Mailbox providers",
};

const STATS = {
	sent: 1200,
	delivered: 1180,
	bounced: 10,
	complained: 0,
	opened: 500,
	clicked: 90,
	deliveryRate: 0.98,
	bounceRate: 0.008,
	complaintRate: 0,
	openRate: 0.42,
	clickRate: 0.08,
	bounce: "ok" as const,
	complaint: "ok" as const,
	soft_bounced: 2,
};

function DetailSketch() {
	const { params, search } = usePage(Route);
	const kind = (params.kind ?? "template") as Kind;
	const days = Number(search.days ?? 30);
	const day = (i: number) =>
		new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
	return (
		<Sketch
			data={{
				kind,
				key: params.key ?? "",
				title:
					kind === "provider"
						? "Gmail"
						: kind === "tag"
							? "category: receipt"
							: "Welcome",
				alias: null,
				exists: true,
				brands: [],
				brand: null,
				totals: STATS,
				previous: STATS,
				series: sample(days, (i) => ({
					day: day(i),
					sent: 40,
					delivered: 39,
					bounced: 1,
					soft_bounced: 0,
					complained: 0,
					opened: 16,
					clicked: 3,
				})),
				latency: {
					count: 1000,
					median: 4,
					p90: 12,
					p99: 60,
					slowShare: 0.01,
					buckets: ["Under 5 s", "5–15 s", "15–60 s", "1–5 min", "Over 5 min"].map(
						(label, i) => ({
							label,
							count: 100,
							share: [0.6, 0.3, 0.08, 0.02, 0][i] ?? 0,
						}),
					),
					toOpen: { count: 400, median: 1800 },
				},
				byProvider: sample(rememberedRows("insight:providers", 4), (i) => ({
					provider: pick(i, PROVIDERS),
					label: pick(i, ["Gmail", "Outlook", "Yahoo", "iCloud", "Other"]),
					...STATS,
					median: 4,
				})),
				bySender: sample(rememberedRows("insight:senders", 1), (i) => ({
					domain: pick(i, ["mail.example.com", "news.example.com"]),
					...STATS,
				})),
				byTemplate: sample(rememberedRows("insight:templates", 3), (i) => ({
					id: `sketch-${i}`,
					name: pick(i, ["Welcome", "Password reset", "Booking confirmed"]),
					...STATS,
				})),
				notDelivered: sample(rememberedRows("insight:reasons", 1), () => ({
					status: "bounced",
					bounceType: "Permanent",
					count: 10,
				})),
				opensByHour: sample(24, (hour) => ({ hour, opened: 10 })),
				recent: sample(rememberedRows("insight:recent", 6), (i) => ({
					id: `sketch-${i}`,
					to: [pick(i, ["guest@example.com", "maria.lopez@example.com"])],
					subject: pick(i, ["Your booking is confirmed", "Your invoice"]),
					status: "delivered",
					created_at: new Date().toISOString(),
					opened_at: null,
					clicked_at: null,
				})),
			}}
		>
			<Detail />
		</Sketch>
	);
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

const tone = (level: "ok" | "warning" | "danger") =>
	level === "danger"
		? "text-destructive"
		: level === "warning"
			? "text-warning"
			: "text-muted-foreground";

function Detail() {
	const { data, search: shown, params } = usePage(Route);
	const pending = usePendingSearch(shown);
	const { search } = pending;
	const days = Number(search.days ?? 30) as 7 | 30 | 90;
	const navigate = Route.useNavigate();
	const router = useRouter();
	const range = (v: number) => (v === 30 ? undefined : (v as 7 | 90));
	const known = !pending.loading;
	useRememberRows("insight:providers", known ? data.byProvider.length : undefined);
	useRememberRows("insight:senders", known ? data.bySender.length : undefined);
	useRememberRows("insight:templates", known ? data.byTemplate.length : undefined);
	useRememberRows("insight:reasons", known ? data.notDelivered.length : undefined);
	useRememberRows("insight:recent", known ? data.recent.length : undefined);
	const kind = (data.kind ?? params.kind) as Kind;
	const key = (data.key ?? params.key) as string;
	const t = data.totals;
	const p = data.previous;
	// Nothing to compare rates with when the period before sent nothing.
	const compare = p.sent > 0;

	/** The emails behind a number: this template, tag or provider, plus a status or day. */
	const emails = (more: { status?: EmailFilterValue; day?: string } = {}) => ({
		...(kind === "template"
			? { template: key }
			: kind === "tag"
				? { tag: key }
				: { provider: key as Provider }),
		days: more.day ? undefined : days,
		brand: data.brand ?? undefined,
		...more,
	});
	const openEmails = (more: { status?: EmailFilterValue; day?: string }) =>
		navigate({ to: "/emails", search: emails(more) });

	return (
		<Page>
			<PageHeader
				crumbs={[
					{
						label: "Insights",
						to: "/insights",
						search: { days: search.days, brand: search.brand },
					},
					{
						label: KIND_LABEL[kind],
						to: "/insights",
						search: { days: search.days, brand: search.brand },
					},
				]}
				title={
					<span className={cn("block truncate", kind === "tag" && "font-mono text-xl")}>
						<Ph>{data.title}</Ph>
					</span>
				}
				description={
					kind === "template"
						? "Every email made from this template: API, automations and broadcasts."
						: kind === "tag"
							? "Every email your app sent with this tag."
							: "Every email to this provider's addresses (by the recipient's domain)."
				}
				actions={
					<>
						{kind === "template" && data.exists && (
							<Button
								variant="outline"
								size="sm"
								asChild
							>
								<Link
									to="/templates/$id"
									params={{ id: key }}
								>
									Open template
								</Link>
							</Button>
						)}
						<Button
							variant="outline"
							size="sm"
							asChild
						>
							<Link
								to="/emails"
								search={emails()}
							>
								See the emails
								<ArrowUpRight />
							</Link>
						</Button>
						<ToggleGroup
							type="single"
							variant="outline"
							value={String(days)}
							onValueChange={(v) =>
								v &&
								navigate({
									search: { ...search, days: range(Number(v)) },
									replace: true,
									resetScroll: false,
								})
							}
						>
							{[7, 30, 90].map((v) => (
								<ToggleGroupItem
									key={v}
									value={String(v)}
									onPointerEnter={() =>
										void router
											.preloadRoute({
												to: "/insights/$kind/$key",
												params: { kind, key },
												search: { ...search, days: range(v) },
											})
											.catch(() => {})
									}
								>
									{v} days
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</>
				}
			/>
			<SketchWhile loading={pending.loading}>
				<Card className="gap-0 overflow-hidden p-0">
					<div className="grid grid-cols-2 gap-px bg-border/70 sm:grid-cols-3 lg:grid-cols-6">
						<Kpi
							label="Sent"
							value={formatNumber(t.sent)}
							delta={
								<Delta
									now={t.sent}
									before={p.sent}
									kind="count"
									goodWhen="neutral"
								/>
							}
							to={emails()}
						/>
						<Kpi
							label="Delivered"
							value={formatPercent(t.deliveryRate, 1)}
							sub={formatNumber(t.delivered)}
							delta={
								compare && (
									<Delta
										now={t.deliveryRate}
										before={p.deliveryRate}
										kind="rate"
									/>
								)
							}
							to={emails({ status: "delivered" })}
						/>
						<Kpi
							label="Bounced"
							value={formatPercent(t.bounceRate, 2)}
							sub={formatNumber(t.bounced)}
							className={tone(t.bounce)}
							delta={
								compare && (
									<Delta
										now={t.bounceRate}
										before={p.bounceRate}
										kind="rate"
										goodWhen="down"
									/>
								)
							}
							to={emails({ status: "bounced" })}
						/>
						<Kpi
							label="Spam reports"
							value={formatPercent(t.complaintRate, 3)}
							sub={formatNumber(t.complained)}
							className={tone(t.complaint)}
							delta={
								compare && (
									<Delta
										now={t.complaintRate}
										before={p.complaintRate}
										kind="rate"
										goodWhen="down"
									/>
								)
							}
							to={emails({ status: "complained" })}
						/>
						<Kpi
							label="Opened"
							value={formatPercent(t.openRate, 1)}
							sub={formatNumber(t.opened)}
							delta={
								compare && (
									<Delta
										now={t.openRate}
										before={p.openRate}
										kind="rate"
									/>
								)
							}
							to={emails({ status: "opened" })}
						/>
						<Kpi
							label="Clicked"
							value={formatPercent(t.clickRate, 1)}
							sub={formatNumber(t.clicked)}
							delta={
								compare && (
									<Delta
										now={t.clickRate}
										before={p.clickRate}
										kind="rate"
									/>
								)
							}
							to={emails({ status: "clicked" })}
						/>
					</div>
				</Card>
				<div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
					<ChartCard
						title="Volume"
						hint="Delivered and not, day by day. Click a day to see its emails."
						legend={VOLUME}
					>
						<DayBars
							data={data.series.map((d) => ({
								...d,
								other: Math.max(
									0,
									d.sent - d.delivered - d.bounced - d.soft_bounced,
								),
							}))}
							series={VOLUME}
							format={formatNumber}
							height={200}
							total={{
								label: "Sent",
								value: (r) => formatNumber(Number(r.sent) || 0),
							}}
							onPick={(day, k) =>
								openEmails({
									day,
									status:
										k === "other"
											? "sent"
											: ((k as EmailFilterValue | null) ?? undefined),
								})
							}
						/>
					</ChartCard>
					<ChartCard
						title="Opens"
						hint="Delivered emails opened, day by day. A lower bound: some apps block the pixel, and Apple Mail opens emails on its own."
						legend={[
							{
								key: "opened",
								label: `Open rate ${formatPercent(t.openRate, 1)}`,
								color: "var(--chart-1)",
							},
						]}
					>
						<TrendChart
							data={data.series.map((d) => ({
								day: d.day,
								value: Math.min(1, ratio(d.opened, d.delivered)),
								sub: `${formatNumber(d.opened)} of ${formatNumber(d.delivered)}`,
							}))}
							label="Opened"
							fraction
							color="var(--chart-1)"
							format={(v) => formatPercent(v, 1)}
							formatAxis={(v) => formatPercent(v, 0)}
							height={200}
							onPick={(day) => openEmails({ day, status: "opened" })}
						/>
					</ChartCard>
				</div>
				<div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
					<Speed latency={data.latency} />
					<OpenHours
						hours={data.opensByHour}
						toOpen={data.latency.toOpen}
					/>
				</div>
				{kind !== "provider" && (
					<Section
						title="By mailbox provider"
						description="Where these emails went (by the first recipient), how they did there, and how long each took to arrive."
					>
						<Breakdown
							label="Provider"
							empty="Nothing sent in this range."
							extra={{ label: "Typical", value: (r) => formatSeconds(r.median) }}
							rows={data.byProvider.map((r) => ({
								key: r.provider,
								stats: r,
								median: r.median,
								name: (
									<Link
										to="/insights/$kind/$key"
										params={{ kind: "provider", key: r.provider }}
										search={{ days: search.days, brand: search.brand }}
										className="font-medium hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
									>
										<Ph>{r.label}</Ph>
									</Link>
								),
							}))}
						/>
					</Section>
				)}
				{kind !== "template" && data.byTemplate.length > 0 && (
					<Section
						title="By template"
						description="The templates behind these emails."
					>
						<Breakdown
							label="Template"
							empty=""
							rows={data.byTemplate.map((r) => ({
								key: r.id,
								stats: r,
								name: (
									<Link
										to="/insights/$kind/$key"
										params={{ kind: "template", key: r.id }}
										search={{ days: search.days, brand: search.brand }}
										className="font-medium hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
									>
										<Ph>{r.name}</Ph>
									</Link>
								),
							}))}
						/>
					</Section>
				)}
				{data.bySender.length > 1 && (
					<Section
						title="By sending domain"
						description="The From domains these emails went out from."
					>
						<Breakdown
							label="Domain"
							empty=""
							rows={data.bySender.map((r) => ({
								key: r.domain,
								stats: r,
								name: (
									<Link
										to="/emails"
										search={{ ...emails(), domain: r.domain }}
										className="font-mono text-[13px] hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
									>
										<Ph>{r.domain}</Ph>
									</Link>
								),
							}))}
						/>
					</Section>
				)}
				<div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
					<NotDelivered
						rows={data.notDelivered}
						sent={t.sent}
						emails={emails}
					/>
					<Recent rows={data.recent} />
				</div>
			</SketchWhile>
		</Page>
	);
}

const VOLUME = [
	{ key: "delivered", label: "Delivered", color: "var(--success)" },
	{ key: "other", label: "Waiting", color: "var(--chart-1)" },
	{ key: "soft_bounced", label: "Soft bounced", color: "var(--warning)" },
	{ key: "bounced", label: "Bounced", color: "var(--destructive)" },
];

type EmailsSearch = Record<string, string | number | undefined>;

function Kpi({
	label,
	value,
	sub,
	delta,
	className,
	to,
}: {
	label: string;
	value: string;
	sub?: string;
	delta: ReactNode;
	className?: string;
	to: EmailsSearch;
}) {
	return (
		<Link
			to="/emails"
			search={to}
			className="group flex min-w-0 flex-col gap-1 bg-card px-4 py-3.5 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 sm:px-5"
		>
			<span className="flex items-center justify-between text-[13px] text-muted-foreground">
				{label}
				<ChevronRight className="size-3.5 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
			</span>
			<span
				className={cn(
					"text-[22px] leading-8 font-semibold tracking-[-0.022em] text-foreground tabular-nums",
					className !== "text-muted-foreground" && className,
				)}
			>
				<Ph>{value}</Ph>
			</span>
			<span className="flex h-5 items-center gap-1.5 text-xs text-faint tabular-nums">
				{sub && <Ph>{sub}</Ph>}
				<Ph>{delta}</Ph>
			</span>
		</Link>
	);
}

function ChartCard({
	title,
	hint,
	legend,
	children,
}: {
	title: string;
	hint: string;
	legend: { key: string; label: string; color: string }[];
	children: ReactNode;
}) {
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4">
				<p className="font-medium">{title}</p>
				<p className="text-sm text-muted-foreground">{hint}</p>
			</div>
			<div className="px-2 pt-4 pb-2 sm:px-3">
				<PhBox>{children}</PhBox>
			</div>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
				{legend.map((s) => (
					<span
						key={s.key}
						className="flex items-center gap-1.5"
					>
						<span
							className="size-2 rounded-[3px]"
							style={{ background: s.color }}
						/>
						<Ph>{s.label}</Ph>
					</span>
				))}
			</div>
		</Card>
	);
}

/** Time to inbox: the usual, the slow ones, and how it spreads. */
function Speed({ latency: l }: { latency: Data["latency"] }) {
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4">
				<p className="font-medium">Time to inbox</p>
				<p className="text-sm text-muted-foreground">
					From SES taking the email to the recipient's server accepting it, over the
					latest <Ph>{formatNumber(l.count)}</Ph> delivered (broadcasts aside).
				</p>
			</div>
			{l.count === 0 ? (
				<p className="px-5 py-10 text-center text-sm text-muted-foreground">
					No delivered emails in this range.
				</p>
			) : (
				<>
					<dl className="grid grid-cols-2 gap-3 px-5 pt-4 pb-1 sm:grid-cols-4">
						<Figure label="Typical">{formatSeconds(l.median)}</Figure>
						<Figure label="1 in 10">{formatSeconds(l.p90)}</Figure>
						<Figure label="1 in 100">{formatSeconds(l.p99)}</Figure>
						<Figure
							label="Over a minute"
							className={l.slowShare > 0.1 ? "text-warning" : undefined}
						>
							{formatPercent(l.slowShare, 1)}
						</Figure>
					</dl>
					<ul className="grid gap-2 px-5 pt-3 pb-4">
						{l.buckets.map((b, i) => (
							<Tooltip key={b.label}>
								<TooltipTrigger asChild>
									<li className="grid grid-cols-[5.5rem_1fr_3.5rem] items-center gap-3 rounded-sm text-sm">
										<span className="text-muted-foreground">{b.label}</span>
										<span className="h-2 overflow-hidden rounded-full bg-muted">
											<span
												data-ph
												className="block h-full rounded-full transition-[width] duration-500 ease-out"
												style={{
													width: `${Math.max(b.share > 0 ? 2 : 0, b.share * 100)}%`,
													background:
														i < 2
															? "var(--success)"
															: i === 2
																? "var(--chart-1)"
																: i === 3
																	? "var(--warning)"
																	: "var(--destructive)",
												}}
											/>
										</span>
										<span className="text-right tabular-nums">
											<Ph>
												{formatPercent(
													b.share,
													b.share > 0 && b.share < 0.01 ? 1 : 0,
												)}
											</Ph>
										</span>
									</li>
								</TooltipTrigger>
								<TooltipContent>
									{formatNumber(b.count)} of {formatNumber(l.count)} emails took{" "}
									{b.label.replace("Under", "under").replace("Over", "over")}
								</TooltipContent>
							</Tooltip>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

/** When people open these emails, by the hour of the day (in the account's time zone). */
function OpenHours({
	hours,
	toOpen,
}: {
	hours: Data["opensByHour"];
	toOpen: Data["latency"]["toOpen"];
}) {
	const max = Math.max(1, ...hours.map((h) => h.opened));
	const total = hours.reduce((s, h) => s + h.opened, 0);
	const peak = hours.reduce(
		(a, b) => (b.opened > a.opened ? b : a),
		hours[0] ?? { hour: 0, opened: 0 },
	);
	const hour = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "am" : "pm"}`;
	const [active, setActive] = useState<number | null>(null);
	const shown = active === null ? null : hours[active];
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4">
				<p className="font-medium">When people open them</p>
				<p className="text-sm text-muted-foreground">
					First opens by the hour of the day. Good for timing reminders and broadcasts.
				</p>
			</div>
			{total === 0 ? (
				<p className="px-5 py-10 text-center text-sm text-muted-foreground">
					No opens in this range.
				</p>
			) : (
				<>
					<dl className="grid grid-cols-2 gap-3 px-5 pt-4">
						<Figure label="Busiest hour">{`${hour(peak.hour)}–${hour((peak.hour + 1) % 24)}`}</Figure>
						<Figure label="Typical time to open">{formatSeconds(toOpen.median)}</Figure>
					</dl>
					<div className="px-5 pt-4 pb-4">
						<div
							className="relative flex h-28 items-end gap-[3px]"
							onMouseLeave={() => setActive(null)}
						>
							{shown && active !== null && (
								<div
									role="tooltip"
									className="pointer-events-none absolute bottom-full z-10 mb-2 min-w-44 -translate-x-1/2 overflow-hidden rounded-lg bg-popover text-xs text-popover-foreground shadow-[0_0_0_1px_var(--border-strong),0_8px_24px_-6px_var(--shadow-color-strong)]"
									style={{
										// Kept inside the card at both ends.
										left: `clamp(5.5rem, ${((active + 0.5) / 24) * 100}%, calc(100% - 5.5rem))`,
									}}
								>
									<p className="border-b border-border/70 px-3 py-2 font-medium">
										{hour(shown.hour)}–{hour((shown.hour + 1) % 24)}
									</p>
									<div className="grid gap-1.5 px-3 py-2">
										<p className="flex items-center justify-between gap-4">
											<span className="flex items-center gap-2 text-muted-foreground">
												<span className="size-2.5 rounded-[3px] bg-chart-1" />
												First opens
											</span>
											<span className="font-medium tabular-nums">
												{formatNumber(shown.opened)}
											</span>
										</p>
										<p className="flex items-center justify-between gap-4">
											<span className="text-muted-foreground">
												Of all opens
											</span>
											<span className="font-medium tabular-nums">
												{formatPercent(ratio(shown.opened, total), 1)}
											</span>
										</p>
										{shown.hour === peak.hour && (
											<p className="text-faint">The busiest hour</p>
										)}
									</div>
								</div>
							)}
							{hours.map((h, i) => (
								<div
									key={h.hour}
									className="relative flex h-full flex-1 items-end transition-opacity duration-150"
									style={{ opacity: active === null || active === i ? 1 : 0.4 }}
									onMouseEnter={() => setActive(i)}
									aria-label={`${hour(h.hour)}: ${formatNumber(h.opened)} first opens`}
								>
									{/*
										The whole column's box never moves as data loads; the bar is its
										::after, rounded at the top like the other charts' bars.
									*/}
									<span
										data-ph
										className="relative block h-full w-full after:absolute after:inset-x-0 after:bottom-0 after:h-(--bar) after:rounded-[3px] after:bg-(--fill) after:transition-[height,background-color] after:duration-300 after:ease-out"
										style={
											{
												"--bar": `${Math.max(h.opened ? 4 : 1, (h.opened / max) * 100)}%`,
												"--fill":
													h.hour === peak.hour || active === i
														? "var(--chart-1)"
														: "color-mix(in oklch, var(--chart-1) 45%, transparent)",
											} as CSSProperties
										}
									/>
								</div>
							))}
						</div>
						<div className="mt-1.5 flex justify-between text-[11px] text-faint">
							<span>12 am</span>
							<span>6 am</span>
							<span>12 pm</span>
							<span>6 pm</span>
							<span>11 pm</span>
						</div>
					</div>
				</>
			)}
		</Card>
	);
}

function Figure({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className="min-w-0">
			<dt className="text-xs text-faint">{label}</dt>
			<dd className={cn("mt-0.5 truncate text-lg font-semibold tabular-nums", className)}>
				<Ph>{children}</Ph>
			</dd>
		</div>
	);
}

type BreakdownStats = Omit<Data["byTemplate"][number], "id" | "name">;

function Breakdown<
	R extends { key: string; name: ReactNode; stats: BreakdownStats; median?: number | null },
>({
	label,
	rows,
	empty,
	extra,
}: {
	label: string;
	rows: R[];
	empty: string;
	extra?: { label: string; value: (r: R) => string };
}) {
	const most = Math.max(1, ...rows.map((r) => r.stats.sent));
	return (
		<TableCard>
			{rows.length === 0 ? (
				<p className="px-5 py-8 text-center text-sm text-muted-foreground">{empty}</p>
			) : (
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>{label}</TableHead>
							<TableHead className="w-28 text-right">Sent</TableHead>
							<TableHead className="hidden w-24 text-right sm:table-cell">
								Delivered
							</TableHead>
							<TableHead className="w-24 text-right">Bounced</TableHead>
							<TableHead className="hidden w-24 text-right md:table-cell">
								Spam
							</TableHead>
							<TableHead className="hidden w-24 text-right sm:table-cell">
								Opened
							</TableHead>
							<TableHead className="hidden w-24 text-right lg:table-cell">
								Clicked
							</TableHead>
							{extra && (
								<TableHead className="hidden w-24 text-right md:table-cell">
									{extra.label}
								</TableHead>
							)}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r) => {
							const s = r.stats;
							return (
								<TableRow
									key={r.key}
									className="relative"
								>
									<TableCell className="truncate">{r.name}</TableCell>
									<TableCell className="text-right tabular-nums">
										<span className="flex items-center justify-end gap-2">
											<span className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-muted sm:block">
												<span
													data-ph
													className="block h-full rounded-full bg-chart-1"
													style={{ width: `${(s.sent / most) * 100}%` }}
												/>
											</span>
											<Ph>{formatNumber(s.sent)}</Ph>
										</span>
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">
										<Ph>{formatPercent(s.deliveryRate, 1)}</Ph>
									</TableCell>
									<TableCell
										className={cn("text-right tabular-nums", tone(s.bounce))}
									>
										<Ph>{formatPercent(s.bounceRate, 1)}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden text-right tabular-nums md:table-cell",
											tone(s.complaint),
										)}
									>
										<Ph>{formatPercent(s.complaintRate, 2)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
										<Ph>{formatPercent(s.openRate, 1)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums lg:table-cell">
										<Ph>{formatPercent(s.clickRate, 1)}</Ph>
									</TableCell>
									{extra && (
										<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
											<Ph>{extra.value(r)}</Ph>
										</TableCell>
									)}
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</TableCard>
	);
}

const REASON: Record<string, string> = {
	bounced: "Bounced",
	soft_bounced: "Soft bounced",
	failed: "Failed",
	delivery_delayed: "Still delayed",
};

/** What a status means when SES gave no bounce type. */
const STATUS_DETAIL: Record<string, string> = {
	bounced: "the recipient's server refused it",
	soft_bounced: "SES gave up after retrying",
	failed: "SES didn't accept it",
	delivery_delayed: "the recipient's server asked to try later",
};

const BOUNCE_TYPE: Record<string, string> = {
	Permanent: "the address doesn't exist or refuses mail",
	Transient: "a full, down or refusing server",
	Undetermined: "the server didn't say why",
};

/** Why some didn't arrive: each status and SES's bounce type, a link to those emails. */
function NotDelivered({
	rows,
	sent,
	emails,
}: {
	rows: Data["notDelivered"];
	sent: number;
	emails: (more: { status?: EmailFilterValue }) => EmailsSearch;
}) {
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4 pb-3">
				<p className="font-medium">Why some didn't arrive</p>
				<p className="text-sm text-muted-foreground">
					Bounces, failures and delays, most first.
				</p>
			</div>
			{rows.length === 0 ? (
				<p className="border-t border-border/70 px-5 py-10 text-center text-sm text-muted-foreground">
					Everything sent in this range arrived.
				</p>
			) : (
				<ul className="border-t border-border/70">
					{rows.map((r) => (
						<li key={`${r.status}:${r.bounceType}`}>
							<Link
								to="/emails"
								search={emails({ status: r.status as EmailFilterValue })}
								className="group flex items-center gap-3 border-b border-border/70 px-5 py-2.5 text-sm outline-none transition-colors last:border-0 hover:bg-accent/50"
							>
								<StatusBadge
									status={r.status}
									label={REASON[r.status] ?? r.status}
								/>
								<span className="min-w-0 flex-1 truncate text-muted-foreground max-sm:invisible">
									<Ph>
										{(r.bounceType && BOUNCE_TYPE[r.bounceType]) ??
											r.bounceType ??
											STATUS_DETAIL[r.status] ??
											""}
									</Ph>
								</span>
								<span className="w-12 text-right tabular-nums">
									<Ph>{formatNumber(r.count)}</Ph>
								</span>
								<span className="w-14 text-right text-muted-foreground tabular-nums">
									<Ph>{formatPercent(ratio(r.count, sent), 1)}</Ph>
								</span>
								<ChevronRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
							</Link>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

function Recent({ rows }: { rows: Data["recent"] }) {
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4 pb-3">
				<p className="font-medium">Latest emails</p>
				<p className="text-sm text-muted-foreground">
					The newest ones, with where each stands.
				</p>
			</div>
			{rows.length === 0 ? (
				<p className="border-t border-border/70 px-5 py-10 text-center text-sm text-muted-foreground">
					None in this range.
				</p>
			) : (
				<ul className="border-t border-border/70">
					{rows.map((r) => (
						<li key={r.id}>
							<Link
								to="/emails/$id"
								params={{ id: r.id }}
								className="group flex items-center gap-3 border-b border-border/70 px-5 py-2.5 text-sm outline-none transition-colors last:border-0 hover:bg-accent/50"
							>
								<span className="flex min-w-0 flex-1 items-baseline gap-2">
									<span className="min-w-0 truncate font-medium sm:shrink-0">
										<Ph>{r.to?.[0] ?? ""}</Ph>
									</span>
									<span className="hidden min-w-0 truncate text-muted-foreground sm:block">
										<Ph>{r.subject}</Ph>
									</span>
								</span>
								<StatusBadge
									status={
										r.clicked_at ? "clicked" : r.opened_at ? "opened" : r.status
									}
								/>
								<span className="hidden w-16 text-right text-xs text-faint tabular-nums sm:block">
									<Ph>{formatAgo(r.created_at)}</Ph>
								</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}
