import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { MoreHorizontal, Pause, Play, Trash2, Workflow, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import {
	AutomationCanvas,
	STEP_KINDS,
	stepIcon,
	stepTone,
	TRIGGER_ICON,
} from "@/components/automation-canvas";
import { AutomationStatus, triggerLabel } from "@/components/automation-status";
import { Confirm } from "@/components/confirm";
import { ListSelect } from "@/components/list-dialogs";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TagField } from "@/components/variables";
import {
	cancelRunFn,
	deleteAutomationFn,
	getAutomationFn,
	saveAutomationFn,
} from "@/functions/automations";
import {
	blank,
	type Check,
	type Form,
	findStep,
	formOf,
	insertStep,
	removeStep,
	type SavedStep,
	type SavedTrigger,
	type Step,
	stepAtPath,
	type TriggerType,
	toFields,
	type Unit,
	updateStep,
} from "@/lib/automation-form";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/automations/$id")({
	loader: ({ params }) => getAutomationFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.automation.name ?? "Automation"} · Mailroom` }],
	}),
	component: AutomationPage,
	pendingComponent: AutomationSketch,
});

type Data = Awaited<ReturnType<typeof getAutomationFn>>;

function AutomationSketch() {
	const { params } = usePage(Route);
	const row = listedRow<{ name: string; status: string }>("automations", params.id);
	return (
		<Sketch
			data={
				{
					automation: {
						object: "automation",
						id: params.id ?? "",
						brand_id: "",
						name: row?.name ?? "Automation",
						status: (row?.status ?? "draft") as "draft",
						trigger: { type: "contact.created" },
						steps: [],
						reentry: false,
						created_at: ago(60 * 24),
						updated_at: ago(60),
					},
					brand: null,
					counts: { active: 0, done: 0, exited: 0, failed: 0, canceled: 0 },
					runs: [],
					here: [],
					segments: [],
					topics: [],
					properties: [],
					broadcasts: [],
					templates: [],
				} satisfies Data
			}
		>
			<AutomationPage />
		</Sketch>
	);
}

const NONE = "none";
const ANY = "any";

const TRIGGERS: { type: TriggerType; label: string; hint: string }[] = [
	{ type: "contact.created", label: "A contact is added", hint: "By a form, the API or by hand" },
	{ type: "segment.joined", label: "A contact joins a segment", hint: "Like a tag being added" },
	{ type: "email.opened", label: "A contact opens a broadcast", hint: "Any, or one of them" },
	{ type: "email.clicked", label: "A contact clicks a link", hint: "In any broadcast, or one" },
	{ type: "event", label: "Your app sends an event", hint: "POST /api/events" },
];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function AutomationPage() {
	const { data } = usePage(Route);
	const saved = data.automation;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "automations:edit");
	const savedForm = () =>
		formOf(
			saved as { name: string; trigger: SavedTrigger; reentry: boolean; steps: SavedStep[] },
		);
	const [form, setForm] = useState<Form>(savedForm);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved automation changes
	useEffect(() => setForm(savedForm()), [saved.updated_at, saved.id]);
	const dirty = JSON.stringify(toFields(form)) !== JSON.stringify(toFields(savedForm()));
	const [busy, setBusy] = useState<"save" | "status" | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	const setStep = (key: string, change: Partial<Step>) =>
		setForm((f) => ({ ...f, steps: updateStep(f.steps, key, change) }));

	const segmentName = (id: string) => data.segments.find((s) => s.id === id)?.name;
	const broadcastName = (id: string) => data.broadcasts.find((b) => b.id === id)?.name;
	const templateOf = (id: string) => data.templates.find((t) => t.id === id);

	const here = useMemo(() => new Map(data.here.map((h) => [h.path.join("."), h.n])), [data.here]);

	const describe = (s: Step) => {
		switch (s.type) {
			case "send": {
				const t = templateOf(s.template_id);
				return {
					title: t?.name ?? "Choose a template",
					detail: s.subject || t?.subject || "",
				};
			}
			case "wait": {
				const n = Number(s.amount) || 0;
				return {
					title: `Wait ${plural(n, s.unit.replace(/s$/, ""))}`,
					detail: "Then go on",
				};
			}
			case "segment":
				return {
					title: `${s.action === "add" ? "Add to" : "Remove from"} ${segmentName(s.segment_id) ?? "a segment"}`,
					detail: s.action === "add" ? "Can start other automations" : "",
				};
			case "property":
				return {
					title: `Set ${s.property || "a property"}`,
					detail: s.value ? `to “${s.value}”` : "to nothing",
				};
			case "condition": {
				const title =
					s.check === "opened"
						? "Opened the last email?"
						: s.check === "clicked"
							? "Clicked in the last email?"
							: s.check === "segment"
								? `In ${segmentName(s.segment_id) ?? "a segment"}?`
								: s.equals
									? `${s.property || "property"} is “${s.equals}”?`
									: `${s.property || "property"} has a value?`;
				return {
					title,
					detail: s.no.length ? "Yes and no paths" : "No: the run ends",
				};
			}
		}
	};

	const triggerInfo = {
		title: TRIGGERS.find((t) => t.type === form.trigger)?.label ?? "",
		detail:
			form.trigger === "event"
				? form.event || ""
				: form.trigger === "email.opened" || form.trigger === "email.clicked"
					? [
							form.broadcast_id
								? (broadcastName(form.broadcast_id) ?? "One broadcast")
								: "Any broadcast",
							form.trigger === "email.clicked" && form.link
								? form.link.replace(/^https?:\/\//, "")
								: null,
						]
							.filter(Boolean)
							.join(" · ")
					: form.segment_id
						? `In ${segmentName(form.segment_id) ?? "a segment"}`
						: form.trigger === "contact.created"
							? "Anyone"
							: "",
	};

	const save = async (status?: "active" | "paused") => {
		setBusy(status ? "status" : "save");
		try {
			await saveAutomationFn({
				data: {
					id: saved.id,
					fields: {
						...(toFields(form) as unknown as Record<string, never>),
						...(status ? { status } : {}),
					},
				},
			});
			toast.success(
				status === "active"
					? "On: it starts for contacts from now"
					: status
						? "Paused"
						: "Saved",
			);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const on = saved.status === "active";
	const current = selected && selected !== "trigger" ? findStep(form.steps, selected) : null;
	const savedSteps = useMemo(
		() =>
			formOf(
				saved as {
					name: string;
					trigger: SavedTrigger;
					reentry: boolean;
					steps: SavedStep[];
				},
			).steps,
		[saved],
	);

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/automations"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Automations
					</Link>
				</nav>
				<RecordHeader
					icon={Workflow}
					tone={on ? "blue" : "gray"}
					kind={data.brand ? `Automation of ${data.brand.name}` : "Automation"}
					title={saved.name}
					actions={
						<>
							{canManage && (
								<>
									<Button
										variant="outline"
										disabled={!dirty || !!busy}
										onClick={() => save()}
									>
										{busy === "save" && <Spinner />}
										{dirty ? "Save changes" : "Saved"}
									</Button>
									<Button
										variant={on ? "outline" : "default"}
										disabled={!!busy}
										onClick={() => save(on ? "paused" : "active")}
									>
										{busy === "status" ? (
											<Spinner />
										) : on ? (
											<Pause />
										) : (
											<Play />
										)}
										{on ? "Pause" : "Turn on"}
									</Button>
								</>
							)}
							<ApiDrawer
								title="This automation in the API"
								description="Needs a full-access key."
								calls={[
									...(saved.trigger.type === "event"
										? [
												{
													title: "Start it",
													method: "POST" as const,
													path: "/events",
													body: {
														event: saved.trigger.event,
														email: "ana@example.com",
														data: { room: "204" },
													},
												},
											]
										: []),
									{
										title: "Its runs",
										method: "GET",
										path: `/automations/${saved.id}/runs`,
									},
								]}
							/>
							{canManage && (
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
										<DropdownMenuItem
											variant="destructive"
											onSelect={() => setDeleting(true)}
										>
											<Trash2 /> Delete automation
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</>
					}
				/>
			</div>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this automation?"
				description="Runs under way stop. Emails already sent stay in the log."
				action="Delete automation"
				onConfirm={async () => {
					try {
						await deleteAutomationFn({ data: { id: saved.id } });
						toast.success("Automation deleted");
						await router.navigate({ to: "/automations" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">
					<AutomationStatus status={saved.status} />
				</Fact>
				<Fact label="Under way">
					<span className="tabular-nums">{data.counts.active ?? 0}</span>
				</Fact>
				<Fact label="Finished">
					<span className="tabular-nums">
						{(data.counts.done ?? 0) + (data.counts.exited ?? 0)}
					</span>
				</Fact>
				<Fact label="Id">
					<IdChip value={saved.id} />
				</Fact>
			</Facts>

			<Card className="grid min-w-0 gap-0 overflow-hidden p-0 lg:grid-cols-[minmax(0,1fr)_380px]">
				<AutomationCanvas
					form={form}
					selected={selected}
					onSelect={setSelected}
					here={here}
					describe={describe}
					trigger={triggerInfo}
					editable={canManage}
					onInsert={(at, index, kind) => {
						const step = { ...blank(kind.type), action: kind.action ?? "add" };
						setForm((f) => ({ ...f, steps: insertStep(f.steps, at, index, step) }));
						setSelected(step.key);
					}}
				/>
				<aside className="flex min-w-0 flex-col border-t border-border/70 lg:max-h-[calc(100vh-8rem)] lg:min-h-[560px] lg:border-t-0 lg:border-l">
					{selected === "trigger" ? (
						<Panel
							icon={TRIGGER_ICON[form.trigger]}
							tone={stepTone("trigger").tile}
							eyebrow="Trigger"
							title="What starts it"
							onClose={() => setSelected(null)}
						>
							<TriggerFields
								form={form}
								set={set}
								data={data}
								disabled={!canManage}
							/>
						</Panel>
					) : current ? (
						<Panel
							icon={stepIcon(current)}
							tone={stepTone(current.type).tile}
							eyebrow={
								STEP_KINDS.find(
									(k) =>
										k.type === current.type &&
										(k.type !== "segment" || k.action === current.action),
								)?.label ?? ""
							}
							title={describe(current).title}
							onClose={() => setSelected(null)}
							onRemove={
								canManage
									? () => {
											setForm((f) => ({
												...f,
												steps: removeStep(f.steps, current.key),
											}));
											setSelected(null);
										}
									: undefined
							}
						>
							<StepFields
								s={current}
								setStep={(c) => setStep(current.key, c)}
								data={data}
								disabled={!canManage}
							/>
						</Panel>
					) : (
						<Overview
							form={form}
							set={set}
							disabled={!canManage}
							data={data}
							on={on}
							savedSteps={savedSteps}
							describe={describe}
							segmentName={segmentName}
							broadcastName={broadcastName}
							onCancel={async (run) => {
								try {
									await cancelRunFn({ data: { automation: saved.id, run } });
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
							canManage={canManage}
						/>
					)}
				</aside>
			</Card>
		</Page>
	);
}

function Panel({
	icon: Icon,
	tone,
	eyebrow,
	title,
	onClose,
	onRemove,
	children,
}: {
	icon: React.ComponentType<{ className?: string }>;
	tone: string;
	eyebrow: string;
	title: string;
	onClose: () => void;
	onRemove?: () => void;
	children: ReactNode;
}) {
	return (
		<>
			<div className="flex items-start gap-3 border-b border-border/70 px-5 py-4">
				<span
					className={cn(
						"flex size-9 shrink-0 items-center justify-center rounded-lg",
						tone,
					)}
				>
					<Icon className="size-[18px]" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
						{eyebrow}
					</p>
					<h2 className="truncate text-sm font-semibold">{title}</h2>
				</div>
				<div className="-mr-2 flex items-center">
					{onRemove && (
						<Button
							size="icon"
							variant="ghost"
							className="size-8 text-muted-foreground hover:text-destructive"
							aria-label="Remove step"
							title="Remove step"
							onClick={onRemove}
						>
							<Trash2 />
						</Button>
					)}
					<Button
						size="icon"
						variant="ghost"
						className="size-8"
						aria-label="Close"
						onClick={onClose}
					>
						<X />
					</Button>
				</div>
			</div>
			<div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">{children}</div>
		</>
	);
}

function TriggerFields({
	form,
	set,
	data,
	disabled,
}: {
	form: Form;
	set: <K extends keyof Form>(k: K, v: Form[K]) => void;
	data: Data;
	disabled: boolean;
}) {
	const email = form.trigger === "email.opened" || form.trigger === "email.clicked";
	return (
		<>
			<div
				className="flex flex-col gap-1.5"
				role="radiogroup"
				aria-label="Starts when"
			>
				{TRIGGERS.map((t) => {
					const Icon = TRIGGER_ICON[t.type];
					const on = form.trigger === t.type;
					return (
						// biome-ignore lint/a11y/useSemanticElements: a card that acts as a radio
						<button
							key={t.type}
							type="button"
							role="radio"
							aria-checked={on}
							disabled={disabled}
							onClick={() => set("trigger", t.type)}
							className={cn(
								"flex items-center gap-3 rounded-lg px-3 py-2.5 text-left shadow-[0_0_0_1px_var(--border)] transition-shadow outline-none hover:shadow-[0_0_0_1px_var(--border-strong)] focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
								on && "bg-amber-500/5 shadow-[0_0_0_1.5px_var(--color-amber-500)]",
							)}
						>
							<Icon
								className={cn(
									"size-4 shrink-0",
									on
										? "text-amber-600 dark:text-amber-400"
										: "text-muted-foreground",
								)}
							/>
							<span className="flex min-w-0 flex-col">
								<span className="text-sm font-medium">{t.label}</span>
								<span className="text-xs text-muted-foreground">{t.hint}</span>
							</span>
						</button>
					);
				})}
			</div>
			{(form.trigger === "contact.created" || form.trigger === "segment.joined") && (
				<Field>
					<FieldLabel htmlFor="a-seg">
						{form.trigger === "segment.joined" ? "Segment" : "Only when added to"}
					</FieldLabel>
					<ListSelect
						kind="segment"
						id="a-seg"
						brand={data.automation.brand_id || null}
						disabled={disabled}
						canCreate={!disabled}
						value={form.segment_id}
						onChange={(v) => set("segment_id", v)}
						items={data.segments}
						none={form.trigger === "segment.joined" ? "Pick a segment" : "Any segment"}
						noneDisabled={form.trigger === "segment.joined"}
					/>
				</Field>
			)}
			{form.trigger === "event" && (
				<Field>
					<FieldLabel htmlFor="a-event">Event name</FieldLabel>
					<Input
						id="a-event"
						className="font-mono"
						spellCheck={false}
						disabled={disabled}
						placeholder="booking.created"
						value={form.event}
						onChange={(e) => set("event", e.target.value)}
					/>
					<FieldDescription>
						Its data goes in emails as {"{{{event.<key>}}}"}.
					</FieldDescription>
				</Field>
			)}
			{email && (
				<Field>
					<FieldLabel htmlFor="a-broadcast">Broadcast</FieldLabel>
					<Select
						disabled={disabled}
						value={form.broadcast_id || ANY}
						onValueChange={(v) => set("broadcast_id", v === ANY ? "" : v)}
					>
						<SelectTrigger id="a-broadcast">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ANY}>Any broadcast</SelectItem>
							{data.broadcasts.map((b) => (
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
			{form.trigger === "email.clicked" && (
				<Field>
					<FieldLabel htmlFor="a-link">Link</FieldLabel>
					<Input
						id="a-link"
						spellCheck={false}
						disabled={disabled}
						placeholder="Any link"
						value={form.link}
						onChange={(e) => set("link", e.target.value)}
					/>
					<FieldDescription>
						A URL in the email, like https://example.com/pricing. Empty: any link.
					</FieldDescription>
				</Field>
			)}
			{(form.trigger === "event" || email) && (
				<div className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-3.5 py-3 text-sm">
					<label htmlFor="a-reentry">
						<span className="font-medium">Start again each time</span>
						<span className="block text-xs text-muted-foreground">
							Off: a contact goes through it once.
						</span>
					</label>
					<Switch
						id="a-reentry"
						disabled={disabled}
						checked={form.reentry}
						onCheckedChange={(v) => set("reentry", v)}
					/>
				</div>
			)}
		</>
	);
}

function StepFields({
	s,
	setStep,
	data,
	disabled,
}: {
	s: Step;
	setStep: (c: Partial<Step>) => void;
	data: Data;
	disabled: boolean;
}) {
	const brand = data.automation.brand_id || null;
	if (s.type === "wait")
		return (
			<Field>
				<FieldLabel htmlFor={`${s.key}-amount`}>Wait for</FieldLabel>
				<div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-2">
					<Input
						id={`${s.key}-amount`}
						inputMode="numeric"
						disabled={disabled}
						value={s.amount}
						onChange={(e) => setStep({ amount: e.target.value.replace(/[^\d.]/g, "") })}
					/>
					<ToggleGroup
						type="single"
						variant="outline"
						disabled={disabled}
						value={s.unit}
						onValueChange={(v) => v && setStep({ unit: v as Unit })}
						className="w-full *:flex-1"
					>
						<ToggleGroupItem value="minutes">Minutes</ToggleGroupItem>
						<ToggleGroupItem value="hours">Hours</ToggleGroupItem>
						<ToggleGroupItem value="days">Days</ToggleGroupItem>
					</ToggleGroup>
				</div>
				<FieldDescription>Up to 90 days. The next step goes after it.</FieldDescription>
			</Field>
		);
	if (s.type === "send") {
		const tpl = data.templates.find((t) => t.id === s.template_id);
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-tpl`}>Template</FieldLabel>
					<Select
						disabled={disabled}
						value={s.template_id || NONE}
						onValueChange={(v) => setStep({ template_id: v === NONE ? "" : v })}
					>
						<SelectTrigger id={`${s.key}-tpl`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem
								value={NONE}
								disabled
							>
								Pick a template
							</SelectItem>
							{data.templates.map((t) => (
								<SelectItem
									key={t.id}
									value={t.id}
									disabled={!t.published}
								>
									{t.name}
									{!t.published && " (draft)"}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>
						{data.templates.length === 0 ? (
							<>
								Make one first in{" "}
								<Link
									to="/templates"
									className="underline underline-offset-2"
								>
									Templates
								</Link>
								.
							</>
						) : tpl ? (
							<Link
								to="/templates/$id"
								params={{ id: tpl.id }}
								className="underline underline-offset-2"
							>
								Open the template
							</Link>
						) : (
							"Published templates, filled in with the contact's values."
						)}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-subject`}>Subject</FieldLabel>
					<TagField
						id={`${s.key}-subject`}
						disabled={disabled}
						placeholder={tpl?.subject ?? "The template's"}
						value={s.subject}
						onChange={(v) => setStep({ subject: v })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-from`}>From</FieldLabel>
					<Input
						id={`${s.key}-from`}
						spellCheck={false}
						disabled={disabled}
						placeholder={tpl?.from ?? "The template's"}
						value={s.from}
						onChange={(e) => setStep({ from: e.target.value })}
					/>
				</Field>
			</>
		);
	}
	if (s.type === "segment")
		return (
			<>
				<Field>
					<FieldLabel>Action</FieldLabel>
					<ToggleGroup
						type="single"
						variant="outline"
						disabled={disabled}
						value={s.action}
						onValueChange={(v) => v && setStep({ action: v as Step["action"] })}
						className="w-full *:flex-1"
					>
						<ToggleGroupItem value="add">Add to</ToggleGroupItem>
						<ToggleGroupItem value="remove">Remove from</ToggleGroupItem>
					</ToggleGroup>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-seg`}>Segment</FieldLabel>
					<ListSelect
						kind="segment"
						id={`${s.key}-seg`}
						brand={brand}
						disabled={disabled}
						canCreate={!disabled}
						value={s.segment_id}
						onChange={(v) => setStep({ segment_id: v })}
						items={data.segments}
						none="Pick a segment"
						noneDisabled
					/>
					{s.action === "add" && (
						<FieldDescription>
							Automations that start when someone joins it start too.
						</FieldDescription>
					)}
				</Field>
			</>
		);
	if (s.type === "property")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-prop`}>Property</FieldLabel>
					<Select
						disabled={disabled}
						value={s.property || NONE}
						onValueChange={(v) => setStep({ property: v === NONE ? "" : v })}
					>
						<SelectTrigger
							id={`${s.key}-prop`}
							className="font-mono"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem
								value={NONE}
								disabled
							>
								Pick a property
							</SelectItem>
							{data.properties.map((p) => (
								<SelectItem
									key={p.key}
									value={p.key}
									className="font-mono"
								>
									{p.key}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{data.properties.length === 0 && (
						<FieldDescription>
							Add properties in{" "}
							<Link
								to="/contacts"
								className="underline underline-offset-2"
							>
								Contacts
							</Link>{" "}
							first.
						</FieldDescription>
					)}
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-value`}>Value</FieldLabel>
					<Input
						id={`${s.key}-value`}
						disabled={disabled}
						placeholder="customer"
						value={s.value}
						onChange={(e) => setStep({ value: e.target.value })}
					/>
				</Field>
			</>
		);
	// A condition.
	return (
		<>
			<Field>
				<FieldLabel htmlFor={`${s.key}-check`}>Check whether</FieldLabel>
				<Select
					disabled={disabled}
					value={s.check}
					onValueChange={(v) => setStep({ check: v as Check })}
				>
					<SelectTrigger id={`${s.key}-check`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="opened">They opened the last email</SelectItem>
						<SelectItem value="clicked">They clicked in the last email</SelectItem>
						<SelectItem value="segment">They're in a segment</SelectItem>
						<SelectItem value="property">A property has a value</SelectItem>
					</SelectContent>
				</Select>
			</Field>
			{s.check === "segment" && (
				<Field>
					<FieldLabel htmlFor={`${s.key}-seg`}>Segment</FieldLabel>
					<ListSelect
						kind="segment"
						id={`${s.key}-seg`}
						brand={brand}
						disabled={disabled}
						canCreate={!disabled}
						value={s.segment_id}
						onChange={(v) => setStep({ segment_id: v })}
						items={data.segments}
						none="Pick a segment"
						noneDisabled
					/>
				</Field>
			)}
			{s.check === "property" && (
				<div className="grid grid-cols-2 gap-3">
					<Field>
						<FieldLabel htmlFor={`${s.key}-cprop`}>Property</FieldLabel>
						<Input
							id={`${s.key}-cprop`}
							className="font-mono"
							disabled={disabled}
							placeholder="plan"
							value={s.property}
							onChange={(e) => setStep({ property: e.target.value })}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor={`${s.key}-equals`}>Equals</FieldLabel>
						<Input
							id={`${s.key}-equals`}
							disabled={disabled}
							placeholder="Any value"
							value={s.equals}
							onChange={(e) => setStep({ equals: e.target.value })}
						/>
					</Field>
				</div>
			)}
			<div className="grid gap-2 rounded-lg bg-muted/60 p-3.5 text-xs text-muted-foreground">
				<p>
					<span className="font-semibold text-emerald-700 dark:text-emerald-300">
						Yes
					</span>{" "}
					goes on with the steps under it on the left.
				</p>
				<p>
					<span className="font-semibold text-rose-700 dark:text-rose-300">No</span>{" "}
					{s.no.length
						? "takes the steps on the right."
						: "ends the run, until you add steps on the right."}
				</p>
			</div>
		</>
	);
}

const RUN_BADGE: Record<string, { status: string; label: string }> = {
	active: { status: "sending", label: "Under way" },
	done: { status: "delivered", label: "Done" },
	exited: { status: "canceled", label: "Left" },
	failed: { status: "failed", label: "Failed" },
	canceled: { status: "canceled", label: "Stopped" },
};

function Overview({
	form,
	set,
	disabled,
	data,
	on,
	savedSteps,
	describe,
	segmentName,
	broadcastName,
	onCancel,
	canManage,
}: {
	form: Form;
	set: <K extends keyof Form>(k: K, v: Form[K]) => void;
	disabled: boolean;
	data: Data;
	on: boolean;
	savedSteps: Step[];
	describe: (s: Step) => { title: string };
	segmentName: (id: string) => string | undefined;
	broadcastName: (id: string) => string | undefined;
	onCancel: (run: string) => void;
	canManage: boolean;
}) {
	return (
		<>
			<div className="flex flex-col gap-4 border-b border-border/70 px-5 py-5">
				<Field>
					<FieldLabel htmlFor="a-name">Name</FieldLabel>
					<Input
						id="a-name"
						disabled={disabled}
						value={form.name}
						onChange={(e) => set("name", e.target.value)}
					/>
				</Field>
				<p className="text-xs text-muted-foreground">
					{triggerLabel(data.automation.trigger, segmentName, broadcastName)}. Select a
					step on the canvas to change it, or + on a line to add one.
				</p>
			</div>
			<div className="flex h-11 shrink-0 items-center justify-between border-b border-border/70 px-5">
				<h2 className="text-sm font-semibold">Contacts going through it</h2>
				<span className="text-xs text-muted-foreground tabular-nums">
					{data.runs.length ? `Latest ${data.runs.length}` : ""}
				</span>
			</div>
			{data.runs.length === 0 ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 py-12 text-center">
					<p className="text-sm font-medium">No one yet</p>
					<p className="text-xs text-muted-foreground">
						{on
							? "It starts for contacts from when it was turned on."
							: "Turn it on and contacts start going through it."}
					</p>
				</div>
			) : (
				<ul className="flex flex-col overflow-y-auto">
					{data.runs.map((run) => {
						const at =
							run.status === "active"
								? stepAtPath(savedSteps, run.path?.length ? run.path : [run.step])
								: null;
						const badge = RUN_BADGE[run.status] ?? {
							status: run.status,
							label: run.status,
						};
						return (
							<li
								key={run.id}
								className="flex items-center gap-3 border-b border-border/50 px-5 py-2.5 text-sm last:border-0"
							>
								<div className="flex min-w-0 flex-1 flex-col">
									<Link
										to="/contacts/$id"
										params={{ id: run.contact_id }}
										className="truncate hover:underline"
									>
										<Ph>{run.email ?? "Deleted contact"}</Ph>
									</Link>
									<span
										className={cn(
											"truncate text-xs text-muted-foreground",
											run.error && "text-destructive",
										)}
										title={run.error ?? undefined}
									>
										{run.status === "active"
											? `${at ? `Next: ${describe(at).title}` : "Next step"}${
													run.next_at &&
													new Date(run.next_at).getTime() > Date.now()
														? ` · ${formatDateTime(run.next_at)}`
														: ""
												}`
											: (run.error ?? formatAgo(run.updated_at))}
									</span>
								</div>
								<StatusBadge
									status={badge.status}
									label={badge.label}
								/>
								{canManage && run.status === "active" && (
									<Button
										size="icon"
										variant="ghost"
										className="-mr-2 size-7"
										aria-label="Stop this run"
										title="Stop this run"
										onClick={() => onCancel(run.id)}
									>
										<X />
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}
