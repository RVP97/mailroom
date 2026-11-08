import { createFileRoute, Link } from "@tanstack/react-router";
import {
	AlarmClock,
	AtSign,
	CalendarClock,
	CheckCircle2,
	Frown,
	Inbox,
	type LucideIcon,
	MessageSquare,
	ShieldAlert,
	Stamp as StampIcon,
	Undo2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Page, PageHeader } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { todayFn } from "@/functions/today";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/today")({
	loader: () => todayFn(),
	head: () => ({ meta: [{ title: "Today · Mailroom" }] }),
	component: TodayPage,
});

type Data = Awaited<ReturnType<typeof todayFn>>;

const greeting = () => {
	const h = new Date().getHours();
	return h < 12 ? "Good morning" : h < 19 ? "Good afternoon" : "Good evening";
};

const timeOf = (at: string | null, tz: string) =>
	at
		? new Intl.DateTimeFormat(undefined, {
				timeZone: tz,
				hour: "numeric",
				minute: "2-digit",
			}).format(new Date(at))
		: "";

/** When an SLA is due, said plainly: "in 40 min", "25 min late". */
function dueText(at: string | null, breached: boolean) {
	if (!at) return breached ? "Missed" : "";
	const min = Math.round((Date.parse(at) - Date.now()) / 60_000);
	if (min < 0 || breached) {
		const late = Math.abs(min);
		return late >= 60 ? `${Math.round(late / 60)} h late` : `${late} min late`;
	}
	return min >= 60 ? `in ${Math.round(min / 60)} h` : `in ${min} min`;
}

function Tile({
	icon: Icon,
	label,
	value,
	href,
	tone,
}: {
	icon: LucideIcon;
	label: string;
	value: number;
	href: string;
	tone: "red" | "amber" | "brand" | "muted";
}) {
	return (
		<a
			href={href}
			className="group flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
		>
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center rounded-lg",
					value === 0
						? "bg-muted text-muted-foreground"
						: tone === "red"
							? "bg-red-500/15 text-red-600 dark:text-red-400"
							: tone === "amber"
								? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
								: "bg-brand/15 text-brand",
				)}
			>
				<Icon className="size-4.5" />
			</span>
			<span className="min-w-0">
				<span className="block text-2xl leading-none font-semibold tabular-nums">
					{value}
				</span>
				<span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
			</span>
		</a>
	);
}

