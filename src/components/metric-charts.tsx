import { ArrowUpRight } from "lucide-react";
import { useId, useState } from "react";
import {
	Area,
	AreaChart,
	Bar,
	BarChart,
	CartesianGrid,
	ReferenceLine,
	XAxis,
	YAxis,
} from "recharts";
import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Overview's charts: one area for a metric over time (with the period before as a dashed line)
 * and bars, stacked or single, with a reference line. Every day (and every segment) is a link:
 * clicking it opens the emails behind it. Marks follow one spec: 2px lines, bars with 3px
 * rounded ends and a 2px gap between stacked segments, the hovered day lit and the rest dimmed.
 */

export type Series = { key: string; label: string; color: string };

type Row = { day: string } & Record<string, number | string | undefined>;

/** What recharts hands a chart's mouse handlers. */
type ChartState = { activeLabel?: string | number; activeTooltipIndex?: number | string | null };

const compact = (v: number) =>
	v >= 1000
		? `${(v / 1000).toLocaleString(undefined, { maximumFractionDigits: v >= 10_000 ? 0 : 1 })}k`
		: String(v);

const dayOf = (data: Row[], s: ChartState | null | undefined) => {
	if (typeof s?.activeLabel === "string") return s.activeLabel;
	const i = Number(s?.activeTooltipIndex);
	return Number.isInteger(i) ? (data[i]?.day ?? null) : null;
};

const indexOf = (s: ChartState | null | undefined) => {
	const i = Number(s?.activeTooltipIndex);
	return Number.isInteger(i) && i >= 0 ? i : null;
};

/** The card a hovered day shows: its date, each series with its swatch, and where a click goes. */
function TooltipCard({
	title,
	rows,
	total,
	footer,
}: {
	title: string;
	rows: {
		key: string;
		label: string;
		value: string;
		sub?: string;
		color: string;
		dashed?: boolean;
		strong?: boolean;
	}[];
	/** The rows added up, under a rule like a receipt's total. */
	total?: { label: string; value: string } | null;
	footer?: string | null;
}) {
	return (
		<div className="min-w-48 overflow-hidden rounded-lg bg-popover text-xs text-popover-foreground shadow-[0_0_0_1px_var(--border-strong),0_8px_24px_-6px_var(--shadow-color-strong)]">
			<p className="border-b border-border/70 px-3 py-2 font-medium">{title}</p>
			<div className="grid gap-1.5 px-3 py-2">
				{rows.map((r) => (
					<div
						key={r.key}
						className={cn(
							"flex items-center justify-between gap-4 transition-opacity",
							r.strong === false && "opacity-55",
						)}
					>
						<span className="flex items-center gap-2 text-muted-foreground">
							{r.dashed ? (
								<span
									className="h-0 w-2.5 border-t-2 border-dashed"
									style={{ borderColor: r.color }}
								/>
							) : (
								<span
									className="size-2.5 rounded-[3px]"
									style={{ background: r.color }}
								/>
							)}
							{r.label}
						</span>
						<span className="flex items-baseline gap-1.5 tabular-nums">
							<span className="font-medium text-foreground">{r.value}</span>
							{r.sub && <span className="text-faint">{r.sub}</span>}
						</span>
					</div>
				))}
				{total && (
					<div className="mt-0.5 flex items-center justify-between gap-4 border-t border-border/70 pt-2">
						<span className="font-medium text-foreground">{total.label}</span>
						<span className="font-semibold text-foreground tabular-nums">
							{total.value}
						</span>
					</div>
				)}
			</div>
			{footer && (
				<p className="flex items-center gap-1 border-t border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
					{footer}
					<ArrowUpRight className="size-3" />
				</p>
			)}
		</div>
	);
}

const axisProps = {
	tickLine: false,
	axisLine: false,
	tick: { fontSize: 11, fill: "var(--faint)" },
} as const;

