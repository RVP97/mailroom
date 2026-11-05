import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Bot,
	CircleCheck,
	Mail,
	MailOpen,
	MessageCircle,
	MessagesSquare,
	Paperclip,
	PenLine,
	RotateCcw,
	Send,
	ShieldAlert,
	Trash2,
	User,
	X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { ChatThread, type Live } from "@/components/chat-thread";
import { Confirm } from "@/components/confirm";
import { CopyValue } from "@/components/copy";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { deleteConversationNowFn } from "@/functions/chat";
import {
	deleteConversationDraftFn,
	getConversationFn,
	markMessageFn,
	olderTimelineFn,
	saveConversationDraftFn,
	sendConversationReplyFn,
	updateConversationFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** One conversation: everything in it in order (what came in, our replies, open drafts), and the
 * reply box. A received message whole (preview, headers, report) is received.m.$id.tsx. */
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
					attachments: [],
					spam: false,
					verdicts: {
						spam: "PASS",
						virus: "PASS",
						spf: "PASS",
						dkim: "PASS",
						dmarc: "PASS",
					},
				},
			],
		},
		compose: { from: null, to: [], subject: "", fixed_from: false },
		inbox: null,
		brand: null,
		activity: [],
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
	"draft.created": "wrote a draft",
	"draft.updated": "edited a draft",
	"draft.deleted": "discarded a draft",
	"reply.sent": "sent a reply",
	"attachment.downloaded": "downloaded an attachment",
	"message.read": "read a message",
	"chat.started": "opened the chat (the visitor's first message)",
};

