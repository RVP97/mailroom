/**
 * Node's Buffer, as much of it as the app uses on the Worker (nodejs_compat): Drizzle's blob
 * columns and a few Buffer.from calls. Bytes with base64, hex and UTF-8.
 */
class DemoBuffer extends Uint8Array {
	static from(value: unknown, encoding?: string): DemoBuffer {
		if (typeof value === "string") {
			if (encoding === "base64")
				return new DemoBuffer(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
			if (encoding === "hex")
				return new DemoBuffer(
					(value.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)),
				);
			return new DemoBuffer(new TextEncoder().encode(value));
		}
		if (value instanceof ArrayBuffer) return new DemoBuffer(new Uint8Array(value));
		if (ArrayBuffer.isView(value))
			return new DemoBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
		if (Array.isArray(value)) return new DemoBuffer(value);
		return new DemoBuffer(0);
	}
	static isBuffer(v: unknown) {
		return v instanceof DemoBuffer;
	}
	static alloc(n: number) {
		return new DemoBuffer(n);
	}
	static byteLength(s: string) {
		return new TextEncoder().encode(s).byteLength;
	}
	static concat(list: Uint8Array[]) {
		const out = new DemoBuffer(list.reduce((n, b) => n + b.byteLength, 0));
		let at = 0;
		for (const b of list) {
			out.set(b, at);
			at += b.byteLength;
		}
		return out;
	}
	override toString(encoding?: string): string {
		if (encoding === "base64") {
			let s = "";
			for (let i = 0; i < this.length; i += 0x8000)
				s += String.fromCharCode(...this.subarray(i, i + 0x8000));
			return btoa(s);
		}
		if (encoding === "hex")
			return [...this].map((b) => b.toString(16).padStart(2, "0")).join("");
		return new TextDecoder().decode(this);
	}
	toJSON() {
		return { type: "Buffer", data: [...this] };
	}
}

const g = globalThis as { Buffer?: unknown };
g.Buffer ??= DemoBuffer;
