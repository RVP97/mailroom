import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Flag, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BroadcastStatus } from "@/components/broadcast-status";
import { Confirm } from "@/components/confirm";
import { DatePicker } from "@/components/date-picker";
import { Page, Section, TableCard } from "@/components/page";
import { RecordHeader } from "@/components/record";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { createBroadcastFn } from "@/functions/broadcasts";
import { campaignPageFn, deleteCampaignFn, saveCampaignFn } from "@/functions/newsletters";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import { formatSpan } from "./campaigns.index";

export const Route = createFileRoute("/_app/campaigns/$id")({
	loader: ({ params }) => campaignPageFn({ data: { id: params.id } }),
	head: () => ({ meta: [{ title: "Campaign · Mailroom" }] }),
	component: CampaignPage,
	pendingComponent: CampaignSketch,
});

type Data = Awaited<ReturnType<typeof campaignPageFn>>;

function CampaignSketch() {
	return (
		<Sketch
			data={
				{
					campaign: {
						object: "campaign",
						id: "",
						brand_id: "",
						name: "Campaign",
						description: null,
						utm_campaign: null,
						starts_on: null,
						ends_on: null,
						created_at: "",
						updated_at: "",
					},
					brand: null,
					broadcasts: [],
					totals: {
						emails: 0,
						delivered: 0,
						opened: 0,
						clicked: 0,
						bounced: 0,
						complained: 0,
						unsubscribed: 0,
						people: 0,
						people_opened: 0,
						people_clicked: 0,
					},
				} satisfies Data
			}
		>
			<CampaignPage />
		</Sketch>
	);
}

const rate = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : "–");

/** When it goes or went, for the timeline. */
const whenOf = (b: Data["broadcasts"][number]) => b.sent_at ?? b.scheduled_at ?? null;

