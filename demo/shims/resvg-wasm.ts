/**
 * resvg's WebAssembly. The Worker imports it as a compiled module; in the demo it's a file next
 * to the page, and initWasm fetches it by its URL.
 */
export { default } from "@resvg/resvg-wasm/index_bg.wasm?url";
