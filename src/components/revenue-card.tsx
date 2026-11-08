import { Link } from "@tanstack/react-router";
import { ChevronRight, Coins } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney, formatNumber } from "@/lib/format";
import { Ph } from "@/lib/sketch";

export type Money = { currency: string | null; total: number; purchases: number };

/** What a broadcast, automation or campaign earned (src/server/revenue.ts), when it earned any. */
export function RevenueCard({ revenue, what }: { revenue: Money[]; what: string }) {
	if (!revenue.length) return null;
	const [main, ...rest] = revenue;
	if (!main) return null;
	return (
		<Card className="flex-row flex-wrap items-center justify-between gap-3 px-5 py-4">
			<div className="flex min-w-0 items-start gap-3">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/12 text-amber-600 dark:text-amber-400">
					<Coins className="size-[18px]" />
				</span>
				<div className="min-w-0">
					<h2 className="font-semibold tabular-nums">
						<Ph>
							{formatMoney(main.total, main.currency)} from{" "}
							{formatNumber(main.purchases)}{" "}
							{main.purchases === 1 ? "purchase" : "purchases"}
						</Ph>
						{rest.length > 0 && (
							<span className="font-normal text-muted-foreground">
								{" "}
								and {rest.map((m) => formatMoney(m.total, m.currency)).join(", ")}
							</span>
						)}
					</h2>
					<p className="text-sm text-muted-foreground">
						Purchases made within 7 days of opening or clicking {what}, when it was the
						last thing that reached them.
					</p>
				</div>
			</div>
			<Button
				variant="outline"
				size="sm"
				asChild
			>
				<Link to="/insights/revenue">
					All revenue
					<ChevronRight />
				</Link>
			</Button>
		</Card>
	);
}
