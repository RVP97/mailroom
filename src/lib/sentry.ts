import * as Sentry from "@sentry/react";
import { isNetworkError } from "@/lib/network-error";
import { isStaleCode } from "@/lib/stale-code";

/**
 * The dashboard's errors in Sentry (the Worker's are in src/server/sentry.ts): anything thrown and
 * not caught, React's errors (also those an error boundary shows as "This page didn't load"), and a
 * replay of the moments before each error. Off in development.
 */
export function initSentry() {
	if (!__SENTRY_DSN__ || !import.meta.env.PROD) return;
	Sentry.init({
		dsn: __SENTRY_DSN__,
		release: __SENTRY_RELEASE__ || undefined,
		environment: "production",
		// Errors only: no performance tracing (the free plan's quota).
		tracesSampleRate: 0,
		// Replays only of sessions with an error, recorded from shortly before it.
		replaysSessionSampleRate: 0,
		replaysOnErrorSampleRate: 1,
		beforeSend(event, hint) {
			const error = hint.originalException;
			// A server function's refusal (signed out, no access, not found) is an answer, not a bug.
			if (error instanceof Response && error.status < 500) return null;
			// A tab from before a deploy asking for replaced code: the page loads again by itself
			// (PageError).
			if (error instanceof Error && isStaleCode(error)) return null;
			// The browser lost the network ("Load failed" on a phone waking up): the page says
			// Mailroom couldn't be reached and offers to try again; a real outage shows on the
			// Worker's side.
			if (isNetworkError(error)) return null;
			// A route's notFound(), drawn by its not-found page.
			if (typeof error === "object" && error && "isNotFound" in error) return null;
			return event;
		},
	});
	// The replay's code loads after the page, so it never slows the first paint.
	const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1000));
	idle(() => {
		void Sentry.lazyLoadIntegration("replayIntegration")
			// Text and images stay masked: the pages show customers' addresses.
			.then((replay) => Sentry.addIntegration(replay()))
			.catch(() => {});
	});
}

/** Who was signed in, on each error. */
export function identify(user: { id: string; email: string; name?: string | null }) {
	Sentry.setUser({ id: user.id, email: user.email, username: user.name ?? undefined });
}

/**
 * React 19's error hooks, for hydrateRoot: errors nothing caught, and those an error boundary
 * caught (a page that didn't load, even for a moment). Not the recoverable ones: the first paint is
 * drawn from a cookie and React redraws it when it differs, which is expected.
 */
const logged = (error: unknown) => console.error(error);
export const reactErrorHandlers = {
	onUncaughtError: Sentry.reactErrorHandler(logged),
	onCaughtError: Sentry.reactErrorHandler(logged),
	// React's default reports these as page errors, which Sentry would take on every first load.
	onRecoverableError: (error: unknown) => console.warn(error),
};
