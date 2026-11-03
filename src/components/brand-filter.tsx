import { OrgAvatar } from "@/components/org-avatar";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * The pick between every brand of the organization and one of them (the first is the
 * organization's own). Renders nothing with fewer than two brands.
 */
export function BrandFilter({
	brands,
	value,
	onChange,
	className,
	all = "All brands",
}: {
	brands: { id: string; name: string }[];
	value: string | undefined;
	onChange: (brand: string | undefined) => void;
	className?: string;
	/** The label of "every brand", or null when one must be picked. */
	all?: string | null;
}) {
	if (brands.length < 2) return null;
	const [own, ...rest] = brands;
	const picked = brands.find((b) => b.id === (value ?? (all === null ? own?.id : undefined)));
	return (
		<Select
			value={value ?? (all === null ? own?.id : "all")}
			onValueChange={(v) => onChange(v === "all" ? undefined : v)}
		>
			<SelectTrigger
				aria-label="Brand"
				className={cn("flex-1 sm:w-48 sm:flex-none", className)}
			>
				{/* Its label written out, so the server's first paint has it too. */}
				<SelectValue>
					{picked ? (
						<>
							<OrgAvatar
								name={picked.name}
								className="size-4 text-[9px]"
							/>
							{picked.name}
						</>
					) : (
						all
					)}
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="end">
				{all !== null && (
					<>
						<SelectItem value="all">{all}</SelectItem>
						<SelectSeparator />
					</>
				)}
				{own && (
					<SelectItem value={own.id}>
						<OrgAvatar
							name={own.name}
							className="size-4 text-[9px]"
						/>
						{own.name}
					</SelectItem>
				)}
				{rest.map((o) => (
					<SelectItem
						key={o.id}
						value={o.id}
					>
						<OrgAvatar
							name={o.name}
							className="size-4 text-[9px]"
						/>
						{o.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
