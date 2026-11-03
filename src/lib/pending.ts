import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * How long a click waits on data before its skeleton shows. Anything the router already has
 * (visited, or preloaded on hover) opens before this, so it never flashes one.
 */
export const SKELETON_MS = 60;

/** `on` once it has stayed true for `ms`; false at once when it turns false. */
export function useDelayed(on: boolean, ms = SKELETON_MS): boolean {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		if (!on) return setShown(false);
		const t = setTimeout(() => setShown(true), ms);
		return () => clearTimeout(t);
	}, [on, ms]);
	return on && shown;
}

/** A click to another page is waiting for that page's data. */
export function useEnteringPage() {
	return useDelayed(
		useRouterState({
			select: (s) =>
				s.status === "pending" &&
				!!s.resolvedLocation &&
				s.location.pathname !== s.resolvedLocation.pathname,
		}),
	);
}

/**
 * For a page whose filters live in the URL (and whose route has pendingMs: Infinity, so it stays
 * up while they load): the filters being loaded, so the controls show the choice at once, and
 * whether the widgets they feed should show their skeletons.
 */
export function usePendingSearch<S extends object>(current: S) {
	const target = useRouterState({
		select: (s) =>
			s.status === "pending" &&
			!!s.resolvedLocation &&
			s.location.pathname === s.resolvedLocation.pathname &&
			s.location.searchStr !== s.resolvedLocation.searchStr
				? (s.location.search as S)
				: null,
	});
	const loading = useDelayed(target !== null);
	return { search: target ?? current, loading };
}
