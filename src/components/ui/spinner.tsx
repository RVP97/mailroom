import type * as React from "react";
import { cn } from "@/lib/utils";

/** Eight ticks that fade around a circle, like macOS's: calmer than a spinning arc. */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			role="status"
			aria-label="Loading"
			className={cn("relative inline-block size-4 shrink-0", className)}
			{...props}
		>
			{Array.from({ length: 8 }, (_, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed ticks
					key={i}
					className="absolute top-0 left-[calc(50%-0.75px)] h-full w-[1.5px]"
					style={{ transform: `rotate(${i * 45}deg)` }}
				>
					<span
						className="block h-[30%] w-full rounded-full bg-current"
						style={{
							animation: "spinner-tick 0.8s linear infinite",
							animationDelay: `${-0.8 + i * 0.1}s`,
						}}
					/>
				</span>
			))}
		</span>
	);
}

export { Spinner };
