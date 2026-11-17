import { ArrowRight, Lock, LogIn } from "lucide-react";
import { useEffect, useState } from "react";
import { AuthShell } from "@/components/auth-shell";
import { OrgAvatar } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import { getMyOrganizations } from "@/functions/session";
import { authClient } from "@/lib/auth-client";
import { forgetMe, forgetRememberedMe } from "@/lib/me";
import { handleOfPath } from "@/lib/org-path";
import { ROLE_LABEL } from "@/lib/roles";

type Mine = Awaited<ReturnType<typeof getMyOrganizations>>;

/**
 * An address naming an organization that doesn't exist or isn't the signed-in person's (someone
 * else's link, a mistyped one, one they were removed from, or a session that changed in another
 * tab): the same page for all of them, so handles can't be probed. It says which account is
 * signed in (the usual reason), and offers that account's organizations and another sign-in.
 * Every way out is a full page load: an in-app one would keep what this tab remembered and land
 * here again.
 */
export function NoOrgAccess() {
	const [mine, setMine] = useState<Mine | null>(null);
	const [failed, setFailed] = useState(false);
	const [leaving, setLeaving] = useState(false);
	useEffect(() => {
		getMyOrganizations()
			.then(setMine)
			.catch(() => setFailed(true));
	}, []);
	const address = typeof window === "undefined" ? "" : window.location.pathname;
	const handle = handleOfPath(address);
	const host = typeof window === "undefined" ? "" : window.location.host;

	const signInAgain = async () => {
		setLeaving(true);
		await authClient.signOut().catch(() => {});
		forgetMe();
		forgetRememberedMe();
		window.location.assign(
			`/login?next=${encodeURIComponent(`${address}${window.location.search}`)}`,
		);
	};

	return (
		<AuthShell
			footer={
				mine ? (
					<>
						Signed in as <span className="text-foreground">{mine.email}</span>
					</>
				) : null
			}
		>
			<div className="flex flex-col items-center text-center">
				{handle && (
					<div className="mb-5 inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/70 py-1 pr-3 pl-2 font-mono text-xs text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]">
						<Lock
							className="size-3 shrink-0 text-faint"
							strokeWidth={2}
						/>
						<span className="truncate">
							{host}/<span className="text-foreground">{handle}</span>
						</span>
					</div>
				)}
				<h1 className="text-lg font-semibold tracking-[-0.015em] text-balance">
					You don't have access to this organization
				</h1>
				<p className="mt-1.5 text-sm text-pretty text-muted-foreground">
					It doesn't exist, or{" "}
					{mine ? <span className="text-foreground">{mine.email}</span> : "your account"}{" "}
					isn't a member of it. Ask one of its owners to invite you, or open one of yours.
				</p>
			</div>

			<div className="mt-6">
				{failed ? null : !mine ? (
					<div
						className="flex flex-col gap-1.5"
						aria-busy="true"
					>
						{[0, 1].map((i) => (
							<div
								key={i}
								className="flex h-12 items-center gap-3 rounded-lg px-3"
							>
								<div className="skeleton size-7 rounded-md" />
								<div className="skeleton h-3.5 w-32" />
							</div>
						))}
					</div>
				) : mine.organizations.length ? (
					<>
						<p className="eyebrow mb-1.5 px-1">Your organizations</p>
						<ul className="-mx-1 flex max-h-72 flex-col overflow-y-auto">
							{mine.organizations.map((o) => (
								<li key={o.id}>
									<a
										href={o.handle ? `/${o.handle}` : "/"}
										className="group flex h-12 items-center gap-3 rounded-lg px-2 transition-colors duration-100 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
									>
										<OrgAvatar
											id={o.id}
											name={o.name}
											logo={o.logo?.url}
											background={o.logo?.background}
											className="size-7 rounded-md text-xs"
										/>
										<span className="min-w-0 flex-1 text-left">
											<span className="block truncate text-sm font-medium">
												{o.name}
											</span>
											<span className="block truncate text-xs text-muted-foreground">
												{ROLE_LABEL[o.role as keyof typeof ROLE_LABEL] ??
													o.role}
											</span>
										</span>
										<ArrowRight className="size-3.5 shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
									</a>
								</li>
							))}
						</ul>
					</>
				) : (
					<p className="rounded-lg bg-muted/60 px-3 py-3 text-center text-sm text-muted-foreground">
						This account isn't in any organization yet.
					</p>
				)}
			</div>

			<div className="mt-5 border-t pt-5">
				<Button
					variant="outline"
					className="w-full"
					disabled={leaving}
					onClick={signInAgain}
				>
					<LogIn />
					{leaving ? "Signing out…" : "Sign in with another account"}
				</Button>
			</div>
		</AuthShell>
	);
}
