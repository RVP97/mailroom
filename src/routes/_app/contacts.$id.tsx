import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	Circle,
	CircleCheck,
	ExternalLink,
	Gift,
	Merge,
	MoreHorizontal,
	Trash2,
	Users,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm } from "@/components/confirm";
import { ContactTimeline } from "@/components/contact-timeline";
import { CopyButton } from "@/components/copy";
import { EngagementCard } from "@/components/engagement";
import { LeadCard } from "@/components/lead-score";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import {
	contactTimelineFn,
	deleteContactFn,
	getContactFn,
	mergeContactFn,
	saveContactFn,
	setContactSegmentFn,
	setContactTopicFn,
} from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/contacts/$id")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ params, deps }) => getContactFn({ data: { id: params.id, brand: deps.brand } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.contact.email ?? "Contact"} · Mailroom` }],
	}),
	component: ContactPage,
	pendingComponent: ContactSketch,
});

type Data = Awaited<ReturnType<typeof getContactFn>>;

function ContactSketch() {
	const { params } = usePage(Route);
	const row = listedRow<Data["contact"]>("contacts", params.id);
	return (
		<Sketch
			data={
				{
					contact: row ?? {
						object: "contact",
						id: params.id ?? "",
						brand_id: "",
						email: "someone@example.com",
						first_name: "Ana",
						last_name: null,
						unsubscribed: false,
						properties: {},
						timezone: null,
						pace: null,
						paused_until: null,
						created_at: ago(60 * 24),
						updated_at: ago(60),
					},
					engagement: null,
					lead: { score: 0, level: "cold", hot: 50, warm: 20, days: 90, breakdown: [] },
					referrals: null,
					brand: null,
					segments: [],
					topics: [],
					properties: [],
					timeline: { object: "list", next: null, data: [] },
				} satisfies Data
			}
		>
			<ContactPage />
		</Sketch>
	);
}

