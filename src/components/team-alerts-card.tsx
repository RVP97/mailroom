import { Bell, Plus, Send, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	deleteAlertChannelFn,
	listAlertChannelsFn,
	saveAlertChannelFn,
	testAlertChannelFn,
} from "@/functions/team-alerts";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import {
	ALERT_EVENT_LABELS,
	ALERT_EVENTS,
	type AlertChannelKind,
	type AlertEvent,
} from "@/lib/team-alerts";

type Channel = Awaited<ReturnType<typeof listAlertChannelsFn>>[number];

const KIND_LABELS: Record<AlertChannelKind, string> = {
	slack: "Slack",
	discord: "Discord",
	webhook: "Webhook",
};

const DEFAULT_EVENTS: AlertEvent[] = [
	"chat.started",
	"sla.warning",
	"sla.breached",
	"note.mention",
];

export function TeamAlertsCard({ canEdit }: { canEdit: boolean }) {
	const [channels, setChannels] = useState<Channel[] | null>(null);
	const [editing, setEditing] = useState<Channel | "new" | null>(null);
	const [testing, setTesting] = useState<string | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!canEdit) return;
		try {
			setChannels(await listAlertChannelsFn());
		} catch {
			setChannels([]);
		}
	}, [canEdit]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!canEdit) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Bell className="size-4 text-muted-foreground" />
					Slack, Discord &amp; team alerts
				</CardTitle>
				<CardDescription>
					Send real-time notifications to Slack, Discord, or any webhook when live chats
					arrive, SLAs approach breach, teammates @mention someone, or sending alerts
					fire. Webhook URLs are encrypted at rest.
				</CardDescription>
				<CardAction>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setEditing("new")}
					>
						<Plus />
						Add channel
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				{channels === null ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> Loading alert channels…
					</div>
				) : channels.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No alert channels connected yet. Add a Slack or Discord incoming webhook URL
						so your team hears about urgent chats and SLA warnings without watching the
						tab.
					</p>
				) : (
					<div className="divide-y divide-border/70 rounded-lg border border-border/70">
						{channels.map((ch) => (
							<div
								key={ch.id}
								className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium text-sm">{ch.name}</span>
										<Badge variant="outline">{KIND_LABELS[ch.kind]}</Badge>
										{!ch.enabled && <Badge variant="secondary">Paused</Badge>}
										<span className="truncate font-mono text-xs text-muted-foreground">
											{ch.url_hint}
										</span>
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
										{ch.events.map((e) => (
											<span
												key={e}
												className="rounded bg-muted px-1.5 py-0.5 text-[11px]"
											>
												{ALERT_EVENT_LABELS[e] ?? e}
											</span>
										))}
										{ch.last_sent_at && (
											<span className="ml-1">
												· last sent {formatRelative(ch.last_sent_at)}
											</span>
										)}
										{ch.last_error && (
											<span className="ml-1 text-destructive">
												· {ch.last_error}
											</span>
										)}
									</div>
								</div>
								<div className="flex items-center gap-1.5">
									<Button
										variant="outline"
										size="sm"
										disabled={testing === ch.id}
										onClick={async () => {
											setTesting(ch.id);
											try {
												await testAlertChannelFn({ data: { id: ch.id } });
												toast.success(`Test sent to ${ch.name}`);
												await load();
											} catch (error) {
												toast.error(await errorMessage(error));
											} finally {
												setTesting(null);
											}
										}}
									>
										{testing === ch.id ? <Spinner /> : <Send />}
										Test
									</Button>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setEditing(ch)}
									>
										Edit
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label={`Delete ${ch.name}`}
										disabled={removing === ch.id}
										onClick={async () => {
											setRemoving(ch.id);
											try {
												await deleteAlertChannelFn({ data: { id: ch.id } });
												toast.success("Channel removed");
												await load();
											} catch (error) {
												toast.error(await errorMessage(error));
											} finally {
												setRemoving(null);
											}
										}}
									>
										<Trash2 className="size-4" />
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</CardContent>
			{editing && (
				<AlertChannelDialog
					channel={editing === "new" ? null : editing}
					onClose={() => setEditing(null)}
					onSaved={async () => {
						setEditing(null);
						await load();
					}}
				/>
			)}
		</Card>
	);
}

function AlertChannelDialog({
	channel,
	onClose,
	onSaved,
}: {
	channel: Channel | null;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState(channel?.name ?? "#support-alerts");
	const [kind, setKind] = useState<AlertChannelKind>(channel?.kind ?? "slack");
	const [url, setUrl] = useState("");
	const [events, setEvents] = useState<AlertEvent[]>(channel?.events ?? DEFAULT_EVENTS);
	const [enabled, setEnabled] = useState(channel?.enabled ?? true);
	const [busy, setBusy] = useState(false);

	const toggleEvent = (e: AlertEvent) =>
		setEvents((cur) => (cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]));

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							await saveAlertChannelFn({
								data: {
									...(channel ? { id: channel.id } : {}),
									name: name.trim(),
									kind,
									...(url.trim() ? { webhook_url: url.trim() } : {}),
									events,
									enabled,
								},
							});
							toast.success(channel ? "Channel updated" : "Alert channel added");
							await onSaved();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>
							{channel ? "Edit alert channel" : "Add Slack, Discord or webhook alert"}
						</DialogTitle>
						<DialogDescription>
							Paste an incoming webhook URL from Slack, Discord, or your own receiver.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="alc-name">Channel name</FieldLabel>
								<Input
									id="alc-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="#support-alerts"
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="alc-kind">Format</FieldLabel>
								<Select
									value={kind}
									onValueChange={(v) => setKind(v as AlertChannelKind)}
								>
									<SelectTrigger id="alc-kind">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="slack">Slack (Block Kit)</SelectItem>
										<SelectItem value="discord">Discord (Embed)</SelectItem>
										<SelectItem value="webhook">Generic JSON</SelectItem>
									</SelectContent>
								</Select>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="alc-url">Webhook URL</FieldLabel>
							<Input
								id="alc-url"
								type="url"
								value={url}
								onChange={(e) => {
									const next = e.target.value;
									setUrl(next);
									if (next.includes("hooks.slack.com")) setKind("slack");
									else if (next.includes("discord.com/api/webhooks"))
										setKind("discord");
								}}
								placeholder={
									channel
										? `Saved (${channel.url_hint}) — paste to replace`
										: "https://hooks.slack.com/services/…"
								}
							/>
							<FieldDescription>
								Encrypted with AES-GCM before saving. Never shown in full again.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel>Notify on</FieldLabel>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								{ALERT_EVENTS.map((ev) => (
									<label
										key={ev}
										htmlFor={`alc-ev-${ev}`}
										className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-sm hover:bg-muted/40"
									>
										<Checkbox
											id={`alc-ev-${ev}`}
											checked={events.includes(ev)}
											onCheckedChange={() => toggleEvent(ev)}
										/>
										<span>{ALERT_EVENT_LABELS[ev]}</span>
									</label>
								))}
							</div>
						</Field>
						<label
							htmlFor="alc-enabled"
							className="flex cursor-pointer items-center gap-2 text-sm"
						>
							<Checkbox
								id="alc-enabled"
								checked={enabled}
								onCheckedChange={(v) => setEnabled(Boolean(v))}
							/>
							<span>Channel enabled</span>
						</label>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								busy || !name.trim() || !events.length || (!channel && !url.trim())
							}
						>
							{busy && <Spinner />}
							Save channel
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
