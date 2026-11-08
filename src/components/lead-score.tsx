import { Link } from "@tanstack/react-router";
import { Flame } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export type LeadLevel = "hot" | "warm" | "cold";

export const LEAD: Record<LeadLevel, { label: string; tone: string; dot: string }> = {
	hot: {
		label: "Hot",
		tone: "bg-red-500/12 text-red-700 dark:text-red-300",
		dot: "bg-red-500",
	},
	warm: {
		label: "Warm",
		tone: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
		dot: "bg-amber-500",
	},
	cold: {
		label: "Cold",
		tone: "bg-sky-500/12 text-sky-800 dark:text-sky-300",
		dot: "bg-sky-500",
	},
};

export function LeadBadge({ level, score }: { level: LeadLevel; score?: number }) {
	const m = LEAD[level];
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
				m.tone,
			)}
		>
			<span className={cn("size-1.5 rounded-full", m.dot)} />
			{m.label}
			{score !== undefined && <span className="tabular-nums opacity-80">{score}</span>}
		</span>
	);
}

/** A contact's lead score: the total, its level and what each rule gave. */
export function LeadCard({
	lead,
	brand,
}: {
	lead: {
		score: number;
		level: LeadLevel;
		hot: number;
		warm: number;
		days: number;
		breakdown: { rule: string; points: number }[];
	};
	brand: string;
}) {
	const toHot = Math.max(0, lead.hot - lead.score);
	const pct = Math.min(100, Math.round((lead.score / Math.max(1, lead.hot)) * 100));
	return (
		<Card className="gap-4 p-5">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-1.5 font-semibold">
						<Flame className="size-4 text-muted-foreground" />
						Lead score
					</h2>
					<p className="mt-0.5 text-xs text-muted-foreground">
						Points for what they did in the last {lead.days} days.
					</p>
				</div>
				<div className="flex flex-col items-end gap-1">
					<span className="text-2xl font-semibold tabular-nums">
						<Ph>{lead.score}</Ph>
					</span>
					<LeadBadge level={lead.level} />
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				<div className="h-1.5 overflow-hidden rounded-full bg-muted">
					<div
						className={cn("h-full rounded-full", LEAD[lead.level].dot)}
						style={{ width: `${pct}%` }}
					/>
				</div>
				<p className="text-xs text-muted-foreground">
					{toHot === 0
						? `A hot lead (${lead.hot}+ points).`
						: `${toHot} points from hot (${lead.hot}); warm from ${lead.warm}.`}
				</p>
			</div>
			{lead.breakdown.length > 0 ? (
				<ul className="flex flex-col gap-1.5 text-sm">
					{lead.breakdown.map((b) => (
						<li
							key={b.rule}
							className="flex items-center justify-between gap-3"
						>
							<span className="truncate text-muted-foreground">{b.rule}</span>
							<span
								className={cn(
									"shrink-0 font-medium tabular-nums",
									b.points < 0 && "text-red-600 dark:text-red-400",
								)}
							>
								{b.points > 0 ? "+" : ""}
								{b.points}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-sm text-muted-foreground">Nothing that scores points yet.</p>
			)}
			<Link
				to="/contacts/leads"
				search={{ brand }}
				className="border-t border-border/70 pt-3 text-xs text-muted-foreground hover:text-foreground"
			>
				How leads are scored
			</Link>
		</Card>
	);
}
