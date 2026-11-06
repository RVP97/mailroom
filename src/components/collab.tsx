import {
	BadgeCheck,
	Check,
	Eye,
	History,
	MessageSquare,
	MessageSquareWarning,
	RotateCcw,
	Send,
	Trash2,
	Undo2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ActivityFeed, type ActivityRow } from "@/components/activity-feed";
import { UserAvatar } from "@/components/org-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
	addCommentFn,
	commentsFn,
	decideReviewFn,
	deleteCommentFn,
	requestReviewFn,
	resolveCommentFn,
	restoreVersionFn,
	versionsFn,
	withdrawReviewFn,
} from "@/functions/collab";
import { activityFn } from "@/functions/team";
import { renderEmail } from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { sampleFill } from "@/lib/merge-tags";
import { cn } from "@/lib/utils";

/*
 * Working together on an email: its comment thread (review steps show in it), asking for and
 * giving a review, and its history (earlier versions to restore, and who did what).
 */

type Subject = { type: "broadcast" | "template"; id: string };
type Comment = Awaited<ReturnType<typeof commentsFn>>[number];
type Version = Awaited<ReturnType<typeof versionsFn>>[number];

/** A subject's comments, loaded once and on demand. */
export function useComments(s: Subject) {
	const [rows, setRows] = useState<Comment[] | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the subject is its type and id
	const load = useCallback(
		() =>
			commentsFn({ data: s })
				.then(setRows)
				.catch(() => setRows([])),
		[s.type, s.id],
	);
	useEffect(() => {
		void load();
	}, [load]);
	return { rows, load, open: rows?.filter((c) => c.kind === "comment" && !c.resolved_at).length ?? 0 };
}

const KIND = {
	requested: { icon: Send, label: "asked for a review", tone: "text-sky-600 dark:text-sky-400" },
	approved: { icon: BadgeCheck, label: "approved it", tone: "text-emerald-600 dark:text-emerald-400" },
	changes: {
		icon: MessageSquareWarning,
		label: "asked for changes",
		tone: "text-amber-600 dark:text-amber-400",
	},
} as const;

