/**
 * A page's code that a deploy replaced: a tab opened before it asks for files the new build named
 * otherwise. Loading the page again gets the new ones.
 */
export const isStaleCode = (error: unknown) =>
	error instanceof Error &&
	/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(
		error.message,
	);

/** Loads the page again for new code, once a minute at most (so a real outage shows its error). */
export function reloadForNewCode() {
	try {
		const last = Number(sessionStorage.getItem("reloaded-for-new-code") ?? 0);
		if (Date.now() - last < 60_000) return false;
		sessionStorage.setItem("reloaded-for-new-code", String(Date.now()));
	} catch {
		return false;
	}
	window.location.reload();
	return true;
}
