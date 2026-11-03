const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	timeZone: "UTC",
});
const numberFmt = new Intl.NumberFormat();
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const formatDateTime = (iso: string | null | undefined) =>
	iso ? dateTime.format(new Date(iso)) : "—";
export const formatDay = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));
export const formatNumber = (n: number) => numberFmt.format(n);
export const formatPercent = (v: number, digits = 2) =>
	`${(v * 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits })}%`;

export function formatRelative(iso: string | null | undefined, now = Date.now()) {
	if (!iso) return "—";
	const diff = (Date.parse(iso) - now) / 1000;
	const abs = Math.abs(diff);
	if (abs < 45) return "just now";
	if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
	if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
	if (abs < 7 * 86_400) return rtf.format(Math.round(diff / 86_400), "day");
	return dateTime.format(new Date(iso));
}

/** "Name <a@b>" → a@b. */
export const bare = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();

const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const shortDateYear = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

/** A compact age for lists: "now", "5m", "3h", "4d", then "Oct 12" (with the year if not this one). */
export function formatAgo(iso: string | null | undefined, now = Date.now()) {
	if (!iso) return "—";
	const t = Date.parse(iso);
	const s = Math.round((now - t) / 1000);
	if (s < 0) {
		const ahead = -s;
		if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))}m`;
		if (ahead < 86_400) return `in ${Math.round(ahead / 3600)}h`;
		return shortDate.format(new Date(t));
	}
	if (s < 45) return "now";
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
	if (s < 86_400) return `${Math.round(s / 3600)}h`;
	if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d`;
	const d = new Date(t);
	return (d.getFullYear() === new Date(now).getFullYear() ? shortDate : shortDateYear).format(d);
}

const stamp = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
/** "Oct 28, 3:53 PM": a moment on a timeline. */
export const formatStamp = (iso: string | null | undefined) =>
	iso ? stamp.format(new Date(iso)) : "—";

/** Long values (DKIM keys, ids) keep their start and end: "p=MIGf…AQAB". */
export const middle = (s: string, head = 18, tail = 10) =>
	s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

/** Seconds as people say them: 4 s, 2.5 min, 1.2 h. */
export function formatSeconds(s: number | null | undefined) {
	if (s === null || s === undefined) return "—";
	if (s < 1) return "<1 s";
	if (s < 90) return `${Math.round(s)} s`;
	if (s < 5400) return `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`;
	if (s < 172_800) return `${(s / 3600).toFixed(1)} h`;
	return `${(s / 86_400).toFixed(1)} d`;
}
