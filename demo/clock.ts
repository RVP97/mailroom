/**
 * The demo's clock. The seed writes months of history by running the app's own code at past
 * times: within at(time, fn) every `new Date()` and `Date.now()` answers that time (a few
 * milliseconds later at each call, so rows keep their order). Outside it, the real time.
 */

const RealDate = Date;
let fixed: number | null = null;

const read = () => {
	if (fixed === null) return RealDate.now();
	fixed += 3;
	return fixed;
};

class DemoDate extends RealDate {
	constructor(...args: unknown[]) {
		if (args.length === 0) super(read());
		else super(...(args as [string | number | Date]));
	}
	static override now() {
		return read();
	}
}

export function installClock() {
	if (globalThis.Date !== (DemoDate as unknown)) globalThis.Date = DemoDate as DateConstructor;
}

/** Runs fn with the clock at `time` (ms), moving forward as it reads. */
export async function at<T>(time: number, fn: () => Promise<T>): Promise<T> {
	const before = fixed;
	fixed = time;
	try {
		return await fn();
	} finally {
		fixed = before;
	}
}

export const clockTime = () => (fixed === null ? RealDate.now() : fixed);
export const isFixed = () => fixed !== null;
export const realNow = () => RealDate.now();
