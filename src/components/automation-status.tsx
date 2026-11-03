import { StatusBadge } from "@/components/status-badge";

const STATUS: Record<string, { status: string; label: string }> = {
	draft: { status: "not_started", label: "Draft" },
	active: { status: "ready", label: "On" },
	paused: { status: "paused", label: "Paused" },
};

/** An automation's status as a badge. */
export function AutomationStatus({ status, className }: { status: string; className?: string }) {
	const s = STATUS[status] ?? { status, label: status };
	return (
		<StatusBadge
			status={s.status}
			label={s.label}
			className={className}
		/>
	);
}

/** What starts it, in words. */
export function triggerLabel(
	t: {
		type: string;
		event?: string;
		segment_id?: string | null;
		broadcast_id?: string | null;
		link?: string | null;
	},
	segmentName?: (id: string) => string | undefined,
	broadcastName?: (id: string) => string | undefined,
) {
	if (t.type === "event") return `When ${t.event || "an event"} comes in`;
	if (t.type === "email.opened" || t.type === "email.clicked") {
		const b = t.broadcast_id
			? `“${broadcastName?.(t.broadcast_id) ?? "a broadcast"}”`
			: "a broadcast";
		if (t.type === "email.opened") return `When a contact opens ${b}`;
		return t.link
			? `When a contact clicks ${t.link.replace(/^https?:\/\//, "")} in ${b}`
			: `When a contact clicks a link in ${b}`;
	}
	const seg = t.segment_id ? (segmentName?.(t.segment_id) ?? "a segment") : null;
	if (t.type === "segment.joined") return `When a contact joins ${seg ?? "a segment"}`;
	return seg ? `When a contact is added to ${seg}` : "When a contact is added";
}
