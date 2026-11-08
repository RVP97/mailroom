import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Coins } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { DayBars } from "@/components/metric-charts";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { getRevenueFn } from "@/functions/insights";
import { formatAgo, formatMoney, formatNumber, formatPercent } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
import { Ph, Sketch, SketchWhile, usePage } from "@/lib/sketch";

export const Route = createFileRoute("/_app/insights/revenue")({
	validateSearch: z.object({
		days: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).optional(),
		brand: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({ days: search.days ?? 30, brand: search.brand }),
	loader: ({ deps }) => getRevenueFn({ data: { days: deps.days, brand: deps.brand } }),
	pendingMs: Number.POSITIVE_INFINITY,
	head: () => ({ meta: [{ title: "Revenue · Mailroom" }] }),
	component: Revenue,
	pendingComponent: RevenueSketch,
});

type Data = Awaited<ReturnType<typeof getRevenueFn>>;

function RevenueSketch() {
	return (
		<Sketch
			data={{
				days: 30,
				credit_days: 7,
				currency: "USD",
				totals: [
					{
						currency: "USD",
						total: 4200,
						purchases: 40,
						credited: 1900,
						credited_purchases: 18,
					},
				],
				by_type: [],
				broadcasts: [],
				automations: [],
				campaigns: [],
				daily: [],
				latest: [],
				brands: [],
			}}
		>
			<Revenue />
		</Sketch>
	);
}

const TYPE_LABEL: Record<string, string> = {
	broadcast: "Broadcasts",
	automation: "Automations",
	chat: "Website chat",
	none: "Nothing in the last 7 days",
};

const DAILY = [
	{ key: "credited", label: "Earned by email and chat", color: "var(--chart-1)" },
	{ key: "rest", label: "Everything else", color: "var(--chart-3)" },
];

function Revenue() {
	const { data, search: shown } = usePage(Route);
	const pending = usePendingSearch(shown);
	const { search } = pending;
	const days = Number(search.days ?? 30);
	const navigate = Route.useNavigate();
	const cur = data.currency;
	const main = data.totals[0];
	const money = (n: number) => formatMoney(n, cur);
	return (
		<Page>
			<PageHeader
				title="Revenue"
				description={`Purchases your app sends as events with a value, and what earned them: the last broadcast or automation email the person opened or clicked, or website chat they wrote in, within ${data.credit_days} days.`}
				actions={
					<>
						<Button
							variant="outline"
							asChild
						>
							<Link
								to="/insights"
								search={{ brand: search.brand }}
							>
								<ArrowLeft />
								Insights
							</Link>
						</Button>
						<BrandFilter
							brands={data.brands}
							value={search.brand}
							onChange={(brand) =>
								navigate({ search: { ...search, brand }, replace: true })
							}
						/>
						<ToggleGroup
							type="single"
							variant="outline"
							value={String(days)}
							onValueChange={(v) =>
								v &&
								navigate({
									search: {
										...search,
										days: v === "30" ? undefined : (Number(v) as 7 | 90 | 365),
									},
									replace: true,
								})
							}
						>
							{[7, 30, 90, 365].map((v) => (
								<ToggleGroupItem
									key={v}
									value={String(v)}
								>
									{v === 365 ? "1 year" : `${v} days`}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</>
				}
			/>
			<SketchWhile loading={pending.loading}>
				{!main ? (
					<Empty className="border">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Coins />
							</EmptyMedia>
							<EmptyTitle>No purchases in this range</EmptyTitle>
							<EmptyDescription>
								Send them as events with a value: <code>POST /api/events</code> with{" "}
								<code>{`{ "event": "purchase", "email": "…", "value": 120, "currency": "USD" }`}</code>
								. Each one is credited to the broadcast, automation or chat that
								reached the person last.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<>
						<Card className="grid gap-px overflow-hidden bg-border/70 p-0 sm:grid-cols-3">
							<Figure
								label="Revenue"
								value={money(main.total)}
								sub={`${formatNumber(main.purchases)} ${main.purchases === 1 ? "purchase" : "purchases"}`}
							/>
							<Figure
								label="Earned by email and chat"
								value={money(main.credited)}
								sub={
									main.total
										? `${formatPercent(main.credited / main.total, 0)} of it, ${formatNumber(main.credited_purchases)} ${main.credited_purchases === 1 ? "purchase" : "purchases"}`
										: undefined
								}
							/>
							<Figure
								label="Per credited purchase"
								value={
									main.credited_purchases
										? money(
												Math.round(
													(main.credited / main.credited_purchases) * 100,
												) / 100,
											)
										: "—"
								}
								sub="on average"
							/>
						</Card>
						{data.totals.length > 1 && (
							<p className="text-sm text-muted-foreground">
								Also:{" "}
								{data.totals
									.slice(1)
									.map(
										(t) =>
											`${formatMoney(t.total, t.currency)} (${formatNumber(t.purchases)})`,
									)
									.join(", ")}
								. The rest of the page is in {cur ?? "amounts without a currency"}.
							</p>
						)}
						<Card className="gap-0 p-0">
							<div className="px-5 pt-4">
								<p className="font-medium">Day by day</p>
								<p className="text-sm text-muted-foreground">
									What came in each day, and how much of it email and chat earned.
								</p>
							</div>
							<div className="px-2 pt-4 pb-2 sm:px-3">
								<DayBars
									data={data.daily.map((d) => ({
										day: d.day,
										credited: d.credited,
										rest: Math.max(
											0,
											Math.round((d.total - d.credited) * 100) / 100,
										),
									}))}
									series={DAILY}
									format={money}
									footer={null}
									height={200}
									total={{
										label: "Total",
										value: (r) =>
											money(Number(r.credited ?? 0) + Number(r.rest ?? 0)),
									}}
								/>
							</div>
						</Card>
						<div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
							<Ranked
								title="By what earned it"
								rows={data.by_type.map((t) => ({
									key: t.type,
									name: TYPE_LABEL[t.type] ?? t.type,
									total: t.total,
									purchases: t.purchases,
								}))}
								money={money}
								of={main.total}
							/>
							<Ranked
								title="Top broadcasts"
								empty="No purchases were credited to a broadcast."
								rows={data.broadcasts.map((b) => ({
									key: b.id,
									name: (
										<Link
											to="/broadcasts/$id"
											params={{ id: b.id }}
											className="hover:underline"
										>
											<Ph>{b.name}</Ph>
										</Link>
									),
									total: b.total,
									purchases: b.purchases,
								}))}
								money={money}
								of={main.total}
							/>
							<Ranked
								title="Top automations"
								empty="No purchases were credited to an automation."
								rows={data.automations.map((x) => ({
									key: x.id,
									name: (
										<Link
											to="/automations/$id"
											params={{ id: x.id }}
											className="hover:underline"
										>
											<Ph>{x.name}</Ph>
										</Link>
									),
									total: x.total,
									purchases: x.purchases,
								}))}
								money={money}
								of={main.total}
							/>
							<Ranked
								title="Top campaigns"
								empty="No purchases were credited to a campaign's broadcasts."
								rows={data.campaigns.map((c) => ({
									key: c.id,
									name: (
										<Link
											to="/campaigns/$id"
											params={{ id: c.id }}
											className="hover:underline"
										>
											<Ph>{c.name}</Ph>
										</Link>
									),
									total: c.total,
									purchases: c.purchases,
								}))}
								money={money}
								of={main.total}
							/>
						</div>
						<Section
							title="Latest purchases"
							description="The newest 20, with who bought and what gets the credit."
						>
							<TableCard>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>Who</TableHead>
											<TableHead>Event</TableHead>
											<TableHead>Credit</TableHead>
											<TableHead className="text-right">Amount</TableHead>
											<TableHead className="text-right">When</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.latest.map((l) => (
											<TableRow key={l.id}>
												<TableCell className="max-w-56 truncate">
													<Link
														to="/contacts/$id"
														params={{ id: l.contact_id }}
														className="hover:underline"
													>
														<Ph>{l.email}</Ph>
													</Link>
												</TableCell>
												<TableCell>
													<code className="font-mono text-[13px]">
														{l.event}
													</code>
												</TableCell>
												<TableCell className="max-w-56 truncate text-muted-foreground">
													<CreditLink l={l} />
												</TableCell>
												<TableCell className="text-right tabular-nums">
													{formatMoney(l.value, l.currency)}
												</TableCell>
												<TableCell className="text-right text-muted-foreground tabular-nums">
													{formatAgo(l.created_at)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableCard>
						</Section>
					</>
				)}
			</SketchWhile>
		</Page>
	);
}

function CreditLink({ l }: { l: Data["latest"][number] }) {
	if (!l.credit_type || !l.credit_id) return <>Nothing</>;
	const name = <Ph>{l.credit_name ?? "Deleted"}</Ph>;
	if (l.credit_type === "broadcast")
		return (
			<Link
				to="/broadcasts/$id"
				params={{ id: l.credit_id }}
				className="hover:underline"
			>
				{name}
			</Link>
		);
	if (l.credit_type === "automation")
		return (
			<Link
				to="/automations/$id"
				params={{ id: l.credit_id }}
				className="hover:underline"
			>
				{name}
			</Link>
		);
	return (
		<Link
			to="/received/$id"
			params={{ id: l.credit_id }}
			className="hover:underline"
		>
			{name}
		</Link>
	);
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-1 bg-card px-5 py-4">
			<span className="text-[13px] text-muted-foreground">{label}</span>
			<span className="text-[22px] leading-8 font-semibold tracking-[-0.022em] tabular-nums">
				<Ph>{value}</Ph>
			</span>
			<span className="h-5 text-xs text-faint tabular-nums">{sub && <Ph>{sub}</Ph>}</span>
		</div>
	);
}

function Ranked({
	title,
	rows,
	money,
	of,
	empty,
}: {
	title: string;
	rows: { key: string; name: ReactNode; total: number; purchases: number }[];
	money: (n: number) => string;
	of: number;
	empty?: string;
}) {
	return (
		<Card className="gap-0 p-0">
			<p className="px-5 pt-4 pb-2 font-medium">{title}</p>
			{rows.length ? (
				<ul className="flex flex-col px-5 pb-4">
					{rows.map((r) => (
						<li
							key={r.key}
							className="flex flex-col gap-1 py-1.5"
						>
							<div className="flex items-baseline gap-3 text-sm">
								<span className="min-w-0 flex-1 truncate">{r.name}</span>
								<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
									{formatNumber(r.purchases)}
								</span>
								<span className="w-24 shrink-0 text-right font-medium tabular-nums">
									<Ph>{money(r.total)}</Ph>
								</span>
							</div>
							<div className="h-1 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-chart-1"
									style={{
										width: `${of ? Math.min(100, (r.total / of) * 100) : 0}%`,
									}}
								/>
							</div>
						</li>
					))}
				</ul>
			) : (
				<p className="px-5 pb-4 text-sm text-muted-foreground">{empty}</p>
			)}
		</Card>
	);
}
