/** @tanstack/react-start/server for the demo: one fixed request, cookies from the browser. */

export const getRequest = () =>
	new Request(`${location.origin}/demo`, {
		headers: { "user-agent": navigator.userAgent, "cf-connecting-ip": "203.0.113.7" },
	});

export function getCookie(name: string): string | undefined {
	const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
	return hit ? decodeURIComponent(hit.slice(name.length + 1)) : undefined;
}

export const setCookie = () => {};
export const deleteCookie = () => {};
export const setResponseHeader = () => {};
export const setResponseHeaders = () => {};
export const setResponseStatus = () => {};
export const getRequestHeader = (name: string) => getRequest().headers.get(name) ?? undefined;
export const getRequestIP = () => "203.0.113.7";
