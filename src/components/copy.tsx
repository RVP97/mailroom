import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Copy to the clipboard and say so for a moment. */
export function useCopy(timeout = 1400) {
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return {
		copied,
		copy: (value: string) => {
			void navigator.clipboard?.writeText(value);
			setCopied(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setCopied(false), timeout);
		},
	};
}

/** The copy icon that cross-fades into a check (scale, opacity and blur, no layout shift). */
export function CopyIcon({ copied, className }: { copied: boolean; className?: string }) {
	const swap =
		"absolute inset-0 size-full transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
	return (
		<span className={cn("relative inline-block size-3.5 shrink-0", className)}>
			<Copy
				className={cn(
					swap,
					copied ? "scale-25 opacity-0 blur-[4px]" : "scale-100 opacity-100",
				)}
			/>
			<Check
				className={cn(
					swap,
					"text-success",
					copied ? "scale-100 opacity-100" : "scale-25 opacity-0 blur-[4px]",
				)}
				strokeWidth={2.5}
			/>
		</span>
	);
}

/** A square button that copies a value. */
export function CopyButton({
	value,
	className,
	label = "Copy",
}: {
	value: string;
	className?: string;
	label?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : label}
			onClick={(e) => {
				e.stopPropagation();
				copy(value);
			}}
			className={cn(
				"pressable relative inline-flex size-6 shrink-0 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground before:absolute before:-inset-1.5",
				className,
			)}
		>
			<CopyIcon copied={copied} />
		</button>
	);
}

/** A value in mono that copies when clicked, with the copy icon showing on hover. */
export function CopyText({
	value,
	display,
	className,
}: {
	value: string;
	display?: string;
	className?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			title={copied ? "Copied" : `Copy ${value}`}
			onClick={(e) => {
				e.stopPropagation();
				copy(value);
			}}
			className={cn(
				"group/copy inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1.5 rounded text-left font-mono text-xs text-foreground/90 hover:text-foreground",
				className,
			)}
		>
			<span className="truncate">{display ?? value}</span>
			<CopyIcon
				copied={copied}
				className={cn(
					"size-3 text-faint transition-opacity duration-150",
					copied
						? "opacity-100"
						: "opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
				)}
			/>
		</button>
	);
}

/**
 * A field's value (an address, a subject) that copies whole on click: a soft highlight and the copy
 * icon on hover, a check and «Copied» once copied. The cursor stays the usual hand; the icon says
 * what the click does.
 */
export function CopyValue({
	value,
	children,
	className,
}: {
	value: string;
	children?: ReactNode;
	className?: string;
}) {
	const { copied, copy } = useCopy();
	const [hover, setHover] = useState(false);
	// «Copied» stays up after the click (Radix closes on press) until the pointer moves away.
	const [pressed, setPressed] = useState(false);
	const long = value.length > 32;
	return (
		<Tooltip
			open={hover || (copied && pressed)}
			onOpenChange={setHover}
		>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						copy(value);
						setPressed(true);
					}}
					onPointerLeave={() => {
						setHover(false);
						setPressed(false);
					}}
					className={cn(
						"group/copy -mx-1.5 inline-flex max-w-[calc(100%+0.75rem)] min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 -my-0.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
						className,
					)}
				>
					<span className="truncate">{children ?? value}</span>
					<CopyIcon
						copied={copied}
						className={cn(
							"size-3 text-faint transition-opacity duration-150",
							copied
								? "opacity-100"
								: "opacity-0 group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
						)}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent className={cn(long && !copied && "max-w-96 break-all")}>
				{copied ? (
					"Copied"
				) : long ? (
					<span className="flex flex-col gap-0.5">
						<span className="font-normal">{value}</span>
						<span className="opacity-60">Click to copy</span>
					</span>
				) : (
					"Click to copy"
				)}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * A labelled value to paste into another app's settings (a host, a port, a header): a read-only
 * box that copies whole on click, like a settings field with a copy button.
 */
export function CopyField({
	label,
	value,
	hint,
	className,
}: {
	label: ReactNode;
	value: string;
	hint?: ReactNode;
	className?: string;
}) {
	const { copied, copy } = useCopy();
	return (
		<div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
			<span className="text-sm text-muted-foreground">{label}</span>
			<button
				type="button"
				title={copied ? "Copied" : `Copy ${value}`}
				onClick={() => copy(value)}
				className="group/copy flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg bg-muted/70 pr-2.5 pl-3 text-left font-mono text-[13px] text-foreground shadow-[inset_0_0_0_1px_var(--border)] transition-colors duration-150 hover:bg-muted hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="min-w-0 flex-1 truncate">{value}</span>
				<CopyIcon
					copied={copied}
					className="text-faint transition-colors group-hover/copy:text-foreground"
				/>
			</button>
			{hint && <div className="text-xs text-muted-foreground">{hint}</div>}
		</div>
	);
}

/** A short value in a chip that copies on click (another port, a header name). */
export function CopyChip({ value, className }: { value: string; className?: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			title={copied ? "Copied" : `Copy ${value}`}
			onClick={() => copy(value)}
			className={cn(
				"pressable inline-flex h-5 cursor-pointer items-center gap-1 rounded-md bg-muted px-1.5 align-middle font-mono text-[11px] text-foreground/90 shadow-[inset_0_0_0_1px_var(--border)] hover:text-foreground",
				className,
			)}
		>
			{value}
			<CopyIcon
				copied={copied}
				className="size-3 text-faint"
			/>
		</button>
	);
}
