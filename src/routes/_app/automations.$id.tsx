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
import { Checkbox } from "@/components/ui/checkbox";
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
import { Textarea } from "@/components/ui/textarea";
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
	type ConversationAction,
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
						goal_event: null,
						created_at: ago(60 * 24),
						updated_at: ago(60),
					},
					brand: null,
					counts: { active: 0, done: 0, exited: 0, failed: 0, canceled: 0, converted: 0 },
					runs: [],
					here: [],
					segments: [],
					topics: [],
					properties: [],
					broadcasts: [],
					templates: [],
					forms: [],
					newsletters: [],
					inboxes: [],
					team: [],
					events: [],
				} satisfies Data
			}
		>
			<AutomationPage />
		</Sketch>
	);
}

const NONE = "none";
const ANY = "any";

const TRIGGERS: { type: TriggerType; label: string; hint: string; group: string }[] = [
	{
		type: "contact.created",
		label: "A contact is added",
		hint: "By a form, the API or by hand",
		group: "Audience",
	},
	{
		type: "segment.joined",
		label: "A contact joins a segment",
		hint: "Like a tag being added",
		group: "Audience",
	},
	{
		type: "form.submitted",
		label: "Someone signs up on a form",
		hint: "Any form, or one",
		group: "Audience",
	},
	{
		type: "property.changed",
		label: "A property changes",
		hint: "Like plan becoming pro",
		group: "Audience",
	},
	{
		type: "topic.changed",
		label: "A topic choice changes",
		hint: "Opted in or out",
		group: "Audience",
	},
	{
		type: "unsubscribed",
		label: "A contact unsubscribes",
		hint: "From all broadcasts",
		group: "Audience",
	},
	{
		type: "date",
		label: "A date comes round",
		hint: "Birthdays, anniversaries, trials",
		group: "Time",
	},
	{
		type: "inactive",
		label: "A contact stops engaging",
		hint: "No opens or clicks for a while",
		group: "Time",
	},
	{
		type: "email.opened",
		label: "A contact opens a broadcast",
		hint: "Any, or one of them",
		group: "Email",
	},
	{
		type: "email.clicked",
		label: "A contact clicks a link",
		hint: "In any broadcast, or one",
		group: "Email",
	},
	{
		type: "event",
		label: "Something happens",
		hint: "An event from your app, a poll, a referral",
		group: "Events",
	},
	{
		type: "conversation.opened",
		label: "A conversation starts",
		hint: "An email to an inbox, or a chat",
		group: "Support",
	},
	{
		type: "conversation.resolved",
		label: "A conversation is resolved",
		hint: "Follow up after support",
		group: "Support",
	},
	{
		type: "conversation.rated",
		label: "A conversation is rated",
		hint: "Happy or unhappy guests",
		group: "Support",
	},
];

/** Events Mailroom sends itself, offered beside the brand's own. */
const OWN_EVENTS = [
	{ name: "poll.answered", hint: "Someone answered a poll in a broadcast" },
	{ name: "referral.milestone", hint: "Someone reached a referral reward" },
];

/** The triggers that may start again for the same contact (as the server allows). */
const REENTERS = new Set<TriggerType>([
	"event",
	"email.opened",
	"email.clicked",
	"form.submitted",
	"topic.changed",
	"property.changed",
	"date",
	"inactive",
	"conversation.opened",
	"conversation.resolved",
	"conversation.rated",
]);

