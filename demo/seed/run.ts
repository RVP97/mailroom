/**
 * Makes the demo's database: the repo's migrations, then the seed, run by the app's own code.
 * Run by demo/build-db.mjs (in Node, through Vite, with the demo's swaps) at build time.
 */
import { installClock } from "../clock";
import { openDemoDb } from "../d1";
import { migrate } from "../migrate";
import { installOutside } from "../outside";
import { dispatcherHooks } from "../shims/cloudflare-workers";
import { seed } from "./index";

export async function buildDemoDb(wasm: ArrayBuffer) {
	installClock();
	installOutside();
	// The seed moves the Dispatcher itself, at the seed's times.
	dispatcherHooks.manual = true;
	const sqlite = await openDemoDb({ wasm });
	migrate(sqlite);
	const started = Date.now();
	await seed();
	sqlite.run("CREATE TABLE demo_meta (built_at INTEGER NOT NULL)");
	sqlite.run("INSERT INTO demo_meta (built_at) VALUES (?)", [Date.now()]);
	console.log(`[demo] seeded in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	sqlite.run("VACUUM");
	return sqlite.export();
}
