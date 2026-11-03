import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import type * as React from "react";
import { type DayButton, DayPicker, getDefaultClassNames } from "react-day-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** shadcn's Calendar (react-day-picker 9), in this app's button styles. */
function Calendar({
	className,
	classNames,
	showOutsideDays = true,
	captionLayout = "label",
	components,
	...props
}: React.ComponentProps<typeof DayPicker>) {
	const d = getDefaultClassNames();
	return (
		<DayPicker
			showOutsideDays={showOutsideDays}
			className={cn("group/calendar bg-popover p-3 [--cell-size:2rem]", className)}
			captionLayout={captionLayout}
			classNames={{
				root: cn("w-fit", d.root),
				months: cn("relative flex flex-col gap-4 md:flex-row", d.months),
				month: cn("flex w-full flex-col gap-4", d.month),
				nav: cn(
					"absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
					d.nav,
				),
				button_previous: cn(
					buttonVariants({ variant: "ghost" }),
					"size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
					d.button_previous,
				),
				button_next: cn(
					buttonVariants({ variant: "ghost" }),
					"size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
					d.button_next,
				),
				month_caption: cn(
					"flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
					d.month_caption,
				),
				dropdowns: cn(
					"flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
					d.dropdowns,
				),
				dropdown_root: cn(
					"relative rounded-md border border-input shadow-xs has-focus:border-ring has-focus:ring-[3px] has-focus:ring-ring/50",
					d.dropdown_root,
				),
				dropdown: cn("absolute inset-0 bg-popover opacity-0", d.dropdown),
				caption_label: cn(
					"font-medium select-none",
					captionLayout === "label"
						? "text-sm"
						: "flex h-8 items-center gap-1 rounded-md pr-1 pl-2 text-sm [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
					d.caption_label,
				),
				table: "w-full border-collapse",
				weekdays: cn("flex", d.weekdays),
				weekday: cn(
					"flex-1 rounded-md text-[0.8rem] font-normal text-muted-foreground select-none",
					d.weekday,
				),
				week: cn("mt-1 flex w-full", d.week),
				day: cn(
					"group/day relative aspect-square h-full w-full p-0 text-center select-none [&:first-child[data-selected=true]_button]:rounded-l-md [&:last-child[data-selected=true]_button]:rounded-r-md",
					d.day,
				),
				range_start: cn("rounded-l-md bg-accent", d.range_start),
				range_middle: cn("rounded-none", d.range_middle),
				range_end: cn("rounded-r-md bg-accent", d.range_end),
				today: cn(
					"rounded-md bg-accent text-accent-foreground data-[selected=true]:rounded-none",
					d.today,
				),
				outside: cn("text-muted-foreground aria-selected:text-muted-foreground", d.outside),
				disabled: cn("text-muted-foreground opacity-50", d.disabled),
				hidden: cn("invisible", d.hidden),
				...classNames,
			}}
			components={{
				Root: ({ className, rootRef, ...props }) => (
					<div
						data-slot="calendar"
						ref={rootRef}
						className={cn(className)}
						{...props}
					/>
				),
				Chevron: ({ className, orientation, ...props }) => {
					const Icon =
						orientation === "left"
							? ChevronLeft
							: orientation === "right"
								? ChevronRight
								: ChevronDown;
					return (
						<Icon
							className={cn("size-4", className)}
							{...props}
						/>
					);
				},
				DayButton: CalendarDayButton,
				...components,
			}}
			{...props}
		/>
	);
}

function CalendarDayButton({
	className,
	day,
	modifiers,
	...props
}: React.ComponentProps<typeof DayButton>) {
	const d = getDefaultClassNames();
	return (
		<Button
			variant="ghost"
			size="icon"
			data-day={day.date.toLocaleDateString()}
			data-selected-single={
				modifiers.selected &&
				!modifiers.range_start &&
				!modifiers.range_end &&
				!modifiers.range_middle
			}
			data-range-start={modifiers.range_start}
			data-range-end={modifiers.range_end}
			data-range-middle={modifiers.range_middle}
			className={cn(
				"flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal text-foreground data-[range-end=true]:rounded-md data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-accent data-[range-middle=true]:text-accent-foreground data-[range-start=true]:rounded-md data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground data-[selected-single=true]:hover:bg-primary/90",
				d.day,
				className,
			)}
			{...props}
		/>
	);
}

export { Calendar, CalendarDayButton };
