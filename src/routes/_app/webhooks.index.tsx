import { createFileRoute, Link } from "@tanstack/react-router";
import { Webhook } from "lucide-react";
import { ApiDrawer } from "@/components/api-drawer";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { WebhookForm } from "@/components/webhook-form";
import { listWebhooksFn } from "@/functions/settings";
import { formatAgo, formatDateTime } from "@/lib/format";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

export const Route = createFileRoute("/_app/webhooks/")({
	loader: () => listWebhooksFn(),
	head: () => ({ meta: [{ title: "Webhooks · Mailroom" }] }),
	component: Webhooks,
	pendingComponent: WebhooksSketch,
});

function WebhooksSketch() {
	const events = sample(12, (i) => `email.event${i}`);
	return (
		<Sketch
			data={{
				events,
				hooks: sample(rememberedRows("webhooks", 2), (i) => ({
					id: `sketch-${i}`,
					url: pick(i, [
						"https://example.com/webhooks/mailroom",
						"https://api.example.com/hooks/email",
					]),
					enabled: true,
					down_since: null,
					events,
					created_at: ago(60 * 24 * 20),
				})),
			}}
		>
			<Webhooks />
		</Sketch>
	);
}

/** «All events», or how many. */
const listening = (n: number, all: number) =>
	n === all ? "All events" : `${n} ${n === 1 ? "event" : "events"}`;

function Webhooks() {
	const { hooks, events } = usePage(Route).data;
	useRememberRows("webhooks", hooks.length);
	useListed("webhooks", hooks);
	const now = Date.now();
	return (
		<Page>
			<PageHeader
				title="Webhooks"
				description="Your endpoints get each email's events as they happen, signed like Resend's (Standard Webhooks)."
				actions={
					<>
						<ApiDrawer
							title="Webhooks in the API"
							description="Needs a full-access key."
							calls={[
								{ title: "List endpoints", method: "GET", path: "/webhooks" },
								{
									title: "Add an endpoint",
									method: "POST",
									path: "/webhooks",
									body: {
										url: "https://example.com/webhooks/mailroom",
										events: [
											"email.delivered",
											"email.bounced",
											"email.complained",
										],
									},
								},
							]}
						/>
						{hooks.length > 0 && <WebhookForm events={[...events]} />}
					</>
				}
			/>
			<TableCard>
				{hooks.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Webhook />
							</EmptyMedia>
							<EmptyTitle>Add your first endpoint</EmptyTitle>
							<EmptyDescription>
								Get delivered, bounced, opened and the rest as POSTs to your server.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<WebhookForm events={[...events]} />
						</EmptyContent>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Endpoint</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-32 md:table-cell">
									Listening for
								</TableHead>
								<TableHead className="w-20 text-right">Added</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{hooks.map((h) => (
								<TableRow
									key={h.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Webhook}
												tone={h.enabled ? "green" : "gray"}
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/webhooks/$id"
													params={{ id: h.id }}
													title={h.url}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{h.url}</Ph>
												</Link>
												<StatusBadge
													status={
														!h.enabled
															? "canceled"
															: h.down_since
																? "error"
																: "ready"
													}
													label={
														!h.enabled
															? "Disabled"
															: h.down_since
																? "Down"
																: "Enabled"
													}
													className="mt-1 sm:hidden"
												/>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<StatusBadge
											status={
												!h.enabled
													? "canceled"
													: h.down_since
														? "error"
														: "ready"
											}
											label={
												!h.enabled
													? "Disabled"
													: h.down_since
														? "Down"
														: "Enabled"
											}
										/>
									</TableCell>
									<TableCell className="hidden text-muted-foreground md:table-cell">
										<Ph>{listening(h.events.length, events.length)}</Ph>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(h.created_at)}
									>
										<Ph>{formatAgo(h.created_at, now)}</Ph>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}
