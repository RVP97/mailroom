import { Badge } from "@/components/ui/badge";

/** What a brand's status says, in one word. */
export function brandStatus(b: {
	sending: string;
	paused: { by: string } | null;
	ses_status?: string | null;
	sesStatus?: string | null;
}) {
	const ses = b.ses_status ?? b.sesStatus;
	if (b.paused) return { status: "paused", label: "Paused" };
	if (ses && ses !== "ENABLED" && ses !== "REINSTATED")
		return { status: "error", label: "Paused by SES" };
	if (b.sending === "ready") return { status: "ready", label: "Sending" };
	if (b.sending === "error") return { status: "error", label: "Setup failed" };
	return { status: "not_set_up", label: "Not set up" };
}

/** A domain's purpose, quietly: transactional is the norm, marketing stands out a little. */
export function PurposeBadge({ purpose }: { purpose: string }) {
	return purpose === "marketing" ? (
		<Badge
			data-ph
			variant="outline"
			className="border-brand/40 text-brand"
		>
			Marketing
		</Badge>
	) : (
		<Badge
			data-ph
			variant="secondary"
		>
			Transactional
		</Badge>
	);
}
