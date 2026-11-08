import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { PageHeader, TabCount } from "@/components/page";
import { useMe } from "@/lib/me";

export type ContactsTab =
	| "contacts"
	| "segments"
	| "topics"
	| "properties"
	| "engagement"
	| "leads"
	| "growth"
	| "forms";

type Counts = { contacts: number; segments: number; topics: number; properties: number };

/**
 * The counts the Contacts tab last showed, per brand, so the other tabs show the same numbers
 * (and the bar doesn't change width) without loading them again.
 */
const seen = new Map<string, Counts>();

const TABS: { tab: ContactsTab; label: string }[] = [
	{ tab: "contacts", label: "Contacts" },
	{ tab: "segments", label: "Segments" },
	{ tab: "topics", label: "Topics" },
	{ tab: "properties", label: "Properties" },
	{ tab: "engagement", label: "Engagement" },
	{ tab: "leads", label: "Leads" },
	{ tab: "growth", label: "Growth" },
	{ tab: "forms", label: "Sign-up forms" },
];

const tabClass =
	"relative inline-flex h-10 shrink-0 items-center gap-1.5 rounded-sm px-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring after:absolute after:inset-x-0 after:bottom-0 after:h-[1.5px] after:rounded-full after:bg-foreground after:opacity-0 data-current:text-foreground data-current:after:opacity-100";

/**
 * The Contacts section's header: one title, its actions, and a tab per view (the lists, plus
 * Engagement, Growth and Sign-up forms, which are pages of their own). `filters` sit at the
 * right of the tab bar.
 */
export function ContactsHeader({
	current,
	brand,
	counts,
	actions,
	filters,
}: {
	current: ContactsTab;
	brand?: string;
	counts?: Counts;
	actions?: ReactNode;
	filters?: ReactNode;
}) {
	const me = useMe();
	const key = `${me.active?.id ?? ""}:${brand ?? ""}`;
	// Only in the browser: on the server this would be shared between everyone's requests.
	if (counts && typeof window !== "undefined") seen.set(key, counts);
	const n = counts ?? (typeof window !== "undefined" ? seen.get(key) : undefined);
	const nav = useRef<HTMLElement>(null);
	// On a phone the bar scrolls: keep the open tab in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: again each time another tab opens
	useEffect(() => {
		const el = nav.current?.querySelector<HTMLElement>("[data-current]");
		if (!el || !nav.current) return;
		const box = nav.current;
		if (
			el.offsetLeft + el.offsetWidth > box.scrollLeft + box.clientWidth ||
			el.offsetLeft < box.scrollLeft
		)
			box.scrollLeft = el.offsetLeft - 16;
	}, [current]);
	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title="Contacts"
				description="The people your broadcasts and automations go to, per brand. Segments group them; topics are what each one chooses to get."
				actions={actions}
			/>
			<div className="flex flex-wrap items-end justify-between gap-x-3 border-b border-border/70">
				<nav
					ref={nav}
					aria-label="Contacts"
					className="-mb-px flex max-w-full items-center gap-5 overflow-x-auto [scrollbar-width:none]"
				>
					{TABS.map(({ tab, label }) => {
						const count = n && tab in n ? n[tab as keyof Counts] : undefined;
						// The router marks a link active on its own (aria-current); `exact` keeps it to
						// the page it really is, and data-current draws which tab is open.
						const props = {
							"data-current": tab === current ? "" : undefined,
							activeOptions: { exact: true },
							className: tabClass,
							children: (
								<>
									{label}
									{count !== undefined && <TabCount n={count} />}
								</>
							),
						};
						if (tab === "engagement")
							return (
								<Link
									key={tab}
									to="/contacts/engagement"
									search={{ brand }}
									{...props}
								/>
							);
						if (tab === "leads")
							return (
								<Link
									key={tab}
									to="/contacts/leads"
									search={{ brand }}
									{...props}
								/>
							);
						if (tab === "growth")
							return (
								<Link
									key={tab}
									to="/contacts/growth"
									search={{ brand }}
									{...props}
								/>
							);
						if (tab === "forms")
							return (
								<Link
									key={tab}
									to="/contacts/forms"
									{...props}
								/>
							);
						return (
							<Link
								key={tab}
								to="/contacts"
								search={{ tab: tab === "contacts" ? undefined : tab, brand }}
								{...props}
							/>
						);
					})}
				</nav>
				{filters && (
					// 34px controls plus this margin are the tabs' 40px, so the bar is as tall with them.
					<div className="mb-1.5 flex flex-wrap items-center gap-2">{filters}</div>
				)}
			</div>
		</div>
	);
}
