/**
 * SVG logos as PNG, for the places that can't show SVG (mail apps): a brand whose only logo is
 * its BIMI SVG, or an uploaded SVG logo. Rendered with resvg (WebAssembly), loaded on first use.
 */
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";

let ready: Promise<void> | null = null;

/** The SVG drawn as a square-ish PNG `size` pixels wide. */
export async function svgToPng(svg: string, size = 256): Promise<Uint8Array<ArrayBuffer>> {
	ready ??= initWasm(wasm).catch((error) => {
		ready = null;
		throw error;
	});
	await ready;
	const r = new Resvg(svg, { fitTo: { mode: "width", value: size } });
	try {
		const png = r.render();
		const bytes = png.asPng();
		png.free();
		return new Uint8Array(bytes);
	} finally {
		r.free();
	}
}
