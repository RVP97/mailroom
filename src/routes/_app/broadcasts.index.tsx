import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Megaphone, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { BroadcastStatus } from "@/components/broadcast-status";
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
	createBroadcastFn,
	deleteBroadcastFn,
	duplicateBroadcastFn,
	listBroadcastsFn,
} from "@/functions/broadcasts";
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

export const Route = createFileRoute("/_app/broadcasts/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => listBroadcastsFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Broadcasts · Mailroom" }] }),
	component: Broadcasts,
	pendingComponent: BroadcastsSketch,
});

type Data = Awaited<ReturnType<typeof listBroadcastsFn>>;

function BroadcastsSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					broadcasts: sample(rememberedRows("broadcasts", 3), (i) => ({
						id: `sketch-${i}`,
						name: pick(i, ["November news", "Holiday offer", "Welcome back"]),
						subject: "Our news this month",
						status: "sent",
						brand: null,
						segment: "Guests",
						queued: 1200,
						scheduled_at: ago(60 * 24 * (i + 1)),
						started_at: ago(60 * 24 * (i + 1)),
						created_at: ago(60 * 24 * (i + 2)),
					})),
				} satisfies Data
			}
		>
			<Broadcasts />
		</Sketch>
	);
}

function NewBroadcast({ brand }: { brand?: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const { id } = await createBroadcastFn({ data: { brand } });
					await router.invalidate();
					await router.navigate({ to: "/broadcasts/$id", params: { id } });
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : <Plus />}
			New broadcast
		</Button>
	);
}

function Broadcasts() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const canManage = allows(me.active?.access, "broadcasts:edit");
	const { broadcasts } = data;
	useRememberRows("broadcasts", broadcasts.length);
	useListed("broadcasts", broadcasts);
	const now = Date.now();
	const many = data.brands.length > 1;
	const router = useRouter();
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof broadcasts)[number] | null>(null);
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this broadcast"}?`}
				description={
					deleting?.status === "scheduled"
						? "It's scheduled; deleting it means it won't go out."
						: "The draft and its content go for good."
				}
				action="Delete broadcast"
				onConfirm={() =>
					act(
						() => deleteBroadcastFn({ data: { id: deleting?.id ?? "" } }),
						"Broadcast deleted",
					)
				}
			/>
			<PageHeader
				title="Broadcasts"
				description="One email to a segment of your contacts, now or at a time you pick. Unsubscribed contacts, those who left its topic and suppressed addresses are left out."
				actions={
					<>
						<ApiDrawer
							title="Broadcasts in the API"
							description="Resend's Broadcasts API. Needs a full-access key."
							calls={[
								{
									title: "Create and send",
									method: "POST",
									path: "/broadcasts",
									body: {
										segment_id: "<segment id>",
										from: "Hotel <news@example.com>",
										subject: "Our news",
										html: "<p>Hi {{{FIRST_NAME|there}}}</p>",
										send: true,
									},
								},
								{ title: "List broadcasts", method: "GET", path: "/broadcasts" },
							]}
						/>
						{canManage && broadcasts.length > 0 && (
							<NewBroadcast brand={search.brand} />
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
				{broadcasts.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Megaphone />
							</EmptyMedia>
							<EmptyTitle>Send your first broadcast</EmptyTitle>
							<EmptyDescription>
								Write it here or start from a template, pick a segment, and send it
								now or schedule it.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<NewBroadcast brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Broadcast</TableHead>
								<TableHead className="hidden w-36 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-28 text-right md:table-cell">
									Recipients
								</TableHead>
								<TableHead className="w-20 text-right sm:w-28">When</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{broadcasts.map((x) => {
								const when = x.started_at ?? x.scheduled_at ?? x.created_at;
								return (
									<TableRow
										key={x.id}
										className="relative"
									>
										<TableCell className="h-14">
											<span className="flex min-w-0 items-center gap-3">
												<Stamp
													icon={Megaphone}
													tone={x.status === "draft" ? "gray" : "blue"}
													className="size-7"
												/>
												<span className="min-w-0">
													<Link
														to="/broadcasts/$id"
														params={{ id: x.id }}
														className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
													>
														<Ph>{x.name}</Ph>
													</Link>
													<span className="block truncate text-xs text-muted-foreground">
														<Ph>
															{[
																many && !search.brand
																	? x.brand
																	: null,
																x.segment ?? "No segment yet",
															]
																.filter(Boolean)
																.join(" · ")}
														</Ph>
													</span>
												</span>
											</span>
										</TableCell>
										<TableCell className="hidden sm:table-cell">
											<BroadcastStatus status={x.status} />
										</TableCell>
										<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
											<Ph>{x.queued ? x.queued.toLocaleString() : "—"}</Ph>
										</TableCell>
										<TableCell
											className="text-right text-muted-foreground tabular-nums"
											title={formatDateTime(when)}
										>
											<Ph>
												{x.status === "scheduled" && x.scheduled_at
													? formatDateTime(x.scheduled_at).split(",")[0]
													: formatAgo(when, now)}
											</Ph>
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
																		duplicateBroadcastFn({
																			data: { id: x.id },
																		}),
																	"Broadcast duplicated",
																	({ id }) =>
																		router.navigate({
																			to: "/broadcasts/$id",
																			params: { id },
																		}),
																)
														: undefined
												}
												onDelete={
													canManage &&
													(x.status === "draft" ||
														x.status === "scheduled")
														? () => setDeleting(x)
														: undefined
												}
											/>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}
