import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { saveSegmentFn, saveTopicFn } from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";

/**
 * Segments and topics: the dialogs that make them, and a picker that can make one on the spot,
 * so a form, broadcast or automation never sends you away to Contacts first.
 */

const NONE = "__none";
const NEW = "__new";

export function ListSelect({
	kind,
	brand,
	id,
	value,
	onChange,
	items,
	none,
	noneDisabled,
	canCreate = true,
	disabled,
	ariaLabel,
}: {
	kind: "segment" | "topic";
	/** The brand it's made in (null/undefined: the active organization). */
	brand?: string | null;
	id?: string;
	/** The chosen id, or "" for none. */
	value: string;
	onChange: (id: string) => void;
	items: { id: string; name: string }[];
	/** What "none" reads as ("No segment", "Any segment", "Pick a segment"). */
	none: string;
	/** "None" can't be picked: one is needed. */
	noneDisabled?: boolean;
	canCreate?: boolean;
	disabled?: boolean;
	ariaLabel?: string;
}) {
	const [creating, setCreating] = useState(false);
	// What was just made shows at once, before the page's data comes back with it.
	const [made, setMade] = useState<{ id: string; name: string }[]>([]);
	const all = [...items, ...made.filter((m) => !items.some((i) => i.id === m.id))];
	const picked = (newId: string, name?: string) => {
		if (name) setMade((m) => [...m, { id: newId, name }]);
		onChange(newId);
	};
	const pendingName = useRef("");
	return (
		<>
			<Select
				disabled={disabled}
				value={value || NONE}
				onValueChange={(v) => {
					if (v === NEW) setCreating(true);
					else onChange(v === NONE ? "" : v);
				}}
			>
				<SelectTrigger
					id={id}
					aria-label={ariaLabel}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem
						value={NONE}
						disabled={noneDisabled}
					>
						{none}
					</SelectItem>
					{all.length > 0 && <SelectSeparator />}
					{all.map((s) => (
						<SelectItem
							key={s.id}
							value={s.id}
						>
							{s.name}
						</SelectItem>
					))}
					{canCreate && (
						<>
							<SelectSeparator />
							<SelectItem value={NEW}>
								<Plus />
								New {kind}…
							</SelectItem>
						</>
					)}
				</SelectContent>
			</Select>
			{kind === "segment" ? (
				<NameDialog
					open={creating}
					onOpenChange={setCreating}
					title="New segment"
					initial=""
					save={(name) => {
						pendingName.current = name;
						return saveSegmentFn({ data: { brand: brand ?? undefined, name } });
					}}
					onSaved={(newId) => picked(newId, pendingName.current)}
				/>
			) : (
				<TopicDialog
					open={creating}
					onOpenChange={setCreating}
					brand={brand ?? undefined}
					onCreated={(newId, name) => picked(newId, name)}
				/>
			)}
		</>
	);
}

export function NameDialog({
	open,
	onOpenChange,
	title,
	initial,
	save,
	onSaved,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	title: string;
	initial: string;
	save: (name: string) => Promise<{ id: string }>;
	/** Runs with what was saved, after the page reloaded its data. */
	onSaved?: (id: string) => void;
}) {
	const router = useRouter();
	const [name, setName] = useState(initial);
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (v) setName(initial);
				onOpenChange(v);
			}}
		>
			<DialogContent
				className="sm:max-w-sm"
				onOpenAutoFocus={() => setName(initial)}
			>
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						// It can open over another form: React would hand it this submit too.
						e.stopPropagation();
						setBusy(true);
						try {
							const saved = await save(name.trim());
							onOpenChange(false);
							await router.invalidate();
							onSaved?.(saved.id);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>{title}</DialogTitle>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="name-dialog">Name</FieldLabel>
							<Input
								id="name-dialog"
								required
								autoFocus
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export function TopicDialog({
	open,
	onOpenChange,
	brand,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	brand?: string;
	/** Runs with the new topic, after the page reloaded its data. */
	onCreated?: (id: string, name: string) => void;
}) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [mode, setMode] = useState<"opt_out" | "opt_in">("opt_out");
	const [visibility, setVisibility] = useState<"public" | "private">("public");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						// It can open over another form: React would hand it this submit too.
						e.stopPropagation();
						setBusy(true);
						try {
							const saved = await saveTopicFn({
								data: {
									brand,
									name: name.trim(),
									description: description.trim() || null,
									default_subscription: mode,
									visibility,
								},
							});
							onOpenChange(false);
							setName("");
							setDescription("");
							await router.invalidate();
							onCreated?.(saved.id, name.trim());
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>New topic</DialogTitle>
						<DialogDescription>Who gets it can't change later.</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="topic-name">Name</FieldLabel>
							<Input
								id="topic-name"
								required
								autoFocus
								placeholder="Monthly newsletter"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="topic-description">Description</FieldLabel>
							<Input
								id="topic-description"
								placeholder="Optional, shown on the preferences page"
								value={description}
								onChange={(e) => setDescription(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel>Who gets it</FieldLabel>
							<Select
								value={mode}
								onValueChange={(v) => setMode(v as typeof mode)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="opt_out">
										Everyone, until they leave it
									</SelectItem>
									<SelectItem value="opt_in">Only who opts in</SelectItem>
								</SelectContent>
							</Select>
						</Field>
						<Field>
							<FieldLabel>On the preferences page</FieldLabel>
							<Select
								value={visibility}
								onValueChange={(v) => setVisibility(v as typeof visibility)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="public">
										Shown, so people can choose
									</SelectItem>
									<SelectItem value="private">Hidden</SelectItem>
								</SelectContent>
							</Select>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Create topic
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
