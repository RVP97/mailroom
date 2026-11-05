/**
 * The Worker's own fetch handler (src/server.ts), run in the demo tab for what the service worker
 * (public/sw.js) hands it: a newsletter's public page, a sign-up form, a logo, a poll answer.
 * Links to them are made from BETTER_AUTH_URL, which in the demo is <demo>/worker.
 */
import worker from "@/server";
import { env, settle } from "./shims/cloudflare-workers";

export const workerBase = () => `${location.origin}${import.meta.env.BASE_URL}worker`;

type Ask = {
	type: string;
	path: string;
	method: string;
	headers: [string, string][];
	body: ArrayBuffer | null;
};

export function installWorker() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker.addEventListener("message", async (e: MessageEvent<Ask>) => {
		if (e.data?.type !== "mailroom-demo:fetch") return;
		const port = e.ports[0];
		if (!port) return;
		try {
			const request = new Request(`${location.origin}${e.data.path}`, {
				method: e.data.method,
				headers: e.data.headers,
				body: e.data.body,
				redirect: "manual",
			});
			const res = await (
				worker as { fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response> }
			).fetch(request, env, {
				waitUntil: () => {},
				passThroughOnException: () => {},
			});
			const body = await res.arrayBuffer();
			const headers = [...res.headers].map(([k, v]): [string, string] =>
				// Absolute links back to the Worker's own address stay in the demo.
				k === "location" && v.startsWith("/") && !v.startsWith(import.meta.env.BASE_URL)
					? [k, `${import.meta.env.BASE_URL}worker${v}`]
					: [k, v],
			);
			port.postMessage({ status: res.status, headers, body }, [body]);
			void settle();
		} catch (error) {
			console.error("[demo] worker", error);
			port.postMessage({
				status: 500,
				headers: [["content-type", "text/plain"]],
				body: new TextEncoder().encode(String(error)).buffer,
			});
		}
	});
	void navigator.serviceWorker
		.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
		.catch((error) => console.warn("[demo] service worker", error));
}
