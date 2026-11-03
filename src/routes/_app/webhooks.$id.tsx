import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import {
	CircleAlert,
	Copy,
	Eye,
	EyeOff,
	History,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	RotateCw,
	Send,
	Trash2,
	Webhook,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { CodeBlock } from "@/components/code-block";
import { Confirm } from "@/components/confirm";
import { CopyIcon, useCopy } from "@/components/copy";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
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
import { Spinner } from "@/components/ui/spinner";
import { type Hook, WebhookForm } from "@/components/webhook-form";
import {
	deleteWebhookFn,
	listWebhooksFn,
	replayDeliveryFn,
	replayFailedFn,
	testWebhookFn,
	updateWebhookFn,
	webhookDeliveriesFn,
} from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatRelative } from "@/lib/format";
import { patch, useOptimisticState } from "@/lib/optimistic";
import {
	ago,
	listedRow,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useOpened,
	usePage,
	useRememberRows,
} from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/webhooks/$id")({
	// The delivery shown beside the list (the newest when none is picked).
	validateSearch: (s: Record<string, unknown>): { delivery?: string } =>
		typeof s.delivery === "string" ? { delivery: s.delivery } : {},
	loader: async ({ params }) => {
		const [{ hooks, events }, deliveries] = await Promise.all([
			listWebhooksFn(),
			webhookDeliveriesFn({ data: { id: params.id } }),
		]);
		const hook = hooks.find((h) => h.id === params.id);
		if (!hook) throw notFound();
		return { hook, events: [...events], deliveries };
	},
	head: ({ loaderData }) => ({
		meta: [
			{
				title: `${loaderData?.hook.url.replace(/^https?:\/\//, "") ?? "Webhook"} · Mailroom`,
			},
		],
	}),
	component: WebhookPage,
	pendingComponent: WebhookSketch,
});

/** Drawn from the row the webhooks list showed, when it did. */
function WebhookSketch() {
	const { params } = usePage(Route);
	const events = sample(12, (i) => `email.event${i}`);
	const row = listedRow<Hook>("webhooks", params.id);
	const opened = listedRow<PageData & { id: string }>("webhook-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<WebhookPage />
			</Sketch>
		);
	return (
		<Sketch
			data={{
				events: row ? events.slice(0, Math.max(row.events.length, 12)) : events,
				hook: {
					id: params.id ?? "",
					url: "https://example.com/webhooks/mailroom",
					secret: "whsec_0000000000",
					events,
					enabled: true,
					down_since: null,
					failures: 0,
					created_at: ago(60 * 24 * 20),
					...row,
				},
				deliveries: sample(rememberedRows("webhook:deliveries", 20), (i) => ({
					id: `sketch-${i}`,
					event_type: pick(i, ["email.delivered", "email.sent", "email.opened"]),
					status: "delivered",
					attempts: 1,
					next_attempt_at: null,
					response_status: 200,
					response_body: null,
					payload:
						'{\n  "type": "email.delivered",\n  "created_at": "",\n  "data": {\n    "email_id": "",\n    "from": "",\n    "to": [""],\n    "subject": ""\n  }\n}',
					created_at: ago(i * 30),
				})),
			}}
		>
			<WebhookPage />
		</Sketch>
	);
}

type PageData = (typeof Route)["types"]["loaderData"];

type Delivery = Awaited<ReturnType<typeof webhookDeliveriesFn>>[number];

const deliveryStatus = (d: Delivery) =>
	d.status === "delivered" ? "delivered" : d.status === "failed" ? "failed" : "pending";
const DELIVERY_LABEL = { delivered: "Delivered", failed: "Failed", pending: "Retrying" };

