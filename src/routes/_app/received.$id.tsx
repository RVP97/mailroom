import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Bot,
	ChevronDown,
	CircleCheck,
	Ellipsis,
	Mail,
	MailOpen,
	MessageCircle,
	MessagesSquare,
	Paperclip,
	PenLine,
	RotateCcw,
	Send,
	ShieldAlert,
	ShieldCheck,
	StickyNote,
	Trash2,
	Undo2,
	User,
	X,
	Zap,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { ChatThread, type Live } from "@/components/chat-thread";
import { Confirm } from "@/components/confirm";
import { CopyValue } from "@/components/copy";
import {
	AssigneeMenu,
	Avatar,
	PickMoment,
	PriorityMenu,
	SlaBadge,
	SnoozeMenu,
	Stars,
	TagChip,
	TagsMenu,
	TriageBar,
} from "@/components/inbox-triage";
import { Page, Section } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteConversationNowFn } from "@/functions/chat";
import {
	addNoteFn,
	deleteConversationDraftFn,
	deleteNoteFn,
	getConversationFn,
	markMessageFn,
	olderTimelineFn,
	saveConversationDraftFn,
	sendConversationReplyFn,
	unsendReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatSeconds } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { fillVariables } from "@/lib/reply-variables";
import { ago, listedRow, Ph, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** One conversation: everything in it in order (what came in, our replies, open drafts, the
 * team's notes), who has it and how it's triaged, and the reply box. A received message whole
 * (preview, headers, report) is received.m.$id.tsx. */
export const Route = createFileRoute("/_app/received/$id")({
	loader: ({ params }) => getConversationFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.conversation.subject || "Conversation"} · Mailroom` }],
	}),
	component: ConversationPage,
	pendingComponent: ConversationSketch,
});

type Data = Awaited<ReturnType<typeof getConversationFn>>;
type Item = Data["conversation"]["timeline"][number];
type Conversation = Data["conversation"];

function ConversationSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("conversation-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<ConversationPage />
			</Sketch>
		);
	const listed = listedRow<{ subject: string; contact: string; last_message_at: string }>(
		"received",
		params.id,
	);
	const at = listed?.last_message_at ?? ago(30);
	const data: Data = {
		conversation: {
			object: "conversation",
			id: params.id ?? "",
			brand_id: "",
			inbox_id: null,
			channel: "email",
			subject: listed?.subject ?? "Question about my booking",
			contact: listed?.contact ?? "guest@example.com",
			status: "open",
			unread: false,
			messages: 1,
			drafts: 0,
			snippet: null,
			last_message_at: at,
			last_inbound_at: at,
			last_reply_at: null,
			replied_by: null,
			resolved_at: null,
			created_at: at,
			assignee: null,
			tags: [],
			priority: "normal",
			snoozed_until: null,
			first_reply_at: null,
			sla: { reply_due_at: null, resolve_due_at: null, breached: [] },
			csat: null,
			held: false,
			has_more: false,
			before: null,
			timeline: [
				{
					type: "inbound",
					id: "sketch",
					at,
					unread: false,
					from: listed?.contact ?? "guest@example.com",
					to: ["support@example.com"],
					cc: [],
					reply_to: [],
					subject: listed?.subject ?? "Question",
					message_id: null,
					text: "Hello, I wanted to ask about my booking for next week.",
					new_text: "Hello, I wanted to ask about my booking for next week.",
					quoted: false,
					attachments: [],
					spam: false,
					verdicts: {
						spam: "PASS",
						virus: "PASS",
						spf: "PASS",
						dkim: "PASS",
						dmarc: "PASS",
					},
					flags: null,
					held: false,
				},
			],
		},
		compose: { from: null, to: [], subject: "", fixed_from: false },
		inbox: null,
		brand: null,
		activity: [],
		me: "",
		people: [],
		saved: [],
		variables: [],
		workflow: { tags: [], undo_seconds: 0, signature: false, sla: false },
		contact: null,
	};
	return (
		<Sketch data={data}>
			<ConversationPage />
		</Sketch>
	);
}

const ACTIONS: Record<string, string> = {
	"conversation.read": "read the conversation",
	"conversation.resolved": "resolved it",
	"conversation.reopened": "reopened it",
	"conversation.assigned": "assigned it",
	"conversation.unassigned": "unassigned it",
	"conversation.claimed": "started working on it",
	"conversation.released": "let go of it",
	"conversation.tagged": "changed its tags",
	"conversation.prioritized": "changed its priority",
	"conversation.snoozed": "snoozed it",
	"conversation.woke": "brought it back from a snooze",
	"conversation.released_to_agents": "let agents see the held mail",
	"draft.created": "wrote a draft",
	"draft.updated": "edited a draft",
	"draft.deleted": "discarded a draft",
	"draft.discarded": "discarded a draft",
	"reply.sent": "sent a reply",
	"reply.unsent": "called a reply back",
	"note.created": "added a note",
	"note.deleted": "deleted a note",
	"message.held": "held a message for a person",
	"rule.matched": "ran a rule",
	"sla.breached": "missed the SLA",
	"csat.sent": "sent the rating survey",
	"csat.received": "got a rating",
	"attachment.downloaded": "downloaded an attachment",
	"message.read": "read a message",
	"chat.started": "opened the chat (the visitor's first message)",
};

type Patch = Omit<Parameters<typeof updateConversationFn>[0]["data"], "id">;

function ConversationPage() {
	const data = usePage(Route).data;
	const router = useRouter();
	const me = useMe();
	const canReply = allows(me.active?.access, "inbox:reply");
	const { conversation: c, inbox, brand, activity, compose, workflow, people } = data;
	useOpened(
		"conversation-page",
		useMemo(() => ({ ...data, id: c.id, activity: [] }), [data, c.id]),
	);
	const [busy, setBusy] = useState<string | null>(null);
	const reload = () => router.invalidate();
	const update = async (patch: Patch, key: string, done?: string) => {
		setBusy(key);
		try {
			await updateConversationFn({ data: { id: c.id, ...patch } });
			if (patch.read === false) {
				toast.success("Marked unread");
				await router.navigate({ to: "/received" });
				return;
			}
			if (done) toast.success(done);
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const [editing, setEditing] = useState<string | null>(null);
	// Older pages, added on "Load older" (the loader brings the newest).
	const [older, setOlder] = useState<{
		items: Item[];
		more: boolean;
		before: string | null;
		busy: boolean;
		for: string;
	}>({ items: [], more: c.has_more, before: c.before, busy: false, for: c.id });
	if (older.for !== c.id)
		setOlder({ items: [], more: c.has_more, before: c.before, busy: false, for: c.id });
	const timeline = [...older.items, ...c.timeline];
	const firstUnread = timeline.find((t) => t.type === "inbound" && t.unread)?.id;
	const lastInbound = timeline.findLast((t) => t.type === "inbound")?.id;
	const loadOlder = async () => {
		if (!older.before) return;
		setOlder((o) => ({ ...o, busy: true }));
		try {
			const r = await olderTimelineFn({ data: { id: c.id, before: older.before } });
			setOlder((o) => ({
				...o,
				items: [...r.timeline, ...o.items],
				more: r.has_more,
				before: r.before,
				busy: false,
			}));
		} catch (error) {
			toast.error(await errorMessage(error));
			setOlder((o) => ({ ...o, busy: false }));
		}
	};
	const chat = c.channel === "chat";
	const [live, setLive] = useState<Live | null>(null);
	const canDelete = allows(me.active?.access, "inbox:reply");
	const held = timeline.filter((t) => t.type === "inbound" && t.held);
	const nameOfReader = (reader: string) => people.find((p) => p.reader === reader)?.name;
	const notes = timeline.filter((t) => t.type === "note");
	const ctx = {
		contact: chat ? (c.visitor?.name ?? c.visitor?.email ?? "") : c.contact,
		agent: me.user.name || me.user.email,
		inbox: inbox?.name ?? null,
		subject: c.subject,
	};
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/received"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Received
					</Link>
					{inbox && (
						<>
							<span aria-hidden="true"> / </span>
							<Link
								to="/received"
								search={{ inbox: inbox.id }}
								className="rounded-sm transition-colors hover:text-foreground"
							>
								{inbox.name}
							</Link>
						</>
					)}
				</nav>
				<RecordHeader
					icon={chat ? MessageCircle : MessagesSquare}
					tone={c.status === "resolved" ? "gray" : c.snoozed_until ? "amber" : "blue"}
					kind={
						chat
							? c.status === "resolved"
								? "Resolved website chat"
								: "Open website chat"
							: c.status === "resolved"
								? "Resolved conversation"
								: c.snoozed_until
									? "Snoozed conversation"
									: "Open conversation"
					}
					title={c.subject || "(no subject)"}
					actions={
						<>
							<Button
								variant="outline"
								aria-label="Mark unread"
								disabled={busy !== null}
								onClick={() => update({ read: false }, "unread")}
							>
								{busy === "unread" ? <Spinner /> : <Mail />}
								<span className="hidden sm:inline">Mark unread</span>
							</Button>
							{c.status === "open" ? (
								<Button
									disabled={busy !== null}
									onClick={() =>
										update({ status: "resolved" }, "status", "Resolved")
									}
								>
									{busy === "status" ? <Spinner /> : <CircleCheck />}
									Resolve
								</Button>
							) : (
								<Button
									variant="outline"
									disabled={busy !== null}
									onClick={() => update({ status: "open" }, "status", "Reopened")}
								>
									{busy === "status" ? <Spinner /> : <RotateCcw />}
									Reopen
								</Button>
							)}
							{chat && canDelete && (
								<Confirm
									trigger={
										<Button
											variant="ghost"
											aria-label="Delete now"
											title="Delete now"
										>
											<Trash2 />
										</Button>
									}
									title="Delete this chat now?"
									description="The messages and files go for good, and the visitor's chat ends. It doesn't wait for the inbox's retention."
									action="Delete now"
									onConfirm={async () => {
										try {
											await deleteConversationNowFn({ data: { id: c.id } });
											toast.success("Chat deleted");
											await router.navigate({ to: "/received" });
										} catch (error) {
											toast.error(await errorMessage(error));
										}
									}}
								/>
							)}
							<ApiDrawer
								title="This conversation in the API"
								description="With a full-access key, or the inbox's own credential (mri_…)."
								calls={[
									{
										title: "Read it whole",
										method: "GET",
										path: `/conversations/${c.id}?mark_read=true`,
									},
									{
										title: "Claim it while an agent works on it",
										method: "POST",
										path: `/conversations/${c.id}/claim`,
										body: { minutes: 15 },
									},
									{
										title: "Write a draft for review",
										method: "POST",
										path: `/conversations/${c.id}/drafts`,
										body: {
											text: "Thanks for writing…",
											after_message: lastInbound ?? null,
										},
									},
									{
										title: "Reply in the same thread",
										method: "POST",
										path: `/conversations/${c.id}/reply`,
										body: { text: "Thanks for writing…" },
									},
									{
										title: "Leave a note for the team",
										method: "POST",
										path: `/conversations/${c.id}/notes`,
										body: { text: "Checked the booking: it's paid." },
									},
									{
										title: "Triage it",
										method: "PATCH",
										path: `/conversations/${c.id}`,
										body: { add_tags: ["billing"], priority: "high" },
									},
								]}
							/>
						</>
					}
				/>
				{canReply && (
					<TriageBar>
						<AssigneeMenu
							holder={c.assignee}
							people={people}
							me={data.me}
							disabled={busy !== null}
							onChange={(reader) =>
								update(
									{ assignee: reader },
									"assignee",
									reader
										? reader === data.me
											? "It's yours"
											: `Assigned to ${nameOfReader(reader) ?? "them"}`
										: "Unassigned",
								)
							}
						/>
						<PriorityMenu
							priority={c.priority}
							disabled={busy !== null}
							onChange={(priority) => update({ priority }, "priority")}
						/>
						<TagsMenu
							tags={c.tags}
							catalog={workflow.tags}
							disabled={busy !== null}
							onChange={(tags) => update({ tags }, "tags")}
						/>
						{c.status === "open" && (
							<SnoozeMenu
								until={c.snoozed_until}
								disabled={busy !== null}
								onChange={(until) =>
									update(
										{ snooze_until: until },
										"snooze",
										until
											? `Snoozed until ${formatDateTime(until)}`
											: "Back in the open list",
									)
								}
							/>
						)}
						{busy && ["assignee", "priority", "tags", "snooze"].includes(busy) && (
							<Spinner />
						)}
						<span className="flex flex-wrap items-center gap-1.5">
							{c.tags.map((t) => (
								<TagChip
									key={t}
									tag={t}
									catalog={workflow.tags}
								/>
							))}
							<SlaBadge
								sla={c.sla}
								status={c.status}
							/>
						</span>
					</TriageBar>
				)}
			</div>

			{c.held && (
				<Alert variant="warning">
					<ShieldAlert />
					<AlertTitle>Held for a person</AlertTitle>
					<AlertDescription className="flex flex-col gap-3">
						<span>
							Agents don't see{" "}
							{held.length === 1
								? "one message"
								: `${held.length || "some"} messages`}{" "}
							here until someone checks {held.length === 1 ? "it" : "them"}
							{reasonsOf(held).length ? `: ${reasonsOf(held).join("; ")}.` : "."}
						</span>
						<span className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busy !== null}
								onClick={() =>
									update(
										{ release_held: true },
										"release",
										"Agents can see it now",
									)
								}
							>
								{busy === "release" ? <Spinner /> : <ShieldCheck />}
								It's fine, let agents see it
							</Button>
						</span>
					</AlertDescription>
				</Alert>
			)}

			<Facts>
				{chat ? (
					<>
						<Fact label="Visitor">
							{c.visitor?.name || c.visitor?.email ? (
								<span className="flex min-w-0 flex-col">
									{c.visitor.name && (
										<span className="truncate">
											<Ph>{c.visitor.name}</Ph>
										</span>
									)}
									{c.visitor.email && <CopyValue value={c.visitor.email} />}
								</span>
							) : (
								<span className="text-muted-foreground">
									Anonymous (no email left)
								</span>
							)}
						</Fact>
						{c.visitor?.page_url && (
							<Fact label="Wrote from">
								<a
									href={c.visitor.page_url}
									target="_blank"
									rel="noreferrer"
									className="truncate underline-offset-2 hover:underline"
									title={c.visitor.page_url}
								>
									{pageOf(c.visitor.page_url)}
								</a>
							</Fact>
						)}
						<Fact label="On the site">
							{live?.visitorOnline ? (
								<span className="text-emerald-600 dark:text-emerald-400">Now</span>
							) : c.visitor?.seen_at ? (
								<span title={formatDateTime(c.visitor.seen_at)}>
									{formatAgo(c.visitor.seen_at)}
								</span>
							) : (
								"—"
							)}
						</Fact>
					</>
				) : (
					<Fact label="With">
						<CopyValue value={c.contact} />
					</Fact>
				)}
				<Fact label="Inbox">
					{inbox ? (
						<Link
							to="/received/inboxes/$id"
							params={{ id: inbox.id }}
							className="truncate underline-offset-2 hover:underline"
						>
							{inbox.address}
						</Link>
					) : (
						<span className="text-muted-foreground">None (a domain address)</span>
					)}
				</Fact>
				{brand && <Fact label="Brand">{brand.name}</Fact>}
				<Fact label="Messages">
					<Ph>{c.messages}</Ph>
				</Fact>
				<Fact label="Started">{formatDateTime(c.created_at)}</Fact>
				<Fact label="First reply">
					{c.first_reply_at ? (
						<span title={formatDateTime(c.first_reply_at)}>
							after{" "}
							{formatSeconds(
								Math.max(
									0,
									(Date.parse(c.first_reply_at) - Date.parse(c.created_at)) /
										1000,
								),
							)}
						</span>
					) : (
						<span className="text-muted-foreground">Not yet</span>
					)}
				</Fact>
				{c.replied_by && (
					<Fact label="Replied last">
						{c.replied_by === "agent" ? "An agent" : "A person"}
					</Fact>
				)}
				{c.csat && (
					<Fact label="Their rating">
						{c.csat.rating ? (
							<span
								className="flex items-center gap-2"
								title={c.csat.comment ?? undefined}
							>
								<Stars rating={c.csat.rating} />
								{c.csat.comment && (
									<span className="truncate text-muted-foreground">
										“{c.csat.comment}”
									</span>
								)}
							</span>
						) : (
							<span className="text-muted-foreground">Asked, no answer yet</span>
						)}
					</Fact>
				)}
				<Fact label="Id">
					<IdChip value={c.id} />
				</Fact>
			</Facts>

			{chat && (
				<ChatThread
					conversation={c}
					canReply={canReply}
					onLive={setLive}
				/>
			)}

			{chat && (notes.length > 0 || canReply) && (
				<Section
					title="Team notes"
					description="Only your team sees these, never the visitor."
				>
					<ol className="flex flex-col gap-3">
						{notes.map((t) => (
							<li key={`note-${t.id}`}>
								<TimelineItem
									conversation={c.id}
									item={t}
									canReply={canReply}
									me={data.me}
									onEdit={() => {}}
								/>
							</li>
						))}
					</ol>
					{canReply && (
						<Composer
							conversation={c}
							compose={compose}
							data={data}
							ctx={ctx}
							notesOnly
							key={`${c.id}-notes`}
						/>
					)}
				</Section>
			)}

			<ol className={cn("flex flex-col gap-4", chat && "hidden")}>
				{older.more && (
					<li className="flex justify-center">
						<Button
							variant="outline"
							size="sm"
							disabled={older.busy}
							onClick={loadOlder}
						>
							{older.busy && <Spinner />}
							Load older
						</Button>
					</li>
				)}
				{timeline.map((t) => (
					<li key={`${t.type}-${t.id}`}>
						{t.id === firstUnread && (
							<div className="mb-4 flex items-center gap-3 text-xs font-medium text-brand">
								<span
									aria-hidden="true"
									className="h-px flex-1 bg-brand/40"
								/>
								New since you last read
								<span
									aria-hidden="true"
									className="h-px flex-1 bg-brand/40"
								/>
							</div>
						)}
						{t.type === "draft" && editing === t.id ? (
							<Composer
								conversation={c}
								compose={compose}
								data={data}
								ctx={ctx}
								draft={t}
								lastInbound={lastInbound}
								onDone={() => setEditing(null)}
							/>
						) : (
							<TimelineItem
								conversation={c.id}
								item={t}
								canReply={canReply}
								me={data.me}
								onEdit={() => setEditing(t.id)}
							/>
						)}
					</li>
				))}
			</ol>

			{canReply && !editing && !chat && (
				<Composer
					conversation={c}
					compose={compose}
					data={data}
					ctx={ctx}
					lastInbound={lastInbound}
					key={c.id}
				/>
			)}

			{data.contact && (data.contact.record || data.contact.others.length > 0) && (
				<Section
					title="About them"
					description={data.contact.email}
				>
					<Card className="gap-0 divide-y px-0 py-0">
						{data.contact.record && (
							<Link
								to="/contacts/$id"
								params={{ id: data.contact.record.id }}
								className="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-muted/50"
							>
								<User className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">
									<span className="font-medium">
										{[
											data.contact.record.first_name,
											data.contact.record.last_name,
										]
											.filter(Boolean)
											.join(" ") || data.contact.email}
									</span>{" "}
									<span className="text-muted-foreground">
										is a contact since{" "}
										{formatDateTime(data.contact.record.created_at)}
										{data.contact.record.unsubscribed ? " (unsubscribed)" : ""}
									</span>
								</span>
								<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
							</Link>
						)}
						{data.contact.others.map((o) => (
							<Link
								key={o.id}
								to="/received/$id"
								params={{ id: o.id }}
								className="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-muted/50"
							>
								<MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
								<span className="min-w-0 flex-1 truncate">
									{o.subject || "(no subject)"}
								</span>
								{o.csat ? <Stars rating={o.csat} /> : null}
								<StatusBadge status={o.status} />
								<span className="w-12 shrink-0 text-right text-muted-foreground tabular-nums">
									{formatAgo(o.last_message_at)}
								</span>
							</Link>
						))}
					</Card>
				</Section>
			)}

			{activity.length > 0 && (
				<section className="flex flex-col gap-3">
					<h2 className="eyebrow">Activity</h2>
					<ul className="flex flex-col gap-2 text-sm">
						{activity.map((a) => (
							<li
								key={a.id}
								className="flex items-center gap-2"
							>
								{a.actor.type === "agent" ? (
									<Bot className="size-4 shrink-0 text-muted-foreground" />
								) : a.actor.type === "system" ? (
									<Zap className="size-4 shrink-0 text-muted-foreground" />
								) : (
									<User className="size-4 shrink-0 text-muted-foreground" />
								)}
								<span className="min-w-0 truncate">
									<span className="font-medium">{a.actor.name ?? "Someone"}</span>{" "}
									{ACTIONS[a.action] ?? a.action}
								</span>
								<span
									className="ml-auto shrink-0 text-muted-foreground tabular-nums"
									title={formatDateTime(a.created_at)}
								>
									{formatAgo(a.created_at)}
								</span>
							</li>
						))}
					</ul>
				</section>
			)}
		</Page>
	);
}

/** Why held messages wait, each reason once. */
const reasonsOf = (items: Item[]) => [
	...new Set(
		items.flatMap((t) =>
			t.type === "inbound" ? (t.flags?.reasons ?? []).map((r) => r.text) : [],
		),
	),
];

/** A page's address without the scheme: harborinn.com/rooms. */
const pageOf = (url: string) => {
	try {
		const u = new URL(url);
		return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
	} catch {
		return url;
	}
};

/** «Ana López <ana@…>» as «Ana López», or the bare address. */
const nameOf = (from: string) => /^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

function Author({ author }: { author: { type: string; name: string | null } }) {
	return author.type === "agent" ? (
		<Badge variant="secondary">
			<Bot />
			{author.name ?? "Agent"}
		</Badge>
	) : (
		<Badge variant="outline">
			<User />
			{author.name ?? "Person"}
		</Badge>
	);
}

const kb = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

function Files({
	list,
	onRemove,
}: {
	list: { id: string; filename: string; size: number }[];
	onRemove?: (id: string) => void;
}) {
	return (
		<div className="flex flex-wrap gap-2">
			{list.map((a) => (
				<span
					key={a.id}
					className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
				>
					<Paperclip className="size-3 text-muted-foreground" />
					{a.filename}
					<span className="text-muted-foreground tabular-nums">{kb(a.size)}</span>
					{onRemove && (
						<button
							type="button"
							aria-label={`Remove ${a.filename}`}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => onRemove(a.id)}
						>
							<X className="size-3" />
						</button>
					)}
				</span>
			))}
		</div>
	);
}

/** A note's text with its @mentions drawn as chips. */
function NoteText({ text, names }: { text: string; names: string[] }) {
	if (!names.length) return <>{text}</>;
	const escaped = names
		.sort((a, b) => b.length - a.length)
		.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const parts = text.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
	return (
		<>
			{parts.map((p, i) =>
				p.startsWith("@") && names.includes(p.slice(1)) ? (
					<span
						key={i}
						className="rounded bg-brand/10 px-1 font-medium text-brand"
					>
						{p}
					</span>
				) : (
					p
				),
			)}
		</>
	);
}

function TimelineItem({
	conversation,
	item: t,
	canReply,
	me,
	onEdit,
}: {
	conversation: string;
	item: Item;
	canReply: boolean;
	me: string;
	onEdit: () => void;
}) {
	const router = useRouter();
	const [whole, setWhole] = useState(false);
	if (t.type === "origin")
		return (
			<Card className="gap-1 border-dashed px-5 py-4 text-sm">
				<span className="flex items-center gap-2">
					<Send className="size-4 text-muted-foreground" />
					<span className="min-w-0 truncate">
						We sent{" "}
						<Link
							to="/emails/$id"
							params={{ id: t.email_id }}
							className="font-medium underline-offset-2 hover:underline"
						>
							{t.subject || "(no subject)"}
						</Link>{" "}
						to {t.to.join(", ")}
					</span>
					<span className="ml-auto shrink-0 text-muted-foreground">
						{formatDateTime(t.at)}
					</span>
				</span>
			</Card>
		);
	if (t.type === "note") {
		const mine = `${t.author.type === "agent" ? "cred" : "user"}:${t.author.id}` === me;
		const names = t.mentions.map((m) => m.name);
		return (
			<Card className="gap-2 bg-amber-50/70 px-5 py-4 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--warning)_30%,transparent)] dark:bg-amber-500/[0.05]">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span className="flex items-center gap-2 font-medium">
						<StickyNote className="size-4 text-amber-600 dark:text-amber-400" />
						Note
					</span>
					<Author author={t.author} />
					<span className="text-xs text-muted-foreground">Only your team sees it</span>
					<span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
						<span title={formatDateTime(t.at)}>{formatAgo(t.at)}</span>
						{canReply && mine && (
							<Confirm
								trigger={
									<Button
										size="sm"
										variant="ghost"
										aria-label="Delete the note"
									>
										<Trash2 />
									</Button>
								}
								title="Delete this note?"
								description="Your team won't see it any more."
								action="Delete"
								onConfirm={async () => {
									try {
										await deleteNoteFn({ data: { conversation, id: t.id } });
										await router.invalidate();
									} catch (error) {
										toast.error(await errorMessage(error));
									}
								}}
							/>
						)}
					</span>
				</div>
				<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
					<Ph>
						<NoteText
							text={t.text}
							names={names}
						/>
					</Ph>
				</p>
			</Card>
		);
	}
	if (t.type === "inbound") {
		const body = whole || !t.quoted ? t.text : t.new_text;
		const flagged = (t.flags?.score ?? 0) > 0;
		return (
			<Card className="gap-3 px-5 py-4">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span className="flex min-w-0 items-center gap-2">
						<MailOpen className="size-4 shrink-0 text-muted-foreground" />
						<span
							className="truncate font-medium"
							title={t.from}
						>
							<Ph>{nameOf(t.from)}</Ph>
						</span>
					</span>
					<span className="truncate text-sm text-muted-foreground">
						to {t.to.join(", ")}
					</span>
					{t.spam && (
						<Badge variant="destructive">
							<ShieldAlert />
							Spam
						</Badge>
					)}
					{flagged && t.flags && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Badge
									variant="outline"
									className="text-amber-700 dark:text-amber-300"
								>
									<ShieldAlert />
									{t.held ? "Held from agents" : "Looks off"}
								</Badge>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								<ul className="flex flex-col gap-1">
									{t.flags.reasons.map((r) => (
										<li key={r.code}>{r.text}</li>
									))}
								</ul>
							</TooltipContent>
						</Tooltip>
					)}
					<span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
						<span title={formatDateTime(t.at)}>{formatAgo(t.at)}</span>
						<Button
							size="sm"
							variant="ghost"
							aria-label="Mark this message unread"
							title="Mark this message unread (for you)"
							onClick={async () => {
								try {
									await markMessageFn({ data: { id: t.id, read: false } });
									toast.success("Marked unread");
									await router.navigate({ to: "/received" });
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						>
							<Mail />
						</Button>
						<Button
							size="sm"
							variant="ghost"
							asChild
						>
							<Link
								to="/received/m/$id"
								params={{ id: t.id }}
								aria-label="The whole message"
							>
								<ArrowUpRight />
								<span className="hidden sm:inline">Message</span>
							</Link>
						</Button>
					</span>
				</div>
				<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
					<Ph>
						{body?.trim() ||
							(t.html
								? "No plain-text part: open the message to see it."
								: "No longer kept (past its retention).")}
					</Ph>
				</p>
				{t.quoted && (
					<button
						type="button"
						className="flex w-fit items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
						aria-expanded={whole}
						onClick={() => setWhole((w) => !w)}
					>
						<Ellipsis className="size-3.5" />
						{whole ? "Hide what it quotes" : "Show what it quotes"}
					</button>
				)}
				{(t.attachments ?? []).length > 0 && (
					<div className="flex flex-wrap gap-2">
						{t.attachments.map((a) => (
							<span
								key={a.id}
								className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
							>
								<Paperclip className="size-3 text-muted-foreground" />
								{a.filename ?? a.id}
							</span>
						))}
					</div>
				)}
			</Card>
		);
	}
	// A website chat's lines are drawn by ChatThread.
	if (t.type === "chat") return null;
	const draft = t.type === "draft";
	const waiting = !draft && t.scheduled_for;
	return (
		<Card
			className={cn(
				"gap-3 px-5 py-4",
				draft ? "border-brand/50 bg-brand/5" : waiting ? "border-dashed" : "bg-muted/40",
			)}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="flex items-center gap-2 font-medium">
					{draft ? (
						<PenLine className="size-4 text-muted-foreground" />
					) : (
						<Send className="size-4 text-muted-foreground" />
					)}
					{draft ? "Draft reply" : waiting ? "Reply, waiting to go" : "Reply"}
				</span>
				<Author author={t.author} />
				{draft && t.author.type === "agent" && <Badge variant="brand">Needs review</Badge>}
				{!draft && t.sent_by && (
					<span className="text-sm text-muted-foreground">approved by {t.sent_by}</span>
				)}
				{!draft && t.author.type === "agent" && t.review && (
					<Badge variant="secondary">
						{t.review === "edited"
							? "Edited before sending"
							: "Sent as the agent wrote it"}
					</Badge>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
					{waiting ? (
						<span title={formatDateTime(t.scheduled_for)}>
							{Date.parse(t.scheduled_for ?? "") - Date.now() < 90_000
								? "Goes in a moment"
								: `Goes ${formatAgo(t.scheduled_for)}`}
						</span>
					) : (
						<>
							{!draft && t.delivery && <StatusBadge status={t.delivery} />}
							<span title={formatDateTime(t.at)}>{formatAgo(t.at)}</span>
						</>
					)}
					{!draft && t.email_id && !waiting && (
						<Button
							size="sm"
							variant="ghost"
							asChild
						>
							<Link
								to="/emails/$id"
								params={{ id: t.email_id }}
								aria-label="The sent email"
							>
								<ArrowUpRight />
								<span className="hidden sm:inline">Email</span>
							</Link>
						</Button>
					)}
				</span>
			</div>
			<p className="truncate text-sm text-muted-foreground">
				{t.from ? `From ${t.from} · ` : ""}to {t.to.join(", ")}
				{t.cc.length ? `, cc ${t.cc.join(", ")}` : ""}
			</p>
			<p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
				<Ph>{t.text}</Ph>
			</p>
			{/* Pages kept in this browser before replies had files lack the list. */}
			{(t.attachments ?? []).length > 0 && <Files list={t.attachments} />}
			{waiting && canReply && (
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							try {
								await unsendReplyFn({ data: { id: t.id } });
								toast.success("Called back: it's a draft again");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							}
						}}
					>
						<Undo2 />
						Don't send, back to a draft
					</Button>
				</div>
			)}
			{draft && canReply && (
				<div className="flex flex-wrap gap-2">
					<SendDraft
						conversation={conversation}
						draft={t.id}
						onSent={() => router.invalidate()}
					/>
					<Button
						variant="outline"
						size="sm"
						onClick={onEdit}
					>
						<PenLine />
						Edit
					</Button>
					<Confirm
						trigger={
							<Button
								variant="ghost"
								size="sm"
							>
								<Trash2 />
								Discard
							</Button>
						}
						title="Discard this draft?"
						description="Nobody can send it afterwards."
						action="Discard"
						onConfirm={async () => {
							try {
								await deleteConversationDraftFn({ data: { id: t.id } });
								toast.success("Draft discarded");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							}
						}}
					/>
				</div>
			)}
		</Card>
	);
}

/** After a send: Undo while it waits (the undo window, or a time picked to send it). */
function announce(
	reply: { id: string },
	later: boolean,
	undoSeconds: number,
	reload: () => Promise<void>,
) {
	// A website chat's line has no wait.
	const sent = { scheduled_for: null as string | null, ...reply };
	if (!sent.scheduled_for) {
		toast.success("Reply sent");
		return;
	}
	const undo = {
		label: "Undo",
		onClick: async () => {
			try {
				await unsendReplyFn({ data: { id: sent.id } });
				toast.success("Called back: it's a draft again");
				await reload();
			} catch (error) {
				toast.error(await errorMessage(error));
			}
		},
	};
	if (later)
		toast.success(`Goes ${formatDateTime(sent.scheduled_for)}`, {
			description: "It waits in the conversation until then.",
			action: undo,
		});
	else
		toast(`Sending in ${undoSeconds} seconds…`, {
			duration: Math.max(3, undoSeconds) * 1000,
			action: undo,
		});
}

/** Sends a draft as it is: the person approving it is recorded as who sent it. */
function SendDraft({
	conversation,
	draft,
	onSent,
}: {
	conversation: string;
	draft: string;
	onSent: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const undo = usePage(Route).data.workflow.undo_seconds;
	return (
		<Button
			size="sm"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const sent = await sendConversationReplyFn({
						data: { conversation, draft },
					});
					announce(sent, false, undo, onSent);
					await onSent();
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : <Send />}
			Approve and send
		</Button>
	);
}

/** A reply or draft (one shape, told apart by `type`). */
type Draft = Extract<Item, { type: "reply" | "draft" }>;
type Saved = Data["saved"][number];

const at9 = (days: number) => {
	const d = new Date(Date.now() + days * 86_400_000);
	d.setHours(9, 0, 0, 0);
	return d;
};
const nextMonday = () => {
	const d = at9(0);
	d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
	return d;
};
const short = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
});

/** What's typed just before the caret that opens a menu: @someone in a note, /shortcut in a reply. */
function triggerAt(text: string, caret: number, mode: "reply" | "note") {
	const before = text.slice(0, caret);
	const m =
		mode === "note"
			? /(?:^|\s)@([^\s@]{0,30})$/.exec(before)
			: /(?:^|\n)\/([\w-]{0,30})$/.exec(before);
	if (!m) return null;
	return { q: (m[1] ?? "").toLowerCase(), start: caret - (m[1]?.length ?? 0) - 1, end: caret };
}

function Composer({
	conversation: c,
	compose,
	data,
	ctx,
	draft,
	lastInbound,
	notesOnly,
	onDone,
}: {
	conversation: Conversation;
	compose: Data["compose"];
	data: Data;
	ctx: Parameters<typeof fillVariables>[1];
	draft?: Draft;
	lastInbound?: string;
	notesOnly?: boolean;
	onDone?: () => void;
}) {
	const router = useRouter();
	const { people, saved, workflow } = data;
	const [mode, setMode] = useState<"reply" | "note">(notesOnly ? "note" : "reply");
	const [from, setFrom] = useState(draft?.from ?? compose.from ?? "");
	const [to, setTo] = useState((draft?.to ?? compose.to).join(", "));
	const [cc, setCc] = useState((draft?.cc ?? []).join(", "));
	const [subject, setSubject] = useState(draft?.subject ?? compose.subject);
	const [text, setText] = useState(draft?.text ?? "");
	const [more, setMore] = useState(Boolean(draft) || !compose.from);
	const [busy, setBusy] = useState<"send" | "draft" | "note" | null>(null);
	const [savedId, setSavedId] = useState<string | null>(null);
	const [signature, setSignature] = useState(true);
	const [mentions, setMentions] = useState<{ reader: string; name: string }[]>([]);
	const [picking, setPicking] = useState(false);
	const [menu, setMenu] = useState<{ q: string; start: number; end: number } | null>(null);
	const [index, setIndex] = useState(0);
	const box = useRef<HTMLTextAreaElement>(null);
	// Where the caret goes after a pick (set once the new text is on screen).
	const caret = useRef<number | null>(null);
	useLayoutEffect(() => {
		if (caret.current === null || !box.current) return;
		box.current.focus();
		box.current.setSelectionRange(caret.current, caret.current);
		caret.current = null;
	});
	// The draft's files (kept by id) and new ones (sent as base64).
	const [files, setFiles] = useState<
		{ id: string; filename: string; size: number; content?: string; content_type?: string }[]
	>(() =>
		(draft?.attachments ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
	);
	const fileInput = useRef<HTMLInputElement>(null);
	const addFiles = async (list: FileList | null) => {
		const added = await Promise.all(
			[...(list ?? [])].map(
				(f) =>
					new Promise<(typeof files)[number]>((resolve, reject) => {
						const reader = new FileReader();
						reader.onload = () =>
							resolve({
								id: crypto.randomUUID(),
								filename: f.name,
								size: f.size,
								content: String(reader.result).replace(/^data:[^,]*,/, ""),
								content_type: f.type || undefined,
							});
						reader.onerror = () => reject(reader.error);
						reader.readAsDataURL(f);
					}),
			),
		);
		const next = [...files, ...added];
		if (next.reduce((n, f) => n + f.size, 0) > 20 * 1024 * 1024)
			toast.error("Attachments: up to 20 MB together");
		else setFiles(next);
		if (fileInput.current) fileInput.current.value = "";
	};

	// The menu under the box: people for @, saved replies for /.
	const choices =
		menu === null
			? []
			: mode === "note"
				? people
						.filter((p) => p.type === "person" && p.name.toLowerCase().includes(menu.q))
						.slice(0, 6)
						.map((p) => ({
							key: p.reader,
							label: p.name,
							hint: "",
							pick: () => mention(p),
						}))
				: saved
						.filter(
							(s) =>
								(s.shortcut ?? "").toLowerCase().includes(menu.q) ||
								s.name.toLowerCase().includes(menu.q),
						)
						.slice(0, 6)
						.map((s) => ({
							key: s.id,
							label: s.name,
							hint: s.shortcut ? `/${s.shortcut}` : "",
							pick: () => insertSaved(s, menu),
						}));
	const look = (value: string, caret: number) => {
		const t = triggerAt(value, caret, mode);
		setMenu(t);
		setIndex(0);
	};
	const replaceRange = (start: number, end: number, insert: string) => {
		const next = text.slice(0, start) + insert + text.slice(end);
		setText(next);
		setMenu(null);
		caret.current = start + insert.length;
	};
	const mention = (p: { reader: string; name: string }) => {
		if (!menu) return;
		setMentions((m) => (m.some((x) => x.reader === p.reader) ? m : [...m, p]));
		replaceRange(menu.start, menu.end, `@${p.name} `);
	};
	const insertSaved = (s: Saved, range?: { start: number; end: number } | null) => {
		const filled = fillVariables(s.text, ctx);
		setSavedId(s.id);
		if (range) replaceRange(range.start, range.end, filled);
		else if (!text.trim()) replaceRange(0, text.length, filled);
		else {
			const caret = box.current?.selectionStart ?? text.length;
			replaceRange(caret, caret, filled);
		}
	};

	const fields = {
		conversation: c.id,
		draft: draft?.id,
		from: from || undefined,
		to,
		cc,
		subject,
		text,
		...(savedId ? { saved_reply_id: savedId } : {}),
		...(workflow.signature && !signature ? { signature: false } : {}),
		...(lastInbound && lastInbound !== "sketch" ? { after_message: lastInbound } : {}),
		...(draft || files.length
			? {
					attachments: files.map((f) =>
						f.content
							? {
									filename: f.filename,
									content: f.content,
									...(f.content_type ? { content_type: f.content_type } : {}),
								}
							: { id: f.id },
					),
				}
			: {}),
	};
	const reload = () => router.invalidate();
	const clear = () => {
		if (!draft) {
			setText("");
			setFiles([]);
			setSavedId(null);
			setMentions([]);
		}
	};
	const send = async (o: { at?: Date; resolve?: boolean } = {}) => {
		setBusy("send");
		try {
			const sent = await sendConversationReplyFn({
				data: { ...fields, ...(o.at ? { send_at: o.at.toISOString() } : {}) },
			});
			announce(sent, !!o.at, workflow.undo_seconds, reload);
			if (o.resolve) await updateConversationFn({ data: { id: c.id, status: "resolved" } });
			clear();
			onDone?.();
			await reload();
		} catch (error) {
			const message = await errorMessage(error);
			if (error instanceof Response && error.status === 409 && /new message/i.test(message))
				toast.warning("They wrote again while you were writing", {
					description: "Your reply is still here. Read what they said, then send.",
					action: { label: "Show it", onClick: () => void reload() },
					duration: 12_000,
				});
			else toast.error(message);
		} finally {
			setBusy(null);
		}
	};
	const saveDraft = async () => {
		setBusy("draft");
		try {
			await saveConversationDraftFn({ data: fields });
			toast.success("Draft saved");
			clear();
			onDone?.();
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const addNote = async () => {
		setBusy("note");
		try {
			await addNoteFn({
				data: {
					conversation: c.id,
					text,
					mentions: mentions
						.filter((m) => text.includes(`@${m.name}`))
						.map((m) => m.reader),
				},
			});
			toast.success("Note added");
			setText("");
			setMentions([]);
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const note = mode === "note";
	return (
		<Card
			className={cn(
				"gap-4 px-5 py-4",
				note &&
					"bg-amber-50/50 shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--warning)_30%,transparent)] dark:bg-amber-500/[0.04]",
			)}
		>
			<form
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					if (note) void addNote();
					else void send();
				}}
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					{draft ? (
						<h2 className="font-medium">Edit the draft</h2>
					) : notesOnly ? (
						<h2 className="font-medium">Add a note</h2>
					) : (
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={mode}
							onValueChange={(v) => {
								if (!v) return;
								setMode(v as "reply" | "note");
								setMenu(null);
							}}
						>
							<ToggleGroupItem value="reply">
								<Send />
								Reply
							</ToggleGroupItem>
							<ToggleGroupItem value="note">
								<StickyNote />
								Note
							</ToggleGroupItem>
						</ToggleGroup>
					)}
					{!more && !note && (
						<button
							type="button"
							className="min-w-0 truncate text-sm text-muted-foreground hover:text-foreground"
							onClick={() => setMore(true)}
						>
							From {from} to {to}
						</button>
					)}
				</div>
				{more && !note && (
					<div className="grid gap-3 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="c-from">From</FieldLabel>
							<Input
								id="c-from"
								value={from}
								placeholder="you@your-domain.com"
								onChange={(e) => setFrom(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-to">To</FieldLabel>
							<Input
								id="c-to"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-cc">Cc</FieldLabel>
							<Input
								id="c-cc"
								value={cc}
								onChange={(e) => setCc(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-subject">Subject</FieldLabel>
							<Input
								id="c-subject"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
							/>
						</Field>
					</div>
				)}
				<div className="relative">
					<Textarea
						ref={box}
						aria-label={note ? "Note" : "Message"}
						rows={note ? 3 : 6}
						value={text}
						placeholder={
							note
								? "A note for your team. Type @ to mention someone: they get an email."
								: saved.length
									? "Write a reply, or type / for a saved reply. It goes in the same thread in their mailbox."
									: "Write a reply. It goes in the same thread in their mailbox."
						}
						onChange={(e) => {
							setText(e.target.value);
							look(e.target.value, e.target.selectionStart);
						}}
						onClick={(e) => look(text, e.currentTarget.selectionStart)}
						onBlur={() => setTimeout(() => setMenu(null), 150)}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								if (text.trim()) e.currentTarget.form?.requestSubmit();
								return;
							}
							if (!choices.length) return;
							if (e.key === "ArrowDown" || e.key === "ArrowUp") {
								e.preventDefault();
								setIndex(
									(i) =>
										(i + (e.key === "ArrowDown" ? 1 : -1) + choices.length) %
										choices.length,
								);
							} else if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								choices[index]?.pick();
							} else if (e.key === "Escape") setMenu(null);
						}}
					/>
					{choices.length > 0 && (
						<ul className="absolute top-full left-0 z-20 mt-1 w-72 overflow-hidden rounded-lg bg-popover p-1 text-sm shadow-lg ring-1 ring-border">
							{choices.map((x, i) => (
								<li key={x.key}>
									<button
										type="button"
										className={cn(
											"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
											i === index ? "bg-muted" : "hover:bg-muted",
										)}
										onMouseDown={(e) => {
											e.preventDefault();
											x.pick();
										}}
									>
										{note ? (
											<Avatar name={x.label} />
										) : (
											<Zap className="size-4 shrink-0 text-muted-foreground" />
										)}
										<span className="min-w-0 flex-1 truncate">{x.label}</span>
										{x.hint && (
											<span className="text-xs text-muted-foreground">
												{x.hint}
											</span>
										)}
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				{files.length > 0 && !note && (
					<Files
						list={files}
						onRemove={(id) => setFiles((l) => l.filter((f) => f.id !== id))}
					/>
				)}
				<input
					ref={fileInput}
					type="file"
					multiple
					hidden
					onChange={(e) => void addFiles(e.target.files)}
				/>
				{note ? (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="submit"
							disabled={busy !== null || !text.trim()}
						>
							{busy === "note" ? <Spinner /> : <StickyNote />}
							Add note
						</Button>
						<span className="text-xs text-muted-foreground">
							Never sent to {c.channel === "chat" ? "the visitor" : "them"}.
						</span>
					</div>
				) : (
					<div className="flex flex-wrap items-center gap-2">
						<div className="flex">
							<Button
								type="submit"
								className="rounded-r-none"
								disabled={busy !== null || !text.trim()}
							>
								{busy === "send" ? <Spinner /> : <Send />}
								Send
							</Button>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										className="rounded-l-none border-l border-primary-foreground/20 px-2"
										aria-label="More ways to send"
										disabled={busy !== null || !text.trim()}
									>
										<ChevronDown />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									align="start"
									className="w-60"
								>
									{c.status === "open" && (
										<>
											<DropdownMenuItem
												onSelect={() => void send({ resolve: true })}
											>
												<CircleCheck />
												Send and resolve
											</DropdownMenuItem>
											<DropdownMenuSeparator />
										</>
									)}
									<DropdownMenuLabel>Send later</DropdownMenuLabel>
									{[
										{
											label: "In an hour",
											at: new Date(
												Math.ceil((Date.now() + 3_600_000) / 900_000) *
													900_000,
											),
										},
										{ label: "Tomorrow morning", at: at9(1) },
										{ label: "Monday morning", at: nextMonday() },
									].map((p) => (
										<DropdownMenuItem
											key={p.label}
											onSelect={() => void send({ at: p.at })}
										>
											<span className="flex-1">{p.label}</span>
											<span className="text-xs text-muted-foreground">
												{short.format(p.at)}
											</span>
										</DropdownMenuItem>
									))}
									<DropdownMenuItem onSelect={() => setPicking(true)}>
										Pick a time…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<Button
							type="button"
							variant="outline"
							disabled={busy !== null || !text.trim()}
							onClick={() => void saveDraft()}
						>
							{busy === "draft" ? <Spinner /> : <PenLine />}
							{draft ? "Save draft" : "Save as draft"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							disabled={busy !== null}
							onClick={() => fileInput.current?.click()}
						>
							<Paperclip />
							Attach
						</Button>
						<SavedPicker
							saved={saved}
							onPick={(s) => insertSaved(s)}
						/>
						{onDone && (
							<Button
								type="button"
								variant="ghost"
								onClick={onDone}
							>
								Cancel
							</Button>
						)}
						<span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
							{workflow.signature && (
								<span className="flex items-center gap-1.5">
									<Checkbox
										id={`sig-${c.id}`}
										checked={signature}
										onCheckedChange={(v) => setSignature(v === true)}
									/>
									<label htmlFor={`sig-${c.id}`}>Signature</label>
								</span>
							)}
							<span className="hidden items-center gap-1 sm:flex">
								<Kbd>⌘</Kbd>
								<Kbd>↵</Kbd>
							</span>
						</span>
					</div>
				)}
			</form>
			<PickMoment
				open={picking}
				onOpenChange={setPicking}
				title="Send later"
				description="The reply waits in the conversation and goes at this time (your time zone). Until then you can call it back."
				action="Schedule"
				onPick={(d) => void send({ at: d })}
			/>
		</Card>
	);
}

/** The saved replies, found by name or shortcut. */
function SavedPicker({ saved, onPick }: { saved: Saved[]; onPick: (s: Saved) => void }) {
	const [q, setQ] = useState("");
	const [open, setOpen] = useState(false);
	const shown = saved.filter((s) =>
		`${s.name} ${s.shortcut ?? ""} ${s.text}`.toLowerCase().includes(q.trim().toLowerCase()),
	);
	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
				>
					<Zap />
					Saved replies
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-80 p-2"
			>
				<Input
					autoFocus
					className="h-8"
					placeholder="Find a saved reply"
					value={q}
					onChange={(e) => setQ(e.target.value)}
				/>
				<ul className="mt-2 flex max-h-72 flex-col overflow-y-auto">
					{shown.map((s) => (
						<li key={s.id}>
							<button
								type="button"
								className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted"
								onClick={() => {
									onPick(s);
									setOpen(false);
								}}
							>
								<span className="flex items-center gap-2 text-sm">
									<span className="min-w-0 flex-1 truncate font-medium">
										{s.name}
									</span>
									{s.shortcut && (
										<span className="text-xs text-muted-foreground">
											/{s.shortcut}
										</span>
									)}
								</span>
								<span className="line-clamp-2 text-xs text-muted-foreground">
									{s.text}
								</span>
							</button>
						</li>
					))}
					{!shown.length && (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							{saved.length ? "None match." : "No saved replies yet."}
						</li>
					)}
				</ul>
				<div className="mt-1 border-t pt-2">
					<Link
						to="/received/replies"
						className="block rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						Manage saved replies
					</Link>
				</div>
			</PopoverContent>
		</Popover>
	);
}
