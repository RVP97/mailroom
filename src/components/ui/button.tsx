import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"pressable relative inline-flex shrink-0 cursor-default items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
	{
		variants: {
			variant: {
				default:
					"bg-primary text-primary-foreground shadow-primary hover:bg-primary/88 [&_svg]:opacity-80",
				brand: "bg-brand text-brand-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.18),0_0_0_1px_var(--brand),0_1px_2px_var(--shadow-color-strong)] hover:bg-brand/90",
				destructive:
					"bg-destructive text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.16),0_0_0_1px_var(--destructive),0_1px_2px_var(--shadow-color-strong)] hover:bg-destructive/90",
				outline:
					"bg-background text-foreground shadow-button hover:bg-muted dark:bg-white/[0.045] dark:hover:bg-white/[0.08] [&_svg]:text-muted-foreground",
				secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
				ghost: "text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
				link: "h-auto px-0 text-brand underline-offset-4 hover:underline",
			},
			size: {
				default: "h-8 px-3 has-[>svg:first-child]:pl-2.5",
				xs: "h-6 gap-1 rounded-sm px-2 text-xs has-[>svg:first-child]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
				sm: "h-7 gap-1 px-2.5 has-[>svg:first-child]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
				lg: "h-9 px-4 text-base has-[>svg:first-child]:pl-3.5",
				xl: "h-10 rounded-lg px-4 text-base",
				icon: "size-8",
				"icon-xs": "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
				"icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
				"icon-lg": "size-9",
			},
		},
		defaultVariants: {
			variant: "default",
			size: "default",
		},
	},
);

function Button({
	className,
	variant = "default",
	size = "default",
	asChild = false,
	...props
}: React.ComponentProps<"button"> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	}) {
	const Comp = asChild ? Slot.Root : "button";
	return (
		<Comp
			data-slot="button"
			data-variant={variant}
			data-size={size}
			className={cn(buttonVariants({ variant, size, className }))}
			{...props}
		/>
	);
}

export { Button, buttonVariants };
