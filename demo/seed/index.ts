/**
 * The demo's data: one organization with everything in it, made by the app's own code (its API
 * and server functions) at the times it happened, into the SQLite the demo opens. Dates are moved
 * up to today when the demo loads (demo/shift.ts), so charts always end today.
 */
import { purge } from "@/server/cron";
import { at, realNow } from "../clock";
import { flushSes } from "../ses";
import { settle } from "../shims/cloudflare-workers";
import { extras } from "./extras";
import { inbox } from "./inbox";
import { setup } from "./setup";
import { timeline } from "./timeline";

export async function seed() {
	const now = realNow();
	const ctx = await setup(now);
	await timeline(ctx);
	await inbox(ctx);
	await extras(ctx);
	await flushSes();
	await settle();
	// The nightly clean-up, as on the last night: old bodies and logs go, as they would.
	await at(now - 60_000, () => purge(Date.now()));
	return ctx;
}
