import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useLocation,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import {
	BookOpen,
	Bot,
	Building2,
	ChartColumn,
	ChevronsUpDown,
	ClipboardCheck,
	Cloud,
	Contact as ContactIcon,
	Flag,
	Gauge,
	Globe,
	Inbox,
	KeyRound,
	LayoutTemplate,
	LifeBuoy,
	LogOut,
	Mail,
	MailX,
	Megaphone,
	Menu,
	MessageCircle,
	Monitor,
	Moon,
	Newspaper,
	Plus,
	ScrollText,
	Search,
	Settings,
	Sun,
	UserRound,
	UserSearch,
	Webhook,
	Workflow,
} from "lucide-react";
import { type ComponentType, type ReactNode, Suspense, useEffect, useMemo, useState } from "react";
import { CommandMenu, type NavItem, useCommandMenu } from "@/components/command-menu";
import { Mark } from "@/components/logo";
import { NavProgress } from "@/components/nav-progress";
import { UserAvatar } from "@/components/org-avatar";
import { OrgSwitchVeil } from "@/components/org-switch-veil";
import { OrgSwitcher } from "@/components/org-switcher";
import { PagePending } from "@/components/route-states";
import { StoppedBanner } from "@/components/stopped-banner";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { authClient } from "@/lib/auth-client";
import {
	forgetMe,
	forgetRememberedMe,
	frameMe,
	loadMe,
	type Me,
	MeStandIn,
	rememberedMe,
} from "@/lib/me";
import { useEnteringPage } from "@/lib/pending";
import { Ph, Sketch, SketchTarget } from "@/lib/sketch";
import { useSwitchOrg } from "@/lib/switch-org";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app")({
	// A loader, not beforeLoad: on the first visit it runs alongside the page's own data instead of
	// before it, and afterwards it answers from the browser's copy.
	loader: async ({ location }) => {
		try {
			return await loadMe();
		} catch (error) {
			if (error instanceof Response && error.status === 401)
				throw redirect({ to: "/login", search: { next: location.href } });
			throw error;
		}
	},
	// The dashboard renders in the browser (start.ts), so this is what the first paint shows.
	pendingComponent: AppPending,
	pendingMs: 0,
	component: AppLayout,
});

const SENDING: NavItem[] = [
	{ to: "/today", label: "Today", icon: Sun, key: "z" },
	{ to: "/", label: "Overview", icon: Gauge, key: "o" },
	{ to: "/emails", label: "Emails", icon: Mail, key: "e" },
	{ to: "/insights", label: "Insights", icon: ChartColumn, key: "h" },
	{ to: "/received", label: "Received", icon: Inbox, key: "i" },
	{
		to: "/received/inboxes",
		label: "Agent inboxes",
		icon: Bot,
		key: "x",
		also: ["/received/workflow"],
	},
	{ to: "/received/chat", label: "Website chat", icon: MessageCircle, key: "j" },
	{ to: "/articles", label: "Help center", icon: LifeBuoy, key: "y" },
	{ to: "/domains", label: "Domains", icon: Globe, key: "d" },
	{ to: "/logs", label: "Logs", icon: ScrollText, key: "l" },
	{ to: "/api-keys", label: "API keys", icon: KeyRound, key: "k" },
	{ to: "/webhooks", label: "Webhooks", icon: Webhook, key: "w" },
	{ to: "/suppressions", label: "Suppressions", icon: MailX, key: "u" },
	{ to: "/recipients", label: "Recipients", icon: UserSearch, key: "r" },
];
/** Email to people on a list: templates, contacts, broadcasts, automations. */
const AUDIENCE: NavItem[] = [
	{ to: "/contacts", label: "Contacts", icon: ContactIcon, key: "c" },
	{ to: "/broadcasts", label: "Broadcasts", icon: Megaphone, key: "n" },
	{ to: "/campaigns", label: "Campaigns", icon: Flag, key: "g" },
	{ to: "/newsletters", label: "Newsletters", icon: Newspaper, key: "p" },
	{ to: "/automations", label: "Automations", icon: Workflow, key: "m" },
	{ to: "/surveys", label: "Surveys", icon: ClipboardCheck, key: "v" },
	{ to: "/templates", label: "Templates", icon: LayoutTemplate, key: "t" },
];
const ORGANIZATION: NavItem[] = [
	{ to: "/brands", label: "Brands", icon: Building2, key: "b" },
	{ to: "/settings", label: "Settings", icon: Settings, key: "s" },
	{ to: "/docs", label: "API & SMTP", icon: BookOpen, key: "a" },
];
const DEPLOYMENT: NavItem[] = [{ to: "/admin", label: "AWS account", icon: Cloud }];
const ACCOUNT: NavItem = { to: "/account", label: "Account & passkeys", icon: UserRound };

