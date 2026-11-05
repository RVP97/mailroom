import {
	AlarmClock,
	Bot,
	Check,
	ChevronDown,
	Clock,
	Flag,
	Plus,
	Star,
	Tag,
	User,
	UserMinus,
	UserRound,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { DateTimePicker } from "@/components/date-picker";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
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
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatAgo, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/*
 * The pieces a conversation is triaged with, on its page and in the list: who has it, its
 * priority, its tags, a snooze, its SLA and its rating. Each control calls `onChange` with a
 * patch for updateConversationFn; the page saves it.
 */

export type Person = { reader: string; name: string; type: "person" | "agent" };
export type Holder = {
	reader: string;
	name: string;
	type: "person" | "agent";
	until: string | null;
} | null;
export type InboxTag = { name: string; color: string };
export type Priority = "urgent" | "high" | "normal" | "low";

// ── Tags ───────────────────────────────────────────────────────────────────

/** The colors a tag can have, as a dot and a chip. */
export const TAG_COLORS: Record<string, { dot: string; chip: string; label: string }> = {
	gray: {
		label: "Gray",
		dot: "bg-zinc-400",
		chip: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
	},
	red: { label: "Red", dot: "bg-red-500", chip: "bg-red-500/10 text-red-700 dark:text-red-300" },
	orange: {
		label: "Orange",
		dot: "bg-orange-500",
		chip: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
	},
	amber: {
		label: "Amber",
		dot: "bg-amber-500",
		chip: "bg-amber-500/12 text-amber-800 dark:text-amber-300",
	},
	green: {
		label: "Green",
		dot: "bg-emerald-500",
		chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
	},
	teal: {
		label: "Teal",
		dot: "bg-teal-500",
		chip: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
	},
	blue: {
		label: "Blue",
		dot: "bg-blue-500",
		chip: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
	},
	violet: {
		label: "Violet",
		dot: "bg-violet-500",
		chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
	},
	pink: {
		label: "Pink",
		dot: "bg-pink-500",
		chip: "bg-pink-500/10 text-pink-700 dark:text-pink-300",
	},
};

const colorOf = (tag: string, catalog: InboxTag[]) =>
	TAG_COLORS[catalog.find((t) => t.name === tag)?.color ?? "gray"] ?? TAG_COLORS.gray;

export function TagChip({
	tag,
	catalog,
	className,
}: {
	tag: string;
	catalog: InboxTag[];
	className?: string;
}) {
	const c = colorOf(tag, catalog);
	// Drawn like a gray StatusBadge: the tag's color is only its dot.
	return (
		<span
			className={cn(
				"inline-flex h-5 max-w-40 shrink-0 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-xs font-medium text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]",
				className,
			)}
		>
			<span className={cn("size-1.5 shrink-0 rounded-full", c?.dot)} />
			<span className="truncate">{tag}</span>
		</span>
	);
}

/** Tags picked from the inbox's list, or new ones typed in. */
export function TagsMenu({
	tags,
	catalog,
	disabled,
	onChange,
}: {
	tags: string[];
	catalog: InboxTag[];
	disabled?: boolean;
	onChange: (tags: string[]) => void;
}) {
	const [q, setQ] = useState("");
	const known = [...new Set([...catalog.map((t) => t.name), ...tags])];
	const shown = known.filter((t) => t.toLowerCase().includes(q.trim().toLowerCase()));
	const typed = q.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
	const toggle = (t: string) =>
		onChange(tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
				>
					{tags.length ? (
						<span className="flex -space-x-0.5">
							{tags.slice(0, 3).map((t) => (
								<span
									key={t}
									className={cn(
										"size-2 rounded-full ring-2 ring-background",
										colorOf(t, catalog)?.dot,
									)}
								/>
							))}
						</span>
					) : (
						<Tag />
					)}
					<span
						className="max-w-40 truncate"
						title={tags.length ? tags.join(", ") : undefined}
					>
						{tags.length ? tags.join(", ") : "Tag"}
					</span>
					<ChevronDown className="opacity-60" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-64 p-2"
			>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						if (typed && !tags.includes(typed)) onChange([...tags, typed]);
						setQ("");
					}}
				>
					<Input
						autoFocus
						value={q}
						placeholder="Find or add a tag"
						className="h-8"
						onChange={(e) => setQ(e.target.value)}
					/>
				</form>
				<ul className="mt-2 flex max-h-64 flex-col overflow-y-auto">
					{shown.map((t) => (
						<li key={t}>
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
								onClick={() => toggle(t)}
							>
								<span
									className={cn(
										"size-2 shrink-0 rounded-full",
										colorOf(t, catalog)?.dot,
									)}
								/>
								<span className="min-w-0 flex-1 truncate">{t}</span>
								{tags.includes(t) && <Check className="size-4 text-brand" />}
							</button>
						</li>
					))}
					{typed && !known.includes(typed) && (
						<li>
							<button
								type="button"
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
								onClick={() => {
									onChange([...tags, typed]);
									setQ("");
								}}
							>
								<Plus className="size-4 text-muted-foreground" />
								Add “{typed}”
							</button>
						</li>
					)}
					{!shown.length && !typed && (
						<li className="px-2 py-1.5 text-sm text-muted-foreground">
							Type a tag to add it. The inbox's workflow settings keep a list with
							colors.
						</li>
					)}
				</ul>
			</PopoverContent>
		</Popover>
	);
}

