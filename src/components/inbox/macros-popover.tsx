import { Layers, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { applyMacroFn, deleteMacroFn, listMacrosFn, saveMacroFn } from "@/functions/inbox-power";
import { errorMessage } from "@/lib/errors";

type Macro = Awaited<ReturnType<typeof listMacrosFn>>[number];

export function MacrosPopover({
	brandId,
	inboxId,
	conversationId,
	canManage,
	onInsertReply,
	onApplied,
}: {
	brandId: string;
	inboxId: string | null;
	conversationId: string;
	canManage: boolean;
	onInsertReply: (text: string) => void;
	onApplied: () => Promise<void> | void;
}) {
	const [open, setOpen] = useState(false);
	const [macros, setMacros] = useState<Macro[] | null>(null);
	const [running, setRunning] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	const load = useCallback(async () => {
		try {
			setMacros(
				await listMacrosFn({ data: { brand: brandId, inbox: inboxId ?? undefined } }),
			);
		} catch {
			setMacros([]);
		}
	}, [brandId, inboxId]);

	useEffect(() => {
		if (open && macros === null) void load();
	}, [open, macros, load]);

	const run = async (m: Macro) => {
		setRunning(m.id);
		try {
			const res = await applyMacroFn({
				data: { conversationId, macroId: m.id },
			});
			if (res.reply_text) onInsertReply(res.reply_text);
			toast.success(
				res.applied.length
					? `Macro "${m.name}": ${res.applied.join(", ")}`
					: `Inserted macro "${m.name}"`,
			);
			setOpen(false);
			await onApplied();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setRunning(null);
		}
	};

	return (
		<>
			<Popover
				open={open}
				onOpenChange={setOpen}
			>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-label="Macros"
						className="h-7 px-2 text-xs text-muted-foreground"
					>
						<Layers className="size-3.5" />
						<span className="hidden sm:inline">Macros</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-72 max-w-[calc(100vw-2rem)] p-1.5"
				>
					<div className="flex items-center justify-between px-2 py-1">
						<span className="text-xs font-medium text-muted-foreground">
							Multi-action macros
						</span>
						{canManage && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-1.5 text-xs"
								onClick={() => {
									setOpen(false);
									setCreating(true);
								}}
							>
								<Plus className="size-3" />
								New
							</Button>
						)}
					</div>
					{macros === null ? (
						<div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
							<Spinner className="size-3.5" /> Loading…
						</div>
					) : macros.length === 0 ? (
						<p className="px-2 py-3 text-xs text-muted-foreground">
							No macros yet. Bundle a reply, tags, priority, assignment, and
							resolve/snooze into one click.
						</p>
					) : (
						<div className="max-h-60 space-y-0.5 overflow-y-auto">
							{macros.map((m) => {
								const chips = [
									...(m.actions.add_tags ?? []).map((t) => `+${t}`),
									m.actions.priority ? m.actions.priority : null,
									m.actions.status ? m.actions.status : null,
									m.actions.snooze_hours
										? `snooze ${m.actions.snooze_hours}h`
										: null,
								].filter(Boolean);
								return (
									<div
										key={m.id}
										className="group flex items-center gap-1 rounded-md hover:bg-muted"
									>
										<button
											type="button"
											disabled={running !== null}
											onClick={() => void run(m)}
											className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
										>
											<span className="flex items-center gap-1.5 text-xs font-medium">
												{running === m.id && <Spinner className="size-3" />}
												<span className="truncate">{m.name}</span>
												{m.shortcut && (
													<span className="font-mono text-[10px] text-muted-foreground">
														/{m.shortcut}
													</span>
												)}
											</span>
											{chips.length > 0 && (
												<span className="truncate text-[11px] text-muted-foreground">
													{chips.join(" · ")}
												</span>
											)}
										</button>
										{canManage && (
											<button
												type="button"
												aria-label={`Delete ${m.name}`}
												className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-70 hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 pointer-coarse:opacity-70"
												onClick={async () => {
													try {
														await deleteMacroFn({
															data: { id: m.id },
														});
														toast.success("Macro deleted");
														await load();
													} catch (error) {
														toast.error(await errorMessage(error));
													}
												}}
											>
												<Trash2 className="size-3" />
											</button>
										)}
									</div>
								);
							})}
						</div>
					)}
				</PopoverContent>
			</Popover>
			{creating && (
				<NewMacroDialog
					brandId={brandId}
					inboxId={inboxId}
					onClose={() => setCreating(false)}
					onSaved={async () => {
						setCreating(false);
						await load();
					}}
				/>
			)}
		</>
	);
}

