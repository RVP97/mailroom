import { Card } from "@/components/ui/card";
import { MIN_EMAILS } from "@/lib/engagement";
import { formatAgo, formatDateTime } from "@/lib/format";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** A contact's engagement (src/server/engagement.ts): a five-bar meter, its level, its numbers. */

export type Level = "champion" | "engaged" | "cooling" | "cold" | "new";

export type EngagementView = {
	score: number | null;
	level: Level;
	stars: number;
	sent?: number;
	opened?: number;
	clicked?: number;
	last_sent_at?: string | null;
	last_engaged_at?: string | null;
};

export const LEVEL: Record<Level, { label: string; bar: string; text: string; hint: string }> = {
	champion: {
		label: "Very engaged",
		bar: "bg-emerald-500",
		text: "text-emerald-700 dark:text-emerald-300",
		hint: "Opens and clicks often, and lately",
	},
	engaged: {
		label: "Engaged",
		bar: "bg-sky-500",
		text: "text-sky-700 dark:text-sky-300",
		hint: "Opens a good share of what you send",
	},
	cooling: {
		label: "Losing interest",
		bar: "bg-amber-500",
		text: "text-amber-700 dark:text-amber-300",
		hint: "Opens less, or not lately",
	},
	cold: {
		label: "Cold",
		bar: "bg-rose-500",
		text: "text-rose-700 dark:text-rose-300",
		hint: "Hardly opens or clicks anymore",
	},
	new: {
		label: "Too new to tell",
		bar: "bg-muted-foreground/40",
		text: "text-muted-foreground",
		hint: `Fewer than ${MIN_EMAILS} emails so far`,
	},
};

const emails = (n: number) => (n === 1 ? "email" : "emails");

export function EngagementMeter({
	e,
	label = true,
	className,
}: {
	e: EngagementView | null;
	label?: boolean;
	className?: string;
}) {
	const level = e?.level ?? "new";
	const m = LEVEL[level];
	return (
		<span
			className={cn("inline-flex items-center gap-2", className)}
			title={
				e?.score !== null && e?.score !== undefined
					? `${m.label} · ${e.score}/100`
					: m.label
			}
		>
			<span
				className="flex items-end gap-[3px]"
				aria-hidden
			>
				{[0, 1, 2, 3, 4].map((i) => (
					<span
						key={i}
						className={cn(
							"w-[4px] rounded-full",
							i < (e?.stars ?? 0) ? m.bar : "bg-border-strong",
						)}
						style={{ height: 6 + i * 2.5 }}
					/>
				))}
			</span>
			{label && <span className={cn("text-xs font-medium", m.text)}>{m.label}</span>}
		</span>
	);
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/** The engagement card on a contact's page. */
export function EngagementCard({ e }: { e: EngagementView | null }) {
	const level = e?.level ?? "new";
	const m = LEVEL[level];
	const sent = e?.sent ?? 0;
	const opened = e?.opened ?? 0;
	const clicked = e?.clicked ?? 0;
	const tooFew = e?.score === null || e?.score === undefined;
	const hint = tooFew
		? `Not enough data yet: scored after ${MIN_EMAILS} emails${sent ? ` (${sent} so far)` : ""}`
		: m.hint;
	return (
		<Card className="gap-4 p-5">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">Engagement</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						From broadcasts and automations in the last 90 days.
					</p>
				</div>
				<div className="flex flex-col items-end gap-1">
					<span className="text-2xl font-semibold tabular-nums">
						<Ph>{e?.score ?? "–"}</Ph>
						{e?.score !== null && e?.score !== undefined && (
							<span className="text-sm font-normal text-muted-foreground">/100</span>
						)}
					</span>
				</div>
			</div>
			<div className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3.5 py-3">
				<EngagementMeter e={e} />
				<span className="text-right text-xs text-muted-foreground">{hint}</span>
			</div>
			<dl className="grid grid-cols-3 gap-3 text-sm">
				{(
					[
						["Got", String(sent), emails(sent)],
						// A rate from one or two emails says nothing: just the count until there's enough.
						["Opened", tooFew ? String(opened) : pct(opened, sent), `of ${sent}`],
						["Clicked", tooFew ? String(clicked) : pct(clicked, sent), `of ${sent}`],
					] as const
				).map(([k, v, sub]) => (
					<div
						key={k}
						className="flex flex-col gap-0.5"
					>
						<dt className="text-xs text-muted-foreground">{k}</dt>
						<dd className="text-lg font-semibold tabular-nums">
							<Ph>{v}</Ph>
						</dd>
						<dd className="text-xs text-muted-foreground tabular-nums">{sub}</dd>
					</div>
				))}
			</dl>
			<p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">
				{e?.last_engaged_at ? (
					<>
						Last opened or clicked{" "}
						<span title={formatDateTime(e.last_engaged_at)}>
							{formatAgo(e.last_engaged_at)} ago
						</span>
						.
					</>
				) : sent ? (
					sent === 1 ? (
						"Hasn't opened or clicked it."
					) : (
						"Hasn't opened or clicked any of them."
					)
				) : (
					"No broadcast or automation email yet."
				)}
			</p>
		</Card>
	);
}