// ── Priority ───────────────────────────────────────────────────────────────

export const PRIORITY: Record<Priority, { label: string; icon: string; text: string }> = {
	urgent: { label: "Urgent", icon: "text-destructive", text: "text-destructive" },
	high: { label: "High", icon: "text-warning", text: "text-foreground" },
	normal: { label: "Normal", icon: "text-muted-foreground", text: "text-muted-foreground" },
	low: { label: "Low", icon: "text-faint", text: "text-muted-foreground" },
};

export function PriorityFlag({ priority, label }: { priority: Priority; label?: boolean }) {
	if (priority === "normal" && !label) return null;
	const p = PRIORITY[priority];
	return (
		<span
			className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", p.text)}
			title={`${p.label} priority`}
		>
			<Flag className={cn("size-3.5", p.icon)} />
			{label !== false && p.label}
		</span>
	);
}

export function PriorityMenu({
	priority,
	disabled,
	onChange,
}: {
	priority: Priority;
	disabled?: boolean;
	onChange: (p: Priority) => void;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
				>
					<Flag className={PRIORITY[priority].icon} />
					{PRIORITY[priority].label}
					<ChevronDown className="opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start">
				<DropdownMenuLabel>Priority</DropdownMenuLabel>
				<DropdownMenuRadioGroup
					value={priority}
					onValueChange={(v) => onChange(v as Priority)}
				>
					{(Object.keys(PRIORITY) as Priority[]).map((p) => (
						<DropdownMenuRadioItem
							key={p}
							value={p}
						>
							<Flag className={PRIORITY[p].icon} />
							{PRIORITY[p].label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ── Who has it ─────────────────────────────────────────────────────────────

const initials = (name: string) =>
	name
		.replace(/<.*>/, "")
		.trim()
		.split(/[\s@._-]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase())
		.join("") || "?";

export function Avatar({
	name,
	agent,
	className,
}: {
	name: string;
	agent?: boolean;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
				agent ? "bg-brand/12 text-brand" : "bg-muted text-foreground",
				className,
			)}
		>
			{agent ? <Bot className="size-3" /> : initials(name)}
		</span>
	);
}

export function AssigneeMenu({
	holder,
	people,
	me,
	disabled,
	onChange,
}: {
	holder: Holder;
	people: Person[];
	me: string;
	disabled?: boolean;
	onChange: (reader: string | null) => void;
}) {
	const persons = people.filter((p) => p.type === "person");
	const agents = people.filter((p) => p.type === "agent");
	const claim = holder?.type === "agent" && holder.until;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					title={
						claim
							? `An agent is working on it until ${formatDateTime(holder.until)}`
							: undefined
					}
				>
					{holder ? (
						<Avatar
							name={holder.name}
							agent={holder.type === "agent"}
							className="-ml-0.5"
						/>
					) : (
						<UserRound />
					)}
					<span className="max-w-36 truncate">
						{holder ? (holder.reader === me ? "You" : holder.name) : "Unassigned"}
					</span>
					{claim && <span className="text-xs text-muted-foreground">working</span>}
					<ChevronDown className="opacity-60" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="max-h-80 w-60"
			>
				{holder?.reader !== me && (
					<DropdownMenuItem onSelect={() => onChange(me)}>
						<User />
						Take it
					</DropdownMenuItem>
				)}
				{holder && (
					<DropdownMenuItem onSelect={() => onChange(null)}>
						<UserMinus />
						Unassign
					</DropdownMenuItem>
				)}
				{persons.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>People</DropdownMenuLabel>
						{persons.map((p) => (
							<DropdownMenuItem
								key={p.reader}
								onSelect={() => onChange(p.reader)}
							>
								<Avatar name={p.name} />
								<span className="min-w-0 flex-1 truncate">
									{p.name}
									{p.reader === me && (
										<span className="text-muted-foreground"> (you)</span>
									)}
								</span>
								{holder?.reader === p.reader && <Check className="text-brand" />}
							</DropdownMenuItem>
						))}
					</>
				)}
				{agents.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Agents</DropdownMenuLabel>
						{agents.map((p) => (
							<DropdownMenuItem
								key={p.reader}
								onSelect={() => onChange(p.reader)}
							>
								<Avatar
									name={p.name}
									agent
								/>
								<span className="min-w-0 flex-1 truncate">{p.name}</span>
								{holder?.reader === p.reader && <Check className="text-brand" />}
							</DropdownMenuItem>
						))}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// ── Snooze ─────────────────────────────────────────────────────────────────

const at = (d: Date, h: number) => {
	const x = new Date(d);
	x.setHours(h, 0, 0, 0);
	return x;
};

/** Later today, tomorrow morning, Monday morning, in a week: local times. */
export function snoozePresets(now = new Date()) {
	const tomorrow = at(new Date(now.getTime() + 86_400_000), 9);
	const monday = at(new Date(now), 9);
	monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
	const week = at(new Date(now.getTime() + 7 * 86_400_000), 9);
	const later = new Date(now.getTime() + 3 * 3_600_000);
	later.setMinutes(0, 0, 0);
	return [
		{ label: "Later today", hint: "in 3 hours", at: later },
		{ label: "Tomorrow", hint: "9:00", at: tomorrow },
		{ label: "Monday", hint: "9:00", at: monday },
		{ label: "Next week", hint: "9:00", at: week },
	];
}

const short = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "numeric",
	minute: "2-digit",
});

const pad = (n: number) => String(n).padStart(2, "0");
const localValue = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A moment picked in a dialog (local time), for a snooze or a reply sent later. */
export function PickMoment({
	open,
	onOpenChange,
	title,
	description,
	action,
	onPick,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description: string;
	action: string;
	onPick: (at: Date) => void;
}) {
	const [value, setValue] = useState(() => localValue(at(new Date(Date.now() + 86_400_000), 9)));
	const min = localValue(new Date());
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DateTimePicker
					value={value}
					min={min}
					onChange={setValue}
				/>
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						disabled={!value || value < min}
						onClick={() => {
							onPick(new Date(value));
							onOpenChange(false);
						}}
					>
						{action}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SnoozeMenu({
	until,
	disabled,
	onChange,
}: {
	until: string | null;
	disabled?: boolean;
	onChange: (until: string | null) => void;
}) {
	const [picking, setPicking] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={disabled}
					>
						<AlarmClock />
						{until ? `Until ${short.format(new Date(until))}` : "Snooze"}
						<ChevronDown className="opacity-60" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="w-56"
				>
					<DropdownMenuLabel>Hide it until…</DropdownMenuLabel>
					{snoozePresets().map((p) => (
						<DropdownMenuItem
							key={p.label}
							onSelect={() => onChange(p.at.toISOString())}
						>
							<span className="flex-1">{p.label}</span>
							<span className="text-xs text-muted-foreground">
								{short.format(p.at)}
							</span>
						</DropdownMenuItem>
					))}
					<DropdownMenuItem onSelect={() => setPicking(true)}>
						Pick a time…
					</DropdownMenuItem>
					{until && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => onChange(null)}>
								Wake it now
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<PickMoment
				open={picking}
				onOpenChange={setPicking}
				title="Snooze until"
				description="It leaves the open list and comes back, unread, at this time. A new message from them brings it back sooner."
				action="Snooze"
				onPick={(d) => onChange(d.toISOString())}
			/>
		</>
	);
}

// ── SLA and rating ─────────────────────────────────────────────────────────

export type Sla = {
	reply_due_at: string | null;
	resolve_due_at: string | null;
	breached: ("reply" | "resolve")[];
};

/** The next SLA promise: when a reply (or resolving it) is due, or that it was missed. */
export function slaState(sla: Sla, status: string, now = Date.now()) {
	if (status === "resolved") return null;
	const due = sla.reply_due_at ?? sla.resolve_due_at;
	const kind = sla.reply_due_at ? "Reply" : "Resolve";
	if (!due) return sla.breached.length ? { tone: "red" as const, text: "SLA missed", due } : null;
	const left = Date.parse(due) - now;
	if (left <= 0)
		return { tone: "red" as const, text: `${kind} overdue ${formatAgo(due, now)}`, due };
	return {
		tone: left < 3_600_000 ? ("amber" as const) : ("gray" as const),
		text: `${kind} due ${formatAgo(due, now)}`,
		due,
	};
}

export function SlaBadge({
	sla,
	status,
	className,
}: {
	sla: Sla;
	status: string;
	className?: string;
}) {
	const s = slaState(sla, status);
	if (!s) return null;
	return (
		<span
			title={s.due ? formatDateTime(s.due) : undefined}
			className="inline-flex"
		>
			<StatusBadge
				status={s.tone === "red" ? "overdue" : s.tone === "amber" ? "due_soon" : "due"}
				label={s.text}
				className={cn("tabular-nums", className)}
			/>
		</span>
	);
}

/** When it's due, as quiet text for a list row: colored only once it's close or late. */
export function SlaText({ sla, status }: { sla: Sla; status: string }) {
	const s = slaState(sla, status);
	if (!s) return null;
	return (
		<span
			title={s.due ? formatDateTime(s.due) : undefined}
			className={cn(
				"inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums",
				s.tone === "red"
					? "font-medium text-destructive"
					: s.tone === "amber"
						? "font-medium text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]"
						: "text-muted-foreground",
			)}
		>
			<Clock className="size-3" />
			{s.text
				.replace(/^Reply due /, "Due ")
				.replace(/^Resolve due /, "Resolve ")
				.replace(/^\w+ overdue /, "Overdue ")}
		</span>
	);
}

export function Stars({ rating, className }: { rating: number; className?: string }) {
	return (
		<span
			className={cn("inline-flex items-center gap-0.5", className)}
			title={`${rating} of 5`}
		>
			{[1, 2, 3, 4, 5].map((n) => (
				<Star
					key={n}
					className={cn(
						"size-3.5",
						n <= rating ? "fill-warning text-warning" : "text-border-strong",
					)}
				/>
			))}
		</span>
	);
}

/** A row of controls that wraps. */
export function TriageBar({ children }: { children: ReactNode }) {
	return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
