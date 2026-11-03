import { StatusBadge } from "@/components/status-badge";

const STATUS: Record<string, { status: string; label: string }> = {
	draft: { status: "not_started", label: "Draft" },
	scheduled: { status: "scheduled", label: "Scheduled" },
	sending: { status: "sending", label: "Sending" },
	testing: { status: "scheduled", label: "Testing" },
	sent: { status: "delivered", label: "Sent" },
	canceled: { status: "canceled", label: "Canceled" },
	failed: { status: "failed", label: "Failed" },
};

/** A broadcast's status as a badge. */
export function BroadcastStatus({ status, className }: { status: string; className?: string }) {
	const s = STATUS[status] ?? { status, label: status };
	return (
		<StatusBadge
			status={s.status}
			label={s.label}
			className={className}
		/>
	);
}
