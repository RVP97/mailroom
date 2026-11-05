// Seeds the demo's database (demo/seed) and saves it as demo/public/demo.db, which the demo
// opens in the browser. Runs the seed through Vite so it gets the demo's module swaps.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createServer } from "vite";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

const server = await createServer({
	configFile: here("./vite.config.ts"),
	server: { middlewareMode: true, hmr: false, watch: null },
	appType: "custom",
	logLevel: "warn",
});
try {
	const { buildDemoDb } = await server.ssrLoadModule("/seed/run.ts");
	const wasm = readFileSync(here("../node_modules/sql.js/dist/sql-wasm.wasm"));
	const bytes = await buildDemoDb(
		wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
	);
	mkdirSync(here("./public"), { recursive: true });
	// Gzipped (to about a fifth): the demo unzips it in the browser (DecompressionStream).
	const zipped = gzipSync(bytes, { level: 9 });
	writeFileSync(here("./public/demo.db.gz"), zipped);
	console.log(
		`[demo] demo/public/demo.db.gz: ${(bytes.byteLength / 1024).toFixed(0)} KB, ${(zipped.byteLength / 1024).toFixed(0)} KB gzipped`,
	);
} finally {
	await server.close();
}
