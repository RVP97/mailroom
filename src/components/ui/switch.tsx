import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			data-ph
			className={cn(
				"peer inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 ease-out outline-none disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=unchecked]:bg-[oklch(0.2_0.01_265/0.16)] dark:data-[state=unchecked]:bg-white/15",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block size-[14px] rounded-full bg-white shadow-[0_1px_2px_oklch(0_0_0/0.2),0_0_0_0.5px_oklch(0_0_0/0.04)] transition-transform duration-200 ease-out data-[state=checked]:translate-x-[12px] data-[state=unchecked]:translate-x-0"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
