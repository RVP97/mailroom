import { Link } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { LeadBadge, type LeadLevel } from "@/components/lead-score";
import { Card } from "@/components/ui/card";
import { formatAgo, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface AcrossBrand {
	brand_id: string;
	brand: string | null;
	contact: { id: string; unsubscribed: boolean; created_at: string } | null;
	emails: { sent: number; opened: number; clicked: number; last_at: string | null };
	conversations: { total: number; open: number; last_at: string | null };
	lead: { score: number; level: LeadLevel } | null;
	follow_ups: number;
	suppressed: string | null;
	spent: { currency: string | null; value: number; purchases: number }[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The same person in each of the organization's brands, side by side: each brand keeps its own
 * contact and consent, so this only shows them together.
 */
export function PersonAcrossCard({
	across,
	current,
}: {
	across: { brands: AcrossBrand[]; totals: { brands: number } };
	current: string;
}) {
	const others = across.brands.filter((b) => b.brand_id !== current);
	return (
		<Card className="gap-4 p-5">
			<div>
				<h2 className="flex items-center gap-2 font-semibold">
					<Building2 className="size-4 text-muted-foreground" />
					Across your brands
				</h2>
				<p className="text-sm text-muted-foreground">
					{others.length
						? `Also known to ${plural(others.length, "other brand")}. Each keeps its own consent.`
						: "Only this brand knows them."}
				</p>
			</div>
			<ul className="flex flex-col divide-y">
				{across.brands.map((b) => {
					const here = b.brand_id === current;
					const facts = [
						b.emails.sent
							? `${plural(b.emails.sent, "email")}, ${b.emails.opened} opened`
							: null,
						b.conversations.total
							? `${plural(b.conversations.total, "conversation")}${b.conversations.open ? ` (${b.conversations.open} open)` : ""}`
							: null,
						...b.spent.map((s) => `spent ${formatMoney(s.value, s.currency)}`),
						b.follow_ups ? plural(b.follow_ups, "follow-up") : null,
					].filter(Boolean);
					const last = [b.emails.last_at, b.conversations.last_at]
						.filter(Boolean)
						.sort()
						.pop();
					const status = b.suppressed
						? { text: "Blocked", tone: "text-destructive" }
						: !b.contact
							? { text: "Not a contact", tone: "text-muted-foreground" }
							: b.contact.unsubscribed
								? { text: "Unsubscribed", tone: "text-muted-foreground" }
								: {
										text: "Subscribed",
										tone: "text-emerald-700 dark:text-emerald-400",
									};
					const name = (
						<span className="font-medium">
							{b.brand ?? "This brand"}
							{here && (
								<span className="font-normal text-muted-foreground">
									{" "}
									· this one
								</span>
							)}
						</span>
					);
					return (
						<li
							key={b.brand_id}
							className={cn(
								"flex flex-col gap-1 py-2.5 text-sm first:pt-0 last:pb-0",
							)}
						>
							<div className="flex items-center justify-between gap-2">
								{b.contact && !here ? (
									<Link
										to="/contacts/$id"
										params={{ id: b.contact.id }}
										search={{ brand: b.brand_id }}
										className="underline-offset-2 hover:underline"
									>
										{name}
									</Link>
								) : (
									name
								)}
								<span className="flex items-center gap-2">
									{b.lead && b.lead.score > 0 && (
										<LeadBadge
											level={b.lead.level}
											score={b.lead.score}
										/>
									)}
									<span className={cn("text-xs", status.tone)}>
										{status.text}
									</span>
								</span>
							</div>
							<p className="text-xs text-muted-foreground">
								{facts.length ? facts.join(" · ") : "Nothing sent or received yet"}
								{last ? ` · last ${formatAgo(last)}` : ""}
							</p>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
