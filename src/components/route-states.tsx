import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { NoOrgAccess } from "@/components/no-org-access";
import { Button } from "@/components/ui/button";
import { forgetMe, forgetRememberedMe, isNetworkError } from "@/lib/me";
import { isStaleCode, reloadForNewCode } from "@/lib/stale-code";
import { isOrgUnavailable, repinFromAddress } from "@/lib/tab-org";

/** What a page shows while its data loads for the first time: its frame, sketched. */
export function PagePending() {
	return (
		<div
			className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 pt-6 pb-16 md:px-10 md:pt-9"
			aria-busy="true"
		>
			<div className="flex flex-col gap-2">
				<div className="skeleton h-7 w-40" />
				<div className="skeleton h-4 w-80 max-w-full" />
			</div>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				{Array.from({ length: 6 }, (_, i) => (
					<div
						key={i}
						className="flex h-11 items-center gap-4 border-b border-border/70 px-5 last:border-0"
					>
						<div className="skeleton h-3.5 w-48" />
						<div className="skeleton h-3.5 w-16" />
						<div className="skeleton ml-auto h-3.5 w-10" />
					</div>
				))}
			</div>
		</div>
	);
}

/** A list's rows while new filters (a search, a status, the next page) load. */
export function RowsPending({ rows = 8 }: { rows?: number }) {
	return (
		<div aria-busy="true">
			{Array.from({ length: rows }, (_, i) => (
				<div
					key={i}
					className="flex h-11 items-center gap-4 border-b border-border/70 px-5 last:border-0"
				>
					<div
						className="skeleton h-3.5"
						style={{ width: `${[48, 36, 42, 30, 46, 38, 44, 34][i % 8]}%` }}
					/>
					<div className="skeleton hidden h-3.5 w-16 sm:block" />
					<div className="skeleton ml-auto h-3.5 w-10" />
				</div>
			))}
		</div>
	);
}

/** An address that matches no page. */
export function PageMissing() {
	return (
		<div className="flex min-h-[70svh] flex-col items-center justify-center gap-1 px-4 text-center">
			<p className="font-mono text-sm text-faint">404</p>
			<h1 className="text-xl font-semibold tracking-[-0.015em]">This page doesn't exist</h1>
			<p className="text-base text-muted-foreground">The link may be old, or mistyped.</p>
			<Button
				asChild
				variant="outline"
				className="mt-5"
			>
				<Link to="/">Go to the overview</Link>
			</Button>
		</div>
	);
}

/** A page that failed: what happened, and a way to try again. Signed out? Back to sign-in. */
export function PageError({ error, reset }: ErrorComponentProps) {
	const router = useRouter();
	const signedOut = error instanceof Response && error.status === 401;
	const [reloading] = useState(() => isStaleCode(error) && reloadForNewCode());
	// The tab's organization refused: what the tab remembered is stale if the address names
	// another one (it takes that one and asks again, once); otherwise the address's isn't theirs.
	const [refused] = useState(() => {
		if (!isOrgUnavailable(error)) return null;
		return repinFromAddress() ? "retry" : "no-access";
	});
	useEffect(() => {
		if (refused !== "retry") return;
		forgetMe();
		reset();
		void router.invalidate();
	}, [refused, reset, router]);
	useEffect(() => {
		if (!signedOut) return;
		forgetMe();
		forgetRememberedMe();
		void router.navigate({
			to: "/login",
			search: { next: `${window.location.pathname}${window.location.search}` },
		});
	}, [signedOut, router]);
	if (refused === "no-access") return <NoOrgAccess />;
	if (signedOut || reloading || refused) return null;
	const message =
		error instanceof Response
			? error.statusText || `The server answered ${error.status}`
			: isNetworkError(error)
				? "Mailroom couldn't be reached. Check your connection and try again."
				: error instanceof Error
					? error.message
					: "Something went wrong";
	return (
		<div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center px-4 text-center">
			<span className="mb-4 flex size-10 items-center justify-center rounded-[10px] bg-card text-warning shadow-raised">
				<TriangleAlert className="size-[18px]" />
			</span>
			<h1 className="text-base font-semibold">This page didn't load</h1>
			<p className="mt-1 text-sm break-words text-muted-foreground">{message}</p>
			<div className="mt-5 flex gap-2">
				<Button
					variant="outline"
					onClick={() => {
						reset();
						void router.invalidate();
					}}
				>
					<RotateCw />
					Try again
				</Button>
				<Button
					asChild
					variant="ghost"
				>
					<Link to="/">Go to the overview</Link>
				</Button>
			</div>
		</div>
	);
}
