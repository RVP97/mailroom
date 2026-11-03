import { Link } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Plus, Search, Settings } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { OrgAvatar } from "@/components/org-avatar";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Me } from "@/lib/me";
import { ROLE_LABEL } from "@/lib/roles";
import { Ph } from "@/lib/sketch";
import { useSwitchOrg } from "@/lib/switch-org";
import { cn } from "@/lib/utils";

type Org = Me["organizations"][number];

/** Opens the switcher from anywhere (the «O» key, the command menu). */
export const OPEN_SWITCHER = "mailroom:open-org-switcher";

const touch = () => matchMedia("(pointer: coarse)").matches;
const phone = () => matchMedia("(max-width: 639px)").matches;
const ROLE = ROLE_LABEL;

/**
 * The organization switcher, like Stripe's account menu: the organization you're in on top with
 * its settings, then every other one, searchable, with 1–9 and «O» on a keyboard. On
 * a phone it's a sheet from the bottom. Picking one switches in place (lib/switch-org.ts).
 */
export function OrgSwitcher({
	me,
	variant = "sidebar",
	onPicked,
}: {
	me: Me;
	/** `bar`: the phone's top bar, just the mark and name. */
	variant?: "sidebar" | "bar";
	/** Called as a pick starts (the phone menu closes itself). */
	onPicked?: () => void;
}) {
	const switchOrg = useSwitchOrg();
	const [open, setOpen] = useState(false);
	const [sheet, setSheet] = useState(false);
	const active = me.active;

	useEffect(() => {
		// The sidebar's switcher on wide screens, the top bar's on phones: whichever shows opens.
		if (onPicked) return;
		const onOpen = () => {
			if (matchMedia("(min-width: 1024px)").matches === (variant === "sidebar")) show();
		};
		window.addEventListener(OPEN_SWITCHER, onOpen);
		return () => window.removeEventListener(OPEN_SWITCHER, onOpen);
	});

	function show() {
		setSheet(phone());
		setOpen(true);
	}

	function pick(o: Org) {
		if (o.id === active?.id) return setOpen(false);
		void switchOrg(o.id);
		setOpen(false);
		onPicked?.();
	}

	const leave = () => {
		setOpen(false);
		onPicked?.();
	};

	const trigger =
		variant === "bar" ? (
			<button
				type="button"
				aria-label="Switch organization"
				onClick={show}
				className="flex h-9 min-w-0 items-center gap-2 rounded-lg px-1.5 text-left transition-colors data-[state=open]:bg-accent"
			>
				<OrgAvatar
					name={active?.name ?? "?"}
					id={active?.id}
					logo={active?.logo?.url}
					background={active?.logo?.background}
				/>
				<span className="truncate text-sm font-semibold">
					<Ph>{active?.name}</Ph>
				</span>
				<ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
			</button>
		) : (
			<button
				type="button"
				onClick={show}
				className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-accent data-[state=open]:bg-accent"
			>
				<OrgAvatar
					name={active?.name ?? "?"}
					id={active?.id}
					logo={active?.logo?.url}
					background={active?.logo?.background}
				/>
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm font-semibold leading-tight">
						<Ph>{active?.name}</Ph>
					</span>
					{me.brands.length > 1 && (
						<span className="block truncate text-[11px] leading-tight text-muted-foreground">
							<Ph>{me.brands.length} brands</Ph>
						</span>
					)}
				</span>
				<ChevronsUpDown className="size-3.5 shrink-0 text-faint" />
			</button>
		);

	const panel = open && (
		<SwitcherPanel
			me={me}
			onPick={pick}
			onLeave={leave}
		/>
	);

	if (sheet)
		return (
			<>
				{trigger}
				<Dialog
					open={open}
					onOpenChange={setOpen}
				>
					<DialogContent
						showCloseButton={false}
						onOpenAutoFocus={(e) => e.preventDefault()}
					>
						<DialogTitle className="sr-only">Switch organization</DialogTitle>
						<span
							aria-hidden="true"
							className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-border-strong"
						/>
						{panel}
					</DialogContent>
				</Dialog>
			</>
		);

	return (
		<Popover
			open={open}
			onOpenChange={(v) => (v ? show() : setOpen(false))}
		>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				className="flex max-h-(--radix-popover-content-available-height) w-[20rem] flex-col overflow-hidden p-0"
				collisionPadding={12}
				onOpenAutoFocus={(e) => {
					// The search if there is one, else the list, so the arrows move at once; on a
					// touch screen nothing, so no keyboard pops up.
					e.preventDefault();
					if (touch()) return;
					const root = e.currentTarget as HTMLElement;
					root.querySelector<HTMLElement>("[cmdk-input], [cmdk-root]")?.focus();
				}}
			>
				{panel}
			</PopoverContent>
		</Popover>
	);
}

