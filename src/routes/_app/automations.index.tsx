import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { AutomationStatus, triggerLabel } from "@/components/automation-status";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions, useRowAction } from "@/components/row-menu";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	createAutomationFn,
	deleteAutomationFn,
	duplicateAutomationFn,
	listAutomationsFn,
} from "@/functions/automations";
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

export const Route = createFileRoute("/_app/automations/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => listAutomationsFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Automations · Mailroom" }] }),
	component: Automations,
	pendingComponent: AutomationsSketch,
});

type Data = Awaited<ReturnType<typeof listAutomationsFn>>;

function AutomationsSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					automations: sample(rememberedRows("automations", 2), (i) => ({
						object: "automation",
						id: `sketch-${i}`,
						brand_id: "",
						name: pick(i, ["Welcome series", "After the stay"]),
						status: "active",
						trigger: { type: "contact.created" },
						steps: [],
						reentry: false,
						created_at: ago(60 * 24 * (i + 2)),
						updated_at: ago(60 * 24 * (i + 1)),
						brand: null,
						counts: { active: 12, done: 140 },
					})),
				} satisfies Data
			}
		>
			<Automations />
		</Sketch>
	);
}

function NewAutomation({ brand }: { brand?: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const { id } = await createAutomationFn({ data: { brand } });
					await router.invalidate();
					await router.navigate({ to: "/automations/$id", params: { id } });
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : <Plus />}
			New automation
		</Button>
	);
}

function Automations() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const canManage = allows(me.active?.access, "automations:edit");
	const { automations } = data;
	useRememberRows("automations", automations.length);
	useListed("automations", automations);
	const now = Date.now();
	const many = data.brands.length > 1;
	const router = useRouter();
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof automations)[number] | null>(null);
	const underWay = deleting?.counts.active ?? 0;
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this automation"}?`}
				description={
					underWay
						? `${underWay.toLocaleString()} ${underWay === 1 ? "contact is" : "contacts are"} still going through it; they stop where they are.`
						: "Its steps and history go for good. Emails it already sent stay in Emails."
				}
				action="Delete automation"
				onConfirm={() =>
					act(
						() => deleteAutomationFn({ data: { id: deleting?.id ?? "" } }),
						"Automation deleted",
					)
				}
			/>
			<PageHeader
				title="Automations"
				description="Emails that go by themselves: when a contact is added, joins a segment or your app sends an event, Mailroom waits, checks and sends your templates, one contact at a time."
				actions={
					<>
						<ApiDrawer
							title="Automations in the API"
							description="Send events from your app; automations listening for them start. Needs a full-access key."
							calls={[
								{
									title: "Send an event",
									method: "POST",
									path: "/events",
									body: {
										event: "booking.created",
										email: "ana@example.com",
										data: { room: "204" },
									},
								},
								{ title: "List automations", method: "GET", path: "/automations" },
							]}
						/>
						{canManage && automations.length > 0 && (
							<NewAutomation brand={search.brand} />
						)}
					</>
				}
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
				{automations.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Workflow />
							</EmptyMedia>
							<EmptyTitle>Make your first automation</EmptyTitle>
							<EmptyDescription>
								A welcome series for new contacts, a reminder before a stay, a
								thank-you after one: pick what starts it, then wait and send.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<NewAutomation brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Automation</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-28 text-right md:table-cell">
									Under way
								</TableHead>
								<TableHead className="hidden w-28 text-right md:table-cell">
									Finished
								</TableHead>
								<TableHead className="w-24 text-right">Edited</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{automations.map((x) => (
								<TableRow
									key={x.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Workflow}
												tone={x.status === "active" ? "blue" : "gray"}
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/automations/$id"
													params={{ id: x.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{x.name}</Ph>
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															many && !search.brand ? x.brand : null,
															triggerLabel(x.trigger),
															`${x.steps.length} ${x.steps.length === 1 ? "step" : "steps"}`,
														]
															.filter(Boolean)
															.join(" · ")}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<AutomationStatus status={x.status} />
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
										<Ph>{(x.counts.active ?? 0).toLocaleString()}</Ph>
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
										<Ph>
											{(
												(x.counts.done ?? 0) + (x.counts.exited ?? 0)
											).toLocaleString()}
										</Ph>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(x.updated_at)}
									>
										<Ph>{formatAgo(x.updated_at, now)}</Ph>
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${x.name} actions`}
											id={x.id}
											onDuplicate={
												canManage
													? () =>
															act(
																() =>
																	duplicateAutomationFn({
																		data: { id: x.id },
																	}),
																"Automation duplicated",
																({ id }) =>
																	router.navigate({
																		to: "/automations/$id",
																		params: { id },
																	}),
															)
													: undefined
											}
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
