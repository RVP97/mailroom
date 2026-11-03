import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { ChoiceCards } from "@/components/choice-cards";
import { Confirm } from "@/components/confirm";
import { Uses } from "@/components/domain-uses";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp, toneOf } from "@/components/record";
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
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { addDomainFn, listDomainsFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

export const Route = createFileRoute("/_app/domains/")({
	validateSearch: (s: Record<string, unknown>): { brand?: string; add?: 1 } => ({
		...(typeof s.brand === "string" && s.brand ? { brand: s.brand } : {}),
		...(s.add ? { add: 1 as const } : {}),
	}),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => listDomainsFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Domains · Mailroom" }] }),
	component: Domains,
	pendingComponent: DomainsSketch,
});

function DomainsSketch() {
	const me = useMe();
	return (
		<Sketch
			data={sample(rememberedRows("domains", 3), (i) => ({
				id: `sketch-${i}`,
				organization_id: me.active?.id ?? "",
				name: pick(i, [
					"mail.example.com",
					"news.example.com",
					"notifications.example.com",
				]),
				status: "verified",
				purpose: "transactional",
				sending: true,
				receiving: false,
				region: "us-east-1",
				paused_at: null,
				created_at: ago(60 * 24 * 30),
			}))}
		>
			<Domains />
		</Sketch>
	);
}

function Domains() {
	const { data: domains, search } = usePage(Route);
	const me = useMe();
	const canManage = allows(me.active?.access, "domains:manage");
	const now = Date.now();
	const { brand, add } = search;
	useRememberRows("domains", domains.length);
	useListed("domains", domains);
	const navigate = Route.useNavigate();
	const several = me.brands.length > 1;
	const brandName = new Map(me.brands.map((b) => [b.id, b.name]));
	return (
		<Page>
			<PageHeader
				title="Domains"
				description={
					several
						? "The domains your brands send from, receive at, or both. Each needs its DNS records before SES verifies it."
						: "The domains this organization sends from, receives at, or both. Each needs its DNS records before SES verifies it."
				}
				actions={
					<>
						<BrandFilter
							brands={me.brands}
							value={brand}
							onChange={(b) =>
								navigate({ search: b ? { brand: b } : {}, replace: true })
							}
						/>
						<ApiDrawer
							title="Domains in the API"
							calls={[
								{ title: "List domains", method: "GET", path: "/domains" },
								{
									title: "Add a domain",
									method: "POST",
									path: "/domains",
									body: {
										name: "news.example.com",
										...(several ? { brand: "{brand_id}" } : {}),
										purpose: "marketing",
									},
								},
								{
									title: "Check its DNS now",
									method: "POST",
									path: "/domains/{id}/verify",
								},
							]}
						/>
						{canManage && domains.length > 0 && (
							<AddDomain
								brands={me.brands}
								brand={brand}
								open={add}
							/>
						)}
					</>
				}
			/>
			<TableCard>
				{domains.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Globe />
							</EmptyMedia>
							<EmptyTitle>Add your first domain</EmptyTitle>
							<EmptyDescription>
								The domain, or a subdomain like mail.example.com, your emails will
								come from.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<AddDomain
									brands={me.brands}
									brand={brand}
									open={add}
								/>
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Domain</TableHead>
								{several && (
									<TableHead className="hidden w-44 lg:table-cell">
										Brand
									</TableHead>
								)}
								<TableHead className="hidden w-56 md:table-cell">
									Used for
								</TableHead>
								<TableHead className="hidden w-36 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-28 xl:table-cell">Region</TableHead>
								<TableHead className="w-20 text-right">Added</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{domains.map((d) => (
								<TableRow
									key={d.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Globe}
												tone={toneOf(d.status)}
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/domains/$id"
													params={{ id: d.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{d.name}</Ph>
												</Link>
												<span className="mt-1 flex min-w-0 items-center gap-2 md:hidden">
													<StatusBadge
														status={d.paused_at ? "paused" : d.status}
														label={d.paused_at ? "Paused" : undefined}
														className="sm:hidden"
													/>
													<Uses
														domain={d}
														compact
													/>
												</span>
											</span>
										</span>
									</TableCell>
									{several && (
										<TableCell className="hidden truncate text-muted-foreground lg:table-cell">
											<Ph>{brandName.get(d.organization_id) ?? "—"}</Ph>
										</TableCell>
									)}
									<TableCell className="hidden md:table-cell">
										<Uses domain={d} />
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<StatusBadge
											status={d.paused_at ? "paused" : d.status}
											label={d.paused_at ? "Paused" : undefined}
										/>
									</TableCell>
									<TableCell className="hidden font-mono text-xs text-muted-foreground xl:table-cell">
										<Ph>{d.region}</Ph>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(d.created_at)}
									>
										<Ph>{formatAgo(d.created_at, now)}</Ph>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}

/** What a domain is for: sending (transactional or marketing), receiving, or both. */
function AddDomain({
	brands,
	brand: picked,
	open: initial,
}: {
	brands: { id: string; name: string }[];
	brand: string | undefined;
	open?: 1;
}) {
	const router = useRouter();
	const navigate = Route.useNavigate();
	const [open, setOpen] = useState(!!initial);
	const [name, setName] = useState("");
	const [brand, setBrand] = useState(picked ?? brands[0]?.id);
	const [purpose, setPurpose] = useState<"transactional" | "marketing">("transactional");
	const [use, setUse] = useState<"sending" | "receiving" | "both">("sending");
	const [taken, setTaken] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const sending = use !== "receiving";
	const receiving = use !== "sending";

	async function submit(replaceMx = false) {
		setBusy(true);
		try {
			const { id } = await addDomainFn({
				data: { name: name.trim(), brand, purpose, sending, receiving, replaceMx },
			});
			toast.success("Domain added. Now add its DNS records.");
			setOpen(false);
			setName("");
			setPurpose("transactional");
			setUse("sending");
			await router.invalidate();
			await router.navigate({ to: "/domains/$id", params: { id } });
		} catch (error) {
			const message = await errorMessage(error);
			if (/already receives email/.test(message)) setTaken(message);
			else toast.error(message);
		} finally {
			setBusy(false);
		}
	}
	useEffect(() => setBrand(picked ?? brands[0]?.id), [picked, brands]);
	// Opened from a brand's page (?add=1): drop the flag so closing it doesn't reopen it.
	useEffect(() => {
		if (initial) navigate({ search: (s) => ({ ...s, add: undefined }), replace: true });
	}, [initial, navigate]);
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus /> Add domain
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form
					className="contents"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<DialogHeader>
						<DialogTitle>Add a domain</DialogTitle>
						<DialogDescription>
							A subdomain like mail.example.com keeps its sending reputation, and the
							mail it receives, apart from your main domain's.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="domain">Domain</FieldLabel>
							<Input
								id="domain"
								autoFocus
								required
								autoComplete="off"
								spellCheck={false}
								placeholder="mail.example.com"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
							<FieldDescription>
								{sending
									? `You'll get DKIM, MAIL FROM and DMARC records to add${receiving ? ", and an MX for receiving" : ""}.`
									: "You'll get DKIM records (SES's verification) and an MX to add."}
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel>What it's for</FieldLabel>
							<ChoiceCards
								name="use"
								value={use}
								onChange={setUse}
								options={[
									{
										value: "sending",
										title: "Sending",
										description: "Brands send email from addresses at it.",
									},
									{
										value: "receiving",
										title: "Receiving",
										description:
											"Email to any address at it comes to Mailroom and your webhooks. Its MX goes to SES, so use a domain no mailbox reads.",
									},
									{
										value: "both",
										title: "Both",
										description: "Sends, and receives the replies.",
									},
								]}
							/>
						</Field>
						{brands.length > 1 && (
							<Field>
								<FieldLabel>Brand</FieldLabel>
								<BrandFilter
									brands={brands}
									value={brand}
									all={null}
									onChange={(b) => setBrand(b ?? brands[0]?.id)}
									className="w-full sm:w-full"
								/>
								<FieldDescription>
									Emails from this domain are sent as this brand, with its
									reputation and suppression list.
								</FieldDescription>
							</Field>
						)}
						{sending && (
							<Field>
								<FieldLabel>What it sends</FieldLabel>
								<ChoiceCards
									name="purpose"
									value={purpose}
									onChange={setPurpose}
									options={[
										{
											value: "transactional",
											title: "Transactional",
											description:
												"Receipts, codes, confirmations: mail people expect.",
										},
										{
											value: "marketing",
											title: "Marketing",
											description:
												"Newsletters and offers. Kept on a separate reputation, with one-click unsubscribe.",
										},
									]}
								/>
							</Field>
						)}
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
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Add domain
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
			<Confirm
				open={taken !== null}
				onOpenChange={(v) => !v && setTaken(null)}
				title={`Take ${name.trim()}'s email?`}
				description={taken ?? ""}
				action="Receive here instead"
				cancel="Keep its mailbox"
				onConfirm={async () => {
					setTaken(null);
					await submit(true);
				}}
			/>
		</Dialog>
	);
}
