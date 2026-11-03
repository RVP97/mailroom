import type { LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";
import { CopyIcon, useCopy } from "@/components/copy";
import { statusTone } from "@/components/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDateTime, formatStamp, middle } from "@/lib/format";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * The pieces of a record page (an email, a domain): a stamp with what it is, a grid of facts,
 * a timeline of what happened, then tabs. One template, so every record reads the same way.
 */

export type Tone = "brand" | "green" | "blue" | "amber" | "red" | "gray";

/** A status's colour as a record tone. */
export const toneOf = (status: string): Tone => {
	const t = statusTone(status);
	return t === "faint" ? "gray" : t;
};

const STAMP: Record<Tone, [string, string]> = {
	brand: ["#4b82ff", "#2150e6"],
	blue: ["#4b82ff", "#2150e6"],
	green: ["#34c27f", "#178a52"],
	amber: ["#f3b33d", "#c5820e"],
	red: ["#f2575f", "#c42a3b"],
	gray: ["#6b7280", "#3d424c"],
};

/** Holes along the edge, `n` to a side, on a 0–32 square. */
const holes = (n: number) => {
	const out: [number, number][] = [];
	for (let i = 0; i <= n; i++) {
		const p = (32 / n) * i;
		out.push([p, 0], [p, 32]);
		if (i > 0 && i < n) out.push([0, p], [32, p]);
	}
	return out;
};
const HOLES = holes(6);

/** A perforated stamp in a status colour with an icon on it: Mailroom's take on an icon tile. */
export function Stamp({
	icon: Icon,
	tone = "brand",
	className,
}: {
	icon: LucideIcon;
	tone?: Tone;
	className?: string;
}) {
	const id = useId();
	const [from, to] = STAMP[tone];
	return (
		<span
			data-ph
			className={cn("relative flex size-12 shrink-0 items-center justify-center", className)}
		>
			<svg
				viewBox="0 0 32 32"
				className="absolute inset-0 size-full"
				aria-hidden="true"
			>
				<defs>
					<mask id={`${id}-m`}>
						<rect
							width="32"
							height="32"
							fill="#fff"
						/>
						{HOLES.map(([cx, cy]) => (
							<circle
								key={`${cx}-${cy}`}
								cx={cx}
								cy={cy}
								r="1.45"
								fill="#000"
							/>
						))}
					</mask>
					<linearGradient
						id={`${id}-g`}
						x1="0"
						y1="0"
						x2="0"
						y2="1"
					>
						<stop
							offset="0"
							stopColor={from}
						/>
						<stop
							offset="1"
							stopColor={to}
						/>
					</linearGradient>
				</defs>
				<rect
					width="32"
					height="32"
					fill={`url(#${id}-g)`}
					mask={`url(#${id}-m)`}
				/>
				<rect
					x="4"
					y="4"
					width="24"
					height="24"
					rx="1.2"
					fill="none"
					stroke="#fff"
					strokeOpacity=".2"
					strokeWidth=".6"
				/>
			</svg>
			<Icon
				className="relative size-[42%] text-white"
				strokeWidth={2}
			/>
		</span>
	);
}

/** Stamp, what kind of record, and its name. Actions sit on the right (below on phones). */
export function RecordHeader({
	icon,
	tone,
	kind,
	title,
	actions,
}: {
	icon: LucideIcon;
	tone?: Tone;
	kind: string;
	title: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<header className="flex items-center gap-4">
			<div className="flex min-w-0 flex-1 items-center gap-3.5 sm:gap-4">
				<Stamp
					icon={icon}
					tone={tone}
					className="size-11 sm:size-14"
				/>
				<div className="min-w-0">
					<p className="text-sm text-muted-foreground">{kind}</p>
					<h1 className="truncate text-xl font-semibold tracking-[-0.018em] sm:text-2xl">
						<Ph>{title}</Ph>
					</h1>
				</div>
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</header>
	);
}

/** Facts about a record in columns, each under a small uppercase label. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<dl
			className={cn(
				"grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-4",
				className,
			)}
		>
			{children}
		</dl>
	);
}

export function Fact({
	label,
	children,
	className,
}: {
	label: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("min-w-0", className)}>
			<dt className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				{label}
			</dt>
			<dd className="mt-1.5 min-w-0 truncate text-sm">
				<Ph>{children}</Ph>
			</dd>
		</div>
	);
}

/** An id in a chip: shortened in the middle, copied whole on click. */
export function IdChip({ value, className }: { value: string; className?: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			data-ph
			type="button"
			title={copied ? "Copied" : `Copy ${value}`}
			onClick={() => copy(value)}
			className={cn(
				"pressable inline-flex h-6 max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md bg-muted px-2 font-mono text-xs text-foreground/90 shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground",
				className,
			)}
		>
			<span className="truncate">{middle(value, 10, 6)}</span>
			<CopyIcon
				copied={copied}
				className="size-3 text-faint"
			/>
		</button>
	);
}

export type Step = {
	key: string;
	label: string;
	icon: LucideIcon;
	tone: Tone;
	at?: string | null;
	/** What this step means, on hover. */
	hint?: string;
	/** A step that hasn't happened yet: drawn hollow. */
	waiting?: boolean;
};

const STEP_TONE: Record<Tone, { tile: string; pill: string }> = {
	brand: { tile: "bg-brand/12 text-brand", pill: "bg-brand/10 text-brand" },
	blue: { tile: "bg-brand/12 text-brand", pill: "bg-brand/10 text-brand" },
	green: { tile: "bg-success/12 text-success", pill: "bg-success/10 text-success" },
	amber: {
		tile: "bg-warning/14 text-warning",
		pill: "bg-warning/12 text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]",
	},
	red: { tile: "bg-destructive/12 text-destructive", pill: "bg-destructive/10 text-destructive" },
	gray: {
		tile: "bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
		pill: "bg-muted text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]",
	},
};

/** What happened, left to right, on a dotted panel. Scrolls sideways when it's long. */
export function Timeline({ title, steps }: { title: string; steps: Step[] }) {
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				{title}
			</h2>
			<div className="relative overflow-hidden rounded-xl bg-card shadow-card">
				<div
					aria-hidden="true"
					className="absolute inset-0 [background-image:radial-gradient(color-mix(in_oklch,var(--foreground)_10%,transparent)_1px,transparent_1px)] [background-size:16px_16px]"
				/>
				<ol className="relative flex flex-col px-5 py-5 sm:flex-row sm:overflow-x-auto sm:[scrollbar-width:none]">
					{steps.map((s, i) => {
						const tone = STEP_TONE[s.tone];
						const step = (
							<div className="flex items-center gap-3 sm:flex-col sm:items-start sm:gap-2.5">
								<span
									data-ph
									className={cn(
										"relative z-10 flex size-8 items-center justify-center rounded-lg bg-card",
										s.waiting
											? "text-faint shadow-[inset_0_0_0_1px_var(--border-strong)] [border-style:dashed]"
											: tone.tile,
									)}
								>
									<s.icon className="size-4" />
								</span>
								<span
									data-ph
									className={cn(
										"inline-flex h-5 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap",
										s.waiting
											? "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]"
											: tone.pill,
									)}
								>
									{s.label}
								</span>
								<time
									dateTime={s.at ?? undefined}
									className="ml-auto text-xs whitespace-nowrap sm:ml-0 text-muted-foreground tabular-nums"
								>
									<Ph>{s.at ? formatStamp(s.at) : "Not yet"}</Ph>
								</time>
							</div>
						);
						return (
							<li
								key={s.key}
								className="relative pb-4 last:pb-0 sm:w-40 sm:shrink-0 sm:pb-0 sm:last:w-auto"
							>
								{i < steps.length - 1 && (
									<span
										aria-hidden="true"
										className={cn(
											"absolute top-10 bottom-1 left-4 w-px sm:top-4 sm:right-3 sm:bottom-auto sm:left-11 sm:h-px sm:w-auto",
											steps[i + 1]?.waiting
												? "bg-[repeating-linear-gradient(180deg,var(--border-strong)_0_4px,transparent_4px_8px)] sm:bg-[repeating-linear-gradient(90deg,var(--border-strong)_0_4px,transparent_4px_8px)]"
												: "bg-border-strong",
										)}
									/>
								)}
								{s.hint || s.at ? (
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												className="w-full cursor-default rounded-md text-left outline-none sm:w-auto focus-visible:ring-2 focus-visible:ring-ring"
											>
												{step}
											</button>
										</TooltipTrigger>
										<TooltipContent className="max-w-64">
											{s.hint}
											{s.hint && s.at ? <br /> : null}
											{s.at && (
												<span className="font-normal opacity-70">
													{formatDateTime(s.at)}
												</span>
											)}
										</TooltipContent>
									</Tooltip>
								) : (
									step
								)}
							</li>
						);
					})}
				</ol>
			</div>
		</section>
	);
}
