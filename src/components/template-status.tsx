import { StatusBadge } from "@/components/status-badge";

/** Draft, Published, or Published with changes waiting. */
export function TemplateStatus({
	t,
	className,
}: {
	t: { status: string; has_unpublished_changes: boolean };
	className?: string;
}) {
	return (
		<StatusBadge
			status={
				t.status === "draft"
					? "not_started"
					: t.has_unpublished_changes
						? "pending"
						: "ready"
			}
			label={
				t.status === "draft"
					? "Draft"
					: t.has_unpublished_changes
						? "Unpublished changes"
						: "Published"
			}
			className={className}
		/>
	);
}