/** A metric day by day as a smooth area, the period before as a dashed line under it. */
export function TrendChart({
	data,
	label,
	color,
	format,
	formatAxis = compact,
	previousLabel = "Period before",
	footer,
	onPick,
	height = 240,
	fraction = false,
}: {
	data: { day: string; value: number; previous?: number; previousDay?: string; sub?: string }[];
	label: string;
	color: string;
	format: (v: number) => string;
	formatAxis?: (v: number) => string;
	previousLabel?: string;
	footer?: string;
	onPick?: (day: string) => void;
	height?: number;
	/** Values are rates between 0 and 1: decimal ticks, the axis's top no higher than 100%. */
	fraction?: boolean;
}) {
	const id = useId().replace(/:/g, "");
	const config = { value: { label, color } } satisfies ChartConfig;
	return (
		<ChartContainer
			config={config}
			className={cn("aspect-auto w-full", onPick && "[&_.recharts-surface]:cursor-pointer")}
			style={{ height }}
		>
			<AreaChart
				data={data}
				margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
				onClick={(s) => {
					const day = dayOf(data as Row[], s as ChartState);
					if (day && onPick) onPick(day);
				}}
			>
				<defs>
					<linearGradient
						id={`fill-${id}`}
						x1="0"
						y1="0"
						x2="0"
						y2="1"
					>
						<stop
							offset="0"
							stopColor={color}
							stopOpacity={0.26}
						/>
						<stop
							offset="0.95"
							stopColor={color}
							stopOpacity={0}
						/>
					</linearGradient>
				</defs>
				<CartesianGrid
					vertical={false}
					stroke="var(--border)"
				/>
				<XAxis
					dataKey="day"
					{...axisProps}
					tickMargin={10}
					minTickGap={32}
					tickFormatter={formatDay}
				/>
				<YAxis
					{...axisProps}
					width={44}
					tickCount={4}
					allowDecimals={fraction}
					domain={
						fraction ? [0, (max: number) => Math.min(1, niceFraction(max))] : undefined
					}
					tickFormatter={formatAxis}
				/>
				<ChartTooltip
					cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
					content={({ active, payload }) => {
						const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
						if (!active || !p) return null;
						return (
							<TooltipCard
								title={formatDay(p.day)}
								rows={[
									{
										key: "value",
										label,
										value: format(p.value),
										sub: p.sub,
										color,
									},
									...(p.previous !== undefined
										? [
												{
													key: "previous",
													label: p.previousDay
														? formatDay(p.previousDay)
														: previousLabel,
													value: format(p.previous),
													color: "var(--faint)",
													dashed: true,
												},
											]
										: []),
								]}
								footer={onPick ? (footer ?? "Click to see these emails") : null}
							/>
						);
					}}
				/>
				<Area
					dataKey="previous"
					type="monotone"
					stroke="var(--faint)"
					strokeOpacity={0.7}
					strokeWidth={1.5}
					strokeDasharray="3 4"
					fill="none"
					dot={false}
					activeDot={false}
					isAnimationActive={false}
				/>
				<Area
					dataKey="value"
					type="monotone"
					stroke={color}
					strokeWidth={2}
					fill={`url(#fill-${id})`}
					dot={false}
					activeDot={{ r: 4.5, strokeWidth: 2, stroke: "var(--card)", fill: color }}
					animationDuration={500}
					animationEasing="ease-out"
				/>
			</AreaChart>
		</ChartContainer>
	);
}

/** A rate axis's top: the next of 10%, 20%, 25%, 40%, 50%, 100% above the highest value. */
const niceFraction = (max: number) =>
	[0.1, 0.2, 0.25, 0.4, 0.5, 0.75, 1].find((m) => m >= max) ?? 1;

/** A bar with every corner rounded, inset so stacked segments keep a 2px gap between them. */
function RoundedBar(props: {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	fill?: string;
	index?: number;
	active: number | null;
	onEnter?: () => void;
}) {
	const { x = 0, y = 0, width = 0, fill, index, active } = props;
	const height = Math.max(0, (props.height ?? 0) - 2);
	if (height <= 0 || width <= 0) return null;
	const r = Math.min(3, width / 2, height / 2);
	return (
		<rect
			x={x}
			y={y + 2}
			width={width}
			height={height}
			rx={r}
			ry={r}
			fill={fill}
			opacity={active === null || active === index ? 1 : 0.38}
			style={{ transition: "opacity 150ms ease-out" }}
			onMouseEnter={props.onEnter}
		/>
	);
}

/**
 * Bars day by day: one series or several stacked. Hovering a day lights it; clicking a
 * segment opens that series' emails of that day (a day's empty space, all of them).
 */
