import type * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			className={cn("skeleton h-4", className)}
			{...props}
		/>
	);
}

export { Skeleton };
