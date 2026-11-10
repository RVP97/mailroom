import { useRouter } from "@tanstack/react-router";
import { Command } from "cmdk";
import {
	ClipboardCheck,
	Contact as ContactIcon,
	CornerDownLeft,
	Flag,
	Globe,
	LayoutTemplate,
	LifeBuoy,
	type LucideIcon,
	Megaphone,
	MessageSquare,
	Monitor,
	Moon,
	Newspaper,
	Search,
	Sun,
	UserSearch,
	Users,
	Workflow,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { OrgAvatar } from "@/components/org-avatar";
import { OPEN_SWITCHER } from "@/components/org-switcher";
import { useTheme } from "@/components/theme-provider";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { searchEverythingFn } from "@/functions/search";
import type { Me } from "@/lib/me";

type Hit = Awaited<ReturnType<typeof searchEverythingFn>>["hits"][number];

const KIND: Record<Hit["kind"], { label: string; icon: LucideIcon }> = {
	contact: { label: "Contacts", icon: ContactIcon },
	conversation: { label: "Conversations", icon: MessageSquare },
	broadcast: { label: "Broadcasts", icon: Megaphone },
	template: { label: "Templates", icon: LayoutTemplate },
	segment: { label: "Segments", icon: Users },
	automation: { label: "Automations", icon: Workflow },
	newsletter: { label: "Newsletters", icon: Newspaper },
	campaign: { label: "Campaigns", icon: Flag },
	survey: { label: "Surveys", icon: ClipboardCheck },
	article: { label: "Help articles", icon: LifeBuoy },
	domain: { label: "Domains", icon: Globe },
};

/** A hit's value for the menu: always matches what was typed, so the menu never hides it. */
const hitValue = (h: Hit, q: string) => `${h.kind} ${h.id} ${h.title} ${h.detail ?? ""} ${q}`;

/** What the organization has matching what's typed, a moment after typing stops. */
function useSearch(q: string, open: boolean) {
	const [state, setState] = useState<{ q: string; hits: Hit[]; busy: boolean }>({
		q: "",
		hits: [],
		busy: false,
	});
	useEffect(() => {
		if (!open || q.length < 2) {
			setState({ q: "", hits: [], busy: false });
			return;
		}
		let stale = false;
		setState((s) => ({ ...s, busy: true }));
		const timer = setTimeout(() => {
			searchEverythingFn({ data: { q } })
				.then((r) => !stale && setState({ q, hits: r.hits, busy: false }))
				.catch(() => !stale && setState({ q, hits: [], busy: false }));
		}, 180);
		return () => {
			stale = true;
			clearTimeout(timer);
		};
	}, [q, open]);
	return state;
}

export type NavItem = {
	to: string;
	label: string;
	icon: LucideIcon;
	key?: string;
	/** Other paths that belong to it (an inbox's workflow page belongs to Agent inboxes). */
	also?: string[];
};

const Ctx = createContext<{ open: () => void }>({ open: () => {} });
export const useCommandMenu = () => useContext(Ctx);

const isTyping = (t: EventTarget | null) =>
	t instanceof HTMLElement &&
	(t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * ⌘K: go anywhere, switch organization, change theme, or look up an email. Also the "g then a
 * letter" shortcuts (g e: Emails), like Linear's.
 */
export function CommandMenu({
	nav,
	me,
	onSwitchOrg,
	children,
}: {
	nav: NavItem[];
	me: Me;
	onSwitchOrg: (id: string) => void;
	children: ReactNode;
}) {
	const router = useRouter();
	const { setTheme } = useTheme();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");

	useEffect(() => {
		let g = 0;
		const onKey = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setOpen((v) => !v);
				return;
			}
			if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
			if (e.key === "g") {
				g = Date.now();
				return;
			}
			if (Date.now() - g < 1000) {
				const item = nav.find((n) => n.key === e.key.toLowerCase());
				if (item) {
					e.preventDefault();
					g = 0;
					void router.navigate({ to: item.to });
				}
				return;
			}
			// «O» on its own: the organization switcher.
			if (e.key === "o" && !e.shiftKey && me.organizations.length > 1) {
				e.preventDefault();
				window.dispatchEvent(new Event(OPEN_SWITCHER));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [nav, router, me.organizations.length]);

	const run = (fn: () => void) => {
		setOpen(false);
		setQuery("");
		fn();
	};
	const q = query.trim();
	const found = useSearch(q, open);
	const kinds = [...new Set(found.hits.map((h) => h.kind))];
	const [selected, setSelected] = useState("");
	// When results come in, the first of them is the one Enter opens.
	useEffect(() => {
		const first = found.hits[0];
		if (first && found.q) setSelected(hitValue(first, found.q));
	}, [found]);

	return (
		<Ctx.Provider value={{ open: () => setOpen(true) }}>
			{children}
			<DialogPrimitive.Root
				open={open}
				onOpenChange={(v) => {
					setOpen(v);
					if (!v) setQuery("");
				}}
			>
				<DialogPrimitive.Portal>
					{/* No motion: people open this many times a day, mostly from the keyboard (⌘K). */}
					<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-[oklch(0.2_0.01_265/0.2)] dark:bg-black/50" />
					<DialogPrimitive.Content
						aria-describedby={undefined}
						className="fixed top-[14vh] left-1/2 z-50 w-[calc(100%-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-popover outline-none"
					>
						<DialogPrimitive.Title className="sr-only">
							Command menu
						</DialogPrimitive.Title>
						<Command
							loop
							value={selected}
							onValueChange={setSelected}
							className="flex flex-col"
						>
							<div className="flex h-12 items-center gap-2.5 border-b px-4">
								<Search className="size-4 shrink-0 text-faint" />
								<Command.Input
									autoFocus
									value={query}
									onValueChange={setQuery}
									placeholder="Search contacts, conversations, broadcasts… or go anywhere"
									className="h-full flex-1 bg-transparent text-base outline-none placeholder:text-faint"
								/>
								{found.busy && <Spinner className="size-4 text-faint" />}
								<Kbd>esc</Kbd>
							</div>
							<Command.List className="max-h-[min(24rem,60vh)] scroll-py-2 overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-faint">
								<Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">
									{found.busy ? "Searching…" : <>Nothing matches “{q}”.</>}
								</Command.Empty>
								{found.q === q &&
									kinds.map((kind) => (
										<Command.Group
											key={kind}
											heading={KIND[kind].label}
										>
											{found.hits
												.filter((h) => h.kind === kind)
												.map((h) => (
													<Command.Item
														key={`${h.kind}:${h.id}`}
														value={hitValue(h, q)}
														onSelect={() =>
															run(() =>
																router.navigate({ href: h.path }),
															)
														}
														className={ITEM}
													>
														{(() => {
															const Icon = KIND[kind].icon;
															return <Icon strokeWidth={1.75} />;
														})()}
														<span className="min-w-0 flex-1 truncate">
															{h.title}
															{h.detail && (
																<span className="ml-2 text-muted-foreground">
																	{h.detail}
																</span>
															)}
														</span>
														{h.brand && (
															<span className="shrink-0 text-xs text-faint">
																{h.brand}
															</span>
														)}
													</Command.Item>
												))}
										</Command.Group>
									))}
								{/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q) && (
									<Command.Group heading="Recipient">
										<Item
											value={`look up recipient ${q}`}
											icon={UserSearch}
											onSelect={() =>
												run(() =>
													router.navigate({
														to: "/recipients",
														search: { address: q.toLowerCase() },
													}),
												)
											}
										>
											Can <span className="font-medium">{q}</span> get email?
										</Item>
									</Command.Group>
								)}
								{q.length > 1 && (
									<Command.Group heading="Emails">
										<Item
											value={`search emails ${q}`}
											icon={Search}
											onSelect={() =>
												run(() =>
													router.navigate({
														to: "/emails",
														search: { q },
													}),
												)
											}
										>
											Find emails matching “
											<span className="font-medium">{q}</span>”
										</Item>
									</Command.Group>
								)}
								<Command.Group heading="Go to">
									{nav.map((n) => (
										<Item
											key={n.to}
											value={`go ${n.label}`}
											icon={n.icon}
											shortcut={
												n.key ? ["G", n.key.toUpperCase()] : undefined
											}
											onSelect={() =>
												run(() => router.navigate({ to: n.to }))
											}
										>
											{n.label}
										</Item>
									))}
								</Command.Group>
								{me.organizations.length > 1 && (
									<Command.Group heading="Switch organization">
										{me.organizations
											.filter((o) => o.id !== me.active?.id)
											.map((o) => (
												<Command.Item
													key={o.id}
													value={`switch ${o.name} ${o.slug}`}
													onSelect={() => run(() => onSwitchOrg(o.id))}
													className={ITEM}
												>
													<OrgAvatar
														name={o.name}
														id={o.id}
														logo={o.logo?.url}
														background={o.logo?.background}
														className="size-4 rounded-[4px] text-[9px]"
													/>
													{o.name}
												</Command.Item>
											))}
									</Command.Group>
								)}
								<Command.Group heading="Theme">
									<Item
										value="theme light"
										icon={Sun}
										onSelect={() => run(() => setTheme("light"))}
									>
										Light
									</Item>
									<Item
										value="theme dark"
										icon={Moon}
										onSelect={() => run(() => setTheme("dark"))}
									>
										Dark
									</Item>
									<Item
										value="theme system"
										icon={Monitor}
										onSelect={() => run(() => setTheme("system"))}
									>
										Match the system
									</Item>
								</Command.Group>
							</Command.List>
							<div className="flex h-10 items-center justify-end gap-4 border-t px-4 text-xs text-muted-foreground">
								<span className="flex items-center gap-1.5">
									<Kbd>↑</Kbd>
									<Kbd>↓</Kbd> to move
								</span>
								<span className="flex items-center gap-1.5">
									<Kbd>
										<CornerDownLeft />
									</Kbd>{" "}
									to open
								</span>
							</div>
						</Command>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
		</Ctx.Provider>
	);
}

const ITEM =
	"flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-sm select-none data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground";

function Item({
	value,
	icon: Icon,
	shortcut,
	onSelect,
	children,
}: {
	value: string;
	icon: LucideIcon;
	shortcut?: string[];
	onSelect: () => void;
	children: ReactNode;
}) {
	return (
		<Command.Item
			value={value}
			onSelect={onSelect}
			className={ITEM}
		>
			<Icon strokeWidth={1.75} />
			<span className="min-w-0 flex-1 truncate">{children}</span>
			{shortcut && (
				<span className="flex gap-1">
					{shortcut.map((k, i) => (
						// "G G" (Campaigns) has the same key twice.
						<Kbd key={`${i}${k}`}>{k}</Kbd>
					))}
				</span>
			)}
		</Command.Item>
	);
}
