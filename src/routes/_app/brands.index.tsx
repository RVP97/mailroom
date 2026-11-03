import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Building2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { brandStatus } from "@/components/brand-status";
import { OrgAvatar } from "@/components/org-avatar";
import { Page, PageHeader, TableCard } from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
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
import { createBrandFn, listBrandsFn } from "@/functions/brands";
import { errorMessage } from "@/lib/errors";
import { formatNumber, formatPercent } from "@/lib/format";
import { forgetMe, useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import {
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/brands/")({
	loader: () => listBrandsFn(),
	head: () => ({ meta: [{ title: "Brands · Mailroom" }] }),
	component: Brands,
	pendingComponent: BrandsSketch,
});

function BrandsSketch() {
	return (
		<Sketch
			data={sample(rememberedRows("brands", 1), (i) => ({
				id: `sketch-${i}`,
				name: pick(i, ["Organization", "Harbor Inn", "Newsletter"]),
				default: i === 0,
				external_id: null,
				sending: "ready",
				paused: null,
				ses_status: null,
				domains: 2,
				marketingDomains: 0,
				sent: 1200,
				bounceRate: 0.004,
				complaintRate: 0.0001,
				bounce: "ok",
				complaint: "ok",
			}))}
		>
			<Brands />
		</Sketch>
	);
}

/**
 * Who the organization's emails are from: its own brand and any others (a hotel each, a
 * newsletter…), each its own SES tenant, so one's bounces never pause another's mail.
 */
function Brands() {
	const brands = usePage(Route).data;
	useRememberRows("brands", brands.length);
	useListed("brands", brands);
	const me = useMe();
	const canManage = allows(me.active?.access, "brands:edit");
	return (
		<Page>
			<PageHeader
				title="Brands"
				description="Who your emails are from. Each brand has its own domains, suppression list and SES reputation, so one brand's bounces never pause another's mail. The last 7 days each."
				actions={
					<>
						<ApiDrawer
							title="Brands in the API"
							calls={[
								{ title: "List brands", method: "GET", path: "/brands" },
								{
									title: "Create a brand",
									method: "POST",
									path: "/brands",
									body: { name: "Harbor Inn", external_id: "hotel_123" },
								},
								{
									title: "Pause a brand",
									method: "PATCH",
									path: "/brands/{id}",
									body: { paused: true },
								},
							]}
						/>
						{canManage && <NewBrand />}
					</>
				}
			/>
			<TableCard>
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead>Brand</TableHead>
							<TableHead className="hidden w-36 sm:table-cell">Status</TableHead>
							<TableHead className="hidden w-28 text-right md:table-cell">
								Domains
							</TableHead>
							<TableHead className="w-24 text-right">Sent</TableHead>
							<TableHead className="hidden w-24 text-right sm:table-cell">
								Bounces
							</TableHead>
							<TableHead className="hidden w-28 text-right sm:table-cell">
								Complaints
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{brands.map((b) => {
							const st = brandStatus(b);
							return (
								<TableRow
									key={b.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-2.5">
											<OrgAvatar name={b.name} />
											<span className="min-w-0">
												<span className="flex min-w-0 items-center gap-2">
													<Link
														to="/brands/$id"
														params={{ id: b.id }}
														className="truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
													>
														<Ph>{b.name}</Ph>
													</Link>
													{b.default && (
														<Badge
															data-ph
															variant="secondary"
															className="shrink-0"
														>
															Default
														</Badge>
													)}
												</span>
												{b.external_id ? (
													<span className="block truncate font-mono text-[11px] text-muted-foreground">
														<Ph>{b.external_id}</Ph>
													</span>
												) : (
													<StatusBadge
														status={st.status}
														label={st.label}
														className="mt-1 sm:hidden"
													/>
												)}
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<StatusBadge
											status={st.status}
											label={st.label}
										/>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
										<Ph>
											{formatNumber(b.domains)}
											{b.marketingDomains > 0 && (
												<span className="text-faint">
													{" "}
													· {b.marketingDomains} mkt
												</span>
											)}
										</Ph>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Ph>{formatNumber(b.sent)}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden text-right tabular-nums sm:table-cell",
											b.bounce === "danger" && "text-destructive",
											b.bounce === "warning" && "text-warning",
										)}
									>
										<Ph>{b.sent ? formatPercent(b.bounceRate) : "—"}</Ph>
									</TableCell>
									<TableCell
										className={cn(
											"hidden text-right tabular-nums sm:table-cell",
											b.complaint === "danger" && "text-destructive",
											b.complaint === "warning" && "text-warning",
										)}
									>
										<Ph>{b.sent ? formatPercent(b.complaintRate, 3) : "—"}</Ph>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</TableCard>
			{brands.length === 1 && (
				<p className="flex items-start gap-2 text-sm text-muted-foreground">
					<Building2 className="mt-0.5 size-4 shrink-0 text-faint" />
					One brand is all most companies need. Add another when you send for someone else
					(each hotel of a platform) or want a sender's reputation kept apart.
				</p>
			)}
		</Page>
	);
}

function NewBrand() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus /> New brand
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const brand = await createBrandFn({ data: { name: name.trim() } });
							toast.success(
								brand.sending === "ready"
									? `${brand.name} is ready. Add the domain it sends from.`
									: `${brand.name} is added; its sending setup needs another try.`,
							);
							setOpen(false);
							setName("");
							forgetMe();
							await router.invalidate();
							await router.navigate({ to: "/brands/$id", params: { id: brand.id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>New brand</DialogTitle>
						<DialogDescription>
							Its own SES tenant, domains and suppression list. Your people, API keys
							and webhooks already cover it.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="brand-name">Name</FieldLabel>
							<Input
								id="brand-name"
								autoFocus
								required
								maxLength={80}
								autoComplete="off"
								placeholder="Harbor Inn"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
							<FieldDescription>
								What your team calls it. Recipients see the From name you send with.
							</FieldDescription>
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
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Create brand
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
