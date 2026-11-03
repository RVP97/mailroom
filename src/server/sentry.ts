import { type CloudflareOptions, captureConsoleIntegration } from "@sentry/cloudflare";
import { ApiError } from "./errors";

/**
 * The Worker's errors in Sentry (the dashboard's are in src/lib/sentry.ts): whatever a request, the
 * cron, an email or the Dispatcher throws, a server function's unexpected errors
 * (src/start.ts), and every console.error (the code logs what it catches and carries on). Off in
 * development and without SENTRY_DSN.
 */
export function sentryOptions(env: Env): CloudflareOptions | undefined {
	if (!env.SENTRY_DSN || !import.meta.env.PROD) return undefined;
	return {
		dsn: env.SENTRY_DSN,
		release: __SENTRY_RELEASE__ || undefined,
		environment: "production",
		// No cookies, IPs or headers but a few: requests carry session cookies and API keys.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: {
				request: { allow: ["user-agent", "content-type", "referer"] },
				response: false,
			},
		},
		tracesSampleRate: 0,
		integrations: [captureConsoleIntegration({ levels: ["error"] })],
		beforeSend(event, hint) {
			const error = hint.originalException;
			// Answers, not bugs: a refusal (signed out, no access) or an API error the caller gets.
			if (error instanceof Response && error.status < 500) return null;
			if (error instanceof ApiError && error.status < 500) return null;
			return event;
		},
	};
}

/** Reports an error from a place that answers it itself (a server function's failure). */
export async function reportError(error: unknown) {
	if (error instanceof Response && error.status < 500) return;
	if (error instanceof ApiError && error.status < 500) return;
	if (typeof error === "object" && error && "isNotFound" in error) return;
	const { captureException } = await import("@sentry/cloudflare");
	captureException(error);
}
