import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	Bot,
	KeyRound,
	MessageCircle,
	MessagesSquare,
	Plus,
	RefreshCw,
	Trash2,
	TriangleAlert,
	User,
	Webhook,
	Workflow,
} from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ChoiceCards } from "@/components/choice-cards";
import { CodeTabs } from "@/components/code-block";
import { Confirm } from "@/components/confirm";
import { CopyIcon, CopyValue, useCopy } from "@/components/copy";
import { Page, Section } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	createInboxCredentialFn,
	createInboxWebhookFn,
	deleteInboxFn,
	getInboxFn,
	revokeInboxCredentialFn,
	rotateInboxCredentialFn,
	updateInboxCredentialFn,
	updateInboxFn,
} from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { DEFAULT_INBOX_SETTINGS } from "@/lib/inbox-settings";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, Sketch, usePage } from "@/lib/sketch";

/** One agent inbox: its settings, credentials, webhooks and audit trail, and how to connect. */
export const Route = createFileRoute("/_app/received/inboxes/$id")({
	loader: ({ params }) => getInboxFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.inbox.name || "Inbox"} · Mailroom` }],
	}),
	component: InboxPage,
	pendingComponent: InboxSketch,
});

type Data = Awaited<ReturnType<typeof getInboxFn>>;
type Credential = Data["credentials"][number];
type Permission = "read" | "attachments" | "triage" | "notes" | "draft" | "send";

const PERMISSIONS: { value: Permission; title: string; description: string }[] = [
	{ value: "read", title: "Read", description: "Conversations and messages (always on)." },
	{ value: "attachments", title: "Attachments", description: "Download what was attached." },
	{
		value: "triage",
		title: "Triage",
		description: "Resolve, tag, snooze, prioritize and assign conversations.",
	},
	{ value: "notes", title: "Notes", description: "Leave internal notes for the team." },
	{ value: "draft", title: "Draft", description: "Write drafts for a person to approve." },
	{ value: "send", title: "Send", description: "Send replies itself, without approval." },
];

function InboxSketch() {
	const data: Data = {
		inbox: {
			object: "inbox",
			id: "",
			brand_id: "",
			name: "Support agent",
			address: "support@example.com",
			domain_id: null,
			reply_from: null,
			send_allow: [],
			send_block: [],
			description: null,
			settings: DEFAULT_INBOX_SETTINGS,
			created_at: "",
			updated_at: "",
		},
		brand: null,
		chat: null,
		retention_days: null,
		credentials: [],
		webhooks: [],
		activity: [],
		events: [],
		base: "https://mailroom.example.com",
		inboxes: [],
	};
	return (
		<Sketch data={data}>
			<InboxPage />
		</Sketch>
	);
}

const ACTIONS: Record<string, string> = {
	"inbox.created": "created the inbox",
	"inbox.updated": "changed its settings",
	"credential.created": "made a credential",
	"credential.updated": "changed a credential",
	"credential.rotated": "rotated a credential",
	"credential.revoked": "revoked a credential",
	"webhook.created": "added a webhook",
	"conversation.read": "read a conversation",
	"conversation.resolved": "resolved a conversation",
	"conversation.reopened": "reopened a conversation",
	"draft.created": "wrote a draft",
	"draft.updated": "edited a draft",
	"draft.deleted": "discarded a draft",
	"reply.sent": "sent a reply",
	"attachment.downloaded": "downloaded an attachment",
	"message.read": "read a message",
	"chat.created": "set up the website chat",
	"chat.updated": "changed the website chat",
	"chat.key_rotated": "made a new chat key",
	"chat.deleted": "removed the website chat",
	"conversation.deleted": "deleted a conversation",
	"chat.started": "started a chat",
};

function InboxPage() {
	const data = usePage(Route).data;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	const { inbox } = data;
	const [token, setToken] = useState<{ token: string; name: string } | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
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
					<span aria-hidden="true"> / </span>
					<Link
						to="/received/inboxes"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Agent inboxes
					</Link>
				</nav>
				<RecordHeader
					icon={Bot}
					tone="brand"
					kind="Agent inbox"
					title={inbox.name}
					actions={
						<>
							<Button
								variant="outline"
								asChild
							>
								<Link
									to="/received"
									search={{ inbox: inbox.id }}
								>
									<MessagesSquare />
									Conversations
								</Link>
							</Button>
							<Button
								variant="outline"
								asChild
							>
								<Link
									to="/received/workflow/$id"
									params={{ id: inbox.id }}
								>
									<Workflow />
									Workflow
								</Link>
							</Button>
							{canManage && (
								<Confirm
									trigger={
										<Button
											variant="ghost"
											aria-label="Delete inbox"
										>
											<Trash2 />
										</Button>
									}
									title={`Delete ${inbox.name}?`}
									description="Its credentials stop working and its webhooks are removed. Its conversations stay, under Other addresses; mail to it keeps arriving there if its domain receives."
									action="Delete inbox"
									onConfirm={async () => {
										try {
											await deleteInboxFn({ data: { id: inbox.id } });
											toast.success("Inbox deleted");
											await router.navigate({ to: "/received/inboxes" });
										} catch (error) {
											toast.error(await errorMessage(error));
										}
									}}
								/>
							)}
						</>
					}
				/>
			</div>

			<Facts>
				<Fact label="Address">
					<CopyValue value={inbox.address} />
				</Fact>
				<Fact label="Replies from">
					{inbox.reply_from ?? (
						<span className="text-warning">Not set: it can't send replies yet</span>
					)}
				</Fact>
				{data.brand && <Fact label="Brand">{data.brand.name}</Fact>}
				<Fact label="Created">{formatDateTime(inbox.created_at)}</Fact>
				<Fact label="Id">
					<IdChip value={inbox.id} />
				</Fact>
			</Facts>

			<WebsiteChat
				inbox={inbox.id}
				chat={data.chat}
				canManage={canManage}
			/>

			{canManage && <Settings inbox={inbox} />}

			<Section
				title="Credentials"
				description="Each reaches this inbox (and, if you choose, other inboxes of the brand), and nothing else in Mailroom, through the API or MCP. Revoke one and it stops at once."
				actions={
					canManage && (
						<CreateCredential
							inboxId={inbox.id}
							inboxes={data.inboxes}
							onCreated={setToken}
						/>
					)
				}
			>
				{data.credentials.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No credentials yet. Make one for the agent that works this inbox.
					</p>
				) : (
					<ul className="flex flex-col gap-3">
						{data.credentials.map((c) => (
							<CredentialRow
								key={c.id}
								inboxId={inbox.id}
								inboxes={data.inboxes}
								credential={c}
								canManage={canManage}
								onRotated={setToken}
							/>
						))}
					</ul>
				)}
			</Section>

			<Connect
				base={data.base}
				inbox={inbox}
			/>

			<Section
				title="Webhooks"
				description="Signed and retried like your other webhooks, with only this inbox's events. Their payloads carry no message text: fetch it with the credential."
				actions={
					canManage && (
						<CreateWebhook
							inboxId={inbox.id}
							events={data.events}
							onCreated={setSecret}
						/>
					)
				}
			>
				{data.webhooks.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						None yet. Organization-wide webhooks with inbox events get this inbox's too.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{data.webhooks.map((h) => (
							<li key={h.id}>
								<Link
									to="/webhooks/$id"
									params={{ id: h.id }}
									className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm shadow-[inset_0_0_0_1px_var(--border)] hover:bg-accent/50"
								>
									<Webhook className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 truncate font-mono">{h.url}</span>
									<span className="ml-auto shrink-0 text-muted-foreground">
										{h.events.length} events
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section
				title="Activity"
				description="What agents and people did here: reads, drafts, replies and credential changes."
			>
				{data.activity.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nothing yet.</p>
				) : (
					<ul className="flex flex-col gap-2 text-sm">
						{data.activity.map((a) => (
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
									<span className="font-medium">
										<Ph>{a.actor.name ?? "Someone"}</Ph>
									</span>{" "}
									{ACTIONS[a.action] ?? a.action}
									{a.conversation_id && (
										<>
											{" · "}
											<Link
												to="/received/$id"
												params={{ id: a.conversation_id }}
												className="underline-offset-2 hover:underline"
											>
												open
											</Link>
										</>
									)}
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
				)}
			</Section>

			<ShownOnce
				open={token !== null}
				onClose={() => setToken(null)}
				title={`Copy ${token?.name ?? "the"} credential`}
				description="Give it to the agent (as a secret). It won't be shown again; rotate it if it's lost."
				value={token?.token ?? ""}
				hint={`Authorization: Bearer ${token?.token.slice(0, 8) ?? ""}…`}
			/>
			<ShownOnce
				open={secret !== null}
				onClose={() => setSecret(null)}
				title="Copy the signing secret"
				description="Check each delivery's signature with it. It's also on the webhook's page."
				value={secret ?? ""}
			/>
		</Page>
	);
}

const lines = (s: string) =>
	s
		.split(/[\s,;]+/)
		.map((x) => x.trim())
		.filter(Boolean);

/** The inbox's website chat, at a glance, with the way to its settings. */
function WebsiteChat({
	inbox,
	chat,
	canManage,
}: {
	inbox: string;
	chat: Data["chat"];
	canManage: boolean;
}) {
	return (
		<Section
			title="Website chat"
			description="A chat bubble on your website. Visitors chat live; the team gets each chat by email and answers by replying, or here."
			actions={
				(chat || canManage) && (
					<Button
						variant={chat ? "outline" : "default"}
						asChild
					>
						<Link
							to="/received/chat/$id"
							params={{ id: inbox }}
						>
							<MessageCircle />
							{chat ? "Chat settings" : "Set up"}
						</Link>
					</Button>
				)
			}
		>
			{chat ? (
				<Card className="flex-row flex-wrap items-center gap-x-6 gap-y-2 px-5 py-4 text-sm">
					<span className="flex items-center gap-2">
						<span
							className={
								chat.enabled
									? "size-2 rounded-full bg-emerald-500"
									: "size-2 rounded-full bg-muted-foreground/40"
							}
						/>
						<span className="font-medium">{chat.enabled ? "On" : "Off"}</span>
					</span>
					<span className="min-w-0 truncate text-muted-foreground">
						{chat.origins.length
							? chat.origins.join(", ")
							: "Not on a website yet: add yours in Install"}
					</span>
					<span className="ml-auto flex gap-4 text-muted-foreground tabular-nums">
						<Link
							to="/received"
							search={{ inbox }}
							className="hover:text-foreground"
						>
							<b className="font-semibold text-foreground">{chat.stats.open}</b> open
						</Link>
						<span>
							<b className="font-semibold text-foreground">{chat.stats.month}</b> in
							30 days
						</span>
					</span>
				</Card>
			) : (
				<p className="text-sm text-muted-foreground">
					Not set up. Chats would arrive here as conversations, next to email.
				</p>
			)}
		</Section>
	);
}

function Settings({ inbox }: { inbox: Data["inbox"] }) {
	const router = useRouter();
	const [name, setName] = useState(inbox.name);
	const [replyFrom, setReplyFrom] = useState(inbox.reply_from ?? "");
	const [allow, setAllow] = useState(inbox.send_allow.join("\n"));
	const [block, setBlock] = useState(inbox.send_block.join("\n"));
	const [busy, setBusy] = useState(false);
	return (
		<Section
			title="Settings"
			description="The send lists hold for every reply from this inbox, agents' and people's, drafts approved included."
		>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					try {
						await updateInboxFn({
							data: {
								id: inbox.id,
								name: name.trim(),
								reply_from: replyFrom.trim() || null,
								send_allow: lines(allow),
								send_block: lines(block),
							},
						});
						toast.success("Saved");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					} finally {
						setBusy(false);
					}
				}}
			>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="i-name">Name</FieldLabel>
						<Input
							id="i-name"
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="i-from">Replies from</FieldLabel>
						<Input
							id="i-from"
							placeholder={
								inbox.domain_id ? inbox.address : "support@your-domain.com"
							}
							value={replyFrom}
							onChange={(e) => setReplyFrom(e.target.value)}
						/>
						<FieldDescription>
							On one of the brand's sending domains. Replies go Reply-To the inbox.
						</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="i-allow">Only send to</FieldLabel>
						<Textarea
							id="i-allow"
							rows={3}
							placeholder={"example.com\nana@example.org"}
							value={allow}
							onChange={(e) => setAllow(e.target.value)}
						/>
						<FieldDescription>Addresses or domains. Empty: anyone.</FieldDescription>
					</Field>
					<Field>
						<FieldLabel htmlFor="i-block">Never send to</FieldLabel>
						<Textarea
							id="i-block"
							rows={3}
							placeholder="competitor.com"
							value={block}
							onChange={(e) => setBlock(e.target.value)}
						/>
						<FieldDescription>Checked before the allow list.</FieldDescription>
					</Field>
				</div>
				<div>
					<Button
						type="submit"
						disabled={busy}
					>
						{busy && <Spinner />}
						Save settings
					</Button>
				</div>
			</form>
		</Section>
	);
}

function PermissionPicker({
	value,
	onChange,
	scope,
	onScope,
}: {
	value: Permission[];
	onChange: (v: Permission[]) => void;
	scope: "replies" | "anyone";
	onScope: (v: "replies" | "anyone") => void;
}) {
	const uid = useId();
	return (
		<>
			<fieldset className="flex flex-col gap-2.5">
				<legend className="mb-1 text-sm font-medium">It may</legend>
				{PERMISSIONS.map((p) => (
					<label
						key={p.value}
						htmlFor={`${uid}-${p.value}`}
						className="flex items-start gap-2.5 text-sm"
					>
						<Checkbox
							id={`${uid}-${p.value}`}
							className="mt-0.5"
							checked={value.includes(p.value)}
							disabled={p.value === "read"}
							onCheckedChange={(v) =>
								onChange(
									v ? [...value, p.value] : value.filter((x) => x !== p.value),
								)
							}
						/>
						<span>
							<span className="font-medium">{p.title}</span>
							<span className="block text-muted-foreground">{p.description}</span>
						</span>
					</label>
				))}
			</fieldset>
			{value.includes("send") && (
				<ChoiceCards
					name="scope"
					value={scope}
					onChange={onScope}
					options={[
						{
							value: "replies",
							title: "Replies only",
							description: "Only to the people already in the conversation.",
						},
						{
							value: "anyone",
							title: "Anyone",
							description:
								"May add new recipients (the inbox's send lists still apply).",
						},
					]}
				/>
			)}
		</>
	);
}

type Reach = { scope: "inbox" | "inboxes" | "brand"; ids: string[] };
type Sibling = Data["inboxes"][number];

/** Which inboxes a credential reaches: this one, some of the brand's, or all of them. */
function ReachPicker({
	inboxId,
	inboxes,
	value,
	onChange,
}: {
	inboxId: string;
	inboxes: Sibling[];
	value: Reach;
	onChange: (v: Reach) => void;
}) {
	const uid = useId();
	if (inboxes.length < 2 && value.scope === "inbox") return null;
	return (
		<div className="flex flex-col gap-2.5">
			<span className="text-sm font-medium">It reaches</span>
			<ChoiceCards
				name={`${uid}-reach`}
				value={value.scope}
				onChange={(scope) => onChange({ ...value, scope })}
				className="sm:grid-cols-3"
				options={[
					{ value: "inbox", title: "This inbox", description: "Only this one." },
					{ value: "inboxes", title: "Some inboxes", description: "The ones you pick." },
					{
						value: "brand",
						title: "Every inbox",
						description: "All of the brand's, new ones too.",
					},
				]}
			/>
			{value.scope === "inboxes" && (
				<fieldset className="flex flex-col gap-2">
					{inboxes.map((i) => (
						<label
							key={i.id}
							htmlFor={`${uid}-${i.id}`}
							className="flex items-center gap-2.5 text-sm"
						>
							<Checkbox
								id={`${uid}-${i.id}`}
								checked={i.id === inboxId || value.ids.includes(i.id)}
								disabled={i.id === inboxId}
								onCheckedChange={(v) =>
									onChange({
										...value,
										ids: v
											? [...value.ids, i.id]
											: value.ids.filter((x) => x !== i.id),
									})
								}
							/>
							<span className="min-w-0 truncate">
								{i.name} <span className="text-muted-foreground">{i.address}</span>
							</span>
						</label>
					))}
				</fieldset>
			)}
		</div>
	);
}

function CreateCredential({
	inboxId,
	inboxes,
	onCreated,
}: {
	inboxId: string;
	inboxes: Sibling[];
	onCreated: (t: { token: string; name: string }) => void;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [perms, setPerms] = useState<Permission[]>(["read"]);
	const [scope, setScope] = useState<"replies" | "anyone">("replies");
	const [reach, setReach] = useState<Reach>({ scope: "inbox", ids: [] });
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
			>
				<Plus />
				New credential
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const r = await createInboxCredentialFn({
									data: {
										id: inboxId,
										name: name.trim(),
										permissions: perms,
										send_scope: scope,
										scope: reach.scope,
										inbox_ids:
											reach.scope === "inboxes" ? reach.ids : undefined,
									},
								});
								setOpen(false);
								setName("");
								setPerms(["read"]);
								setReach({ scope: "inbox", ids: [] });
								onCreated({ token: r.token, name: r.credential.name });
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New credential</DialogTitle>
							<DialogDescription>
								For one agent. It starts read-only: add only what it needs.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-4">
							<Field>
								<FieldLabel htmlFor="cred-name">Name</FieldLabel>
								<Input
									id="cred-name"
									required
									placeholder="Support bot"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
								<FieldDescription>
									Shown on its drafts, replies and activity.
								</FieldDescription>
							</Field>
							<PermissionPicker
								value={perms}
								onChange={setPerms}
								scope={scope}
								onScope={setScope}
							/>
							<ReachPicker
								inboxId={inboxId}
								inboxes={inboxes}
								value={reach}
								onChange={setReach}
							/>
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !name.trim()}
							>
								{busy ? <Spinner /> : <KeyRound />}
								Create credential
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function CredentialRow({
	inboxId,
	inboxes,
	credential: c,
	canManage,
	onRotated,
}: {
	inboxId: string;
	inboxes: Sibling[];
	credential: Credential;
	canManage: boolean;
	onRotated: (t: { token: string; name: string }) => void;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [perms, setPerms] = useState<Permission[]>(c.permissions as Permission[]);
	const [scope, setScope] = useState(c.send_scope as "replies" | "anyone");
	const [reach, setReach] = useState<Reach>({ scope: c.scope, ids: c.inbox_ids });
	const home = inboxes.find((i) => i.id === c.inbox_id);
	const [busy, setBusy] = useState(false);
	const revoked = c.status === "revoked";
	return (
		<li>
			<Card className="gap-3 px-4 py-3">
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
					<KeyRound className="size-4 text-muted-foreground" />
					<span className="font-medium">
						<Ph>{c.name}</Ph>
					</span>
					<code className="font-mono text-xs text-muted-foreground">{c.start}…</code>
					{revoked ? (
						<Badge variant="outline">Revoked</Badge>
					) : (
						<span className="flex flex-wrap gap-1">
							{(c.permissions as Permission[]).map((p) => (
								<Badge
									key={p}
									variant={p === "send" ? "brand" : "secondary"}
								>
									{PERMISSIONS.find((x) => x.value === p)?.title ?? p}
									{p === "send" && c.send_scope === "replies" ? " (replies)" : ""}
								</Badge>
							))}
						</span>
					)}
					{c.scope !== "inbox" && (
						<Badge variant="outline">
							{c.scope === "brand" ? "Every inbox" : `${c.inbox_ids.length} inboxes`}
						</Badge>
					)}
					<span className="ml-auto text-sm text-muted-foreground">
						{c.last_used_at ? `Used ${formatAgo(c.last_used_at)}` : "Never used"}
					</span>
				</div>
				{c.inbox_id !== inboxId && home && (
					<p className="text-sm text-muted-foreground">
						Made on{" "}
						<Link
							to="/received/inboxes/$id"
							params={{ id: home.id }}
							className="underline-offset-2 hover:underline"
						>
							{home.name}
						</Link>
						; it reaches this inbox too.
					</p>
				)}
				{canManage && !revoked && !editing && (
					<div className="flex flex-wrap gap-2">
						<Button
							size="sm"
							variant="outline"
							onClick={() => setEditing(true)}
						>
							Change access
						</Button>
						<Confirm
							trigger={
								<Button
									size="sm"
									variant="outline"
								>
									<RefreshCw />
									Rotate
								</Button>
							}
							title={`Rotate ${c.name}?`}
							description="The current secret stops working at once; you get a new one to give the agent."
							action="Rotate"
							onConfirm={async () => {
								try {
									const r = await rotateInboxCredentialFn({
										data: { id: inboxId, credential: c.id },
									});
									onRotated({ token: r.token, name: c.name });
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
						<Confirm
							trigger={
								<Button
									size="sm"
									variant="ghost"
								>
									<Trash2 />
									Revoke
								</Button>
							}
							title={`Revoke ${c.name}?`}
							description="The agent loses access to this inbox at once. This can't be undone."
							action="Revoke"
							onConfirm={async () => {
								try {
									await revokeInboxCredentialFn({
										data: { id: inboxId, credential: c.id },
									});
									toast.success("Credential revoked");
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
					</div>
				)}
				{editing && (
					<div className="flex flex-col gap-4">
						<PermissionPicker
							value={perms}
							onChange={setPerms}
							scope={scope}
							onScope={setScope}
						/>
						<ReachPicker
							inboxId={c.inbox_id}
							inboxes={inboxes}
							value={reach}
							onChange={setReach}
						/>
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									try {
										await updateInboxCredentialFn({
											data: {
												id: inboxId,
												credential: c.id,
												permissions: perms,
												send_scope: scope,
												scope: reach.scope,
												inbox_ids:
													reach.scope === "inboxes"
														? reach.ids
														: undefined,
											},
										});
										toast.success("Access changed");
										setEditing(false);
										await router.invalidate();
									} catch (error) {
										toast.error(await errorMessage(error));
									} finally {
										setBusy(false);
									}
								}}
							>
								{busy && <Spinner />}
								Save
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setEditing(false)}
							>
								Cancel
							</Button>
						</div>
					</div>
				)}
			</Card>
		</li>
	);
}

function Connect({ base, inbox }: { base: string; inbox: Data["inbox"] }) {
	const mcp = JSON.stringify(
		{
			mcpServers: {
				mailroom: {
					type: "http",
					url: `${base}/mcp`,
					headers: { Authorization: "Bearer mri_…" },
				},
			},
		},
		null,
		2,
	);
	const curl = [
		"# Unread conversations",
		`curl "${base}/api/conversations?unread=true" \\`,
		`  -H "Authorization: Bearer $MAILROOM_INBOX_KEY"`,
		"",
		"# Read one whole, and mark it read for this agent",
		`curl "${base}/api/conversations/<id>?mark_read=true" \\`,
		`  -H "Authorization: Bearer $MAILROOM_INBOX_KEY"`,
		"",
		"# Draft a reply for a person to approve",
		`curl -X POST "${base}/api/conversations/<id>/drafts" \\`,
		`  -H "Authorization: Bearer $MAILROOM_INBOX_KEY" \\`,
		`  -H "Content-Type: application/json" \\`,
		`  -d '{"text":"Thanks for writing. Here is what I found…"}'`,
	].join("\n");
	return (
		<Section
			title="Connect an agent"
			description={`With MCP (tools for listing, reading, drafting and replying, only those its credential allows) or the REST API. Either way it sees only ${inbox.address}.`}
		>
			<CodeTabs
				tabs={[
					{ label: "MCP", code: mcp, lang: "json" },
					{ label: "REST", code: curl, lang: "bash" },
				]}
			/>
		</Section>
	);
}

function CreateWebhook({
	inboxId,
	events,
	onCreated,
}: {
	inboxId: string;
	events: string[];
	onCreated: (secret: string) => void;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [url, setUrl] = useState("");
	const [picked, setPicked] = useState<string[]>(events);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
			>
				<Plus />
				Add webhook
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const hook = await createInboxWebhookFn({
									data: { id: inboxId, url: url.trim(), events: picked },
								});
								setOpen(false);
								setUrl("");
								onCreated((hook as { secret?: string }).secret ?? "");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>Add an inbox webhook</DialogTitle>
							<DialogDescription>
								Mailroom posts each event to it, signed, and retries until it
								answers 2xx.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-4">
							<Field>
								<FieldLabel htmlFor="hook-url">Endpoint</FieldLabel>
								<Input
									id="hook-url"
									type="url"
									required
									placeholder="https://agent.example.com/mailroom"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
								/>
							</Field>
							<fieldset className="flex flex-col gap-2">
								<legend className="mb-1 text-sm font-medium">Events</legend>
								{events.map((ev) => (
									<label
										key={ev}
										htmlFor={`hook-${ev}`}
										className="flex items-center gap-2.5 font-mono text-[13px]"
									>
										<Checkbox
											id={`hook-${ev}`}
											checked={picked.includes(ev)}
											onCheckedChange={(v) =>
												setPicked(
													v
														? [...picked, ev]
														: picked.filter((x) => x !== ev),
												)
											}
										/>
										{ev}
									</label>
								))}
							</fieldset>
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !url.trim() || picked.length === 0}
							>
								{busy ? <Spinner /> : <Webhook />}
								Add webhook
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** A secret shown once, to copy. */
function ShownOnce({
	open,
	onClose,
	title,
	description,
	value,
	hint,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	description: string;
	value: string;
	hint?: string;
}) {
	const { copied, copy } = useCopy(2000);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => !v && onClose()}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<button
						type="button"
						onClick={() => copy(value)}
						className="pressable group flex w-full items-center gap-3 rounded-lg bg-muted px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--border)]"
					>
						<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
							{value}
						</code>
						<span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground">
							<CopyIcon copied={copied} />
							{copied ? "Copied" : "Copy"}
						</span>
					</button>
					{hint && (
						<p className="flex items-start gap-2 text-xs text-muted-foreground">
							<TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
							Send it as <code className="font-mono">{hint}</code>
						</p>
					)}
				</DialogBody>
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
