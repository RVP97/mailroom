/** Times relative to now, as the app stores them (ISO strings) and as Dates. */

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** `days` from now (negative: ago), plus hours and minutes, as an ISO string. */
export const iso = (days: number, hours = 0, minutes = 0) =>
	new Date(Date.now() + days * DAY + hours * HOUR + minutes * 60_000).toISOString();

export const at = (days: number, hours = 0, minutes = 0) =>
	new Date(Date.now() + days * DAY + hours * HOUR + minutes * 60_000);

/** A day's YYYY-MM-DD, `days` from today. */
export const day = (days: number) => iso(days).slice(0, 10);

/** A seeded random number generator, so the demo looks the same on every visit. */
export function random(seed = 42) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