function Section({
	id,
	icon: Icon,
	title,
	hint,
	empty,
	count,
	action,
	children,
}: {
	id: string;
	icon: LucideIcon;
	title: string;
	hint?: string;
	empty: string;
	count: number;
	action?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Card
			id={id}
			className="scroll-mt-6 gap-0 p-0"
		>
			<div className="flex items-start gap-3 border-b border-border/70 px-5 py-4">
				<Icon className="mt-0.5 size-4.5 shrink-0 text-muted-foreground" />
				<div className="min-w-0 flex-1">
					<h2 className="font-medium">{title}</h2>
					{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
				</div>
				{action}
			</div>
			{count === 0 ? (
				<p className="flex items-center gap-2 px-5 py-5 text-sm text-muted-foreground">
					<CheckCircle2 className="size-4 text-emerald-500" />
					{empty}
				</p>
			) : (
				<ul className="divide-y">{children}</ul>
			)}
		</Card>
	);
}

function Row({
	to,
	params,
	title,
	meta,
	side,
}: {
	to: string;
	params?: Record<string, string>;
	title: ReactNode;
	meta?: ReactNode;
	side?: ReactNode;
}) {
	return (
		<li className="relative flex items-center gap-3 px-5 py-3 hover:bg-accent/30">
			<div className="min-w-0 flex-1">
				<Link
					// biome-ignore lint/suspicious/noExplicitAny: links to several routes
					to={to as any}
					// biome-ignore lint/suspicious/noExplicitAny: their params
					params={params as any}
					className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
				>
					{title}
				</Link>
				{meta && <p className="truncate text-xs text-muted-foreground">{meta}</p>}
			</div>
			{side && <div className="shrink-0 text-right text-xs">{side}</div>}
		</li>
	);
}

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ");

function TodayPage() {
	const d: Data = Route.useLoaderData();
	const late = d.sla.filter((x) => x.breached || (x.due_at && Date.parse(x.due_at) < Date.now()));
	const date = new Intl.DateTimeFormat(undefined, {
		timeZone: d.timezone,
		weekday: "long",
		month: "long",
		day: "numeric",
	}).format(new Date());
	const first = d.name.split(/[\s@]/)[0];
	const nothing =
		d.approvals.length +
			d.sent_back.length +
			d.sla.length +
			d.mine.count +
			d.mentions.length +
			d.going_out.length +
			d.unhappy.length +
			d.deliverability.length ===
		0;
	return (
		<Page>
			<PageHeader
				title={`${greeting()}, ${first}`}
				description={
					nothing
						? `${date}. Nothing needs you right now.`
						: `${date}. Here's what needs you, across your brands and inboxes.`
				}
			/>
			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Tile
					icon={StampIcon}
					label="Waiting for your approval"
					value={d.approvals.length}
					href="#approvals"
					tone="amber"
				/>
				<Tile
					icon={AlarmClock}
					label={
						late.length
							? `Service levels (${late.length} late)`
							: "Service levels at risk"
					}
					value={d.sla.length}
					href="#sla"
					tone={late.length ? "red" : "amber"}
				/>
				<Tile
					icon={Inbox}
					label="Assigned to you"
					value={d.mine.count}
					href="#mine"
					tone="brand"
				/>
				<Tile
					icon={CalendarClock}
					label="Going out today"
					value={d.going_out.length}
					href="#today"
					tone="brand"
				/>
			</div>
			{d.deliverability.length > 0 && (
				<Card className="gap-2 border-red-500/40 bg-red-500/5 p-4">
					{d.deliverability.map((x, i) => (
						<Link
							// biome-ignore lint/suspicious/noExplicitAny: settings, insights or a domain
							to={x.link as any}
							key={`${x.text}-${i}`}
							className="flex items-start gap-2.5 text-sm hover:underline"
						>
							<ShieldAlert
								className={cn(
									"mt-0.5 size-4 shrink-0",
									x.level === "danger" ? "text-red-500" : "text-amber-500",
								)}
							/>
							<span>
								{x.brand && <b>{x.brand}: </b>}
								{x.text}
							</span>
						</Link>
					))}
				</Card>
			)}
			<div className="grid items-start gap-6 lg:grid-cols-2">
				<div className="flex min-w-0 flex-col gap-6">
					<Section
						id="sla"
						icon={AlarmClock}
						title="Service levels"
						hint="Open conversations past or within 2 hours of their reply or resolve time."
						empty="Every conversation is on time."
						count={d.sla.length}
					>
						{d.sla.map((x) => (
							<Row
								key={x.id}
								to="/received/$id"
								params={{ id: x.id }}
								title={x.subject}
								meta={join(
									x.contact,
									x.brand,
									x.assignee ? `with ${x.assignee}` : "unassigned",
								)}
								side={
									<span
										className={cn(
											"font-medium",
											x.breached ||
												(x.due_at && Date.parse(x.due_at) < Date.now())
												? "text-red-600 dark:text-red-400"
												: "text-amber-700 dark:text-amber-400",
										)}
									>
										{dueText(x.due_at, x.breached)}
									</span>
								}
							/>
						))}
					</Section>
					<Section
						id="mine"
						icon={Inbox}
						title="Assigned to you"
						hint={
							d.unassigned
								? `${d.unassigned} more open ${d.unassigned === 1 ? "conversation has" : "conversations have"} nobody yet.`
								: undefined
						}
						empty="Nothing assigned to you is open."
						count={d.mine.count}
						action={
							<Link
								to="/received"
								className="text-xs text-muted-foreground hover:text-foreground"
							>
								All received
							</Link>
						}
					>
						{d.mine.conversations.map((x) => (
							<Row
								key={x.id}
								to="/received/$id"
								params={{ id: x.id }}
								title={x.subject}
								meta={join(x.contact, x.brand, x.channel === "chat" && "chat")}
								side={
									<span className="flex flex-col items-end gap-1">
										{x.priority === "urgent" || x.priority === "high" ? (
											<Badge variant="destructive">{x.priority}</Badge>
										) : null}
										<span className="text-muted-foreground">
											{formatRelative(x.last_message_at)}
										</span>
									</span>
								}
							/>
						))}
					</Section>
					<Section
						id="mentions"
						icon={AtSign}
						title="Notes that mention you"
						hint="On open conversations, the last 3 days."
						empty="Nobody's waiting on a note from you."
						count={d.mentions.length}
					>
						{d.mentions.map((m) => (
							<Row
								key={`${m.conversation_id}-${m.at}`}
								to="/received/$id"
								params={{ id: m.conversation_id }}
								title={`${m.author}: “${m.text}”`}
								meta={join(m.subject, formatRelative(m.at))}
							/>
						))}
					</Section>
				</div>
				<div className="flex min-w-0 flex-col gap-6">
					<Section
						id="approvals"
						icon={StampIcon}
						title="Waiting for approval"
						hint="Broadcasts someone asked you to review."
						empty="No broadcast is waiting for you."
						count={d.approvals.length + d.sent_back.length}
					>
						{d.approvals.map((x) => (
							<Row
								key={x.id}
								to="/broadcasts/$id"
								params={{ id: x.id }}
								title={x.name}
								meta={join(
									x.requested_by && `${x.requested_by} asked`,
									x.brand,
									x.requested_at && formatRelative(x.requested_at),
								)}
								side={<Badge variant="secondary">Review</Badge>}
							/>
						))}
						{d.sent_back.map((x) => (
							<Row
								key={x.id}
								to="/broadcasts/$id"
								params={{ id: x.id }}
								title={x.name}
								meta={join(
									x.reviewed_by && `${x.reviewed_by} asked for changes`,
									x.brand,
									x.reviewed_at && formatRelative(x.reviewed_at),
								)}
								side={
									<span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
										<Undo2 className="size-3.5" />
										Changes
									</span>
								}
							/>
						))}
					</Section>
					<Section
						id="today"
						icon={CalendarClock}
						title="Going out today"
						hint="Broadcasts sending now or scheduled before midnight."
						empty="Nothing is scheduled for today."
						count={d.going_out.length}
					>
						{d.going_out.map((x) => (
							<Row
								key={x.id}
								to="/broadcasts/$id"
								params={{ id: x.id }}
								title={x.name}
								meta={join(
									x.brand,
									x.status === "sending" && `${x.queued.toLocaleString()} queued`,
								)}
								side={
									x.status === "sending" ? (
										<Badge>Sending</Badge>
									) : (
										<span className="font-medium tabular-nums">
											{timeOf(x.scheduled_at, d.timezone)}
										</span>
									)
								}
							/>
						))}
					</Section>
					<Section
						id="unhappy"
						icon={Frown}
						title="Unhappy answers"
						hint="Detractors (0-6) and low satisfaction (1-2) from your surveys, the last 24 hours."
						empty="No unhappy answers today."
						count={d.unhappy.length}
					>
						{d.unhappy.map((r, i) => (
							<Row
								key={`${r.survey_id}-${r.at}-${i}`}
								to={
									r.conversation_id
										? "/received/$id"
										: r.contact_id
											? "/contacts/$id"
											: "/surveys/$id"
								}
								params={{
									id: r.conversation_id ?? r.contact_id ?? r.survey_id,
								}}
								title={
									<>
										<span className="mr-2 inline-flex size-6 items-center justify-center rounded bg-red-500 text-xs font-semibold text-white tabular-nums">
											{r.score}
										</span>
										{r.email ?? "A visitor"}
									</>
								}
								meta={join(
									r.comment ? `“${r.comment}”` : null,
									r.survey,
									formatRelative(r.at),
								)}
							/>
						))}
					</Section>
					<Section
						id="deliverability"
						icon={ShieldAlert}
						title="Delivery"
						hint="Sending pauses, bounce and complaint limits, and failing domains."
						empty="Your email is getting delivered: no pauses, limits or failing domains."
						count={d.deliverability.length}
						action={
							<Link
								to="/"
								className="text-xs text-muted-foreground hover:text-foreground"
							>
								Overview
							</Link>
						}
					>
						{d.deliverability.map((x, i) => (
							<Row
								key={`${x.text}-${i}`}
								to={x.link}
								title={x.text}
								meta={x.brand ?? undefined}
								side={
									<Badge
										variant={x.level === "danger" ? "destructive" : "secondary"}
									>
										{x.level === "danger" ? "Act now" : "Watch"}
									</Badge>
								}
							/>
						))}
					</Section>
				</div>
			</div>
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				<MessageSquare className="size-3.5" />
				Your assistant sees the same list with the MCP tool get_today.
			</p>
		</Page>
	);
}
