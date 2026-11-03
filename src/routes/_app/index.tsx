import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowRight, Check, ChevronRight, CircleHelp, Globe } from "lucide-react";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { DayBars, Delta, type Series, TrendChart } from "@/components/metric-charts";
import { OrgAvatar } from "@/components/org-avatar";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getOverview } from "@/functions/emails";
import { type EmailFilterValue, STATUS_INFO } from "@/lib/email-status";
import { formatNumber, formatPercent } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
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

const METRICS = ["sent", "delivered", "opened", "clicked", "not_delivered"] as const;
type Metric = (typeof METRICS)[number];

export const Route = createFileRoute("/_app/")({
	validateSearch: z.object({
		days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
		/** One brand; without it, every brand of the organization. */
		brand: z.string().optional(),
		/** One sending domain; without it, all of them. */
		domain: z.string().optional(),
		/** What the big chart shows. */
		metric: z.enum(METRICS).optional(),
	}),
	loaderDeps: ({ search }) => ({
		days: search.days ?? 30,
		brand: search.brand,
		domain: search.domain,
	}),
	loader: ({ deps }) =>
		getOverview({ data: { days: deps.days, brand: deps.brand, domain: deps.domain } }),
	// Another range keeps the page up: only what depends on it turns into skeletons.
	pendingMs: Number.POSITIVE_INFINITY,
	head: () => ({ meta: [{ title: "Overview · Mailroom" }] }),
	component: Overview,
	pendingComponent: OverviewSketch,
});

/** A typical range: what the page draws while the real one loads (numbers as placeholders). */
function OverviewSketch() {
	const { search } = usePage(Route);
	const days = search.days ?? 30;
	const totals = {
		sent: 12000,
		delivered: 11760,
		bounced: 120,
		soft_bounced: 40,
		complained: 0,
		opened: 4800,
		clicked: 960,
		failed: 20,
		delayed: 10,
		suppressed: 60,
	};
	const day = (i: number) =>
		new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
	// Where setup stood last time (sending ready 1, a domain 2, verified 4): the same card, or none.
	const setup = rememberedRows("overview:setup", 7, 7);
	return (
		<Sketch
			data={{
				totals,
				previous: totals,
				previousSeries: sample(days, (i) => ({
					day: day(i - days),
					...Object.fromEntries(
						Object.entries(totals).map(([k, v]) => [k, Math.round(v / days)]),
					),
				})),
				series: sample(days, (i) => ({
					day: day(i),
					...Object.fromEntries(
						Object.entries(totals).map(([k, v]) => [k, Math.round(v / days)]),
					),
				})),
				week: {
					health: {
						bounceRate: 0.01,
						bounce: "ok",
						complaintRate: 0.0003,
						complaint: "ok",
					},
				},
				sending: { status: setup & 1 ? "ready" : "not_set_up" },
				domains:
					setup & 2
						? [{ status: setup & 4 ? "verified" : "pending", name: "mail.example.com" }]
						: [],
				brands: sample(rememberedRows("overview:brands", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
				})),
				brand: search.brand ?? null,
				domain: search.domain ?? null,
				byProvider: sample(rememberedRows("overview:providers", 4), (i) => ({
					provider: pick(i, ["gmail", "outlook", "yahoo", "icloud", "other"]),
					sent: 3000 - i * 500,
					deliveryRate: 0.98,
					openRate: 0.4,
					bounceRate: 0.01,
					bounce: "ok",
				})),
				byDomain: sample(rememberedRows("overview:domains", 1), (i) => ({
					domain: pick(i, ["mail.example.com", "news.example.com"]),
					...totals,
				})),
				byBrand: sample(rememberedRows("overview:byBrand", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
					sent: 1000,
					delivered: 980,
					bounceRate: 0.01,
					complaintRate: 0.0001,
					bounce: "ok",
					complaint: "ok",
				})),
			}}
		>
			<Overview />
		</Sketch>
	);
}

type Data = Awaited<ReturnType<typeof getOverview>>;
type Totals = Data["totals"];
type Day = Data["series"][number];

/** SES's thresholds: it reviews the account at the first and may pause it at the second. */
const LIMITS = {
	bounce: { warning: 0.05, danger: 0.1 },
	complaint: { warning: 0.001, danger: 0.005 },
};

/** The four ways an email ends up not delivered, each with its colour, worst first. */
const NOT_DELIVERED: Series[] = [
	{ key: "bounced", label: "Bounced", color: "var(--destructive)" },
	{ key: "soft_bounced", label: "Soft bounced", color: "var(--warning)" },
	{ key: "failed", label: "Failed", color: "var(--failed)" },
	{ key: "suppressed", label: "Suppressed", color: "var(--faint)" },
];

const notDelivered = (t: Omit<Totals, never>) =>
	t.bounced + t.soft_bounced + t.failed + t.suppressed;
/** Everything Mailroom tried to send: what SES took plus what never got that far. */
const attempted = (t: Totals) => t.sent + t.failed + t.suppressed;
const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

/** Where a number leads: the Emails list with the same brand, domain and range, plus a filter. */
type EmailsSearch = {
	status?: EmailFilterValue;
	day?: string;
	provider?: Provider;
	domain?: string;
};

/** The Emails list's search a number links to. */
type EmailsLink = {
	brand?: string;
	domain?: string;
	days?: number;
	status?: EmailFilterValue;
	day?: string;
	provider?: Provider;
};

