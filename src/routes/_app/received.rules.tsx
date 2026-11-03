import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Ban, Forward, MoreHorizontal, Plus, Route as RouteIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
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
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { deleteRuleFn, listRulesFn, saveRuleFn } from "@/functions/received";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, pick, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

export const Route = createFileRoute("/_app/received/rules")({
	loader: () => listRulesFn(),
	head: () => ({ meta: [{ title: "Inbound rules · Mailroom" }] }),
	component: Rules,
	pendingComponent: RulesSketch,
});

type Data = Awaited<ReturnType<typeof listRulesFn>>;
type Rule = Data["rules"][number];

function RulesSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					rules: sample(rememberedRows("inbound-rules", 2), (i) => ({
						object: "inbound_rule",
						id: `sketch-${i}`,
						brand_id: "",
						name: pick(i, ["Bookings to the front desk", "Auto-replies"]),
						match_to: "reservas@example.com",
						match_from: null,
						match_subject: null,
						action: "forward",
						forward_to: ["desk@example.com"],
						continue: false,
						enabled: true,
						position: i,
						created_at: "",
						updated_at: "",
					})),
				} satisfies Data
			}
		>
			<Rules />
		</Sketch>
	);
}

const describe = (r: Rule) =>
	[
		r.match_to === "*" ? "Any address" : r.match_to,
		r.match_from && `from “${r.match_from}”`,
		r.match_subject && `subject has “${r.match_subject}”`,
	]
		.filter(Boolean)
		.join(", ");