function AppLayout() {
	const me = Route.useLoaderData();
	const router = useRouter();
	const entering = useEnteringPage();

	// Fetch every page's data while the browser is idle, so the first click on each is instant too,
	// and the code of the pages opened from a list (an email, a domain).
	useEffect(() => {
		if (!me.active) return;
		const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
		const handle = idle(() => {
			for (const item of [...SENDING, ...AUDIENCE, ...ORGANIZATION, ACCOUNT])
				void router.preloadRoute({ to: item.to as "/" }).catch(() => {});
			for (const id of [
				"/_app/emails/$id",
				"/_app/domains/$id",
				"/_app/logs/$id",
				"/_app/brands/$id",
				"/_app/templates/$id",
				"/_app/contacts/$id",
				"/_app/broadcasts/$id",
				"/_app/automations/$id",
			] as const) {
				const route = router.routesById[id];
				if (route) void router.loadRouteChunk(route)?.catch(() => {});
			}
		});
		return () => (window.cancelIdleCallback ?? clearTimeout)(handle as number);
	}, [router, me.active]);

	if (!me.active)
		return (
			<NoOrganization
				isAdmin={me.isAdmin}
				email={me.user.email}
			/>
		);

	return (
		<Shell me={me}>
			{/* A click answers at once: the menu marks the new page, and if its data isn't here
			    within 60 ms, that page's own skeleton replaces the old page. Keyed by organization,
			    so nothing a page kept in its state follows into another one. */}
			{entering ? <PageSketch /> : <Outlet key={me.active.id} />}
		</Shell>
	);
}

/** The dashboard's frame: the menu, the bar on phones, and the page. */
function Shell({ me, children }: { me: Me; children: ReactNode }) {
	const switchOrg = useSwitchOrg();
	const nav = useMemo(
		() => [
			...SENDING,
			...AUDIENCE,
			...ORGANIZATION,
			...(me.isAdmin ? DEPLOYMENT : []),
			ACCOUNT,
		],
		[me.isAdmin],
	);
	return (
		<CommandMenu
			nav={nav}
			me={me}
			onSwitchOrg={switchOrg}
		>
			<div className="min-h-svh bg-canvas">
				<aside className="fixed inset-y-0 left-0 hidden w-60 lg:flex">
					<SidebarContent me={me} />
				</aside>
				<MobileBar me={me} />
				<main className="lg:py-2 lg:pr-2 lg:pl-60">
					<div
						data-app-frame
						className="relative min-h-[calc(100svh-3rem)] bg-background lg:min-h-[calc(100svh-1rem)] lg:rounded-xl lg:shadow-card"
					>
						<NavProgress />
						<StoppedBanner me={me} />
						{children}
					</div>
				</main>
			</div>
			<OrgSwitchVeil />
		</CommandMenu>
	);
}

/**
 * The skeleton of the page the address points to, drawn outside its route (the router enters it
 * only once its data is here): the route's own pendingComponent, given the address's search and
 * params. Pages without one get the generic sketch.
 */
function PageSketch() {
	const router = useRouter();
	const location = useRouterState({ select: (s) => s.location });
	const target = useMemo(() => {
		const leaf = router.matchRoutes(location).at(-1);
		const route = leaf
			? router.routesById[leaf.routeId as keyof typeof router.routesById]
			: undefined;
		return {
			Sketch: route?.options.pendingComponent as ComponentType | undefined,
			value: { search: leaf?.search ?? {}, params: leaf?.params ?? {} },
			key: leaf?.routeId ?? "",
		};
	}, [router, location]);
	if (!target.Sketch) return <PagePending />;
	// Its code comes with the page's (one chunk): usually here already (preloaded, or on the first
	// paint). Until it is, the page area stays empty rather than showing a skeleton that isn't the
	// page's.
	return (
		<Suspense fallback={null}>
			<SketchTarget.Provider value={target.value}>
				<target.Sketch key={target.key} />
			</SketchTarget.Provider>
		</Suspense>
	);
}

