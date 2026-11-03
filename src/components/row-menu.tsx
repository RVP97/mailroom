import { useRouter } from "@tanstack/react-router";
import { Copy, CopyPlus, MoreHorizontal, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/**
 * A list row's ⋯ menu. It sits above the row's full-row link (which covers the row with
 * after:absolute), so clicking it opens the menu instead of the record.
 */
export function RowMenu({
	label,
	children,
	className,
}: {
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<DropdownMenu modal={false}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={label}
					className={cn(
						"relative z-10 size-8 text-muted-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground",
						className,
					)}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-40"
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The usual row menu: Duplicate, Copy ID, then Delete (each only when given). */
export function RowActions({
	label,
	id,
	onDuplicate,
	onDelete,
	deleteLabel = "Delete",
	children,
}: {
	label: string;
	id?: string;
	onDuplicate?: () => void;
	onDelete?: () => void;
	deleteLabel?: string;
	children?: ReactNode;
}) {
	return (
		<RowMenu label={label}>
			{children}
			{onDuplicate && (
				<DropdownMenuItem onSelect={onDuplicate}>
					<CopyPlus />
					Duplicate
				</DropdownMenuItem>
			)}
			{id && (
				<DropdownMenuItem
					onSelect={() => {
						void navigator.clipboard?.writeText(id);
						toast.success("ID copied");
					}}
				>
					<Copy />
					Copy ID
				</DropdownMenuItem>
			)}
			{onDelete && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onSelect={onDelete}
					>
						<Trash2 />
						{deleteLabel}
					</DropdownMenuItem>
				</>
			)}
		</RowMenu>
	);
}

/**
 * Runs a row action, toasts how it went and reloads the list. `after` gets the result (to open
 * a duplicate, say).
 */
export function useRowAction() {
	const router = useRouter();
	return async <T,>(fn: () => Promise<T>, done: string, after?: (result: T) => unknown) => {
		try {
			const result = await fn();
			toast.success(done);
			await router.invalidate();
			await after?.(result);
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};
}
