/*
 * The demo's Worker routes (its public pages: newsletters, sign-up forms, logos, polls,
 * attachments) live under <demo>/worker/. Nothing serves them: this service worker hands each
 * request to an open demo tab, which runs the app's own Worker code on its database
 * (demo/worker.ts) and answers.
 */
const SCOPE = new URL("./", self.location.href).pathname;
const PREFIX = `${SCOPE}worker/`;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

async function demoTab(exclude) {
	const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	return all.find((c) => c.id !== exclude && !new URL(c.url).pathname.startsWith(PREFIX)) ?? null;
}

const page = (title, text) =>
	new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:16px/1.5 system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#18181b"><div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:20px">${title}</h1><p>${text}</p><p><a href="${SCOPE}">Open the demo</a></p></div>`,
		{ status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
	);

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
	event.respondWith(
		(async () => {
			const tab = await demoTab(event.resultingClientId || "");
			if (!tab)
				return page(
					"The demo isn't open",
					"This page is made by the demo in your browser: open the demo in another tab, then reload this one.",
				);
			const body = ["GET", "HEAD"].includes(event.request.method)
				? null
				: await event.request.arrayBuffer();
			const channel = new MessageChannel();
			const answer = new Promise((resolve) => {
				channel.port1.onmessage = (m) => resolve(m.data);
				setTimeout(() => resolve(null), 15000);
			});
			tab.postMessage(
				{
					type: "mailroom-demo:fetch",
					path: url.pathname.slice(PREFIX.length - 1) + url.search,
					method: event.request.method,
					headers: [...event.request.headers],
					body,
				},
				[channel.port2],
			);
			const res = await answer;
			if (!res)
				return page(
					"No answer",
					"The demo tab didn't answer in time. Reload it, then try again.",
				);
			const empty = [101, 204, 205, 304].includes(res.status);
			return new Response(empty ? null : res.body, {
				status: res.status,
				headers: res.headers,
			});
		})(),
	);
});
