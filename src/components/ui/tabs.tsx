import { cva, type VariantProps } from "class-variance-authority";
import { Tabs as TabsPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Tabs({
	className,
	orientation = "horizontal",
	...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			data-orientation={orientation}
			orientation={orientation}
			className={cn("group/tabs flex gap-3 data-[orientation=horizontal]:flex-col", className)}
			{...props}
		/>
	);
}

const tabsListVariants = cva("group/tabs-list inline-flex w-fit items-center text-muted-foreground", {
	variants: {
		variant: {
			default:
				"h-8 rounded-lg bg-[oklch(0.2_0.01_265/0.055)] p-[3px] dark:bg-white/[0.06]",
			line: "h-9 gap-4",
		},
	},
	defaultVariants: {
		variant: "default",
	},
});

function TabsList({
	className,
	variant = "default",
	...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			data-variant={variant}
			className={cn(tabsListVariants({ variant }), className)}
			{...props}
		/>
	);
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"relative inline-flex h-full cursor-default rounded-sm outline-none focus-visible:outline-none items-center justify-center gap-1.5 text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow] duration-150 hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
				"group-data-[variant=default]/tabs-list:rounded-md group-data-[variant=default]/tabs-list:px-2.5 group-data-[variant=default]/tabs-list:data-[state=active]:bg-background group-data-[variant=default]/tabs-list:data-[state=active]:shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:group-data-[variant=default]/tabs-list:data-[state=active]:bg-white/[0.1]",
				"group-data-[variant=line]/tabs-list:px-0.5 after:absolute after:inset-x-0 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-foreground after:opacity-0 group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100",
				className,
			)}
			{...props}
		/>
	);
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
	return (
		<TabsPrimitive.Content
			data-slot="tabs-content"
			className={cn("flex-1 outline-none", className)}
			{...props}
		/>
	);
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