function Overview() {
	const { data, search: shown } = usePage(Route);
	const pending = usePendingSearch(shown);
	const { search } = pending;
	const days = Number(search.days ?? 30) as 7 | 30 | 90;
	const navigate = Route.useNavigate();
	const router = useRouter();
	const range = (v: number) => (v === 30 ? undefined : (v as 7 | 90));
	const t = data.totals;
	const setupDone =
		data.sending?.status === "ready" && data.domains.some((d) => d.status === "verified");
	/** The Emails list's search for a number on this page. */
	const emails = (s: EmailsSearch): EmailsLink => ({
		brand: data.brand ?? undefined,
		domain: s.domain ?? data.domain ?? undefined,
		// A day is its own range.
		days: s.day ? undefined : days,
		status: s.status,
		day: s.day,
		provider: s.provider,
	});
	const open = (s: EmailsSearch) => navigate({ to: "/emails", search: emails(s) });
	const domainNames = [
		...new Set([...data.byDomain.map((d) => d.domain), ...data.domains.map((d) => d.name)]),
	].sort();
	const setupKnown = !pending.loading;
	useRememberRows(
		"overview:setup",
		setupKnown
			? (data.sending?.status === "ready" ? 1 : 0) +
					(data.domains.length > 0 ? 2 : 0) +
					(data.domains.some((d) => d.status === "verified") ? 4 : 0)
			: undefined,
	);
	useRememberRows("overview:brands", data.brands.length);
	useRememberRows(
		"overview:providers",
		setupKnown ? data.byProvider.filter((p) => p.sent > 0).length : undefined,
	);
	useRememberRows("overview:domains", setupKnown ? data.byDomain.length : undefined);
	useRememberRows("overview:byBrand", setupKnown ? data.byBrand.length : undefined);
	return (
		<Page>
			<PageHeader
				title="Overview"
				description={
					data.brands.length > 0 && !data.brand
						? "How every brand's emails did, added up. Click any number or day to see its emails."
						: "How your emails did. Click any number or day to see its emails."
				}
				actions={
					<>
						<BrandFilter
							brands={data.brands}
							value={search.brand}
							onChange={(brand) =>
								navigate({
									search: { ...search, brand, domain: undefined },
									replace: true,
								})
							}
						/>
						{domainNames.length > 1 && (
							<Select
								value={search.domain ?? "all"}
								onValueChange={(v) =>
									navigate({
										search: { ...search, domain: v === "all" ? undefined : v },
										replace: true,
									})
								}
							>
								<SelectTrigger
									aria-label="Sending domain"
									className="flex-1 sm:w-52 sm:flex-none"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="all">All domains</SelectItem>
									<SelectSeparator />
									{domainNames.map((d) => (
										<SelectItem
											key={d}
											value={d}
										>
											<Globe className="text-muted-foreground" />
											{d}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
						<ToggleGroup
							type="single"
							variant="outline"
							value={String(days)}
							onValueChange={(v) =>
								v &&
								navigate({
									search: { ...search, days: range(Number(v)) },
									replace: true,
								})
							}
						>
							{[7, 30, 90].map((v) => (
								<ToggleGroupItem
									key={v}
									value={String(v)}
									// Hovering a range fetches it, so the click shows it at once.
									onPointerEnter={() =>
										void router
											.preloadRoute({
												to: "/",
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
				{!setupDone && (
					<Setup
						sending={data.sending?.status ?? "not_set_up"}
						domains={data.domains}
					/>
				)}
				<Trend
					data={data}
					days={days}
					metric={search.metric ?? "sent"}
					onMetric={(metric) =>
						navigate({
							search: { ...search, metric: metric === "sent" ? undefined : metric },
							replace: true,
							resetScroll: false,
						})
					}
					onPick={(day, status) => open({ day, status })}
				/>
				<div className="grid gap-4 md:grid-cols-2">
					<RateCard
						title="Bounce rate"
						info="Hard bounces over emails sent: the rate SES watches. Soft bounces (a full, down or refusing server) don't count toward it."
						value={ratio(t.bounced, t.sent)}
						before={ratio(data.previous.bounced, data.previous.sent)}
						goodWhen="down"
						series={[
							{ key: "bounced", label: "Hard bounces", color: "var(--destructive)" },
							{ key: "soft_bounced", label: "Soft bounces", color: "var(--warning)" },
						]}
						data={data.series.map((d) => ({
							day: d.day,
							bounced: ratio(d.bounced, d.sent),
							soft_bounced: ratio(d.soft_bounced, d.sent),
							sent: d.sent,
							n_bounced: d.bounced,
							n_soft_bounced: d.soft_bounced,
						}))}
						reference={{
							value: LIMITS.bounce.warning,
							label: "SES reviews at 5%",
							color: "var(--warning)",
						}}
						onPick={(day, key) =>
							open({
								day,
								status: (key as EmailFilterValue | null) ?? "not_delivered",
							})
						}
						rows={[
							{
								label: "Hard bounces",
								color: "var(--destructive)",
								count: t.bounced,
								share: ratio(t.bounced, t.sent),
								to: emails({ status: "bounced" }),
								hint: STATUS_INFO.bounced?.description,
							},
							{
								label: "Soft bounces",
								color: "var(--warning)",
								count: t.soft_bounced,
								share: ratio(t.soft_bounced, t.sent),
								to: emails({ status: "soft_bounced" }),
								hint: STATUS_INFO.soft_bounced?.description,
							},
						]}
						health={{
							value: data.week.health.bounceRate,
							level: data.week.health.bounce,
							limits: LIMITS.bounce,
						}}
					/>
					<RateCard
						title="Complaint rate"
						info="Emails marked as spam over emails sent. Complaining addresses are suppressed at once."
						value={ratio(t.complained, t.sent)}
						before={ratio(data.previous.complained, data.previous.sent)}
						goodWhen="down"
						digits={3}
						series={[
							{ key: "complained", label: "Complaints", color: "var(--chart-4)" },
						]}
						data={data.series.map((d) => ({
							day: d.day,
							complained: ratio(d.complained, d.sent),
							sent: d.sent,
							n_complained: d.complained,
						}))}
						reference={{
							value: LIMITS.complaint.warning,
							label: "SES reviews at 0.1%",
							color: "var(--warning)",
						}}
						onPick={(day) => open({ day, status: "complained" })}
						rows={[
							{
								label: "Complaints",
								color: "var(--chart-4)",
								count: t.complained,
								share: ratio(t.complained, t.sent),
								to: emails({ status: "complained" }),
								hint: STATUS_INFO.complained?.description,
							},
						]}
						health={{
							value: data.week.health.complaintRate,
							level: data.week.health.complaint,
							limits: LIMITS.complaint,
						}}
					/>
					<RateCard
						title="Open rate"
						info="Delivered emails opened at least once. A lower bound: some apps block images, and Apple Mail can open emails on its own."
						value={ratio(t.opened, t.delivered)}
						before={ratio(data.previous.opened, data.previous.delivered)}
						goodWhen="up"
						digits={1}
						series={[{ key: "opened", label: "Opened", color: "var(--chart-1)" }]}
						base="delivered"
						data={data.series.map((d) => ({
							day: d.day,
							opened: ratio(d.opened, d.delivered),
							delivered: d.delivered,
							n_opened: d.opened,
						}))}
						onPick={(day) => open({ day, status: "opened" })}
						rows={[
							{
								label: "Opened",
								color: "var(--chart-1)",
								count: t.opened,
								share: ratio(t.opened, t.delivered),
								to: emails({ status: "opened" }),
							},
							{
								label: "Delivered",
								color: "var(--success)",
								count: t.delivered,
								share: ratio(t.delivered, t.sent),
								to: emails({ status: "delivered" }),
								shareOf: "of sent",
							},
						]}
					/>
					<RateCard
						title="Click rate"
						info="Delivered emails with at least one link clicked. Needs click tracking on the domain."
						value={ratio(t.clicked, t.delivered)}
						before={ratio(data.previous.clicked, data.previous.delivered)}
						goodWhen="up"
						digits={1}
						series={[{ key: "clicked", label: "Clicked", color: "var(--chart-6)" }]}
						base="delivered"
						data={data.series.map((d) => ({
							day: d.day,
							clicked: ratio(d.clicked, d.delivered),
							delivered: d.delivered,
							n_clicked: d.clicked,
						}))}
						onPick={(day) => open({ day, status: "clicked" })}
						rows={[
							{
								label: "Clicked",
								color: "var(--chart-6)",
								count: t.clicked,
								share: ratio(t.clicked, t.delivered),
								to: emails({ status: "clicked" }),
							},
							{
								label: "Click-to-open",
								color: "var(--chart-1)",
								count: t.opened,
								share: ratio(t.clicked, t.opened),
								to: emails({ status: "opened" }),
								shareOf: "of opened clicked",
								countLabel: "opened",
							},
						]}
					/>
				</div>
				<div className="grid gap-4 lg:grid-cols-2">
					<NotDeliveredCard
						totals={t}
						emails={emails}
					/>
					<ProvidersCard
						rows={data.byProvider}
						emails={emails}
					/>
				</div>
				{data.byDomain.length > 0 && (
					<ByDomain
						rows={data.byDomain}
						days={days}
						selected={data.domain}
						onPick={(domain) =>
							navigate({
								search: {
									...search,
									domain: domain === search.domain ? undefined : domain,
								},
								replace: true,
							})
						}
						emails={emails}
					/>
				)}
				{data.byBrand.length > 0 && (
					<ByBrand
						rows={data.byBrand}
						days={days}
						onPick={(brand) => navigate({ search: { ...search, brand } })}
					/>
				)}
			</SketchWhile>
		</Page>
	);
}

/**
 * The big chart: five numbers across the top (sent, delivered, opened, clicked, not delivered),
 * each a tab; the picked one day by day, against the period before. Not delivered stacks its
 * four reasons. Clicking a day opens its emails.
 */
function Trend({
	data,
	days,
	metric,
	onMetric,
	onPick,
}: {
	data: Data;
	days: number;
	metric: Metric;
	onMetric: (m: Metric) => void;
	onPick: (day: string, status: EmailFilterValue | undefined) => void;
}) {
	const t = data.totals;
	const p = data.previous;
	const tabs: {
		key: Metric;
		label: string;
		value: number;
		before: number;
		rate: string | null;
		goodWhen: "up" | "down" | "neutral";
		status: EmailFilterValue | undefined;
		of: (d: Day) => number;
		sub?: (d: Day) => string | undefined;
	}[] = [
		{
			key: "sent",
			label: "Sent",
			value: t.sent,
			before: p.sent,
			rate: null,
			goodWhen: "neutral",
			status: undefined,
			of: (d) => d.sent,
		},
		{
			key: "delivered",
			label: "Delivered",
			value: t.delivered,
			before: p.delivered,
			rate: t.sent ? formatPercent(ratio(t.delivered, t.sent), 1) : null,
			goodWhen: "neutral",
			status: "delivered",
			of: (d) => d.delivered,
			sub: (d) => (d.sent ? formatPercent(ratio(d.delivered, d.sent), 1) : undefined),
		},
		{
			key: "opened",
			label: "Opened",
			value: t.opened,
			before: p.opened,
			rate: t.delivered ? formatPercent(ratio(t.opened, t.delivered), 1) : null,
			goodWhen: "neutral",
			status: "opened",
			of: (d) => d.opened,
			sub: (d) => (d.delivered ? formatPercent(ratio(d.opened, d.delivered), 1) : undefined),
		},
		{
			key: "clicked",
			label: "Clicked",
			value: t.clicked,
			before: p.clicked,
			rate: t.delivered ? formatPercent(ratio(t.clicked, t.delivered), 1) : null,
			goodWhen: "neutral",
			status: "clicked",
			of: (d) => d.clicked,
			sub: (d) => (d.delivered ? formatPercent(ratio(d.clicked, d.delivered), 1) : undefined),
		},
		{
			key: "not_delivered",
			label: "Not delivered",
			value: notDelivered(t),
			before: notDelivered(p),
			rate: attempted(t) ? formatPercent(ratio(notDelivered(t), attempted(t)), 1) : null,
			goodWhen: "down",
			status: "not_delivered",
			of: (d) => notDelivered(d),
		},
	];
	const active = tabs.find((x) => x.key === metric) ?? (tabs[0] as (typeof tabs)[number]);
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<div
				role="tablist"
				aria-label="Metric"
				className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-5"
			>
				{tabs.map((x, i) => (
					<button
						key={x.key}
						type="button"
						role="tab"
						aria-selected={x.key === active.key}
						onClick={() => onMetric(x.key)}
						className={cn(
							"group relative flex min-w-0 flex-col items-start gap-1 bg-card px-4 py-3.5 text-left outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5 sm:py-4",
							x.key === active.key ? "bg-card" : "bg-card/60 hover:bg-card",
							// An odd count on phones: the last one spans the row.
							i === tabs.length - 1 && "max-sm:col-span-2",
						)}
					>
						<span
							className={cn(
								"text-[13px] transition-colors",
								x.key === active.key
									? "text-foreground"
									: "text-muted-foreground group-hover:text-foreground",
							)}
						>
							{x.label}
						</span>
						<span className="text-[22px] leading-8 font-semibold tracking-[-0.022em] tabular-nums">
							<Ph>{formatNumber(x.value)}</Ph>
						</span>
						<span className="flex h-5 items-center gap-1.5 text-xs text-faint tabular-nums">
							{x.rate && <Ph>{x.rate}</Ph>}
							<Ph>
								<Delta
									now={x.value}
									before={x.before}
									kind="count"
									goodWhen={x.goodWhen}
								/>
							</Ph>
						</span>
						<span
							aria-hidden="true"
							className={cn(
								"absolute inset-x-0 bottom-0 h-0.5 origin-left bg-brand transition-transform duration-300 ease-out",
								x.key === active.key ? "scale-x-100" : "scale-x-0",
							)}
						/>
					</button>
				))}
			</div>
			<div className="px-2 pt-5 pb-3 sm:px-3">
				{/* The chart's own frame while sketched (or another range loads): nothing moves. */}
				<PhBox>
					{active.key === "not_delivered" ? (
						<DayBars
							data={data.series}
							series={NOT_DELIVERED}
							format={formatNumber}
							height={260}
							total={{
								label: "Total not delivered",
								value: (r) => formatNumber(notDelivered(r as unknown as Day)),
							}}
							onPick={(day, key) =>
								onPick(day, (key as EmailFilterValue | null) ?? "not_delivered")
							}
						/>
					) : (
						<TrendChart
							data={data.series.map((d, i) => {
								const before = data.previousSeries[i];
								return {
									day: d.day,
									value: active.of(d),
									sub: active.sub?.(d),
									previous: before ? active.of(before) : undefined,
									previousDay: before?.day,
								};
							})}
							label={active.label}
							color="var(--chart-1)"
							format={formatNumber}
							height={260}
							previousLabel={`${days} days before`}
							onPick={(day) => onPick(day, active.status)}
						/>
					)}
				</PhBox>
			</div>
			<div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
				{active.key === "not_delivered" ? (
					NOT_DELIVERED.map((s) => (
						<span
							key={s.key}
							className="flex items-center gap-1.5"
						>
							<span
								className="size-2 rounded-[3px]"
								style={{ background: s.color }}
							/>
							{s.label}
							<span className="text-foreground tabular-nums">
								{formatNumber(t[s.key as keyof Totals] as number)}
							</span>
						</span>
					))
				) : (
					<>
						<span className="flex items-center gap-1.5">
							<span className="h-0.5 w-3 rounded-full bg-chart-1" />
							Last {days} days
						</span>
						<span className="flex items-center gap-1.5">
							<span className="w-3 border-t-[1.5px] border-dashed border-faint" />
							{days} days before
						</span>
					</>
				)}
				<span className="ml-auto hidden text-faint sm:inline">
					Click a day to see its emails
				</span>
			</div>
		</Card>
	);
}

type Row = { day: string } & Record<string, number | string | undefined>;

/**
 * A rate: its value over the range against the period before, day by day as bars (against
 * SES's line for bounces and complaints), and the counts behind it, each a link to its emails.
 */
function RateCard({
	title,
	info,
	value,
	before,
	goodWhen,
	digits = 2,
	series,
	data,
	base = "sent",
	reference,
	onPick,
	rows,
	health,
}: {
	title: string;
	info: string;
	value: number;
	before: number;
	goodWhen: "up" | "down";
	digits?: number;
	series: Series[];
	data: Row[];
	/** What the daily rate is out of, for the tooltip. */
	base?: "sent" | "delivered";
	reference?: { value: number; label: string; color: string };
	onPick: (day: string, key: string | null) => void;
	rows: {
		label: string;
		color: string;
		count: number;
		share: number;
		to: EmailsLink;
		hint?: string;
		shareOf?: string;
		countLabel?: string;
	}[];
	/** SES's own view: the last 7 days, whatever the range. */
	health?: { value: number; level: string; limits: { warning: number; danger: number } };
}) {
	const below = reference && value > 0 ? reference.value / value : null;
	return (
		<Card className="gap-0 p-0">
			<div className="flex items-start justify-between gap-3 px-5 pt-4">
				<div className="min-w-0">
					<p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
						{title}
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={`About ${title.toLowerCase()}`}
									className="rounded-full text-faint transition-colors hover:text-foreground"
								>
									<CircleHelp className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent className="max-w-64">{info}</TooltipContent>
						</Tooltip>
					</p>
					<p className="flex items-center gap-2">
						<span className="text-[26px] leading-9 font-semibold tracking-[-0.022em] tabular-nums">
							<Ph>{formatPercent(value, digits)}</Ph>
						</span>
						<Ph>
							<Delta
								now={value}
								before={before}
								kind="rate"
								goodWhen={goodWhen}
							/>
						</Ph>
					</p>
				</div>
				{health && <Health {...health} />}
			</div>
			<div className="px-2 pt-2 sm:px-3">
				<PhBox>
					{
						<DayBars
							data={data}
							series={series}
							height={150}
							format={(v) => formatPercent(v, digits)}
							formatAxis={(v) => formatPercent(v, v < 0.01 ? 2 : 1)}
							maxDomain={series.length ? undefined : 0}
							sub={(row, key) => {
								const n = Number(row[`n_${key}`]) || 0;
								const whole = Number(row[base]) || 0;
								return `${formatNumber(n)} of ${formatNumber(whole)}`;
							}}
							reference={reference}
							onPick={onPick}
						/>
					}
				</PhBox>
			</div>
			{reference && below !== null && below > 1.6 && (
				<p className="px-5 pt-1 text-xs text-faint">
					{reference.label.replace("SES reviews at", "SES's review line is")}, about{" "}
					<Ph>{below >= 10 ? Math.round(below) : below.toFixed(1)}×</Ph> this rate.
				</p>
			)}
			<ul className="mt-3 border-t border-border/70">
				{rows.map((r) => (
					<li key={r.label}>
						<Link
							to="/emails"
							search={r.to}
							title={r.hint}
							className="group flex items-center gap-3 border-b border-border/70 px-5 py-2.5 text-sm outline-none transition-colors last:border-0 hover:bg-accent/50 focus-visible:bg-accent/50"
						>
							<span
								className="size-2 shrink-0 rounded-[3px]"
								style={{ background: r.color }}
							/>
							<span className="min-w-0 flex-1 truncate">{r.label}</span>
							<span className="text-muted-foreground tabular-nums">
								<Ph>{formatNumber(r.count)}</Ph>
								{r.countLabel && (
									<span className="hidden text-faint sm:inline">
										{" "}
										{r.countLabel}
									</span>
								)}
							</span>
							<span className="w-16 text-right font-medium tabular-nums sm:w-24">
								<Ph>{formatPercent(r.share, digits)}</Ph>
								{r.shareOf && <span className="sr-only"> {r.shareOf}</span>}
							</span>
							<ChevronRight className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}

/** SES's own verdict on the last 7 days: OK, under review, or near a pause. */
function Health({
	value,
	level,
	limits,
}: {
	value: number;
	level: string;
	limits: { warning: number; danger: number };
}) {
	const label =
		level === "danger" ? "Near a pause" : level === "warning" ? "Under review" : "Healthy";
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					data-ph
					className={cn(
						"inline-flex h-6 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2 text-xs font-medium",
						level === "danger"
							? "bg-destructive/12 text-destructive"
							: level === "warning"
								? "bg-warning/14 text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]"
								: "bg-success/12 text-success",
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							level === "danger"
								? "bg-destructive"
								: level === "warning"
									? "bg-warning"
									: "bg-success",
						)}
					/>
					{label}
				</span>
			</TooltipTrigger>
			<TooltipContent className="grid min-w-48 gap-1.5 text-xs">
				<p className="font-medium">What SES sees: the last 7 days</p>
				<MeterRow
					label="Last 7 days"
					value={formatPercent(value, 3)}
				/>
				<MeterRow
					label="SES reviews at"
					value={formatPercent(limits.warning, 1)}
				/>
				<MeterRow
					label="SES pauses at"
					value={formatPercent(limits.danger, 1)}
				/>
			</TooltipContent>
		</Tooltip>
	);
}

function MeterRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-center justify-between gap-4">
			<span className="opacity-80">{label}</span>
			<span className="font-medium tabular-nums">{value}</span>
		</div>
	);
}

/**
 * Why emails weren't delivered: bounced, soft bounced, failed and suppressed, as one bar split
 * by reason and a row each with what it means. Every row opens its emails.
 */
function NotDeliveredCard({
	totals: t,
	emails,
}: {
	totals: Totals;
	emails: (s: EmailsSearch) => EmailsLink;
}) {
	const total = notDelivered(t);
	const tried = attempted(t);
	return (
		<Card className="gap-0 p-0">
			<div className="flex items-start justify-between gap-3 px-5 pt-4">
				<div>
					<p className="text-[13px] text-muted-foreground">Not delivered</p>
					<p className="flex items-baseline gap-2">
						<span className="text-[26px] leading-9 font-semibold tracking-[-0.022em] tabular-nums">
							<Ph>{formatNumber(total)}</Ph>
						</span>
						<span className="text-sm text-faint tabular-nums">
							{tried ? (
								<Ph>{formatPercent(ratio(total, tried), 2)} of emails</Ph>
							) : (
								""
							)}
						</span>
					</p>
				</div>
				<Button
					asChild
					variant="ghost"
					size="sm"
					className="-mr-2"
				>
					<Link
						to="/emails"
						search={emails({ status: "not_delivered" })}
					>
						See all
						<ArrowRight />
					</Link>
				</Button>
			</div>
			<div className="px-5 pt-3">
				<div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted">
					{total > 0 &&
						NOT_DELIVERED.map((s) => {
							const n = t[s.key as keyof Totals] as number;
							return n > 0 ? (
								<span
									data-ph
									key={s.key}
									className="h-full rounded-full transition-[flex-grow] duration-500 ease-out"
									style={{ flexGrow: n, background: s.color, minWidth: 4 }}
								/>
							) : null;
						})}
				</div>
			</div>
			<ul className="mt-3 border-t border-border/70">
				{NOT_DELIVERED.map((s) => {
					const n = t[s.key as keyof Totals] as number;
					return (
						<li key={s.key}>
							<Link
								to="/emails"
								search={emails({ status: s.key as EmailFilterValue })}
								className="group flex items-start gap-3 border-b border-border/70 px-5 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50"
							>
								<span
									className="mt-1.5 size-2 shrink-0 rounded-[3px]"
									style={{ background: s.color }}
								/>
								<span className="min-w-0 flex-1">
									<span className="block text-sm font-medium">{s.label}</span>
									<span className="block text-xs text-muted-foreground text-pretty">
										{STATUS_INFO[s.key]?.description}
									</span>
								</span>
								<span className="text-sm font-medium tabular-nums">
									<Ph>{formatNumber(n)}</Ph>
								</span>
								<span className="w-14 text-right text-sm text-faint tabular-nums">
									{!total ? "" : <Ph>{formatPercent(ratio(n, total), 0)}</Ph>}
								</span>
								<ChevronRight className="mt-0.5 size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
							</Link>
						</li>
					);
				})}
			</ul>
			<p className="flex flex-wrap items-center gap-x-1 px-5 py-3 text-xs text-muted-foreground">
				Suppressed by whose rule:
				<Link
					to="/emails"
					search={emails({ status: "firewall" })}
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					blocked by firewall
				</Link>
				·
				<Link
					to="/emails"
					search={emails({ status: "unsubscribed" })}
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					unsubscribed
				</Link>
				·
				<Link
					to="/suppressions"
					className="font-medium text-foreground underline-offset-4 hover:underline"
				>
					suppression list
				</Link>
			</p>
		</Card>
	);
}

/**
 * Gmail, Outlook, Yahoo and iCloud side by side: a problem with one provider (Outlook bouncing,
 * Gmail marking as spam) shows here before it moves the totals. Each row opens its emails.
 */
function ProvidersCard({
	rows,
	emails,
}: {
	rows: Data["byProvider"];
	emails: (s: EmailsSearch) => EmailsLink;
}) {
	const shown = rows.filter((p) => p.sent > 0);
	const max = Math.max(1, ...shown.map((p) => p.sent));
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4 pb-3">
				<p className="text-[13px] text-muted-foreground">By mailbox provider</p>
				<p className="text-sm text-faint">Where your recipients read their email.</p>
			</div>
			{shown.length === 0 ? (
				<p className="border-t border-border/70 px-5 py-8 text-center text-sm text-muted-foreground">
					Nothing sent in this range.
				</p>
			) : (
				<ul className="border-t border-border/70">
					<li className="grid grid-cols-[1fr_4rem_4rem_1rem] gap-3 sm:grid-cols-[1fr_4.5rem_4.5rem_4.5rem_1rem] border-b border-border/70 px-5 py-2 text-[11px] font-medium tracking-wide text-faint uppercase">
						<span>Provider</span>
						<span className="text-right">Delivered</span>
						<span className="hidden text-right sm:block">Opened</span>
						<span className="text-right">Bounced</span>
						<span />
					</li>
					{shown.map((p) => (
						<li key={p.provider}>
							<Link
								to="/emails"
								search={emails({ provider: p.provider as Provider })}
								className="group grid grid-cols-[1fr_4rem_4rem_1rem] items-center sm:grid-cols-[1fr_4.5rem_4.5rem_4.5rem_1rem] gap-3 border-b border-border/70 px-5 py-2.5 text-sm outline-none transition-colors last:border-0 hover:bg-accent/50 focus-visible:bg-accent/50"
							>
								<span className="min-w-0">
									<span className="flex items-baseline justify-between gap-2">
										<span className="truncate font-medium">
											<Ph>
												{PROVIDER_LABEL[p.provider as Provider] ??
													p.provider}
											</Ph>
										</span>
										<span className="text-xs text-faint tabular-nums">
											<Ph>{formatNumber(p.sent)}</Ph>
										</span>
									</span>
									<span className="mt-1.5 block h-1 rounded-full bg-muted">
										<span
											data-ph
											className="block h-full rounded-full bg-chart-1 transition-[width] duration-500 ease-out"
											style={{
												width: `${(p.sent / max) * 100}%`,
												minWidth: 4,
											}}
										/>
									</span>
								</span>
								<span className="text-right tabular-nums">
									<Ph>{formatPercent(p.deliveryRate, 1)}</Ph>
								</span>
								<span className="hidden text-right text-muted-foreground tabular-nums sm:block">
									<Ph>{formatPercent(p.openRate, 1)}</Ph>
								</span>
								<span
									className={cn(
										"text-right tabular-nums",
										p.bounce === "danger"
											? "text-destructive"
											: p.bounce === "warning"
												? "text-warning"
												: "text-muted-foreground",
									)}
								>
									<Ph>{formatPercent(p.bounceRate, 1)}</Ph>
								</span>
								<ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
							</Link>
						</li>
					))}
				</ul>
			)}
		</Card>
	);
}

/**
 * Each sending domain with its rates, like a row of gauges: click one to see only its numbers
 * (again to see all), or its arrow for its emails.
 */
function ByDomain({
	rows,
	days,
	selected,
	onPick,
	emails,
}: {
	rows: Data["byDomain"];
	days: number;
	selected: string | null;
	onPick: (domain: string) => void;
	emails: (s: EmailsSearch) => EmailsLink;
}) {
	const cols: {
		key: string;
		label: string;
		color: string;
		value: (r: Data["byDomain"][number]) => number;
		digits: number;
		bad?: (r: Data["byDomain"][number]) => string;
		className?: string;
	}[] = [
		{
			key: "delivered",
			label: "Delivered",
			color: "var(--success)",
			value: (r) => ratio(r.delivered, r.sent),
			digits: 1,
			// Bounces say more on a phone, and both don't fit.
			className: "hidden sm:table-cell",
		},
		{
			key: "opened",
			label: "Opened",
			color: "var(--chart-1)",
			value: (r) => ratio(r.opened, r.delivered),
			digits: 1,
			className: "hidden md:table-cell",
		},
		{
			key: "clicked",
			label: "Clicked",
			color: "var(--chart-6)",
			value: (r) => ratio(r.clicked, r.delivered),
			digits: 1,
			className: "hidden lg:table-cell",
		},
		{
			key: "bounced",
			label: "Bounced",
			color: "var(--destructive)",
			value: (r) => r.bounceRate,
			digits: 2,
			bad: (r) => r.bounce,
		},
		{
			key: "complained",
			label: "Complaints",
			color: "var(--chart-4)",
			value: (r) => r.complaintRate,
			digits: 3,
			bad: (r) => r.complaint,
			className: "hidden sm:table-cell",
		},
	];
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-semibold">By sending domain · last {days} days</h2>
			<TableCard>
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>Domain</TableHead>
							<TableHead className="w-20 text-right">Sent</TableHead>
							{cols.map((c) => (
								<TableHead
									key={c.key}
									className={cn("w-28 text-right", c.className)}
								>
									<span className="inline-flex items-center gap-1.5">
										<span
											className="size-1.5 rounded-full"
											style={{ background: c.color }}
										/>
										{c.label}
									</span>
								</TableHead>
							))}
							<TableHead className="w-10" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r) => (
							<TableRow
								key={r.domain}
								data-state={selected === r.domain ? "selected" : undefined}
								className="cursor-pointer"
								onClick={() => onPick(r.domain)}
							>
								<TableCell className="w-full max-w-0 font-medium">
									<span className="flex min-w-0 items-center gap-2">
										<Globe className="size-3.5 shrink-0 text-faint" />
										<span className="truncate">
											<Ph>{r.domain}</Ph>
										</span>
									</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									<Ph>{formatNumber(r.sent)}</Ph>
								</TableCell>
								{cols.map((c) => {
									const level = c.bad?.(r);
									return (
										<TableCell
											key={c.key}
											className={cn(
												"text-right tabular-nums",
												c.className,
												level === "danger" && "text-destructive",
												level === "warning" && "text-warning",
												!level && c.bad && "text-muted-foreground",
											)}
										>
											<Ph>
												{r.sent ? formatPercent(c.value(r), c.digits) : "—"}
											</Ph>
										</TableCell>
									);
								})}
								<TableCell className="text-right">
									<Tooltip>
										<TooltipTrigger asChild>
											<Link
												to="/emails"
												search={emails({ domain: r.domain })}
												onClick={(e) => e.stopPropagation()}
												aria-label={`Emails from ${r.domain}`}
												className="inline-flex size-7 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
											>
												<ArrowRight className="size-4" />
											</Link>
										</TooltipTrigger>
										<TooltipContent>See its emails</TooltipContent>
									</Tooltip>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</TableCard>
		</section>
	);
}

/** The organization's brands side by side, so the one near SES's limits stands out. */
function ByBrand({
	rows,
	days,
	onPick,
}: {
	rows: {
		id: string;
		name: string;
		sent: number;
		delivered: number;
		bounceRate: number;
		complaintRate: number;
		bounce: string;
		complaint: string;
	}[];
	days: number;
	onPick: (brand: string) => void;
}) {
	return (
		<section className="space-y-3">
			<h2 className="text-sm font-semibold">By brand · last {days} days</h2>
			<TableCard>
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>Brand</TableHead>
							<TableHead className="w-20 text-right">Sent</TableHead>
							<TableHead className="hidden w-24 text-right sm:table-cell">
								Delivered
							</TableHead>
							<TableHead className="w-24 text-right">Bounces</TableHead>
							<TableHead className="w-28 text-right">Complaints</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((o) => (
							<TableRow
								key={o.id}
								className="cursor-pointer"
								onClick={() => onPick(o.id)}
							>
								<TableCell className="w-full max-w-0 font-medium">
									<span className="flex min-w-0 items-center gap-2.5">
										<OrgAvatar name={o.name} />
										<span className="truncate">
											<Ph>{o.name}</Ph>
										</span>
									</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									<Ph>{formatNumber(o.sent)}</Ph>
								</TableCell>
								<TableCell className="hidden text-right tabular-nums sm:table-cell">
									<Ph>{o.sent ? formatPercent(o.delivered / o.sent, 1) : "—"}</Ph>
								</TableCell>
								<TableCell
									className={cn(
										"text-right tabular-nums",
										o.bounce === "danger" && "text-destructive",
										o.bounce === "warning" && "text-warning",
									)}
								>
									<Ph>{o.sent ? formatPercent(o.bounceRate) : "—"}</Ph>
								</TableCell>
								<TableCell
									className={cn(
										"text-right tabular-nums",
										o.complaint === "danger" && "text-destructive",
										o.complaint === "warning" && "text-warning",
									)}
								>
									<Ph>{o.sent ? formatPercent(o.complaintRate, 3) : "—"}</Ph>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</TableCard>
		</section>
	);
}

function Setup({ sending, domains }: { sending: string; domains: { status: string }[] }) {
	const steps = [
		{
			done: sending === "ready",
			label: "Set up sending",
			hint: "Its own SES tenant, so its reputation stays its own.",
			to: "/settings" as const,
			action: "Set up",
		},
		{
			done: domains.length > 0,
			label: "Add a domain",
			hint: "The one your emails come from, like mail.example.com.",
			to: "/domains" as const,
			action: "Add domain",
		},
		{
			done: domains.some((d) => d.status === "verified"),
			label: "Verify it",
			hint: "Add its DNS records; SES checks them within minutes.",
			to: "/domains" as const,
			action: "See records",
		},
		{
			done: false,
			label: "Send your first email",
			hint: "Create an API key and call the API, or use SMTP.",
			to: "/api-keys" as const,
			action: "Create key",
		},
	];
	const next = steps.findIndex((s) => !s.done);
	const done = steps.filter((s) => s.done).length;
	return (
		<Card>
			<div className="flex items-center justify-between gap-4 px-5 pt-4 pb-3">
				<div>
					<h2 className="text-sm font-semibold">Get ready to send</h2>
					<p className="text-sm text-muted-foreground">
						<Ph>{done}</Ph> of {steps.length} done
					</p>
				</div>
				<div className="flex w-28 gap-1">
					{steps.map((s, i) => (
						<span
							key={i}
							className={cn(
								"h-1 flex-1 rounded-full",
								s.done
									? "bg-success"
									: "bg-muted shadow-[inset_0_0_0_1px_var(--border)]",
							)}
						/>
					))}
				</div>
			</div>
			<ol className="border-t">
				{steps.map((s, i) => (
					<li
						key={s.label}
						className={cn(
							"flex items-center gap-3.5 border-b border-border/70 px-5 py-3 last:border-0",
							i === next && "bg-brand/[0.035]",
						)}
					>
						<span
							className={cn(
								"flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
								s.done
									? "bg-success text-white"
									: i === next
										? "bg-brand text-brand-foreground"
										: "text-faint shadow-[inset_0_0_0_1px_var(--border-strong)]",
							)}
						>
							{s.done ? (
								<Check
									className="size-3"
									strokeWidth={3}
								/>
							) : (
								i + 1
							)}
						</span>
						<div className="min-w-0 flex-1">
							<p
								className={cn(
									"text-sm font-medium",
									s.done && "text-muted-foreground",
								)}
							>
								{s.label}
							</p>
							{!s.done && <p className="text-sm text-muted-foreground">{s.hint}</p>}
						</div>
						{i === next ? (
							<Button
								asChild
								size="sm"
							>
								<Link to={s.to}>
									{s.action}
									<ArrowRight />
								</Link>
							</Button>
						) : !s.done ? (
							<Button
								asChild
								size="sm"
								variant="ghost"
							>
								<Link to={s.to}>{s.action}</Link>
							</Button>
						) : null}
					</li>
				))}
			</ol>
		</Card>
	);
}