function SwitcherPanel({
	me,
	onPick,
	onLeave,
}: {
	me: Me;
	onPick: (o: Org) => void;
	onLeave: () => void;
}) {
	const orgs = me.organizations;
	const active = me.active;
	// The order on screen, which 1–9 follow.
	const order = orgs;
	const searchable = orgs.length > 5;
	const [query, setQuery] = useState("");
	const rowValue = (o: Org) => `${o.name} ${o.slug} ${o.id}`;
	// It opens on the organization you're in.
	const [selected, setSelected] = useState(active ? rowValue(active as Org) : "");

	// 1–9 pick the first nine (unless typing a search).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey || query) return;
			const o = /^[1-9]$/.test(e.key) ? order[Number(e.key) - 1] : undefined;
			if (o) {
				e.preventDefault();
				onPick(o);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	return (
		<Command
			loop
			value={selected}
			onValueChange={setSelected}
			filter={(value, search) =>
				value.toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
			}
			tabIndex={-1}
			className="flex min-h-0 flex-col outline-none"
		>
			{active && (
				<div className="flex items-center gap-3 border-b px-3 py-3">
					<OrgAvatar
						name={active.name}
						id={active.id}
						logo={active.logo?.url}
						background={active.logo?.background}
						className="size-9 rounded-lg text-sm"
					/>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-semibold leading-tight">
							{active.name}
						</p>
						<p className="mt-0.5 truncate text-xs text-muted-foreground">
							{("roleName" in active ? (active.roleName as string) : null) ??
								ROLE[active.role] ??
								active.role}
							{me.brands.length > 1 ? ` · ${me.brands.length} brands` : ""}
						</p>
					</div>
					<Link
						to="/settings"
						onClick={onLeave}
						aria-label="Organization settings"
						title="Settings"
						className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
					>
						<Settings className="size-4" />
					</Link>
				</div>
			)}
			{searchable && (
				<div className="px-2 pt-2">
					<div className="flex h-8 items-center gap-2 rounded-md bg-[oklch(0.2_0.01_265/0.05)] px-2.5 dark:bg-white/[0.05]">
						<Search className="size-3.5 shrink-0 text-faint" />
						<Command.Input
							value={query}
							onValueChange={setQuery}
							placeholder="Find an organization"
							aria-label="Find an organization"
							className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
						/>
					</div>
				</div>
			)}
			<Command.List className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pt-1 pb-1.5 sm:max-h-[22rem]">
				<Command.Empty className="px-2 py-6 text-center text-sm text-muted-foreground">
					No organization matches.
				</Command.Empty>
				<Command.Group
					heading="Organizations"
					className="[&_[cmdk-group-heading]]:eyebrow pt-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1"
				>
					{orgs.map((o, index) => (
						<Command.Item
							key={o.id}
							value={rowValue(o)}
							onSelect={() => onPick(o)}
							data-org-row={o.id}
							className="group flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm outline-none select-none data-[selected=true]:bg-accent"
						>
							<OrgAvatar
								name={o.name}
								id={o.id}
								logo={o.logo?.url}
								background={o.logo?.background}
								className="size-5 rounded-[5px] text-[10px]"
							/>
							<span
								className={cn(
									"min-w-0 flex-1 truncate",
									o.id === active?.id && "font-medium",
								)}
							>
								{o.name}
							</span>
							{o.id === active?.id ? (
								<Check
									className="size-4 shrink-0 text-brand"
									strokeWidth={2.25}
								/>
							) : (
								index < 9 && (
									<Kbd className="hidden group-data-[selected=true]:[@media(pointer:fine)]:inline-flex">
										{index + 1}
									</Kbd>
								)
							)}
						</Command.Item>
					))}
				</Command.Group>
			</Command.List>
			{me.isAdmin && (
				<div className="flex flex-col gap-px border-t p-1.5">
					<FooterLink onClick={onLeave}>
						<Plus className="size-4 text-faint" />
						<span className="flex-1">New organization</span>
					</FooterLink>
				</div>
			)}
		</Command>
	);
}

function FooterLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
	return (
		<Link
			to="/new"
			onClick={onClick}
			className="flex h-9 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent"
		>
			{children}
		</Link>
	);
}
