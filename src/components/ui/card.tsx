import type * as React from "react";
import { cn } from "@/lib/utils";

/** A surface: 12px corners, a hairline ring and a soft shadow. */
function Card({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card"
			className={cn(
				"flex flex-col rounded-xl bg-card text-card-foreground shadow-card",
				className,
			)}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				"@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-x-4 gap-y-1 px-5 pt-4 pb-4 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-[+[data-slot=card-content]]:pb-3",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-title"
			className={cn("text-sm leading-5 font-semibold", className)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("max-w-prose text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn(
				"col-start-2 row-span-2 row-start-1 flex items-center gap-2 self-start justify-self-end",
				className,
			)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("px-5 py-4 [[data-slot=card-header]+&]:pt-0", className)}
			{...props}
		/>
	);
}

/** A footer bar: a hint on the left, the card's action on the right. */
function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn(
				"flex min-h-12 items-center gap-3 rounded-b-xl border-t bg-muted/60 px-5 py-2.5 text-sm text-muted-foreground dark:bg-white/[0.02]",
				className,
			)}
			{...props}
		/>
	);
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
