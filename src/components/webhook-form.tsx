import { useRouter } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Check, Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { createWebhookFn, type listWebhooksFn, updateWebhookFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

export type Hook = Awaited<ReturnType<typeof listWebhooksFn>>["hooks"][number];

/** What each event means, in a line. */
const EVENT_HINT: Record<string, string> = {
	"email.sent": "SES accepted it to deliver",
	"email.delivered": "The recipient's server took it",
	"email.delivery_delayed": "Delivery is slow; SES keeps trying",
	"email.bounced": "The recipient's server refused it",
	"email.complained": "The recipient marked it as spam",
	"email.opened": "Opened (with open tracking on)",
	"email.clicked": "A link was clicked (click tracking)",
	"email.failed": "It couldn't be sent",
	"email.suppressed": "Not sent: the address is suppressed",
	"email.scheduled": "Set to send later",
	"email.unsubscribed": "Someone left an unsubscribe group",
};

/**
 * Event types to pick, Resend's way: a search box over the list, each with its status colour and
 * a check when chosen, and «All events» on top.
 */
function EventPicker({
	events,
	chosen,
	onChange,
}: {
	events: string[];
	chosen: string[];
	onChange: (next: string[]) => void;
}) {
	const all = chosen.length === events.length;
	const toggle = (ev: string) =>
		onChange(
			chosen.includes(ev)
				? chosen.filter((x) => x !== ev)
				: events.filter((x) => x === ev || chosen.includes(x)),
		);
	const row =
		"flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm select-none data-[selected=true]:bg-accent";
	return (
		<Command
			loop
			className="overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--input)] focus-within:shadow-[0_0_0_1px_var(--ring),0_0_0_3px_color-mix(in_oklch,var(--ring),transparent_75%)]"
		>
			<div className="flex h-10 items-center gap-2 border-b border-border/70 px-3">
				<Search className="size-4 shrink-0 text-faint" />
				<Command.Input
					placeholder="Search events…"
					className="h-full flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
				/>
			</div>
			<Command.List className="h-64 scroll-py-1 overflow-y-auto p-1">
				<Command.Empty className="px-3 py-6 text-center text-sm text-muted-foreground">
					No event matches
				</Command.Empty>
				<Command.Item
					value="all events"
					onSelect={() => onChange(all ? [] : [...events])}
					className={row}
				>
					<span className="flex size-4 shrink-0 items-center justify-center">
						<span className="size-2 rounded-full bg-foreground/70" />
					</span>
					<span className="flex-1 font-medium">All events</span>
					<Check className={cn("size-4 text-foreground", !all && "invisible")} />
				</Command.Item>
				{events.map((ev) => {
					const on = chosen.includes(ev);
					return (
						<Command.Item
							key={ev}
							value={`${ev} ${EVENT_HINT[ev] ?? ""}`}
							onSelect={() => toggle(ev)}
							className={row}
						>
							<span className="flex size-4 shrink-0 items-center justify-center">
								<StatusDot status={ev} />
							</span>
							<span className="min-w-0 flex-1 truncate">
								<span className="font-mono text-[13px]">{ev}</span>
								{EVENT_HINT[ev] && (
									<span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
										{EVENT_HINT[ev]}
									</span>
								)}
							</span>
							<Check className={cn("size-4 text-foreground", !on && "invisible")} />
						</Command.Item>
					);
				})}
			</Command.List>
		</Command>
	);
}

const DEFAULT_EVENTS = ["email.delivered", "email.bounced", "email.complained", "email.failed"];

/** Add an endpoint, or (with `hook`) change one's URL and events. */
export function WebhookForm({
	events,
	hook,
	open: shown,
	onOpenChange,
}: {
	events: string[];
	hook?: Hook;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const router = useRouter();
	const [own, setOwn] = useState(false);
	const open = shown ?? own;
	const initial = () => ({
		url: hook?.url ?? "",
		chosen: hook ? [...hook.events] : DEFAULT_EVENTS,
	});
	const [url, setUrl] = useState(initial().url);
	const [chosen, setChosen] = useState<string[]>(initial().chosen);
	const [busy, setBusy] = useState(false);
	const allChosen = chosen.length === events.length;
	const setOpen = (v: boolean) => {
		setOwn(v);
		onOpenChange?.(v);
		if (v) {
			setUrl(initial().url);
			setChosen(initial().chosen);
		}
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset each time it opens from outside
	useEffect(() => {
		if (shown) {
			setUrl(initial().url);
			setChosen(initial().chosen);
		}
	}, [shown]);
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			{!hook && (
				<DialogTrigger asChild>
					<Button>
						<Plus /> Add webhook
					</Button>
				</DialogTrigger>
			)}
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							if (hook) {
								await updateWebhookFn({
									data: { id: hook.id, url: url.trim(), events: chosen },
								});
								toast.success("Endpoint saved");
								setOpen(false);
								await router.invalidate();
							} else {
								const { id } = await createWebhookFn({
									data: { url: url.trim(), events: chosen },
								});
								toast.success("Endpoint added");
								setOpen(false);
								await router.invalidate();
								await router.navigate({ to: "/webhooks/$id", params: { id } });
							}
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{hook ? "Edit webhook" : "Add webhook"}</DialogTitle>
						<DialogDescription>
							{hook
								? "Changes apply from the next event. The signing secret stays the same."
								: "Mailroom POSTs each event you pick to this URL, signed."}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="hook-url">Endpoint URL</FieldLabel>
							<Input
								id="hook-url"
								type="url"
								required
								autoFocus={!hook}
								spellCheck={false}
								placeholder="https://example.com/webhooks/email"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
							/>
							<FieldDescription>
								Answer with a 2xx. Failures are retried for about a day.
							</FieldDescription>
						</Field>
						<Field>
							<div className="flex items-center justify-between">
								<FieldLabel>Event types</FieldLabel>
								<span className="text-xs text-muted-foreground tabular-nums">
									{allChosen ? "All" : chosen.length} of {events.length}
								</span>
							</div>
							<EventPicker
								events={events}
								chosen={chosen}
								onChange={setChosen}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !url.trim() || !chosen.length}
						>
							{busy && <Spinner />}
							{hook ? "Save changes" : "Add webhook"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
