import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";

/**
 * A thin line at the top while a page waits on the server. It only shows after 120ms, so pages
 * that open from the cache (most of them) never flash it.
 */
export function NavProgress() {
	const loading = useRouterState({ select: (s) => s.status === "pending" });
	const [show, setShow] = useState(false);
	useEffect(() => {
		if (!loading) return setShow(false);
		const t = setTimeout(() => setShow(true), 120);
		return () => clearTimeout(t);
	}, [loading]);
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden rounded-t-xl"
		>
			<div
				className={`h-full w-full origin-left bg-brand transition-opacity duration-200 ${show ? "animate-progress opacity-100" : "opacity-0"}`}
			/>
		</div>
	);
}
