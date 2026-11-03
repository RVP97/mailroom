import { timezone } from "./env";

export const iso = (ms: number = Date.now()) => new Date(ms).toISOString();

const formats = new Map<string, Intl.DateTimeFormat>();

/** The day (YYYY-MM-DD) an instant falls on in a time zone (TIMEZONE by default). */
export function dayOf(at: string | number | Date, tz = timezone()): string {
	let f = formats.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-CA", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		formats.set(tz, f);
	}
	return f.format(new Date(at));
}

/** The last n days (oldest first), ending today in the time zone. */
export function lastDays(n: number, now = Date.now(), tz = timezone()): string[] {
	const today = dayOf(now, tz);
	const [y, m, d] = today.split("-").map(Number) as [number, number, number];
	const out: string[] = [];
	for (let i = n - 1; i >= 0; i--)
		out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
	return out;
}

/** How far a time zone's clock is ahead of UTC at an instant, in ms. */
function offsetMs(ms: number, tz: string): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(new Date(ms));
	const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
	return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - ms;
}

/** When a day (YYYY-MM-DD) starts and ends in the time zone, as ISO instants: [start, end). */
export function dayRange(day: string, tz = timezone()): [string, string] {
	const [y, m, d] = day.split("-").map(Number) as [number, number, number];
	const startOf = (date: number) => date - offsetMs(date + 12 * 3_600_000, tz);
	return [iso(startOf(Date.UTC(y, m - 1, d))), iso(startOf(Date.UTC(y, m - 1, d + 1)))];
}
