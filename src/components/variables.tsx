import { Braces, Trash2 } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
	CHIP,
	CONTACT_VARIABLES,
	chipNode,
	labelOf,
	TAG,
	textNodes,
	textWithTags,
	type Variable,
	type VariableGroup,
} from "@/lib/merge-tags";
import { cn } from "@/lib/utils";

/**
 * Variables as people see them, like Loops' and Customer.io's editors: a chip with a plain name
 * ("First name") where the email says {{{FIRST_NAME|there}}}; click one to set what shows when
 * the contact has none, or take it out. A { } menu adds them.
 */

export const DEFAULT_GROUPS: VariableGroup[] = [{ label: "Contact", items: CONTACT_VARIABLES }];

/** The { } menu: the variables to add, grouped. */
export function VariableMenu({
	groups,
	onPick,
	children,
	align = "end",
}: {
	groups: VariableGroup[];
	onPick: (v: Variable) => void;
	children: ReactNode;
	align?: "start" | "end";
}) {
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
			<DropdownMenuContent
				align={align}
				className="max-h-80 w-64"
				onCloseAutoFocus={(e) => e.preventDefault()}
			>
				{groups.map((g, i) => (
					<DropdownMenuGroup key={g.label}>
						{i > 0 && <DropdownMenuSeparator />}
						<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
							{g.label}
						</DropdownMenuLabel>
						{g.items.map((v) => (
							<DropdownMenuItem
								key={v.key}
								onMouseDown={(e) => e.preventDefault()}
								onSelect={() => onPick(v)}
								className="gap-2"
							>
								<span className="mt-chip pointer-events-none">{v.label}</span>
								{v.hint && (
									<span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
										{v.hint}
									</span>
								)}
							</DropdownMenuItem>
						))}
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The popover on a clicked chip: its fallback, or taking it out. */
export function ChipPopover({
	chip,
	groups,
	onClose,
	onChanged,
}: {
	chip: HTMLElement | null;
	groups?: VariableGroup[];
	onClose: () => void;
	/** After the chip changed or went: the field saves. */
	onChanged: () => void;
}) {
	const [fallback, setFallback] = useState("");
	const fid = useId();
	const anchor = useRef<HTMLElement | null>(null);
	anchor.current = chip;
	useEffect(() => {
		if (!chip) return;
		setFallback(chip.dataset.fallback ?? "");
		chip.dataset.active = "";
		return () => {
			delete chip.dataset.active;
		};
	}, [chip]);
	const key = chip?.dataset.key ?? "";
	const label = labelOf(key, groups);
	const save = () => {
		if (!chip) return;
		const f = fallback.replace(/[{}]/g, "").trim();
		if (f) chip.dataset.fallback = f;
		else delete chip.dataset.fallback;
		chip.title = f ? `${label}, or “${f}” when missing` : label;
		onChanged();
		onClose();
	};
	return (
		<Popover
			open={!!chip}
			onOpenChange={(o) => !o && onClose()}
		>
			<PopoverPrimitive.Anchor virtualRef={anchor as React.RefObject<HTMLElement>} />
			<PopoverContent
				className="w-72 p-0"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<form
					className="flex flex-col gap-3 p-3"
					onSubmit={(e) => {
						e.preventDefault();
						save();
					}}
				>
					<div className="flex items-center gap-2">
						<span className="mt-chip">{label}</span>
						<span className="truncate font-mono text-[11px] text-muted-foreground">
							{key}
						</span>
					</div>
					<div className="flex flex-col gap-1.5 text-xs">
						<label
							htmlFor={fid}
							className="font-medium text-foreground"
						>
							When it's missing, show
						</label>
						<Input
							id={fid}
							autoFocus
							value={fallback}
							onChange={(e) => setFallback(e.target.value)}
							placeholder="Nothing"
							className="h-8"
						/>
					</div>
					<div className="flex items-center justify-between">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="-ml-2 text-muted-foreground hover:text-destructive"
							onClick={() => {
								chip?.remove();
								onChanged();
								onClose();
							}}
						>
							<Trash2 />
							Remove
						</Button>
						<Button
							type="submit"
							size="sm"
						>
							Done
						</Button>
					</div>
				</form>
			</PopoverContent>
		</Popover>
	);
}

/** Text with its variables as chips, read only (a subject line in a preview). */
export function TagText({ text, groups }: { text: string; groups?: VariableGroup[] }) {
	const parts: ReactNode[] = [];
	let i = 0;
	for (const m of text.matchAll(TAG)) {
		if (m.index > i) parts.push(text.slice(i, m.index));
		parts.push(
			<span
				key={m.index}
				className={CHIP}
			>
				{labelOf(m[1] as string, groups)}
			</span>,
		);
		i = m.index + m[0].length;
	}
	if (i < text.length) parts.push(text.slice(i));
	return <>{parts}</>;
}

/** Puts nodes where the caret is (or at the end), and the caret after them. */
function insertAtCaret(el: HTMLElement, nodes: Node[], range: Range | null) {
	const sel = window.getSelection();
	let r = range;
	if (!r || !el.contains(r.commonAncestorContainer)) {
		r = document.createRange();
		r.selectNodeContents(el);
		r.collapse(false);
	}
	r.deleteContents();
	const frag = document.createDocumentFragment();
	for (const n of nodes) frag.appendChild(n);
	const last = frag.lastChild;
	r.insertNode(frag);
	if (last && sel) {
		const after = document.createRange();
		after.setStartAfter(last);
		after.collapse(true);
		sel.removeAllRanges();
		sel.addRange(after);
	}
}

/**
 * A one-line field (a subject) whose variables show as chips. Its value is the text with the
 * tags, as stored.
 */
export function TagField({
	id,
	value,
	onChange,
	placeholder,
	groups = DEFAULT_GROUPS,
	disabled,
	className,
	"aria-label": ariaLabel,
}: {
	id?: string;
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
	groups?: VariableGroup[];
	disabled?: boolean;
	className?: string;
	"aria-label"?: string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const range = useRef<Range | null>(null);
	const [chip, setChip] = useState<HTMLElement | null>(null);
	// The field shows the value unless it already says it (while typing).
	useLayoutEffect(() => {
		const el = ref.current;
		if (el && textWithTags(el) !== value)
			el.replaceChildren(...textNodes(document, value, groups));
	}, [value, groups]);
	const emit = () => {
		const el = ref.current;
		if (el) onChange(textWithTags(el));
	};
	const keep = () => {
		const s = window.getSelection();
		if (s?.rangeCount && ref.current?.contains(s.anchorNode))
			range.current = s.getRangeAt(0).cloneRange();
	};
	return (
		<div
			className={cn(
				"control group/tf relative flex h-8 w-full min-w-0 items-center rounded-md pr-1 text-[16px] md:text-sm",
				disabled && "pointer-events-none opacity-50",
				className,
			)}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: a field with chips can't be an input */}
			<div
				ref={ref}
				id={id}
				role="textbox"
				tabIndex={disabled ? -1 : 0}
				aria-label={ariaLabel}
				aria-placeholder={placeholder}
				contentEditable={!disabled}
				suppressContentEditableWarning
				spellCheck
				data-placeholder={placeholder}
				data-empty={value ? undefined : ""}
				className="tag-field min-w-0 flex-1 overflow-hidden px-2.5 leading-8 whitespace-nowrap outline-none [scrollbar-width:none]"
				onInput={emit}
				onKeyUp={keep}
				onMouseUp={keep}
				onBlur={keep}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.preventDefault();
				}}
				onPaste={(e) => {
					e.preventDefault();
					const text = e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " ");
					keep();
					if (ref.current)
						insertAtCaret(
							ref.current,
							textNodes(document, text, groups),
							range.current,
						);
					emit();
				}}
				onClick={(e) => {
					const c = (e.target as HTMLElement).closest<HTMLElement>(`.${CHIP}`);
					if (c) setChip(c);
				}}
			/>
			<VariableMenu
				groups={groups}
				onPick={(v) => {
					const el = ref.current;
					if (!el) return;
					el.focus();
					insertAtCaret(
						el,
						[
							chipNode(document, v.key, v.fallback, v.label),
							document.createTextNode(" "),
						],
						range.current,
					);
					keep();
					emit();
				}}
			>
				<button
					type="button"
					aria-label="Add a variable"
					title="Add a variable"
					onMouseDown={keep}
					className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
				>
					<Braces className="size-3.5" />
				</button>
			</VariableMenu>
			<ChipPopover
				chip={chip}
				groups={groups}
				onClose={() => setChip(null)}
				onChanged={emit}
			/>
		</div>
	);
}
