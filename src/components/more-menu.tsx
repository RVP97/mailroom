import type { LucideIcon } from "lucide-react";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { useCopy } from "@/components/copy";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A record's "more" menu: the three dots at the end of its header, like every record page's. */
export function MoreMenu({ children, label = "More" }: { children: ReactNode; label?: string }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label={label}
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				className="min-w-48"
			>
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** A menu item that copies a value. */
export function CopyMenuItem({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	const { copy } = useCopy();
	return (
		<DropdownMenuItem
			onSelect={() => {
				copy(value);
				toast.success("Copied");
			}}
		>
			<Icon />
			{label}
		</DropdownMenuItem>
	);
}
