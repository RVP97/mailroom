import { Link } from "@tanstack/react-router";
import {
	MailOpen,
	MessageCircle,
	MessagesSquare,
	MousePointerClick,
	Send,
	Star,
	UserMinus,
	UserPlus,
	Users,
	Workflow,
	Zap,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatMoney } from "@/lib/format";
import { Ph } from "@/lib/sketch";
import type { TimelineItem } from "@/server/timeline";

/** Where a contact came from, as people say it. */
export function sourceLabel(source: string | null, detail?: string | null) {
	if (!source) return "Added";
	if (source.startsWith("form:")) return "Signed up through a form";
	const words: Record<string, string> = {
		referral: "Signed up through a friend's link",
		import: "Imported from a file",
		api: "Added by your app",
		mcp: "Added by the assistant",
		dashboard: "Added in the dashboard",
		automation: "Added by an automation",
		event: "Added by an event from your app",
	};
	const base = words[source] ?? "Added";
	return detail ? `${base} (${detail})` : base;
}

const EVENT_WORDS: Record<string, string> = {
	"poll.answered": "Answered a poll",
	"referral.milestone": "Reached a referral milestone",
};

/** The event's data as a short line: key values, the first few. */
function dataLine(data: Record<string, unknown>) {
	const parts = Object.entries(data)
		.filter(([, v]) => v !== null && typeof v !== "object")
		.slice(0, 4)
		.map(([k, v]) => `${k}: ${String(v)}`);
	return parts.join(" · ");
}

function Row({
	icon: Icon,
	at,
	children,
	note,
}: {
	icon: typeof Send;
	at: string;
	children: React.ReactNode;
	note?: React.ReactNode;
}) {
	return (
		<li className="relative flex gap-3 pb-4 last:pb-0">
			<span className="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground">
				<Icon className="size-3.5" />
			</span>
			<div className="min-w-0 flex-1 pt-1">
				<div className="flex items-baseline gap-3">
					<p className="min-w-0 flex-1 text-sm">{children}</p>
					<time
						dateTime={at}
						title={formatDateTime(at)}
						className="shrink-0 text-xs text-muted-foreground tabular-nums"
					>
						{formatAgo(at)}
					</time>
				</div>
				{note && <p className="mt-0.5 truncate text-xs text-muted-foreground">{note}</p>}
			</div>
		</li>
	);
}

const linkClass = "font-medium underline-offset-2 hover:underline";

