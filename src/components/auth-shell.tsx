import type { ReactNode } from "react";
import { AuthShowcase } from "@/components/auth-showcase";
import { Logo, Mark } from "@/components/logo";
import { cn } from "@/lib/utils";

/**
 * The page around sign-in and other one-question screens. With `showcase`, the form takes the
 * left half and Mailroom at work fills the right (from 1024 px; phones and tablets get the form
 * alone). Without it, the form sits centered on its own.
 */
export function AuthShell({
	children,
	footer,
	showcase = false,
	className,
}: {
	children: ReactNode;
	footer?: ReactNode;
	showcase?: boolean;
	className?: string;
}) {
	if (showcase)
		return (
			<div className="grid min-h-svh bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)]">
				<div className="flex min-h-svh flex-col px-6 py-6 sm:px-10 sm:py-8">
					<Logo />
					<div className="flex flex-1 items-center justify-center py-12">
						<div className={cn("w-full max-w-[360px]", className)}>{children}</div>
					</div>
					{footer && <div className="text-xs text-muted-foreground">{footer}</div>}
				</div>
				<div className="hidden p-2 pl-0 lg:block">
					<AuthShowcase className="h-full rounded-2xl" />
				</div>
			</div>
		);
	return (
		<div className="relative flex min-h-svh flex-col items-center justify-center overflow-hidden bg-canvas px-4 py-12">
			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-0 [background-image:radial-gradient(color-mix(in_oklch,var(--foreground)_9%,transparent)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_50%_45%_at_50%_40%,#000_10%,transparent_100%)]"
			/>
			<div
				className={cn(
					"relative flex w-full max-w-[380px] flex-col items-center",
					className,
				)}
			>
				<Mark className="mb-7 size-10" />
				<div className="w-full rounded-2xl bg-card p-7 shadow-raised">{children}</div>
				{footer && (
					<div className="mt-6 text-center text-xs text-muted-foreground">{footer}</div>
				)}
			</div>
		</div>
	);
}

/** A screen's title and the line under it. Centered in a card, left-aligned beside a showcase. */
export function AuthTitle({
	title,
	children,
	align = "center",
}: {
	title: ReactNode;
	children?: ReactNode;
	align?: "center" | "start";
}) {
	return (
		<div className={cn("mb-7", align === "center" && "text-center")}>
			<h1
				className={cn(
					"font-semibold tracking-[-0.02em] text-balance",
					align === "center" ? "text-lg" : "text-2xl",
				)}
			>
				{title}
			</h1>
			{children && (
				<p className="mt-2 text-base text-muted-foreground text-pretty">{children}</p>
			)}
		</div>
	);
}
