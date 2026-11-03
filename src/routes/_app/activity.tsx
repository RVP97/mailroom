import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { type ActivityRow, ActivityFeed } from "@/components/activity-feed";
import { Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { activityFn } from "@/functions/team";
import { errorMessage } from "@/lib/errors";
import { ago, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

export const Route = createFileRoute("/_app/activity")({
	loader: async () => ({ rows: await activityFn({ data: {} }) }),
	head: () => ({ meta: [{ title: "Activity · Mailroom" }] }),
	component: Activity,
	pendingComponent: ActivitySketch,
});

function ActivitySketch() {
	return (
		<Sketch
			data={{
				rows: sample(rememberedRows("activity", 8), (i) => ({
					id: `sketch-${i}`,
					user_id: null,
					actor: "Someone",
					action: "broadcast.edited",
					subject_type: "broadcast",
					subject_id: null,
					subject_name: "November newsletter",
					detail: null,
					created_at: ago(i * 30),
				})),
			}}
		>
			<Activity />
		</Sketch>
	);
}

function Activity() {
	const first = usePage(Route).data.rows;
	const [more, setMore] = useState<ActivityRow[]>([]);
	const [done, setDone] = useState(first.length < 100);
	const [busy, setBusy] = useState(false);
	const rows = [...first, ...more];
	useRememberRows("activity", Math.min(first.length, 12));
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="Activity"
				description="Who changed what in this organization, newest first. Repeated saves of one thing within a few minutes show once."
			/>
			<Card className="gap-0 overflow-hidden p-0">
				<ActivityFeed rows={rows} />
			</Card>
			{!done && (
				<Button
					variant="outline"
					className="self-center"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							const next = await activityFn({
								data: { before: rows[rows.length - 1]?.created_at },
							});
							setMore((m) => [...m, ...next]);
							if (next.length < 100) setDone(true);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy && <Spinner />}
					Show older
				</Button>
			)}
		</Page>
	);
}
