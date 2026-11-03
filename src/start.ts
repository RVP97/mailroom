import { createMiddleware, createStart } from "@tanstack/react-start";

/**
 * Every server function's unexpected errors go to Sentry (src/server/sentry.ts): TanStack turns a
 * thrown error into the function's answer, so the Worker's own handler never sees it.
 */
const reportErrors = createMiddleware({ type: "function" }).server(async ({ next }) => {
	try {
		return await next();
	} catch (error) {
		const { reportError } = await import("./server/sentry");
		await reportError(error);
		throw error;
	}
});

// The dashboard renders in the browser: the Worker only serves data, which keeps it inside the
// free plan's 10 ms of CPU per request.
export const startInstance = createStart(() => ({
	defaultSsr: false,
	functionMiddleware: [reportErrors],
}));
