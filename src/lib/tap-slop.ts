/**
 * Taps in open menus, sheets and dialogs on iPhone. While a Radix menu, sheet or dialog is open,
 * react-remove-scroll cancels every `touchmove` that no scrollable box inside it could take, so
 * the page behind can't scroll. A real finger drifts a few pixels during a tap, and iOS drops the
 * tap's `click` once one of its touchmoves is cancelled: buttons and links in an open menu or
 * dialog only worked when the finger didn't move at all.
 *
 * So, while a scroll lock is on (body[data-scroll-locked], set by react-remove-scroll), a
 * touchmove still inside the tap slop stops at the window and never reaches it: nothing scrolls
 * that early anyway, and the tap stays a tap. Past the slop it's a drag and the lock works as
 * before.
 */

/** About how far iOS lets a finger move before a touch stops being a tap. */
export const TAP_SLOP_PX = 10;

/** Whether a touch that started at `start` and is now at `now` is still a tap. */
export function withinTapSlop(start: { x: number; y: number }, now: { x: number; y: number }) {
	return Math.abs(now.x - start.x) < TAP_SLOP_PX && Math.abs(now.y - start.y) < TAP_SLOP_PX;
}

/** Installs the listeners once per window; returns what removes them. */
export function keepTapsInScrollLocks(win: Window = window) {
	let start: { x: number; y: number } | null = null;
	const onStart = (e: TouchEvent) => {
		const t = e.touches.length === 1 ? e.touches[0] : null;
		start = t ? { x: t.clientX, y: t.clientY } : null;
	};
	const onMove = (e: TouchEvent) => {
		if (!start || e.touches.length !== 1) return;
		if (!win.document.body?.hasAttribute("data-scroll-locked")) return;
		const t = e.touches[0];
		if (!t) return;
		if (withinTapSlop(start, { x: t.clientX, y: t.clientY })) e.stopPropagation();
		// Once it has left the slop it's a drag for good, even if it comes back.
		else start = null;
	};
	const capture = { capture: true, passive: true } as const;
	win.addEventListener("touchstart", onStart, capture);
	win.addEventListener("touchmove", onMove, capture);
	return () => {
		win.removeEventListener("touchstart", onStart, capture);
		win.removeEventListener("touchmove", onMove, capture);
	};
}
