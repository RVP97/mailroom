import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Flag, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { DatePicker } from "@/components/date-picker";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions, useRowAction } from "@/components/row-menu";
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
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { campaignsPageFn, deleteCampaignFn, saveCampaignFn } from "@/functions/newsletters";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
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

export const Route = createFileRoute("/_app/campaigns/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => campaignsPageFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Campaigns · Mailroom" }] }),
	component: Campaigns,
	pendingComponent: CampaignsSketch,
});

type Data = Awaited<ReturnType<typeof campaignsPageFn>>;

function CampaignsSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					campaigns: sample(rememberedRows("campaigns", 2), (i) => ({
						object: "campaign",
						id: `sketch-${i}`,
						brand_id: "",
						name: pick(i, ["Summer promotion", "Holiday season"]),
						description: null,
						utm_campaign: "summer",
						starts_on: "2026-06-01",
						ends_on: "2026-08-31",
						created_at: "",
						updated_at: "",
						brand: null,
						broadcasts: 4,
						sent: 2,
					})),
				} satisfies Data
			}
		>
			<Campaigns />
		</Sketch>
	);
}

/** "Jun 1 – Aug 31, 2026" from two dates. */
export function formatSpan(a: string | null, b: string | null) {
	const f = (s: string, year: boolean) =>
		new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			...(year ? { year: "numeric" } : {}),
			timeZone: "UTC",
		});
	if (a && b) return `${f(a, a.slice(0, 4) !== b.slice(0, 4))} – ${f(b, true)}`;
	if (a) return `From ${f(a, true)}`;
	if (b) return `Until ${f(b, true)}`;
	return null;
}

function NewCampaign({ brand }: { brand?: string }) {
	const router = useRouter();
	const me = useMe();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [starts, setStarts] = useState("");
	const [ends, setEnds] = useState("");
	const [pickBrand, setPickBrand] = useState<string | undefined>(brand);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>
				<Plus />
				New campaign
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-md">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const x = await saveCampaignFn({
									data: {
										brand: pickBrand ?? brand,
										fields: {
											name,
											starts_on: starts || null,
											ends_on: ends || null,
										},
									},
								});
								await router.invalidate();
								await router.navigate({
									to: "/campaigns/$id",
									params: { id: x.id },
								});
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New campaign</DialogTitle>
							<DialogDescription>
								Group the emails of one push, like a seasonal promotion: each goes
								to its own segment, and you see how they did together.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="c-name">Name</FieldLabel>
								<Input
									id="c-name"
									autoFocus
									placeholder="Summer promotion 2026"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel htmlFor="c-start">Starts</FieldLabel>
									<DatePicker
										id="c-start"
										value={starts}
										onChange={setStarts}
										max={ends || undefined}
										placeholder="Optional"
										clearable
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="c-end">Ends</FieldLabel>
									<DatePicker
										id="c-end"
										value={ends}
										onChange={setEnds}
										min={starts || undefined}
										placeholder="Optional"
										clearable
									/>
								</Field>
							</div>
							{me.brands.length > 1 && (
								<Field>
									<FieldLabel>Brand</FieldLabel>
									<BrandFilter
										brands={me.brands}
										value={pickBrand}
										all={null}
										onChange={setPickBrand}
										className="w-full sm:w-full"
									/>
								</Field>
							)}
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !name.trim()}
							>
								{busy && <Spinner />}
								Create campaign
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function Campaigns() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const canManage = allows(me.active?.access, "broadcasts:edit");
	const { campaigns } = data;
	useRememberRows("campaigns", campaigns.length);
	useListed("campaigns", campaigns);
	const many = data.brands.length > 1;
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof campaigns)[number] | null>(null);
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this campaign"}?`}
				description="Its emails stay, as broadcasts on their own."
				action="Delete campaign"
				onConfirm={() =>
					act(
						() => deleteCampaignFn({ data: { id: deleting?.id ?? "" } }),
						"Campaign deleted",
					)
				}
			/>
			<PageHeader
				title="Campaigns"
				description="Several broadcasts toward one goal, like a summer promotion: a different email for each segment, scheduled on one timeline and reported together, with their links tagged for your website's analytics."
				actions={canManage && campaigns.length > 0 && <NewCampaign brand={search.brand} />}
			/>
			{many && (
				<div className="flex justify-end">
					<BrandFilter
						brands={data.brands}
						value={search.brand}
						onChange={(b) => navigate({ search: { brand: b }, replace: true })}
					/>
				</div>
			)}
			<TableCard>
				{campaigns.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Flag />
							</EmptyMedia>
							<EmptyTitle>Plan your first campaign</EmptyTitle>
							<EmptyDescription>
								A teaser, an offer for each kind of guest and a last call: write
								each email, schedule them, and follow how the whole campaign does.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<NewCampaign brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Campaign</TableHead>
								<TableHead className="hidden w-52 md:table-cell">When</TableHead>
								<TableHead className="w-28 text-right">Emails</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{campaigns.map((x) => (
								<TableRow
									key={x.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Flag}
												tone="blue"
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/campaigns/$id"
													params={{ id: x.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{x.name}</Ph>
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															many && !search.brand ? x.brand : null,
															x.utm_campaign
																? `utm_campaign=${x.utm_campaign}`
																: null,
														]
															.filter(Boolean)
															.join(" · ") || "No link tagging"}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden text-sm text-muted-foreground md:table-cell">
										<Ph>{formatSpan(x.starts_on, x.ends_on) ?? "—"}</Ph>
									</TableCell>
									<TableCell className="text-right text-muted-foreground tabular-nums">
										<Ph>
											{x.sent} of {x.broadcasts} sent
										</Ph>
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${x.name} actions`}
											id={x.id}
											onDelete={canManage ? () => setDeleting(x) : undefined}
										/>
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
