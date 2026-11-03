import { useMatch } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Skeletons that are the page itself.
 *
 * A page's skeleton (its route's `pendingComponent`) renders the page's own component with stand-in
 * data inside <Sketch>. Everything the page always shows (its title, labels, column names, buttons)
 * renders as it is; only what comes from the data, wrapped in <Ph> (or carrying `data-ph`), is drawn
 * as a placeholder of the same size. Because it is the same component in the same layout, nothing
 * moves when the data arrives: scripts/check-skeletons.mjs measures every element of every page
 * before and after loading and fails on any shift.
 *
 * Inside a page, read data with usePage(Route) instead of Route.useLoaderData()/useSearch()/
 * useParams(): it answers with the stand-in data while sketching, and also works when the dashboard
 * shows the skeleton outside the route (a click to a page that is still loading, the first paint).
 */

type SketchValue = { data: unknown };
const SketchContext = createContext<SketchValue | null>(null);

/** Where a skeleton shown outside its route is going: its search and params. */
type Target = { search: unknown; params: unknown };
export const SketchTarget = createContext<Target | null>(null);

/** Renders children as their own skeleton: stand-in data, nothing clickable, data spots drawn. */
export function Sketch({ data, children }: { data?: unknown; children: ReactNode }) {
	// The first stand-ins stay: pages keep loader data by identity (useOptimisticState).
	const [value] = useState(() => ({ data }));
	return (
		<SketchContext.Provider value={value}>
			<div
				data-sketch
				aria-busy="true"
				inert
				className="contents"
			>
				{children}
			</div>
		</SketchContext.Provider>
	);
}

/**
 * Draws its children as their own skeleton while `loading` (a list's new filters loading: the rows
 * already there turn into placeholders of the same size).
 */
export function SketchWhile({ loading, children }: { loading: boolean; children: ReactNode }) {
	const outer = useContext(SketchContext);
	// Always the same wrapper, so the rows aren't remounted when loading starts and ends.
	return (
		<SketchContext.Provider value={loading ? WHILE : outer}>
			<div
				data-sketch={loading ? "" : undefined}
				aria-busy={loading || undefined}
				inert={loading}
				className="contents"
			>
				{children}
			</div>
		</SketchContext.Provider>
	);
}
const WHILE: SketchValue = { data: undefined };

/** True inside a skeleton. */
export const useSketching = () => useContext(SketchContext) !== null;

/**
 * A spot that shows data: drawn as a placeholder (its own size, from its stand-in text) while
 * sketching, and as it is otherwise. Static text never goes in one.
 */
export function Ph({ children, className }: { children?: ReactNode; className?: string }) {
	return (
		<span
			data-ph
			className={className}
		>
			{children}
		</span>
	);
}

/** A block that shows data: same box while sketching, drawn as a placeholder. */
export function PhBox({ className, children }: { className?: string; children?: ReactNode }) {
	return (
		<div
			data-ph
			className={cn(className)}
		>
			{children}
		</div>
	);
}

type AnyPageRoute = {
	id: string;
	types: { loaderData: unknown; fullSearchSchema: unknown; allParams: unknown };
};

/**
 * A page's data, search and params: from its route, or the stand-ins while it's sketched. Works
 * outside the route too (the dashboard draws a page's skeleton before the router enters it).
 */
export function usePage<R extends AnyPageRoute>(
	route: R,
): {
	data: R["types"]["loaderData"];
	search: R["types"]["fullSearchSchema"];
	params: R["types"]["allParams"];
} {
	const sketch = useContext(SketchContext);
	const target = useContext(SketchTarget);
	// biome-ignore lint/suspicious/noExplicitAny: the route's own types are restored by the signature
	const match = useMatch({ from: route.id as any, shouldThrow: false }) as any;
	return {
		data: sketch ? sketch.data : match?.loaderData,
		search: match?.search ?? target?.search ?? {},
		params: match?.params ?? target?.params ?? {},
	} as never;
}

/** `n` stand-in rows. */
export function sample<T>(n: number, row: (i: number) => T): T[] {
	return Array.from({ length: n }, (_, i) => row(i));
}

/** Stand-in texts of a typical length, picked by row so a list doesn't look stamped. */
export function pick<T>(i: number, options: readonly T[]): T {
	return options[i % options.length] as T;
}