const PRIORITIES = ["urgent", "high", "normal", "low"];

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function AutomationPage() {
	const { data } = usePage(Route);
	const saved = data.automation;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "automations:edit");
	const savedForm = () =>
		formOf(
			saved as {
				name: string;
				trigger: SavedTrigger;
				reentry: boolean;
				goal_event: string | null;
				steps: SavedStep[];
			},
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

	const topicName = (id: string) => data.topics.find((t) => t.id === id)?.name;
	const describe = (s: Step): { title: string; detail: string } => {
		switch (s.type) {
			case "email":
				return { title: s.subject || "A quick email", detail: s.from };
			case "wait_event": {
				const n = Number(s.amount) || 0;
				return {
					title: `Until they do ${s.event || "something"}`,
					detail: `Or ${plural(n, s.unit.replace(/s$/, ""))} pass`,
				};
			}
			case "split":
				return {
					title: `${Number(s.percent) || 0}% A, ${100 - (Number(s.percent) || 0)}% B`,
					detail: "Each contact takes one path",
				};
			case "score":
				return {
					title: `${Number(s.add) >= 0 ? "Add" : "Take"} ${Math.abs(Number(s.add) || 0)} ${Number(s.add) >= 0 ? "to" : "from"} ${s.property || "a score"}`,
					detail: "A number property",
				};
			case "topic":
				return {
					title: `${s.topic_value === "opt_in" ? "Opt in to" : "Opt out of"} ${topicName(s.topic_id) ?? "a topic"}`,
					detail: "",
				};
			case "newsletter":
				return {
					title: `${s.newsletter_action === "subscribe" ? "Subscribe to" : "Take off"} ${data.newsletters.find((n) => n.id === s.newsletter_id)?.name ?? "a newsletter"}`,
					detail: "",
				};
			case "notify":
				return {
					title: s.to.length
						? `Tell ${s.to
								.map((e) => data.team.find((m) => m.email === e)?.name || e)
								.join(", ")}`
						: "Tell the team",
					detail: s.message,
				};
			case "conversation":
				return {
					title:
						s.conversation_action === "tag"
							? `Tag it “${s.value || "…"}”`
							: s.conversation_action === "priority"
								? `Make it ${s.value || "…"}`
								: s.conversation_action === "assign"
									? `Assign to ${data.team.find((m) => m.id === s.value)?.name || "someone"}`
									: "Resolve it",
					detail: "Their latest open conversation",
				};
			case "webhook":
				return { title: "Call a webhook", detail: s.url.replace(/^https:\/\//, "") };
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

	const otherDetail = (): string | null => {
		switch (form.trigger) {
			case "form.submitted":
				return form.form_id
					? (data.forms.find((f) => f.id === form.form_id)?.name ?? "One form")
					: "Any form";
			case "topic.changed":
				return `${form.topic_value === "opt_in" ? "Opts in to" : "Opts out of"} ${topicName(form.topic_id) ?? "a topic"}`;
			case "property.changed":
				return form.key
					? `${form.key}${form.equals ? ` becomes “${form.equals}”` : ""}`
					: "";
			case "date": {
				const n = Number(form.offset) || 0;
				const when = n === 0 ? "On" : `${Math.abs(n)} days ${n < 0 ? "before" : "after"}`;
				return form.key ? `${when} ${form.key}${form.yearly ? ", every year" : ""}` : "";
			}
			case "inactive":
				return `${form.days || "?"} days without opening or clicking`;
			case "conversation.opened":
			case "conversation.resolved":
				return form.inbox_id
					? (data.inboxes.find((i) => i.id === form.inbox_id)?.name ?? "One inbox")
					: form.channel === "chat"
						? "Chats"
						: "Any inbox";
			case "conversation.rated":
				return `${form.op === "at_most" ? "At most" : "At least"} ${form.rating} stars`;
			case "unsubscribed":
				return "From all broadcasts";
			default:
				return null;
		}
	};
	const triggerInfo = {
		title: TRIGGERS.find((t) => t.type === form.trigger)?.label ?? "",
		detail:
			otherDetail() ??
			(form.trigger === "event"
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
							: ""),
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
				{saved.goal_event && (
					<Fact label="Reached the goal">
						<span className="tabular-nums">
							{data.counts.converted ?? 0}
							{(() => {
								const all =
									(data.counts.active ?? 0) +
									(data.counts.done ?? 0) +
									(data.counts.exited ?? 0) +
									(data.counts.failed ?? 0) +
									(data.counts.canceled ?? 0);
								return all ? (
									<span className="ml-1.5 text-muted-foreground">
										{Math.round(((data.counts.converted ?? 0) / all) * 100)}%
									</span>
								) : null;
							})()}
						</span>
					</Fact>
				)}
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
				{TRIGGERS.map((t, i) => {
					const Icon = TRIGGER_ICON[t.type];
					const on = form.trigger === t.type;
					return [
						TRIGGERS[i - 1]?.group !== t.group && (
							<p
								key={`g-${t.group}`}
								className={cn(
									"text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
									i > 0 && "pt-2",
								)}
							>
								{t.group}
							</p>
						),
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
						</button>,
					];
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
					<EventInput
						id="a-event"
						disabled={disabled}
						value={form.event}
						onChange={(v) => set("event", v)}
						events={data.events}
					/>
					<FieldDescription>
						From your app (POST /api/events), or Mailroom's own: poll.answered,
						referral.milestone. Its data goes in emails as {"{{{event.<key>}}}"}.
					</FieldDescription>
				</Field>
			)}
			{form.trigger === "form.submitted" && (
				<Field>
					<FieldLabel htmlFor="a-form">Form</FieldLabel>
					<Select
						disabled={disabled}
						value={form.form_id || ANY}
						onValueChange={(v) => set("form_id", v === ANY ? "" : v)}
					>
						<SelectTrigger id="a-form">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ANY}>Any form</SelectItem>
							{data.forms.map((f) => (
								<SelectItem
									key={f.id}
									value={f.id}
								>
									{f.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>When they confirm their address.</FieldDescription>
				</Field>
			)}
			{form.trigger === "topic.changed" && (
				<>
					<Field>
						<FieldLabel htmlFor="a-topic">Topic</FieldLabel>
						<Select
							disabled={disabled}
							value={form.topic_id || NONE}
							onValueChange={(v) => set("topic_id", v === NONE ? "" : v)}
						>
							<SelectTrigger id="a-topic">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem
									value={NONE}
									disabled
								>
									Pick a topic
								</SelectItem>
								{data.topics.map((t) => (
									<SelectItem
										key={t.id}
										value={t.id}
									>
										{t.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<ToggleGroup
						type="single"
						variant="outline"
						disabled={disabled}
						value={form.topic_value}
						onValueChange={(v) => v && set("topic_value", v as Form["topic_value"])}
						className="w-full *:flex-1"
					>
						<ToggleGroupItem value="opt_in">Opts in</ToggleGroupItem>
						<ToggleGroupItem value="opt_out">Opts out</ToggleGroupItem>
					</ToggleGroup>
				</>
			)}
			{(form.trigger === "property.changed" || form.trigger === "date") && (
				<Field>
					<FieldLabel htmlFor="a-key">Property</FieldLabel>
					<PropertySelect
						id="a-key"
						disabled={disabled}
						value={form.key}
						onChange={(v) => set("key", v)}
						properties={data.properties}
					/>
					{form.trigger === "date" && (
						<FieldDescription>
							Holding a date like 1990-11-08 (the year doesn't matter every year).
						</FieldDescription>
					)}
				</Field>
			)}
			{form.trigger === "property.changed" && (
				<Field>
					<FieldLabel htmlFor="a-equals">Becomes</FieldLabel>
					<Input
						id="a-equals"
						disabled={disabled}
						placeholder="Any new value"
						value={form.equals}
						onChange={(e) => set("equals", e.target.value)}
					/>
				</Field>
			)}
			{form.trigger === "date" && (
				<>
					<Field>
						<FieldLabel htmlFor="a-offset">When</FieldLabel>
						<div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
							<Input
								id="a-offset"
								inputMode="numeric"
								disabled={disabled}
								value={String(Math.abs(Number(form.offset) || 0))}
								onChange={(e) => {
									const n = Number(e.target.value.replace(/\D/g, "")) || 0;
									set("offset", String(Number(form.offset) < 0 ? -n : n));
								}}
							/>
							<Select
								disabled={disabled}
								value={Number(form.offset) < 0 ? "before" : "after"}
								onValueChange={(v) => {
									const n = Math.abs(Number(form.offset) || 0);
									set("offset", String(v === "before" ? -n : n));
								}}
							>
								<SelectTrigger aria-label="Before or after">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="before">days before the date</SelectItem>
									<SelectItem value="after">days after the date</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<FieldDescription>
							0 is the day itself. It starts in the morning.
						</FieldDescription>
					</Field>
					<div className="flex items-center justify-between gap-4 rounded-lg bg-muted/60 px-3.5 py-3 text-sm">
						<label htmlFor="a-yearly">
							<span className="font-medium">Every year</span>
							<span className="block text-xs text-muted-foreground">
								A birthday or anniversary. Off: once, like a trial's end.
							</span>
						</label>
						<Switch
							id="a-yearly"
							disabled={disabled}
							checked={form.yearly}
							onCheckedChange={(v) => set("yearly", v)}
						/>
					</div>
				</>
			)}
			{form.trigger === "inactive" && (
				<Field>
					<FieldLabel htmlFor="a-days">Days without opening or clicking</FieldLabel>
					<Input
						id="a-days"
						inputMode="numeric"
						disabled={disabled}
						value={form.days}
						onChange={(e) => set("days", e.target.value.replace(/\D/g, ""))}
					/>
					<FieldDescription>
						For contacts who engaged before. Checked once a day.
					</FieldDescription>
				</Field>
			)}
			{(form.trigger === "conversation.opened" ||
				form.trigger === "conversation.resolved") && (
				<Field>
					<FieldLabel htmlFor="a-inbox">Inbox</FieldLabel>
					<Select
						disabled={disabled}
						value={form.inbox_id || ANY}
						onValueChange={(v) => set("inbox_id", v === ANY ? "" : v)}
					>
						<SelectTrigger id="a-inbox">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={ANY}>Any inbox</SelectItem>
							{data.inboxes.map((i) => (
								<SelectItem
									key={i.id}
									value={i.id}
								>
									{i.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>
						Only for people who are already contacts of this brand.
					</FieldDescription>
				</Field>
			)}
			{form.trigger === "conversation.opened" && (
				<ToggleGroup
					type="single"
					variant="outline"
					disabled={disabled}
					value={form.channel || "any"}
					onValueChange={(v) =>
						v && set("channel", (v === "any" ? "" : v) as Form["channel"])
					}
					className="w-full *:flex-1"
				>
					<ToggleGroupItem value="any">Email or chat</ToggleGroupItem>
					<ToggleGroupItem value="email">Email</ToggleGroupItem>
					<ToggleGroupItem value="chat">Chat</ToggleGroupItem>
				</ToggleGroup>
			)}
			{form.trigger === "conversation.rated" && (
				<Field>
					<FieldLabel>Rating</FieldLabel>
					<div className="grid grid-cols-2 gap-2">
						<Select
							disabled={disabled}
							value={form.op}
							onValueChange={(v) => set("op", v as Form["op"])}
						>
							<SelectTrigger aria-label="At most or at least">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="at_most">At most</SelectItem>
								<SelectItem value="at_least">At least</SelectItem>
							</SelectContent>
						</Select>
						<Select
							disabled={disabled}
							value={form.rating}
							onValueChange={(v) => set("rating", v)}
						>
							<SelectTrigger aria-label="Stars">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{["1", "2", "3", "4", "5"].map((n) => (
									<SelectItem
										key={n}
										value={n}
									>
										{n} {n === "1" ? "star" : "stars"}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
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
			{REENTERS.has(form.trigger) && (
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

/** An event name, with the brand's recent ones and Mailroom's own to pick from. */
function EventInput({
	id,
	value,
	onChange,
	events,
	disabled,
	placeholder = "booking.created",
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	events: string[];
	disabled: boolean;
	placeholder?: string;
}) {
	const names = [...new Set([...events, ...OWN_EVENTS.map((e) => e.name)])];
	return (
		<>
			<Input
				id={id}
				list={`${id}-list`}
				className="font-mono"
				spellCheck={false}
				autoComplete="off"
				disabled={disabled}
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value.trim())}
			/>
			<datalist id={`${id}-list`}>
				{names.map((n) => (
					<option
						key={n}
						value={n}
					/>
				))}
			</datalist>
		</>
	);
}

function PropertySelect({
	id,
	value,
	onChange,
	properties,
	disabled,
	numbers,
}: {
	id: string;
	value: string;
	onChange: (v: string) => void;
	properties: { key: string; type: string }[];
	disabled: boolean;
	numbers?: boolean;
}) {
	const list = numbers ? properties.filter((p) => p.type === "number") : properties;
	return (
		<>
			<Select
				disabled={disabled}
				value={value || NONE}
				onValueChange={(v) => onChange(v === NONE ? "" : v)}
			>
				<SelectTrigger
					id={id}
					className="font-mono"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem
						value={NONE}
						disabled
					>
						{numbers ? "Pick a number property" : "Pick a property"}
					</SelectItem>
					{list.map((p) => (
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
			{list.length === 0 && (
				<FieldDescription>
					Add {numbers ? "a number property" : "properties"} in{" "}
					<Link
						to="/contacts"
						search={{ tab: "properties" }}
						className="underline underline-offset-2"
					>
						Contacts
					</Link>{" "}
					first.
				</FieldDescription>
			)}
		</>
	);
}

function WaitFor({
	s,
	setStep,
	disabled,
	label,
	hint,
}: {
	s: Step;
	setStep: (c: Partial<Step>) => void;
	disabled: boolean;
	label: string;
	hint: string;
}) {
	return (
		<Field>
			<FieldLabel htmlFor={`${s.key}-amount`}>{label}</FieldLabel>
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
			<FieldDescription>{hint}</FieldDescription>
		</Field>
	);
}

function PathsNote({ yes, no, hasNo }: { yes: string; no: string; hasNo: boolean }) {
	return (
		<div className="grid gap-2 rounded-lg bg-muted/60 p-3.5 text-xs text-muted-foreground">
			<p>
				<span className="font-semibold text-emerald-700 dark:text-emerald-300">{yes}</span>{" "}
				goes on with the steps under it on the left.
			</p>
			<p>
				<span className="font-semibold text-rose-700 dark:text-rose-300">{no}</span>{" "}
				{hasNo
					? "takes the steps on the right."
					: "ends the run, until you add steps on the right."}
			</p>
		</div>
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
	if (s.type === "wait_event")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-event`}>Until they do</FieldLabel>
					<EventInput
						id={`${s.key}-event`}
						disabled={disabled}
						value={s.event}
						onChange={(v) => setStep({ event: v })}
						events={data.events}
						placeholder="booking.created"
					/>
				</Field>
				<WaitFor
					s={s}
					setStep={setStep}
					disabled={disabled}
					label="Or at most"
					hint="Up to 90 days. When it comes sooner, the run goes on right away."
				/>
				<PathsNote
					yes="Did it"
					no="Time ran out"
					hasNo={s.no.length > 0}
				/>
			</>
		);
	if (s.type === "split")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-pct`}>Path A gets</FieldLabel>
					<div className="flex items-center gap-2">
						<Input
							id={`${s.key}-pct`}
							inputMode="numeric"
							className="w-24"
							disabled={disabled}
							value={s.percent}
							onChange={(e) =>
								setStep({ percent: e.target.value.replace(/\D/g, "") })
							}
						/>
						<span className="text-sm text-muted-foreground">
							% of contacts; B gets the other{" "}
							{Math.max(0, 100 - (Number(s.percent) || 0))}%.
						</span>
					</div>
					<FieldDescription>
						Each contact is picked at random and always takes the same path.
					</FieldDescription>
				</Field>
				<PathsNote
					yes="A"
					no="B"
					hasNo={s.no.length > 0}
				/>
			</>
		);
	if (s.type === "email")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-from`}>From</FieldLabel>
					<Input
						id={`${s.key}-from`}
						spellCheck={false}
						disabled={disabled}
						placeholder="Ana at Harbor Inn <ana@harborinn.com>"
						value={s.from}
						onChange={(e) => setStep({ from: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-subject`}>Subject</FieldLabel>
					<TagField
						id={`${s.key}-subject`}
						disabled={disabled}
						placeholder="Quick question, {{{FIRST_NAME|there}}}"
						value={s.subject}
						onChange={(v) => setStep({ subject: v })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-body`}>Email</FieldLabel>
					<Textarea
						id={`${s.key}-body`}
						rows={8}
						disabled={disabled}
						placeholder={"Hi {{{FIRST_NAME|there}}},\n\nJust checking in…"}
						value={s.body}
						onChange={(e) => setStep({ body: e.target.value })}
					/>
					<FieldDescription>
						Plain words, like a personal note. A blank line starts a paragraph; the
						unsubscribe link is added for you.
					</FieldDescription>
				</Field>
			</>
		);
	if (s.type === "score")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-score`}>Score</FieldLabel>
					<PropertySelect
						id={`${s.key}-score`}
						disabled={disabled}
						value={s.property}
						onChange={(v) => setStep({ property: v })}
						properties={data.properties}
						numbers
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-add`}>Add</FieldLabel>
					<Input
						id={`${s.key}-add`}
						inputMode="numeric"
						className="w-28"
						disabled={disabled}
						value={s.add}
						onChange={(e) => setStep({ add: e.target.value.replace(/[^\d.-]/g, "") })}
					/>
					<FieldDescription>A negative number takes points away.</FieldDescription>
				</Field>
			</>
		);
	if (s.type === "topic")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-topic`}>Topic</FieldLabel>
					<Select
						disabled={disabled}
						value={s.topic_id || NONE}
						onValueChange={(v) => setStep({ topic_id: v === NONE ? "" : v })}
					>
						<SelectTrigger id={`${s.key}-topic`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem
								value={NONE}
								disabled
							>
								Pick a topic
							</SelectItem>
							{data.topics.map((t) => (
								<SelectItem
									key={t.id}
									value={t.id}
								>
									{t.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<ToggleGroup
					type="single"
					variant="outline"
					disabled={disabled}
					value={s.topic_value}
					onValueChange={(v) => v && setStep({ topic_value: v as Step["topic_value"] })}
					className="w-full *:flex-1"
				>
					<ToggleGroupItem value="opt_in">Opt in</ToggleGroupItem>
					<ToggleGroupItem value="opt_out">Opt out</ToggleGroupItem>
				</ToggleGroup>
			</>
		);
	if (s.type === "newsletter")
		return (
			<>
				<ToggleGroup
					type="single"
					variant="outline"
					disabled={disabled}
					value={s.newsletter_action}
					onValueChange={(v) =>
						v && setStep({ newsletter_action: v as Step["newsletter_action"] })
					}
					className="w-full *:flex-1"
				>
					<ToggleGroupItem value="subscribe">Subscribe</ToggleGroupItem>
					<ToggleGroupItem value="remove">Take off</ToggleGroupItem>
				</ToggleGroup>
				<Field>
					<FieldLabel htmlFor={`${s.key}-nl`}>Newsletter</FieldLabel>
					<Select
						disabled={disabled}
						value={s.newsletter_id || NONE}
						onValueChange={(v) => setStep({ newsletter_id: v === NONE ? "" : v })}
					>
						<SelectTrigger id={`${s.key}-nl`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem
								value={NONE}
								disabled
							>
								Pick a newsletter
							</SelectItem>
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
					<FieldDescription>Its segment and topic follow.</FieldDescription>
				</Field>
			</>
		);
	if (s.type === "notify")
		return (
			<>
				<Field>
					<FieldLabel>Tell</FieldLabel>
					<div className="flex flex-col gap-2">
						{data.team.map((m) => (
							<label
								key={m.id}
								htmlFor={`${s.key}-to-${m.id}`}
								className="flex items-center gap-2.5 text-sm"
							>
								<Checkbox
									id={`${s.key}-to-${m.id}`}
									disabled={disabled}
									checked={s.to.includes(m.email)}
									onCheckedChange={(v) =>
										setStep({
											to:
												v === true
													? [...s.to, m.email]
													: s.to.filter((e) => e !== m.email),
										})
									}
								/>
								<span className="min-w-0 truncate">
									{m.name || m.email}
									{m.name && (
										<span className="ml-1.5 text-muted-foreground">
											{m.email}
										</span>
									)}
								</span>
							</label>
						))}
					</div>
				</Field>
				<Field>
					<FieldLabel htmlFor={`${s.key}-msg`}>Message</FieldLabel>
					<Textarea
						id={`${s.key}-msg`}
						rows={4}
						disabled={disabled}
						placeholder="{{{FIRST_NAME|Someone}}} booked a suite: say hi before they arrive."
						value={s.message}
						onChange={(e) => setStep({ message: e.target.value })}
					/>
					<FieldDescription>
						The email links to the contact. Only people on your team get it.
					</FieldDescription>
				</Field>
			</>
		);
	if (s.type === "conversation")
		return (
			<>
				<Field>
					<FieldLabel htmlFor={`${s.key}-conv`}>Do</FieldLabel>
					<Select
						disabled={disabled}
						value={s.conversation_action}
						onValueChange={(v) =>
							setStep({
								conversation_action: v as ConversationAction,
								value: v === "priority" ? "high" : "",
							})
						}
					>
						<SelectTrigger id={`${s.key}-conv`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="tag">Add a tag</SelectItem>
							<SelectItem value="priority">Set its priority</SelectItem>
							<SelectItem value="assign">Assign it</SelectItem>
							<SelectItem value="resolve">Resolve it</SelectItem>
						</SelectContent>
					</Select>
					<FieldDescription>
						On the contact's latest open conversation; nothing when they have none.
					</FieldDescription>
				</Field>
				{s.conversation_action === "tag" && (
					<Field>
						<FieldLabel htmlFor={`${s.key}-tag`}>Tag</FieldLabel>
						<Input
							id={`${s.key}-tag`}
							disabled={disabled}
							placeholder="vip"
							value={s.value}
							onChange={(e) => setStep({ value: e.target.value })}
						/>
					</Field>
				)}
				{s.conversation_action === "priority" && (
					<ToggleGroup
						type="single"
						variant="outline"
						disabled={disabled}
						value={s.value}
						onValueChange={(v) => v && setStep({ value: v })}
						className="w-full *:flex-1"
					>
						{PRIORITIES.map((p) => (
							<ToggleGroupItem
								key={p}
								value={p}
								className="capitalize"
							>
								{p}
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				)}
				{s.conversation_action === "assign" && (
					<Field>
						<FieldLabel htmlFor={`${s.key}-who`}>To</FieldLabel>
						<Select
							disabled={disabled}
							value={s.value || NONE}
							onValueChange={(v) => setStep({ value: v === NONE ? "" : v })}
						>
							<SelectTrigger id={`${s.key}-who`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem
									value={NONE}
									disabled
								>
									Pick someone
								</SelectItem>
								{data.team.map((m) => (
									<SelectItem
										key={m.id}
										value={m.id}
									>
										{m.name || m.email}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				)}
			</>
		);
	if (s.type === "webhook")
		return (
			<Field>
				<FieldLabel htmlFor={`${s.key}-url`}>URL</FieldLabel>
				<Input
					id={`${s.key}-url`}
					spellCheck={false}
					disabled={disabled}
					placeholder="https://example.com/hooks/mailroom"
					value={s.url}
					onChange={(e) => setStep({ url: e.target.value })}
				/>
				<FieldDescription>
					Mailroom posts JSON with the contact, their properties and the event's data. An
					answer other than 2xx stops the run as failed.
				</FieldDescription>
			</Field>
		);
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
						items={data.segments.filter((x) => !x.live || x.id === s.segment_id)}
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
				<Field>
					<FieldLabel htmlFor="a-goal">Goal</FieldLabel>
					<EventInput
						id="a-goal"
						disabled={disabled}
						value={form.goal_event}
						onChange={(v) => set("goal_event", v)}
						events={data.events}
						placeholder="purchase (optional)"
					/>
					<FieldDescription>
						When the contact does this event, they've reached the goal: their run ends
						and it counts as a conversion.
					</FieldDescription>
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
