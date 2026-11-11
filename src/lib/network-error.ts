/**
 * The browser's own "couldn't reach the server" (Safari's "Load failed", Chrome's "Failed to
 * fetch", Firefox's "NetworkError…"): the request never got an answer, often a phone waking up or
 * switching networks for a moment.
 */
export const isNetworkError = (error: unknown) =>
	error instanceof TypeError &&
	/^(Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?|Network request failed)$/i.test(
		error.message,
	);
