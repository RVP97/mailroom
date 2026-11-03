import { env } from "cloudflare:workers";
import { ApiError } from "./errors";

/**
 * The API's rate limits (wrangler.jsonc `ratelimits`): per API key, so a leaked or runaway key
 * can't take the whole AWS account's sending, and per IP for requests without a valid key. A
 * deployment without the bindings isn't limited. Cloudflare counts per location, so the limits
 * are approximate.
 */

type Limiter = { limit(o: { key: string }): Promise<{ success: boolean }> };

const binding = (name: "API_KEY_LIMIT" | "API_IP_LIMIT") =>
	(env as unknown as Record<string, Limiter | undefined>)[name];

const tooMany = (message: string) =>
	new ApiError(429, "rate_limit_exceeded", message, { "retry-after": "10" });

/** Throws a 429 when the key has made too many requests in the last 10 seconds. */
export async function limitKey(keyId: string) {
	const limiter = binding("API_KEY_LIMIT");
	if (limiter && !(await limiter.limit({ key: keyId })).success)
		throw tooMany(
			"Too many requests for this API key; slow down and try again in a few seconds",
		);
}

/** For a request without a valid key: throws a 429 when its IP has tried too often. */
export async function limitIp(req: Request) {
	const limiter = binding("API_IP_LIMIT");
	const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
	if (limiter && !(await limiter.limit({ key: ip })).success)
		throw tooMany("Too many requests without a valid API key; try again later");
}