export function CommentsSheet({
	subject,
	comments,
	open,
	onOpenChange,
	canComment,
	block,
	onBlock,
}: {
	subject: Subject;
	comments: ReturnType<typeof useComments>;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	canComment: boolean;
	/** A block picked in the design, to comment on. */
	block?: { id: string; label: string } | null;
	onBlock?: (id: string | null) => void;
}) {
	const me = useMe();
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [showResolved, setShowResolved] = useState(false);
	const rows = comments.rows ?? [];
	const resolved = rows.filter((c) => c.resolved_at).length;
	const shown = rows.filter((c) => showResolved || !c.resolved_at);
	const post = async () => {
		if (!body.trim()) return;
		setBusy(true);
		try {
			await addCommentFn({ data: { ...subject, body, block: block?.id ?? null } });
			setBody("");
			onBlock?.(null);
			await comments.load();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
		>
			<SheetContent className="sm:max-w-md">
				<SheetHeader>
					<SheetTitle>Comments</SheetTitle>
					<SheetDescription>
						{comments.open
							? `${comments.open} open${resolved ? `, ${resolved} resolved` : ""}`
							: "Notes for whoever works on it next. Reviews show here too."}
					</SheetDescription>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
					{comments.rows === null ? (
						<Spinner className="mx-auto my-8" />
					) : shown.length === 0 ? (
						<p className="my-8 text-center text-sm text-muted-foreground">
							No comments yet.
						</p>
					) : (
						<ol className="flex flex-col gap-4">
							{shown.map((c) => {
								const k = c.kind !== "comment" ? KIND[c.kind] : null;
								return (
									<li
										key={c.id}
										className={cn("flex gap-3", c.resolved_at && "opacity-60")}
									>
										<UserAvatar
											name={c.who}
											className="mt-0.5 size-7 text-[11px]"
										/>
										<div className="min-w-0 flex-1">
											<p className="flex flex-wrap items-baseline gap-x-2 text-sm">
												<span className="font-medium">{c.who}</span>
												{k && (
													<span className={cn("inline-flex items-center gap-1 text-xs", k.tone)}>
														<k.icon className="size-3.5" />
														{k.label}
													</span>
												)}
												<time
													className="text-xs text-muted-foreground"
													title={formatDateTime(c.created_at)}
												>
													{formatAgo(c.created_at)}
												</time>
											</p>
											{c.block_id && (
												<button
													type="button"
													className="mt-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
													onClick={() => onBlock?.(c.block_id)}
												>
													On a block of the design
												</button>
											)}
											{c.body && (
												<p className="mt-1 text-sm whitespace-pre-wrap text-foreground/90">
													{c.body}
												</p>
											)}
											{c.kind === "comment" && (
												<div className="mt-1 flex gap-1">
													<Button
														variant="ghost"
														size="xs"
														onClick={async () => {
															await resolveCommentFn({
																data: { id: c.id, resolved: !c.resolved_at },
															}).catch(async (e) => toast.error(await errorMessage(e)));
															await comments.load();
														}}
													>
														{c.resolved_at ? <Undo2 /> : <Check />}
														{c.resolved_at ? "Reopen" : "Resolve"}
													</Button>
													{c.user_id === me.user.id && (
														<Button
															variant="ghost"
															size="xs"
															aria-label="Delete comment"
															onClick={async () => {
																await deleteCommentFn({ data: { id: c.id } }).catch(async (e) =>
																	toast.error(await errorMessage(e)),
																);
																await comments.load();
															}}
														>
															<Trash2 />
														</Button>
													)}
												</div>
											)}
										</div>
									</li>
								);
							})}
						</ol>
					)}
					{resolved > 0 && (
						<button
							type="button"
							className="mt-4 self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
							onClick={() => setShowResolved((v) => !v)}
						>
							{showResolved ? "Hide resolved" : `Show ${resolved} resolved`}
						</button>
					)}
				</div>
				{canComment && (
					<form
						className="flex flex-col gap-2 border-t px-5 py-4"
						onSubmit={(e) => {
							e.preventDefault();
							void post();
						}}
					>
						{block && (
							<p className="flex items-center justify-between rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
								<span className="truncate">On: {block.label}</span>
								<button
									type="button"
									className="hover:text-foreground"
									onClick={() => onBlock?.(null)}
								>
									Whole email
								</button>
							</p>
						)}
						<Textarea
							aria-label="Comment"
							rows={3}
							value={body}
							placeholder="Write a comment…"
							onChange={(e) => setBody(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void post();
							}}
						/>
						<Button
							type="submit"
							size="sm"
							className="self-end"
							disabled={busy || !body.trim()}
						>
							{busy ? <Spinner /> : <MessageSquare />}
							Comment
						</Button>
					</form>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** Where a draft's review stands, with what the person can do about it. */
export function ReviewBanner({
	broadcast,
	people,
	needsApproval,
	approved,
	canApprove,
	onReview,
	onChanged,
}: {
	broadcast: {
		id: string;
		status: string;
		review: string | null;
		review_requested_by: string | null;
		reviewed_by: string | null;
		reviewed_at: string | null;
	};
	people: Record<string, string>;
	needsApproval: boolean;
	approved: boolean;
	canApprove: boolean;
	onReview: () => void;
	onChanged: () => void;
}) {
	const me = useMe();
	if (broadcast.status !== "draft") return null;
	const who = (id: string | null) => (id ? (people[id] ?? "Someone") : "Someone");
	const mineToApprove =
		canApprove &&
		broadcast.review === "requested" &&
		(broadcast.review_requested_by !== me.user.id || !!me.active?.access?.owner);
	let tone = "bg-muted/60 text-foreground";
	let text: string | null = null;
	if (broadcast.review === "requested") {
		tone = "bg-sky-500/10 text-sky-900 dark:text-sky-200";
		text = `${who(broadcast.review_requested_by)} asked for a review.`;
	} else if (broadcast.review === "approved" && approved) {
		tone = "bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
		text = `Approved by ${who(broadcast.reviewed_by)}${broadcast.reviewed_at ? `, ${formatAgo(broadcast.reviewed_at)}` : ""}.`;
	} else if (broadcast.review === "changes") {
		tone = "bg-amber-500/10 text-amber-900 dark:text-amber-200";
		text = `${who(broadcast.reviewed_by)} asked for changes. See the comments.`;
	} else if (needsApproval) {
		text = "This organization sends only approved broadcasts. Ask for a review when it's ready.";
	}
	if (!text) return null;
	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-3 rounded-xl px-4 py-3 text-sm",
				tone,
			)}
		>
			<span className="min-w-0 flex-1">{text}</span>
			{mineToApprove && (
				<Button
					size="sm"
					onClick={onReview}
				>
					<Eye />
					Review
				</Button>
			)}
			{broadcast.review === "requested" && broadcast.review_requested_by === me.user.id && (
				<Button
					size="sm"
					variant="ghost"
					onClick={async () => {
						try {
							await withdrawReviewFn({ data: { id: broadcast.id } });
							toast.success("Review request withdrawn");
							onChanged();
						} catch (error) {
							toast.error(await errorMessage(error));
						}
					}}
				>
					Withdraw
				</Button>
			)}
		</div>
	);
}

/** Asking for a review: an optional note for the approvers. */
export function RequestReviewDialog({
	id,
	open,
	onOpenChange,
	onDone,
}: {
	id: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onDone: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Ask for a review</DialogTitle>
					<DialogDescription>
						Everyone who can approve broadcasts gets an email with a link here.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						aria-label="Note for the reviewers"
						rows={3}
						value={note}
						placeholder="Anything they should look at? (optional)"
						onChange={(e) => setNote(e.target.value)}
					/>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await requestReviewFn({ data: { id, note: note.trim() || undefined } });
								toast.success("Review requested");
								setNote("");
								onOpenChange(false);
								onDone();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? <Spinner /> : <Send />}
						Ask for review
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Approving, or asking for changes (with what should change). */
export function ReviewDialog({
	id,
	seen,
	open,
	onOpenChange,
	onDone,
}: {
	id: string;
	/** The version on screen (its updated_at): approving holds only for it. */
	seen?: string;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	onDone: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState<"approve" | "changes" | null>(null);
	const decide = async (approve: boolean) => {
		setBusy(approve ? "approve" : "changes");
		try {
			await decideReviewFn({ data: { id, approve, note: note.trim() || undefined, seen } });
			toast.success(approve ? "Approved" : "Changes asked");
			setNote("");
			onOpenChange(false);
			onDone();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Review this broadcast</DialogTitle>
					<DialogDescription>
						Approving lets whoever can send send or schedule it as it is now. Editing it
						afterwards asks for approval again.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						aria-label="Note"
						rows={3}
						value={note}
						placeholder="A note (needed when asking for changes)"
						onChange={(e) => setNote(e.target.value)}
					/>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						disabled={!!busy || !note.trim()}
						onClick={() => decide(false)}
					>
						{busy === "changes" ? <Spinner /> : <MessageSquareWarning />}
						Ask for changes
					</Button>
					<Button
						disabled={!!busy}
						onClick={() => decide(true)}
					>
						{busy === "approve" ? <Spinner /> : <BadgeCheck />}
						Approve
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** Earlier versions (preview, restore) and who did what. */
export function HistorySheet({
	subject,
	open,
	onOpenChange,
	canRestore,
	onRestored,
}: {
	subject: Subject;
	open: boolean;
	onOpenChange: (o: boolean) => void;
	canRestore: boolean;
	onRestored: () => void;
}) {
	const [versions, setVersions] = useState<Version[] | null>(null);
	const [activity, setActivity] = useState<ActivityRow[] | null>(null);
	const [viewing, setViewing] = useState<Version | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the subject is its type and id
	useEffect(() => {
		if (!open) return;
		versionsFn({ data: subject })
			.then(setVersions)
			.catch(() => setVersions([]));
		activityFn({ data: subject })
			.then(setActivity)
			.catch(() => setActivity([]));
	}, [open, subject.type, subject.id]);
	const restore = async (v: Version) => {
		setBusy(v.id);
		try {
			await restoreVersionFn({ data: { version: v.id } });
			toast.success("Earlier version restored");
			setViewing(null);
			onOpenChange(false);
			onRestored();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<>
			<Sheet
				open={open}
				onOpenChange={onOpenChange}
			>
				<SheetContent className="sm:max-w-md">
					<SheetHeader>
						<SheetTitle>History</SheetTitle>
						<SheetDescription>
							A version is kept each time it's saved (one per person every 10 minutes),
							the last 50.
						</SheetDescription>
					</SheetHeader>
					<Tabs
						defaultValue="versions"
						className="flex min-h-0 flex-1 flex-col gap-0"
					>
						<TabsList
							variant="line"
							className="justify-start border-b px-5 *:after:bottom-0"
						>
							<TabsTrigger value="versions">Versions</TabsTrigger>
							<TabsTrigger value="activity">Activity</TabsTrigger>
						</TabsList>
						<TabsContent
							value="versions"
							className="min-h-0 flex-1 overflow-y-auto"
						>
							{versions === null ? (
								<Spinner className="mx-auto my-8" />
							) : versions.length === 0 ? (
								<p className="px-5 py-8 text-center text-sm text-muted-foreground">
									No versions yet. One is kept the first time it's saved.
								</p>
							) : (
								<ol>
									{versions.map((v, i) => (
										<li
											key={v.id}
											className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0"
										>
											<History className="size-4 shrink-0 text-muted-foreground" />
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium">
													{v.snapshot.subject || "No subject"}
												</p>
												<p className="text-xs text-muted-foreground">
													{v.who} · {formatDateTime(v.updated_at)}
													{i === 0 && (
														<Badge
															variant="secondary"
															className="ml-1.5"
														>
															Latest
														</Badge>
													)}
												</p>
											</div>
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setViewing(v)}
											>
												<Eye />
												View
											</Button>
										</li>
									))}
								</ol>
							)}
						</TabsContent>
						<TabsContent
							value="activity"
							className="min-h-0 flex-1 overflow-y-auto"
						>
							{activity === null ? (
								<Spinner className="mx-auto my-8" />
							) : (
								<ActivityFeed
									rows={activity}
									compact
								/>
							)}
						</TabsContent>
					</Tabs>
				</SheetContent>
			</Sheet>
			<Dialog
				open={!!viewing}
				onOpenChange={(o) => !o && setViewing(null)}
			>
				<DialogContent className="sm:max-w-3xl">
					<DialogHeader>
						<DialogTitle>{viewing?.snapshot.subject || "No subject"}</DialogTitle>
						<DialogDescription>
							{viewing ? `Saved by ${viewing.who}, ${formatDateTime(viewing.updated_at)}` : ""}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="p-0">
						{viewing && (
							<iframe
								title="This version"
								sandbox=""
								className="h-[60vh] w-full bg-white"
								srcDoc={sampleFill(
									viewing.snapshot.design ? renderEmail(viewing.snapshot.design) : viewing.snapshot.html,
								)}
							/>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setViewing(null)}
						>
							Close
						</Button>
						{canRestore && viewing && (
							<Button
								disabled={!!busy}
								onClick={() => restore(viewing)}
							>
								{busy ? <Spinner /> : <RotateCcw />}
								Restore this version
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
