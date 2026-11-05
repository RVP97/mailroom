import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowDown,
	ArrowUp,
	Clock,
	MoreHorizontal,
	Plus,
	ShieldAlert,
	Smile,
	Tag,
	Trash2,
	Users,
	Workflow,
	X,
	Zap,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ChoiceCards } from "@/components/choice-cards";
import { Confirm } from "@/components/confirm";
import { Avatar, PRIORITY, type Priority, TAG_COLORS, TagChip } from "@/components/inbox-triage";
import { Page } from "@/components/page";
import { RecordHeader, Stamp } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
	deleteRuleFn,
	getWorkflowFn,
	orderRulesFn,
	saveRuleFn,
	saveWorkflowFn,
} from "@/functions/workflow";
import { errorMessage } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { DEFAULT_INBOX_SETTINGS } from "@/lib/inbox-settings";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { VARIABLES } from "@/lib/reply-variables";
import { Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** An agent inbox's workflow: who gets new conversations, the service levels it promises, the
 * rating survey, how replies go out, its tags, and the rules run on every message in. */
export const Route = createFileRoute("/_app/received/workflow/$id")({
	loader: ({ params }) => getWorkflowFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.inbox.name ?? "Inbox"} workflow · Mailroom` }],
	}),
	component: WorkflowPage,
	pendingComponent: WorkflowSketch,
});

type Data = Awaited<ReturnType<typeof getWorkflowFn>>;
type Settings = Data["settings"];
type Rule = Data["rules"][number];

function WorkflowSketch() {
	const data: Data = {
		inbox: {
			object: "inbox",
			id: "",
			brand_id: "",
			name: "Support",
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
		settings: DEFAULT_INBOX_SETTINGS,
		rules: [],
		people: [],
		saved: [],
		brand: null,
		timezone: "UTC",
		catalog: { fields: [], ops: [], actions: [] },
	};
	return (
		<Sketch data={data}>
			<WorkflowPage />
		</Sketch>
	);
}

const TABS = ["assignment", "sla", "csat", "replies", "tags", "rules"] as const;

function WorkflowPage() {
	const { data } = usePage(Route);
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	const [v, setV] = useState<Settings>(data.settings);
	const [saved, setSaved] = useState(() => JSON.stringify(data.settings));
	const [busy, setBusy] = useState(false);
	const [tab, setTab] = useState<(typeof TABS)[number]>("assignment");
	const dirty = JSON.stringify(v) !== saved;
	const set = <K extends keyof Settings>(k: K, x: Settings[K]) => setV((s) => ({ ...s, [k]: x }));
	const save = async () => {
		setBusy(true);
		try {
			const next = await saveWorkflowFn({ data: { id: data.inbox.id, settings: v } });
			setV(next);
			setSaved(JSON.stringify(next));
			toast.success("Workflow saved");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/received/inboxes"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Agent inboxes
					</Link>
					<span aria-hidden="true"> / </span>
					<Link
						to="/received/inboxes/$id"
						params={{ id: data.inbox.id }}
						className="rounded-sm transition-colors hover:text-foreground"
					>
						{data.inbox.name}
					</Link>
				</nav>
				<RecordHeader
					icon={Workflow}
					tone="brand"
					kind={`Workflow of ${data.inbox.address}`}
					title={data.inbox.name}
					actions={
						tab !== "rules" && (
							<>
								<span className="hidden text-xs text-muted-foreground md:inline">
									{dirty ? "Unsaved changes" : "All changes saved"}
								</span>
								<Button
									disabled={busy || !dirty || !canManage}
									onClick={save}
								>
									{busy && <Spinner />}
									Save
								</Button>
							</>
						)
					}
				/>
			</div>
			<Tabs
				value={tab}
				onValueChange={(t) => setTab(t as (typeof TABS)[number])}
				className="gap-6"
			>
				<div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
					<TabsList variant="line">
						<TabsTrigger value="assignment">
							<Users />
							Assignment
						</TabsTrigger>
						<TabsTrigger value="sla">
							<Clock />
							Service levels
						</TabsTrigger>
						<TabsTrigger value="csat">
							<Smile />
							Ratings
						</TabsTrigger>
						<TabsTrigger value="replies">
							<ShieldAlert />
							Replies and safety
						</TabsTrigger>
						<TabsTrigger value="tags">
							<Tag />
							Tags
						</TabsTrigger>
						<TabsTrigger value="rules">
							<Zap />
							Rules
							{data.rules.length > 0 && (
								<span className="text-xs text-muted-foreground tabular-nums">
									{data.rules.length}
								</span>
							)}
						</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="assignment">
					<Assignment
						v={v}
						set={set}
						people={data.people}
					/>
				</TabsContent>
				<TabsContent value="sla">
					<Sla
						v={v}
						set={set}
						timezone={data.timezone}
					/>
				</TabsContent>
				<TabsContent value="csat">
					<Csat
						v={v}
						set={set}
						brand={data.brand?.name ?? data.inbox.name}
					/>
				</TabsContent>
				<TabsContent value="replies">
					<Replies
						v={v}
						set={set}
					/>
				</TabsContent>
				<TabsContent value="tags">
					<Tags
						v={v}
						set={set}
					/>
				</TabsContent>
				<TabsContent value="rules">
					<Rules
						data={data}
						canManage={canManage}
					/>
				</TabsContent>
			</Tabs>
		</Page>
	);
}

type Panel = {
	v: Settings;
	set: <K extends keyof Settings>(k: K, x: Settings[K]) => void;
};

/** A group of settings: what it is on the left, the controls on the right (stacked on phones). */
function Group({
	title,
	description,
	children,
}: {
	title: ReactNode;
	description: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="grid gap-4 border-b border-border/70 pb-8 last:border-0 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] md:gap-10">
			<div>
				<h2 className="text-base font-semibold">{title}</h2>
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			</div>
			<div className="flex min-w-0 flex-col gap-4">{children}</div>
		</section>
	);
}

function Toggle({
	id,
	label,
	description,
	checked,
	onChange,
}: {
	id: string;
	label: ReactNode;
	description?: ReactNode;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<div className="flex items-start justify-between gap-4">
			<div>
				<label
					htmlFor={id}
					className="text-sm font-medium"
				>
					{label}
				</label>
				{description && <p className="text-sm text-muted-foreground">{description}</p>}
			</div>
			<Switch
				id={id}
				checked={checked}
				onCheckedChange={onChange}
			/>
		</div>
	);
}

// ── Assignment ─────────────────────────────────────────────────────────────

function Assignment({ v, set, people }: Panel & { people: Data["people"] }) {
	const a = v.assignment;
	const members = new Set(a.members);
	const toggle = (reader: string) =>
		set("assignment", {
			...a,
			members: members.has(reader)
				? a.members.filter((m) => m !== reader)
				: [...a.members, reader],
		});
	return (
		<div className="flex flex-col gap-8">
			<Group
				title="New conversations"
				description="Who a conversation goes to when it starts. Rules can still assign it, and anyone can take one."
			>
				<ChoiceCards
					name="assignment"
					value={a.mode}
					onChange={(mode) => set("assignment", { ...a, mode })}
					options={[
						{
							value: "manual",
							title: "Nobody until someone takes it",
							description:
								"They wait in Unassigned. Anyone takes one, or gives it to someone.",
						},
						{
							value: "round_robin",
							title: "Round robin",
							description: "Each new one goes to the next person (or agent) in turn.",
						},
					]}
				/>
				{a.mode === "round_robin" && (
					<Card className="gap-0 divide-y px-0 py-0">
						{people.length === 0 && (
							<p className="px-4 py-3 text-sm text-muted-foreground">
								Nobody to take turns yet: invite your team, or give an agent a
								credential.
							</p>
						)}
						{people.map((p) => (
							<div
								key={p.reader}
								className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/40"
							>
								<Checkbox
									id={`member-${p.reader}`}
									checked={members.has(p.reader)}
									onCheckedChange={() => toggle(p.reader)}
								/>
								<Avatar
									name={p.name}
									agent={p.type === "agent"}
								/>
								<label
									htmlFor={`member-${p.reader}`}
									className="min-w-0 flex-1 cursor-pointer truncate"
								>
									{p.name}
								</label>
								<span className="text-xs text-muted-foreground">
									{p.type === "agent" ? "Agent" : "Person"}
									{a.last === p.reader && " · had the last one"}
								</span>
							</div>
						))}
					</Card>
				)}
				{a.mode === "round_robin" && (
					<Field className="max-w-xs">
						<FieldLabel htmlFor="max-open">Skip whoever has this many open</FieldLabel>
						<Input
							id="max-open"
							type="number"
							min={1}
							placeholder="No limit"
							value={a.max_open ?? ""}
							onChange={(e) =>
								set("assignment", {
									...a,
									max_open: e.target.value
										? Math.max(1, Number(e.target.value))
										: null,
								})
							}
						/>
						<FieldDescription>
							When everyone is at the limit, it waits in Unassigned.
						</FieldDescription>
					</Field>
				)}
			</Group>
			<Group
				title="Agents working on one"
				description="An agent claims a conversation while it works on it, so two never answer the same person. Other agents get a 409 until the claim ends; people see who's on it."
			>
				<Field className="max-w-xs">
					<FieldLabel htmlFor="claim">A claim lasts</FieldLabel>
					<Select
						value={String(v.claim_minutes)}
						onValueChange={(m) => set("claim_minutes", Number(m))}
					>
						<SelectTrigger id="claim">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[5, 10, 15, 30, 60, 120].map((m) => (
								<SelectItem
									key={m}
									value={String(m)}
								>
									{m < 60
										? `${m} minutes`
										: `${m / 60} ${m === 60 ? "hour" : "hours"}`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>It can renew it, or let go sooner.</FieldDescription>
				</Field>
			</Group>
		</div>
	);
}

// ── Service levels ─────────────────────────────────────────────────────────

const UNITS = [
	{ value: "m", label: "minutes", factor: 1 },
	{ value: "h", label: "hours", factor: 60 },
	{ value: "d", label: "days", factor: 60 * 24 },
] as const;

/** Minutes as a number and a unit (the largest that divides it), or empty for no target. */
function Duration({
	id,
	value,
	onChange,
}: {
	id: string;
	value: number | null;
	onChange: (v: number | null) => void;
}) {
	const best =
		value === null
			? UNITS[1]
			: ([...UNITS].reverse().find((u) => value % u.factor === 0) ?? UNITS[0]);
	const [unit, setUnit] = useState<(typeof UNITS)[number]>(best);
	const shown = value === null ? "" : String(+(value / unit.factor).toFixed(2));
	return (
		<div className="flex">
			<Input
				id={id}
				type="number"
				min={0}
				step="any"
				placeholder="None"
				className="w-20 rounded-r-none"
				value={shown}
				onChange={(e) =>
					onChange(
						e.target.value === ""
							? null
							: Math.max(1, Math.round(Number(e.target.value) * unit.factor)),
					)
				}
			/>
			<Select
				value={unit.value}
				onValueChange={(u) => {
					const next = UNITS.find((x) => x.value === u) ?? UNITS[0];
					setUnit(next);
					if (value !== null)
						onChange(Math.max(1, Math.round((value / unit.factor) * next.factor)));
				}}
			>
				<SelectTrigger
					aria-label="Unit"
					className="w-28 rounded-l-none border-l-0"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{UNITS.map((u) => (
						<SelectItem
							key={u.value}
							value={u.value}
						>
							{u.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Sla({ v, set, timezone }: Panel & { timezone: string }) {
	const s = v.sla;
	const hours = s.business_hours;
	const patch = (x: Partial<Settings["sla"]>) => set("sla", { ...s, ...x });
	return (
		<div className="flex flex-col gap-8">
			<Group
				title="Service levels"
				description="How soon you promise a reply, and to resolve, by priority. Conversations show when each is due; the Overdue view and the report show what slipped."
			>
				<Toggle
					id="sla-on"
					label="Keep service levels"
					description="Due times start when a conversation arrives, and again each time they write after you replied."
					checked={s.enabled}
					onChange={(enabled) => patch({ enabled })}
				/>
				<Card className={cn("gap-0 px-0 py-0", !s.enabled && "opacity-60")}>
					<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-3 px-4 py-3 text-sm">
						<span className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
							Priority
						</span>
						<span className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
							First reply within
						</span>
						<span className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
							Resolved within
						</span>
						{(Object.keys(PRIORITY) as Priority[]).map((p) => (
							<SlaRow
								key={p}
								p={p}
								target={s.targets[p] ?? { reply: null, resolve: null }}
								onChange={(t) => patch({ targets: { ...s.targets, [p]: t } })}
							/>
						))}
					</div>
				</Card>
			</Group>
			<Group
				title="Business hours"
				description="Only these hours count toward a due time, so a message on Friday night isn't late by Monday morning."
			>
				<Toggle
					id="hours-on"
					label="Count business hours only"
					checked={!!hours}
					onChange={(on) =>
						patch({
							business_hours: on
								? { timezone, days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" }
								: null,
						})
					}
				/>
				{hours && (
					<>
						<ToggleGroup
							type="multiple"
							variant="outline"
							value={hours.days.map(String)}
							onValueChange={(days) =>
								patch({
									business_hours: { ...hours, days: days.map(Number).sort() },
								})
							}
						>
							{DAYS.map((d, i) => (
								<ToggleGroupItem
									key={d}
									value={String(i)}
									aria-label={d}
								>
									{d}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<div className="grid gap-3 sm:grid-cols-3">
							<Field>
								<FieldLabel htmlFor="h-start">From</FieldLabel>
								<Input
									id="h-start"
									type="time"
									step={900}
									value={hours.start}
									onChange={(e) =>
										patch({
											business_hours: { ...hours, start: e.target.value },
										})
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="h-end">To</FieldLabel>
								<Input
									id="h-end"
									type="time"
									step={900}
									value={hours.end}
									onChange={(e) =>
										patch({ business_hours: { ...hours, end: e.target.value } })
									}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="h-tz">Time zone</FieldLabel>
								<Input
									id="h-tz"
									list="time-zones"
									value={hours.timezone}
									onChange={(e) =>
										patch({
											business_hours: { ...hours, timezone: e.target.value },
										})
									}
								/>
								<datalist id="time-zones">
									{zones().map((z) => (
										<option
											key={z}
											value={z}
										/>
									))}
								</datalist>
							</Field>
						</div>
					</>
				)}
			</Group>
			<Group
				title="Warnings"
				description="Before a reply is due: the inbox's webhooks get inbox.sla.warning, and these people an email. When one is missed, inbox.sla.breached."
			>
				<Field className="max-w-xs">
					<FieldLabel htmlFor="warn">Warn before it's due</FieldLabel>
					<Duration
						id="warn"
						value={s.warn_minutes || null}
						onChange={(m) => patch({ warn_minutes: m ?? 0 })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="notify">Email</FieldLabel>
					<Input
						id="notify"
						placeholder="lead@your-domain.com, desk@your-domain.com"
						value={s.notify.join(", ")}
						onChange={(e) =>
							patch({
								notify: e.target.value
									.split(/[,\s]+/)
									.map((x) => x.trim())
									.filter(Boolean),
							})
						}
					/>
					<FieldDescription>
						Optional. Whoever has the conversation is emailed too.
					</FieldDescription>
				</Field>
			</Group>
		</div>
	);
}

function SlaRow({
	p,
	target,
	onChange,
}: {
	p: Priority;
	target: { reply: number | null; resolve: number | null };
	onChange: (t: { reply: number | null; resolve: number | null }) => void;
}) {
	return (
		<>
			<span className={cn("flex items-center gap-2 font-medium", PRIORITY[p].text)}>
				{PRIORITY[p].label}
			</span>
			<Duration
				id={`reply-${p}`}
				value={target.reply}
				onChange={(reply) => onChange({ ...target, reply })}
			/>
			<Duration
				id={`resolve-${p}`}
				value={target.resolve}
				onChange={(resolve) => onChange({ ...target, resolve })}
			/>
		</>
	);
}

const zones = () => {
	try {
		return (
			(Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
				"timeZone",
			) ?? ["UTC"]
		);
	} catch {
		return ["UTC"];
	}
};

// ── Ratings ────────────────────────────────────────────────────────────────

const FACES = ["😞", "🙁", "😐", "🙂", "😄"];

function Csat({ v, set, brand }: Panel & { brand: string }) {
	const c = v.csat;
	const patch = (x: Partial<Settings["csat"]>) => set("csat", { ...c, ...x });
	return (
		<div className="flex flex-col gap-8">
			<Group
				title="Ask how it went"
				description="After a conversation is resolved, they get one short email: five faces, one click. A rating shows on the conversation, in the report, and goes to webhooks as inbox.csat.received."
			>
				<Toggle
					id="csat-on"
					label="Send the survey"
					description="Never to automatic senders, and once per conversation."
					checked={c.enabled}
					onChange={(enabled) => patch({ enabled })}
				/>
				<Field>
					<FieldLabel htmlFor="csat-q">The question</FieldLabel>
					<Input
						id="csat-q"
						maxLength={200}
						value={c.question}
						onChange={(e) => patch({ question: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="csat-t">After they answer</FieldLabel>
					<Input
						id="csat-t"
						maxLength={400}
						value={c.thanks}
						onChange={(e) => patch({ thanks: e.target.value })}
					/>
				</Field>
				<Field className="max-w-xs">
					<FieldLabel htmlFor="csat-d">Wait after resolving</FieldLabel>
					<Duration
						id="csat-d"
						value={c.delay_minutes}
						onChange={(m) => patch({ delay_minutes: m ?? 10 })}
					/>
					<FieldDescription>
						Reopening it within this time sends nothing.
					</FieldDescription>
				</Field>
			</Group>
			<Group
				title="What they get"
				description="A preview of the email."
			>
				<Card className="items-center gap-4 px-6 py-8 text-center">
					<p className="text-xs text-muted-foreground">{brand}</p>
					<p className="text-lg font-semibold">{c.question || "How did we do?"}</p>
					<div className="flex gap-2">
						{FACES.map((f, i) => (
							<span
								key={f}
								className="flex size-11 items-center justify-center rounded-full bg-muted text-2xl"
								title={`${i + 1} of 5`}
							>
								{f}
							</span>
						))}
					</div>
					<p className="text-xs text-muted-foreground">
						One click is enough. A comment is optional.
					</p>
				</Card>
			</Group>
		</div>
	);
}

// ── Replies and safety ─────────────────────────────────────────────────────

function Replies({ v, set }: Panel) {
	return (
		<div className="flex flex-col gap-8">
			<Group
				title="Signature"
				description="Added under every reply from this inbox, by people and agents. A reply that already ends with it isn't signed twice."
			>
				<Textarea
					rows={4}
					aria-label="Signature"
					placeholder={"{{agent.first_name}}\nThe {{inbox.name}} team"}
					value={v.signature ?? ""}
					onChange={(e) => set("signature", e.target.value || null)}
				/>
				<p className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
					{VARIABLES.filter(
						(x) => x.key.startsWith("agent") || x.key.startsWith("inbox"),
					).map((x) => (
						<button
							key={x.key}
							type="button"
							className="rounded bg-muted px-1.5 py-0.5 font-mono hover:text-foreground"
							title={x.label}
							onClick={() => set("signature", `${v.signature ?? ""}{{${x.key}}}`)}
						>
							{`{{${x.key}}}`}
						</button>
					))}
				</p>
			</Group>
			<Group
				title="Undo send"
				description="A person's reply waits this long before it goes, so a slip can be called back. Agents' replies and replies sent later aren't held."
			>
				<ToggleGroup
					type="single"
					variant="outline"
					value={String(v.undo_seconds)}
					onValueChange={(s) => s && set("undo_seconds", Number(s))}
				>
					{[0, 5, 10, 20, 30].map((s) => (
						<ToggleGroupItem
							key={s}
							value={String(s)}
						>
							{s ? `${s} s` : "Off"}
						</ToggleGroupItem>
					))}
				</ToggleGroup>
			</Group>
			<Group
				title="Suspicious mail"
				description="Mail that fails its checks, spoofs a name, uses a lookalike domain, hides text or tries to give an agent instructions waits for a person. Agents don't see it until someone lets them."
			>
				<Toggle
					id="hold"
					label="Hold it for a person"
					description="Held conversations show in the Held view, with why."
					checked={v.hold_suspicious}
					onChange={(x) => set("hold_suspicious", x)}
				/>
			</Group>
		</div>
	);
}

// ── Tags ───────────────────────────────────────────────────────────────────

function Tags({ v, set }: Panel) {
	const [name, setName] = useState("");
	const clean = name.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
	const add = () => {
		if (!clean || v.tags.some((t) => t.name === clean)) return;
		const colors = Object.keys(TAG_COLORS);
		set("tags", [
			...v.tags,
			{ name: clean, color: colors[(v.tags.length + 1) % colors.length] ?? "gray" },
		]);
		setName("");
	};
	return (
		<Group
			title="Tags"
			description="The tags people pick from on a conversation, each with a color. Others can still be typed in; rules and agents can add them too."
		>
			<Card className="gap-0 divide-y px-0 py-0">
				{v.tags.length === 0 && (
					<p className="px-4 py-3 text-sm text-muted-foreground">
						No tags yet. Billing, bug, refund, vip…
					</p>
				)}
				{v.tags.map((t, i) => (
					<div
						key={t.name}
						className="flex items-center gap-3 px-4 py-2"
					>
						<TagChip
							tag={t.name}
							catalog={v.tags}
						/>
						<span className="flex-1" />
						<Select
							value={t.color}
							onValueChange={(color) =>
								set(
									"tags",
									v.tags.map((x, j) => (j === i ? { ...x, color } : x)),
								)
							}
						>
							<SelectTrigger
								aria-label={`Color of ${t.name}`}
								className="h-8 w-32"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Object.entries(TAG_COLORS).map(([k, c]) => (
									<SelectItem
										key={k}
										value={k}
									>
										<span className={cn("size-2 rounded-full", c.dot)} />
										{c.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Button
							size="icon"
							variant="ghost"
							aria-label={`Remove ${t.name}`}
							onClick={() =>
								set(
									"tags",
									v.tags.filter((_, j) => j !== i),
								)
							}
						>
							<X />
						</Button>
					</div>
				))}
			</Card>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					add();
				}}
			>
				<Input
					aria-label="New tag"
					placeholder="New tag"
					className="max-w-xs"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={!clean}
				>
					<Plus />
					Add
				</Button>
			</form>
			<p className="text-xs text-muted-foreground">
				Removing a tag here keeps it on conversations that have it.
			</p>
		</Group>
	);
}

// ── Rules ──────────────────────────────────────────────────────────────────

const FIELD_LABEL: Record<string, string> = {
	from: "From",
	from_domain: "Sender's domain",
	to: "To",
	subject: "Subject",
	body: "Message",
	has_attachments: "Has attachments",
	channel: "Channel",
	new_conversation: "Starts a conversation",
	suspicious: "Looks suspicious",
	business_hours: "Arrives in business hours",
};
const BOOLEAN_FIELDS = ["has_attachments", "new_conversation", "suspicious", "business_hours"];
const OP_LABEL: Record<string, string> = {
	contains: "contains",
	not_contains: "doesn't contain",
	is: "is",
	is_not: "isn't",
	starts_with: "starts with",
	ends_with: "ends with",
	matches: "matches the pattern",
};
const ACTION_LABEL: Record<string, string> = {
	add_tag: "Add tags",
	set_priority: "Set the priority",
	assign: "Assign to",
	round_robin: "Assign in turn (round robin)",
	snooze_hours: "Snooze for hours",
	resolve: "Resolve it",
	auto_reply: "Reply with a saved reply",
	note: "Leave a note",
	hold: "Hold it for a person",
	notify: "Email someone",
};

type Draft = {
	name: string;
	enabled: boolean;
	match: "all" | "any";
	conditions: { field: string; op: string; value: string }[];
	actions: { type: string; value: string }[];
	stop: boolean;
};

const draftOf = (r: Rule | null): Draft =>
	r
		? {
				name: r.name,
				enabled: r.enabled,
				match: r.match,
				conditions: r.conditions.map((c) => ({ ...c })),
				actions: r.actions.map((a) => ({
					type: a.type,
					value: a.value == null ? "" : String(a.value),
				})),
				stop: r.stop,
			}
		: {
				name: "",
				enabled: true,
				match: "all",
				conditions: [{ field: "subject", op: "contains", value: "" }],
				actions: [{ type: "add_tag", value: "" }],
				stop: false,
			};

function summary(r: Pick<Draft, "match" | "conditions" | "actions">, data: Data) {
	const when = r.conditions.length
		? r.conditions
				.map((c) =>
					BOOLEAN_FIELDS.includes(c.field)
						? `${c.value === "false" ? "not " : ""}${FIELD_LABEL[c.field]?.toLowerCase()}`
						: `${FIELD_LABEL[c.field]?.toLowerCase()} ${OP_LABEL[c.op]} “${c.value}”`,
				)
				.join(r.match === "any" ? " or " : " and ")
		: "every message";
	const does = r.actions
		.map((a) => {
			if (a.type === "assign")
				return `assign to ${data.people.find((p) => p.reader === a.value)?.name ?? "someone"}`;
			if (a.type === "auto_reply")
				return `reply “${data.saved.find((s) => s.id === a.value)?.name ?? "a saved reply"}”`;
			if (a.type === "set_priority") return `priority ${a.value}`;
			if (a.type === "add_tag") return `tag ${a.value}`;
			if (a.type === "snooze_hours") return `snooze ${a.value}h`;
			return ACTION_LABEL[a.type]?.toLowerCase() ?? a.type;
		})
		.join(", ");
	return `When ${when}: ${does}`;
}

function Rules({ data, canManage }: { data: Data; canManage: boolean }) {
	const router = useRouter();
	const [editing, setEditing] = useState<Rule | "new" | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const move = async (i: number, by: number) => {
		const ids = data.rules.map((r) => r.id);
		const [x] = ids.splice(i, 1);
		if (!x) return;
		ids.splice(i + by, 0, x);
		setBusy(x);
		try {
			await orderRulesFn({ data: { inbox: data.inbox.id, ids } });
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const toggle = async (r: Rule) => {
		setBusy(r.id);
		try {
			await saveRuleFn({
				data: {
					inbox: data.inbox.id,
					id: r.id,
					rule: { ...draftOf(r), enabled: !r.enabled },
				},
			});
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="text-base font-semibold">Rules</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Run on each message that comes in, in this order, after it joins its
						conversation. Each rule that matches runs, unless one says to stop.
					</p>
				</div>
				{canManage && data.rules.length > 0 && (
					<Button onClick={() => setEditing("new")}>
						<Plus />
						New rule
					</Button>
				)}
			</div>
			{data.rules.length === 0 ? (
				<Card>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Zap />
							</EmptyMedia>
							<EmptyTitle>No rules yet</EmptyTitle>
							<EmptyDescription>
								Tag invoices as billing, make anything with “urgent” urgent, give
								refunds to the right person, or answer outside business hours with a
								saved reply.
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
				</Card>
			) : (
				<Card className="gap-0 divide-y px-0 py-0">
					{data.rules.map((r, i) => (
						<div
							key={r.id}
							className="flex items-center gap-3 px-4 py-3"
						>
							<Stamp
								icon={Zap}
								tone={r.enabled ? "brand" : "gray"}
								className="size-8"
							/>
							<button
								type="button"
								disabled={!canManage}
								className="min-w-0 flex-1 text-left"
								onClick={() => setEditing(r)}
							>
								<span className="block truncate font-medium hover:underline">
									{r.name}
								</span>
								<span className="block truncate text-xs text-muted-foreground">
									{summary(draftOf(r), data)}
									{r.stop ? ". Then stop." : ""}
								</span>
							</button>
							<span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block">
								{r.matched ? `Matched ${r.matched}×` : "Not matched yet"}
								{r.last_matched_at && (
									<span className="block">
										last {formatAgo(r.last_matched_at)}
									</span>
								)}
							</span>
							<StatusBadge
								status={r.enabled ? "ready" : "paused"}
								label={r.enabled ? "On" : "Off"}
							/>
							{canManage && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											size="icon"
											variant="ghost"
											aria-label={`More for ${r.name}`}
											disabled={busy === r.id}
										>
											{busy === r.id ? <Spinner /> : <MoreHorizontal />}
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem onSelect={() => setEditing(r)}>
											Edit
										</DropdownMenuItem>
										<DropdownMenuItem onSelect={() => void toggle(r)}>
											{r.enabled ? "Turn off" : "Turn on"}
										</DropdownMenuItem>
										{i > 0 && (
											<DropdownMenuItem onSelect={() => void move(i, -1)}>
												<ArrowUp />
												Move up
											</DropdownMenuItem>
										)}
										{i < data.rules.length - 1 && (
											<DropdownMenuItem onSelect={() => void move(i, 1)}>
												<ArrowDown />
												Move down
											</DropdownMenuItem>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					))}
				</Card>
			)}
			<RuleDialog
				data={data}
				rule={editing}
				onClose={() => setEditing(null)}
			/>
		</div>
	);
}

function RuleDialog({
	data,
	rule,
	onClose,
}: {
	data: Data;
	rule: Rule | "new" | null;
	onClose: () => void;
}) {
	const router = useRouter();
	const existing = rule && rule !== "new" ? rule : null;
	const [d, setD] = useState<Draft>(() => draftOf(existing));
	const [for_, setFor] = useState<string | null>(null);
	const key = existing?.id ?? (rule === "new" ? "new" : null);
	if (key !== for_) {
		setFor(key);
		setD(draftOf(existing));
	}
	const [busy, setBusy] = useState(false);
	const patchCond = (i: number, x: Partial<Draft["conditions"][number]>) =>
		setD((s) => ({
			...s,
			conditions: s.conditions.map((c, j) => (j === i ? { ...c, ...x } : c)),
		}));
	const patchAction = (i: number, x: Partial<Draft["actions"][number]>) =>
		setD((s) => ({ ...s, actions: s.actions.map((a, j) => (j === i ? { ...a, ...x } : a)) }));
	const save = async () => {
		setBusy(true);
		try {
			await saveRuleFn({
				data: {
					inbox: data.inbox.id,
					id: existing?.id,
					rule: {
						...d,
						actions: d.actions.map((a) => ({
							type: a.type,
							value:
								a.type === "snooze_hours" ? Number(a.value) || 24 : a.value || null,
						})),
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
	};
	return (
		<Dialog
			open={!!rule}
			onOpenChange={(o) => !o && onClose()}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{existing ? "Edit the rule" : "New rule"}</DialogTitle>
					<DialogDescription>{summary(d, data)}</DialogDescription>
				</DialogHeader>
				<DialogBody className="flex flex-col gap-5">
					<datalist id="rule-tags">
						{data.settings.tags.map((t) => (
							<option
								key={t.name}
								value={t.name}
							/>
						))}
					</datalist>
					<Field>
						<FieldLabel htmlFor="r-name">Name</FieldLabel>
						<Input
							id="r-name"
							autoFocus
							placeholder="Invoices to billing"
							value={d.name}
							onChange={(e) => setD({ ...d, name: e.target.value })}
						/>
					</Field>
					<div className="flex flex-col gap-2">
						<div className="flex flex-wrap items-center gap-2 text-sm font-medium">
							When
							<Select
								value={d.match}
								onValueChange={(match) =>
									setD({ ...d, match: match as "all" | "any" })
								}
							>
								<SelectTrigger
									aria-label="Match"
									className="h-8 w-auto"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">all of these are true</SelectItem>
									<SelectItem value="any">any of these is true</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{d.conditions.map((c, i) => (
							<div
								key={i}
								className="flex flex-wrap items-center gap-2"
							>
								<Select
									value={c.field}
									onValueChange={(field) =>
										patchCond(i, {
											field,
											...(BOOLEAN_FIELDS.includes(field)
												? { op: "is", value: "true" }
												: {}),
											...(field === "channel"
												? { op: "is", value: "email" }
												: {}),
										})
									}
								>
									<SelectTrigger
										aria-label="Field"
										className="w-48"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{data.catalog.fields.map((f) => (
											<SelectItem
												key={f}
												value={f}
											>
												{FIELD_LABEL[f] ?? f}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{BOOLEAN_FIELDS.includes(c.field) ? (
									<Select
										value={c.value === "false" ? "false" : "true"}
										onValueChange={(value) => patchCond(i, { value })}
									>
										<SelectTrigger
											aria-label="Yes or no"
											className="w-28"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="true">Yes</SelectItem>
											<SelectItem value="false">No</SelectItem>
										</SelectContent>
									</Select>
								) : c.field === "channel" ? (
									<Select
										value={c.value || "email"}
										onValueChange={(value) => patchCond(i, { op: "is", value })}
									>
										<SelectTrigger
											aria-label="Channel"
											className="w-36"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="email">is email</SelectItem>
											<SelectItem value="chat">is website chat</SelectItem>
										</SelectContent>
									</Select>
								) : (
									<>
										<Select
											value={c.op}
											onValueChange={(op) => patchCond(i, { op })}
										>
											<SelectTrigger
												aria-label="How"
												className="w-44"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{data.catalog.ops.map((o) => (
													<SelectItem
														key={o}
														value={o}
													>
														{OP_LABEL[o] ?? o}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<Input
											aria-label="Value"
											className="min-w-40 flex-1"
											placeholder={
												c.op === "matches" ? "invoice|receipt" : "invoice"
											}
											value={c.value}
											onChange={(e) =>
												patchCond(i, { value: e.target.value })
											}
										/>
									</>
								)}
								<Button
									size="icon"
									variant="ghost"
									aria-label="Remove the condition"
									onClick={() =>
										setD({
											...d,
											conditions: d.conditions.filter((_, j) => j !== i),
										})
									}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						<Button
							variant="ghost"
							size="sm"
							className="w-fit"
							onClick={() =>
								setD({
									...d,
									conditions: [
										...d.conditions,
										{ field: "subject", op: "contains", value: "" },
									],
								})
							}
						>
							<Plus />
							Add a condition
						</Button>
						{d.conditions.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No conditions: every message.
							</p>
						)}
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-sm font-medium">Then</span>
						{d.actions.map((a, i) => (
							<div
								key={i}
								className="flex flex-wrap items-center gap-2"
							>
								<Select
									value={a.type}
									onValueChange={(type) =>
										patchAction(i, {
											type,
											value:
												type === "set_priority"
													? "high"
													: type === "snooze_hours"
														? "24"
														: "",
										})
									}
								>
									<SelectTrigger
										aria-label="Action"
										className="w-60"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{data.catalog.actions.map((x) => (
											<SelectItem
												key={x}
												value={x}
											>
												{ACTION_LABEL[x] ?? x}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<ActionValue
									a={a}
									data={data}
									onChange={(value) => patchAction(i, { value })}
								/>
								<Button
									size="icon"
									variant="ghost"
									aria-label="Remove the action"
									disabled={d.actions.length === 1}
									onClick={() =>
										setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })
									}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						<Button
							variant="ghost"
							size="sm"
							className="w-fit"
							onClick={() =>
								setD({
									...d,
									actions: [...d.actions, { type: "add_tag", value: "" }],
								})
							}
						>
							<Plus />
							Add an action
						</Button>
					</div>
					<Toggle
						id="r-stop"
						label="Stop here"
						description="Rules after this one don't run when it matches."
						checked={d.stop}
						onChange={(stop) => setD({ ...d, stop })}
					/>
					<Toggle
						id="r-on"
						label="On"
						checked={d.enabled}
						onChange={(enabled) => setD({ ...d, enabled })}
					/>
				</DialogBody>
				<DialogFooter className="sm:justify-between">
					{existing ? (
						<Confirm
							trigger={
								<Button variant="ghost">
									<Trash2 />
									Delete
								</Button>
							}
							title="Delete this rule?"
							description="Messages it matched are left as they are."
							action="Delete rule"
							onConfirm={async () => {
								try {
									await deleteRuleFn({
										data: { inbox: data.inbox.id, id: existing.id },
									});
									toast.success("Rule deleted");
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
							disabled={busy || !d.name.trim() || !d.actions.length}
							onClick={save}
						>
							{busy && <Spinner />}
							{existing ? "Save rule" : "Add rule"}
						</Button>
					</span>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function ActionValue({
	a,
	data,
	onChange,
}: {
	a: Draft["actions"][number];
	data: Data;
	onChange: (v: string) => void;
}) {
	switch (a.type) {
		case "set_priority":
			return (
				<Select
					value={a.value || "high"}
					onValueChange={onChange}
				>
					<SelectTrigger
						aria-label="Priority"
						className="w-36"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(Object.keys(PRIORITY) as Priority[]).map((p) => (
							<SelectItem
								key={p}
								value={p}
							>
								{PRIORITY[p].label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		case "assign":
			return (
				<Select
					value={a.value}
					onValueChange={onChange}
				>
					<SelectTrigger
						aria-label="Who"
						className="min-w-44 flex-1"
					>
						<SelectValue placeholder="Pick someone" />
					</SelectTrigger>
					<SelectContent>
						{data.people.map((p) => (
							<SelectItem
								key={p.reader}
								value={p.reader}
							>
								<Avatar
									name={p.name}
									agent={p.type === "agent"}
								/>
								{p.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			);
		case "auto_reply":
			return data.saved.length ? (
				<Select
					value={a.value}
					onValueChange={onChange}
				>
					<SelectTrigger
						aria-label="Saved reply"
						className="min-w-44 flex-1"
					>
						<SelectValue placeholder="Pick a saved reply" />
					</SelectTrigger>
					<SelectContent>
						{data.saved.map((s) => (
							<SelectItem
								key={s.id}
								value={s.id}
							>
								{s.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			) : (
				<Link
					to="/received/replies"
					className="text-sm text-brand underline-offset-2 hover:underline"
				>
					Write a saved reply first
				</Link>
			);
		case "snooze_hours":
			return (
				<Input
					aria-label="Hours"
					type="number"
					min={1}
					max={720}
					className="w-24"
					value={a.value}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		case "add_tag":
			return (
				<Input
					aria-label="Tags"
					className="min-w-40 flex-1"
					placeholder="billing, invoice"
					list="rule-tags"
					value={a.value}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		case "note":
			return (
				<Input
					aria-label="Note"
					className="min-w-40 flex-1"
					placeholder="Check the booking before answering"
					value={a.value}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		case "notify":
			return (
				<Input
					aria-label="Email"
					className="min-w-40 flex-1"
					placeholder="lead@your-domain.com"
					value={a.value}
					onChange={(e) => onChange(e.target.value)}
				/>
			);
		default:
			return null;
	}
}
