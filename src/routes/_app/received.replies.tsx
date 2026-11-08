import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { MoreHorizontal, Plus, Search, Zap } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { TagChip } from "@/components/inbox-triage";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { SearchBox } from "@/components/search-box";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { deleteSavedReplyFn, listSavedRepliesFn, saveSavedReplyFn } from "@/functions/workflow";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { fillVariables } from "@/lib/reply-variables";
import { Ph, pick, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

/** Saved replies: answers written once and used from any conversation (type / in the reply
 * box), by people and agents, with what sending one also does. */
export const Route = createFileRoute("/_app/received/replies")({
	loader: () => listSavedRepliesFn(),
	head: () => ({ meta: [{ title: "Saved replies · Mailroom" }] }),
	component: SavedReplies,
	pendingComponent: SavedRepliesSketch,
});

type Data = Awaited<ReturnType<typeof listSavedRepliesFn>>;
type Saved = Data["saved"][number];

function SavedRepliesSketch() {
	return (
		<Sketch
			data={
				{
					saved: sample(rememberedRows("saved-replies", 3), (i) => ({
						object: "saved_reply",
						id: `sketch-${i}`,
						brand_id: "",
						inbox_id: null,
						name: pick(i, ["Check-in times", "Refund policy", "Thanks"]),
						shortcut: pick(i, ["checkin", "refund", "thanks"]),
						text: "Hi {{contact.first_name|there}}, check-in is from 3 pm.",
						add_tags: [],
						set_status: null,
						snooze_days: null,
						uses: 0,
						created_at: "",
						updated_at: "",
					})),
					inboxes: [],
					brands: [],
					own: "",
					variables: [],
					articles: [],
				} satisfies Data
			}
		>
			<SavedReplies />
		</Sketch>
	);
}

function SavedReplies() {
	const { data } = usePage(Route);
	const me = useMe();
	const canWrite = allows(me.active?.access, "inbox:reply");
	const [editing, setEditing] = useState<Saved | "new" | null>(null);
	const [q, setQ] = useState("");
	const [brand, setBrand] = useState<string | undefined>();
	useRememberRows("saved-replies", data.saved.length);
	const inboxes = new Map(data.inboxes.map((i) => [i.id, i]));
	const brands = new Map(data.brands.map((b) => [b.id, b.name]));
	const shown = data.saved.filter(
		(s) =>
			(!brand || s.brand_id === brand) &&
			`${s.name} ${s.shortcut ?? ""} ${s.text}`
				.toLowerCase()
				.includes(q.trim().toLowerCase()),
	);
	return (
		<Page>
			<nav
				aria-label="Breadcrumb"
				className="-mb-2 text-sm text-muted-foreground"
			>
				<Link
					to="/received"
					className="rounded-sm transition-colors hover:text-foreground"
				>
					Received
				</Link>
			</nav>
			<PageHeader
				title="Saved replies"
				description="Answers you write once. In a conversation, type / and a shortcut, or pick one from Saved replies; agents list and use them through the API and MCP. Variables fill in for each person."
				actions={
					canWrite &&
					data.saved.length > 0 && (
						<Button onClick={() => setEditing("new")}>
							<Plus />
							New saved reply
						</Button>
					)
				}
			/>
			{data.saved.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<BrandFilter
						brands={data.brands}
						value={brand}
						onChange={setBrand}
					/>
					<SearchBox
						value={q}
						onChange={setQ}
						placeholder="Search saved replies"
						className="w-full sm:ml-auto sm:w-64"
					/>
				</div>
			)}
			<ReplyDialog
				data={data}
				reply={editing}
				onClose={() => setEditing(null)}
			/>
			<TableCard>
				{data.saved.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Zap />
							</EmptyMedia>
							<EmptyTitle>No saved replies yet</EmptyTitle>
							<EmptyDescription>
								Check-in times, the refund policy, where to park: write them once
								and answer in a keystroke. Agents can use them too.
							</EmptyDescription>
						</EmptyHeader>
						{canWrite && (
							<EmptyContent>
								<Button onClick={() => setEditing("new")}>
									<Plus />
									New saved reply
								</Button>
							</EmptyContent>
						)}
					</Empty>
				) : shown.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Search />
							</EmptyMedia>
							<EmptyTitle>None match</EmptyTitle>
						</EmptyHeader>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Reply</TableHead>
								<TableHead className="hidden w-[28%] md:table-cell">For</TableHead>
								<TableHead className="w-20 text-right">Used</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{shown.map((s) => (
								<TableRow key={s.id}>
									<TableCell className="py-3">
										<span className="flex min-w-0 items-start gap-3">
											<Stamp
												icon={Zap}
												tone="brand"
												className="mt-0.5 size-7"
											/>
											<span className="min-w-0">
												<button
													type="button"
													disabled={!canWrite}
													onClick={() => setEditing(s)}
													className="flex max-w-full items-center gap-2 text-left font-medium hover:underline disabled:no-underline"
												>
													<span className="truncate">
														<Ph>{s.name}</Ph>
													</span>
													{s.shortcut && (
														<span className="shrink-0 rounded bg-muted px-1.5 font-mono text-xs text-muted-foreground">
															/{s.shortcut}
														</span>
													)}
												</button>
												<span className="line-clamp-1 text-sm text-muted-foreground">
													<Ph>{s.text}</Ph>
												</span>
												{(s.add_tags.length > 0 ||
													s.set_status ||
													s.snooze_days) && (
													<span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
														Then
														{s.add_tags.map((t) => (
															<TagChip
																key={t}
																tag={t}
																catalog={[]}
															/>
														))}
														{s.set_status === "resolved" && (
															<span>resolve</span>
														)}
														{s.snooze_days && (
															<span>
																snooze {s.snooze_days}{" "}
																{s.snooze_days === 1
																	? "day"
																	: "days"}
															</span>
														)}
													</span>
												)}
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden truncate text-muted-foreground md:table-cell">
										<Ph>
											{s.inbox_id
												? (inboxes.get(s.inbox_id)?.name ?? "One inbox")
												: "Every inbox"}
											{data.brands.length > 1 && brands.get(s.brand_id)
												? ` · ${brands.get(s.brand_id)}`
												: ""}
										</Ph>
									</TableCell>
									<TableCell className="text-right text-muted-foreground tabular-nums">
										<Ph>{s.uses}</Ph>
									</TableCell>
									<TableCell className="text-right">
										{canWrite && (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														size="icon"
														variant="ghost"
														aria-label={`More for ${s.name}`}
													>
														<MoreHorizontal />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onSelect={() => setEditing(s)}
													>
														Edit
													</DropdownMenuItem>
													<DropdownMenuItem
														onSelect={() => {
															navigator.clipboard
																.writeText(s.text)
																.then(() =>
																	toast.success("Copied"),
																);
														}}
													>
														Copy the text
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<p className="text-sm text-muted-foreground">
				A saved reply sent by a rule (Reply with a saved reply) goes only to new
				conversations, and never to automatic senders.
			</p>
		</Page>
	);
}

type Draft = {
	name: string;
	shortcut: string;
	text: string;
	inbox_id: string;
	brand: string;
	add_tags: string;
	after: "none" | "resolved" | "snooze";
	snooze_days: number;
};

const draftOf = (s: Saved | null, own: string): Draft => ({
	name: s?.name ?? "",
	shortcut: s?.shortcut ?? "",
	text: s?.text ?? "",
	inbox_id: s?.inbox_id ?? "all",
	brand: s?.brand_id ?? own,
	add_tags: (s?.add_tags ?? []).join(", "),
	after: s?.snooze_days ? "snooze" : s?.set_status === "resolved" ? "resolved" : "none",
	snooze_days: s?.snooze_days ?? 3,
});

const SAMPLE = {
	contact: "Ana López <ana@example.com>",
	agent: "Sam Rivera",
	inbox: "Support",
	subject: "Question about my booking",
};

function ReplyDialog({
	data,
	reply,
	onClose,
}: {
	data: Data;
	reply: Saved | "new" | null;
	onClose: () => void;
}) {
	const router = useRouter();
	const existing = reply && reply !== "new" ? reply : null;
	const [d, setD] = useState<Draft>(() => draftOf(existing, data.own));
	const [for_, setFor] = useState<string | null>(null);
	const key = existing?.id ?? (reply === "new" ? "new" : null);
	if (key !== for_) {
		setFor(key);
		setD(draftOf(existing, data.own));
	}
	const [busy, setBusy] = useState(false);
	const box = useRef<HTMLTextAreaElement>(null);
	const insert = (v: string) => {
		const el = box.current;
		const at = el?.selectionStart ?? d.text.length;
		const text = d.text.slice(0, at) + v + d.text.slice(el?.selectionEnd ?? at);
		setD({ ...d, text });
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(at + v.length, at + v.length);
		});
	};
	const inboxesOfBrand = data.inboxes.filter((i) => i.brand_id === d.brand);
	const save = async () => {
		setBusy(true);
		try {
			await saveSavedReplyFn({
				data: {
					id: existing?.id,
					brand: d.inbox_id === "all" ? d.brand : undefined,
					reply: {
						name: d.name,
						shortcut: d.shortcut.trim() || null,
						text: d.text,
						inbox_id: d.inbox_id === "all" ? null : d.inbox_id,
						add_tags: d.add_tags
							.split(",")
							.map((t) => t.trim())
							.filter(Boolean),
						set_status: d.after === "resolved" ? "resolved" : null,
						snooze_days: d.after === "snooze" ? d.snooze_days : null,
					},
				},
			});
			toast.success(existing ? "Saved reply saved" : "Saved reply added");
			onClose();
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Dialog
			open={!!reply}
			onOpenChange={(o) => !o && onClose()}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{existing ? "Edit the saved reply" : "New saved reply"}
					</DialogTitle>
					<DialogDescription>
						Variables fill in when it's used: {"{{contact.first_name|there}}"} says
						“there” when the name isn't known.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-4">
					<div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
						<Field>
							<FieldLabel htmlFor="s-name">Name</FieldLabel>
							<Input
								id="s-name"
								autoFocus
								placeholder="Check-in times"
								value={d.name}
								onChange={(e) => setD({ ...d, name: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="s-short">Shortcut</FieldLabel>
							<div className="flex items-center rounded-md shadow-[0_0_0_1px_var(--border-strong)] focus-within:ring-2 focus-within:ring-ring">
								<span className="pl-3 font-mono text-sm text-muted-foreground">
									/
								</span>
								<Input
									id="s-short"
									placeholder="checkin"
									className="border-0 shadow-none focus-visible:ring-0"
									value={d.shortcut}
									onChange={(e) =>
										setD({
											...d,
											shortcut: e.target.value
												.toLowerCase()
												.replace(/[^a-z0-9_-]/g, ""),
										})
									}
								/>
							</div>
						</Field>
					</div>
					<Field>
						<FieldLabel htmlFor="s-text">Reply</FieldLabel>
						<Textarea
							id="s-text"
							ref={box}
							rows={7}
							placeholder={
								"Hi {{contact.first_name|there}},\n\nCheck-in is from 3 pm and check-out until noon."
							}
							value={d.text}
							onChange={(e) => setD({ ...d, text: e.target.value })}
						/>
						<span className="flex flex-wrap gap-1.5">
							{data.variables.map((x) => (
								<button
									key={x.key}
									type="button"
									title={x.label}
									className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground hover:text-foreground"
									onClick={() =>
										insert(
											x.key === "contact.first_name"
												? `{{${x.key}|there}}`
												: `{{${x.key}}}`,
										)
									}
								>
									{x.label}
								</button>
							))}
						</span>
						{data.articles.some((a) => a.brand_id === d.brand) && (
							<Select
								value=""
								onValueChange={(id) => {
									const a = data.articles.find((x) => x.id === id);
									if (a) insert(`${a.title}: ${a.url}`);
								}}
							>
								<SelectTrigger
									aria-label="Link a help article"
									className="w-full sm:w-72"
								>
									<SelectValue placeholder="Link a help article…" />
								</SelectTrigger>
								<SelectContent>
									{data.articles
										.filter((a) => a.brand_id === d.brand)
										.map((a) => (
											<SelectItem
												key={a.id}
												value={a.id}
											>
												{a.title}
											</SelectItem>
										))}
								</SelectContent>
							</Select>
						)}
					</Field>
					{d.text.includes("{{") && (
						<div className="rounded-lg bg-muted/60 px-4 py-3 text-sm whitespace-pre-wrap">
							<p className="mb-1 text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
								For Ana López, from Sam
							</p>
							{fillVariables(d.text, SAMPLE)}
						</div>
					)}
					<div className="grid gap-3 sm:grid-cols-2">
						{data.brands.length > 1 && (
							<Field>
								<FieldLabel htmlFor="s-brand">Brand</FieldLabel>
								<Select
									value={d.brand}
									disabled={!!existing}
									onValueChange={(brand) =>
										setD({ ...d, brand, inbox_id: "all" })
									}
								>
									<SelectTrigger id="s-brand">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{data.brands.map((b) => (
											<SelectItem
												key={b.id}
												value={b.id}
											>
												{b.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						)}
						<Field>
							<FieldLabel htmlFor="s-inbox">Used in</FieldLabel>
							<Select
								value={d.inbox_id}
								onValueChange={(inbox_id) => setD({ ...d, inbox_id })}
							>
								<SelectTrigger id="s-inbox">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">Every inbox</SelectItem>
									{inboxesOfBrand.length > 0 && <SelectSeparator />}
									{inboxesOfBrand.map((i) => (
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
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="s-tags">After sending, add tags</FieldLabel>
							<Input
								id="s-tags"
								placeholder="billing, refund"
								value={d.add_tags}
								onChange={(e) => setD({ ...d, add_tags: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="s-after">And then</FieldLabel>
							<div className="flex gap-2">
								<Select
									value={d.after}
									onValueChange={(after) =>
										setD({ ...d, after: after as Draft["after"] })
									}
								>
									<SelectTrigger
										id="s-after"
										className="flex-1"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">Leave it open</SelectItem>
										<SelectItem value="resolved">Resolve it</SelectItem>
										<SelectItem value="snooze">
											Snooze it (a follow-up)
										</SelectItem>
									</SelectContent>
								</Select>
								{d.after === "snooze" && (
									<Input
										aria-label="Days"
										type="number"
										min={1}
										max={90}
										className="w-20"
										value={d.snooze_days}
										onChange={(e) =>
											setD({
												...d,
												snooze_days: Math.min(
													90,
													Math.max(1, Number(e.target.value) || 1),
												),
											})
										}
									/>
								)}
							</div>
							{d.after === "snooze" && (
								<FieldDescription>
									It comes back in {d.snooze_days}{" "}
									{d.snooze_days === 1 ? "day" : "days"} if they don't answer.
								</FieldDescription>
							)}
						</Field>
					</div>
				</DialogBody>
				<DialogFooter className="sm:justify-between">
					{existing ? (
						<Confirm
							trigger={<Button variant="ghost">Delete</Button>}
							title="Delete this saved reply?"
							description="Replies already sent with it stay as they are. Rules that use it stop replying."
							action="Delete"
							onConfirm={async () => {
								try {
									await deleteSavedReplyFn({ data: { id: existing.id } });
									toast.success("Saved reply deleted");
									onClose();
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
					) : (
						<span />
					)}
					<span className="flex gap-2">
						<Button
							variant="ghost"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							disabled={busy || !d.name.trim() || !d.text.trim()}
							onClick={save}
						>
							{busy && <Spinner />}
							{existing ? "Save" : "Add saved reply"}
						</Button>
					</span>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