function ConversationPage() {
	const data = usePage(Route).data;
	const router = useRouter();
	const me = useMe();
	const canReply = allows(me.active?.access, "inbox:reply");
	const { conversation: c, inbox, brand, activity, compose } = data;
	useOpened(
		"conversation-page",
		useMemo(() => ({ ...data, id: c.id, activity: [] }), [data, c.id]),
	);
	const [busy, setBusy] = useState<string | null>(null);
	const reload = () => router.invalidate();
	const update = async (patch: { status?: "open" | "resolved"; read?: boolean }, key: string) => {
		setBusy(key);
		try {
			await updateConversationFn({ data: { id: c.id, ...patch } });
			if (patch.read === false) {
				toast.success("Marked unread");
				await router.navigate({ to: "/received" });
				return;
			}
			toast.success(patch.status === "resolved" ? "Resolved" : "Reopened");
			await reload();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const drafts = c.timeline.filter((t) => t.type === "draft");
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
					tone={c.status === "resolved" ? "gray" : "blue"}
					kind={
						chat
							? c.status === "resolved"
								? "Resolved website chat"
								: "Open website chat"
							: c.status === "resolved"
								? "Resolved conversation"
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
									onClick={() => update({ status: "resolved" }, "status")}
								>
									{busy === "status" ? <Spinner /> : <CircleCheck />}
									Resolve
								</Button>
							) : (
								<Button
									variant="outline"
									disabled={busy !== null}
									onClick={() => update({ status: "open" }, "status")}
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
										title: "Write a draft for review",
										method: "POST",
										path: `/conversations/${c.id}/drafts`,
										body: { text: "Thanks for writing…" },
									},
									{
										title: "Reply in the same thread",
										method: "POST",
										path: `/conversations/${c.id}/reply`,
										body: { text: "Thanks for writing…" },
									},
									{
										title: "Resolve it",
										method: "PATCH",
										path: `/conversations/${c.id}`,
										body: { status: "resolved" },
									},
								]}
							/>
						</>
					}
				/>
			</div>

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
				{c.replied_by && (
					<Fact label="Replied last">
						{c.replied_by === "agent" ? "An agent" : "A person"}
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
								conversation={c.id}
								compose={compose}
								draft={t}
								onDone={() => setEditing(null)}
							/>
						) : (
							<TimelineItem
								conversation={c.id}
								item={t}
								canReply={canReply}
								onEdit={() => setEditing(t.id)}
							/>
						)}
					</li>
				))}
			</ol>

			{canReply && !editing && !chat && (
				<Composer
					conversation={c.id}
					compose={compose}
					key={`${c.id}-${drafts.length}-${c.messages}`}
				/>
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

function TimelineItem({
	conversation,
	item: t,
	canReply,
	onEdit,
}: {
	conversation: string;
	item: Item;
	canReply: boolean;
	onEdit: () => void;
}) {
	const router = useRouter();
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
	if (t.type === "inbound")
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
						{t.text?.trim() ||
							(t.html
								? "No plain-text part: open the message to see it."
								: "No longer kept (past its retention).")}
					</Ph>
				</p>
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
	// A website chat's lines are drawn by ChatThread.
	if (t.type === "chat") return null;
	const draft = t.type === "draft";
	return (
		<Card
			className={cn("gap-3 px-5 py-4", draft ? "border-brand/50 bg-brand/5" : "bg-muted/40")}
		>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="flex items-center gap-2 font-medium">
					{draft ? (
						<PenLine className="size-4 text-muted-foreground" />
					) : (
						<Send className="size-4 text-muted-foreground" />
					)}
					{draft ? "Draft reply" : "Reply"}
				</span>
				<Author author={t.author} />
				{draft && t.author.type === "agent" && <Badge variant="brand">Needs review</Badge>}
				{!draft && t.sent_by && (
					<span className="text-sm text-muted-foreground">approved by {t.sent_by}</span>
				)}
				<span className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
					{!draft && t.delivery && <StatusBadge status={t.delivery} />}
					<span title={formatDateTime(t.at)}>{formatAgo(t.at)}</span>
					{!draft && t.email_id && (
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

/** Sends a draft as it is: the person approving it is recorded as who sent it. */
function SendDraft({
	conversation,
	draft,
	onSent,
}: {
	conversation: string;
	draft: string;
	onSent: () => void;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Button
			size="sm"
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					await sendConversationReplyFn({
						data: { conversation, draft },
					});
					toast.success("Reply sent");
					onSent();
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

function Composer({
	conversation,
	compose,
	draft,
	onDone,
}: {
	conversation: string;
	compose: Data["compose"];
	draft?: Draft;
	onDone?: () => void;
}) {
	const router = useRouter();
	const [from, setFrom] = useState(draft?.from ?? compose.from ?? "");
	const [to, setTo] = useState((draft?.to ?? compose.to).join(", "));
	const [cc, setCc] = useState((draft?.cc ?? []).join(", "));
	const [subject, setSubject] = useState(draft?.subject ?? compose.subject);
	const [text, setText] = useState(draft?.text ?? "");
	const [more, setMore] = useState(Boolean(draft) || !compose.from);
	const [busy, setBusy] = useState<"send" | "draft" | null>(null);
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
	const fields = {
		conversation,
		draft: draft?.id,
		from: from || undefined,
		to,
		cc,
		subject,
		text,
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
	const run = async (kind: "send" | "draft") => {
		setBusy(kind);
		try {
			if (kind === "send") await sendConversationReplyFn({ data: fields });
			else await saveConversationDraftFn({ data: fields });
			toast.success(kind === "send" ? "Reply sent" : "Draft saved");
			if (!draft) {
				setText("");
				setFiles([]);
			}
			onDone?.();
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Card className="gap-4 px-5 py-4">
			<form
				className="contents"
				onSubmit={(e) => {
					e.preventDefault();
					void run("send");
				}}
			>
				<div className="flex items-center justify-between gap-2">
					<h2 className="font-medium">{draft ? "Edit the draft" : "Reply"}</h2>
					{!more && (
						<button
							type="button"
							className="truncate text-sm text-muted-foreground hover:text-foreground"
							onClick={() => setMore(true)}
						>
							From {from} to {to}
						</button>
					)}
				</div>
				{more && (
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
				<Textarea
					aria-label="Message"
					rows={6}
					value={text}
					placeholder="Write a reply. It goes in the same thread in their mailbox."
					onChange={(e) => setText(e.target.value)}
				/>
				{files.length > 0 && (
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
				<div className="flex flex-wrap gap-2">
					<Button
						type="submit"
						disabled={busy !== null || !text.trim()}
					>
						{busy === "send" ? <Spinner /> : <Send />}
						Send
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={busy !== null || !text.trim()}
						onClick={() => run("draft")}
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
					{onDone && (
						<Button
							type="button"
							variant="ghost"
							onClick={onDone}
						>
							Cancel
						</Button>
					)}
				</div>
			</form>
		</Card>
	);
}
