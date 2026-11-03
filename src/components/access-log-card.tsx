import { Link } from "@tanstack/react-router";
import { Bot, KeyRound, MonitorSmartphone } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAgo, formatDateTime } from "@/lib/format";
import { Ph } from "@/lib/sketch";

const ACTION: Record<string, string> = {
	recipient_lookup: "looked up",
	suppression_removed: "let receive again",
	unsubscribe_removed: "subscribed again",
};

const CHANNEL = {
	dashboard: { icon: MonitorSmartphone, label: "Dashboard" },
	api: { icon: KeyRound, label: "API" },
	assistant: { icon: Bot, label: "Assistant (MCP)" },
} as const;

/**
 * Who looked up a recipient or let one receive again, and how (dashboard, API, assistant): the
 * trail support work leaves. Browsing emails isn't logged.
 */
export function AccessLogCard({
	rows,
}: {
	rows: {
		id: string;
		action: string;
		subject: string;
		channel: string;
		who: string;
		created_at: string;
	}[];
}) {
	const now = Date.now();
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="pb-4">
				<CardTitle>Access log</CardTitle>
				<CardDescription>
					Who looked up a recipient or let one receive email again, the last 200.
				</CardDescription>
			</CardHeader>
			{rows.length === 0 ? (
				<p className="border-t border-border/70 px-5 py-6 text-center text-sm text-muted-foreground">
					Nothing yet. Recipient lookups and removed suppressions show up here.
				</p>
			) : (
				<ul className="max-h-96 overflow-y-auto border-t border-border/70">
					{rows.map((r) => {
						const ch = CHANNEL[r.channel as keyof typeof CHANNEL] ?? CHANNEL.dashboard;
						return (
							<li
								key={r.id}
								className="flex items-center gap-3 border-b border-border/70 px-5 py-2.5 text-sm last:border-0"
							>
								<ch.icon
									aria-label={ch.label}
									className="size-4 shrink-0 text-faint"
								/>
								<p className="min-w-0 flex-1 truncate">
									<Ph>
										<span className="font-medium">{r.who}</span>{" "}
										<span className="text-muted-foreground">
											{ACTION[r.action] ?? r.action}
										</span>{" "}
										<Link
											to="/recipients"
											search={{ address: r.subject }}
											className="underline-offset-4 hover:underline"
										>
											{r.subject}
										</Link>
									</Ph>
								</p>
								<span
									className="shrink-0 text-xs text-muted-foreground tabular-nums"
									title={formatDateTime(r.created_at)}
								>
									<Ph>{formatAgo(r.created_at, now)}</Ph>
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</Card>
	);
}
