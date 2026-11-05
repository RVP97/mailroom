import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Bot,
	CircleCheck,
	Mail,
	MailOpen,
	MessagesSquare,
	Paperclip,
	PenLine,
	RotateCcw,
	Send,
	ShieldAlert,
	Trash2,
	User,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
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
import {
	deleteConversationDraftFn,
	getConversationFn,
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
			timeline: [
				{
					type: "inbound",
					id: "sketch",
					at,
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
					icon={MessagesSquare}
					tone={c.status === "resolved" ? "gray" : "blue"}
					kind={c.status === "resolved" ? "Resolved conversation" : "Open conversation"}
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
				<Fact label="With">
					<CopyValue value={c.contact} />
				</Fact>
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

			<ol className="flex flex-col gap-4">
				{c.timeline.map((t) => (
					<li key={`${t.type}-${t.id}`}>
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

			{canReply && !editing && (
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
				{t.attachments.length > 0 && (
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
				{draft && <Badge variant="brand">Needs review</Badge>}
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
type Draft = Extract<Item, { author: unknown }>;

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
	const fields = {
		conversation,
		draft: draft?.id,
		from: from || undefined,
		to,
		cc,
		subject,
		text,
	};
	const run = async (kind: "send" | "draft") => {
		setBusy(kind);
		try {
			if (kind === "send") await sendConversationReplyFn({ data: fields });
			else await saveConversationDraftFn({ data: fields });
			toast.success(kind === "send" ? "Reply sent" : "Draft saved");
			if (!draft) setText("");
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