function CampaignPage() {
	const { data } = usePage(Route);
	const c = data.campaign;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "broadcasts:edit");
	const of = () => ({
		name: c.name,
		description: c.description ?? "",
		utm_campaign: c.utm_campaign ?? "",
		starts_on: c.starts_on ?? "",
		ends_on: c.ends_on ?? "",
	});
	const [form, setForm] = useState(of);
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved campaign changes
	useEffect(() => setForm(of()), [c.updated_at, c.id]);
	const dirty = JSON.stringify(form) !== JSON.stringify(of());
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const t = data.totals;
	const span = formatSpan(c.starts_on, c.ends_on);

	const add = async () => {
		setAdding(true);
		try {
			const { id } = await createBroadcastFn({ data: { brand: c.brand_id, campaign: c.id } });
			await router.navigate({ to: "/broadcasts/$id", params: { id } });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setAdding(false);
		}
	};

	// Days across the campaign's dates (or its emails'), for the timeline's marks.
	const times = data.broadcasts
		.map(whenOf)
		.filter((x): x is string => !!x)
		.map(Date.parse);
	const from = Math.min(
		...(c.starts_on ? [Date.parse(`${c.starts_on}T00:00:00Z`)] : []),
		...times,
	);
	const to = Math.max(...(c.ends_on ? [Date.parse(`${c.ends_on}T23:59:59Z`)] : []), ...times);
	const spanMs = Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : null;
	const now = Date.now();

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/campaigns"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Campaigns
					</Link>
				</nav>
				<RecordHeader
					icon={Flag}
					tone="blue"
					kind={[data.brand ? `Campaign of ${data.brand.name}` : "Campaign", span]
						.filter(Boolean)
						.join(" · ")}
					title={c.name}
					actions={
						canManage && (
							<Button
								disabled={adding}
								onClick={add}
							>
								{adding ? <Spinner /> : <Plus />}
								Add an email
							</Button>
						)
					}
				/>
			</div>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this campaign?"
				description="Its emails stay, as broadcasts on their own."
				action="Delete campaign"
				onConfirm={async () => {
					try {
						await deleteCampaignFn({ data: { id: c.id } });
						toast.success("Campaign deleted");
						await router.navigate({ to: "/campaigns" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Card className="grid grid-cols-2 gap-0 p-0 sm:grid-cols-3 lg:grid-cols-6">
				{(
					[
						[
							"People reached",
							t.people.toLocaleString(),
							`${t.emails.toLocaleString()} emails`,
						],
						[
							"Opened",
							rate(t.people_opened, t.people),
							`${t.people_opened.toLocaleString()} people`,
						],
						[
							"Clicked",
							rate(t.people_clicked, t.people),
							`${t.people_clicked.toLocaleString()} people`,
						],
						["Delivered", rate(t.delivered, t.emails), null],
						["Bounced", rate(t.bounced, t.emails), null],
						[
							"Unsubscribed",
							t.unsubscribed.toLocaleString(),
							rate(t.unsubscribed, t.emails),
						],
					] as const
				).map(([k, v, sub]) => (
					<div
						key={k}
						className="flex flex-col gap-1 border-border/70 px-5 py-4 not-last:border-r max-lg:nth-[n+4]:border-t max-sm:nth-[n+3]:border-t max-sm:even:border-r-0"
					>
						<span className="text-xs text-muted-foreground">{k}</span>
						<span className="text-xl font-semibold tabular-nums">
							<Ph>{v}</Ph>
						</span>
						{sub && (
							<span className="text-xs text-muted-foreground tabular-nums">
								<Ph>{sub}</Ph>
							</span>
						)}
					</div>
				))}
			</Card>

			<Section
				title="Emails"
				description="Each one goes to its own segment at its own time. People count once in the totals above, however many of the emails they got."
			>
				{data.broadcasts.length > 0 && (
					<Timeline
						broadcasts={data.broadcasts}
						from={from}
						spanMs={spanMs}
						now={now}
					/>
				)}
				<TableCard>
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Email</TableHead>
								<TableHead className="hidden w-32 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-40 lg:table-cell">When</TableHead>
								<TableHead className="w-20 text-right">Sent</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									Opens
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									Clicks
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.broadcasts.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={6}
										className="h-20 text-center text-muted-foreground"
									>
										No emails yet. Add one for each segment and moment.
									</TableCell>
								</TableRow>
							) : (
								data.broadcasts.map((b) => {
									const w = whenOf(b);
									return (
										<TableRow
											key={b.id}
											className="relative"
										>
											<TableCell className="h-14">
												<Link
													to="/broadcasts/$id"
													params={{ id: b.id }}
													className="block truncate font-medium after:absolute after:inset-0"
												>
													<Ph>{b.name}</Ph>
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															b.segment ?? "No segment yet",
															b.campaign_dedupe
																? "skips those already reached"
																: null,
														]
															.filter(Boolean)
															.join(" · ")}
													</Ph>
												</span>
											</TableCell>
											<TableCell className="hidden sm:table-cell">
												<BroadcastStatus status={b.status} />
											</TableCell>
											<TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
												{w ? formatDateTime(w) : "Not scheduled"}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{(b.stats?.sent ?? 0).toLocaleString()}
											</TableCell>
											<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
												{b.stats ? rate(b.stats.opened, b.stats.sent) : "–"}
											</TableCell>
											<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
												{b.stats
													? rate(b.stats.clicked, b.stats.sent)
													: "–"}
											</TableCell>
										</TableRow>
									);
								})
							)}
						</TableBody>
					</Table>
				</TableCard>
			</Section>

			{canManage && (
				<Card className="gap-5 p-5">
					<h2 className="font-semibold">Details</h2>
					<div className="grid gap-5 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="c-name">Name</FieldLabel>
							<Input
								id="c-name"
								value={form.name}
								onChange={(e) => setForm({ ...form, name: e.target.value })}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-utm">utm_campaign</FieldLabel>
							<Input
								id="c-utm"
								spellCheck={false}
								placeholder="Leave empty to keep links as written"
								value={form.utm_campaign}
								onChange={(e) => setForm({ ...form, utm_campaign: e.target.value })}
							/>
							<FieldDescription>
								Added to every link with utm_source=mailroom and utm_medium=email.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-start">Starts</FieldLabel>
							<DatePicker
								id="c-start"
								value={form.starts_on}
								onChange={(starts_on) => setForm({ ...form, starts_on })}
								max={form.ends_on || undefined}
								placeholder="Optional"
								clearable
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-end">Ends</FieldLabel>
							<DatePicker
								id="c-end"
								value={form.ends_on}
								onChange={(ends_on) => setForm({ ...form, ends_on })}
								min={form.starts_on || undefined}
								placeholder="Optional"
								clearable
							/>
						</Field>
					</div>
					<Field>
						<FieldLabel htmlFor="c-desc">Notes</FieldLabel>
						<Textarea
							id="c-desc"
							rows={2}
							placeholder="What it's for, the offer, who gets what."
							value={form.description}
							onChange={(e) => setForm({ ...form, description: e.target.value })}
						/>
					</Field>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<Button
							variant="outline"
							onClick={() => setDeleting(true)}
						>
							<Trash2 />
							Delete campaign
						</Button>
						<Button
							disabled={!dirty || busy}
							onClick={async () => {
								setBusy(true);
								try {
									await saveCampaignFn({
										data: {
											id: c.id,
											fields: {
												name: form.name,
												description: form.description || null,
												utm_campaign: form.utm_campaign || null,
												starts_on: form.starts_on || null,
												ends_on: form.ends_on || null,
											},
										},
									});
									toast.success("Campaign saved");
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								} finally {
									setBusy(false);
								}
							}}
						>
							{busy && <Spinner />}
							Save changes
						</Button>
					</div>
				</Card>
			)}
		</Page>
	);
}

