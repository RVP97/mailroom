import { Inbox, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** What a domain is for, as badges: Sending (with its purpose when marketing), Receiving. */
export function Uses({
	domain: d,
	compact,
}: {
	domain: { sending: boolean; receiving: boolean; purpose: string };
	/** As a short line of text, for a narrow row. */
	compact?: boolean;
}) {
	if (compact)
		return (
			<span
				data-ph
				className="truncate text-xs text-muted-foreground"
			>
				{[d.sending && "Sending", d.receiving && "Receiving"].filter(Boolean).join(" · ")}
			</span>
		);
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			{d.sending && (
				<Badge
					data-ph
					variant={d.purpose === "marketing" ? "outline" : "secondary"}
					className={cn(
						"gap-1",
						d.purpose === "marketing" && "border-brand/40 text-brand",
					)}
				>
					<Send className="size-3" />
					{d.purpose === "marketing" ? "Sending · Marketing" : "Sending"}
				</Badge>
			)}
			{d.receiving && (
				<Badge
					data-ph
					variant="secondary"
					className="gap-1"
				>
					<Inbox className="size-3" />
					Receiving
				</Badge>
			)}
		</span>
	);
}
