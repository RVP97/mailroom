import { ExternalLink } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** A sent broadcast's report: opens and clicks over time, the click map, and email apps. */

export type Report = {
	links: { url: string; clicks: number; people: number }[];
	timeline: { hour: string; opens: number; clicks: number }[];
	apps: { name: string; opens: number }[];
};

const OPENS = "var(--chart-1)";
const CLICKS = "var(--chart-3)";

const hourLabel = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric" });

export function BroadcastReport({
	report,
	html,
	sent,
}: {
	report: Report;
	/** The email as sent (for the click map). */
	html: string;
	sent: number;
}) {
	return (
		<div className="flex flex-col gap-6">
			<Timeline report={report} />
			<ClickMap
				html={html}
				links={report.links}
				sent={sent}
			/>
			{report.apps.length > 0 && <Apps apps={report.apps} />}
		</div>
	);
}

function Timeline({ report }: { report: Report }) {
	const id = useId().replace(/:/g, "");
	const config = {
		opens: { label: "Opens", color: OPENS },
		clicks: { label: "Clicks", color: CLICKS },
	} satisfies ChartConfig;
	const total = report.timeline.reduce((a, r) => a + r.opens, 0);
	const peak = report.timeline.reduce(
		(best, r) => (r.opens > (best?.opens ?? 0) ? r : best),
		null as Report["timeline"][number] | null,
	);
	return (
		<Card className="gap-0 p-0">
			<div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-5 py-4">
				<div>
					<h2 className="text-sm font-semibold">Opens and clicks over time</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						First opens and clicks, hour by hour, for three days after it went.
					</p>
				</div>
				<div className="flex items-center gap-4 text-xs text-muted-foreground">
					{peak && total > 0 && (
						<span>
							Busiest: <Ph>{hourLabel(peak.hour)}</Ph>
						</span>
					)}
					<span className="flex items-center gap-1.5">
						<span
							className="size-2 rounded-full"
							style={{ background: OPENS }}
						/>
						Opens
					</span>
					<span className="flex items-center gap-1.5">
						<span
							className="size-2 rounded-full"
							style={{ background: CLICKS }}
						/>
						Clicks
					</span>
				</div>
			</div>
			<div className="px-3 pt-4 pb-2">
				<ChartContainer
					config={config}
					className="aspect-auto h-[220px] w-full"
				>
					<AreaChart
						data={report.timeline}
						margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
					>
						<defs>
							{(["opens", "clicks"] as const).map((k) => (
								<linearGradient
									key={k}
									id={`${k}-${id}`}
									x1="0"
									y1="0"
									x2="0"
									y2="1"
								>
									<stop
										offset="0"
										stopColor={k === "opens" ? OPENS : CLICKS}
										stopOpacity={0.24}
									/>
									<stop
										offset="0.95"
										stopColor={k === "opens" ? OPENS : CLICKS}
										stopOpacity={0}
									/>
								</linearGradient>
							))}
						</defs>
						<CartesianGrid
							vertical={false}
							stroke="var(--border)"
						/>
						<XAxis
							dataKey="hour"
							tickLine={false}
							axisLine={false}
							tick={{ fontSize: 11, fill: "var(--faint)" }}
							tickMargin={10}
							minTickGap={40}
							tickFormatter={hourLabel}
						/>
						<YAxis
							tickLine={false}
							axisLine={false}
							tick={{ fontSize: 11, fill: "var(--faint)" }}
							width={36}
							tickCount={4}
							allowDecimals={false}
						/>
						<ChartTooltip
							cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
							content={({ active, payload }) => {
								const p = payload?.[0]?.payload as
									| Report["timeline"][number]
									| undefined;
								if (!active || !p) return null;
								return (
									<div className="min-w-40 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-[0_0_0_1px_var(--border-strong),0_8px_24px_-6px_var(--shadow-color-strong)]">
										<p className="mb-1.5 font-medium">{hourLabel(p.hour)}</p>
										{(
											[
												["Opens", p.opens, OPENS],
												["Clicks", p.clicks, CLICKS],
											] as const
										).map(([l, v, c]) => (
											<p
												key={l}
												className="flex items-center justify-between gap-4"
											>
												<span className="flex items-center gap-2 text-muted-foreground">
													<span
														className="size-2 rounded-full"
														style={{ background: c }}
													/>
													{l}
												</span>
												<span className="font-medium tabular-nums">
													{v}
												</span>
											</p>
										))}
									</div>
								);
							}}
						/>
						{(["opens", "clicks"] as const).map((k) => (
							<Area
								key={k}
								dataKey={k}
								type="monotone"
								stroke={k === "opens" ? OPENS : CLICKS}
								strokeWidth={2}
								fill={`url(#${k}-${id})`}
								dot={false}
								activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
								animationDuration={500}
							/>
						))}
					</AreaChart>
				</ChartContainer>
			</div>
		</Card>
	);
}

