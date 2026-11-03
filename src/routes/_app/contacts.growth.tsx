import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
	Bot,
	Code,
	FileUp,
	Gift,
	HelpCircle,
	NotebookPen,
	TrendingDown,
	TrendingUp,
	UserPlus,
	Zap,
} from "lucide-react";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { ContactsHeader } from "@/components/contacts-tabs";
import { DayBars, type Series, TrendChart } from "@/components/metric-charts";
import { Page, Section, TableCard } from "@/components/page";
import { Card } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
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
import { growthPageFn } from "@/functions/newsletters";
import { useMe } from "@/lib/me";
import { Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/contacts/growth")({
	validateSearch: z.object({
		brand: z.string().optional(),
		days: z.number().int().optional(),
	}),
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => growthPageFn({ data: { brand: deps.brand, days: deps.days ?? 30 } }),
	head: () => ({ meta: [{ title: "Growth · Mailroom" }] }),
	component: GrowthPage,
	pendingComponent: GrowthSketch,
});

type Data = Awaited<ReturnType<typeof growthPageFn>>;

function GrowthSketch() {
	const days = 30;
	return (
		<Sketch
			data={
				{
					brand: "",
					brands: [],
					referrals: { referred: 0, referrers: 0 },
					growth: {
						days,
						start: "",
						subscribed: 1200,
						total: 1300,
						joined: 80,
						left: 12,
						net: 68,
						growth_rate: 0.05,
						churn_rate: 0.01,
						series: Array.from({ length: days }, (_, i) => ({
							day: new Date(Date.now() - (days - 1 - i) * 86_400_000)
								.toISOString()
								.slice(0, 10),
							joined: 0,
							left: 0,
							net: 0,
							subscribed: 0,
						})),
						sources: [],
						details: [],
					},
				} satisfies Data
			}
		>
			<GrowthPage />
		</Sketch>
	);
}

const pct = (n: number | null, digits = 1) =>
	n === null ? "–" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;

const SERIES: Series[] = [
	{ key: "joined", label: "Joined", color: "var(--success)" },
	{ key: "left", label: "Unsubscribed", color: "var(--destructive)" },
];

const RANGES: [string, string][] = [
	["7", "Last 7 days"],
	["30", "Last 30 days"],
	["90", "Last 90 days"],
	["365", "Last 12 months"],
];

