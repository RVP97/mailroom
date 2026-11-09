import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export { CopyButton, CopyText } from "@/components/copy";

/**
 * The column every page sits in. Narrower pages (a className like max-w-4xl) keep the same left
 * edge, so titles don't jump sideways between pages.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 md:px-10 md:pt-9">
			<div className={cn("flex w-full flex-col gap-6", className)}>{children}</div>
		</div>
	);
}

/** A page's title row: where it sits (for detail pages), the title, a line of what it is, its actions. */
export function PageHeader({
	title,
	description,
	actions,
	crumbs,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	crumbs?: { label: string; to: LinkProps["to"]; search?: LinkProps["search"] }[];
	className?: string;
}) {
	return (
		<header className={cn("flex flex-col gap-1", className)}>
			{crumbs && (
				<nav
					aria-label="Breadcrumb"
					className="mb-1 flex items-center gap-1 text-sm text-muted-foreground"
				>
					{crumbs.map((c) => (
						<span
							key={c.label}
							className="flex items-center gap-1"
						>
							<Link
								to={c.to}
								search={c.search}
								className="rounded-sm transition-colors hover:text-foreground"
							>
								{c.label}
							</Link>
							<ChevronRight className="size-3.5 text-faint" />
						</span>
					))}
				</nav>
			)}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="text-2xl font-semibold tracking-[-0.018em]">{title}</h1>
					{description && (
						<p className="mt-1 max-w-2xl text-base text-muted-foreground">
							{description}
						</p>
					)}
				</div>
				{actions && (
					// Filters that don't fit on one line wrap instead of widening the page.
					<div className="flex min-w-0 flex-wrap items-center gap-2 sm:shrink-0 sm:pt-0.5">
						{actions}
					</div>
				)}
			</div>
		</header>
	);
}

/** A titled group of content inside a page. */
export function Section({
	title,
	description,
	actions,
	children,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<section className={cn("flex flex-col gap-3", className)}>
			{/* On phones the actions go under a description, which otherwise wraps a few words a line. */}
			<div
				className={cn(
					"flex items-end justify-between gap-4",
					description &&
						"max-sm:flex-col max-sm:items-start max-sm:justify-start max-sm:gap-2",
				)}
			>
				<div className="min-w-0">
					<h2 className="text-base font-semibold">{title}</h2>
					{description && (
						<p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
					)}
				</div>
				{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
			</div>
			{children}
		</section>
	);
}

/**
 * The surface a table sits on. On phones in portrait it runs edge to edge, with a hairline above
 * and below, like a phone's own lists: the card's inset and rounded corners would take 32px of a
 * 390px screen away from what the rows say.
 */
export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div
			className={cn(
				"overflow-hidden rounded-xl bg-card shadow-card max-sm:-mx-4 max-sm:rounded-none max-sm:shadow-[0_-1px_0_var(--border),0_1px_0_var(--border)]",
				className,
			)}
		>
			{children}
		</div>
	);
}

/** Label and value rows, Stripe-style. */
export function DetailList({ children, className }: { children: ReactNode; className?: string }) {
	return <dl className={cn("grid gap-0 text-sm", className)}>{children}</dl>;
}

export function Detail({
	label,
	children,
	className,
}: {
	label: ReactNode;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] items-baseline gap-3 py-1.5",
				className,
			)}
		>
			<dt className="truncate text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words">{children}</dd>
		</div>
	);
}

/** The row under a paged table: which rows these are, and the way to the others. */
export function TablePager({
	label,
	onPrevious,
	onNext,
	previousLabel = "Previous",
	nextLabel = "Next",
}: {
	label: ReactNode;
	onPrevious?: () => void;
	onNext?: () => void;
	previousLabel?: string;
	nextLabel?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-2 border-t border-border/70 px-4 py-2.5 sm:px-5">
			<span className="text-xs text-muted-foreground tabular-nums">
				<Ph>{label}</Ph>
			</span>
			<div className="flex gap-1.5">
				<Button
					variant="outline"
					size="sm"
					disabled={!onPrevious}
					onClick={onPrevious}
				>
					<ArrowLeft />
					{previousLabel}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={!onNext}
					onClick={onNext}
				>
					{nextLabel}
					<ArrowRight />
				</Button>
			</div>
		</div>
	);
}

/** How many there are, next to a tab's name. */
export function TabCount({ n }: { n: number }) {
	return (
		<span
			data-ph
			className="rounded-full bg-muted px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground tabular-nums shadow-[inset_0_0_0_1px_var(--border)]"
		>
			{n.toLocaleString("en-US")}
		</span>
	);
}
