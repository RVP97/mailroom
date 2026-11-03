import { Link } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import type { Me } from "@/lib/me";

/**
 * Why sending stopped, above every page: a brand or domain paused (by your team, by Mailroom's
 * auto-pause, or by SES), with a link to where it's fixed. Nothing shows while all is sending.
 */
export function StoppedBanner({ me }: { me: Me }) {
	const several = me.brands.length > 1;
	const lines: { key: string; text: string; to: string; params?: { id: string } }[] = [];
	for (const b of me.brands) {
		const name = several ? b.name : "Sending";
		if (b.paused)
			lines.push({
				key: `b-${b.id}`,
				text:
					b.paused.by === "mailroom"
						? `${name} is paused by Mailroom${b.paused.reason ? `: ${b.paused.reason}` : ""}.`
						: `${name} is paused by your team. Queued emails wait until it's resumed.`,
				to: "/brands/$id",
				params: { id: b.id },
			});
		else if (b.sesStatus && b.sesStatus !== "ENABLED" && b.sesStatus !== "REINSTATED")
			lines.push({
				key: `s-${b.id}`,
				text: `Amazon SES paused ${several ? b.name : "this organization"}'s sending: its bounces or complaints went over SES's limits.`,
				to: "/brands/$id",
				params: { id: b.id },
			});
	}
	for (const d of me.pausedDomains)
		lines.push({
			key: `d-${d.id}`,
			text:
				d.reason === "unknown_recipients"
					? `Mailroom paused ${d.name}: too many emails to addresses that don't exist.`
					: d.reason === "sending_limits"
						? `Mailroom paused ${d.name}: its bounces or complaints went over the sending limits.`
						: `${d.name} is paused by your team.`,
			to: "/domains/$id",
			params: { id: d.id },
		});
	if (!lines.length) return null;
	return (
		<div
			role="status"
			className="flex flex-col gap-1 border-b border-[color-mix(in_oklch,var(--warning)_30%,transparent)] bg-warning/[0.08] px-4 py-2.5 text-sm md:px-10 lg:rounded-t-xl"
		>
			{lines.slice(0, 3).map((l) => (
				<p
					key={l.key}
					className="flex items-start gap-2"
				>
					<CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
					<span className="min-w-0 flex-1">
						{l.text}{" "}
						<Link
							to={l.to}
							params={l.params}
							className="font-medium underline underline-offset-4"
						>
							See why
						</Link>
					</span>
				</p>
			))}
			{lines.length > 3 && (
				<p className="pl-6 text-xs text-muted-foreground">
					And {lines.length - 3} more paused.
				</p>
			)}
		</div>
	);
}
