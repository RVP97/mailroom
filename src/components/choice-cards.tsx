import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A choice between a few options, each a card with a title and a line of what it means. */
export function ChoiceCards<T extends string>({
	name,
	value,
	onChange,
	options,
	className,
}: {
	name: string;
	value: T;
	onChange: (v: T) => void;
	options: { value: T; title: ReactNode; description: ReactNode }[];
	className?: string;
}) {
	return (
		<div
			role="radiogroup"
			className={cn("grid gap-2 sm:grid-cols-2", className)}
		>
			{options.map((o) => {
				const checked = o.value === value;
				return (
					<label
						key={o.value}
						className={cn(
							"relative flex cursor-pointer gap-2.5 rounded-lg p-3 transition-[box-shadow,background-color] duration-150",
							checked
								? "bg-brand/[0.04] shadow-[0_0_0_1.5px_var(--brand)]"
								: "shadow-[0_0_0_1px_var(--border-strong)] hover:bg-accent/50",
						)}
					>
						<input
							type="radio"
							name={name}
							value={o.value}
							checked={checked}
							onChange={() => onChange(o.value)}
							className="peer sr-only"
						/>
						<span
							className={cn(
								"mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full transition-[box-shadow,background-color] duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background",
								checked
									? "bg-brand shadow-none"
									: "bg-background shadow-[inset_0_0_0_1px_var(--border-strong)]",
							)}
						>
							<span
								className={cn(
									"size-1.5 rounded-full bg-white transition-transform duration-150 ease-out",
									checked ? "scale-100" : "scale-0",
								)}
							/>
						</span>
						<span className="min-w-0">
							<span className="block text-sm font-medium">{o.title}</span>
							<span className="mt-0.5 block text-xs text-muted-foreground">
								{o.description}
							</span>
						</span>
					</label>
				);
			})}
		</div>
	);
}
