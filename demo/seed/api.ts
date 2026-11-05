/** The seed's calls to the app's own REST API (src/server/api.ts), as an app with a key makes them. */
import { handleApi } from "@/server/api";

export const BASE = "https://mailroom.example.com/api";

const AGENTS = ["mailroom-node/1.4.0", "resend-node:4.1.2", "python-requests/2.32.3", "curl/8.7.1"];

export async function api<T = Record<string, unknown>>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
	o: { brand?: string; agent?: number; ok?: boolean } = {},
): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"user-agent": AGENTS[o.agent ?? 0] ?? AGENTS[0],
	};
	if (body !== undefined) headers["content-type"] = "application/json";
	if (o.brand) headers["mailroom-brand"] = o.brand;
	const res = await handleApi(
		new Request(`${BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	const text = await res.text();
	const data = text ? JSON.parse(text) : {};
	if (!res.ok && o.ok !== false)
		throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
	return data as T;
}
