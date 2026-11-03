import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { AtSign, Inbox, Paperclip, Route as RouteIcon, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { CopyText, Page, PageHeader, TableCard, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusBadge } from "@/components/status-badge";
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
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
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
import { listReceivedFn, setInboundAddressFn } from "@/functions/received";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
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

export const Route = createFileRoute("/_app/received/")({
	validateSearch: z.object({
		q: z.string().optional(),
		/** One brand; without it, every brand of the organization. */
		brand: z.string().optional(),
		after: z.string().optional(),
	}),
	loaderDeps: ({ search }) => search,
	// New filters keep the page up (and the search box focused): only the rows turn into skeletons.
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) =>
		listReceivedFn({ data: { search: deps.q, brand: deps.brand, after: deps.after } }),
	head: () => ({ meta: [{ title: "Received · Mailroom" }] }),
	component: Received,
	pendingComponent: ReceivedSketch,
});

function ReceivedSketch() {
	return (
		<Sketch
			data={{
				has_more: rememberedRows("received:more", 0) > 0,
				address: rememberedRows("received:address", 1)
					? "brand-name@in.mailroom.example.com"
					: null,
				brands: sample(rememberedRows("received:brands", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
				})),
				data: sample(rememberedRows("received", 8), (i) => ({
					id: `sketch-${i}`,
					brand_id: "",
					from: pick(i, ["Ana López <ana@example.com>", "guest@example.org"]),
					to: ["reservas@example.com"],
					subject: pick(i, ["Re: Your booking", "Question about check-in", "Invoice"]),
					attachments: 0,
					spam: false,
					created_at: ago(i * 45),
				})),
			}}
		>
			<Received />
		</Sketch>
	);
}

/** «Ana López <ana@…>» as «Ana López», or the bare address. */
const senderName = (from: string) =>
	/^(.+?)\s*<[^>]+>$/.exec(from)?.[1]?.replace(/^"|"$/g, "") ?? from;