function GrowthPage() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const g = data.growth;
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, ...next }, replace: true });
	const stats: [string, string, string | null, "up" | "down" | null][] = [
		["Subscribed now", g.subscribed.toLocaleString(), null, null],
		[
			"Net growth",
			`${g.net > 0 ? "+" : ""}${g.net.toLocaleString()}`,
			pct(g.growth_rate),
			g.net > 0 ? "up" : g.net < 0 ? "down" : null,
		],
		["Joined", g.joined.toLocaleString(), null, null],
		[
			"Unsubscribed",
			g.left.toLocaleString(),
			g.churn_rate === null ? null : `${(g.churn_rate * 100).toFixed(1)}% churn`,
			null,
		],
	];
	const best = g.sources[0];
	return (
		<Page>
			<ContactsHeader
				current="growth"
				brand={search.brand}
				filters={
					<>
						<Select
							value={String(search.days ?? 30)}
							onValueChange={(v) => go({ days: Number(v) })}
						>
							<SelectTrigger
								aria-label="Period"
								className="w-40"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{RANGES.map(([v, l]) => (
									<SelectItem
										key={v}
										value={v}
									>
										{l}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<BrandFilter
							brands={me.brands}
							value={search.brand}
							all={null}
							onChange={(b) => go({ brand: b })}
						/>
					</>
				}
			/>
			<p className="-mt-2 max-w-3xl text-sm text-muted-foreground">
				Who joined your list and who left, day by day, and where new subscribers came from:
				each sign-up form, referrals, imports and your app.
			</p>

			<Card className="gap-0 p-0">
				<div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-xl bg-border/70 lg:grid-cols-4">
					{stats.map(([k, v, sub, dir]) => (
						<div
							key={k}
							className="flex flex-col gap-1 bg-card px-5 py-4"
						>
							<span className="text-xs text-muted-foreground">{k}</span>
							<span className="flex items-baseline gap-2">
								<span className="text-2xl font-semibold tabular-nums">
									<Ph>{v}</Ph>
								</span>
								{sub && (
									<span
										className={cn(
											"flex items-center gap-1 text-xs tabular-nums",
											dir === "up"
												? "text-success"
												: dir === "down"
													? "text-destructive"
													: "text-muted-foreground",
										)}
									>
										{dir === "up" && <TrendingUp className="size-3" />}
										{dir === "down" && <TrendingDown className="size-3" />}
										<Ph>{sub}</Ph>
									</span>
								)}
							</span>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-2 border-t border-border/70 px-5 pt-4 pb-3">
					<p className="text-sm font-medium">Subscribed contacts</p>
					<TrendChart
						data={g.series.map((s) => ({ day: s.day, value: s.subscribed }))}
						label="Subscribed"
						color="var(--chart-1)"
						format={(v) => v.toLocaleString()}
						height={200}
					/>
				</div>
				<div className="flex flex-col gap-2 border-t border-border/70 px-5 pt-4 pb-3">
					<p className="text-sm font-medium">Joined and unsubscribed each day</p>
					<DayBars
						data={g.series}
						series={SERIES}
						format={(v) => v.toLocaleString()}
						footer={null}
						height={160}
						total={{
							label: "Net",
							value: (r) => {
								const n = Number(r.joined ?? 0) - Number(r.left ?? 0);
								return `${n > 0 ? "+" : ""}${n.toLocaleString()}`;
							},
						}}
					/>
				</div>
			</Card>

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<Section
					title="Where they came from"
					description={
						best
							? `Most new subscribers came from ${best.label.replace(/^Form: /, "the form ")}.`
							: "New contacts in this period, by how they were added."
					}
				>
					<TableCard>
						<Table className="table-fixed">
							<TableHeader>
								<TableRow>
									<TableHead>Source</TableHead>
									<TableHead className="w-24 text-right">Joined</TableHead>
									<TableHead className="w-28 text-right">
										Still subscribed
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{g.sources.length === 0 ? (
									<TableRow>
										<TableCell
											colSpan={3}
											className="h-20 text-center text-muted-foreground"
										>
											Nobody joined in this period.
										</TableCell>
									</TableRow>
								) : (
									g.sources.map((s) => (
										<TableRow key={s.source ?? "none"}>
											<TableCell className="h-12">
												<span className="flex min-w-0 items-center gap-2.5">
													{(() => {
														const Icon = {
															form: NotebookPen,
															referral: Gift,
															import: FileUp,
															api: Code,
															dashboard: UserPlus,
															mcp: Bot,
															event: Zap,
															unknown: HelpCircle,
														}[s.kind];
														return (
															<Icon className="size-4 shrink-0 text-muted-foreground" />
														);
													})()}
													<span className="truncate">
														<Ph>{s.label}</Ph>
													</span>
												</span>
											</TableCell>
											<TableCell className="text-right tabular-nums">
												<Ph>{s.joined.toLocaleString()}</Ph>
											</TableCell>
											<TableCell className="text-right text-muted-foreground tabular-nums">
												<Ph>
													{s.joined
														? `${Math.round((s.stayed / s.joined) * 100)}%`
														: "–"}
												</Ph>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</TableCard>
				</Section>
				<Section
					title="Websites and campaigns"
					description="The utm_source of the page someone signed up on, or the website the form was on."
				>
					<TableCard>
						<Table className="table-fixed">
							<TableBody>
								{g.details.length === 0 ? (
									<TableRow>
										<TableCell className="h-20 text-center text-muted-foreground">
											No sign-ups with a website or utm_source yet.
										</TableCell>
									</TableRow>
								) : (
									g.details.map((d) => (
										<TableRow key={d.detail}>
											<TableCell className="h-11 truncate">
												<Ph>{d.detail}</Ph>
											</TableCell>
											<TableCell className="w-20 text-right tabular-nums">
												<Ph>{d.joined.toLocaleString()}</Ph>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</TableCard>
					<p className="text-xs text-muted-foreground">
						<Ph>
							All time: {data.referrals.referred.toLocaleString()}{" "}
							{data.referrals.referred === 1 ? "subscriber" : "subscribers"} credited
							to {data.referrals.referrers.toLocaleString()}{" "}
							{data.referrals.referrers === 1 ? "referrer" : "referrers"}. The table
							counts this period's sign-ups.
						</Ph>
					</p>
				</Section>
			</div>
		</Page>
	);
}
