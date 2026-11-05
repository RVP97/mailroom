import { createFileRoute, Link, notFound, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Building2,
	CircleAlert,
	Copy,
	MoreHorizontal,
	Pause,
	Pencil,
	Play,
	Plus,
	Send,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandKitCard } from "@/components/brand-kit-card";
import { brandStatus, PurposeBadge } from "@/components/brand-status";
import { Confirm } from "@/components/confirm";
import { useCopy } from "@/components/copy";
import { FirewallCard } from "@/components/firewall-card";
import { OrgAvatar } from "@/components/org-avatar";
import { Page, Section, TableCard } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader, toneOf } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { UnsubscribePageCard } from "@/components/unsubscribe-page-card";
import { getBrandFn, removeBrandFn, updateBrandFn } from "@/functions/brands";
import { kitFn } from "@/functions/collab";
import { firewallFn } from "@/functions/recipients";
import { sendingStatusFn, setUpSendingFn } from "@/functions/settings";
import { subscriberPageFn } from "@/functions/subscriber-pages";
import { errorMessage } from "@/lib/errors";
import { formatDateTime, formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { forgetMe, useMe } from "@/lib/me";
import { patch, useOptimisticState } from "@/lib/optimistic";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, pick, Sketch, sample, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/brands/$id")({
	loader: async ({ params }) => {
		const [data, sending, firewall, kit, unsubscribePage] = await Promise.all([
			getBrandFn({ data: { id: params.id } }).catch(() => null),
			sendingStatusFn({ data: { brand: params.id } }).catch(() => null),
			firewallFn({ data: { brand: params.id } }).catch(() => null),
			kitFn({ data: { brand: params.id } }).catch(() => null),
			subscriberPageFn({ data: { brand: params.id } }).catch(() => null),
		]);
		if (!data) throw notFound();
		return { ...data, sending, firewall, kit, unsubscribePage };
	},
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.brand.name ?? "Brand"} · Mailroom` }],
	}),
	component: BrandPage,
	pendingComponent: BrandSketch,
});

type Data = (typeof Route)["types"]["loaderData"];

/** What it showed last time, or the row the brands list showed, or a typical brand. */
function BrandSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("brand-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<BrandPage />
			</Sketch>
		);
	const row = listedRow<Data["brand"] & { domains: number }>("brands", params.id);
	const brand = {
		id: params.id ?? "",
		name: "Organization",
		default: false,
		external_id: null,
		sending: "ready",
		paused: null,
		ses_status: null,
		created_at: ago(60 * 24 * 60),
		...row,
	} as Data["brand"];
	return (
		<Sketch
			data={{
				brand,
				stats: {
					totals: { sent: 1200, delivered: 1190 },
					health: {
						bounceRate: 0.004,
						bounce: "ok",
						complaintRate: 0.0001,
						complaint: "ok",
					},
				},
				domains: sample(row?.domains ?? 1, (i) => ({
					id: `sketch-${i}`,
					name: pick(i, ["mail.example.com", "news.example.com"]),
					status: "verified",
					purpose: i === 0 ? "transactional" : "marketing",
					paused_at: null,
					paused_reason: null,
				})),
				sending: { tenant_name: "organization-0000000" },
				firewall: null,
				kit: null,
				unsubscribePage: null,
			}}
		>
			<BrandPage />
		</Sketch>
	);
}

/** A brand: who it sends as, whether it can, its domains and how its mail did lately. */
function BrandPage() {
	const data = usePage(Route).data;
	const { brand: savedBrand, stats, domains, sending, firewall } = data;
	useOpened(
		"brand-page",
		useMemo(() => ({ ...data, id: data.brand.id }), [data]),
	);
	// Pausing and renaming show at once; a failed save puts them back.
	const me = useMe();
	const router = useRouter();
	const refresh = async () => {
		forgetMe();
		await router.invalidate();
	};
	const [brand, save] = useOptimisticState(savedBrand, patch<typeof savedBrand>, refresh);
	const canManage = allows(me.active?.access, "brands:edit");
	const { copy } = useCopy();
	const [pausing, setPausing] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [settingUp, setSettingUp] = useState(false);
	const st = brandStatus(brand);
	const sesPaused =
		!!brand.ses_status && brand.ses_status !== "ENABLED" && brand.ses_status !== "REINSTATED";
	const pausedByMailroom = brand.paused?.by === "mailroom";
	const canResume = canManage && (!pausedByMailroom || me.isAdmin);

	const pause = (paused: boolean) =>
		save(
			{ paused: paused ? { at: new Date().toISOString(), by: "you", reason: null } : null },
			() => updateBrandFn({ data: { id: brand.id, paused } }),
		);
	const setPaused = async (paused: boolean) => {
		if (!(await pause(paused))) return;
		toast.success(paused ? `${brand.name} is paused` : `${brand.name} is sending again`, {
			action: { label: "Undo", onClick: () => void pause(!paused) },
		});
	};
	const rename = async (name: string) => {
		const ok = await save({ name }, () => updateBrandFn({ data: { id: brand.id, name } }));
		if (ok) toast.success("Renamed");
	};
	const setUp = async () => {
		setSettingUp(true);
		try {
			await setUpSendingFn({ data: { brand: brand.id } });
			toast.success("Sending is set up");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			await refresh();
			setSettingUp(false);
		}
	};

	return (
		<Page>
			<div className="flex flex-col gap-4">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/brands"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Brands
					</Link>
				</nav>
				<RecordHeader
					icon={Building2}
					tone={toneOf(st.status === "not_set_up" ? "pending" : st.status)}
					kind={brand.default ? "Brand · default" : "Brand"}
					title={brand.name}
					actions={
						<>
							{canManage &&
								(brand.paused ? (
									canResume && (
										<Button onClick={() => setPaused(false)}>
											<Play />
											Resume sending
										</Button>
									)
								) : (
									<Button
										variant="outline"
										className="hidden sm:inline-flex"
										onClick={() => setPausing(true)}
									>
										<Pause />
										Pause
									</Button>
								))}
							<ApiDrawer
								title="This brand in the API"
								calls={[
									{
										title: "Retrieve it",
										method: "GET",
										path: `/brands/${brand.id}`,
									},
									{
										title: "Send as it",
										method: "POST",
										path: "/emails",
										body: {
											from: `${brand.name} <hello@${domains[0]?.name ?? "example.com"}>`,
											to: ["customer@example.com"],
											subject: "Hello",
											html: "<p>Sent as this brand: its domain says so.</p>",
										},
									},
									{
										title: brand.paused ? "Resume it" : "Pause it",
										method: "PATCH",
										path: `/brands/${brand.id}`,
										body: { paused: !brand.paused },
									},
								]}
							/>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="outline"
										size="icon"
										aria-label="More"
									>
										<MoreHorizontal />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{canManage && !brand.paused && (
										<DropdownMenuItem
											className="sm:hidden"
											onSelect={() => setPausing(true)}
										>
											<Pause />
											Pause sending
										</DropdownMenuItem>
									)}
									{canManage && (
										<DropdownMenuItem onSelect={() => setRenaming(true)}>
											<Pencil />
											Rename
										</DropdownMenuItem>
									)}
									<DropdownMenuItem onSelect={() => copy(brand.id)}>
										<Copy />
										Copy brand id
									</DropdownMenuItem>
									{canManage && (
										<DropdownMenuItem
											disabled={settingUp}
											onSelect={setUp}
										>
											<Send />
											Run sending setup again
										</DropdownMenuItem>
									)}
									{canManage && !brand.default && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onSelect={() => setRemoving(true)}
											>
												<Trash2 />
												Remove brand
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					}
				/>
			</div>

			<Confirm
				open={pausing}
				onOpenChange={setPausing}
				title={`Pause ${brand.name}?`}
				description="Nothing is sent as this brand until you resume it: new emails are refused with brand_paused, and queued ones wait. Your other brands keep sending."
				action="Pause sending"
				cancel="Keep sending"
				onConfirm={() => void setPaused(true)}
			/>
			<Rename
				open={renaming}
				onOpenChange={setRenaming}
				name={brand.name}
				onRename={rename}
			/>
			{!brand.default && (
				<Remove
					open={removing}
					onOpenChange={setRemoving}
					brand={brand}
					others={me.brands.filter((b) => b.id !== brand.id)}
				/>
			)}

			<Facts>
				<Fact label="Status">
					<StatusBadge
						status={st.status}
						label={st.label}
					/>
				</Fact>
				<Fact label="Domains">
					<span className="tabular-nums">
						<Ph>{formatNumber(domains.length)}</Ph>
						{domains.some((d) => d.purpose === "marketing") && (
							<span className="text-muted-foreground">
								{" "}
								· {domains.filter((d) => d.purpose === "marketing").length}{" "}
								marketing
							</span>
						)}
					</span>
				</Fact>
				<Fact label="SES tenant">
					<span className="font-mono text-xs">{sending?.tenant_name ?? "—"}</span>
				</Fact>
				{sending?.marketing_tenant_name && (
					<Fact label="Marketing tenant">
						<span className="font-mono text-xs">{sending.marketing_tenant_name}</span>
					</Fact>
				)}
				{brand.external_id && (
					<Fact label="External id">
						<span className="font-mono text-xs">{brand.external_id}</span>
					</Fact>
				)}
				<Fact label="Added">
					<span className="tabular-nums">{formatDateTime(brand.created_at)}</span>
				</Fact>
				<Fact label="Id">
					<IdChip value={brand.id} />
				</Fact>
			</Facts>

			{brand.paused && (
				<Alert variant="warning">
					<Pause />
					<AlertTitle>
						{pausedByMailroom ? "Mailroom paused this brand" : "Sending is paused"}
						<span className="font-normal text-muted-foreground">
							{" "}
							· {formatRelative(brand.paused.at)}
						</span>
					</AlertTitle>
					<AlertDescription>
						{brand.paused.reason ??
							(pausedByMailroom
								? "To protect the account's reputation."
								: "Someone on your team paused it.")}{" "}
						{pausedByMailroom && !me.isAdmin
							? "Mailroom's team lifts it once the cause is fixed."
							: "Queued emails go out once it's resumed."}
					</AlertDescription>
				</Alert>
			)}
			{sesPaused && (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>Amazon SES paused this brand's tenant</AlertTitle>
					<AlertDescription>
						Its bounces or complaints went over SES's limits. Remove the addresses that
						bounce, then ask AWS to re-enable the tenant ({sending?.tenant_name}).
					</AlertDescription>
				</Alert>
			)}
			{brand.sending !== "ready" && (
				<Alert variant={brand.sending === "error" ? "destructive" : "warning"}>
					<CircleAlert />
					<AlertTitle>
						{brand.sending === "error"
							? "The sending setup failed"
							: "Sending isn't set up yet"}
					</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						{/* A long AWS error can be one unbroken token; ordinary words still wrap whole. */}
						<span className="[overflow-wrap:anywhere]">
							{brand.sending_error ??
								"Mailroom creates the brand's SES tenant and configuration sets."}
						</span>
						{canManage && (
							<Button
								size="sm"
								disabled={settingUp}
								onClick={setUp}
							>
								{settingUp ? <Spinner /> : <Send />}
								Set up sending
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}

			<Section
				title="Last 30 days"
				actions={
					<Button
						variant="ghost"
						size="sm"
						asChild
					>
						<Link
							to="/"
							search={me.brands.length > 1 ? { brand: brand.id } : {}}
						>
							Overview
							<ArrowUpRight />
						</Link>
					</Button>
				}
			>
				<div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border/70 shadow-card sm:grid-cols-4">
					<Stat
						label="Sent"
						value={formatNumber(stats.totals.sent)}
					/>
					<Stat
						label="Delivered"
						value={formatNumber(stats.totals.delivered)}
					/>
					<Stat
						label="Bounce rate"
						value={stats.totals.sent ? formatPercent(stats.health.bounceRate) : "—"}
						level={stats.health.bounce}
					/>
					<Stat
						label="Complaint rate"
						value={
							stats.totals.sent ? formatPercent(stats.health.complaintRate, 3) : "—"
						}
						level={stats.health.complaint}
					/>
				</div>
			</Section>

			<Section
				title="Domains"
				description="It sends from these. Marketing domains use the brand's second SES tenant, so newsletters never hurt receipts and codes."
				actions={
					canManage && (
						<Button
							variant="outline"
							size="sm"
							asChild
						>
							<Link
								to="/domains"
								search={{ add: 1, brand: brand.id }}
							>
								<Plus />
								Add domain
							</Link>
						</Button>
					)
				}
			>
				<TableCard>
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Domain</TableHead>
								<TableHead className="w-32">Purpose</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{domains.length === 0 && (
								<TableRow>
									<TableCell
										colSpan={3}
										className="h-20 text-center text-muted-foreground"
									>
										No domains yet. Add the one this brand sends from.
									</TableCell>
								</TableRow>
							)}
							{domains.map((d) => (
								<TableRow
									key={d.id}
									className="relative"
								>
									<TableCell className="h-12">
										<Link
											to="/domains/$id"
											params={{ id: d.id }}
											className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
										>
											<Ph>{d.name}</Ph>
										</Link>
									</TableCell>
									<TableCell>
										<PurposeBadge purpose={d.purpose} />
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<StatusBadge
											status={d.paused_at ? "paused" : d.status}
											label={d.paused_at ? "Paused" : undefined}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</TableCard>
			</Section>

			<BrandKitCard
				key={`kit-${brand.id}`}
				brand={brand.id}
				name={brand.name}
				logo={me.active?.logo?.url ?? null}
				kit={data.kit}
				canEdit={allows(me.active?.access, "library:edit")}
			/>

			{data.unsubscribePage && (
				<UnsubscribePageCard
					key={`unsub-${brand.id}`}
					brand={brand.id}
					page={data.unsubscribePage.page}
					isSaved={data.unsubscribePage.saved}
					kitAccent={data.kit?.accent ?? null}
					brandLogo={!!me.active?.logo?.url}
					canEdit={allows(me.active?.access, "brands:edit")}
				/>
			)}

			{firewall && (
				<FirewallCard
					key={brand.id}
					brand={brand.id}
					firewall={firewall}
					canManage={canManage}
				/>
			)}
		</Page>
	);
}

function Stat({ label, value, level }: { label: string; value: string; level?: string }) {
	return (
		<div className="bg-card px-5 py-4">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p
				className={cn(
					"mt-1 text-xl font-semibold tabular-nums tracking-[-0.01em]",
					level === "danger" && "text-destructive",
					level === "warning" && "text-warning",
				)}
			>
				<Ph>{value}</Ph>
			</p>
		</div>
	);
}

function Rename({
	open,
	onOpenChange,
	name: current,
	onRename,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	name: string;
	onRename: (name: string) => void;
}) {
	const [name, setName] = useState(current);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (v) setName(current);
				onOpenChange(v);
			}}
		>
			<DialogContent>
				<form
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						onOpenChange(false);
						if (name.trim() !== current) onRename(name.trim());
					}}
				>
					<DialogHeader>
						<DialogTitle>Rename brand</DialogTitle>
						<DialogDescription>
							Only your team sees this name. Recipients see the From name you send
							with.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="brand-rename">Name</FieldLabel>
							<Input
								id="brand-rename"
								autoFocus
								required
								maxLength={80}
								autoComplete="off"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!name.trim() || name.trim() === current}
						>
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Removing a brand moves what it has (domains, emails, suppressions, unsubscribes, stats) to
 * another brand, so no history and no opt-out is lost.
 */
function Remove({
	open,
	onOpenChange,
	brand,
	others,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	brand: { id: string; name: string };
	others: { id: string; name: string }[];
}) {
	const router = useRouter();
	const [moveTo, setMoveTo] = useState(others[0]?.id ?? "");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => !busy && onOpenChange(v)}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Remove {brand.name}?</DialogTitle>
					<DialogDescription>
						Its domains, emails, suppressions and unsubscribes move to the brand you
						pick, so nobody who opted out gets mail again. Its SES tenant is deleted.
						This can't be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Field>
						<FieldLabel>Move everything to</FieldLabel>
						<Select
							value={moveTo}
							onValueChange={setMoveTo}
						>
							<SelectTrigger aria-label="Move everything to">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{others.map((b) => (
									<SelectItem
										key={b.id}
										value={b.id}
									>
										<OrgAvatar
											name={b.name}
											className="size-4 text-[9px]"
										/>
										{b.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<FieldDescription>
							Domains keep sending, now with that brand's reputation.
						</FieldDescription>
					</Field>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="ghost"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						Keep it
					</Button>
					<Button
						variant="destructive"
						disabled={busy || !moveTo}
						onClick={async () => {
							setBusy(true);
							try {
								await removeBrandFn({ data: { id: brand.id, moveTo } });
								toast.success(`${brand.name} removed`);
								forgetMe();
								onOpenChange(false);
								await router.navigate({ to: "/brands" });
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Spinner />}
						Remove brand
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