function Received() {
	const { data: page, search: current } = usePage(Route);
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:rules");
	const { search, loading } = usePendingSearch(current);
	useRememberRows("received", loading ? undefined : page.data.length);
	useRememberRows("received:more", loading ? undefined : page.has_more ? 1 : 0);
	useRememberRows("received:brands", page.brands.length);
	useRememberRows("received:address", page.address ? 1 : 0);
	useListed("received", page.data);
	const navigate = Route.useNavigate();
	const names = new Map(page.brands.map((o) => [o.id, o.name]));
	const now = Date.now();
	const filtered = Boolean(search.q || search.brand);
	return (
		<Page>
			<PageHeader
				title="Received"
				description={
					<>
						Email to your domains with receiving on (a domain's page turns it on)
						{page.address ? ", and to the brand's Mailroom address:" : "."}
						{page.address && (
							<span className="mt-1 flex flex-col items-start gap-0.5 text-sm">
								<Ph>
									<CopyText
										value={page.address}
										className="text-sm"
									/>
								</Ph>
								<span className="text-muted-foreground">
									(and anything+{"…"} at it)
									{page.addresses?.own && page.addresses.fallback && (
										<>; {page.addresses.fallback} works too</>
									)}
								</span>
								{page.addresses?.picked && !page.addresses.own && (
									<span className="text-warning">
										{page.addresses.picked} isn't used while its domain doesn't
										receive.
									</span>
								)}
								{canManage && page.addresses && (
									<InboundAddress
										brand={page.addressBrand}
										addresses={page.addresses}
									/>
								)}
							</span>
						)}
						{!page.address && canManage && page.addresses && (
							<span className="mt-1 flex">
								<InboundAddress
									brand={page.addressBrand}
									addresses={page.addresses}
								/>
							</span>
						)}
					</>
				}
				actions={
					<>
						<Button
							variant="outline"
							asChild
						>
							<Link to="/received/rules">
								<RouteIcon />
								Rules
							</Link>
						</Button>
						<BrandFilter
							brands={page.brands}
							value={search.brand}
							onChange={(brand) =>
								navigate({ search: { ...search, brand, after: undefined } })
							}
						/>
						<SearchBox
							value={search.q ?? ""}
							onChange={(q) =>
								navigate({
									search: { ...search, q: q || undefined, after: undefined },
								})
							}
							placeholder="Search from, to or subject"
							className="w-full sm:w-64"
						/>
						<ApiDrawer
							title="Received emails in the API"
							description="Resend's paths. Needs a full-access key."
							calls={[
								{
									title: "List received emails",
									method: "GET",
									path: "/emails/receiving",
								},
								{
									title: "Retrieve one, with its HTML, text and headers",
									method: "GET",
									path: `/emails/receiving/${page.data[0]?.id ?? "<id>"}`,
								},
								{
									title: "Its attachments, with download links",
									method: "GET",
									path: `/emails/receiving/${page.data[0]?.id ?? "<id>"}/attachments`,
								},
							]}
						/>
					</>
				}
			/>
			<TableCard>
				<SketchWhile loading={loading && page.data.length > 0}>
					{loading && page.data.length === 0 ? (
						<RowsPending />
					) : page.data.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									{filtered ? <Search /> : <Inbox />}
								</EmptyMedia>
								<EmptyTitle>
									{filtered ? "No emails match" : "Nothing received yet"}
								</EmptyTitle>
								<EmptyDescription>
									{filtered
										? "Try another search."
										: "Turn on receiving on a domain's page, then add its MX record. Webhooks get each one as email.received."}
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table className="table-fixed">
							<TableHeader>
								<TableRow>
									<TableHead className="w-32 sm:w-56">From</TableHead>
									<TableHead>Subject</TableHead>
									<TableHead className="hidden w-56 md:table-cell">To</TableHead>
									<TableHead className="w-20 text-right">Received</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{page.data.map((r) => (
									<TableRow
										key={r.id}
										className="relative"
									>
										<TableCell className="h-12">
											<Link
												to="/received/$id"
												params={{ id: r.id }}
												title={r.from}
												className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
											>
												<Ph>{senderName(r.from)}</Ph>
											</Link>
										</TableCell>
										<TableCell>
											<span className="flex min-w-0 items-center gap-2">
												<span className="truncate">
													<Ph>{r.subject || "(no subject)"}</Ph>
												</span>
												{r.attachments > 0 && (
													<Paperclip
														className="size-3.5 shrink-0 text-muted-foreground"
														aria-label={`${r.attachments} attachments`}
													/>
												)}
												{r.spam && (
													<StatusBadge
														status="failed"
														label="Spam"
													/>
												)}
											</span>
										</TableCell>
										<TableCell className="hidden truncate text-muted-foreground md:table-cell">
											<Ph>
												{r.to.join(", ")}
												{names.size > 1 && names.get(r.brand_id)
													? ` · ${names.get(r.brand_id)}`
													: ""}
											</Ph>
										</TableCell>
										<TableCell
											className="text-right text-muted-foreground tabular-nums"
											title={formatDateTime(r.created_at)}
										>
											<Ph>{formatAgo(r.created_at, now)}</Ph>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{(page.has_more || search.after) && (
						<TablePager
							label={`${page.data.length} ${page.data.length === 1 ? "email" : "emails"}${search.after ? ", older page" : ""}`}
							previousLabel="Newest"
							nextLabel="Older"
							onPrevious={
								search.after
									? () => navigate({ search: { ...search, after: undefined } })
									: undefined
							}
							onNext={
								page.has_more
									? () =>
											navigate({
												search: { ...search, after: page.data.at(-1)?.id },
											})
									: undefined
							}
						/>
					)}
				</SketchWhile>
			</TableCard>
		</Page>
	);
}

type Addresses = NonNullable<Awaited<ReturnType<typeof listReceivedFn>>["addresses"]>;

/** The brand's own inbound address on one of its receiving domains, or the default one. */
function InboundAddress({ brand, addresses }: { brand: string; addresses: Addresses }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [local, setLocal] = useState("");
	const [host, setHost] = useState("");
	const [busy, setBusy] = useState(false);
	const start = () => {
		const [l = "inbox", h = ""] = (addresses.picked ?? "").split("@");
		setLocal(addresses.picked ? l : "inbox");
		setHost(addresses.hosts.some((x) => x.host === h) ? h : (addresses.hosts[0]?.host ?? ""));
		setOpen(true);
	};
	const save = async (address: string | null) => {
		setBusy(true);
		try {
			await setInboundAddressFn({ data: { brand, address } });
			toast.success(
				address ? `Its address is now ${address}` : "Back to the default address",
			);
			setOpen(false);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button
				size="sm"
				variant="outline"
				className="mt-1"
				onClick={start}
			>
				<AtSign />
				{addresses.picked ? "Change address" : "Use your own domain"}
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>The brand's inbound address</DialogTitle>
						<DialogDescription>
							Shown instead of the default address, on one of the brand's domains that
							receive.
							{addresses.fallback
								? ` ${addresses.fallback} keeps working either way.`
								: ""}
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						{addresses.hosts.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								None of the brand's domains receive yet. Open a domain's page and
								turn receiving on (reply.yourdomain.com by default, with its MX
								record), then come back to pick an address there.
							</p>
						) : (
							<form
								id="inbound-address"
								className="flex flex-col gap-4"
								onSubmit={(e) => {
									e.preventDefault();
									save(`${local.trim()}@${host}`);
								}}
							>
								<Field>
									<FieldLabel htmlFor="inbound-local">Address</FieldLabel>
									<div className="flex items-center gap-2">
										<Input
											id="inbound-local"
											value={local}
											spellCheck={false}
											autoComplete="off"
											className="w-28 shrink-0 font-mono sm:w-36"
											onChange={(e) => setLocal(e.target.value)}
											required
										/>
										<span className="text-muted-foreground">@</span>
										<Select
											value={host}
											onValueChange={setHost}
										>
											<SelectTrigger className="min-w-0 flex-1 font-mono [&>span]:truncate">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{addresses.hosts.map((h) => (
													<SelectItem
														key={h.host}
														value={h.host}
														className="font-mono"
													>
														{h.host}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<FieldDescription>
										{addresses.hosts.find((h) => h.host === host)?.active ===
										false
											? "This domain's MX doesn't point at SES yet: mail reaches it once it does (see the domain's page)."
											: "Any address at this domain already reaches the brand; this is the one Mailroom shows and suggests."}
									</FieldDescription>
								</Field>
							</form>
						)}
					</DialogBody>
					<DialogFooter>
						{addresses.picked && (
							<Button
								variant="ghost"
								className="mr-auto"
								disabled={busy}
								onClick={() => save(null)}
							>
								Use the default
							</Button>
						)}
						<Button
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						{addresses.hosts.length > 0 && (
							<Button
								type="submit"
								form="inbound-address"
								disabled={busy || !local.trim() || !host}
							>
								{busy && <Spinner />}
								Save
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
