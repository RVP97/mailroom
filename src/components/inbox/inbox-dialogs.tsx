import { GitMerge, Send } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { inboxSendersFn, mergeConversationsFn, startConversationFn } from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo } from "@/lib/format";

type SendersData = Awaited<ReturnType<typeof inboxSendersFn>>;

/** Compose a brand-new 1-to-1 outbound email conversation directly from the Inbox. */
export function NewConversationDialog({
	open,
	onOpenChange,
	defaultInbox,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	defaultInbox?: string;
	onCreated: (conversationId: string) => void;
}) {
	const [senders, setSenders] = useState<SendersData | null>(null);
	const [inbox, setInbox] = useState<string>(defaultInbox ?? "none");
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [subject, setSubject] = useState("");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!open) return;
		inboxSendersFn()
			.then((data) => {
				setSenders(data);
				const picked = data.inboxes.find((i) => i.id === defaultInbox) ?? data.inboxes[0];
				if (picked) {
					setInbox(picked.id);
					setFrom((f) => f || picked.reply_from || picked.address);
				} else if (data.domains[0]) {
					const domain = data.domains[0].name;
					setFrom((f) => f || `hello@${domain}`);
				}
			})
			.catch(() => {});
	}, [open, defaultInbox]);

	const pickInbox = (val: string) => {
		setInbox(val);
		const found = senders?.inboxes.find((i) => i.id === val);
		if (found) setFrom(found.reply_from || found.address);
	};

	const submit = async () => {
		setBusy(true);
		try {
			const picked = senders?.inboxes.find((i) => i.id === inbox);
			const created = await startConversationFn({
				data: {
					inbox: inbox === "none" ? undefined : inbox,
					brand: picked?.brand_id,
					from: from.trim(),
					to: to.trim(),
					cc: cc.trim() || undefined,
					subject: subject.trim(),
					text: text.trim(),
				},
			});
			toast.success("Conversation started");
			setTo("");
			setCc("");
			setSubject("");
			setText("");
			onOpenChange(false);
			onCreated(created.id);
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>New conversation</DialogTitle>
					<DialogDescription>
						Send a 1-to-1 email from your Inbox. Replies thread back here automatically.
					</DialogDescription>
				</DialogHeader>
				<form
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<DialogBody className="flex flex-col gap-3">
						<div className="grid gap-3 sm:grid-cols-2">
							{senders && senders.inboxes.length > 0 && (
								<Field>
									<FieldLabel htmlFor="nc-inbox">Inbox</FieldLabel>
									<Select
										value={inbox}
										onValueChange={pickInbox}
									>
										<SelectTrigger id="nc-inbox">
											<SelectValue placeholder="Choose inbox" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">No specific inbox</SelectItem>
											{senders.inboxes.map((i) => (
												<SelectItem
													key={i.id}
													value={i.id}
												>
													{i.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
							<Field
								className={!senders?.inboxes.length ? "sm:col-span-2" : undefined}
							>
								<FieldLabel htmlFor="nc-from">From</FieldLabel>
								<Input
									id="nc-from"
									required
									value={from}
									placeholder={
										senders?.domains[0]
											? `support@${senders.domains[0].name}`
											: "you@yourdomain.com"
									}
									onChange={(e) => setFrom(e.target.value)}
								/>
							</Field>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="nc-to">To</FieldLabel>
								<Input
									id="nc-to"
									required
									value={to}
									placeholder="customer@example.com"
									onChange={(e) => setTo(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="nc-cc">Cc (optional)</FieldLabel>
								<Input
									id="nc-cc"
									value={cc}
									placeholder="colleague@example.com"
									onChange={(e) => setCc(e.target.value)}
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="nc-subject">Subject</FieldLabel>
							<Input
								id="nc-subject"
								required
								value={subject}
								placeholder="Quick follow-up on your account"
								onChange={(e) => setSubject(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="nc-text">Message</FieldLabel>
							<Textarea
								id="nc-text"
								required
								rows={6}
								value={text}
								placeholder="Write your message…"
								onChange={(e) => setText(e.target.value)}
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
							disabled={
								busy ||
								!from.trim() ||
								!to.trim() ||
								!subject.trim() ||
								!text.trim()
							}
						>
							{busy ? <Spinner /> : <Send />}
							Send email
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Merge another duplicate conversation into the current conversation. */
export function MergeConversationDialog({
	open,
	onOpenChange,
	keepId,
	keepSubject,
	candidates,
	onMerged,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	keepId: string;
	keepSubject: string;
	candidates: { id: string; subject: string; status: string; last_message_at: string }[];
	onMerged: () => Promise<void> | void;
}) {
	const [selected, setSelected] = useState<string>("");
	const [manualId, setManualId] = useState("");
	const [busy, setBusy] = useState(false);
	const target = selected || manualId.trim();

	const merge = async () => {
		if (!target || target === keepId) return;
		setBusy(true);
		try {
			await mergeConversationsFn({ data: { keep_id: keepId, drop_ids: [target] } });
			toast.success("Conversations merged");
			setSelected("");
			setManualId("");
			onOpenChange(false);
			await onMerged();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Merge conversation</DialogTitle>
					<DialogDescription>
						Fold another conversation into “{keepSubject || "(no subject)"}”. All
						messages, replies, notes, and tags move here.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-3">
					{candidates.length > 0 && (
						<div className="flex flex-col gap-1.5">
							<span className="text-xs font-medium text-muted-foreground">
								Other conversations from this person
							</span>
							<ul className="flex max-h-52 flex-col gap-1 overflow-y-auto">
								{candidates.map((c) => (
									<li key={c.id}>
										<button
											type="button"
											onClick={() => {
												setSelected(c.id);
												setManualId("");
											}}
											className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
												selected === c.id
													? "border-brand bg-brand/8"
													: "border-border hover:bg-muted/50"
											}`}
										>
											<span className="min-w-0 flex-1 truncate font-medium">
												{c.subject || "(no subject)"}
											</span>
											<span className="shrink-0 text-xs text-muted-foreground">
												{formatAgo(c.last_message_at)}
											</span>
										</button>
									</li>
								))}
							</ul>
						</div>
					)}
					<Field>
						<FieldLabel htmlFor="merge-id">Or paste a conversation ID</FieldLabel>
						<Input
							id="merge-id"
							value={manualId}
							placeholder="UUID of conversation to fold into this one"
							onChange={(e) => {
								setManualId(e.target.value);
								if (e.target.value) setSelected("");
							}}
						/>
						<FieldDescription>
							Both conversations must belong to the same brand.
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
						type="button"
						disabled={busy || !target || target === keepId}
						onClick={() => void merge()}
					>
						{busy ? <Spinner /> : <GitMerge />}
						Merge into this thread
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
