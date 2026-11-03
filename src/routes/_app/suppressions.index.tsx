import { createFileRoute, Link } from "@tanstack/react-router";
import {
	BellOff,
	Copy,
	Download,
	Mail,
	MailX,
	MoreHorizontal,
	Plus,
	Search,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { UserAvatar } from "@/components/org-avatar";
import { Page, PageHeader, TabCount, TableCard, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusBadge, StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
	addSuppressionFn,
	exportSuppressionsFn,
	listSuppressionsFn,
	listUnsubscribesFn,
	removeSuppressionFn,
	resubscribeFn,
} from "@/functions/settings";
import { downloadCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useOptimisticState } from "@/lib/optimistic";
import { usePendingSearch } from "@/lib/pending";
import { allows } from "@/lib/permissions";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	SketchWhile,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

const PAGE = 100;

const REASONS = ["bounce", "complaint", "manual"] as const;
type Reason = (typeof REASONS)[number];

export const Route = createFileRoute("/_app/suppressions/")({
	validateSearch: z.object({
		tab: z.literal("unsubscribed").optional(),
		q: z.string().optional(),
		reason: z.enum(REASONS).optional(),
		group: z.string().optional(),
		brand: z.string().optional(),
		offset: z.number().int().min(0).optional(),
	}),
	loaderDeps: ({ search }) => search,
	// New filters keep the page up (and the search box focused): only the rows turn into skeletons.
	pendingMs: Number.POSITIVE_INFINITY,
	loader: async ({ deps }) => {
		const unsub = deps.tab === "unsubscribed";
		const [suppressed, unsubscribed] = await Promise.all([
			listSuppressionsFn({
				data: {
					search: deps.q,
					reason: deps.reason,
					brand: deps.brand,
					offset: unsub ? 0 : (deps.offset ?? 0),
				},
			}),
			listUnsubscribesFn({
				data: {
					search: deps.q,
					group: deps.group,
					brand: deps.brand,
					offset: unsub ? (deps.offset ?? 0) : 0,
				},
			}),
		]);
		return { suppressed, unsubscribed };
	},
	head: () => ({ meta: [{ title: "Suppressions · Mailroom" }] }),
	component: Suppressions,
	pendingComponent: SuppressionsSketch,
});

function SuppressionsSketch() {
	const n = rememberedRows("suppressions", 20);
	const u = rememberedRows("suppressions:unsubscribed", 0);
	return (
		<Sketch
			data={{
				suppressed: {
					has_more: rememberedRows("suppressions:more", 0) > 0,
					counts: { bounce: n, complaint: 0, manual: 0 },
					data: sample(n, (i) => ({
						organization_id: "",
						address: pick(i, [
							"guest@example.com",
							"maria.lopez@example.com",
							"old-address@example.org",
						]),
						reason: "bounce",
						detail: "550 5.1.1 The email account that you tried to reach does not exist",
						email_id: null,
						created_at: ago(i * 60),
					})),
				},
				unsubscribed: {
					has_more: false,
					groups: sample(rememberedRows("suppressions:groups", 0), (i) => ({
						group: `group-${i}`,
						count: 1,
					})),
					data: sample(u, (i) => ({
						organization_id: "",
						group: "newsletter",
						address: pick(i, ["guest@example.com", "maria.lopez@example.com"]),
						email_id: null,
						created_at: ago(i * 60),
					})),
				},
			}}
		>
			<Suppressions />
		</Sketch>
	);
}

const REASON: Record<string, { label: string; status: string }> = {
	bounce: { label: "Hard bounce", status: "bounced" },
	complaint: { label: "Spam complaint", status: "complained" },
	manual: { label: "Added by hand", status: "canceled" },
};

const reasonBadge = (reason: string) => ({
	status: REASON[reason]?.status ?? "canceled",
	label: REASON[reason]?.label ?? reason,
});

type Row = Awaited<ReturnType<typeof listSuppressionsFn>>["data"][number];
type Unsub = Awaited<ReturnType<typeof listUnsubscribesFn>>["data"][number];
type Filters = ReturnType<typeof Route.useSearch>;
type Data = {
	suppressed: Awaited<ReturnType<typeof listSuppressionsFn>>;
	unsubscribed: Awaited<ReturnType<typeof listUnsubscribesFn>>;
};

const same = (a: Row, b: Row) => a.organization_id === b.organization_id && a.address === b.address;

/** The suppressed page with a change the server hasn't confirmed yet. */
function changeSuppressed(
	page: Data["suppressed"],
	change: { remove: Row } | { add: Row[] },
): Data["suppressed"] {
	if ("remove" in change) {
		const data = page.data.filter((s) => !same(s, change.remove));
		if (data.length === page.data.length) return page;
		const reason = change.remove.reason;
		const counts =
			reason in page.counts
				? { ...page.counts, [reason]: Math.max(0, page.counts[reason as Reason] - 1) }
				: page.counts;
		return { ...page, data, counts };
	}
	const fresh = change.add.filter((n) => !page.data.some((s) => same(s, n)));
	return {
		...page,
		data: [...fresh, ...page.data],
		counts: { ...page.counts, manual: page.counts.manual + fresh.length },
	};
}

/** The unsubscribed page without someone who was just subscribed again. */
function changeUnsubscribed(page: Data["unsubscribed"], remove: Unsub): Data["unsubscribed"] {
	const gone = (u: Unsub) =>
		u.organization_id === remove.organization_id &&
		u.group === remove.group &&
		u.address === remove.address;
	if (!page.data.some(gone)) return page;
	return {
		...page,
		data: page.data.filter((u) => !gone(u)),
		groups: page.groups.map((g) =>
			g.group === remove.group ? { ...g, count: Math.max(0, g.count - 1) } : g,
		),
	};
}

function Suppressions() {
	const { data: loaded, search: current } = usePage(Route);
	// Removing, adding and subscribing again show at once; a failed save puts the row back.
	const [suppressed, saveSuppressed] = useOptimisticState(loaded.suppressed, changeSuppressed);
	const [unsubscribed, saveUnsubscribed] = useOptimisticState(
		loaded.unsubscribed,
		changeUnsubscribed,
	);
	const { search, loading } = usePendingSearch(current);
	const tabShown = search.tab === "unsubscribed" ? "unsubscribed" : "suppressed";
	useRememberRows(
		tabShown === "suppressed" ? "suppressions" : "suppressions:unsubscribed",
		loading ? undefined : (tabShown === "suppressed" ? suppressed : unsubscribed).data.length,
	);
	useRememberRows("suppressions:more", loading ? undefined : suppressed.has_more ? 1 : 0);
	useRememberRows("suppressions:groups", unsubscribed.groups.length);
	useListed(
		"suppressions",
		suppressed.data.map((s) => ({ ...s, id: s.address })),
	);
	const navigate = Route.useNavigate();
	const me = useMe();
	const canManage = allows(me.active?.access, "recipients:block");
	// Support can let someone receive again; adding to the list stays with owners and admins.
	const canRemove = allows(me.active?.access, "recipients:unblock");
	const brands = new Map(me.brands.map((b) => [b.id, b.name]));
	const brandOf = me.brands.length > 1 && !search.brand ? brands : null;
	const tab = search.tab ?? "suppressed";
	const total = suppressed.counts.bounce + suppressed.counts.complaint + suppressed.counts.manual;
	const unsubTotal = unsubscribed.groups.reduce((n, g) => n + g.count, 0);
	const go = (next: Partial<Filters>) =>
		navigate({ search: { ...search, offset: undefined, ...next }, replace: true });

	const remove = async (s: Row) => {
		const ok = await saveSuppressed({ remove: s }, () =>
			removeSuppressionFn({ data: { address: s.address, brand: s.organization_id } }),
		);
		if (ok) toast.success(`${s.address} can get emails again`);
	};
	const resubscribe = async (r: Unsub) => {
		const ok = await saveUnsubscribed(r, () =>
			resubscribeFn({
				data: { group: r.group, address: r.address, brand: r.organization_id },
			}),
		);
		if (ok)
			toast.success(`${r.address} gets ${r.group} emails again`, {
				action: {
					label: "Undo",
					onClick: () => toast.info("They can unsubscribe again from any email."),
				},
			});
	};
	const add = async (input: string) => {
		const address = input.trim().toLowerCase();
		// Without a brand picked it goes on every brand's list. Shown only where the filters let it.
		const shown =
			!search.offset &&
			(!search.reason || search.reason === "manual") &&
			(!search.q || address.includes(search.q.trim().toLowerCase()));
		const created_at = new Date().toISOString();
		const rows: Row[] = shown
			? (search.brand ? [search.brand] : me.brands.map((b) => b.id)).map((id) => ({
					organization_id: id,
					address,
					reason: "manual",
					detail: "Added in the dashboard",
					email_id: null,
					created_at,
				}))
			: [];
		const ok = await saveSuppressed({ add: rows }, () =>
			addSuppressionFn({ data: { address, brand: search.brand } }),
		);
		if (ok) toast.success(`${address} won't get emails`);
	};
	return (
		<Page>
			<PageHeader
				title="Suppressions"
				description={
					tab === "suppressed"
						? "Addresses this organization never sends to. Hard bounces and spam complaints land here on their own, so they can't hurt your sender reputation."
						: "People who left an unsubscribe group with an email's one-click link. Only that group's emails skip them."
				}
				actions={
					<>
						{tab === "suppressed" ? <SuppressionsApi /> : <UnsubscribesApi />}
						{canManage && tab === "suppressed" && <AddSuppression onAdd={add} />}
					</>
				}
			/>
			<Tabs
				value={tab}
				onValueChange={(v) =>
					navigate({
						search: {
							q: search.q,
							brand: search.brand,
							tab: v === "unsubscribed" ? "unsubscribed" : undefined,
						},
						replace: true,
						resetScroll: false,
					})
				}
				className="gap-4"
			>
				<div className="border-b border-border/70">
					<TabsList
						variant="line"
						className="justify-start gap-5 *:after:bottom-0"
					>
						<TabsTrigger value="suppressed">
							Suppressed <TabCount n={total} />
						</TabsTrigger>
						<TabsTrigger value="unsubscribed">
							Unsubscribed <TabCount n={unsubTotal} />
						</TabsTrigger>
					</TabsList>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<SearchBox
						className="basis-full sm:basis-0"
						placeholder="Search an address"
						value={search.q ?? ""}
						onChange={(q) => go({ q: q || undefined })}
					/>
					<BrandFilter
						brands={me.brands}
						value={search.brand}
						onChange={(b) => go({ brand: b, reason: undefined, group: undefined })}
					/>
					{tab === "suppressed" ? (
						<>
							<Select
								value={search.reason ?? "all"}
								onValueChange={(v) =>
									go({ reason: v === "all" ? undefined : (v as Reason) })
								}
							>
								<SelectTrigger className="flex-1 sm:w-48 sm:flex-none">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="all">All reasons</SelectItem>
									<SelectSeparator />
									{REASONS.map((r) => (
										<SelectItem
											key={r}
											value={r}
										>
											<StatusDot status={REASON[r]?.status ?? "canceled"} />
											{REASON[r]?.label}
											<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
												{suppressed.counts[r]}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<ExportButton
								reason={search.reason}
								brand={search.brand}
								disabled={total === 0}
							/>
						</>
					) : (
						unsubscribed.groups.length > 0 && (
							<Select
								value={search.group ?? "all"}
								onValueChange={(v) => go({ group: v === "all" ? undefined : v })}
							>
								<SelectTrigger className="flex-1 sm:w-48 sm:flex-none">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="all">All groups</SelectItem>
									<SelectSeparator />
									{unsubscribed.groups.map((g) => (
										<SelectItem
											key={g.group}
											value={g.group}
										>
											<span className="truncate font-mono text-xs">
												{g.group}
											</span>
											<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
												{g.count}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)
					)}
				</div>
				<TabsContent value="suppressed">
					<SuppressedTable
						page={suppressed}
						loading={loading}
						search={search}
						canManage={canRemove}
						brandOf={brandOf}
						several={me.brands.length > 1}
						onRemove={remove}
						onClear={() => go({ q: undefined, reason: undefined })}
						onPage={(offset) =>
							navigate({ search: { ...search, offset: offset || undefined } })
						}
					/>
				</TabsContent>
				<TabsContent value="unsubscribed">
					<UnsubscribedTable
						page={unsubscribed}
						loading={loading}
						search={search}
						canManage={canRemove}
						brandOf={brandOf}
						onResubscribe={resubscribe}
						onClear={() => go({ q: undefined, group: undefined })}
						onPage={(offset) =>
							navigate({ search: { ...search, offset: offset || undefined } })
						}
					/>
				</TabsContent>
			</Tabs>
		</Page>
	);
}

function SuppressedTable({
	page,
	loading,
	search,
	canManage,
	brandOf,
	several,
	onRemove,
	onClear,
	onPage,
}: {
	page: { data: Row[]; has_more: boolean };
	loading: boolean;
	search: Filters;
	canManage: boolean;
	brandOf: Map<string, string> | null;
	several: boolean;
	onRemove: (s: Row) => void;
	onClear: () => void;
	onPage: (offset: number) => void;
}) {
	const offset = search.offset ?? 0;
	const filtered = Boolean(search.q || search.reason);
	const now = Date.now();
	return (
		<TableCard>
			<SketchWhile loading={loading && page.data.length > 0}>
				{loading && page.data.length === 0 ? (
					<RowsPending />
				) : page.data.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								{filtered ? <Search /> : <MailX />}
							</EmptyMedia>
							<EmptyTitle>
								{filtered ? "No address matches" : "Nobody is suppressed"}
							</EmptyTitle>
							<EmptyDescription>
								{filtered
									? "Try another search, or clear the filters."
									: "Hard bounces and spam complaints land here on their own."}
							</EmptyDescription>
						</EmptyHeader>
						{filtered && (
							<Button
								variant="outline"
								size="sm"
								onClick={onClear}
							>
								Clear filters
							</Button>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead className="md:w-[38%]">Address</TableHead>
								<TableHead className="hidden w-40 sm:table-cell">Reason</TableHead>
								<TableHead className="hidden md:table-cell">Detail</TableHead>
								<TableHead className="w-20 text-right">Added</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{page.data.map((s) => (
								<TableRow
									key={`${s.organization_id}:${s.address}`}
									className="relative"
								>
									<TableCell className="py-2.5">
										<div className="flex min-w-0 items-center gap-2.5">
											<UserAvatar name={s.address} />
											<div className="min-w-0">
												<Link
													to="/suppressions/$id"
													params={{ id: s.address }}
													search={
														several
															? {
																	brand: s.organization_id,
																	filtered: search.brand
																		? true
																		: undefined,
																}
															: {}
													}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{s.address}</Ph>
												</Link>
												{brandOf && (
													<p className="truncate text-xs text-muted-foreground">
														<Ph>{brandOf.get(s.organization_id)}</Ph>
													</p>
												)}
												<StatusBadge
													className="mt-1 sm:hidden"
													{...reasonBadge(s.reason)}
												/>
											</div>
										</div>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<StatusBadge {...reasonBadge(s.reason)} />
									</TableCell>
									<TableCell
										className="hidden truncate text-muted-foreground md:table-cell"
										title={s.detail ?? undefined}
									>
										<Ph>{s.detail}</Ph>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(s.created_at)}
									>
										<Ph>{formatAgo(s.created_at, now)}</Ph>
									</TableCell>
									<TableCell className="relative z-10 text-right">
										<RowMenu
											s={s}
											canManage={canManage}
											onRemove={() => void onRemove(s)}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{(page.has_more || offset > 0) && (
					<TablePager
						label={`${offset + 1}–${offset + page.data.length}`}
						onPrevious={
							offset > 0 ? () => onPage(Math.max(0, offset - PAGE)) : undefined
						}
						onNext={page.has_more ? () => onPage(offset + PAGE) : undefined}
					/>
				)}
			</SketchWhile>
		</TableCard>
	);
}

/**
 * Who used the one-click unsubscribe of an email sent with an unsubscribe group: only that
 * group's emails skip them (src/server/unsubscribes.ts).
 */
function UnsubscribedTable({
	page,
	loading,
	search,
	canManage,
	brandOf,
	onResubscribe,
	onClear,
	onPage,
}: {
	page: { data: Unsub[]; has_more: boolean };
	loading: boolean;
	search: Filters;
	canManage: boolean;
	brandOf: Map<string, string> | null;
	onResubscribe: (r: Unsub) => void;
	onClear: () => void;
	onPage: (offset: number) => void;
}) {
	const offset = search.offset ?? 0;
	const filtered = Boolean(search.q || search.group);
	const now = Date.now();
	return (
		<TableCard>
			<SketchWhile loading={loading && page.data.length > 0}>
				{loading && page.data.length === 0 ? (
					<RowsPending />
				) : page.data.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								{filtered ? <Search /> : <BellOff />}
							</EmptyMedia>
							<EmptyTitle>
								{filtered ? "No address matches" : "Nobody unsubscribed"}
							</EmptyTitle>
							<EmptyDescription>
								{filtered ? (
									"Try another search, or clear the filters."
								) : (
									<>
										Send with <code>unsubscribe_group</code> and Mailroom adds
										the one-click link; whoever uses it lands here.
									</>
								)}
							</EmptyDescription>
						</EmptyHeader>
						{filtered && (
							<Button
								variant="outline"
								size="sm"
								onClick={onClear}
							>
								Clear filters
							</Button>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead className="md:w-[45%]">Address</TableHead>
								<TableHead className="hidden sm:table-cell">Group</TableHead>
								<TableHead className="w-20 text-right">Since</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{page.data.map((r) => (
								<TableRow key={`${r.organization_id}:${r.group}:${r.address}`}>
									<TableCell className="py-2.5">
										<div className="flex min-w-0 items-center gap-2.5">
											<UserAvatar name={r.address} />
											<div className="min-w-0">
												<p className="truncate font-medium">
													<Ph>{r.address}</Ph>
												</p>
												{brandOf && (
													<p className="truncate text-xs text-muted-foreground">
														<Ph>{brandOf.get(r.organization_id)}</Ph>
													</p>
												)}
												<p className="truncate font-mono text-xs text-muted-foreground sm:hidden">
													<Ph>{r.group}</Ph>
												</p>
											</div>
										</div>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<span
											data-ph
											className="inline-flex max-w-full items-center truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]"
										>
											{r.group}
										</span>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(r.created_at)}
									>
										<Ph>{formatAgo(r.created_at, now)}</Ph>
									</TableCell>
									<TableCell className="text-right">
										<UnsubMenu
											r={r}
											canManage={canManage}
											onResubscribe={() => void onResubscribe(r)}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				{(page.has_more || offset > 0) && (
					<TablePager
						label={`${offset + 1}–${offset + page.data.length}`}
						onPrevious={
							offset > 0 ? () => onPage(Math.max(0, offset - PAGE)) : undefined
						}
						onNext={page.has_more ? () => onPage(offset + PAGE) : undefined}
					/>
				)}
			</SketchWhile>
		</TableCard>
	);
}

function ExportButton({
	reason,
	brand,
	disabled,
}: {
	reason?: Reason;
	brand?: string;
	disabled: boolean;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label="Download CSV"
					disabled={disabled || busy}
					onClick={async () => {
						setBusy(true);
						try {
							const { data } = await exportSuppressionsFn({
								data: { reason, brand },
							});
							downloadCsv(`suppressions${reason ? `-${reason}` : ""}.csv`, [
								["email", "reason", "detail", "email_id", "created_at"],
								...data.map((s) => [
									s.address,
									s.reason,
									s.detail,
									s.email_id,
									s.created_at,
								]),
							]);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? <Spinner /> : <Download />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>Download CSV</TooltipContent>
		</Tooltip>
	);
}

function SuppressionsApi() {
	return (
		<ApiDrawer
			title="Suppressions in the API"
			calls={[
				{
					title: "List suppressions",
					method: "GET",
					path: "/suppressions?reason=bounce",
				},
				{
					title: "Retrieve one",
					method: "GET",
					path: "/suppressions/someone@example.com",
				},
				{
					title: "Suppress an address",
					method: "POST",
					path: "/suppressions",
					body: { email: "someone@example.com" },
				},
				{
					title: "Send to it again",
					method: "DELETE",
					path: "/suppressions/someone@example.com",
				},
			]}
		/>
	);
}

function UnsubscribesApi() {
	return (
		<ApiDrawer
			title="Unsubscribes in the API"
			calls={[
				{
					title: "Send with a one-click unsubscribe",
					method: "POST",
					path: "/emails",
					body: {
						from: "Acme <billing@acme.com>",
						to: "someone@example.com",
						subject: "Your invoice",
						html: "<p>…</p>",
						unsubscribe_group: "customer_123",
					},
				},
				{
					title: "List unsubscribes",
					method: "GET",
					path: "/unsubscribes?group=customer_123",
				},
				{
					title: "Record one you heard of",
					method: "POST",
					path: "/unsubscribes",
					body: { email: "someone@example.com", group: "customer_123" },
				},
				{
					title: "Subscribe them again",
					method: "DELETE",
					path: "/unsubscribes/customer_123/someone@example.com",
				},
			]}
		/>
	);
}

function UnsubMenu({
	r,
	canManage,
	onResubscribe,
}: {
	r: Unsub;
	canManage: boolean;
	onResubscribe: () => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`More for ${r.address}`}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<RowLinks
						address={r.address}
						emailId={r.email_id}
					/>
					{canManage && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => setOpen(true)}>
								<Undo2 />
								Subscribe again
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Confirm
				open={open}
				onOpenChange={setOpen}
				title={`Send ${r.group} emails to ${r.address} again?`}
				description="Only when this person asked you to. Emailing someone who unsubscribed leads to spam reports."
				action="Subscribe again"
				onConfirm={onResubscribe}
			/>
		</>
	);
}

/** What every row's menu starts with: the email that put the address here, and the address. */
function RowLinks({ address, emailId }: { address: string; emailId: string | null }) {
	return (
		<>
			{emailId && (
				<DropdownMenuItem asChild>
					<Link
						to="/emails/$id"
						params={{ id: emailId }}
					>
						<Mail />
						View email
					</Link>
				</DropdownMenuItem>
			)}
			<DropdownMenuItem
				onSelect={() => {
					void navigator.clipboard.writeText(address);
					toast.success("Address copied");
				}}
			>
				<Copy />
				Copy address
			</DropdownMenuItem>
		</>
	);
}

function RowMenu({ s, canManage, onRemove }: { s: Row; canManage: boolean; onRemove: () => void }) {
	const [removing, setRemoving] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`More for ${s.address}`}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<RowLinks
						address={s.address}
						emailId={s.email_id}
					/>
					{canManage && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem onSelect={() => setRemoving(true)}>
								<Undo2 />
								Send to it again
							</DropdownMenuItem>
						</>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title={`Send to ${s.address} again?`}
				description={
					s.reason === "complaint"
						? "This person marked your email as spam. Sending again can get your account reviewed: only remove it if they asked you to."
						: "It's also taken off SES's own suppression list. If it bounces again, it comes back here."
				}
				action="Remove suppression"
				onConfirm={onRemove}
			/>
		</>
	);
}

function AddSuppression({ onAdd }: { onAdd: (address: string) => void }) {
	const [open, setOpen] = useState(false);
	const [address, setAddress] = useState("");
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus /> Add address
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						setOpen(false);
						setAddress("");
						onAdd(address);
					}}
				>
					<DialogHeader>
						<DialogTitle>Suppress an address</DialogTitle>
						<DialogDescription>
							For someone who asked not to get your emails, or an address you know is
							gone.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="sup">Email</FieldLabel>
							<Input
								id="sup"
								type="email"
								required
								autoFocus
								placeholder="someone@example.com"
								value={address}
								onChange={(e) => setAddress(e.target.value)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={!address.trim()}
						>
							Suppress
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
