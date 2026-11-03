import { CalendarDays, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/*
 * Date pickers built on shadcn's Calendar and Popover, holding the same strings the native
 * inputs did: "YYYY-MM-DD" for a day and "YYYY-MM-DDTHH:mm" (local time) for a moment.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-11-03" → that day at local midnight (null if it isn't one). */
export function dayOf(v: string | null | undefined): Date | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? "");
	if (!m) return null;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export const dayString = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const dayLabel = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
});
const timeLabel = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Every 15 minutes of a day, as "HH:mm" with how this browser writes it. */
const TIMES = Array.from({ length: 96 }, (_, i) => {
	const h = Math.floor(i / 4);
	const m = (i % 4) * 15;
	return { value: `${pad(h)}:${pad(m)}`, label: timeLabel.format(new Date(2000, 0, 1, h, m)) };
});

function Trigger({
	id,
	text,
	placeholder,
	disabled,
	className,
}: {
	id?: string;
	text: string | null;
	placeholder: string;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<PopoverTrigger asChild>
			<Button
				id={id}
				type="button"
				variant="outline"
				disabled={disabled}
				className={cn(
					"h-9 w-full justify-start px-3 text-left font-normal",
					!text && "text-muted-foreground",
					className,
				)}
			>
				<CalendarDays />
				<span className="truncate">{text ?? placeholder}</span>
			</Button>
		</PopoverTrigger>
	);
}

/** A day, or none when `clearable`. */
export function DatePicker({
	id,
	value,
	onChange,
	min,
	max,
	placeholder = "Pick a day",
	clearable = false,
	disabled,
	className,
}: {
	id?: string;
	value: string;
	onChange: (v: string) => void;
	min?: string;
	max?: string;
	placeholder?: string;
	clearable?: boolean;
	disabled?: boolean;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const day = dayOf(value);
	const from = dayOf(min);
	const to = dayOf(max);
	return (
		<div className={cn("relative", className)}>
			<Popover
				open={open}
				onOpenChange={setOpen}
			>
				<Trigger
					id={id}
					text={day ? dayLabel.format(day) : null}
					placeholder={placeholder}
					disabled={disabled}
					className={clearable && day ? "pr-8" : undefined}
				/>
				<PopoverContent
					className="w-auto p-0"
					align="start"
				>
					<Calendar
						mode="single"
						selected={day ?? undefined}
						defaultMonth={day ?? from ?? undefined}
						captionLayout="dropdown"
						disabled={[
							...(from ? [{ before: from }] : []),
							...(to ? [{ after: to }] : []),
						]}
						onSelect={(d) => {
							if (d) onChange(dayString(d));
							else if (clearable) onChange("");
							setOpen(false);
						}}
					/>
				</PopoverContent>
			</Popover>
			{clearable && day && !disabled && (
				<button
					type="button"
					aria-label="Clear the date"
					onClick={() => onChange("")}
					className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}

/** A day and a time (every 15 minutes), local, never before `min`. */
export function DateTimePicker({
	id,
	value,
	onChange,
	min,
	disabled,
}: {
	id?: string;
	value: string;
	onChange: (v: string) => void;
	min?: string;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const day = dayOf(value);
	const time = /T(\d{2}:\d{2})/.exec(value)?.[1] ?? "09:00";
	const minDay = dayOf(min);
	const minTime = /T(\d{2}:\d{2})/.exec(min ?? "")?.[1] ?? null;
	const sameAsMin = !!day && !!minDay && dayString(day) === dayString(minDay);
	const times = TIMES.filter((t) => !sameAsMin || !minTime || t.value >= minTime);
	// A time that isn't on the 15-minute grid still shows.
	const shown = TIMES.some((t) => t.value === time)
		? times
		: [...times, { value: time, label: time }].sort((a, b) => a.value.localeCompare(b.value));
	const set = (d: string, t: string) => {
		const next = `${d}T${t}`;
		onChange(min && next < min ? min : next);
	};
	return (
		<div className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
			<Popover
				open={open}
				onOpenChange={setOpen}
			>
				<Trigger
					id={id}
					text={day ? dayLabel.format(day) : null}
					placeholder="Pick a day"
					disabled={disabled}
				/>
				<PopoverContent
					className="w-auto p-0"
					align="start"
				>
					<Calendar
						mode="single"
						selected={day ?? undefined}
						defaultMonth={day ?? minDay ?? undefined}
						disabled={minDay ? { before: minDay } : undefined}
						onSelect={(d) => {
							if (d) set(dayString(d), time);
							setOpen(false);
						}}
					/>
				</PopoverContent>
			</Popover>
			<Select
				value={time}
				disabled={disabled || !day}
				onValueChange={(t) => day && set(dayString(day), t)}
			>
				<SelectTrigger
					className="h-9 w-full"
					aria-label="Time"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-72">
					{shown.map((t) => (
						<SelectItem
							key={t.value}
							value={t.value}
						>
							{t.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
