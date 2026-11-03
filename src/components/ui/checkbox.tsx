import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				"peer size-4 shrink-0 rounded-[4px] bg-background shadow-[0_0_0_1px_var(--border-strong),0_1px_1px_var(--shadow-color)] transition-[background-color,box-shadow] duration-150 outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground data-[state=checked]:shadow-[0_0_0_1px_var(--brand)] dark:bg-white/[0.04]",
				className,
			)}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current data-[state=checked]:animate-[pop-in_150ms_var(--ease-out)]"
			>
				<CheckIcon
					className="size-3"
					strokeWidth={3}
				/>
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