export function DayBars({
	data,
	series,
	format,
	formatAxis = compact,
	sub,
	reference,
	maxDomain,
	footer = "Click to see these emails",
	onPick,
	height = 160,
	total,
}: {
	data: Row[];
	series: Series[];
	format: (v: number) => string;
	formatAxis?: (v: number) => string;
	/** A note beside a series' value in the tooltip ("12 of 3,400"). */
	sub?: (row: Row, key: string) => string | undefined;
	/** A line across the chart, like SES's review threshold. Left out when above the bars. */
	reference?: { value: number; label: string; color: string };
	/** The axis's top at least this high. */
	maxDomain?: number;
	footer?: string | null;
	onPick?: (day: string, key: string | null) => void;
	height?: number;
	/** A total under the tooltip's rows. */
	total?: { label: string; value: (row: Row) => string };
}) {
	const [active, setActive] = useState<number | null>(null);
	const [hoverKey, setHoverKey] = useState<string | null>(null);
	const config = Object.fromEntries(
		series.map((s) => [s.key, { label: s.label, color: s.color }]),
	) satisfies ChartConfig;
	const top = Math.max(
		maxDomain ?? 0,
		...data.map((r) => series.reduce((sum, s) => sum + (Number(r[s.key]) || 0), 0)),
	);
	const domainTop = niceTop(top * 1.1);
	const showReference = reference && reference.value <= domainTop;
	return (
		<ChartContainer
			config={config}
			className={cn("aspect-auto w-full", onPick && "[&_.recharts-surface]:cursor-pointer")}
			style={{ height }}
		>
			<BarChart
				data={data}
				margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
				barCategoryGap={data.length > 45 ? "14%" : data.length > 14 ? "22%" : "34%"}
				onMouseMove={(s) => setActive(indexOf(s as ChartState))}
				onMouseLeave={() => {
					setActive(null);
					setHoverKey(null);
				}}
				onClick={(s) => {
					const day = dayOf(data, s as ChartState);
					if (day && onPick) onPick(day, hoverKey);
				}}
			>
				<CartesianGrid
					vertical={false}
					stroke="var(--border)"
				/>
				<XAxis
					dataKey="day"
					{...axisProps}
					tickMargin={10}
					minTickGap={32}
					tickFormatter={formatDay}
				/>
				<YAxis
					{...axisProps}
					width={44}
					tickCount={4}
					domain={[0, domainTop]}
					ticks={[0, domainTop / 2, domainTop]}
					tickFormatter={formatAxis}
				/>
				<ChartTooltip
					cursor={false}
					content={({ active: on, payload }) => {
						const row = payload?.[0]?.payload as Row | undefined;
						if (!on || !row) return null;
						return (
							<TooltipCard
								title={formatDay(row.day)}
								total={total && { label: total.label, value: total.value(row) }}
								rows={[
									...series.map((s) => ({
										key: s.key,
										label: s.label,
										value: format(Number(row[s.key]) || 0),
										sub: sub?.(row, s.key),
										color: s.color,
										strong:
											hoverKey && series.length > 1
												? hoverKey === s.key
												: undefined,
									})),
								]}
								footer={
									onPick && footer
										? hoverKey && series.length > 1
											? `Click to see ${series.find((s) => s.key === hoverKey)?.label.toLowerCase()}`
											: footer
										: null
								}
							/>
						);
					}}
				/>
				{showReference && (
					<ReferenceLine
						y={reference.value}
						stroke={reference.color}
						strokeDasharray="4 4"
						strokeOpacity={0.8}
						ifOverflow="extendDomain"
						label={(p: { viewBox?: { x?: number; y?: number; width?: number } }) => (
							<text
								x={(p.viewBox?.x ?? 0) + (p.viewBox?.width ?? 0) - 4}
								y={(p.viewBox?.y ?? 0) - 6}
								textAnchor="end"
								fontSize={10}
								fontWeight={500}
								fill={reference.color}
								stroke="var(--card)"
								strokeWidth={4}
								paintOrder="stroke"
							>
								{reference.label}
							</text>
						)}
					/>
				)}
				{series.map((s) => (
					<Bar
						key={s.key}
						dataKey={s.key}
						stackId="a"
						fill={s.color}
						maxBarSize={28}
						isAnimationActive={false}
						shape={(p: unknown) => (
							<RoundedBar
								{...(p as Parameters<typeof RoundedBar>[0])}
								active={active}
								onEnter={() => setHoverKey(s.key)}
							/>
						)}
					/>
				))}
			</BarChart>
		</ChartContainer>
	);
}

/** A round axis top (1, 2, 2.5, 4 or 5 times a power of ten), so its middle tick is round too. */
function niceTop(v: number) {
	if (!(v > 0)) return 1;
	const mag = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 2, 2.5, 4, 5, 10]) if (m * mag >= v) return m * mag;
	return 10 * mag;
}

/**
 * A change against the period before: green when it went the good way, red the bad; plain for
 * volumes, where more or fewer is neither.
 */
export function Delta({
	now,
	before,
	kind,
	goodWhen = "up",
}: {
	now: number;
	before: number;
	/** "count": percent change; "rate": percentage points. */
	kind: "count" | "rate";
	goodWhen?: "up" | "down" | "neutral";
}) {
	if (kind === "count" && before === 0) return null;
	const diff = kind === "count" ? (now - before) / before : (now - before) * 100;
	if (!Number.isFinite(diff)) return null;
	const flat = Math.abs(diff) < (kind === "count" ? 0.005 : 0.005);
	const good = flat ? null : diff > 0 === (goodWhen === "up");
	const text =
		kind === "count"
			? `${diff > 0 ? "+" : ""}${(diff * 100).toLocaleString(undefined, { maximumFractionDigits: Math.abs(diff) < 0.1 ? 1 : 0 })}%`
			: `${diff > 0 ? "+" : ""}${diff.toLocaleString(undefined, { maximumFractionDigits: Math.abs(diff) < 0.1 ? 2 : 1 })} pts`;
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-full px-1.5 text-[11px] font-medium tabular-nums",
				flat || goodWhen === "neutral"
					? "bg-muted text-muted-foreground"
					: good
						? "bg-success/12 text-success"
						: "bg-destructive/12 text-destructive",
			)}
			title="Against the same number of days just before"
		>
			{flat ? "No change" : text}
		</span>
	);
}
