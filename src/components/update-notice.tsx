import { ArrowUpRight, ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { versionStatusFn } from "@/functions/admin";
import type { Me } from "@/lib/me";
import { useSketching } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { REPO_URL, VERSION } from "@/lib/version";
import type { VersionStatus } from "@/server/updates";

/**
 * New versions of Mailroom, for the people who run a deployment (ADMIN_EMAILS): the sidebar's
 * link to the GitHub repo (everyone sees it) says "Update" when a newer release is out, and a
 * card in the corner says what's new until it's dismissed (once per version, in this browser).
 */

const DISMISSED = "mailroom:update-dismissed";

/** One ask a page load, shared by the sidebar (twice on phones) and the card. */
let asked: Promise<VersionStatus | null> | null = null;
function useVersionStatus(isAdmin: boolean) {
	const sketching = useSketching();
	const [status, setStatus] = useState<VersionStatus | null>(null);
	useEffect(() => {
		if (!isAdmin || sketching) return;
		asked ??= versionStatusFn().catch(() => null);
		let live = true;
		void asked.then((s) => live && setStatus(s));
		return () => {
			live = false;
		};
	}, [isAdmin, sketching]);
	return status;
}

const readDismissed = () => {
	try {
		return localStorage.getItem(DISMISSED);
	} catch {
		return null;
	}
};

export function GitHubMark({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			className={className}
			fill="currentColor"
		>
			<path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3" />
		</svg>
	);
}

/** The sidebar's quiet link to Mailroom on GitHub, with the running version. */
export function RepoLink({ me }: { me: Me }) {
	const status = useVersionStatus(me.isAdmin);
	const update = status?.updateAvailable ? status.latest : null;
	return (
		<a
			href={update ? update.url : REPO_URL}
			target="_blank"
			rel="noreferrer"
			title={
				update ? `Mailroom ${update.version} is out: see what's new` : "Mailroom on GitHub"
			}
			className="group flex h-7 items-center gap-2 rounded-md px-2 text-xs text-faint transition-colors hover:bg-accent hover:text-muted-foreground"
		>
			<GitHubMark className="size-3.5 shrink-0" />
			<span className="flex-1 truncate">Mailroom {VERSION}</span>
			{update ? (
				<span
					className={cn(
						"rounded-full px-1.5 py-px text-[11px] font-medium",
						status?.securityUpdate
							? "bg-destructive/12 text-destructive"
							: "bg-brand/12 text-brand",
					)}
				>
					{status?.securityUpdate ? "Security" : "Update"}
				</span>
			) : (
				<ArrowUpRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
			)}
		</a>
	);
}

/** The card in the corner while a newer release is out and this browser hasn't dismissed it. */
export function UpdateNotice({ me }: { me: Me }) {
	const status = useVersionStatus(me.isAdmin);
	const [dismissed, setDismissed] = useState<string | null>(() =>
		typeof window === "undefined" ? null : readDismissed(),
	);
	const latest = status?.updateAvailable ? status.latest : null;
	// A security update shows as the banner above the page instead, which can't be dismissed.
	if (!latest || status?.securityUpdate || dismissed === latest.version) return null;
	const dismiss = () => {
		try {
			localStorage.setItem(DISMISSED, latest.version);
		} catch {}
		setDismissed(latest.version);
	};
	return (
		<section
			aria-label="A new version of Mailroom"
			className={cn(
				"fixed right-4 bottom-4 left-4 z-50 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg sm:left-auto sm:w-[22rem]",
				"animate-in fade-in slide-in-from-bottom-2 duration-200 ease-out",
			)}
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
					<GitHubMark className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">Mailroom {latest.version} is out</p>
					<p className="mt-0.5 text-sm text-muted-foreground">
						This deployment runs {status?.current}.
					</p>
				</div>
				<Button
					variant="ghost"
					size="icon-xs"
					className="-mt-1 -mr-1"
					aria-label="Dismiss"
					onClick={dismiss}
				>
					<X />
				</Button>
			</div>
			{latest.highlights.length > 0 && (
				<ul className="mt-3 flex flex-col gap-1 pl-10 text-sm text-muted-foreground">
					{latest.highlights.map((h) => (
						<li
							key={h}
							className="relative before:absolute before:top-[0.6em] before:-left-3 before:size-1 before:rounded-full before:bg-faint"
						>
							{h}
						</li>
					))}
				</ul>
			)}
			<div className="mt-4 flex gap-2 pl-10">
				<Button
					asChild
					size="sm"
				>
					<a
						href={latest.url}
						target="_blank"
						rel="noreferrer"
					>
						What's new
					</a>
				</Button>
				<Button
					asChild
					size="sm"
					variant="outline"
				>
					<a
						href={status?.upgradeUrl}
						target="_blank"
						rel="noreferrer"
					>
						How to update
					</a>
				</Button>
			</div>
		</section>
	);
}

/**
 * Above every page while a newer release fixes a security problem (its title says "security"):
 * not dismissible, gone once the deployment runs that version. Admins are also emailed once.
 */
export function SecurityUpdateBanner({ me }: { me: Me }) {
	const status = useVersionStatus(me.isAdmin);
	if (!status?.securityUpdate || !status.latest) return null;
	return (
		<div
			role="alert"
			className="flex items-start gap-2 border-b border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] bg-destructive/[0.08] px-4 py-2.5 text-sm md:px-10 lg:rounded-t-xl"
		>
			<ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
			<span className="min-w-0 flex-1">
				Mailroom {status.latest.version} fixes a security problem. This deployment runs{" "}
				{status.current}: update it soon.{" "}
				<a
					href={status.latest.url}
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-4"
				>
					What's fixed
				</a>{" "}
				·{" "}
				<a
					href={status.upgradeUrl}
					target="_blank"
					rel="noreferrer"
					className="font-medium underline underline-offset-4"
				>
					How to update
				</a>
			</span>
		</div>
	);
}
