import { cva, type VariantProps } from "class-variance-authority";
import { Toggle as TogglePrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const toggleVariants = cva(
	"inline-flex cursor-default items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-150 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=on]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default: "hover:bg-accent data-[state=on]:bg-accent",
				outline:
					"data-[state=on]:bg-background data-[state=on]:shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:data-[state=on]:bg-white/[0.1]",
			},
			size: {
				default: "h-[26px] min-w-8 px-2.5",
				sm: "h-[22px] min-w-7 px-2 text-xs",
				lg: "h-8 min-w-9 px-3",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Toggle({
	className,
	variant,
	size,
	...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
	return (
		<TogglePrimitive.Root
			data-slot="toggle"
			className={cn(toggleVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Toggle, toggleVariants };