/** A stand-in time `minutes` ago, as the API sends it. */
export function ago(minutes: number) {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

/**
 * How many rows each list had the last time it loaded in this browser, in a small cookie: the
 * server's first paint and the browser draw the same number of skeleton rows (the page below
 * doesn't move when the data comes, and the first paint matches the page).
 */
const ROWS_COOKIE = "mailroom_rows";
const MAX_LISTS = 40;

function parseRows(text: string | undefined): Record<string, number> {
	try {
		const rows = text ? JSON.parse(text) : {};
		return rows && typeof rows === "object" ? rows : {};
	} catch {
		return {};
	}
}

const savedRows = createIsomorphicFn()
	.server(() => parseRows(getCookie(ROWS_COOKIE)))
	.client(() => {
		const raw = document.cookie
			.split("; ")
			.find((c) => c.startsWith(`${ROWS_COOKIE}=`))
			?.slice(ROWS_COOKIE.length + 1);
		return parseRows(raw ? decodeURIComponent(raw) : undefined);
	});

/** How many rows the list `key` had last time (at most `max`); `fallback` the first time. */
export function rememberedRows(key: string, fallback: number, max = 50): number {
	const n = savedRows()[key];
	return typeof n === "number" && Number.isInteger(n) && n >= 0 ? Math.min(n, max) : fallback;
}

/** Remembers a loaded list's length for its next skeleton. */
export function useRememberRows(key: string, n: number | undefined) {
	const sketching = useSketching();
	useEffect(() => {
		if (sketching || n === undefined) return;
		const rows = savedRows();
		if (rows[key] === n) return;
		delete rows[key];
		rows[key] = n;
		const keys = Object.keys(rows);
		for (const old of keys.slice(0, Math.max(0, keys.length - MAX_LISTS))) delete rows[old];
		document.cookie = `${ROWS_COOKIE}=${encodeURIComponent(JSON.stringify(rows))}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
	}, [key, n, sketching]);
}

/** Forgets the lists' lengths (signing out). */
export function forgetRows() {
	document.cookie = `${ROWS_COOKIE}=; Path=/; Max-Age=0`;
}

const listed = new Map<string, unknown>();

/**
 * Keeps the rows a list showed (in memory, for this visit), so the page one of them opens can draw
 * its skeleton from what the list already knew: its title, status and dates, exactly.
 */
export function useListed<T extends { id: string }>(kind: string, rows: readonly T[] | undefined) {
	const sketching = useSketching();
	useEffect(() => {
		if (sketching || !rows) return;
		for (const r of rows) {
			const key = `${kind}:${r.id}`;
			listed.delete(key);
			listed.set(key, r);
		}
		while (listed.size > 2000) listed.delete(listed.keys().next().value as string);
	}, [kind, rows, sketching]);
}

/**
 * Keeps the records a page showed (the last few of each kind, in this browser), so opening or
 * reloading one again draws its skeleton from what it showed.
 */
export function useOpened<T extends { id: string }>(kind: string, record: T | undefined) {
	const sketching = useSketching();
	useEffect(() => {
		if (sketching || !record) return;
		listed.set(`${kind}:${record.id}`, record);
		keep(kind, record.id, record);
	}, [kind, record, sketching]);
}

const OPENED_KEY = "mailroom:opened:";

/** Saves `value` as the latest of `kind` in this browser, keeping the last `max`. */
export function keep(kind: string, id: string, value: unknown, max = 20) {
	try {
		const all = { ...kept(kind) };
		delete all[id];
		all[id] = value;
		const ids = Object.keys(all);
		for (const old of ids.slice(0, Math.max(0, ids.length - max))) delete all[old];
		localStorage.setItem(OPENED_KEY + kind, JSON.stringify(all));
	} catch {}
}

/** What keep() saved for `kind`, by id. */
export function kept(kind: string): Record<string, unknown> {
	try {
		return JSON.parse(localStorage.getItem(OPENED_KEY + kind) ?? "{}") ?? {};
	} catch {
		return {};
	}
}

/** The row a list showed for this record (or the page itself last time), if one did. */
export function listedRow<T>(kind: string, id: string | undefined): T | undefined {
	if (id === undefined) return undefined;
	return (listed.get(`${kind}:${id}`) ?? kept(kind)[id]) as T | undefined;
}
