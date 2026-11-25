import { Check, Code2, Copy, Eye, Sparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Group, Labeled, SwitchRow } from "@/components/design-controls";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { aiEmailAssistFn } from "@/functions/ai";
import {
	type Block,
	type BlockCondition,
	type ConditionOp,
	type EmailDoc,
	renderEmail,
} from "@/lib/email-doc";
import { importMarkupToEmailDoc } from "@/lib/email-import";
import { errorMessage } from "@/lib/errors";
import { htmlToText } from "@/lib/template-fill";

const OP_LABELS: Record<ConditionOp, string> = {
	eq: "equals",
	neq: "does not equal",
	contains: "contains",
	exists: "is set",
	not_exists: "is empty",
};

/** Per-block conditional visibility editor (`show_if`) inside the Email Builder inspector. */
export function BlockVisibilityControl({
	condition,
	onChange,
}: {
	condition: BlockCondition | null | undefined;
	onChange: (next: BlockCondition | null) => void;
}) {
	const enabled = Boolean(condition);
	const current: BlockCondition = condition ?? { field: "plan", op: "eq", value: "pro" };
	const needsValue = current.op !== "exists" && current.op !== "not_exists";

	return (
		<Group title="Visibility">
			<SwitchRow
				label="Show conditionally"
				hint="Only render this block for contacts matching a property or segment."
				checked={enabled}
				onChange={(on) => onChange(on ? { field: "plan", op: "eq", value: "pro" } : null)}
			/>
			{enabled && (
				<div className="space-y-2.5 pt-1">
					<Labeled label="Contact property or 'segment'">
						<Input
							className="h-8 font-mono text-xs"
							value={current.field}
							placeholder="plan, FIRST_NAME, or segment"
							onChange={(e) => onChange({ ...current, field: e.target.value })}
						/>
					</Labeled>
					<Labeled label="Condition">
						<Select
							value={current.op}
							onValueChange={(v) => {
								const op = v as ConditionOp;
								onChange(
									op === "exists" || op === "not_exists"
										? { field: current.field, op }
										: { field: current.field, op, value: current.value ?? "" },
								);
							}}
						>
							<SelectTrigger className="h-8 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(Object.keys(OP_LABELS) as ConditionOp[]).map((op) => (
									<SelectItem
										key={op}
										value={op}
									>
										{OP_LABELS[op]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Labeled>
					{needsValue && (
						<Labeled label="Value">
							<Input
								className="h-8 text-xs"
								value={current.value ?? ""}
								placeholder="pro"
								onChange={(e) => onChange({ ...current, value: e.target.value })}
							/>
						</Labeled>
					)}
				</div>
			)}
		</Group>
	);
}

/** Small badge rendered on canvas blocks that carry a `show_if` condition. */
export function ConditionBadge({ condition }: { condition: BlockCondition }) {
	const label =
		condition.op === "exists"
			? `${condition.field} is set`
			: condition.op === "not_exists"
				? `${condition.field} is empty`
				: `${condition.field} ${OP_LABELS[condition.op]} "${condition.value ?? ""}"`;
	return (
		<span
			title={`Conditional block: ${label}`}
			className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-200"
		>
			<Eye className="size-2.5" />
			If {label}
		</span>
	);
}

/** Header button to import MJML or raw HTML into native editable blocks. */
export function ImportMarkupButton({
	doc,
	onImport,
}: {
	doc: EmailDoc;
	onImport: (blocks: Block[], mode: "replace" | "append") => void;
}) {
	const [open, setOpen] = useState(false);
	const [markup, setMarkup] = useState("");
	const preview = markup.trim() ? importMarkupToEmailDoc(markup, doc.theme) : null;

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-8 px-2 text-xs text-muted-foreground"
				onClick={() => setOpen(true)}
			>
				<Code2 className="size-3.5" />
				<span className="hidden lg:inline">Import HTML/MJML</span>
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-xl">
					<DialogHeader>
						<DialogTitle>Import HTML or MJML</DialogTitle>
						<DialogDescription>
							Paste MJML or email HTML (from React Email, Mailgun, or another editor)
							to convert headings, paragraphs, buttons, images and dividers into
							editable Mailroom blocks.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-3">
						<Field>
							<FieldLabel htmlFor="eb-import-src">Markup</FieldLabel>
							<Textarea
								id="eb-import-src"
								rows={10}
								className="font-mono text-xs"
								placeholder="<mj-section><mj-column><mj-text><h1>Hello</h1></mj-text><mj-button href='https://...'>Get started</mj-button></mj-column></mj-section>"
								value={markup}
								onChange={(e) => setMarkup(e.target.value)}
							/>
							{preview && (
								<FieldDescription>
									Detected <strong>{preview.format.toUpperCase()}</strong> ·{" "}
									{preview.count} block{preview.count === 1 ? "" : "s"} ready to
									import.
								</FieldDescription>
							)}
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="outline"
							disabled={!preview?.count}
							onClick={() => {
								if (!preview) return;
								onImport(preview.doc.blocks, "append");
								toast.success(`Appended ${preview.count} blocks`);
								setMarkup("");
								setOpen(false);
							}}
						>
							Append blocks
						</Button>
						<Button
							type="button"
							disabled={!preview?.count}
							onClick={() => {
								if (!preview) return;
								onImport(preview.doc.blocks, "replace");
								toast.success(`Imported ${preview.count} blocks`);
								setMarkup("");
								setOpen(false);
							}}
						>
							Replace email
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Header popover powered by the org's BYO-key AI settings: subject ideas & spam critique. */
export function EmailBuilderAiButton({ doc, subject }: { doc: EmailDoc; subject?: string }) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<"subjects" | "spam_check" | null>(null);
	const [subjects, setSubjects] = useState<string[]>([]);
	const [previews, setPreviews] = useState<string[]>([]);
	const [critique, setCritique] = useState<string>("");
	const [copied, setCopied] = useState<string | null>(null);

	const run = async (mode: "subjects" | "spam_check") => {
		setBusy(mode);
		try {
			const body = htmlToText(renderEmail(doc)).slice(0, 5000);
			const res = await aiEmailAssistFn({
				data: { mode, subject, body: body || subject || "Newsletter update" },
			});
			if (mode === "subjects") {
				setSubjects(res.subjects);
				setPreviews(res.previews);
				if (res.text && !res.subjects.length) setCritique(res.text);
			} else {
				setCritique(res.text);
			}
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const copy = async (val: string) => {
		await navigator.clipboard?.writeText(val).catch(() => {});
		setCopied(val);
		toast.success("Copied to clipboard");
		setTimeout(() => setCopied(null), 1500);
	};

	return (
		<Popover
			open={open}
			onOpenChange={setOpen}
		>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="h-8 px-2 text-xs text-brand hover:text-brand"
				>
					<Sparkles className="size-3.5" />
					<span className="hidden lg:inline">AI assist</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-80 space-y-3 p-3"
			>
				<div>
					<p className="text-xs font-semibold">AI email assistant</p>
					<p className="mt-0.5 text-[11px] text-muted-foreground">
						Uses your organization's BYO AI key from Settings → General.
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="flex-1 text-xs"
						disabled={busy !== null}
						onClick={() => void run("subjects")}
					>
						{busy === "subjects" ? (
							<Spinner className="size-3" />
						) : (
							<Sparkles className="size-3" />
						)}
						Subject ideas
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="flex-1 text-xs"
						disabled={busy !== null}
						onClick={() => void run("spam_check")}
					>
						{busy === "spam_check" && <Spinner className="size-3" />}
						Spam check
					</Button>
				</div>
				{subjects.length > 0 && (
					<div className="space-y-1">
						<p className="text-[11px] font-medium text-muted-foreground">
							Subject ideas (click to copy)
						</p>
						{subjects.map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => void copy(s)}
								className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left text-xs hover:bg-muted"
							>
								<span className="min-w-0 flex-1">{s}</span>
								{copied === s ? (
									<Check className="size-3 shrink-0 text-emerald-600" />
								) : (
									<Copy className="size-3 shrink-0 text-muted-foreground" />
								)}
							</button>
						))}
					</div>
				)}
				{previews.length > 0 && (
					<div className="space-y-1">
						<p className="text-[11px] font-medium text-muted-foreground">
							Preview text ideas
						</p>
						{previews.map((p) => (
							<button
								key={p}
								type="button"
								onClick={() => void copy(p)}
								className="flex w-full items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left text-xs hover:bg-muted"
							>
								<span className="min-w-0 flex-1 text-muted-foreground">{p}</span>
								<Copy className="size-3 shrink-0 text-muted-foreground" />
							</button>
						))}
					</div>
				)}
				{critique && (
					<div className="max-h-48 overflow-y-auto rounded-md bg-muted/50 p-2.5 text-xs whitespace-pre-wrap leading-relaxed">
						{critique}
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