function NewMacroDialog({
	brandId,
	inboxId,
	onClose,
	onSaved,
}: {
	brandId: string;
	inboxId: string | null;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [shortcut, setShortcut] = useState("");
	const [replyText, setReplyText] = useState("");
	const [tags, setTags] = useState("");
	const [priority, setPriority] = useState<string>("none");
	const [outcome, setOutcome] = useState<string>("none");
	const [busy, setBusy] = useState(false);

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const addTags = tags
								.split(",")
								.map((s) => s.trim())
								.filter(Boolean);
							await saveMacroFn({
								data: {
									brand: brandId,
									inbox_id: inboxId,
									name: name.trim(),
									shortcut: shortcut.trim() || null,
									reply_text: replyText.trim() || null,
									actions: {
										...(addTags.length ? { add_tags: addTags } : {}),
										...(priority !== "none"
											? {
													priority: priority as
														| "urgent"
														| "high"
														| "normal"
														| "low",
												}
											: {}),
										...(outcome === "resolve" ? { status: "resolved" } : {}),
										...(outcome === "snooze_24" ? { snooze_hours: 24 } : {}),
										...(outcome === "snooze_48" ? { snooze_hours: 48 } : {}),
									},
								},
							});
							toast.success("Macro saved");
							await onSaved();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>New inbox macro</DialogTitle>
						<DialogDescription>
							Apply tags, priority, status or snooze and prefill a reply in one click.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="mac-name">Name</FieldLabel>
								<Input
									id="mac-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Billing refund approved"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="mac-short">Shortcut (optional)</FieldLabel>
								<Input
									id="mac-short"
									value={shortcut}
									onChange={(e) => setShortcut(e.target.value)}
									placeholder="refund"
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="mac-reply">Reply text (optional)</FieldLabel>
							<Textarea
								id="mac-reply"
								rows={3}
								value={replyText}
								onChange={(e) => setReplyText(e.target.value)}
								placeholder="Hi {{contact.first_name}}, we've issued your refund…"
							/>
						</Field>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<Field>
								<FieldLabel htmlFor="mac-tags">Add tags</FieldLabel>
								<Input
									id="mac-tags"
									value={tags}
									onChange={(e) => setTags(e.target.value)}
									placeholder="billing, refund"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="mac-pri">Priority</FieldLabel>
								<Select
									value={priority}
									onValueChange={setPriority}
								>
									<SelectTrigger id="mac-pri">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">Unchanged</SelectItem>
										<SelectItem value="urgent">Urgent</SelectItem>
										<SelectItem value="high">High</SelectItem>
										<SelectItem value="normal">Normal</SelectItem>
										<SelectItem value="low">Low</SelectItem>
									</SelectContent>
								</Select>
							</Field>
							<Field>
								<FieldLabel htmlFor="mac-out">After applying</FieldLabel>
								<Select
									value={outcome}
									onValueChange={setOutcome}
								>
									<SelectTrigger id="mac-out">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">Keep open</SelectItem>
										<SelectItem value="resolve">Resolve</SelectItem>
										<SelectItem value="snooze_24">Snooze 24h</SelectItem>
										<SelectItem value="snooze_48">Snooze 48h</SelectItem>
									</SelectContent>
								</Select>
							</Field>
						</div>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Save macro
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
