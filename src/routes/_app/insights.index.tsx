import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronRight, Coins } from "lucide-react";
import type { ReactNode } from "react";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { CopyButton } from "@/components/copy";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
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
import { getInsights } from "@/functions/insights";
import { formatMoney, formatNumber, formatPercent, formatSeconds } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
import { PROVIDER_LABEL, type Provider } from "@/lib/providers";
import {
	Ph,
	pick,
	rememberedRows,
	Sketch,
	SketchWhile,
	sample,
	usePage,
	useRememberRows,
} from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/insights/")({
	validateSearch: z.object({
		days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(),
		brand: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({ days: search.days ?? 30, brand: search.brand }),
	loader: ({ deps }) => getInsights({ data: { days: deps.days, brand: deps.brand } }),
	pendingMs: Number.POSITIVE_INFINITY,
	head: () => ({ meta: [{ title: "Insights · Mailroom" }] }),
	component: Insights,
	pendingComponent: InsightsSketch,
});

type Data = Awaited<ReturnType<typeof getInsights>>;
type Stats = Data["byStream"][number];

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
};
const LATENCY = { count: 1000, median: 4, p90: 12, p99: 60, slowShare: 0.01 };

function InsightsSketch() {
	const { search } = usePage(Route);
	return (
		<Sketch
			data={{
				byStream: [
					{ stream: "transactional", ...STATS },
					{ stream: "marketing", ...STATS },
				],
				latency: {
					all: { provider: "all", ...LATENCY },
					byProvider: sample(rememberedRows("insights:providers", 4), (i) => ({
						provider: pick(i, ["gmail", "outlook", "yahoo", "icloud", "other"]),
						...LATENCY,
					})),
				},
				byTemplate: sample(rememberedRows("insights:templates", 3), (i) => ({
					id: `sketch-${i}`,
					name: pick(i, ["Welcome", "Password reset", "Booking confirmed"]),
					alias: null,
					...STATS,
				})),
				byTag: sample(rememberedRows("insights:tags", 3), (i) => ({
					name: "category",
					value: pick(i, ["receipt", "login", "reminder"]),
					...STATS,
				})),
				brands: sample(rememberedRows("insights:brands", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
				})),
				brand: search.brand ?? null,
				testAddress: "brand@in.example.com",
				revenue: { currency: null, totals: [] },
				gmail: rememberedRows("insights:gmail", 0)
					? sample(rememberedRows("insights:gmail", 0), (i) => ({
							id: `sketch-${i}`,
							domain: pick(i, ["mail.example.com", "news.example.com"]),
							needsWork: [],
							status: "verified",
							error: null,
							checked_at: null,
							latest: {
								day: "2026-01-01",
								spam_rate: 0.0004,
								spf_rate: 1,
								dkim_rate: 1,
								dmarc_rate: 1,
								tls_rate: 1,
								delivery_error_rate: 0.001,
							},
							spamAverage: 0.0004,
							spam: "ok",
							series: [],
							compliance: null,
						}))
					: null,
			}}
		>
			<Insights />
		</Sketch>
	);
}

const tone = (level: "ok" | "warning" | "danger") =>
	level === "danger"
		? "text-destructive"
		: level === "warning"
			? "text-warning"
			: "text-muted-foreground";