function Rules() {
	const { data } = usePage(Route);
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:rules");
	const router = useRouter();
	const [editing, setEditing] = useState<Rule | "new" | null>(null);
	const [deleting, setDeleting] = useState<Rule | null>(null);
	useRememberRows("inbound-rules", data.rules.length);
	const names = new Map(data.brands.map((b) => [b.id, b.name]));
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
				title="Inbound rules"
				description="What happens to email your brands receive, before it's kept: forward a copy to your team's inboxes, or drop what you never want (auto-replies, a sender). The first rule that matches decides."
				actions={
					canManage &&
					data.rules.length > 0 && (
						<Button onClick={() => setEditing("new")}>
							<Plus />
							New rule
						</Button>
					)
				}
			/>
			<RuleDialog
				rule={editing}
				brands={data.brands}
				onClose={() => setEditing(null)}
			/>
			<Confirm
				open={!!deleting}
				onOpenChange={(v) => !v && setDeleting(null)}
				title="Delete this rule?"
				description="Email it matched is kept as usual from now on."
				action="Delete rule"
				onConfirm={async () => {
					try {
						await deleteRuleFn({ data: { id: deleting?.id ?? "" } });
						toast.success("Rule deleted");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			<TableCard>
				{data.rules.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<RouteIcon />
							</EmptyMedia>
							<EmptyTitle>No rules yet</EmptyTitle>
							<EmptyDescription>
								Everything received is kept and sent to your webhooks. Add a rule to
								forward bookings to the front desk, or drop out-of-office replies.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<Button onClick={() => setEditing("new")}>
									<Plus />
									New rule
								</Button>
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Rule</TableHead>
								<TableHead className="hidden w-[38%] md:table-cell">Does</TableHead>
								<TableHead className="w-24">Status</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.rules.map((r) => (
								<TableRow key={r.id}>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={r.action === "drop" ? Ban : Forward}
												tone={r.action === "drop" ? "gray" : "blue"}
												className="size-7"
											/>
											<span className="min-w-0">
												<button
													type="button"
													disabled={!canManage}
													onClick={() => setEditing(r)}
													className="block max-w-full truncate text-left font-medium hover:underline disabled:no-underline"
												>
													<Ph>{r.name}</Ph>
												</button>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															data.brands.length > 1
																? names.get(r.brand_id)
																: null,
															describe(r),
														]
															.filter(Boolean)
															.join(" · ")}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden truncate text-muted-foreground md:table-cell">
										<Ph>
											{r.action === "drop"
												? "Drop it"
												: `Forward to ${r.forward_to.join(", ")}`}
											{r.continue && ", then the next rules"}
										</Ph>
									</TableCell>
									<TableCell>
										<StatusBadge
											status={r.enabled ? "ready" : "paused"}
											label={r.enabled ? "On" : "Off"}
										/>
									</TableCell>
									<TableCell className="text-right">
										{canManage && (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<Button
														size="icon"
														variant="ghost"
														aria-label={`More for ${r.name}`}
													>
														<MoreHorizontal />
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onSelect={() => setEditing(r)}
													>
														Edit
													</DropdownMenuItem>
													<DropdownMenuItem
														variant="destructive"
														onSelect={() => setDeleting(r)}
													>
														Delete
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
		</Page>
	);
}

type Form = {
	brand?: string;
	name: string;
	match_to: string;
	match_from: string;
	match_subject: string;
	action: "forward" | "drop";
	forward_to: string;
	continue: boolean;
	enabled: boolean;
};

const formOf = (r: Rule | null): Form => ({
	brand: r?.brand_id,
	name: r?.name ?? "",
	match_to: r?.match_to === "*" ? "" : (r?.match_to ?? ""),
	match_from: r?.match_from ?? "",
	match_subject: r?.match_subject ?? "",
	action: r?.action ?? "forward",
	forward_to: r?.forward_to.join(", ") ?? "",
	continue: r?.continue ?? false,
	enabled: r?.enabled ?? true,
});

function RuleDialog({
	rule,
	brands,
	onClose,
}: {
	rule: Rule | "new" | null;
	brands: { id: string; name: string }[];
	onClose: () => void;
}) {
	const router = useRouter();
	const existing = rule && rule !== "new" ? rule : null;
	const [form, setForm] = useState<Form>(() => formOf(existing));
	const [busy, setBusy] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when another rule opens
	useEffect(() => setForm(formOf(existing)), [rule]);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	return (
		<Dialog
			open={rule !== null}
			onOpenChange={(v) => !v && onClose()}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							await saveRuleFn({
								data: {
									id: existing?.id,
									fields: {
										brand: form.brand,
										name: form.name,
										match_to: form.match_to,
										match_from: form.match_from || null,
										match_subject: form.match_subject || null,
										action: form.action,
										forward_to:
											form.action === "forward" ? form.forward_to : null,
										continue: form.continue,
										enabled: form.enabled,
									},
								},
							});
							toast.success(existing ? "Rule saved" : "Rule added");
							onClose();
							await router.invalidate();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{existing ? "Edit rule" : "New rule"}</DialogTitle>
						<DialogDescription>
							Leave a match empty to take any value.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						{!existing && brands.length > 1 && (
							<Field>
								<FieldLabel>Brand</FieldLabel>
								<BrandFilter
									brands={brands}
									value={form.brand}
									all={null}
									onChange={(b) => set("brand", b)}
									className="w-full sm:w-full"
								/>
							</Field>
						)}
						<Field>
							<FieldLabel htmlFor="rule-name">Name</FieldLabel>
							<Input
								id="rule-name"
								required
								placeholder="Bookings to the front desk"
								value={form.name}
								onChange={(e) => set("name", e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="rule-to">Sent to</FieldLabel>
							<Input
								id="rule-to"
								spellCheck={false}
								placeholder="reservas@hotel.com, *@hotel.com or support@*"
								value={form.match_to}
								onChange={(e) => set("match_to", e.target.value)}
							/>
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="rule-from">From contains</FieldLabel>
								<Input
									id="rule-from"
									spellCheck={false}
									placeholder="booking.com"
									value={form.match_from}
									onChange={(e) => set("match_from", e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="rule-subject">Subject contains</FieldLabel>
								<Input
									id="rule-subject"
									placeholder="Out of office"
									value={form.match_subject}
									onChange={(e) => set("match_subject", e.target.value)}
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="rule-action">Then</FieldLabel>
							<Select
								value={form.action}
								onValueChange={(v) => set("action", v as Form["action"])}
							>
								<SelectTrigger id="rule-action">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="forward">
										Forward a copy (and keep it)
									</SelectItem>
									<SelectItem value="drop">
										Drop it (not kept, no webhook)
									</SelectItem>
								</SelectContent>
							</Select>
						</Field>
						{form.action === "forward" && (
							<Field>
								<FieldLabel htmlFor="rule-forward">Forward to</FieldLabel>
								<Input
									id="rule-forward"
									required
									spellCheck={false}
									placeholder="desk@gmail.com, manager@gmail.com"
									value={form.forward_to}
									onChange={(e) => set("forward_to", e.target.value)}
								/>
								<FieldDescription>
									Sent from the address it came to (or forwarding@ your domain),
									with Reply-To the sender, so answering reaches them.
								</FieldDescription>
							</Field>
						)}
						<div className="flex items-center justify-between gap-4 text-sm">
							<label htmlFor="rule-continue">Check the next rules too</label>
							<Switch
								id="rule-continue"
								checked={form.continue}
								onCheckedChange={(v) => set("continue", v)}
							/>
						</div>
						<div className="flex items-center justify-between gap-4 text-sm">
							<label htmlFor="rule-enabled">On</label>
							<Switch
								id="rule-enabled"
								checked={form.enabled}
								onCheckedChange={(v) => set("enabled", v)}
							/>
						</div>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !form.name.trim()}
						>
							{busy && <Spinner />}
							{existing ? "Save rule" : "Add rule"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
