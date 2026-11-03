import type * as React from "react";
import { cn } from "@/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
	return (
		<kbd
			data-slot="kbd"
			className={cn(
				"pointer-events-none inline-flex h-[18px] w-fit min-w-[18px] items-center justify-center gap-0.5 rounded-[4px] bg-background px-1 font-sans text-[11px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong),0_1px_0_var(--border)] select-none dark:bg-white/[0.04]",
				"[&_svg:not([class*='size-'])]:size-3",
				"[[data-slot=tooltip-content]_&]:bg-white/15 [[data-slot=tooltip-content]_&]:text-primary-foreground [[data-slot=tooltip-content]_&]:shadow-none",
				className,
			)}
			{...props}
		/>
	);
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<kbd
			data-slot="kbd-group"
			className={cn("inline-flex items-center gap-0.5", className)}
			{...props}
		/>
	);
}

export { Kbd, KbdGroup };
