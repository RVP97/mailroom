import {
	CircleCheck,
	Clock,
	GitBranch,
	type LucideIcon,
	Mail,
	MailOpen,
	MousePointerClick,
	Plus,
	TagIcon,
	UserMinus,
	UserPlus,
	Users,
	Webhook,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Form, ListPath, Step, StepType, TriggerType } from "@/lib/automation-form";
import { stepNeeds, triggerNeeds } from "@/lib/automation-form";
import { cn } from "@/lib/utils";

/**
 * An automation drawn as a flow, as Kit's and Loops' builders: the trigger at the top, each step a
 * card, a condition splitting into its yes and no paths, and a + on every line to add a step there.
 */

export type Tone = { tile: string; ring: string };

const TONES = {
	trigger: { tile: "bg-amber-500/12 text-amber-600 dark:text-amber-400", ring: "ring-amber-500" },
	send: { tile: "bg-blue-500/12 text-blue-600 dark:text-blue-400", ring: "ring-blue-500" },
	wait: {
		tile: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
		ring: "ring-violet-500",
	},
	condition: {
		tile: "bg-orange-500/12 text-orange-600 dark:text-orange-400",
		ring: "ring-orange-500",
	},
	segment: {
		tile: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
		ring: "ring-emerald-500",
	},
	property: { tile: "bg-teal-500/12 text-teal-600 dark:text-teal-400", ring: "ring-teal-500" },
} satisfies Record<string, Tone>;

export const TRIGGER_ICON: Record<TriggerType, LucideIcon> = {
	"contact.created": UserPlus,
	"segment.joined": Users,
	event: Webhook,
	"email.opened": MailOpen,
	"email.clicked": MousePointerClick,
};

export function stepIcon(s: Pick<Step, "type" | "action">): LucideIcon {
	if (s.type === "segment") return s.action === "remove" ? UserMinus : UserPlus;
	return { wait: Clock, send: Mail, condition: GitBranch, property: TagIcon, segment: Users }[
		s.type
	];
}

export const stepTone = (t: StepType | "trigger"): Tone => TONES[t];

export const STEP_KINDS: {
	type: StepType;
	action?: "add" | "remove";
	label: string;
	hint: string;
}[] = [
	{ type: "send", label: "Send an email", hint: "A published template" },
	{ type: "wait", label: "Wait", hint: "Minutes, hours or days" },
	{ type: "condition", label: "If / else", hint: "Split into yes and no" },
	{ type: "segment", action: "add", label: "Add to a segment", hint: "Tag the contact" },
	{ type: "segment", action: "remove", label: "Remove from a segment", hint: "Untag them" },
	{ type: "property", label: "Set a property", hint: "Update the contact" },
];

type Props = {
	form: Form;
	selected: string | null;
	onSelect: (key: string | null) => void;
	onInsert: (at: ListPath, index: number, kind: (typeof STEP_KINDS)[number]) => void;
	/** Runs under way, by the place they're at (a step's index path, joined with "."). */
	here: Map<string, number>;
	describe: (s: Step) => { title: string; detail: string };
	trigger: { title: string; detail: string };
	editable: boolean;
};

export function AutomationCanvas(p: Props) {
	return (
		<div
			className="relative min-h-[560px] overflow-auto bg-muted/40 [background-image:radial-gradient(var(--border-strong)_1px,transparent_1px)] [background-size:18px_18px]"
			onClick={(e) => {
				if (e.target === e.currentTarget) p.onSelect(null);
			}}
			onKeyDown={(e) => {
				if (e.key === "Escape") p.onSelect(null);
			}}
			role="presentation"
		>
			<div
				className="mx-auto flex w-max min-w-full flex-col items-center px-8 pt-10 pb-16"
				onClick={(e) => {
					if (e.target === e.currentTarget) p.onSelect(null);
				}}
				role="presentation"
			>
				<Node
					eyebrow="Trigger"
					icon={TRIGGER_ICON[p.form.trigger]}
					tone={stepTone("trigger")}
					title={p.trigger.title}
					detail={p.trigger.detail}
					needs={triggerNeeds(p.form)}
					selected={p.selected === "trigger"}
					onSelect={() => p.onSelect("trigger")}
					trigger
				/>
				<Flow
					{...p}
					list={p.form.steps}
					at={[]}
					from={0}
				/>
			</div>
		</div>
	);
}

function Flow(p: Props & { list: Step[]; at: ListPath; from: number }) {
	const out: ReactNode[] = [];
	for (let i = p.from; i < p.list.length; i++) {
		const s = p.list[i] as Step;
		const path = [...p.at, i];
		out.push(
			<Line
				key={`l-${s.key}`}
				editable={p.editable}
				onAdd={(kind) => p.onInsert(p.at, i, kind)}
			/>,
		);
		const { title, detail } = p.describe(s);
		// A run waiting is already past the wait (its place is the step after it).
		const waiting = s.type === "wait" ? p.here.get([...p.at, i + 1].join(".")) : undefined;
		const at = s.type === "wait" ? undefined : p.here.get(path.join("."));
		out.push(
			<Node
				key={s.key}
				eyebrow={STEP_EYEBROW[s.type]}
				icon={stepIcon(s)}
				tone={stepTone(s.type)}
				title={title}
				detail={detail}
				needs={stepNeeds(s)}
				count={waiting ?? at}
				countLabel={waiting ? "waiting" : "here"}
				selected={p.selected === s.key}
				onSelect={() => p.onSelect(s.key)}
			/>,
		);
		if (s.type === "condition") {
			out.push(
				<Split
					key={`split-${s.key}`}
					yes={
						<Flow
							{...p}
							list={p.list}
							at={p.at}
							from={i + 1}
						/>
					}
					no={
						<Flow
							{...p}
							list={s.no}
							at={path}
							from={0}
						/>
					}
				/>,
			);
			return <>{out}</>;
		}
	}
	out.push(
		<Line
			key="l-end"
			editable={p.editable}
			onAdd={(kind) => p.onInsert(p.at, p.list.length, kind)}
		/>,
		<End key="end" />,
	);
	return <>{out}</>;
}