function Insights() {
	const { data, search: shown } = usePage(Route);
	const pending = usePendingSearch(shown);
	const { search } = pending;
	const days = Number(search.days ?? 30) as 7 | 30 | 90;
	const navigate = Route.useNavigate();
	const router = useRouter();
	const range = (v: number) => (v === 30 ? undefined : (v as 7 | 90));
	const known = !pending.loading;
	useRememberRows("insights:brands", data.brands.length);
	useRememberRows("insights:providers", known ? data.latency.byProvider.length : undefined);
	useRememberRows("insights:templates", known ? data.byTemplate.length : undefined);
	useRememberRows("insights:tags", known ? data.byTag.length : undefined);
	useRememberRows("insights:gmail", known ? (data.gmail?.length ?? 0) : undefined);
	return (
		<Page>
			<PageHeader
				title="Insights"
				description="How each kind of email does: transactional and marketing apart, each template and tag, and how long emails take to arrive."
				actions={
					<>
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
									search: { ...search, days: range(Number(v)) },
									replace: true,
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
												to: "/insights",
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
				<RevenueCard
					revenue={data.revenue}
					search={search}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					{data.byStream.map((s) => (
						<StreamCard
							key={s.stream}
							s={s}
						/>
					))}
				</div>
				<TimeToInbox
					latency={data.latency}
					search={search}
				/>
				<Section
					title="By template"
					description="Emails sent with a template (from the API, automations or broadcasts). Click one for its overview."
				>
					<StatsTable
						label="Template"
						empty="No emails were sent with a template in this range."
						rows={data.byTemplate.map((t) => ({
							key: t.id,
							stats: t,
							name: (
								<Link
									to="/insights/$kind/$key"
									params={{ kind: "template", key: t.id }}
									search={{ days: search.days, brand: search.brand }}
									className="font-medium hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
								>
									<Ph>{t.name}</Ph>
								</Link>
							),
						}))}
					/>
				</Section>
				<Section
					title="By tag"
					description="The tags your app sends with each email (category: receipt). Click one for its overview."
				>
					<StatsTable
						label="Tag"
						empty="No emails with tags in this range. Send them with tags: [{ name, value }]."
						rows={data.byTag.map((t) => ({
							key: `${t.name}:${t.value}`,
							stats: t,
							name: (
								<Link
									to="/insights/$kind/$key"
									params={{ kind: "tag", key: `${t.name}:${t.value}` }}
									search={{ days: search.days, brand: search.brand }}
									className="font-mono text-[13px] hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
								>
									<Ph>
										{t.name}: {t.value}
									</Ph>
								</Link>
							),
						}))}
					/>
				</Section>
				{data.gmail && <Gmail rows={data.gmail} />}
				{data.testAddress && <TestAddress address={data.testAddress} />}
			</SketchWhile>
		</Page>
	);
}

/** Revenue in the range and what email and chat earned, linking to the Revenue page. */
function RevenueCard({
	revenue,
	search,
}: {
	revenue: Data["revenue"];
	search: { days?: number; brand?: string };
}) {
	const main = revenue.totals[0];
	const days = search.days === 7 || search.days === 90 ? search.days : undefined;
	return (
		<Card className="flex-row flex-wrap items-center justify-between gap-3 px-5 py-4">
			<div className="flex min-w-0 items-center gap-3">
				<Coins className="size-5 shrink-0 text-muted-foreground" />
				<div className="min-w-0">
					<p className="font-medium">Revenue</p>
					<p className="text-sm text-muted-foreground">
						{main ? (
							<Ph>
								{formatMoney(main.total, main.currency)} from{" "}
								{formatNumber(main.purchases)}{" "}
								{main.purchases === 1 ? "purchase" : "purchases"},{" "}
								{formatMoney(main.credited, main.currency)} of it earned by email
								and chat.
							</Ph>
						) : (
							"Send purchases as events with a value to see what your emails and chats earn."
						)}
					</p>
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				asChild
			>
				<Link
					to="/insights/revenue"
					search={{ days, brand: search.brand }}
				>
					See revenue
					<ChevronRight />
				</Link>
			</Button>
		</Card>
	);
}

const REQUIREMENT: Record<string, string> = {
	SPF: "SPF",
	DKIM: "DKIM",
	SPF_AND_DKIM: "SPF and DKIM",
	DMARC_POLICY: "a DMARC policy",
	DMARC_ALIGNMENT: "DMARC alignment",
	MESSAGE_FORMATTING: "message format",
	DNS_RECORDS: "DNS records",
	ENCRYPTION: "TLS",
	USER_REPORTED_SPAM_RATE: "spam rate",
	ONE_CLICK_UNSUBSCRIBE: "one-click unsubscribe",
	HONOR_UNSUBSCRIBE: "honoring unsubscribes",
};

const rate = (v: number | null | undefined, digits = 1) =>
	v === null || v === undefined ? "—" : formatPercent(v, digits);

/** Gmail Postmaster Tools: what Gmail itself sees of each sending domain. */
function Gmail({ rows }: { rows: NonNullable<Data["gmail"]> }) {
	return (
		<Section
			title="Gmail"
			description="From Gmail Postmaster Tools: the share of Gmail recipients who marked your email as spam (keep it under 0.1%, never reach 0.3%), Gmail's authentication and TLS rates, and its bulk-sender rules. Gmail only reports domains with enough daily volume."
		>
			<TableCard>
				{rows.length === 0 ? (
					<p className="px-5 py-8 text-center text-sm text-muted-foreground">
						No verified sending domains yet.
					</p>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Domain</TableHead>
								<TableHead className="w-24 text-right">Spam rate</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Average
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									DMARC
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									TLS
								</TableHead>
								<TableHead className="hidden w-56 lg:table-cell">
									Bulk-sender rules
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((g) => (
								<TableRow
									key={g.domain}
									className="relative"
								>
									<TableCell className="truncate">
										<Link
											to="/domains/$id"
											params={{ id: g.id }}
											className="font-medium hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
										>
											<Ph>{g.domain}</Ph>
										</Link>
										{g.status !== "verified" && (
											<span className="block text-xs text-muted-foreground">
												{g.status === "pending"
													? "Add the Gmail TXT record on its page"
													: "Registered with Google on the next check"}
											</span>
										)}
									</TableCell>
									<TableCell
										className={cn(
											"text-right tabular-nums",
											g.spam === "unknown"
												? "text-muted-foreground"
												: tone(g.spam),
										)}
										title={g.latest?.day ? `On ${g.latest.day}` : undefined}
									>
										<Ph>{rate(g.latest?.spam_rate, 2)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
										<Ph>{rate(g.spamAverage, 2)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
										<Ph>{rate(g.latest?.dmarc_rate)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
										<Ph>{rate(g.latest?.tls_rate)}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden truncate lg:table-cell",
											g.needsWork?.length
												? "text-warning"
												: "text-muted-foreground",
										)}
									>
										<Ph>
											{g.needsWork === null
												? "—"
												: g.needsWork.length
													? `Needs ${g.needsWork.map((r) => REQUIREMENT[r] ?? r).join(", ")}`
													: "Meets them"}
										</Ph>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Section>
	);
}

/** mail-tester's idea with the brand's own Mailroom address: every received email gets a report. */
function TestAddress({ address }: { address: string }) {
	return (
		<Card className="flex-row flex-wrap items-center justify-between gap-3 px-5 py-4">
			<div className="min-w-0">
				<p className="font-medium">Test an email before it goes out</p>
				<p className="text-sm text-muted-foreground">
					Send it to this address, then open it in Received and pick Deliverability: SPF,
					DKIM and DMARC alignment, one-click unsubscribe, links, images and content,
					scored out of 10.
				</p>
			</div>
			<div className="flex min-w-0 items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					asChild
				>
					<Link to="/received">Received</Link>
				</Button>
				<CopyButton value={address} />
				<code className="min-w-0 truncate font-mono text-[13px]">
					<Ph>{address}</Ph>
				</code>
			</div>
		</Card>
	);
}

function StreamCard({ s }: { s: Stats }) {
	const marketing = s.stream === "marketing";
	return (
		<Card className="gap-0 p-0">
			<div className="px-5 pt-4 pb-3">
				<p className="text-[13px] text-muted-foreground">
					{marketing ? "Marketing" : "Transactional"}
				</p>
				<p className="text-sm text-faint">
					{marketing
						? "Newsletters and broadcasts, from marketing domains."
						: "Receipts, codes and the rest your app sends."}
				</p>
			</div>
			<dl className="grid grid-cols-3 gap-y-3 border-t border-border/70 px-5 py-4 text-sm sm:grid-cols-3">
				<Figure label="Sent">{formatNumber(s.sent)}</Figure>
				<Figure label="Delivered">{formatPercent(s.deliveryRate, 1)}</Figure>
				<Figure label="Opened">{formatPercent(s.openRate, 1)}</Figure>
				<Figure
					label="Bounced"
					className={tone(s.bounce)}
				>
					{formatPercent(s.bounceRate, 2)}
				</Figure>
				<Figure
					label="Spam reports"
					className={tone(s.complaint)}
				>
					{formatPercent(s.complaintRate, 2)}
				</Figure>
				<Figure label="Clicked">{formatPercent(s.clickRate, 1)}</Figure>
			</dl>
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
		<div>
			<dt className="text-xs text-faint">{label}</dt>
			<dd className={cn("mt-0.5 font-medium tabular-nums", className)}>
				<Ph>{children}</Ph>
			</dd>
		</div>
	);
}

function TimeToInbox({
	latency,
	search,
}: {
	latency: Data["latency"];
	search: { days?: 7 | 30 | 90; brand?: string };
}) {
	const a = latency.all;
	return (
		<Section
			title="Time to inbox"
			description="From SES taking an email to the recipient's server accepting it, over the latest 5,000 delivered emails (broadcasts aside). Mailroom emails owners when it gets slow."
		>
			<TableCard>
				{a.count === 0 ? (
					<p className="px-5 py-8 text-center text-sm text-muted-foreground">
						No delivered emails in this range.
					</p>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Provider</TableHead>
								<TableHead className="w-24 text-right">Typical</TableHead>
								<TableHead className="w-24 text-right">1 in 10</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									1 in 100
								</TableHead>
								<TableHead className="hidden w-28 text-right md:table-cell">
									Over a minute
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{[a, ...latency.byProvider].map((l) => (
								<TableRow
									key={l.provider}
									className="relative"
								>
									<TableCell
										className={cn(l.provider === "all" && "font-medium")}
									>
										{l.provider === "all" ? (
											<Ph>All providers</Ph>
										) : (
											<Link
												to="/insights/$kind/$key"
												params={{ kind: "provider", key: l.provider }}
												search={{ days: search.days, brand: search.brand }}
												className="hover:underline outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
											>
												<Ph>{PROVIDER_LABEL[l.provider as Provider]}</Ph>
											</Link>
										)}
										<span className="ml-2 text-xs text-faint tabular-nums">
											<Ph>{formatNumber(l.count)}</Ph>
										</span>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Ph>{formatSeconds(l.median)}</Ph>
									</TableCell>
									<TableCell className="text-right text-muted-foreground tabular-nums">
										<Ph>{formatSeconds(l.p90)}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
										<Ph>{formatSeconds(l.p99)}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden text-right tabular-nums md:table-cell",
											l.slowShare > 0.1
												? "text-warning"
												: "text-muted-foreground",
										)}
									>
										<Ph>{formatPercent(l.slowShare, 1)}</Ph>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Section>
	);
}

function StatsTable({
	label,
	rows,
	empty,
}: {
	label: string;
	rows: { key: string; name: ReactNode; stats: Omit<Stats, "stream"> }[];
	empty: string;
}) {
	return (
		<TableCard>
			{rows.length === 0 ? (
				<p className="px-5 py-8 text-center text-sm text-muted-foreground">{empty}</p>
			) : (
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>{label}</TableHead>
							<TableHead className="w-20 text-right">Sent</TableHead>
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
							<TableHead className="hidden w-24 text-right md:table-cell">
								Clicked
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map(({ key, name, stats: s }) => (
							<TableRow
								key={key}
								className="relative"
							>
								<TableCell className="truncate">{name}</TableCell>
								<TableCell className="text-right tabular-nums">
									<Ph>{formatNumber(s.sent)}</Ph>
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
								<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
									<Ph>{formatPercent(s.clickRate, 1)}</Ph>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</TableCard>
	);
}
