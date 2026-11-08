import { Link } from "@tanstack/react-router";
import { MailOpen, MousePointerClick, Send, Star, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { EngagementMeter, type EngagementView } from "@/components/engagement";
import { formatAgo, formatDateTime } from "@/lib/format";
import { Ph } from "@/lib/sketch";

/** What Mailroom knows about who wrote in (src/server/timeline.ts personPanel). */
export type Person = {
	email: string;
	suppressed: string | null;
	broadcasts: {
		id: string;
		subject: string;
		broadcast_id: string | null;
		opened_at: string | null;
		clicked_at: string | null;
		created_at: string;
	}[];
	last_rating: { rating: number; at: string | null } | null;
	holds?: {
		quiet: boolean;
		capped: boolean;
		cap: { count: number; days: number; sent: number } | null;
	};
	contact: {
		id: string;
		first_name: string | null;
		last_name: string | null;
		unsubscribed: boolean;
		created_at: string;
		source: string | null;
		properties: Record<string, string | number>;
		referrals: number;
	} | null;
	engagement?: EngagementView | null;
	segments?: { id: string; name: string }[];
	topics?: { id: string; name: string; subscription: "opt_in" | "opt_out" }[];
	newsletters?: { id: string; name: string }[];
	events?: { id: string; event: string; created_at: string }[];
};

function Line({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid min-h-7 grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-3">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="min-w-0 text-sm">{children}</dd>
		</div>
	);
}

const SUPPRESSED: Record<string, string> = {
	bounce: "Blocked: their address bounced",
	complaint: "Blocked: they marked an email as spam",
	manual: "Blocked by hand",
};

/**
 * The marketing side of the person beside a conversation: whether they can get email, how
 * engaged they are, the newsletters, segments and topics they're in, what they did with your
 * last broadcasts, their latest events in your app, and the last rating they gave support.
 */
export function PersonFacts({ p, brand }: { p: Person; brand: string }) {
	const c = p.contact;
	const topicsIn = (p.topics ?? []).filter((t) => t.subscription === "opt_in");
	const props = Object.entries(c?.properties ?? {}).slice(0, 6);
	return (
		<div className="flex flex-col gap-4">
			<dl className="flex flex-col gap-0.5">
				<Line label="Email">
					{p.suppressed ? (
						<span className="text-destructive">
							{SUPPRESSED[p.suppressed] ?? "Blocked"}
						</span>
					) : c?.unsubscribed ? (
						"Unsubscribed from broadcasts"
					) : c && p.holds?.quiet ? (
						<span className="text-warning">
							Quiet for now: no broadcasts or automation emails until this is sorted
						</span>
					) : c && p.holds?.capped ? (
						<span>
							Sits out broadcasts: got {p.holds.cap?.sent} in {p.holds.cap?.days} days
							(the cap is {p.holds.cap?.count})
						</span>
					) : c ? (
						"Gets your broadcasts"
					) : (
						<span className="text-muted-foreground">Not a contact yet</span>
					)}
				</Line>
				{c && (
					<Line label="Engaged">
						<EngagementMeter e={p.engagement ?? null} />
					</Line>
				)}
				{!!p.newsletters?.length && (
					<Line label="Reads">
						{p.newsletters.map((n, i) => (
							<span key={n.id}>
								{i > 0 && ", "}
								<Link
									to="/newsletters/$id"
									params={{ id: n.id }}
									className="underline-offset-2 hover:underline"
								>
									{n.name}
								</Link>
							</span>
						))}
					</Line>
				)}
				{!!p.segments?.length && (
					<Line label="Segments">
						<span className="line-clamp-2">
							{p.segments.map((s) => s.name).join(", ")}
						</span>
					</Line>
				)}
				{topicsIn.length > 0 && (
					<Line label="Topics">
						<span className="line-clamp-2">
							{topicsIn.map((t) => t.name).join(", ")}
						</span>
					</Line>
				)}
				{props.map(([k, v]) => (
					<Line
						key={k}
						label={k}
					>
						<span className="block truncate">
							<Ph>{String(v)}</Ph>
						</span>
					</Line>
				))}
				{c && c.referrals > 0 && (
					<Line label="Referred">
						{c.referrals} {c.referrals === 1 ? "friend" : "friends"}
					</Line>
				)}
				{p.last_rating && (
					<Line label="Rated">
						<span
							className="inline-flex items-center gap-1"
							title={p.last_rating.at ? formatDateTime(p.last_rating.at) : undefined}
						>
							<Star className="size-3.5 fill-warning text-warning" />
							{p.last_rating.rating} of 5
							{p.last_rating.at && (
								<span className="text-muted-foreground">
									{" "}
									· {formatAgo(p.last_rating.at)}
								</span>
							)}
						</span>
					</Line>
				)}
			</dl>

			{p.broadcasts.length > 0 && (
				<div className="flex flex-col gap-1">
					<h3 className="eyebrow mb-1">Last broadcasts</h3>
					<ul className="flex flex-col">
						{p.broadcasts.map((b) => {
							const Icon = b.clicked_at
								? MousePointerClick
								: b.opened_at
									? MailOpen
									: Send;
							return (
								<li key={b.id}>
									<Link
										to="/emails/$id"
										params={{ id: b.id }}
										className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/60"
										title={
											b.clicked_at
												? "Opened and clicked"
												: b.opened_at
													? "Opened"
													: "Not opened"
										}
									>
										<Icon
											className={
												b.opened_at
													? "size-3.5 shrink-0 text-foreground"
													: "size-3.5 shrink-0 text-muted-foreground"
											}
										/>
										<span className="min-w-0 flex-1 truncate">
											<Ph>{b.subject || "(no subject)"}</Ph>
										</span>
										<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
											{formatAgo(b.created_at)}
										</span>
									</Link>
								</li>
							);
						})}
					</ul>
				</div>
			)}

			{!!p.events?.length && c && (
				<div className="flex flex-col gap-1">
					<h3 className="eyebrow mb-1">Latest in your app</h3>
					<ul className="flex flex-col">
						{p.events.map((e) => (
							<li
								key={e.id}
								className="flex items-center gap-2 py-1 text-sm"
							>
								<Zap className="size-3.5 shrink-0 text-muted-foreground" />
								<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
									{e.event}
								</code>
								<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
									{formatAgo(e.created_at)}
								</span>
							</li>
						))}
					</ul>
					<Link
						to="/contacts/$id"
						params={{ id: c.id }}
						search={{ brand }}
						className="mt-1 text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						Their whole timeline
					</Link>
				</div>
			)}
		</div>
	);
}
