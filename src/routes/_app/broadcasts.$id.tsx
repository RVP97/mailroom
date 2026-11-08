import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	CalendarClock,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	Copy,
	ExternalLink,
	History,
	ImageIcon,
	ImageOff,
	LayoutTemplate,
	ListChecks,
	Megaphone,
	MessageSquare,
	Monitor,
	Moon,
	MoreHorizontal,
	Repeat2,
	Reply,
	Send,
	Smartphone,
	Sun,
	Trash2,
	Vote,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { BroadcastReport } from "@/components/broadcast-report";
import { BroadcastStatus } from "@/components/broadcast-status";
import {
	CommentsSheet,
	HistorySheet,
	RequestReviewDialog,
	ReviewBanner,
	ReviewDialog,
	useComments,
} from "@/components/collab";
import { Confirm } from "@/components/confirm";
import { ContentChecks } from "@/components/content-checks";
import { useCopy } from "@/components/copy";
import { DateTimePicker } from "@/components/date-picker";
import { Choice, Labeled, SwitchRow } from "@/components/design-controls";
import { EmailBuilder } from "@/components/email-builder";
import { EmailContent } from "@/components/email-content";
import { ClientSelect, InboxNotes } from "@/components/inbox-notes";
import { ListSelect } from "@/components/list-dialogs";
import { LiveFrame } from "@/components/live-frame";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { RevenueCard } from "@/components/revenue-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TagField, TagText } from "@/components/variables";
import {
	applyTemplateFn,
	cancelBroadcastFn,
	checkLinksFn,
	deleteBroadcastFn,
	getBroadcastFn,
	pollToSegmentFn,
	resendBroadcastFn,
	saveBroadcastFn,
	sendBroadcastFn,
	sendBroadcastTestFn,
} from "@/functions/broadcasts";
import { kitTheme } from "@/lib/brand-kit";
import { checkContent } from "@/lib/content-check";
import { type EmailDoc, renderEmail } from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatRelative } from "@/lib/format";
import { CLIENTS, type InboxClient, simulate } from "@/lib/inbox-preview";
import { useMe } from "@/lib/me";
import { contactGroups, SAMPLE_VALUES, sampleFill, type VariableGroup } from "@/lib/merge-tags";
import { emailThemeOf } from "@/lib/newsletter-look";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/broadcasts/$id")({
	loader: ({ params }) => getBroadcastFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.broadcast.name ?? "Broadcast"} · Mailroom` }],
	}),
	component: BroadcastPage,
	pendingComponent: BroadcastSketch,
});

type Data = Awaited<ReturnType<typeof getBroadcastFn>>;
type Broadcast = Data["broadcast"];

function BroadcastSketch() {
	const { params } = usePage(Route);
	const row = listedRow<{ name: string; subject: string; status: string }>(
		"broadcasts",
		params.id,
	);
	const status = (row?.status ?? "draft") as Broadcast["status"];
	return (
		<Sketch
			data={
				{
					broadcast: {
						object: "broadcast",
						id: params.id ?? "",
						brand_id: "",
						name: row?.name ?? "Broadcast",
						segment_id: null,
						audience_id: null,
						topic_id: null,
						from: "Mailroom <news@example.com>",
						subject: row?.subject ?? "Our news",
						reply_to: null,
						preview_text: null,
						html: "<p>…</p>",
						text: null,
						design: null,
						ab_test: null,
						test_ends_at: null,
						local_time: null,
						resend_of: null,
						template_id: null,
						newsletter_id: null,
						web: true,
						slug: null,
						campaign_id: null,
						campaign_dedupe: false,
						status,
						scheduled_at: null,
						sent_at: null,
						completed_at: null,
						queued: 0,
						error: null,
						review: null,
						review_requested_by: null,
						reviewed_by: null,
						reviewed_at: null,
						created_at: ago(60 * 24),
						updated_at: ago(60),
					},
					needs_approval: false,
					approved: false,
					people: {},
					created_by: null,
					updated_by: null,
					kit: null,
					brand: null,
					look: { logo: null, logoBackground: null, name: "" },
					variants: [],
					newsletters: [],
					campaigns: [],
					polls: [],
					replies: { count: 0, latest: [] },
					web_url: null,
					nonOpeners: null,
					report: null,
					stats: {
						total: 0,
						unsubscribed: 0,
						queued: 0,
						sent: 0,
						delivered: 0,
						opened: 0,
						clicked: 0,
						bounced: 0,
						complained: 0,
						failed: 0,
						suppressed: 0,
						canceled: 0,
					},
					audience: 0,
					held_out: 0,
					revenue: [],
					properties: [],
					segments: [],
					topics: [],
					templates: [],
					domains: [],
				} satisfies Data
			}
		>
			<BroadcastPage />
		</Sketch>
	);
}

/** What Mailroom fills in a broadcast beyond the contact's own values. */
const BROADCAST_GROUP: VariableGroup = {
	label: "This email",
	items: [
		{ key: "REFERRAL_COUNT", label: "Referrals", hint: "3" },
		{ key: "REFERRAL_URL", label: "Referral link", hint: "https://…/r/…" },
		{ key: "REFERRAL_PAGE_URL", label: "Referral page", hint: "Their count and rewards" },
		{ key: "WEB_VERSION_URL", label: "Web version link", hint: "https://…/view/…" },
	],
};

type Form = {
	name: string;
	segment_id: string;
	topic_id: string;
	from: string;
	subject: string;
	reply_to: string;
	preview_text: string;
	html: string;
	text: string;
	design: EmailDoc | null;
	newsletter_id: string;
	web: boolean;
	campaign_id: string;
	campaign_dedupe: boolean;
};

const formOf = (x: Broadcast): Form => ({
	name: x.name,
	segment_id: x.segment_id ?? "",
	topic_id: x.topic_id ?? "",
	from: x.from,
	subject: x.subject,
	reply_to: x.reply_to?.join(", ") ?? "",
	preview_text: x.preview_text ?? "",
	html: x.html,
	text: x.text ?? "",
	design: (x.design as EmailDoc | null) ?? null,
	newsletter_id: x.newsletter_id ?? "",
	web: x.web,
	campaign_id: x.campaign_id ?? "",
	campaign_dedupe: x.campaign_dedupe,
});

const toFields = (f: Form) => ({
	name: f.name,
	segment_id: f.segment_id || null,
	topic_id: f.topic_id || null,
	from: f.from,
	subject: f.subject,
	reply_to: f.reply_to,
	preview_text: f.preview_text,
	html: f.design ? renderEmail(f.design) : f.html,
	text: f.text || null,
	design: f.design,
	newsletter_id: f.newsletter_id || null,
	web: f.web,
	campaign_id: f.campaign_id || null,
	campaign_dedupe: f.campaign_dedupe,
});

function BroadcastPage() {
	const { data } = usePage(Route);
	const saved = data.broadcast;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "broadcasts:edit");
	const canSend = allows(me.active?.access, "broadcasts:send");
	const canApprove = allows(me.active?.access, "broadcasts:approve");
	const draft = saved.status === "draft";
	const editable = draft && canManage;
	/** Sending is open: no approval needed, or it holds for what the draft says now. */
	const cleared = !data.needs_approval || data.approved;
	const subject = { type: "broadcast", id: saved.id } as const;
	const comments = useComments(subject);
	const [commenting, setCommenting] = useState(false);
	const [onBlock, setOnBlock] = useState<{ id: string; label: string } | null>(null);
	const [focus, setFocus] = useState<string | null>(null);
	const [history, setHistory] = useState(false);
	const [asking, setAsking] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const refresh = async () => {
		await router.invalidate();
		await comments.load();
	};
	const [form, setForm] = useState<Form>(() => formOf(saved));
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved broadcast changes
	useEffect(() => setForm(formOf(saved)), [saved.updated_at, saved.id]);
	const dirty = JSON.stringify(toFields(form)) !== JSON.stringify(toFields(formOf(saved)));
	const [busy, setBusy] = useState(false);
	const [sending, setSending] = useState(false);
	const [testing, setTesting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [stopping, setStopping] = useState(false);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	const [building, setBuilding] = useState(false);
	const shown = useMemo(
		() => (form.design ? { ...form, html: renderEmail(form.design) } : form),
		[form],
	);

	const save = async (quiet = false) => {
		setBusy(true);
		try {
			await saveBroadcastFn({ data: { id: saved.id, fields: toFields(form) } });
			if (!quiet) toast.success("Draft saved");
			await router.invalidate();
			return true;
		} catch (error) {
			toast.error(await errorMessage(error));
			return false;
		} finally {
			setBusy(false);
		}
	};

	const segment = data.segments.find((s) => s.id === saved.segment_id);
	const topic = data.topics.find((t) => t.id === saved.topic_id);
	const live =
		saved.status === "sending" || saved.status === "scheduled" || saved.status === "testing";
	const [resending, setResending] = useState(false);

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/broadcasts"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Broadcasts
					</Link>
				</nav>
				<RecordHeader
					icon={Megaphone}
					tone={draft ? "gray" : "blue"}
					kind={data.brand ? `Broadcast of ${data.brand.name}` : "Broadcast"}
					title={saved.name}
					actions={
						<>
							{editable && (
								<>
									<Button
										variant="outline"
										className="hidden sm:inline-flex"
										disabled={!dirty || busy}
										onClick={() => save()}
									>
										{busy && <Spinner />}
										Save draft
									</Button>
									{canSend && (cleared || dirty) ? (
										<Button
											disabled={busy}
											onClick={async () => {
												if (dirty && !(await save(true))) return;
												// Saving changes ends an approval; ask again if it's needed.
												if (data.needs_approval && dirty) {
													setAsking(true);
													return;
												}
												setSending(true);
											}}
										>
											<Send />
											Send…
										</Button>
									) : saved.review !== "requested" ? (
										<Button
											disabled={busy}
											onClick={async () => {
												if (dirty && !(await save(true))) return;
												setAsking(true);
											}}
										>
											<Send />
											Ask for review
										</Button>
									) : null}
								</>
							)}
							<Button
								variant="outline"
								aria-label="Comments"
								onClick={() => setCommenting(true)}
							>
								<MessageSquare />
								{comments.open > 0 ? (
									<span className="tabular-nums">{comments.open}</span>
								) : (
									<span className="hidden lg:inline">Comments</span>
								)}
							</Button>
							{canSend && saved.status === "sent" && (data.nonOpeners ?? 0) > 0 && (
								<Button
									variant="outline"
									onClick={() => setResending(true)}
								>
									<Repeat2 />
									<span className="hidden sm:inline">Resend to non-openers</span>
								</Button>
							)}
							{canSend && live && (
								<Button
									variant="outline"
									onClick={() => setStopping(true)}
								>
									{saved.status === "scheduled" ? "Unschedule" : "Stop sending"}
								</Button>
							)}
							<ApiDrawer
								title="This broadcast in the API"
								description="Needs a full-access key."
								calls={[
									{
										title: "Get it",
										method: "GET",
										path: `/broadcasts/${saved.id}`,
									},
									{
										title: "Send it",
										method: "POST",
										path: `/broadcasts/${saved.id}/send`,
										body: { scheduled_at: "in 1 hour" },
									},
								]}
							/>
							<More
								broadcast={saved}
								canManage={canManage}
								canSave={editable && dirty && !busy}
								onSave={() => save()}
								onTest={async () => {
									if (dirty && !(await save(true))) return;
									setTesting(true);
								}}
								onDelete={() => setDeleting(true)}
								onHistory={() => setHistory(true)}
							/>
						</>
					}
				/>
				<ReviewBanner
					broadcast={saved}
					people={data.people}
					needsApproval={data.needs_approval}
					approved={data.approved}
					canApprove={canApprove}
					onReview={() => setReviewing(true)}
					onChanged={refresh}
				/>
			</div>
			<CommentsSheet
				subject={subject}
				comments={comments}
				open={commenting}
				onOpenChange={setCommenting}
				canComment
				block={onBlock}
				onBlock={(id) => {
					if (!id) return setOnBlock(null);
					// A comment's block: open the design on it.
					if (form.design && editable) {
						setFocus(id);
						setCommenting(false);
						setBuilding(true);
					}
				}}
			/>
			<HistorySheet
				subject={subject}
				open={history}
				onOpenChange={setHistory}
				canRestore={editable}
				onRestored={refresh}
			/>
			<RequestReviewDialog
				id={saved.id}
				open={asking}
				onOpenChange={setAsking}
				onDone={refresh}
			/>
			<ReviewDialog
				id={saved.id}
				seen={saved.updated_at}
				open={reviewing}
				onOpenChange={setReviewing}
				onDone={refresh}
			/>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this broadcast?"
				description="The draft goes; nothing was sent."
				action="Delete broadcast"
				onConfirm={async () => {
					try {
						await deleteBroadcastFn({ data: { id: saved.id } });
						toast.success("Broadcast deleted");
						await router.navigate({ to: "/broadcasts" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			<Confirm
				open={stopping}
				onOpenChange={setStopping}
				title={saved.status === "scheduled" ? "Unschedule it?" : "Stop sending it?"}
				description={
					saved.status === "scheduled"
						? "It goes back to a draft you can change and send again."
						: "Emails not sent yet are canceled. Those already sent stay sent."
				}
				action={saved.status === "scheduled" ? "Unschedule" : "Stop sending"}
				onConfirm={async () => {
					try {
						await cancelBroadcastFn({ data: { id: saved.id } });
						toast.success(saved.status === "scheduled" ? "Back to draft" : "Stopped");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			<SendDialog
				open={sending}
				onOpenChange={setSending}
				broadcast={saved}
				audience={data.audience}
				heldOut={data.held_out}
				segment={segment?.name}
				newsletter={data.newsletters.find((n) => n.id === saved.newsletter_id) ?? null}
			/>
			{building && form.design && (
				<EmailBuilder
					doc={form.design}
					onChange={(d) => set("design", d)}
					brand={data.look}
					title={form.name || "Broadcast"}
					subject={form.subject}
					previewText={form.preview_text}
					variables={contactGroups(data.properties, BROADCAST_GROUP)}
					polls
					kit={data.kit}
					focus={focus}
					onComment={(id, label) => {
						setOnBlock({ id, label });
						setCommenting(true);
					}}
					onClose={() => {
						setFocus(null);
						setBuilding(false);
					}}
					actions={
						<>
							<span className="hidden text-xs text-muted-foreground md:inline">
								{dirty ? "Unsaved changes" : "Saved"}
							</span>
							<Button
								variant="outline"
								disabled={!dirty || busy}
								onClick={() => save()}
							>
								{busy && <Spinner />}
								Save
							</Button>
							<Button
								onClick={async () => {
									if (dirty && !(await save(true))) return;
									setBuilding(false);
								}}
							>
								Done
							</Button>
						</>
					}
				/>
			)}
			<ResendDialog
				open={resending}
				onOpenChange={setResending}
				broadcast={saved}
				count={data.nonOpeners ?? 0}
			/>
			<SendTest
				open={testing}
				onOpenChange={setTesting}
				id={saved.id}
				defaultTo={me.user.email}
			/>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">
					<BroadcastStatus status={saved.status} />
				</Fact>
				<Fact label="Segment">
					{segment ? (
						<span className="truncate">{segment.name}</span>
					) : (
						<span className="text-muted-foreground">Not picked</span>
					)}
				</Fact>
				<Fact label={draft || saved.status === "scheduled" ? "Goes to" : "Recipients"}>
					<span className="tabular-nums">
						<Ph>
							{(draft || saved.status === "scheduled"
								? (data.audience ?? 0)
								: saved.queued
							).toLocaleString()}{" "}
							contacts
						</Ph>
					</span>
				</Fact>
				<Fact label={saved.status === "scheduled" ? "Goes" : "Sent"}>
					{saved.status === "scheduled" && saved.local_time ? (
						<span title="In each contact's time zone">
							{formatLocal(saved.local_time)}, their time
						</span>
					) : saved.status === "scheduled" && saved.scheduled_at ? (
						<span title={formatDateTime(saved.scheduled_at)}>
							{formatRelative(saved.scheduled_at)}
						</span>
					) : saved.sent_at ? (
						<span title={formatDateTime(saved.sent_at)}>
							{formatRelative(saved.sent_at)}
						</span>
					) : (
						<span className="text-muted-foreground">Not yet</span>
					)}
				</Fact>
				{(saved.newsletter_id || saved.campaign_id) && (
					<Fact label={saved.newsletter_id ? "Newsletter" : "Campaign"}>
						{saved.newsletter_id ? (
							<Link
								to="/newsletters/$id"
								params={{ id: saved.newsletter_id }}
								className="truncate hover:underline"
							>
								{data.newsletters.find((n) => n.id === saved.newsletter_id)?.name ??
									"Newsletter"}
							</Link>
						) : (
							<Link
								to="/campaigns/$id"
								params={{ id: saved.campaign_id as string }}
								className="truncate hover:underline"
							>
								{data.campaigns.find((c) => c.id === saved.campaign_id)?.name ??
									"Campaign"}
							</Link>
						)}
					</Fact>
				)}
				{data.web_url && (
					<Fact label="Web version">
						<a
							href={data.web_url}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 truncate hover:underline"
						>
							Open
							<ExternalLink className="size-3.5" />
						</a>
					</Fact>
				)}
				<Fact label="Id">
					<IdChip value={saved.id} />
				</Fact>
			</Facts>

			{saved.error && (
				<p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
					{saved.error}
				</p>
			)}

			{!draft && <Stats stats={data.stats} />}
			{saved.ab_test && saved.status !== "draft" && saved.status !== "scheduled" && (
				<AbResults
					broadcast={saved}
					variants={data.variants}
				/>
			)}
			{data.polls.length > 0 && (
				<PollResults
					broadcastId={saved.id}
					polls={data.polls}
					segments={data.segments}
					brand={saved.brand_id}
					canManage={canManage}
				/>
			)}
			<RevenueCard
				revenue={data.revenue}
				what="this broadcast"
			/>
			{data.replies.count > 0 && <Replies replies={data.replies} />}
			{data.report && (
				<BroadcastReport
					report={data.report}
					html={sampleFill(shown.html)}
					sent={data.stats.sent}
				/>
			)}

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-6">
					{editable ? (
						<Editor
							form={form}
							set={set}
							data={data}
							onBuild={() => setBuilding(true)}
							onTemplate={async (template) => {
								if (dirty && !(await save(true))) return;
								try {
									await applyTemplateFn({ data: { id: saved.id, template } });
									toast.success("Template's content copied in");
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
					) : (
						<Card className="gap-4 p-5 text-sm">
							<h2 className="font-semibold">Details</h2>
							<dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5">
								<dt className="text-muted-foreground">From</dt>
								<dd className="truncate">{saved.from}</dd>
								<dt className="text-muted-foreground">Subject</dt>
								<dd className="truncate">
									<TagText text={saved.subject} />
								</dd>
								{saved.preview_text && (
									<>
										<dt className="text-muted-foreground">Preview text</dt>
										<dd className="truncate">{saved.preview_text}</dd>
									</>
								)}
								{saved.reply_to && (
									<>
										<dt className="text-muted-foreground">Reply-To</dt>
										<dd className="truncate">{saved.reply_to.join(", ")}</dd>
									</>
								)}
								<dt className="text-muted-foreground">Topic</dt>
								<dd className="truncate">
									{topic?.name ?? "None (every broadcast)"}
								</dd>
							</dl>
						</Card>
					)}
				</div>
				<Preview
					form={shown}
					email={me.user.email}
				/>
			</div>
		</Page>
	);
}

/** "Nov 10, 9:00" from a wall-clock time. */
const formatLocal = (local: string) => {
	const [d, t] = local.split("T");
	const [y, m, day] = (d ?? "").split("-").map(Number);
	const date = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, day ?? 1, 12));
	return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })}, ${t}`;
};

