import * as React from "react";
import { backgroundColor, useOrgLogo, useOrgLogoBackground } from "@/lib/org-logo";
import { cn } from "@/lib/utils";

const HUES = [257, 200, 160, 70, 25, 310, 285, 120];

function hash(s: string) {
	let h = 0;
	for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
	return Math.abs(h);
}

/** An organization's hue, from its name: its avatar's color and the wash when switching to it. */
export const orgHue = (name: string) => HUES[hash(name) % HUES.length] ?? 257;

/**
 * An organization's logo, or its initial on a tile whose color comes from its name, so each one
 * is easy to tell apart. Pass `id` to show a logo just changed in Settings before it's saved.
 */
export function OrgAvatar({
	name,
	id,
	logo,
	background,
	className,
	...props
}: {
	name: string;
	id?: string;
	/** Its logo's URL (Me's organizations[].logo.url). */
	logo?: string | null;
	/** What's behind the logo (Me's organizations[].logo.background). */
	background?: string | null;
	className?: string;
} & React.ComponentProps<"span">) {
	const hue = orgHue(name);
	const src = useOrgLogo(id, logo);
	const bg = backgroundColor(useOrgLogoBackground(id, background));
	const [broken, setBroken] = React.useState<string | null>(null);
	if (src && broken !== src)
		return (
			<span
				aria-hidden="true"
				data-ph
				{...props}
				className={cn(
					"flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md",
					className,
				)}
				style={bg ? { background: bg } : undefined}
			>
				{/* On a chosen background, a transparent logo gets a little room around it. */}
				<img
					src={src}
					alt=""
					draggable={false}
					onError={() => setBroken(src)}
					className={cn("size-full object-contain", bg && "p-[12%]")}
				/>
			</span>
		);
	return (
		<span
			aria-hidden="true"
			data-ph
			{...props}
			className={cn(
				"flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.2),inset_0_0_0_1px_oklch(0_0_0/0.08)]",
				className,
			)}
			style={{
				background: `linear-gradient(180deg, oklch(0.66 0.14 ${hue}), oklch(0.55 0.15 ${hue}))`,
			}}
		>
			{name.trim().charAt(0).toUpperCase() || "·"}
		</span>
	);
}

/** A person's initials in a quiet circle. */
export function UserAvatar({ name, className }: { name: string; className?: string }) {
	const initials =
		name
			.replace(/@.*/, "")
			.split(/[\s._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((p) => p.charAt(0).toUpperCase())
			.join("") || "·";
	return (
		<span
			aria-hidden="true"
			data-ph
			className={cn(
				"flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
				className,
			)}
		>
			{initials}
		</span>
	);
}
