/** Wall-clock times in a time zone, for sends at each contact's local time. */

/** Whether the runtime knows this IANA time zone. */
export function validZone(tz: string | null | undefined): tz is string {
	if (!tz || tz.length > 64) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** How far ahead of UTC the zone is at that moment, in ms. */
export function zoneOffset(at: number, tz: string) {
	const f = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const p = Object.fromEntries(
		f.formatToParts(new Date(at)).map((x) => [x.type, Number(x.value)]),
	) as Record<string, number>;
	const n = (k: string) => p[k] ?? 0;
	const utc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
	return utc - Math.floor(at / 1000) * 1000;
}

export const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The moment a wall-clock time (2026-11-10T09:00) happens in a zone. */
export function zonedInstant(local: string, tz: string) {
	const m = LOCAL.exec(local);
	if (!m) return Number.NaN;
	const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
	const guess = Date.UTC(y, mo - 1, d, h, mi);
	const first = guess - zoneOffset(guess, tz);
	return guess - zoneOffset(first, tz);
}

/** The first and last moments a wall-clock time happens anywhere (UTC+14 to UTC−12). */
export function localSpan(local: string) {
	return { first: zonedInstant(local, "Etc/GMT-14"), last: zonedInstant(local, "Etc/GMT+12") };
}
