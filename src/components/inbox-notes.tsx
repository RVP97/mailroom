import { CircleAlert, Info, MailCheck } from "lucide-react";
import { useMemo } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { CLIENTS, type InboxClient, inboxNotes } from "@/lib/inbox-preview";
import { cn } from "@/lib/utils";

/** Which inbox the preview shows the email in. */
export function ClientSelect({
	value,
	onChange,
}: {
	value: InboxClient;
	onChange: (c: InboxClient) => void;
}) {
	return (
		<Select
			value={value}
			onValueChange={(v) => onChange(v as InboxClient)}
		>
			<SelectTrigger
				size="sm"
				aria-label="Inbox"
				className="h-7 w-auto gap-1 border-0 bg-muted px-2 text-xs shadow-none"
			>
				<SelectValue>{CLIENTS.find((c) => c.id === value)?.label}</SelectValue>
			</SelectTrigger>
			<SelectContent align="end">
				{CLIENTS.map((c) => (
					<SelectItem
						key={c.id}
						value={c.id}
					>
						<span className="flex flex-col">
							<span>{c.label}</span>
							<span className="text-xs text-muted-foreground">{c.hint}</span>
						</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

/** What the big inboxes show differently in this email. */
export function InboxNotes({ html }: { html: string }) {
	const notes = useMemo(() => inboxNotes(html), [html]);
	return (
		<div className="border-t border-border/70 px-5 py-3">
			<p className="mb-2 flex items-center gap-1.5 text-xs font-medium">
				<MailCheck className="size-3.5 text-muted-foreground" />
				Across inboxes
			</p>
			{notes.length === 0 ? (
				<p className="text-xs text-muted-foreground">
					Nothing here that Gmail, Outlook or Apple Mail show differently.
				</p>
			) : (
				<ul className="flex flex-col gap-2">
					{notes.map((n) => (
						<li
							key={n.title}
							className="flex gap-2 text-xs"
						>
							{n.level === "warn" ? (
								<CircleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
							) : (
								<Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
							)}
							<span>
								<span
									className={cn(
										"font-medium",
										n.level === "warn" && "text-foreground",
									)}
								>
									{n.title}.
								</span>{" "}
								<span className="text-muted-foreground">{n.detail}</span>
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
