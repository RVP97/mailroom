import { Bell, Bookmark, Plus, Trash2, Volume2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { readNotificationPrefs, writeNotificationPrefs } from "@/components/inbox/use-inbox-live";
import { Button } from "@/components/ui/button";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { deleteInboxViewFn, listInboxViewsFn, saveInboxViewFn } from "@/functions/inbox-power";
import { errorMessage } from "@/lib/errors";
import type { InboxViewFilters } from "@/server/db/schema";

type SavedView = Awaited<ReturnType<typeof listInboxViewsFn>>[number];

export function SavedViewsSection({
	currentFilters,
	hasActiveFilters,
	onApply,
}: {
	currentFilters: InboxViewFilters;
	hasActiveFilters: boolean;
	onApply: (filters: InboxViewFilters) => void;
}) {
	const [views, setViews] = useState<SavedView[]>([]);
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			setViews(await listInboxViewsFn());
		} catch {
			// Ignore on demo/sketch or restricted role
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	if (!views.length && !hasActiveFilters) return null;

	return (
		<div className="flex flex-col gap-0.5">
			<div className="flex items-center justify-between px-2 pb-1">
				<p className="eyebrow">Saved views</p>
				{hasActiveFilters && (
					<button
						type="button"
						onClick={() => setSaving(true)}
						title="Save current filters as a view"
						className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline"
					>
						<Plus className="size-3" />
						Save
					</button>
				)}
			</div>
			{views.map((v) => (
				<div
					key={v.id}
					className="group flex items-center gap-1 rounded-md hover:bg-accent"
				>
					<button
						type="button"
						onClick={() => onApply(v.filters)}
						className="flex h-7 min-w-0 flex-1 items-center gap-2 px-2 text-left text-xs text-muted-foreground hover:text-foreground"
					>
						<Bookmark className="size-3 shrink-0 text-faint" />
						<span className="truncate">{v.name}</span>
					</button>
					<button
						type="button"
						aria-label={`Delete view ${v.name}`}
						onClick={async () => {
							try {
								await deleteInboxViewFn({ data: { id: v.id } });
								toast.success("View removed");
								await load();
							} catch (error) {
								toast.error(await errorMessage(error));
							}
						}}
						className="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-70 hover:text-destructive focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 pointer-coarse:opacity-70"
					>
						<Trash2 className="size-3" />
					</button>
				</div>
			))}
			{saving && (
				<SaveViewDialog
					filters={currentFilters}
					onClose={() => setSaving(false)}
					onSaved={async () => {
						setSaving(false);
						await load();
					}}
				/>
			)}
		</div>
	);
}

function SaveViewDialog({
	filters,
	onClose,
	onSaved,
}: {
	filters: InboxViewFilters;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [shared, setShared] = useState(true);
	const [busy, setBusy] = useState(false);
	const summary = [
		filters.view && filters.view !== "open" ? `queue:${filters.view}` : null,
		filters.priority ? `priority:${filters.priority}` : null,
		filters.tag ? `tag:${filters.tag}` : null,
		filters.unread ? "unread" : null,
		filters.q ? `"${filters.q}"` : null,
	]
		.filter(Boolean)
		.join(" · ");

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							await saveInboxViewFn({
								data: { name: name.trim(), filters, shared },
							});
							toast.success(`Saved view "${name.trim()}"`);
							await onSaved();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Save inbox view</DialogTitle>
						<DialogDescription>
							Pin this filter combination in the Inbox sidebar
							{summary ? ` (${summary})` : ""}.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						<Field>
							<FieldLabel htmlFor="sv-name">View name</FieldLabel>
							<Input
								id="sv-name"
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="VIP Billing"
							/>
						</Field>
						<label
							htmlFor="sv-shared"
							className="flex cursor-pointer items-center gap-2 text-sm"
						>
							<Checkbox
								id="sv-shared"
								checked={shared}
								onCheckedChange={(v) => setShared(Boolean(v))}
							/>
							<span>Share with everyone in this organization</span>
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
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Save view
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function InboxNotificationToggle() {
	const [prefs, setPrefs] = useState({ desktop: false, sound: false });
	const [permission, setPermission] = useState<string>("default");

	useEffect(() => {
		setPrefs(readNotificationPrefs());
		if (typeof Notification !== "undefined") setPermission(Notification.permission);
	}, []);

	const toggleDesktop = async (next: boolean) => {
		if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
			const result = await Notification.requestPermission();
			setPermission(result);
			if (result !== "granted") {
				toast.error("Browser notification permission was not granted");
				return;
			}
		}
		writeNotificationPrefs({ desktop: next });
		setPrefs((p) => ({ ...p, desktop: next }));
		toast.success(next ? "Desktop alerts enabled" : "Desktop alerts off");
	};

	const toggleSound = (next: boolean) => {
		writeNotificationPrefs({ sound: next });
		setPrefs((p) => ({ ...p, sound: next }));
	};

	const active = prefs.desktop || prefs.sound;

	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					size="icon-sm"
					variant={active ? "secondary" : "ghost"}
					aria-label="Live alert preferences"
					title="Live alert preferences"
				>
					<Bell className="size-3.5" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-64 space-y-3 p-3"
			>
				<div>
					<p className="text-xs font-medium">Live browser alerts</p>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						Get notified immediately when a new live chat or email lands.
					</p>
				</div>
				<label
					htmlFor="inbox-notify-desktop"
					className="flex cursor-pointer items-center justify-between gap-2 text-xs"
				>
					<span className="flex items-center gap-1.5">
						<Bell className="size-3.5 text-muted-foreground" />
						Desktop notifications
					</span>
					<Checkbox
						id="inbox-notify-desktop"
						checked={prefs.desktop && permission === "granted"}
						onCheckedChange={(v) => void toggleDesktop(Boolean(v))}
					/>
				</label>
				<label
					htmlFor="inbox-notify-sound"
					className="flex cursor-pointer items-center justify-between gap-2 text-xs"
				>
					<span className="flex items-center gap-1.5">
						<Volume2 className="size-3.5 text-muted-foreground" />
						Subtle sound chime
					</span>
					<Checkbox
						id="inbox-notify-sound"
						checked={prefs.sound}
						onCheckedChange={(v) => toggleSound(Boolean(v))}
					/>
				</label>
			</PopoverContent>
		</Popover>
	);
}
