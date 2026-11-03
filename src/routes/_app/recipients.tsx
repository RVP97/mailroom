import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleAlert, CircleCheck, Search, UserSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { UserAvatar } from "@/components/org-avatar";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { lookupRecipientFn } from "@/functions/recipients";
import { removeSuppressionFn, resubscribeFn } from "@/functions/settings";
import { shownStatus } from "@/lib/email-status";
import { formatAgo, formatDateTime, formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { useOptimisticState } from "@/lib/optimistic";
import { allows, maskDigits } from "@/lib/permissions";
import { ago, Ph, pick, Sketch, sample, usePage } from "@/lib/sketch";

export const Route = createFileRoute("/_app/recipients")({
	validateSearch: (s: Record<string, unknown>): { address?: string } =>
		typeof s.address === "string" && s.address ? { address: s.address } : {},
	loaderDeps: ({ search }) => ({ address: search.address }),
	loader: ({ deps }) =>
		deps.address
			? lookupRecipientFn({ data: { address: deps.address } }).catch(() => null)
			: null,
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.address ?? "Recipients"} · Mailroom` }],
	}),
	component: Recipients,
	pendingComponent: RecipientsSketch,
});

/** The address is known (it's in the address bar); what it found draws as placeholders. */
function RecipientsSketch() {
	const { search } = usePage(Route);
	return (
		<Sketch
			data={
				search.address
					? {
							object: "recipient",
							address: search.address,
							can_receive: true,
							reasons: [],
							unsubscribed: [],
							suppressions: [],
							emails: sample(5, (i) => ({
								id: `sketch-${i}`,
								brand_id: "",
								subject: pick(i, [
									"Your booking is confirmed",
									"Your invoice",
									"Reminder: check-in tomorrow",
								]),
								status: "delivered",
								opened_at: null,
								clicked_at: null,
								created_at: ago(i * 60 * 24),
							})),
						}
					: null
			}
		>
			<Recipients />
		</Sketch>
	);
}

type Lookup = Awaited<ReturnType<typeof lookupRecipientFn>> | null;
/** A brand's suppression, or (with a group) one unsubscribe. */
type Block = { brand_id: string; group?: string };

/** The lookup without a block that was just lifted. */
function withoutBlock(r: Lookup, block: Block): Lookup {
	if (!r) return r;
	return block.group === undefined
		? { ...r, suppressions: r.suppressions.filter((s) => s.brand_id !== block.brand_id) }
		: {
				...r,
				unsubscribed: r.unsubscribed.filter(
					(u) => !(u.brand_id === block.brand_id && u.group === block.group),
				),
			};
}

/**
 * One recipient across every brand, for support: «did my code arrive?». Whether they can get
 * email now and why not, what was sent to them, and the one click that lets them receive again.
 * Each lookup goes in the access log.
 */
function Recipients() {
	// Letting someone receive again takes the row away at once; a failed save brings it back.
	const { data, search } = usePage(Route);
	const [r, save] = useOptimisticState(data, withoutBlock);
	const { address } = search;
	const navigate = Route.useNavigate();
	const me = useMe();
	const canFix = allows(me.active?.access, "recipients:unblock");
	const dots = !allows(me.active?.access, "emails:unmasked");
	const several = me.brands.length > 1;
	const brandName = new Map(me.brands.map((b) => [b.id, b.name]));
	const [value, setValue] = useState(address ?? "");
	const [everything, setEverything] = useState(false);
	useEffect(() => {
		setValue(address ?? "");
		setEverything(false);
	}, [address]);
	const now = Date.now();

	const fix = async (block: Block, fn: () => Promise<unknown>, done: string) => {
		if (await save(block, fn)) toast.success(done);
	};

	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="Recipients"
				description="Can someone get your emails? Look up an address to see why not, and what was sent to them, across every brand."
				actions={
					<ApiDrawer
						title="Recipients in the API"
						calls={[
							{
								title: "Look one up",
								method: "GET",
								path: "/recipients/someone@example.com",
							},
						]}
					/>
				}
			/>
			<form
				className="flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const a = value.trim().toLowerCase();
					if (a) navigate({ search: { address: a } });
				}}
			>
				<Input
					type="email"
					required
					autoFocus={!address}
					aria-label="Email address"
					placeholder="someone@example.com"
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<Button
					type="submit"
					disabled={!value.trim()}
				>
					<Search />
					Look up
				</Button>
			</form>

			{!address ? (
				<TableCard>
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<UserSearch />
							</EmptyMedia>
							<EmptyTitle>Look up a recipient</EmptyTitle>
							<EmptyDescription>
								Suppressions, unsubscribes, the firewall and their last emails, in
								one place. Lookups are kept in the access log (Settings).
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				</TableCard>
			) : !r ? (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>That isn't an email address</AlertTitle>
					<AlertDescription>Check it and look it up again.</AlertDescription>
				</Alert>
			) : (
				<>
					<div className="flex items-center gap-3">
						<UserAvatar
							name={r.address}
							className="size-10"
						/>
						<div className="min-w-0">
							<h2 className="truncate text-lg font-semibold">{r.address}</h2>
							<p className="text-sm text-muted-foreground">
								<Ph>
									{r.emails.length
										? `${r.emails.length === 50 ? "50+" : r.emails.length} emails, the last ${formatRelative(r.emails[0]?.created_at)}`
										: "Nothing sent to this address yet"}
								</Ph>
							</p>
						</div>
					</div>
					{r.can_receive ? (
						<Alert
							data-ph
							variant="success"
						>
							<CircleCheck />
							<AlertTitle>Can get your emails</AlertTitle>
							<AlertDescription>
								Not suppressed, not blocked by the firewall
								{r.unsubscribed.length
									? ", though they left some unsubscribe groups (below)"
									: ""}
								.
							</AlertDescription>
						</Alert>
					) : (
						<Alert variant="destructive">
							<CircleAlert />
							<AlertTitle>Doesn't get your emails</AlertTitle>
							<AlertDescription>
								<ul className="list-disc pl-4">
									{r.reasons.map((why) => (
										<li key={why}>{why}</li>
									))}
								</ul>
							</AlertDescription>
						</Alert>
					)}

					{r.suppressions.length > 0 && (
						<Section title="Suppressed">
							<TableCard>
								<ul>
									{r.suppressions.map((s) => (
										<li
											key={s.brand_id}
											className="flex flex-col gap-2 border-b border-border/70 px-5 py-3.5 last:border-0 sm:flex-row sm:items-center"
										>
											<div className="min-w-0 flex-1">
												<p className="text-sm font-medium">
													{s.explanation?.title ??
														(s.reason === "complaint"
															? "Marked an email as spam"
															: "Added by hand")}
													{several && (
														<span className="font-normal text-muted-foreground">
															{" "}
															· {s.brand}
														</span>
													)}
												</p>
												<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
													{s.explanation?.sentence ?? s.detail}
												</p>
											</div>
											{canFix && (
												<Button
													size="sm"
													variant="outline"
													onClick={() =>
														fix(
															{ brand_id: s.brand_id },
															() =>
																removeSuppressionFn({
																	data: {
																		address: r.address,
																		brand: s.brand_id,
																	},
																}),
															`${r.address} can get emails again`,
														)
													}
												>
													Let them receive again
												</Button>
											)}
										</li>
									))}
								</ul>
							</TableCard>
						</Section>
					)}

					{r.unsubscribed.length > 0 && (
						<Section
							title="Unsubscribed"
							description="Only emails sent with these groups skip them."
						>
							<TableCard>
								<ul>
									{r.unsubscribed.map((u) => (
										<li
											key={`${u.brand_id}:${u.group}`}
											className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0"
										>
											<Badge
												variant="secondary"
												className="font-mono"
											>
												{u.group}
											</Badge>
											<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
												{several ? `${u.brand} · ` : ""}
												{formatAgo(u.created_at, now)} ago
											</span>
											{canFix && (
												<Button
													size="sm"
													variant="ghost"
													onClick={() =>
														fix(
															{
																brand_id: u.brand_id,
																group: u.group,
															},
															() =>
																resubscribeFn({
																	data: {
																		group: u.group,
																		address: r.address,
																		brand: u.brand_id,
																	},
																}),
															`${r.address} gets ${u.group} emails again`,
														)
													}
												>
													Subscribe again
												</Button>
											)}
										</li>
									))}
								</ul>
							</TableCard>
						</Section>
					)}

					<Section
						title="Last emails"
						actions={
							r.emails.length > 0 && (
								<Button
									variant="ghost"
									size="sm"
									asChild
								>
									<Link
										to="/emails"
										search={{ q: r.address }}
									>
										All emails
									</Link>
								</Button>
							)
						}
					>
						<TableCard>
							{r.emails.length === 0 ? (
								<p className="px-5 py-6 text-center text-sm text-muted-foreground">
									Nothing was sent to {r.address} yet.
								</p>
							) : (
								<Table className="table-fixed">
									<TableHeader>
										<TableRow>
											<TableHead>Subject</TableHead>
											{several && (
												<TableHead className="hidden w-40 md:table-cell">
													Brand
												</TableHead>
											)}
											<TableHead className="w-32">Status</TableHead>
											<TableHead className="w-20 text-right">Sent</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{(everything ? r.emails : r.emails.slice(0, 10)).map(
											(e) => (
												<TableRow
													key={e.id}
													className="relative"
												>
													<TableCell className="h-12">
														<Link
															to="/emails/$id"
															params={{ id: e.id }}
															className="block truncate outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
														>
															<Ph>
																{dots
																	? maskDigits(e.subject)
																	: e.subject}
															</Ph>
														</Link>
													</TableCell>
													{several && (
														<TableCell className="hidden truncate text-muted-foreground md:table-cell">
															<Ph>
																{brandName.get(e.brand_id) ?? "—"}
															</Ph>
														</TableCell>
													)}
													<TableCell>
														<StatusBadge status={shownStatus(e)} />
													</TableCell>
													<TableCell
														className="text-right text-muted-foreground tabular-nums"
														title={formatDateTime(e.created_at)}
													>
														<Ph>{formatAgo(e.created_at, now)}</Ph>
													</TableCell>
												</TableRow>
											),
										)}
									</TableBody>
								</Table>
							)}
							{!everything && r.emails.length > 10 && (
								<button
									type="button"
									onClick={() => setEverything(true)}
									className="w-full border-t border-border/70 py-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
								>
									Show all {r.emails.length}
								</button>
							)}
						</TableCard>
					</Section>
				</>
			)}
		</Page>
	);
}
