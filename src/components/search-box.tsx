import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** Filters as you type (after a short pause); "/" jumps here from anywhere on the page. */
export function SearchBox({
	value,
	onChange,
	placeholder,
	className,
}: {
	value: string;
	onChange: (q: string) => void;
	placeholder: string;
	className?: string;
}) {
	const [q, setQ] = useState(value);
	const ref = useRef<HTMLInputElement>(null);
	const latest = useRef(onChange);
	latest.current = onChange;
	useEffect(() => setQ(value), [value]);
	useEffect(() => {
		if (q.trim() === value) return;
		const t = setTimeout(() => latest.current(q.trim()), 250);
		return () => clearTimeout(t);
	}, [q, value]);
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
			if (t?.closest("input, textarea, select, [contenteditable=true]")) return;
			e.preventDefault();
			ref.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	return (
		<form
			className={cn("relative flex-1", className)}
			onSubmit={(e) => {
				e.preventDefault();
				onChange(q.trim());
			}}
		>
			<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint" />
			<Input
				ref={ref}
				value={q}
				onChange={(e) => setQ(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setQ("");
						onChange("");
						e.currentTarget.blur();
					}
				}}
				placeholder={placeholder}
				className="pr-9 pl-8"
				aria-label={placeholder}
			/>
			{q ? (
				<button
					type="button"
					aria-label="Clear search"
					onClick={() => {
						setQ("");
						onChange("");
					}}
					className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-faint hover:bg-accent hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			) : (
				<Kbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 sm:inline-flex">
					/
				</Kbd>
			)}
		</form>
	);
}
