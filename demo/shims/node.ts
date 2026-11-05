/** The two Node built-ins the server code uses, enough for the demo. */

/** One scope at a time is enough in a browser tab. */
export class AsyncLocalStorage<T> {
	#store: T | undefined;
	run<R>(store: T, fn: () => R): R {
		const before = this.#store;
		this.#store = store;
		try {
			const out = fn();
			if (out instanceof Promise) return out.finally(() => (this.#store = before)) as R;
			this.#store = before;
			return out;
		} catch (e) {
			this.#store = before;
			throw e;
		}
	}
	getStore() {
		return this.#store;
	}
}

/** Only S3 uploads' Content-MD5 asks for a hash, and the demo never talks to S3. */
export function createHash(_algorithm: string) {
	const h = {
		update: () => h,
		digest: () => "ZGVtbw==",
	};
	return h;
}

export default { AsyncLocalStorage, createHash };
