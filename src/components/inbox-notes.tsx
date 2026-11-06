import { CircleAlert, Info, MailCheck, PenLine } from "lucide-react";
import { useMemo } from "react";
import { siApple, siGmail } from "simple-icons";
import { CLIENTS, type InboxClient, inboxNotes } from "@/lib/inbox-preview";
import { cn } from "@/lib/utils";

/** Each inbox's mark, small, for the picker. */
function ClientMark({ id }: { id: InboxClient }) {
	if (id === "gmail")
		return (
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				className="size-3.5 shrink-0"
				fill={`#${siGmail.hex}`}
			>
				<path d={siGmail.path} />
			</svg>
		);
	if (id === "apple")
		return (
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
				className="size-3.5 shrink-0"
				fill="currentColor"
			>
				<path d={siApple.path} />
			</svg>
		);
	if (id === "outlook")
		return (
			<span
				aria-hidden="true"
				className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-[#0078D4] text-[8.5px] leading-none font-bold text-white"
			>
				O
			</span>
		);
	return (
		<PenLine
			aria-hidden="true"
			className="size-3.5 shrink-0"
		/>
	);
}

const SHORT: Record<InboxClient, string> = {
	default: "As written",
	gmail: "Gmail",
	outlook: "Outlook",
	apple: "Apple Mail",
};

/**
 * Which inbox the preview shows the email in: every choice in sight as a segmented bar with
 * each inbox's mark, and what that inbox changes under it.
 */
export function ClientSelect({
	value,
	onChange,
	className,
}: {
	value: InboxClient;
	onChange: (c: InboxClient) => void;
	className?: string;
}) {
	const hint = CLIENTS.find((c) => c.id === value)?.hint;
	return (
		<div className={cn("flex flex-col gap-1.5", className)}>
			<fieldset className="m-0 grid min-w-0 grid-cols-4 gap-0.5 rounded-lg border-0 bg-muted p-0.5">
				<legend className="sr-only">Show it as</legend>
				{CLIENTS.map((c) => {
					const on = c.id === value;
					return (
						<button
							key={c.id}
							type="button"
							aria-pressed={on}
							title={`${c.label}: ${c.hint}`}
							onClick={() => onChange(c.id)}
							className={cn(
								"flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
								on &&
									"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
							)}
						>
							<span className={cn("flex", !on && c.id !== "default" && "opacity-70")}>
								<ClientMark id={c.id} />
							</span>
							<span className="truncate max-[380px]:hidden">{SHORT[c.id]}</span>
						</button>
					);
				})}
			</fieldset>
			<p className="truncate px-1 text-xs text-muted-foreground">{hint}</p>
		</div>
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