const STEP_EYEBROW: Record<StepType, string> = {
	send: "Send email",
	wait: "Wait",
	condition: "If / else",
	segment: "Segment",
	property: "Property",
};

function Node({
	eyebrow,
	icon: Icon,
	tone,
	title,
	detail,
	needs,
	count,
	countLabel,
	selected,
	onSelect,
	trigger,
}: {
	eyebrow: string;
	icon: LucideIcon;
	tone: Tone;
	title: string;
	detail: string;
	needs: string | null;
	count?: number;
	countLabel?: string;
	selected: boolean;
	onSelect: () => void;
	trigger?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			aria-pressed={selected}
			className={cn(
				"group relative flex w-[264px] items-start gap-3 rounded-xl bg-card p-3.5 text-left shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_var(--shadow-color),0_4px_12px_-4px_var(--shadow-color)] transition-[box-shadow,transform] outline-none hover:shadow-[0_0_0_1px_var(--border-strong),0_2px_4px_var(--shadow-color),0_10px_24px_-8px_var(--shadow-color-strong)] focus-visible:ring-2 focus-visible:ring-ring",
				selected && cn("ring-2 ring-offset-2 ring-offset-background", tone.ring),
			)}
		>
			{trigger && (
				<span className="absolute -top-2.5 left-3.5 flex items-center gap-1 rounded-full bg-amber-500 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase shadow-sm">
					<Zap className="size-2.5 fill-current" />
					Start
				</span>
			)}
			<span
				className={cn(
					"flex size-9 shrink-0 items-center justify-center rounded-lg",
					tone.tile,
				)}
			>
				<Icon className="size-[18px]" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
					{eyebrow}
				</span>
				<span className="truncate text-sm font-medium">{title}</span>
				{needs ? (
					<span className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
						<span className="size-1.5 rounded-full bg-amber-500" />
						{needs}
					</span>
				) : (
					detail && (
						<span className="truncate text-xs text-muted-foreground">{detail}</span>
					)
				)}
			</span>
			{!!count && (
				<span
					className="absolute -top-2 -right-2 flex h-5 items-center gap-1 rounded-full bg-foreground px-2 text-[11px] font-semibold text-background tabular-nums shadow-sm"
					title={`${count} ${countLabel}`}
				>
					{count.toLocaleString()}
					<span className="font-normal opacity-70">{countLabel}</span>
				</span>
			)}
		</button>
	);
}

function Line({
	editable,
	onAdd,
}: {
	editable: boolean;
	onAdd: (kind: (typeof STEP_KINDS)[number]) => void;
}) {
	return (
		<div className="relative flex h-14 w-px flex-col items-center justify-center bg-border-strong">
			{editable && (
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label="Add a step here"
							className="absolute flex size-6 items-center justify-center rounded-full bg-card text-muted-foreground shadow-[0_0_0_1px_var(--border-strong),0_1px_2px_var(--shadow-color)] transition-all outline-none hover:scale-110 hover:bg-brand hover:text-brand-foreground hover:shadow-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:scale-110 data-[state=open]:bg-brand data-[state=open]:text-brand-foreground"
						>
							<Plus className="size-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						align="center"
						className="w-60"
					>
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							Add a step
						</DropdownMenuLabel>
						{STEP_KINDS.map((k, i) => {
							const Icon = stepIcon({ type: k.type, action: k.action ?? "add" });
							return (
								<div key={k.label}>
									{i === 3 && <DropdownMenuSeparator />}
									<DropdownMenuItem
										onSelect={() => onAdd(k)}
										className="h-auto min-h-0 items-center gap-3 py-1.5"
									>
										<span
											className={cn(
												"flex size-7 items-center justify-center rounded-md",
												stepTone(k.type).tile,
											)}
										>
											<Icon className="size-4" />
										</span>
										<span className="flex flex-col gap-0.5 py-0.5 leading-tight">
											<span className="text-sm">{k.label}</span>
											<span className="text-xs text-muted-foreground">
												{k.hint}
											</span>
										</span>
									</DropdownMenuItem>
								</div>
							);
						})}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
}

function Split({ yes, no }: { yes: ReactNode; no: ReactNode }) {
	return (
		<div className="flex flex-col items-center">
			<div className="h-6 w-px bg-border-strong" />
			<div className="flex items-start">
				<Branch
					side="yes"
					label="Yes"
				>
					{yes}
				</Branch>
				<Branch
					side="no"
					label="No"
				>
					{no}
				</Branch>
			</div>
		</div>
	);
}

function Branch({
	side,
	label,
	children,
}: {
	side: "yes" | "no";
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="relative flex flex-col items-center px-5 pt-5">
			<span
				className={cn(
					"pointer-events-none absolute top-0 h-5 border-t border-border-strong",
					side === "yes"
						? "right-0 left-1/2 rounded-tl-xl border-l"
						: "right-1/2 left-0 rounded-tr-xl border-r",
				)}
			/>
			<span
				className={cn(
					"z-10 rounded-full px-2.5 py-0.5 text-[11px] font-semibold shadow-[0_0_0_1px_var(--border-strong)]",
					side === "yes"
						? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
						: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
				)}
			>
				{label}
			</span>
			{children}
		</div>
	);
}

function End() {
	return (
		<span className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1 text-xs font-medium text-muted-foreground shadow-[0_0_0_1px_var(--border-strong)]">
			<CircleCheck className="size-3.5" />
			End
		</span>
	);
}