function Item({ x, brand }: { x: TimelineItem; brand: string }) {
	switch (x.kind) {
		case "joined":
			return (
				<Row
					icon={UserPlus}
					at={x.at}
				>
					{sourceLabel(x.source, x.detail)}
				</Row>
			);
		case "unsubscribed":
			return (
				<Row
					icon={UserMinus}
					at={x.at}
				>
					Unsubscribed from all broadcasts
				</Row>
			);
		case "event": {
			const words = EVENT_WORDS[x.event];
			const line =
				x.event === "poll.answered"
					? [x.data.question, x.data.answer].filter(Boolean).join(" → ")
					: x.event === "referral.milestone"
						? String(x.data.reward ?? "")
						: dataLine(x.data);
			return (
				<Row
					icon={Zap}
					at={x.at}
					note={line ? <Ph>{line}</Ph> : undefined}
				>
					{words ?? (
						<>
							Did <code className="font-mono text-[13px]">{x.event}</code>
							{x.source === "assistant" ? " (the assistant)" : ""}
						</>
					)}
					{x.value !== null && x.value !== undefined && (
						<span className="font-medium tabular-nums">
							{" "}
							· {formatMoney(x.value, x.currency)}
						</span>
					)}
					{x.credit && (
						<span className="text-muted-foreground">
							{" "}
							(credited to{" "}
							{x.credit.type === "chat"
								? "a website chat"
								: x.credit.type === "automation"
									? "an automation"
									: "a broadcast"}
							)
						</span>
					)}
				</Row>
			);
		}
		case "email": {
			const did = x.clicked_at ? "clicked" : x.opened_at ? "opened" : null;
			return (
				<Row
					icon={did === "clicked" ? MousePointerClick : did ? MailOpen : Send}
					at={x.at}
					note={
						<>
							{x.broadcast_id
								? "Broadcast"
								: x.source === "automation"
									? "Automation"
									: "From your app"}
							{" · "}
							{did === "clicked"
								? "Opened and clicked"
								: did === "opened"
									? "Opened"
									: x.status.replace(/_/g, " ")}
						</>
					}
				>
					Got{" "}
					<Link
						to="/emails/$id"
						params={{ id: x.id }}
						className={linkClass}
					>
						<Ph>{x.subject || "(no subject)"}</Ph>
					</Link>
				</Row>
			);
		}
		case "conversation":
			return (
				<Row
					icon={x.channel === "chat" ? MessageCircle : MessagesSquare}
					at={x.at}
					note={
						<span className="inline-flex items-center gap-1">
							{x.status === "resolved" ? "Resolved" : "Open"} · {x.messages}{" "}
							{x.messages === 1 ? "message" : "messages"}
							{x.rating ? (
								<>
									{" · "}
									<Star className="size-3 fill-warning text-warning" />
									{x.rating}
								</>
							) : null}
						</span>
					}
				>
					{x.channel === "chat" ? "Chatted: " : "Wrote in: "}
					<Link
						to="/received/$id"
						params={{ id: x.id }}
						className={linkClass}
					>
						<Ph>{x.subject || "(no subject)"}</Ph>
					</Link>
				</Row>
			);
		case "automation":
			return (
				<Row
					icon={Workflow}
					at={x.at}
					note={
						{
							active: "In it now",
							done: "Went all the way through",
							exited: "Left it at a check",
							failed: "Stopped by an error",
							canceled: "Canceled",
						}[x.status] ?? x.status
					}
				>
					Started{" "}
					<Link
						to="/automations/$id"
						params={{ id: x.automation_id }}
						className={linkClass}
					>
						<Ph>{x.name}</Ph>
					</Link>
				</Row>
			);
		case "referred":
			return (
				<Row
					icon={Users}
					at={x.at}
				>
					Brought{" "}
					<Link
						to="/contacts/$id"
						params={{ id: x.id }}
						search={{ brand }}
						className={linkClass}
					>
						<Ph>{x.name ?? x.email}</Ph>
					</Link>
				</Row>
			);
	}
}

const keyOf = (x: TimelineItem) => `${x.kind}:${"id" in x ? x.id : ""}:${x.at}`;

/**
 * Everything about a contact in one column, newest first: what they did in the app, the emails
 * they got and what they did with them, their conversations and chats, automations and friends
 * brought. Older pages load on demand.
 */
export function ContactTimeline({
	page,
	brand,
	more,
}: {
	page: { data: TimelineItem[]; next: string | null };
	brand: string;
	more: (before: string) => Promise<{ data: TimelineItem[]; next: string | null }>;
}) {
	const [older, setOlder] = useState<TimelineItem[]>([]);
	const [next, setNext] = useState(page.next);
	const [busy, setBusy] = useState(false);
	const seen = new Set<string>();
	const items = [...page.data, ...older].filter((x) => {
		const k = keyOf(x);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	if (!items.length)
		return <p className="text-sm text-muted-foreground">Nothing has happened yet.</p>;
	return (
		<div className="flex flex-col gap-4">
			<ol className="relative before:absolute before:top-3 before:bottom-3 before:left-3.5 before:w-px before:bg-border">
				{items.map((x) => (
					<Item
						key={keyOf(x)}
						x={x}
						brand={brand}
					/>
				))}
			</ol>
			{next && (
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							const p = await more(next);
							setOlder((o) => [...o, ...p.data]);
							setNext(p.next);
						} catch (error) {
							toast.error(await errorMessage(error));
						}
						setBusy(false);
					}}
				>
					{busy && <Spinner />}
					Show older
				</Button>
			)}
		</div>
	);
}
