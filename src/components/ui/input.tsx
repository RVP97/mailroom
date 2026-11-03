import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
	return (
		<input
			type={type}
			data-slot="input"
			className={cn(
				"control h-8 w-full min-w-0 rounded-md px-2.5 text-[16px] text-foreground placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
				"file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium",
				className,
			)}
			{...props}
		/>
	);
}

export { Input };