const decode = (s: string) =>
	s
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");

/** The email with each clicked link marked by how many people clicked it. */
function marked(html: string, counts: Map<string, number>, sent: number, focus: string | null) {
	return html
		.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>[\s\S]*?<\/a>/gi, (whole, _q, href) => {
			const url = decode(String(href));
			const n = counts.get(url);
			if (n === undefined) return whole;
			const pct = sent ? `${((n / sent) * 100).toFixed(1)}%` : String(n);
			const on = focus === url;
			return `<span style="position:relative;display:inline-block;max-width:100%;border-radius:6px;box-shadow:0 0 0 ${on ? 3 : 2}px ${on ? "#f97316" : "rgba(249,115,22,.55)"};">${whole}<span style="position:absolute;top:-11px;right:-12px;z-index:5;background:#f97316;color:#fff;font:700 11px/1 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;padding:4px 7px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.25);white-space:nowrap;">${pct}</span></span>`;
		})
		.replace(/<\/head>/i, "<style>body{padding-top:6px}</style></head>");
}

function ClickMap({ html, links, sent }: { html: string; links: Report["links"]; sent: number }) {
	const [focus, setFocus] = useState<string | null>(null);
	const counts = useMemo(() => new Map(links.map((l) => [l.url, l.people])), [links]);
	const doc = useMemo(() => marked(html, counts, sent, focus), [html, counts, sent, focus]);
	const most = Math.max(1, ...links.map((l) => l.people));
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<div className="border-b border-border/70 px-5 py-4">
				<h2 className="text-sm font-semibold">Click map</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Each link marked with the share of recipients who clicked it.
				</p>
			</div>
			<div className="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
				<div className="border-border/70 bg-muted/50 lg:border-r">
					<iframe
						title="Click map"
						sandbox=""
						srcDoc={doc}
						className="block h-[720px] w-full bg-white"
					/>
				</div>
				<div className="flex min-w-0 flex-col">
					{links.length === 0 ? (
						<p className="px-5 py-10 text-center text-sm text-muted-foreground">
							No clicks yet.
						</p>
					) : (
						<ul className="flex flex-col">
							{links.map((l, i) => (
								<li
									key={l.url}
									onMouseEnter={() => setFocus(l.url)}
									onMouseLeave={() => setFocus(null)}
									className={cn(
										"flex flex-col gap-2 border-b border-border/70 px-5 py-3.5 transition-colors last:border-b-0",
										focus === l.url && "bg-muted/60",
									)}
								>
									<div className="flex items-center gap-3">
										<span className="w-4 text-xs text-muted-foreground tabular-nums">
											{i + 1}
										</span>
										<a
											href={l.url}
											target="_blank"
											rel="noreferrer"
											className="group flex min-w-0 flex-1 items-center gap-1.5 text-sm"
										>
											<span className="truncate">
												{l.url.replace(/^https?:\/\//, "")}
											</span>
											<ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
										</a>
										<span className="text-sm font-semibold tabular-nums">
											<Ph>{l.people.toLocaleString()}</Ph>
										</span>
									</div>
									<div className="ml-7 h-1.5 overflow-hidden rounded-full bg-muted">
										<div
											className="h-full rounded-full bg-orange-500"
											style={{ width: `${(l.people / most) * 100}%` }}
										/>
									</div>
									<p className="ml-7 text-xs text-muted-foreground tabular-nums">
										{l.clicks.toLocaleString()}{" "}
										{l.clicks === 1 ? "click" : "clicks"} ·{" "}
										{sent
											? `${((l.people / sent) * 100).toFixed(1)}% of recipients`
											: ""}
									</p>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
		</Card>
	);
}

function Apps({ apps }: { apps: Report["apps"] }) {
	const total = apps.reduce((a, x) => a + x.opens, 0) || 1;
	return (
		<Card className="gap-0 p-0">
			<div className="border-b border-border/70 px-5 py-4">
				<h2 className="text-sm font-semibold">Where it was read</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Email apps, from the opens. Apple Mail can open emails by itself, so its share
					runs high.
				</p>
			</div>
			<ul className="grid gap-x-8 gap-y-3 px-5 py-4 sm:grid-cols-2">
				{apps.slice(0, 8).map((a) => (
					<li
						key={a.name}
						className="flex flex-col gap-1.5"
					>
						<div className="flex items-center justify-between text-sm">
							<span>{a.name}</span>
							<span className="tabular-nums text-muted-foreground">
								{((a.opens / total) * 100).toFixed(0)}%
							</span>
						</div>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full"
								style={{ width: `${(a.opens / total) * 100}%`, background: OPENS }}
							/>
						</div>
					</li>
				))}
			</ul>
		</Card>
	);
}
