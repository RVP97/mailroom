import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";

/** `doneAt`: how many times the data had changed when the save finished (null while saving). */
type Pending<C> = { id: number; change: C; doneAt: number | null };

/** How long a saved change waits for the reloaded data before it gives way anyway. */
const HAND_OVER_MS = 10_000;

/**
 * Data the page shows with changes the server hasn't confirmed yet. `save(change, write)` shows
 * the change at once, writes it and reloads the route. The change stays on top of the data until
 * the reloaded data has actually rendered, so it never blinks back to the old value in between
 * (the router can resolve its reload a frame before the new data reaches the page). `saved` must
 * keep its identity until the server sends new data: pass loader data, not an object built in
 * render. If the save
 * fails the change is dropped and a toast says why.
 *
 * Only for changes whose outcome the page can predict (a switch, a rename, a row going away).
 * Sending, verifying DNS or creating something that gets a server id still waits on the server.
 *
 * `save` resolves true once saved, false when it failed (already toasted).
 */
export function useOptimisticState<T, C>(
	saved: T,
	apply: (value: T, change: C) => T,
	reload?: () => Promise<unknown>,
) {
	const router = useRouter();
	const [pending, setPending] = useState<Pending<C>[]>([]);
	// Bumped each time the route hands the page new data (a new `saved` object).
	const changes = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per new `saved`
	useLayoutEffect(() => {
		changes.current++;
		// Data that arrived after a save finished includes it: that change steps aside. Data from
		// an earlier reload (a second click while the first saves) doesn't, so it stays on.
		setPending((list) => {
			const next = list.filter((p) => p.doneAt === null || p.doneAt >= changes.current);
			return next.length === list.length ? list : next;
		});
	}, [saved]);
	const nextId = useRef(0);
	const drop = useCallback(
		(id: number) => setPending((list) => list.filter((p) => p.id !== id)),
		[],
	);

	const save = useCallback(
		async (change: C, write: () => Promise<unknown>): Promise<boolean> => {
			const id = ++nextId.current;
			setPending((list) => [...list, { id, change, doneAt: null }]);
			try {
				await write();
				await (reload ? reload() : router.invalidate());
			} catch (error) {
				drop(id);
				toast.error(await errorMessage(error));
				return false;
			}
			const doneAt = changes.current;
			setPending((list) => list.map((p) => (p.id === id ? { ...p, doneAt } : p)));
			// If the reloaded data was already on the page, nothing new comes: let go after a while.
			setTimeout(() => drop(id), HAND_OVER_MS);
			return true;
		},
		[reload, router, drop],
	);

	const value = useMemo(
		() => pending.reduce((v, p) => apply(v, p.change), saved),
		[pending, saved, apply],
	);
	return [value, save] as const;
}

/** An apply for a record: the fields that change, over the saved ones. */
export const patch = <T extends object>(saved: T, change: Partial<T>): T => ({
	...saved,
	...change,
});
