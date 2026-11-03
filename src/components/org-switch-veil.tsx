import { useLayoutEffect } from "react";
import { OrgAvatar } from "@/components/org-avatar";
import { faded, useSwitching } from "@/lib/switch-org";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Over the whole app while the organization changes: the old page dims and a card says
 * «Switching to» the new one, with a thin bar running under it. Nothing flies: once the new
 * page is there the card fades out over it. Meanwhile no click lands on the old organization's
 * page.
 */
export function OrgSwitchVeil() {
	const s = useSwitching();
	const phase = s?.phase;

	// The app eases back a touch while the new organization loads (html[data-org-depth]).
	useLayoutEffect(() => {
		const root = document.documentElement;
		if (phase === "leaving" && !reducedMotion()) root.dataset.orgDepth = "";
		else delete root.dataset.orgDepth;
	}, [phase]);

	// Out of the way once the card has faded (styles.css: .org-veil[data-phase=arriving]).
	useLayoutEffect(() => {
		if (phase !== "arriving") return;
		const t = setTimeout(faded, reducedMotion() ? 0 : 220);
		return () => clearTimeout(t);
	}, [phase]);

	if (!s) return null;
	return (
		<div
			data-phase={s.phase}
			role="status"
			aria-live="polite"
			className="org-veil fixed inset-0 z-[80] grid place-items-center"
		>
			<div className="org-veil-bg absolute inset-0 bg-background/60 backdrop-blur-[4px]" />
			<div className="org-veil-card relative flex w-[min(17rem,calc(100vw-2rem))] flex-col items-center rounded-2xl bg-popover px-6 pt-7 pb-6 text-center shadow-popover">
				<OrgAvatar
					name={s.target.name}
					id={s.target.id}
					logo={s.target.logo}
					background={s.target.background}
					className="size-12 rounded-xl text-lg shadow-[inset_0_1px_0_oklch(1_0_0/0.2),inset_0_0_0_1px_oklch(0_0_0/0.08),0_6px_16px_-6px_oklch(0_0_0/0.35)]"
				/>
				<div className="org-veil-text mt-4 flex w-full min-w-0 flex-col gap-1">
					<span className="text-[13px] text-muted-foreground">Switching to</span>
					<span className="truncate text-[17px] font-semibold tracking-[-0.015em]">
						{s.target.name}
					</span>
				</div>
				<span
					aria-hidden="true"
					className="org-veil-bar relative mt-5 h-0.5 w-28 overflow-hidden rounded-full bg-border"
				/>
			</div>
		</div>
	);
}
