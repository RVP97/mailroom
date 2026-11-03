import { CircleAlert, CircleCheck, Info } from "lucide-react";
import { useMemo } from "react";
import { type ContentInput, checkContent } from "@/lib/content-check";

/** What the content check finds, under an editor's preview. */
export function ContentChecks({ subject, html, text, marketing }: ContentInput) {
	const findings = useMemo(
		() => checkContent({ subject, html, text, marketing }),
		[subject, html, text, marketing],
	);
	return (
		<div className="border-t border-border/70 px-5 py-3 text-xs">
			{findings.length === 0 ? (
				<p className="flex items-center gap-2 text-muted-foreground">
					<CircleCheck className="size-3.5 text-success" />
					Nothing here that inboxes usually hold against an email.
				</p>
			) : (
				<ul className="flex flex-col gap-1.5">
					{findings.map((f) => (
						<li
							key={f.code}
							className="flex items-start gap-2"
						>
							{f.level === "warning" ? (
								<CircleAlert className="mt-px size-3.5 shrink-0 text-warning" />
							) : (
								<Info className="mt-px size-3.5 shrink-0 text-muted-foreground" />
							)}
							<span className={f.level === "note" ? "text-muted-foreground" : ""}>
								{f.message}
							</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
