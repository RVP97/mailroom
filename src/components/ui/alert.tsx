import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
	"relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg px-3.5 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
	{
		variants: {
			variant: {
				default:
					"bg-muted/70 text-foreground shadow-[inset_0_0_0_1px_var(--border)] dark:bg-white/[0.03]",
				destructive:
					"bg-destructive/[0.06] text-destructive shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--destructive)_22%,transparent)] *:data-[slot=alert-description]:text-destructive/85",
				warning:
					"bg-warning/[0.08] text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--warning)_28%,transparent)] [&>svg]:text-warning",
				success:
					"bg-success/[0.07] text-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--success)_24%,transparent)] [&>svg]:text-success",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
);

function Alert({
	className,
	variant,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
	return (
		<div
			data-slot="alert"
			role="alert"
			className={cn(alertVariants({ variant }), className)}
			{...props}
		/>
	);
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-title"
			className={cn("col-start-2 min-h-4 font-medium", className)}
			{...props}
		/>
	);
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="alert-description"
			className={cn(
				"col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
				className,
			)}
			{...props}
		/>
	);
}

export { Alert, AlertTitle, AlertDescription };
