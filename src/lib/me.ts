import { getRouteApi } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createContext, useContext } from "react";
import { getMe } from "@/functions/session";
import { isNetworkError } from "@/lib/network-error";
import { identify } from "@/lib/sentry";
import { forgetRows } from "@/lib/sketch";

export type Me = Awaited<ReturnType<typeof getMe>>;

/**
 * Who is signed in, kept in the browser after the first load so moving between pages never waits
 * on it (the dashboard's layout used to ask the server on every click). Anything that changes it
 * (switching or renaming an organization, your name, signing out) calls forgetMe() first.
 */
let cached: Me | null = null;

export async function loadMe(): Promise<Me> {
	if (typeof window === "undefined") return getMe();
	cached ??= await getMeRetrying();
	identify(cached.user);
	try {
		localStorage.setItem(SHAPE_KEY, JSON.stringify(cached));
		document.cookie = `${FRAME_COOKIE}=${encodeURIComponent(frameOf(cached))}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
	} catch {}
	return cached;
}

export { isNetworkError };

/**
 * Every dashboard page waits on this, so a moment without network (opening it from a phone's home
 * screen before its connection is back) asks again a couple of times before the page shows an
 * error.
 */
async function getMeRetrying(): Promise<Me> {
	for (const wait of [400, 1200]) {
		try {
			return await getMe();
		} catch (error) {
			if (!isNetworkError(error)) throw error;
			await new Promise((r) => setTimeout(r, wait));
		}
	}
	return getMe();
}

/**
 * The menu's shape in a cookie, so the server's first paint (before the browser's code runs)
 * draws the same frame: the organization's and person's names as placeholders of their length,
 * the admin's section, the brands. Kept small.
 */
const FRAME_COOKIE = "mailroom_frame";

function frameOf(me: Me) {
	const frame = {
		...me,
		organizations: me.active ? [me.active] : [],
		pausedDomains: [],
	};
	const text = JSON.stringify(frame);
	return text.length < 2500 ? text : JSON.stringify({ ...frame, brands: [] });
}

/** The frame the server's first paint draws: the cookie's, in either place. */
export const frameMe = createIsomorphicFn()
	.server((): Me | null => {
		try {
			const saved = getCookie(FRAME_COOKIE);
			return saved ? (JSON.parse(saved) as Me) : null;
		} catch {
			return null;
		}
	})
	.client((): Me | null => rememberedMe());

const SHAPE_KEY = "mailroom:me";

/**
 * Who was signed in the last time the dashboard opened in this browser: the first paint's skeleton
 * draws the same menu (the admin's section, the brands line) so nothing moves when it loads.
 */
export function rememberedMe(): Me | null {
	try {
		const saved = localStorage.getItem(SHAPE_KEY);
		return saved ? (JSON.parse(saved) as Me) : null;
	} catch {
		return null;
	}
}

/** Forgets the remembered one too (signing out). */
export function forgetRememberedMe() {
	try {
		localStorage.removeItem(SHAPE_KEY);
		document.cookie = `${FRAME_COOKIE}=; Path=/; Max-Age=0`;
		forgetRows();
		// What pages showed, kept for their skeletons, isn't left behind for the next person.
		for (const k of Object.keys(localStorage))
			if (k.startsWith("mailroom:opened:")) localStorage.removeItem(k);
	} catch {}
}

/** The stand-in Me while the dashboard's first paint is sketched. */
export const MeStandIn = createContext<Me | null>(null);

export function forgetMe() {
	cached = null;
}

const app = getRouteApi("/_app");

/** Who is signed in, inside the dashboard. */
export function useMe(): Me {
	const loaded = app.useLoaderData();
	const standIn = useContext(MeStandIn);
	return (loaded ?? standIn) as Me;
}