function MobileBar({ me }: { me: Me }) {
	const [open, setOpen] = useState(false);
	const { open: search } = useCommandMenu();
	const { pathname } = useLocation();
	// biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
	useEffect(() => setOpen(false), [pathname]);
	return (
		<div className="sticky top-0 z-40 flex h-12 items-center gap-2 border-b bg-canvas/85 px-3 backdrop-blur-md lg:hidden">
			<Button
				variant="ghost"
				size="icon"
				aria-label="Menu"
				onClick={() => setOpen(true)}
			>
				<Menu />
			</Button>
			<OrgSwitcher
				me={me}
				variant="bar"
			/>
			<Button
				variant="ghost"
				size="icon"
				className="ml-auto"
				aria-label="Search"
				onClick={search}
			>
				<Search />
			</Button>
			<Sheet
				open={open}
				onOpenChange={setOpen}
			>
				<SheetContent
					side="left"
					showCloseButton={false}
					className="w-72 bg-canvas"
				>
					<SheetTitle className="sr-only">Menu</SheetTitle>
					<SidebarContent
						me={me}
						onPicked={() => setOpen(false)}
					/>
				</SheetContent>
			</Sheet>
		</div>
	);
}

function SidebarContent({ me, onPicked }: { me: Me; onPicked?: () => void }) {
	const { open } = useCommandMenu();
	return (
		<div className="flex h-full w-full flex-col gap-4 px-3 pt-3 pb-3">
			<OrgSwitcher
				me={me}
				onPicked={onPicked}
			/>
			<button
				type="button"
				onClick={open}
				className="flex h-8 w-full items-center gap-2 rounded-md bg-background transition-colors px-2.5 text-sm text-faint shadow-button hover:text-muted-foreground dark:bg-white/[0.04]"
			>
				<Search
					className="size-3.5"
					strokeWidth={2}
				/>
				<span className="flex-1 text-left">Search</span>
				<Kbd className="hidden md:inline-flex">⌘K</Kbd>
			</button>
			<nav className="flex flex-col gap-5 overflow-y-auto">
				<NavGroup items={SENDING} />
				<NavGroup
					label="Audience"
					items={AUDIENCE}
				/>
				<NavGroup
					label="Organization"
					items={ORGANIZATION}
				/>
				{me.isAdmin && (
					<NavGroup
						label="Deployment"
						items={DEPLOYMENT}
					/>
				)}
			</nav>
			<div className="mt-auto">
				<UserMenu me={me} />
			</div>
		</div>
	);
}