function ContactPage() {
	const { data, search } = usePage(Route);
	const { contact } = data;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "contacts:edit");
	const brand = search.brand ?? contact.brand_id;
	const [first, setFirst] = useState(contact.first_name ?? "");
	const [last, setLast] = useState(contact.last_name ?? "");
	const [props, setProps] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [merging, setMerging] = useState(false);
	const canDelete = allows(me.active?.access, "contacts:delete");
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved contact changes
	useEffect(() => {
		setFirst(contact.first_name ?? "");
		setLast(contact.last_name ?? "");
		setProps(
			Object.fromEntries(
				data.properties.map((p) => [p.key, String(contact.properties[p.key] ?? "")]),
			),
		);
	}, [contact.updated_at, contact.id]);
	const saved = {
		first: contact.first_name ?? "",
		last: contact.last_name ?? "",
		props: Object.fromEntries(
			data.properties.map((p) => [p.key, String(contact.properties[p.key] ?? "")]),
		),
	};
	const dirty =
		first !== saved.first ||
		last !== saved.last ||
		data.properties.some((p) => (props[p.key] ?? "") !== saved.props[p.key]);

	const run = async (fn: () => Promise<unknown>, done?: string) => {
		try {
			await fn();
			if (done) toast.success(done);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};
	const save = async () => {
		setBusy(true);
		await run(
			() =>
				saveContactFn({
					data: {
						brand,
						id: contact.id,
						fields: {
							email: contact.email,
							first_name: first || null,
							last_name: last || null,
							properties: Object.fromEntries(
								data.properties.map((p) => [
									p.key,
									props[p.key] ? props[p.key] : null,
								]),
							) as Record<string, string | null>,
						},
					},
				}),
			"Contact saved",
		);
		setBusy(false);
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/contacts"
						search={{ brand: search.brand }}
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Contacts
					</Link>
				</nav>
				<RecordHeader
					icon={Users}
					tone={contact.unsubscribed ? "gray" : "green"}
					kind={data.brand ? `Contact of ${data.brand.name}` : "Contact"}
					title={contact.email}
					actions={
						canManage && (
							<>
								<Button
									disabled={!dirty || busy}
									onClick={save}
								>
									{busy && <Spinner />}
									Save
								</Button>
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
										{canDelete && (
											<DropdownMenuItem onSelect={() => setMerging(true)}>
												<Merge /> Merge another contact into this one
											</DropdownMenuItem>
										)}
										<DropdownMenuItem
											variant="destructive"
											onSelect={() => setDeleting(true)}
										>
											<Trash2 /> Delete contact
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</>
						)
					}
				/>
			</div>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this contact?"
				description="They leave every segment and their topic choices go. Emails already sent stay in the log."
				action="Delete contact"
				onConfirm={async () => {
					try {
						await deleteContactFn({ data: { brand, id: contact.id } });
						toast.success("Contact deleted");
						await router.navigate({ to: "/contacts", search: { brand: search.brand } });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<MergeDialog
				open={merging}
				onOpenChange={setMerging}
				email={contact.email}
				onMerge={async (other) => {
					try {
						const out = await mergeContactFn({
							data: { brand, id: contact.id, merge: other },
						});
						toast.success(`${out.merged_email} is now part of this contact`);
						setMerging(false);
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">
					<StatusBadge
						status={contact.unsubscribed ? "unsubscribed" : "ready"}
						label={contact.unsubscribed ? "Unsubscribed from all" : "Subscribed"}
					/>
				</Fact>
				<Fact label="Added">
					<span title={formatDateTime(contact.created_at)}>
						{formatAgo(contact.created_at)}
					</span>
				</Fact>
				<Fact label="Segments">{data.segments.filter((s) => s.member).length}</Fact>
				<Fact label="Id">
					<IdChip value={contact.id} />
				</Fact>
			</Facts>

			<div className="grid items-start gap-6 lg:grid-cols-2">
				<div className="flex flex-col gap-6">
					<Card className="gap-5 p-5">
						<h2 className="font-semibold">Details</h2>
						<div className="grid gap-5 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="c-first">First name</FieldLabel>
								<Input
									id="c-first"
									disabled={!canManage}
									value={first}
									onChange={(e) => setFirst(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="c-last">Last name</FieldLabel>
								<Input
									id="c-last"
									disabled={!canManage}
									value={last}
									onChange={(e) => setLast(e.target.value)}
								/>
							</Field>
							{data.properties.map((p) => (
								<Field key={p.id}>
									<FieldLabel
										htmlFor={`c-${p.key}`}
										className="font-mono text-[13px]"
									>
										{p.key}
									</FieldLabel>
									<Input
										id={`c-${p.key}`}
										disabled={!canManage}
										inputMode={p.type === "number" ? "decimal" : undefined}
										placeholder={
											p.fallback_value === null
												? ""
												: `${p.fallback_value} (fallback)`
										}
										value={props[p.key] ?? ""}
										onChange={(e) =>
											setProps((x) => ({ ...x, [p.key]: e.target.value }))
										}
									/>
								</Field>
							))}
						</div>
						<div className="flex items-center justify-between gap-4 border-t border-border/70 pt-4 text-sm">
							<label htmlFor="c-unsubscribed">
								<span className="font-medium">
									Unsubscribed from all broadcasts
								</span>
								<span className="block text-muted-foreground">
									Their emails from your app (receipts, sign-in codes) still go.
								</span>
							</label>
							<Switch
								id="c-unsubscribed"
								disabled={!canManage}
								checked={contact.unsubscribed}
								onCheckedChange={(v) =>
									run(
										() =>
											saveContactFn({
												data: {
													brand,
													id: contact.id,
													fields: {
														email: contact.email,
														first_name: contact.first_name,
														last_name: contact.last_name,
														unsubscribed: v,
													},
												},
											}),
										v ? "Unsubscribed from all broadcasts" : "Subscribed again",
									)
								}
							/>
						</div>
						{!contact.unsubscribed && (
							<div className="flex items-center justify-between gap-4 text-sm">
								<label htmlFor="c-pace">
									<span className="font-medium">How often</span>
									<span className="block text-muted-foreground">
										{contact.paused_until &&
										contact.paused_until > new Date().toISOString()
											? `Paused until ${formatDateTime(contact.paused_until)}: no broadcasts or automation emails.`
											: "They can change it on their preferences page too."}
									</span>
								</label>
								<Select
									disabled={!canManage}
									value={
										contact.paused_until &&
										contact.paused_until > new Date().toISOString()
											? "pause"
											: (contact.pace ?? "all")
									}
									onValueChange={(v) =>
										run(
											() =>
												saveContactFn({
													data: {
														brand,
														id: contact.id,
														fields: {
															email: contact.email,
															first_name: contact.first_name,
															last_name: contact.last_name,
															...(v === "pause"
																? {
																		paused_until: new Date(
																			Date.now() +
																				30 * 86_400_000,
																		).toISOString(),
																	}
																: {
																		pace:
																			v === "all"
																				? null
																				: (v as
																						| "weekly"
																						| "monthly"),
																		paused_until: null,
																	}),
														},
													},
												}),
											"Saved",
										)
									}
								>
									<SelectTrigger
										id="c-pace"
										className="w-52"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">Every broadcast</SelectItem>
										<SelectItem value="weekly">At most one a week</SelectItem>
										<SelectItem value="monthly">At most one a month</SelectItem>
										<SelectItem value="pause">Paused for 30 days</SelectItem>
									</SelectContent>
								</Select>
							</div>
						)}
					</Card>
					{data.referrals && (
						<ReferralCard
							r={data.referrals}
							brand={contact.brand_id}
						/>
					)}
				</div>

				<div className="flex flex-col gap-6">
					<EngagementCard e={data.engagement} />
					<LeadCard
						lead={data.lead}
						brand={contact.brand_id}
					/>
					<Card className="gap-4 p-5">
						<h2 className="font-semibold">Segments</h2>
						{data.segments.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								This brand has no segments yet (Contacts › Segments).
							</p>
						) : (
							<ul className="flex flex-col gap-2.5">
								{data.segments.map((s) => (
									<li key={s.id}>
										<div className="flex items-center gap-2.5 text-sm">
											<Checkbox
												id={`seg-${s.id}`}
												disabled={!canManage || s.live}
												checked={s.member}
												onCheckedChange={(v) =>
													run(() =>
														setContactSegmentFn({
															data: {
																brand,
																id: contact.id,
																segment: s.id,
																member: v === true,
															},
														}),
													)
												}
											/>
											<label htmlFor={`seg-${s.id}`}>{s.name}</label>
											{s.live && (
												<span
													className="ml-auto text-xs text-muted-foreground"
													title="Live segments follow their rules, so people can't be added by hand."
												>
													Live
												</span>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
					</Card>
					<Card className="gap-4 p-5">
						<h2 className="font-semibold">Topics</h2>
						{data.topics.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								This brand has no topics yet (Contacts › Topics).
							</p>
						) : (
							<ul className="flex flex-col gap-3">
								{data.topics.map((t) => (
									<li
										key={t.id}
										className="flex items-center justify-between gap-4 text-sm"
									>
										<span className="min-w-0">
											<span className="block truncate">{t.name}</span>
											{t.description && (
												<span className="block truncate text-xs text-muted-foreground">
													{t.description}
												</span>
											)}
										</span>
										<Switch
											disabled={!canManage}
											aria-label={t.name}
											checked={t.subscription === "opt_in"}
											onCheckedChange={(v) =>
												run(() =>
													setContactTopicFn({
														data: {
															brand,
															id: contact.id,
															topic: t.id,
															subscription: v ? "opt_in" : "opt_out",
														},
													}),
												)
											}
										/>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
			</div>

			<Card className="gap-5 p-5">
				<div>
					<h2 className="font-semibold">Timeline</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Everything they did, newest first: in your app, with your emails, in
						conversations and chats.
					</p>
				</div>
				<ContactTimeline
					key={contact.id}
					page={data.timeline}
					brand={brand}
					more={(before) =>
						contactTimelineFn({ data: { brand, id: contact.id, before } })
					}
				/>
			</Card>
		</Page>
	);
}

/** Folds the contact of another address into this one. */
function MergeDialog({
	open,
	onOpenChange,
	email,
	onMerge,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	email: string;
	onMerge: (other: string) => Promise<void>;
}) {
	const [other, setOther] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				onOpenChange(o);
				if (!o) setOther("");
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						await onMerge(other.trim());
						setBusy(false);
					}}
				>
					<DialogHeader>
						<DialogTitle>Merge another contact into this one</DialogTitle>
						<DialogDescription>
							For the same person under two addresses. {email} stays; the other one's
							segments, topic choices, missing details, events, poll answers and
							referrals move here, then it's deleted.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field>
							<FieldLabel htmlFor="merge-other">The other contact's email</FieldLabel>
							<Input
								id="merge-other"
								type="email"
								required
								autoFocus
								placeholder="ana.personal@example.com"
								value={other}
								onChange={(e) => setOther(e.target.value)}
							/>
							<FieldDescription>
								Emails and conversations stay under the address they were for.
							</FieldDescription>
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
							disabled={busy || !other.includes("@")}
						>
							{busy && <Spinner />}
							Merge
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type Referrals = NonNullable<Data["referrals"]>;

const personName = (p: { email: string; first_name: string | null; last_name: string | null }) =>
	[p.first_name, p.last_name].filter(Boolean).join(" ") || p.email;

/**
 * Their side of the referral program: how many friends they brought and where that ranks, a
 * track of the milestones (reached ones filled in), who brought them, and who they brought.
 */
function ReferralCard({ r, brand }: { r: Referrals; brand: string }) {
	const next = r.rewards.find((x) => x.count > r.count);
	const top = Math.max(r.count, r.rewards.at(-1)?.count ?? 0, 1);
	return (
		<Card className="gap-0 overflow-hidden p-0">
			<div className="flex items-start gap-3 px-5 pt-5 pb-4">
				<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-600 dark:text-violet-400">
					<Gift className="size-[18px]" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 className="font-semibold">Referrals</h2>
					<p className="mt-0.5 truncate text-sm text-muted-foreground">
						{r.program ? (
							<>
								In{" "}
								<Link
									to="/newsletters/$id"
									params={{ id: r.program.id }}
									search={{ tab: "referrals" }}
									className="underline-offset-2 hover:underline"
								>
									{r.program.name}
								</Link>
								's program
							</>
						) : (
							"The program is off now"
						)}
					</p>
				</div>
				<div className="text-right">
					<p className="text-2xl leading-none font-semibold tabular-nums">{r.count}</p>
					<p className="mt-1 text-xs text-muted-foreground">
						{r.rank ? `#${r.rank} of all` : "friends brought"}
					</p>
				</div>
			</div>

			{r.rewards.length > 0 && (
				<div className="border-t border-border/70 px-5 py-4">
					<div className="relative mx-2 h-2 rounded-full bg-muted">
						<div
							className="absolute inset-y-0 left-0 rounded-full bg-violet-500"
							style={{ width: `${Math.min(100, (r.count / top) * 100)}%` }}
						/>
						{r.rewards.map((x) => (
							<span
								key={x.count}
								title={`${x.count}: ${x.reward}`}
								className={cn(
									"absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-[3px] ring-card",
									x.count <= r.count ? "bg-violet-500" : "bg-muted-foreground/40",
								)}
								style={{ left: `${(x.count / top) * 100}%` }}
							/>
						))}
					</div>
					<ul className="mt-4 flex flex-col gap-1.5 text-sm">
						{r.rewards.map((x) => {
							const got = x.count <= r.count;
							return (
								<li
									key={x.count}
									className="flex items-center gap-2"
								>
									{got ? (
										<CircleCheck className="size-4 shrink-0 text-violet-500" />
									) : (
										<Circle className="size-4 shrink-0 text-muted-foreground/50" />
									)}
									<span
										className={cn(
											"min-w-0 flex-1 truncate",
											!got && "text-muted-foreground",
										)}
									>
										{x.reward}
									</span>
									<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
										{got
											? "Unlocked"
											: x === next
												? `${x.count - r.count} more`
												: `at ${x.count}`}
									</span>
								</li>
							);
						})}
					</ul>
				</div>
			)}

			{(r.share_url || r.page_url) && (
				<div className="flex flex-col gap-2 border-t border-border/70 px-5 py-4 text-sm">
					{r.share_url && (
						<div className="flex items-center gap-2">
							<span className="w-24 shrink-0 text-muted-foreground">Share link</span>
							<code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
								{r.share_url}
							</code>
							<CopyButton value={r.share_url} />
						</div>
					)}
					{r.page_url && (
						<div className="flex items-center gap-2">
							<span className="w-24 shrink-0 text-muted-foreground">Their page</span>
							<a
								href={r.page_url}
								target="_blank"
								rel="noreferrer"
								className="inline-flex min-w-0 items-center gap-1 truncate text-xs underline-offset-2 hover:underline"
							>
								What they see when they share
								<ExternalLink className="size-3 shrink-0" />
							</a>
						</div>
					)}
				</div>
			)}

			{r.referred_by && (
				<div className="border-t border-border/70 px-5 py-3 text-sm">
					<span className="text-muted-foreground">Brought by </span>
					<Link
						to="/contacts/$id"
						params={{ id: r.referred_by.id }}
						search={{ brand }}
						className="font-medium underline-offset-2 hover:underline"
					>
						{personName(r.referred_by)}
					</Link>
				</div>
			)}

			<div className="border-t border-border/70">
				<p className="px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
					Friends they brought
				</p>
				{r.referred.length === 0 ? (
					<p className="px-5 pb-4 text-sm text-muted-foreground">None yet.</p>
				) : (
					<ul className="flex flex-col pb-2">
						{r.referred.map((f) => (
							<li key={f.id}>
								<Link
									to="/contacts/$id"
									params={{ id: f.id }}
									search={{ brand }}
									className="flex items-center gap-3 px-5 py-2 text-sm hover:bg-muted/40"
								>
									<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium uppercase">
										{personName(f).slice(0, 1)}
									</span>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate font-medium">
											{personName(f)}
										</span>
										{personName(f) !== f.email && (
											<span className="truncate text-xs text-muted-foreground">
												{f.email}
											</span>
										)}
									</span>
									<span
										className="shrink-0 text-xs text-muted-foreground"
										title={formatDateTime(f.created_at)}
									>
										{formatAgo(f.created_at)}
									</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</Card>
	);
}