function WebhookPage() {
	const data = usePage(Route).data;
	const { hook: savedHook, events, deliveries } = data;
	useOpened(
		"webhook-page",
		useMemo(() => ({ ...data, id: data.hook.id }), [data]),
	);
	useRememberRows("webhook:deliveries", deliveries.length);
	// Turning it on or off shows at once; a failed save turns it back.
	const [hook, save] = useOptimisticState(savedHook, patch<typeof savedHook>);
	const { search } = usePage(Route);
	const navigate = Route.useNavigate();
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [testing, setTesting] = useState(false);
	const selected = deliveries.find((d) => d.id === search.delivery) ?? deliveries[0];
	const now = Date.now();

	const sendTest = async () => {
		setTesting(true);
		try {
			const r = await testWebhookFn({ data: { id: hook.id } });
			if (r.ok) toast.success("Your endpoint answered 2xx");
			else toast.error("Your endpoint didn't answer 2xx");
			await router.invalidate();
			await navigate({ search: {}, replace: true, resetScroll: false });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setTesting(false);
		}
	};
	const replayFailed = async () => {
		try {
			const { replayed } = await replayFailedFn({ data: { id: hook.id } });
			toast.success(
				replayed
					? `${replayed} failed ${replayed === 1 ? "delivery is" : "deliveries are"} being sent again`
					: "No failed deliveries in the last 7 days",
			);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};
	const setEnabled = async (enabled: boolean) => {
		const ok = await save({ enabled }, () =>
			updateWebhookFn({ data: { id: hook.id, enabled } }),
		);
		if (ok) toast.success(enabled ? "Endpoint enabled" : "Endpoint disabled");
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/webhooks"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Webhooks
					</Link>
				</nav>
				<RecordHeader
					icon={Webhook}
					tone={!hook.enabled ? "gray" : hook.down_since ? "red" : "green"}
					kind="Webhook"
					title={<span title={hook.url}>{hook.url}</span>}
					actions={
						<>
							<Button
								variant="outline"
								className="hidden sm:inline-flex"
								disabled={testing || !hook.enabled}
								onClick={sendTest}
							>
								{testing ? <Spinner /> : <Send />}
								Send test
							</Button>
							<ApiDrawer
								title="This endpoint in the API"
								description="Needs a full-access key."
								calls={[
									{
										title: "Change its events",
										method: "PATCH",
										path: `/webhooks/${hook.id}`,
										body: { events: hook.events },
									},
									{
										title: hook.enabled ? "Turn it off" : "Turn it on",
										method: "PATCH",
										path: `/webhooks/${hook.id}`,
										body: { enabled: !hook.enabled },
									},
									{
										title: "Delete it",
										method: "DELETE",
										path: `/webhooks/${hook.id}`,
									},
								]}
							/>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="outline"
										size="icon"
										aria-label="More"
									>
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										className="sm:hidden"
										disabled={!hook.enabled}
										onSelect={sendTest}
									>
										<Send />
										Send test
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => setEditing(true)}>
										<Pencil />
										Edit URL and events
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={replayFailed}>
										<RotateCw />
										Replay failed deliveries
									</DropdownMenuItem>
									<DropdownMenuItem onSelect={() => setEnabled(!hook.enabled)}>
										{hook.enabled ? <Pause /> : <Play />}
										{hook.enabled ? "Disable" : "Enable"}
									</DropdownMenuItem>
									<CopyItem
										label="Copy webhook id"
										value={hook.id}
									/>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										variant="destructive"
										onSelect={() => setDeleting(true)}
									>
										<Trash2 />
										Delete endpoint
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					}
				/>
			</div>
			<WebhookForm
				events={events}
				hook={hook}
				open={editing}
				onOpenChange={setEditing}
			/>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this endpoint?"
				description="It stops getting events, and its pending retries are dropped."
				action="Delete endpoint"
				onConfirm={async () => {
					try {
						await deleteWebhookFn({ data: { id: hook.id } });
						toast.success("Endpoint deleted");
						await router.navigate({ to: "/webhooks" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			{hook.enabled && hook.down_since && (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>
						Your endpoint is down
						<span className="font-normal text-muted-foreground">
							{" "}
							· since {formatRelative(hook.down_since)}
						</span>
					</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						It failed {hook.failures} times in a row, so new events wait for the retries
						instead of being sent at once. The first answer in 2xx brings it back. Fixed
						it? Send the failed ones again.
						<Button
							size="sm"
							variant="outline"
							onClick={replayFailed}
						>
							<RotateCw />
							Replay failed deliveries
						</Button>
					</AlertDescription>
				</Alert>
			)}
			<Facts className="border-b border-border/70 pb-8">
				<Fact
					label="Listening for"
					className="col-span-2"
				>
					<Listening
						hook={hook}
						all={events.length}
						onEdit={() => setEditing(true)}
					/>
				</Fact>
				<Fact label="Status">
					<StatusBadge
						status={!hook.enabled ? "canceled" : hook.down_since ? "error" : "ready"}
						label={!hook.enabled ? "Disabled" : hook.down_since ? "Down" : "Enabled"}
					/>
				</Fact>
				<Fact label="Added">
					<span
						className="tabular-nums"
						title={formatDateTime(hook.created_at)}
					>
						{formatRelative(hook.created_at)}
					</span>
				</Fact>
				<Fact
					label="Signing secret"
					className="col-span-2"
				>
					<Secret value={hook.secret} />
				</Fact>
				<Fact label="Id">
					<IdChip value={hook.id} />
				</Fact>
			</Facts>

			<section className="flex flex-col gap-4">
				<div>
					<h2 className="text-lg font-semibold">Deliveries</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						The last 100 events sent here, with your endpoint's answer. Failures are
						retried for about a day.
					</p>
				</div>
				{deliveries.length === 0 ? (
					<div className="rounded-xl bg-card shadow-card">
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<History />
								</EmptyMedia>
								<EmptyTitle>Nothing sent here yet</EmptyTitle>
								<EmptyDescription>
									Events show up here as they're sent. Send a test to see one now.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button
									variant="outline"
									disabled={testing || !hook.enabled}
									onClick={sendTest}
								>
									{testing ? <Spinner /> : <Send />}
									Send test
								</Button>
							</EmptyContent>
						</Empty>
					</div>
				) : (
					<div className="grid items-start gap-4 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
						<ul className="flex max-h-[42rem] flex-col gap-0.5 overflow-y-auto rounded-xl bg-card p-1.5 shadow-card max-lg:max-h-80">
							{deliveries.map((d) => {
								const active = d.id === selected?.id;
								return (
									<li key={d.id}>
										<Link
											to="."
											search={{ delivery: d.id }}
											replace
											resetScroll={false}
											aria-current={active || undefined}
											className={cn(
												"flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors duration-100",
												active
													? "bg-accent text-foreground"
													: "text-foreground/85 hover:bg-accent/60",
											)}
										>
											<StatusDot status={deliveryStatus(d)} />
											<span className="min-w-0 flex-1 truncate font-mono text-xs">
												<Ph>{d.event_type}</Ph>
											</span>
											<span
												className="shrink-0 text-xs text-muted-foreground tabular-nums"
												title={formatDateTime(d.created_at)}
											>
												<Ph>{formatAgo(d.created_at, now)}</Ph>
											</span>
										</Link>
									</li>
								);
							})}
						</ul>
						{selected && (
							<DeliveryDetail
								key={selected.id}
								d={selected}
							/>
						)}
					</div>
				)}
			</section>
		</Page>
	);
}

/** The events an endpoint hears, as chips; all of them is said in two words. */
function Listening({ hook, all, onEdit }: { hook: Hook; all: number; onEdit: () => void }) {
	return (
		<span className="flex flex-wrap items-center gap-1">
			{hook.events.length === all ? (
				<span className="mr-1">All events</span>
			) : (
				hook.events.map((e) => (
					<span
						key={e}
						className="inline-flex h-5 items-center gap-1.5 rounded-full bg-muted px-2 font-mono text-2xs text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]"
					>
						<StatusDot status={e} />
						{e}
					</span>
				))
			)}
			<button
				type="button"
				onClick={onEdit}
				className="px-1 text-xs font-medium text-brand hover:underline"
			>
				Edit
			</button>
		</span>
	);
}

/** The signing secret, hidden until asked for, copied whole either way. */
function Secret({ value }: { value: string }) {
	const [reveal, setReveal] = useState(false);
	const { copied, copy } = useCopy();
	return (
		<span className="inline-flex h-6 max-w-full min-w-0 items-center gap-0.5 rounded-md bg-muted pr-0.5 pl-2 font-mono text-xs shadow-[inset_0_0_0_1px_var(--border)]">
			<span className={cn("truncate", !reveal && "tracking-wider text-muted-foreground")}>
				{reveal ? value : "whsec_••••••••••••••••"}
			</span>
			<button
				type="button"
				onClick={() => copy(value)}
				aria-label={copied ? "Copied" : "Copy secret"}
				title={copied ? "Copied" : "Copy secret"}
				className="pressable ml-1 flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground"
			>
				<CopyIcon
					copied={copied}
					className="size-3"
				/>
			</button>
			<button
				type="button"
				onClick={() => setReveal(!reveal)}
				aria-label={reveal ? "Hide secret" : "Show secret"}
				title={reveal ? "Hide secret" : "Show secret"}
				className="pressable flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-accent hover:text-foreground [&_svg]:size-3"
			>
				{reveal ? <EyeOff /> : <Eye />}
			</button>
		</span>
	);
}

/** One delivery: what was sent, what came back, and a way to send it again. */
function DeliveryDetail({ d }: { d: Delivery }) {
	const router = useRouter();
	const [resending, setResending] = useState(false);
	const status = deliveryStatus(d);
	return (
		<div className="flex min-w-0 flex-col gap-6 rounded-xl bg-card p-5 shadow-card">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<h3 className="truncate font-mono text-sm font-semibold">
						<Ph>{d.event_type}</Ph>
					</h3>
					<StatusBadge
						status={status}
						label={DELIVERY_LABEL[status]}
						className="mt-1.5"
					/>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={resending}
					onClick={async () => {
						setResending(true);
						try {
							const r = await replayDeliveryFn({ data: { id: d.id } });
							if (r.ok) toast.success("Delivered");
							else toast.error("Still failing");
							await router.invalidate();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setResending(false);
						}
					}}
				>
					{resending ? <Spinner /> : <RotateCw />}
					Send again
				</Button>
			</div>
			<Facts className="sm:grid-cols-2 lg:grid-cols-2">
				<Fact label="Id">
					<IdChip value={d.id} />
				</Fact>
				<Fact label="Sent">
					<span
						className="tabular-nums"
						title={d.created_at}
					>
						{formatDateTime(d.created_at)}
					</span>
				</Fact>
				<Fact label="HTTP status">
					<span className="font-mono text-xs">
						{d.response_status ?? (status === "pending" ? "Not yet" : "No answer")}
					</span>
				</Fact>
				<Fact label="Tries">
					<span className="tabular-nums">
						{d.attempts}
						{status === "pending" && d.next_attempt_at && (
							<span className="text-muted-foreground">
								{" "}
								· next {formatRelative(d.next_attempt_at)}
							</span>
						)}
					</span>
				</Fact>
			</Facts>
			{d.response_body && (
				<div className="flex flex-col gap-2">
					<h4 className="text-sm font-medium">Response body</h4>
					<CodeBlock
						data
						code={d.response_body}
						lang={/^\s*[{[]/.test(d.response_body) ? "json" : "text"}
						className="max-h-40 overflow-auto"
					/>
				</div>
			)}
			<div className="flex flex-col gap-2">
				<h4 className="text-sm font-medium">Payload</h4>
				<CodeBlock
					data
					code={pretty(d.payload)}
					lang="json"
					className="max-h-[28rem] overflow-auto"
				/>
			</div>
		</div>
	);
}

function pretty(json: string) {
	try {
		return JSON.stringify(JSON.parse(json), null, 2);
	} catch {
		return json;
	}
}

function CopyItem({ label, value }: { label: string; value: string }) {
	const { copy } = useCopy();
	return (
		<DropdownMenuItem
			onSelect={() => {
				copy(value);
				toast.success("Copied");
			}}
		>
			<Copy />
			{label}
		</DropdownMenuItem>
	);
}