function NavGroup({ label, items }: { label?: string; items: NavItem[] }) {
	const { pathname } = useLocation();
	const under = (to: string) =>
		to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`);
	const depth = (item: NavItem) =>
		Math.max(-1, ...[item.to, ...(item.also ?? [])].filter(under).map((p) => p.length));
	// The most specific item wins: /received/inboxes is Agent inboxes, not Received.
	const best = Math.max(-1, ...items.map(depth));
	return (
		<div className="flex flex-col gap-px">
			{label && <p className="eyebrow mb-1 px-2">{label}</p>}
			{items.map((item) => (
				<NavLink
					key={item.to}
					item={item}
					active={best >= 0 && depth(item) === best}
				/>
			))}
		</div>
	);
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<Link
			to={item.to}
			aria-current={active ? "page" : undefined}
			className={cn(
				"group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-100",
				active
					? "bg-[oklch(0.2_0.01_265/0.065)] font-medium text-foreground dark:bg-white/[0.07]"
					: "text-muted-foreground hover:bg-accent hover:text-foreground",
			)}
		>
			<item.icon
				className={cn(
					"size-4 shrink-0 transition-colors duration-100",
					active ? "text-foreground" : "text-faint group-hover:text-muted-foreground",
				)}
				strokeWidth={1.75}
			/>
			<span className="truncate">{item.label}</span>
		</Link>
	);
}

function UserMenu({ me }: { me: Me }) {
	const { theme, setTheme } = useTheme();
	const router = useRouter();
	const name = me.user.name || me.user.email.split("@")[0];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
				>
					<UserAvatar name={me.user.name || me.user.email} />
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm font-medium">
							<Ph>{name}</Ph>
						</span>
					</span>
					<ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				side="top"
				align="start"
				className="w-60"
			>
				<DropdownMenuLabel className="truncate font-normal">
					{me.user.email}
				</DropdownMenuLabel>
				<DropdownMenuItem asChild>
					<Link to="/account">
						<UserRound />
						Account & passkeys
					</Link>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<div className="flex items-center justify-between gap-2 px-2 py-1">
					<span className="text-sm">Theme</span>
					<div className="flex rounded-md bg-[oklch(0.2_0.01_265/0.055)] p-0.5 dark:bg-white/[0.06]">
						{(
							[
								["light", "Light", Sun],
								["dark", "Dark", Moon],
								["system", "System", Monitor],
							] as const
						).map(([value, label, Icon]) => (
							<button
								key={value}
								type="button"
								aria-label={label}
								title={label}
								onClick={() => setTheme(value)}
								className={cn(
									"flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:text-foreground",
									theme === value &&
										"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_1px_var(--shadow-color)] dark:bg-white/[0.12]",
								)}
							>
								<Icon className="size-3.5" />
							</button>
						))}
					</div>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={async () => {
						await authClient.signOut();
						forgetMe();
						forgetRememberedMe();
						router.clearCache();
						await router.navigate({ to: "/login" });
					}}
				>
					<LogOut />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function NoOrganization({ isAdmin, email }: { isAdmin: boolean; email: string }) {
	const router = useRouter();
	return (
		<CenteredShell>
			<Mark className="mb-6 size-10" />
			<h1 className="text-xl font-semibold tracking-[-0.015em]">No organization yet</h1>
			{isAdmin ? (
				<>
					<p className="mt-2 text-base text-muted-foreground">
						An organization is a company: its people, API keys and webhooks, and the
						brands it sends as, each with its own domains and SES reputation.
					</p>
					<Button
						asChild
						className="mt-6"
						size="lg"
					>
						<Link to="/new">
							<Plus />
							Create the first one
						</Link>
					</Button>
				</>
			) : (
				<p className="mt-2 text-base text-muted-foreground">
					{email} isn't in any organization yet. Ask an admin to invite you.
				</p>
			)}
			<Button
				variant="ghost"
				className="mt-3"
				onClick={async () => {
					await authClient.signOut();
					forgetMe();
					forgetRememberedMe();
					router.clearCache();
					await router.navigate({ to: "/login" });
				}}
			>
				Sign out
			</Button>
		</CenteredShell>
	);
}

/**
 * The first paint, while who's signed in and the page's data load: the dashboard's own frame with
 * the menu drawn as it was the last time (or a stand-in), and the page's own skeleton.
 */
function AppPending() {
	const me = useMemo(() => rememberedMe() ?? STAND_IN_ME, []);
	return (
		<MeStandIn.Provider value={me}>
			<Sketch>
				<Shell me={me}>
					<PageSketch />
				</Shell>
			</Sketch>
		</MeStandIn.Provider>
	);
}

/**
 * What the server sends for a dashboard address before the browser's code runs (the dashboard
 * renders in the browser): its frame and the page's own skeleton, with the menu from the frame
 * cookie and the lists' row counts from theirs, so it is what the browser draws next. Anything
 * else (sign-in) starts blank.
 */
export function FirstPaint() {
	const router = useRouter();
	const location = useRouterState({ select: (s) => s.location });
	const matches = router.matchRoutes(location);
	if (!matches.some((m) => m.routeId === "/_app")) return null;
	const leaf = matches.at(-1);
	const Page = leaf
		? (router.routesById[leaf.routeId as keyof typeof router.routesById]?.options
				.pendingComponent as ComponentType | undefined)
		: undefined;
	const me = frameMe() ?? STAND_IN_ME;
	return (
		<MeStandIn.Provider value={me}>
			<Sketch>
				<Shell me={me}>
					{/* The skeleton's code comes with the page's: the server waits for it. */}
					<Suspense fallback={null}>
						{Page && leaf ? (
							<SketchTarget.Provider
								value={{ search: leaf.search ?? {}, params: leaf.params ?? {} }}
							>
								<Page />
							</SketchTarget.Provider>
						) : (
							<PagePending />
						)}
					</Suspense>
				</Shell>
			</Sketch>
		</MeStandIn.Provider>
	);
}

const STAND_IN_ME: Me = {
	pausedDomains: [],
	user: { id: "", email: "someone@example.com", name: "Someone" },
	isAdmin: false,
	organizations: [{ id: "", name: "Organization", slug: "", role: "owner", logo: null }],
	active: {
		id: "",
		name: "Organization",
		slug: "",
		role: "owner",
		roleName: "Owner",
		logo: null,
		access: { owner: true, all: true, permissions: [] },
	},
	brands: [],
};

export function CenteredShell({ children }: { children: ReactNode }) {
	return (
		<div className="flex min-h-svh flex-col items-center justify-center bg-background px-4 py-12 text-center">
			<div className="flex w-full max-w-sm flex-col items-center">{children}</div>
		</div>
	);
}
