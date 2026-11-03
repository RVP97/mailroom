import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

/** A public page of plain text (privacy policy, terms), outside the dashboard. */
export function LegalPage({
	title,
	updated,
	children,
}: {
	title: string;
	updated?: string;
	children: ReactNode;
}) {
	return (
		<div className="min-h-svh bg-canvas px-4 py-8 sm:px-10">
			<Link
				to="/login"
				className="inline-block"
			>
				<Logo />
			</Link>
			<article className="mx-auto mt-12 max-w-2xl pb-16 text-[15px] leading-relaxed text-muted-foreground [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_p]:mb-3 [&_ul]:mb-3 [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-2">
				<h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
					{title}
				</h1>
				{updated && <p className="mt-1 text-sm">Last updated {updated}</p>}
				<div className="mt-8">{children}</div>
			</article>
		</div>
	);
}
