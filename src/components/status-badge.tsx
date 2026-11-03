import { STATUS_INFO } from "@/lib/email-status";
import { cn } from "@/lib/utils";

type Tone = "green" | "blue" | "amber" | "red" | "gray" | "faint";

const TONE: Record<string, Tone> = {
	delivered: "green",
	verified: "green",
	ready: "green",
	success: "green",
	opened: "blue",
	clicked: "blue",
	scheduled: "blue",
	sent: "gray",
	sending: "gray",
	queued: "gray",
	pending: "amber",
	delivery_delayed: "amber",
	temporary_failure: "amber",
	not_started: "amber",
	paused: "amber",
	not_set_up: "amber",
	soft_bounced: "amber",
	bounced: "red",
	complained: "red",
	failed: "red",
	not_delivered: "red",
	error: "red",
	suppressed: "faint",
	blocked: "faint",
	unsubscribed: "faint",
	firewall: "faint",
	canceled: "faint",
};

const STYLES: Record<Tone, { pill: string; dot: string }> = {
	green: { pill: "bg-success/10 text-success", dot: "bg-success" },
	blue: { pill: "bg-brand/10 text-brand", dot: "bg-brand" },
	amber: {
		pill: "bg-warning/12 text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]",
		dot: "bg-warning",
	},
	red: { pill: "bg-destructive/10 text-destructive", dot: "bg-destructive" },
	gray: {
		pill: "bg-muted text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]",
		dot: "bg-faint",
	},
	faint: {
		pill: "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
		dot: "bg-faint/70",
	},
};

/** In progress: the dot breathes. */
const LIVE = new Set(["sending", "queued", "pending"]);

export const statusLabel = (s: string) => {
	const key = s.replace(/^email\./, "");
	const known = STATUS_INFO[key]?.label;
	if (known) return known;
	const label = key.replace(/_/g, " ");
	return label.charAt(0).toUpperCase() + label.slice(1);
};

export const statusTone = (s: string): Tone => TONE[s.replace(/^email\./, "")] ?? "gray";

export function StatusDot({ status, className }: { status: string; className?: string }) {
	const key = status.replace(/^email\./, "");
	return (
		<span className={cn("relative flex size-1.5 shrink-0", className)}>
			{LIVE.has(key) && (
				<span
					className={cn(
						"absolute inline-flex size-full animate-ping rounded-full opacity-50 [animation-duration:1.6s]",
						STYLES[statusTone(key)].dot,
					)}
				/>
			)}
			<span
				className={cn(
					"relative inline-flex size-1.5 rounded-full",
					STYLES[statusTone(key)].dot,
				)}
			/>
		</span>
	);
}

export function StatusBadge({
	status,
	label,
	className,
}: {
	status: string;
	label?: string;
	className?: string;
}) {
	const key = status.replace(/^email\./, "");
	return (
		<span
			data-ph
			className={cn(
				"inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-full pr-2 pl-1.5 text-xs font-medium whitespace-nowrap",
				STYLES[statusTone(key)].pill,
				className,
			)}
		>
			<StatusDot status={key} />
			{label ?? statusLabel(key)}
		</span>
	);
}

/** An HTTP status, coloured by its class. */
export function StatusCode({ code, className }: { code: number; className?: string }) {
	return (
		<span
			data-ph
			className={cn(
				"inline-flex h-5 items-center rounded px-1.5 font-mono text-xs font-medium tabular-nums",
				code < 400
					? "bg-success/10 text-success"
					: code < 500
						? "bg-warning/12 text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]"
						: "bg-destructive/10 text-destructive",
				className,
			)}
		>
			{code}
		</span>
	);
}