function AbResults({
	broadcast: x,
	variants,
}: {
	broadcast: Broadcast;
	variants: Data["variants"];
}) {
	const ab = x.ab_test;
	if (!ab) return null;
	const subjects = [x.subject, ...ab.subjects];
	const rate = (v: (typeof variants)[number] | undefined) =>
		v?.sent ? (ab.metric === "clicks" ? v.clicked : v.opened) / v.sent : 0;
	const best = Math.max(
		...subjects.map((_, i) => rate(variants.find((v) => v.variant === i))),
		0,
	);
	return (
		<Card className="gap-0 p-0">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-5 py-3.5">
				<h2 className="text-sm font-semibold">A/B test of the subject line</h2>
				<p className="text-xs text-muted-foreground">
					{ab.winner !== null
						? `${"ABC"[ab.winner]} won on ${ab.metric}, and went to the rest`
						: x.test_ends_at
							? `The winner, by ${ab.metric}, goes to the rest ${formatRelative(x.test_ends_at)}`
							: `Sending the test to ${ab.size}% of the segment`}
				</p>
			</div>
			<ul className="flex flex-col">
				{subjects.map((subject, i) => {
					const v = variants.find((r) => r.variant === i);
					const r = rate(v);
					const won = ab.winner === i;
					const leading = ab.winner === null && r > 0 && r === best;
					return (
						<li
							key={i}
							className="flex flex-col gap-2 border-b border-border/70 px-5 py-4 last:border-b-0"
						>
							<div className="flex items-center gap-3">
								<span
									className={cn(
										"flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold",
										won &&
											"bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
									)}
								>
									{"ABC"[i]}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm">
									<TagText text={subject} />
								</span>
								{won && (
									<span className="rounded-full bg-emerald-500/12 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
										Winner
									</span>
								)}
								{leading && (
									<span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
										Leading
									</span>
								)}
								<span className="w-14 text-right text-sm font-semibold tabular-nums">
									<Ph>{(r * 100).toFixed(1)}%</Ph>
								</span>
							</div>
							<div className="ml-9 h-1.5 overflow-hidden rounded-full bg-muted">
								<div
									className={cn(
										"h-full rounded-full bg-foreground/70 transition-[width] duration-500",
										won && "bg-emerald-500",
									)}
									style={{ width: `${best ? (r / best) * 100 : 0}%` }}
								/>
							</div>
							<p className="ml-9 text-xs text-muted-foreground tabular-nums">
								<Ph>
									{(v?.sent ?? 0).toLocaleString()} sent ·{" "}
									{(v?.opened ?? 0).toLocaleString()} opened ·{" "}
									{(v?.clicked ?? 0).toLocaleString()} clicked
								</Ph>
							</p>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}

function ResendDialog({
	open,
	onOpenChange,
	broadcast,
	count,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	broadcast: Broadcast;
	count: number;
}) {
	const router = useRouter();
	const [subject, setSubject] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const r = await resendBroadcastFn({
								data: { id: broadcast.id, subject },
							});
							toast.success("A draft for those who didn't open is ready");
							onOpenChange(false);
							await router.navigate({ to: "/broadcasts/$id", params: { id: r.id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Resend to those who didn't open</DialogTitle>
						<DialogDescription>
							{count.toLocaleString()} {count === 1 ? "contact" : "contacts"} haven't
							opened or clicked it. They get the same email as a new broadcast, with a
							fresh subject line.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="resend-subject">New subject</FieldLabel>
							<TagField
								id="resend-subject"
								placeholder="Did you see this?"
								value={subject}
								onChange={setSubject}
							/>
							<FieldDescription>
								A different angle works best. Most senders wait two or three days
								before resending.
							</FieldDescription>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !subject.trim()}
						>
							{busy ? <Spinner /> : <Repeat2 />}
							Make the draft
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function Stats({ stats }: { stats: Data["stats"] }) {
	const base = Math.max(stats.sent, 1);
	const items = [
		{ label: "Sent", n: stats.sent, of: stats.total },
		{ label: "Delivered", n: stats.delivered, pct: stats.delivered / base },
		{ label: "Opened", n: stats.opened, pct: stats.opened / base },
		{ label: "Clicked", n: stats.clicked, pct: stats.clicked / base },
		{ label: "Bounced", n: stats.bounced, pct: stats.bounced / base },
		{ label: "Unsubscribed", n: stats.unsubscribed, pct: stats.unsubscribed / base },
	];
	return (
		<Card className="grid grid-cols-2 gap-0 p-0 sm:grid-cols-3 lg:grid-cols-6">
			{items.map((s, i) => (
				<div
					key={s.label}
					className={cn(
						"flex flex-col gap-1 border-border/70 px-5 py-4",
						i % 2 === 1 && "border-l",
						i >= 2 && "border-t sm:border-t-0",
						"sm:border-l sm:[&:nth-child(3n+1)]:border-l-0 lg:[&:nth-child(3n+1)]:border-l",
						i >= 3 && "sm:border-t lg:border-t-0",
						i === 0 && "lg:border-l-0",
					)}
				>
					<span className="text-xs text-muted-foreground">{s.label}</span>
					<span className="text-xl font-semibold tabular-nums">
						<Ph>{s.n.toLocaleString()}</Ph>
					</span>
					<span className="text-xs text-muted-foreground tabular-nums">
						<Ph>
							{s.of !== undefined
								? `of ${s.of.toLocaleString()} queued`
								: `${((s.pct ?? 0) * 100).toFixed(1)}%`}
						</Ph>
					</span>
				</div>
			))}
		</Card>
	);
}

function Editor({
	form,
	set,
	data,
	onTemplate,
	onBuild,
}: {
	form: Form;
	set: <K extends keyof Form>(k: K, v: Form[K]) => void;
	data: Data;
	onTemplate: (id: string) => void;
	onBuild: () => void;
}) {
	const defaultFrom = data.domains.find((d) => d.purpose === "marketing") ?? data.domains[0];
	const groups = useMemo(
		() => contactGroups(data.properties, BROADCAST_GROUP),
		[data.properties],
	);
	// An issue starts in its newsletter's color, fonts and logo.
	const nl = data.newsletters.find((x) => x.id === form.newsletter_id) ?? null;
	// The brand kit's look is offered over each design's own ("Brand colors").
	const issueTheme = nl ? emailThemeOf(nl.look, nl.accent) : undefined;
	const kitLook = data.kit ? kitTheme(data.kit) : null;
	const issueLook =
		nl && nl.look.logo !== "brand"
			? {
					...data.look,
					logo:
						nl.look.logo === "none" || /\.svg(\?|$)/i.test(nl.look.logo)
							? null
							: nl.look.logo,
				}
			: null;
	return (
		<>
			<Card className="gap-5 p-5">
				<Field>
					<FieldLabel htmlFor="b-name">Name</FieldLabel>
					<Input
						id="b-name"
						value={form.name}
						onChange={(e) => set("name", e.target.value)}
					/>
					<FieldDescription>Only you see it.</FieldDescription>
				</Field>
				{(data.newsletters.length > 0 || data.campaigns.length > 0) && (
					<div className="grid gap-5 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="b-newsletter">Newsletter</FieldLabel>
							<Select
								value={form.newsletter_id || "none"}
								onValueChange={(v) => {
									const id = v === "none" ? "" : v;
									set("newsletter_id", id);
									const n = data.newsletters.find((x) => x.id === id);
									// An issue starts from its newsletter's audience and sender.
									if (n) {
										if (!form.segment_id && n.segment_id)
											set("segment_id", n.segment_id);
										if (!form.topic_id && n.topic_id)
											set("topic_id", n.topic_id);
										if (!form.from && n.from) set("from", n.from);
									}
								}}
							>
								<SelectTrigger id="b-newsletter">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">None (a one-off)</SelectItem>
									{data.newsletters.map((n) => (
										<SelectItem
											key={n.id}
											value={n.id}
										>
											{n.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{form.newsletter_id &&
								data.newsletters.find((n) => n.id === form.newsletter_id)
									?.public && (
									<SwitchRow
										label="On the public page"
										hint="Once sent, anyone can read it there."
										checked={form.web}
										onChange={(v) => set("web", v)}
									/>
								)}
						</Field>
						<Field>
							<FieldLabel htmlFor="b-campaign">Campaign</FieldLabel>
							<Select
								value={form.campaign_id || "none"}
								onValueChange={(v) => {
									set("campaign_id", v === "none" ? "" : v);
									if (v === "none") set("campaign_dedupe", false);
								}}
							>
								<SelectTrigger id="b-campaign">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="none">None</SelectItem>
									{data.campaigns.map((c) => (
										<SelectItem
											key={c.id}
											value={c.id}
										>
											{c.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{form.campaign_id && (
								<SwitchRow
									label="Skip those already reached"
									hint="Leave out contacts another email of the campaign went to."
									checked={form.campaign_dedupe}
									onChange={(v) => set("campaign_dedupe", v)}
								/>
							)}
						</Field>
					</div>
				)}
				<div className="grid gap-5 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="b-segment">Send to</FieldLabel>
						<ListSelect
							kind="segment"
							id="b-segment"
							brand={data.broadcast.brand_id || null}
							value={form.segment_id}
							onChange={(v) => set("segment_id", v)}
							items={data.segments.map((s) => ({
								id: s.id,
								name: `${s.name} (${(s.contacts ?? 0).toLocaleString()})`,
							}))}
							none="Pick a segment"
							noneDisabled
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="b-topic">Topic</FieldLabel>
						<ListSelect
							kind="topic"
							id="b-topic"
							brand={data.broadcast.brand_id || null}
							value={form.topic_id}
							onChange={(v) => set("topic_id", v)}
							items={data.topics}
							none="None"
						/>
						<FieldDescription>
							Only contacts in the topic get it, and its unsubscribe link leaves only
							the topic.
						</FieldDescription>
					</Field>
				</div>
				<Field>
					<FieldLabel htmlFor="b-from">From</FieldLabel>
					<Input
						id="b-from"
						spellCheck={false}
						list="b-from-domains"
						placeholder={
							defaultFrom
								? `${data.brand?.name ?? "News"} <news@${defaultFrom.name}>`
								: "News <news@your-domain.com>"
						}
						value={form.from}
						onChange={(e) => set("from", e.target.value)}
					/>
					<datalist id="b-from-domains">
						{data.domains.map((d) => (
							<option
								key={d.name}
								value={`${data.brand?.name ?? "News"} <news@${d.name}>`}
							/>
						))}
					</datalist>
				</Field>
				<Field>
					<FieldLabel htmlFor="b-subject">Subject</FieldLabel>
					<TagField
						id="b-subject"
						placeholder="Our news this month"
						groups={groups}
						value={form.subject}
						onChange={(v) => set("subject", v)}
					/>
				</Field>
				<div className="grid gap-5 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="b-preview">Preview text</FieldLabel>
						<TagField
							id="b-preview"
							placeholder="Optional"
							groups={groups}
							value={form.preview_text}
							onChange={(v) => set("preview_text", v)}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="b-reply">Reply-To</FieldLabel>
						<Input
							id="b-reply"
							spellCheck={false}
							placeholder="Optional"
							value={form.reply_to}
							onChange={(e) => set("reply_to", e.target.value)}
						/>
					</Field>
				</div>
			</Card>

			<EmailContent
				design={form.design}
				html={form.html}
				text={form.text}
				set={(k, v) => set(k, v as never)}
				look={issueLook ?? data.look}
				theme={issueTheme}
				kit={kitLook}
				kind={nl ? "newsletter" : "broadcast"}
				onBuild={onBuild}
				extra={
					data.templates.length > 0 && (
						<Select
							value=""
							onValueChange={onTemplate}
						>
							<SelectTrigger
								size="sm"
								aria-label="Start from a template"
								className="w-auto border-0 shadow-none"
							>
								<LayoutTemplate />
								<span className="hidden sm:inline">From a template</span>
							</SelectTrigger>
							<SelectContent align="end">
								{data.templates.map((t) => (
									<SelectItem
										key={t.id}
										value={t.id}
									>
										{t.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)
				}
				footer={
					<>
						Variables like <span className="mt-chip">First name</span> are filled in for
						each contact. Without an unsubscribe link, Mailroom adds one at the bottom.
					</>
				}
			/>
		</>
	);
}

function Preview({ form, email }: { form: Form; email: string }) {
	const [phone, setPhone] = useState(false);
	const [dark, setDark] = useState(false);
	const [client, setClient] = useState<InboxClient>("default");
	const [images, setImages] = useState(true);
	const values = useMemo(
		() => ({ ...SAMPLE_VALUES, EMAIL: email, UNSUBSCRIBE_URL: "#unsubscribe" }),
		[email],
	);
	const shown = useMemo(
		() => simulate(sampleFill(form.html, values), { client, dark, images }),
		[form.html, values, client, dark, images],
	);
	const changed = client !== "default" || dark || !images;
	return (
		<Card className="min-w-0 gap-0 overflow-hidden p-0 lg:sticky lg:top-4">
			<div className="flex h-12 items-center gap-2 border-b border-border/70 pr-3 pl-5">
				<p className="min-w-0 flex-1 truncate text-sm">
					<span className="text-muted-foreground">Subject </span>
					<Ph>{sampleFill(form.subject, values) || "No subject"}</Ph>
				</p>
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{[
						{ on: false, icon: Monitor, label: "Desktop width" },
						{ on: true, icon: Smartphone, label: "Phone width" },
					].map((w) => (
						<button
							key={w.label}
							type="button"
							aria-label={w.label}
							title={w.label}
							aria-pressed={phone === w.on}
							onClick={() => setPhone(w.on)}
							className={cn(
								"flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:text-foreground",
								phone === w.on &&
									"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
							)}
						>
							<w.icon className="size-3.5" />
						</button>
					))}
				</div>
				<button
					type="button"
					aria-label={dark ? "Light inbox" : "Dark inbox"}
					title={
						dark
							? "Light inbox"
							: "Dark inbox (roughly how Gmail and Outlook darken it)"
					}
					aria-pressed={dark}
					onClick={() => setDark((d) => !d)}
					className={cn(
						"flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:text-foreground",
						dark && "text-foreground",
					)}
				>
					{dark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
				</button>
				<button
					type="button"
					aria-label={images ? "Images off" : "Images on"}
					title={images ? "Images off (as inboxes that block them show it)" : "Images on"}
					aria-pressed={!images}
					onClick={() => setImages((v) => !v)}
					className={cn(
						"flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground transition-colors hover:text-foreground",
						!images && "text-foreground",
					)}
				>
					{images ? (
						<ImageOff className="size-3.5" />
					) : (
						<ImageIcon className="size-3.5" />
					)}
				</button>
			</div>
			<ClientSelect
				value={client}
				onChange={setClient}
				className="border-b border-border/70 px-3 pt-2.5 pb-2"
			/>
			<div
				className={cn(
					"bg-muted/60 transition-[padding] duration-300 ease-out",
					phone && "px-4 py-6",
				)}
			>
				<LiveFrame
					title="Preview"
					html={shown}
					className={cn(
						"mx-auto block h-[560px] w-full bg-white sm:h-[720px]",
						phone &&
							"max-w-[390px] rounded-2xl shadow-[0_0_0_1px_var(--border),0_8px_24px_-8px_var(--shadow-color-strong)]",
					)}
				/>
			</div>
			<p className="border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
				Shown with Ana García as the contact
				{client !== "default"
					? `, roughly as ${CLIENTS.find((c) => c.id === client)?.label} shows it`
					: ""}
				{dark ? ", in a dark inbox" : ""}
				{!images ? ", with images off" : ""}.
				{changed ? " An approximation: send a test to be sure." : ""}
			</p>
			<InboxNotes html={form.html} />
			<ContentChecks
				subject={form.subject}
				html={form.html}
				text={form.text}
				marketing
			/>
		</Card>
	);
}

/** Today plus `hours`, as a datetime-local input's value. */
const localIn = (hours: number) => {
	const d = new Date(Date.now() + hours * 3_600_000);
	d.setMinutes(0, 0, 0);
	return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

const WAITS: [string, string][] = [
	["60", "1 hour"],
	["120", "2 hours"],
	["240", "4 hours"],
	["480", "8 hours"],
	["1440", "1 day"],
];

function SendDialog({
	open,
	onOpenChange,
	broadcast,
	audience,
	heldOut,
	segment,
	newsletter,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	broadcast: Broadcast;
	audience: number | null;
	heldOut: number;
	segment?: string;
	newsletter: Data["newsletters"][number] | null;
}) {
	const router = useRouter();
	const [when, setWhen] = useState<"now" | "later" | "local">("now");
	const [at, setAt] = useState(() => localIn(24));
	const [testing, setTesting] = useState(false);
	const [subjects, setSubjects] = useState<string[]>([""]);
	const [size, setSize] = useState(20);
	const [metric, setMetric] = useState<"opens" | "clicks">("opens");
	const [wait, setWait] = useState("240");
	const [busy, setBusy] = useState(false);
	const n = audience ?? 0;
	const versions = 1 + subjects.length;
	const inTest = Math.round((n * size) / 100);
	const each = Math.floor(inTest / versions);
	const canTest = !broadcast.resend_of;
	const test = testing && canTest;
	const ready = !test || subjects.every((x) => x.trim());
	const waitLabel = WAITS.find(([v]) => v === wait)?.[1] ?? "";
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const r = await sendBroadcastFn({
								data: {
									id: broadcast.id,
									at: when === "later" ? new Date(at).toISOString() : null,
									local_time: when === "local" ? at : null,
									ab_test: test
										? {
												subjects: subjects.map((x) => x.trim()),
												metric,
												size,
												wait_minutes: Number(wait),
											}
										: null,
								},
							});
							toast.success(
								when === "local"
									? "Scheduled at each contact's local time"
									: r.status === "scheduled" && when === "later"
										? "Scheduled"
										: test
											? "The test is going out"
											: "Sending: it goes out at your account's rate",
							);
							onOpenChange(false);
							await router.invalidate();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>
							Send “
							{broadcast.subject ? (
								<TagText text={broadcast.subject} />
							) : (
								broadcast.name
							)}
							”
						</DialogTitle>
						<DialogDescription>
							{segment
								? `To ${n.toLocaleString()} ${n === 1 ? "contact" : "contacts"} in ${segment}${broadcast.resend_of ? " who didn't open the first one" : ""}, from ${broadcast.from || "…"}.`
								: "Pick a segment first."}
							{segment && heldOut > 0 && (
								<>
									{" "}
									{heldOut.toLocaleString()} more {heldOut === 1 ? "sits" : "sit"}{" "}
									this one out (quiet mode or the frequency cap in Settings).
								</>
							)}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-6">
						<section className="flex flex-col gap-3">
							<h3 className="text-sm font-medium">When</h3>
							<RadioGroup
								value={when}
								onValueChange={(v) => setWhen(v as typeof when)}
								className="gap-2.5"
							>
								{[
									["now", "Now", null],
									["later", "At a time", null],
									[
										"local",
										"At a time in each contact's time zone",
										test ? "Not with an A/B test" : null,
									],
								].map(([v, label, off]) => (
									<div
										key={v as string}
										className={cn(
											"flex items-center gap-2.5 text-sm",
											off && "opacity-50",
										)}
									>
										<RadioGroupItem
											id={`when-${v}`}
											value={v as string}
											disabled={!!off}
										/>
										<label htmlFor={`when-${v}`}>
											{label}
											{off && (
												<span className="ml-1.5 text-xs text-muted-foreground">
													({off})
												</span>
											)}
										</label>
									</div>
								))}
							</RadioGroup>
							{when !== "now" && (
								<Field>
									<FieldLabel htmlFor="when-at">
										{when === "local"
											? "Their local date and time"
											: "Date and time"}
									</FieldLabel>
									<DateTimePicker
										id="when-at"
										min={localIn(0)}
										value={at}
										onChange={setAt}
									/>
									<FieldDescription>
										{when === "local"
											? "Each contact gets it at this time where they are, as learned from where they open and click. Those Mailroom hasn't placed yet get it in the deployment's time zone."
											: "Your time zone. Up to 30 days ahead; you can unschedule until then."}
									</FieldDescription>
								</Field>
							)}
						</section>
						{open && (
							<Checklist
								broadcast={broadcast}
								newsletter={newsletter}
							/>
						)}
						{canTest && (
							<section className="flex flex-col gap-4 rounded-xl border border-border/80 p-4">
								<SwitchRow
									label="A/B test the subject line"
									hint="Try versions on part of the list, then send the best one to everyone else."
									checked={testing}
									onChange={(v) => {
										setTesting(v);
										if (v && when === "local") setWhen("now");
									}}
								/>
								{test && (
									<>
										<div className="flex flex-col gap-2">
											{[broadcast.subject, ...subjects].map((x, i) => (
												<div
													key={i}
													className="flex items-center gap-2"
												>
													<span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
														{"ABC"[i]}
													</span>
													{i === 0 ? (
														<span className="min-w-0 flex-1 truncate rounded-md bg-muted/50 px-3 py-2 text-sm">
															<TagText text={x} />
														</span>
													) : (
														<TagField
															aria-label={`Subject ${"ABC"[i]}`}
															placeholder="Another subject line"
															value={x}
															onChange={(v) =>
																setSubjects((l) =>
																	l.map((y, j) =>
																		j === i - 1 ? v : y,
																	),
																)
															}
														/>
													)}
													{i === 2 && (
														<Button
															type="button"
															variant="ghost"
															size="icon"
															className="size-8"
															aria-label="Remove C"
															onClick={() =>
																setSubjects((l) => l.slice(0, 1))
															}
														>
															<Trash2 />
														</Button>
													)}
												</div>
											))}
											{subjects.length < 2 && (
												<button
													type="button"
													onClick={() => setSubjects((l) => [...l, ""])}
													className="self-start text-xs font-medium text-muted-foreground hover:text-foreground"
												>
													+ Add a third version
												</button>
											)}
										</div>
										<Labeled label="Test on">
											<div className="flex items-center gap-3">
												<input
													type="range"
													aria-label="Share of contacts in the test"
													min={10}
													max={50}
													step={5}
													value={size}
													onChange={(e) =>
														setSize(Number(e.target.value))
													}
													className="h-1.5 min-w-0 flex-1 cursor-pointer accent-foreground"
												/>
												<span className="w-10 text-right text-sm tabular-nums">
													{size}%
												</span>
											</div>
										</Labeled>
										<Labeled label="Winner by">
											<Choice
												value={metric}
												onChange={setMetric}
												options={[
													["opens", "Opens"],
													["clicks", "Clicks"],
												]}
											/>
										</Labeled>
										<Labeled label="After">
											<Select
												value={wait}
												onValueChange={setWait}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{WAITS.map(([v, l]) => (
														<SelectItem
															key={v}
															value={v}
														>
															{l}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</Labeled>
										<p className="rounded-lg bg-muted/60 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
											{inTest.toLocaleString()} contacts get a version (about{" "}
											{each.toLocaleString()} each). After {waitLabel}, the
											one with the most {metric} goes to the other{" "}
											{(n - inTest).toLocaleString()}.
											{each < 100 &&
												" With fewer than 100 per version, the result is mostly chance."}
										</p>
									</>
								)}
							</section>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !segment || n === 0 || !ready}
						>
							{busy ? <Spinner /> : when !== "now" ? <CalendarClock /> : <Send />}
							{when !== "now"
								? "Schedule"
								: test
									? "Start the test"
									: `Send to ${n.toLocaleString()}`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function More({
	broadcast,
	canManage,
	canSave,
	onSave,
	onTest,
	onDelete,
	onHistory,
}: {
	broadcast: Broadcast;
	canManage: boolean;
	canSave: boolean;
	onSave: () => void;
	onTest: () => void;
	onDelete: () => void;
	onHistory: () => void;
}) {
	const { copy } = useCopy();
	const draft = broadcast.status === "draft" || broadcast.status === "scheduled";
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label="More"
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{canManage && broadcast.status === "draft" && (
					<DropdownMenuItem
						className="sm:hidden"
						disabled={!canSave}
						onSelect={onSave}
					>
						Save draft
					</DropdownMenuItem>
				)}
				{canManage && (
					<DropdownMenuItem onSelect={onTest}>
						<Send />
						Send a test
					</DropdownMenuItem>
				)}
				<DropdownMenuItem onSelect={onHistory}>
					<History />
					History
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => copy(broadcast.id)}>
					<Copy />
					Copy broadcast id
				</DropdownMenuItem>
				{canManage && draft && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={onDelete}
						>
							<Trash2 />
							Delete broadcast
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function SendTest({
	open,
	onOpenChange,
	id,
	defaultTo,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	id: string;
	defaultTo: string;
}) {
	const [to, setTo] = useState(defaultTo);
	const [busy, setBusy] = useState(false);
	const router = useRouter();
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const r = await sendBroadcastTestFn({ data: { id, to } });
							toast.success("Test sent");
							onOpenChange(false);
							if (r.id)
								await router.navigate({ to: "/emails/$id", params: { id: r.id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Send a test</DialogTitle>
						<DialogDescription>
							The saved broadcast, with “[Test]” before its subject. Contact values
							are left empty.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="btest-to">To</FieldLabel>
							<Input
								id="btest-to"
								type="email"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !to.trim()}
						>
							{busy && <Spinner />}
							Send test
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type LinkCheck = Awaited<ReturnType<typeof checkLinksFn>>;

/**
 * The pre-send checklist in the send dialog: what the content check finds, every link opened
 * from the server, and where the email will also be on the web. Nothing here stops a send.
 */
function Checklist({
	broadcast: x,
	newsletter,
}: {
	broadcast: Broadcast;
	newsletter: Data["newsletters"][number] | null;
}) {
	const [links, setLinks] = useState<LinkCheck | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let on = true;
		checkLinksFn({ data: { id: x.id } })
			.then((r) => on && setLinks(r))
			.catch(() => on && setFailed(true));
		return () => {
			on = false;
		};
	}, [x.id]);
	const findings = checkContent({
		subject: x.subject,
		html: x.html,
		text: x.text,
		marketing: true,
	});
	const has = (code: string) => findings.find((f) => f.code === code);
	const subjectIssue = has("no_subject") ?? has("caps_subject") ?? has("loud_subject");
	const content = findings.filter(
		(f) =>
			f.level === "warning" &&
			!["no_subject", "caps_subject", "loud_subject"].includes(f.code),
	);
	const broken = links?.checked.filter((l) => l.state === "broken") ?? [];
	const unsure = links?.checked.filter((l) => l.state === "unsure") ?? [];
	type Row = { state: "ok" | "warn" | "info" | "busy"; label: string; detail?: ReactNode };
	const rows: Row[] = [
		subjectIssue
			? { state: "warn", label: "Subject", detail: subjectIssue.message }
			: { state: "ok", label: "Subject reads well" },
		x.preview_text?.trim()
			? { state: "ok", label: "Preview text set" }
			: {
					state: "info",
					label: "No preview text",
					detail: "Inboxes show the first words of the email instead.",
				},
		content.length
			? {
					state: "warn",
					label: `${content.length} content ${content.length === 1 ? "warning" : "warnings"}`,
					detail: content.map((f) => f.message).join(" "),
				}
			: { state: "ok", label: "Nothing in the content filters hold against it" },
		has("img_alt")
			? { state: "info", label: "Alt text", detail: has("img_alt")?.message }
			: { state: "ok", label: "Images have alt text" },
		has("no_unsubscribe_link")
			? {
					state: "info",
					label: "Unsubscribe link",
					detail: "None in the body: Mailroom adds one at the bottom.",
				}
			: { state: "ok", label: "Unsubscribe link in the body" },
		failed
			? { state: "info", label: "Links weren't checked", detail: "Try again in a moment." }
			: !links
				? { state: "busy", label: "Opening every link…" }
				: links.checked.length === 0
					? { state: "ok", label: "No web links to check" }
					: broken.length
						? {
								state: "warn",
								label: `${broken.length} broken ${broken.length === 1 ? "link" : "links"}`,
								detail: (
									<ul className="mt-1 flex flex-col gap-0.5">
										{broken.map((l) => (
											<li
												key={l.url}
												className="truncate"
											>
												<span className="font-medium">
													{l.status ?? l.error}
												</span>{" "}
												{l.url}
											</li>
										))}
									</ul>
								),
							}
						: {
								state: "ok",
								label: `All ${links.checked.length} links open`,
								detail: unsure.length
									? `${unsure.length} turned the check away (often sites that block robots); open them yourself to be sure.`
									: undefined,
							},
	];
	if (newsletter)
		rows.push(
			newsletter.public && x.web
				? {
						state: "info",
						label: "Goes on the public page",
						detail: `Once sent, anyone can read it at /n/${newsletter.slug}.`,
					}
				: { state: "ok", label: "Kept off the public page" },
		);
	const warns = rows.filter((r) => r.state === "warn").length;
	return (
		<section className="flex flex-col gap-3 rounded-xl border border-border/80 p-4">
			<p className="flex items-center gap-2 text-sm font-medium">
				<ListChecks className="size-4" />
				Before it goes
				<span className="ml-auto text-xs font-normal text-muted-foreground">
					{warns ? `${warns} to look at` : "All good"}
				</span>
			</p>
			<ul className="flex flex-col gap-2 text-sm">
				{rows.map((r) => (
					<li
						key={r.label}
						className="flex items-start gap-2.5"
					>
						{r.state === "ok" ? (
							<CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
						) : r.state === "warn" ? (
							<CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
						) : r.state === "busy" ? (
							<Spinner className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						) : (
							<CircleHelp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0">
							{r.label}
							{r.detail && (
								<span className="block text-xs text-muted-foreground">
									{r.detail}
								</span>
							)}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** How each poll in a sent broadcast was answered, and those who answered into a segment. */
/** The replies it got, each in its conversation for support to answer. */
function Replies({ replies }: { replies: Data["replies"] }) {
	return (
		<Card className="gap-0 p-0">
			<div className="flex items-start gap-3 px-5 py-5">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
					<Reply className="size-[18px]" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold">
						{replies.count.toLocaleString()} {replies.count === 1 ? "reply" : "replies"}
					</h2>
					<p className="text-sm text-muted-foreground">
						People who answered this email. They're conversations in your inbox, tagged
						“broadcast reply”.
					</p>
				</div>
			</div>
			<ul className="border-t border-border/70">
				{replies.latest.map((r) => (
					<li
						key={r.id}
						className="relative flex items-center gap-3 border-b border-border/50 px-5 py-3 text-sm last:border-0 hover:bg-muted/40"
					>
						<div className="min-w-0 flex-1">
							<Link
								to={r.conversation_id ? "/received/$id" : "/received"}
								params={{ id: r.conversation_id ?? "" }}
								className="block truncate font-medium outline-none after:absolute after:inset-0"
							>
								<Ph>{r.from}</Ph>
							</Link>
							<span className="block truncate text-xs text-muted-foreground">
								{r.snippet || r.subject}
							</span>
						</div>
						{r.status && (
							<StatusBadge
								status={r.status === "open" ? "sending" : "delivered"}
								label={r.status === "open" ? "Open" : "Resolved"}
							/>
						)}
						<span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
							{formatAgo(r.created_at)}
						</span>
					</li>
				))}
			</ul>
		</Card>
	);
}

function PollResults({
	broadcastId,
	polls,
	segments,
	brand,
	canManage,
}: {
	broadcastId: string;
	polls: Data["polls"];
	segments: Data["segments"];
	brand: string;
	canManage: boolean;
}) {
	const router = useRouter();
	const [segment, setSegment] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);
	return (
		<Card className="gap-0 p-0">
			{polls.map((p, k) => (
				<div
					key={p.id}
					className={cn(
						"flex flex-col gap-4 px-5 py-5",
						k && "border-t border-border/70",
					)}
				>
					<div className="flex items-start gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-400">
							<Vote className="size-[18px]" />
						</span>
						<div className="min-w-0">
							<p className="text-xs text-muted-foreground">
								Poll · {p.total.toLocaleString()}{" "}
								{p.total === 1 ? "answer" : "answers"}
							</p>
							<h2 className="font-semibold">{p.question || "Poll"}</h2>
						</div>
					</div>
					<ul className="flex flex-col gap-2">
						{p.options.map((o, i) => {
							const pct = p.total ? (o.votes / p.total) * 100 : 0;
							const key = `${p.id}:${i}`;
							return (
								<li
									key={key}
									className="flex flex-wrap items-center gap-3"
								>
									<div className="relative min-w-0 flex-1 overflow-hidden rounded-lg border border-border/70 px-3 py-2 text-sm">
										<span
											className="absolute inset-y-0 left-0 bg-sky-500/12"
											style={{ width: `${pct}%` }}
										/>
										<span className="relative flex items-center justify-between gap-3">
											<span className="truncate">{o.label}</span>
											<span className="text-muted-foreground tabular-nums">
												{o.votes.toLocaleString()} · {Math.round(pct)}%
											</span>
										</span>
									</div>
									{canManage && o.votes > 0 && (
										<div className="flex items-center gap-2">
											<div className="w-44">
												<ListSelect
													kind="segment"
													brand={brand}
													ariaLabel={`Segment for “${o.label}”`}
													value={segment[key] ?? ""}
													onChange={(v) =>
														setSegment((s) => ({ ...s, [key]: v }))
													}
													items={segments}
													none="Add them to…"
													noneDisabled
												/>
											</div>
											<Button
												variant="outline"
												size="sm"
												disabled={!segment[key] || busy === key}
												onClick={async () => {
													setBusy(key);
													try {
														const r = await pollToSegmentFn({
															data: {
																id: broadcastId,
																poll: p.id,
																answer: i,
																segment_id: segment[key] as string,
															},
														});
														toast.success(
															`${r.added.toLocaleString()} added to ${segments.find((s) => s.id === segment[key])?.name ?? "the segment"}`,
														);
														await router.invalidate();
													} catch (error) {
														toast.error(await errorMessage(error));
													} finally {
														setBusy(null);
													}
												}}
											>
												{busy === key && <Spinner />}
												Add
											</Button>
										</div>
									)}
								</li>
							);
						})}
					</ul>
				</div>
			))}
		</Card>
	);
}
