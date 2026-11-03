import { useRouter } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { authClient } from "@/lib/auth-client";
import { forgetMe, loadMe, useMe } from "@/lib/me";

/**
 * Switching organization in place: no reload and no blank frame. The veil
 * (components/org-switch-veil.tsx) covers the old organization's page while the session moves,
 * the new organization's data loads behind it, and then the same section opens for the new one.
 */

export type Switching = {
	phase: "leaving" | "arriving";
	target: { id: string; name: string; logo: string | null; background: string | null };
};

let state: Switching | null = null;
const listeners = new Set<() => void>();
function set(next: Switching | null) {
	state = next;
	for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
};

export const useSwitching = () =>
	useSyncExternalStore(
		subscribe,
		() => state,
		() => null,
	);

let onFaded: (() => void) | null = null;
/** The veil says it has faded out. */
export const faded = () => onFaded?.();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough to read «Switching to …», short enough not to wait on it. */
const LEAST_MS = 650;
/** Longest the veil takes to fade out. */
const FADE_MS = 400;

/** The section a page belongs to: a record opens its list, since the record was the old one's. */
function sectionOf(pathname: string) {
	const first = pathname.split("/")[1] ?? "";
	return first ? `/${first}` : "/";
}

/**
 * Radix leaves the page untappable (body pointer-events: none) when a menu or sheet goes away
 * while open, which is what used to freeze the phone menu after a switch.
 */
function freePointer() {
	if (
		!document.querySelector(
			"[role=dialog][data-state=open], [data-radix-popper-content-wrapper]",
		)
	)
		document.body.style.removeProperty("pointer-events");
}

export function useSwitchOrg() {
	const router = useRouter();
	const me = useMe();
	return async (id: string) => {
		if (state || id === me.active?.id) return;
		const org = me.organizations.find((o) => o.id === id);
		if (!org) return;
		set({
			phase: "leaving",
			target: {
				id,
				name: org.name,
				logo: org.logo?.url ?? null,
				background: org.logo?.background ?? null,
			},
		});
		const started = performance.now();
		try {
			const res = await authClient.organization.setActive({ organizationId: id });
			if (res.error) throw new Error(res.error.message ?? "Couldn't switch organization");
			forgetMe();
			await loadMe();
			const to = sectionOf(router.state.location.pathname) as "/";
			router.clearCache();
			// The new organization's page loads behind the veil, so it opens complete.
			await router.preloadRoute({ to }).catch(() => {});
			await wait(Math.max(0, LEAST_MS - (performance.now() - started)));
			await router.navigate({ to });
			await router.invalidate();
			const home = new Promise<void>((resolve) => {
				onFaded = resolve;
				setTimeout(resolve, FADE_MS);
			});
			const current = state as Switching | null;
			if (current) set({ ...current, phase: "arriving" });
			await home;
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Couldn't switch organization");
		} finally {
			onFaded = null;
			set(null);
			freePointer();
		}
	};
}