const shortDate = (ms: number) =>
	new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * The campaign's emails along its dates: each one's dot (sent green, scheduled blue) with its
 * name, a mark for now, and the ones without a time yet in a row of their own.
 */
function Timeline({
	broadcasts,
	from,
	spanMs,
	now,
}: {
	broadcasts: Data["broadcasts"];
	from: number;
	spanMs: number | null;
	now: number;
}) {
	const placed = broadcasts.filter((b) => whenOf(b));
	const drafts = broadcasts.filter((b) => !whenOf(b));
	const at = (ms: number) =>
		spanMs ? Math.min(100, Math.max(0, ((ms - from) / spanMs) * 100)) : 50;
	const nowAt = spanMs ? ((now - from) / spanMs) * 100 : null;
	return (
		<Card className="gap-4 p-5">
			{placed.length > 0 && (
				<div>
					<div className="relative mx-10 h-16">
						<div className="absolute inset-x-0 top-6 h-1 rounded-full bg-muted" />
						{nowAt !== null && nowAt >= 0 && nowAt <= 100 && (
							<div
								className="absolute top-0 flex h-14 -translate-x-1/2 flex-col items-center"
								style={{ left: `${nowAt}%` }}
							>
								<span className="text-[10px] font-medium uppercase tracking-wide text-primary">
									Now
								</span>
								<span className="h-5 w-px bg-primary/50" />
							</div>
						)}
						{placed.map((b) => (
							<Link
								key={b.id}
								to="/broadcasts/$id"
								params={{ id: b.id }}
								title={`${b.name}, ${formatDateTime(whenOf(b) as string)}`}
								className="group absolute top-[18px] flex -translate-x-1/2 flex-col items-center outline-none"
								style={{ left: `${at(Date.parse(whenOf(b) as string))}%` }}
							>
								<span
									className={cn(
										"size-4 rounded-full ring-4 ring-card transition-transform group-hover:scale-125 group-focus-visible:ring-ring",
										b.status === "scheduled" ? "bg-sky-500" : "bg-success",
									)}
								/>
								<span className="relative z-10 mt-1.5 max-w-32 truncate rounded bg-card px-1 text-xs font-medium">
									{b.name}
								</span>
							</Link>
						))}
					</div>
					{spanMs && (
						<div className="mt-2 flex justify-between text-xs text-muted-foreground tabular-nums">
							<span>{shortDate(from)}</span>
							<span>{shortDate(from + spanMs)}</span>
						</div>
					)}
				</div>
			)}
			{drafts.length > 0 && (
				<div
					className={cn(
						"flex flex-wrap items-center gap-2 text-sm",
						placed.length > 0 && "border-t border-border/70 pt-4",
					)}
				>
					<span className="text-muted-foreground">Not scheduled yet</span>
					{drafts.map((b) => (
						<Link
							key={b.id}
							to="/broadcasts/$id"
							params={{ id: b.id }}
							className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-xs font-medium hover:border-foreground/40"
						>
							<span className="size-2 rounded-full border border-muted-foreground" />
							{b.name}
						</Link>
					))}
				</div>
			)}
		</Card>
	);
}
