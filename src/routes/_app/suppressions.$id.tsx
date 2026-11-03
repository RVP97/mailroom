import { createFileRoute, Link, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import {
	Ban,
	CircleAlert,
	Copy,
	Flag,
	Link2,
	type LucideIcon,
	Mail,
	MailX,
	MoreHorizontal,
	Undo2,
	UserSearch,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { CodeBlock } from "@/components/code-block";
import { Confirm } from "@/components/confirm";
import { CopyValue, useCopy } from "@/components/copy";
import { Page, Section, TableCard } from "@/components/page";
import { Fact, Facts, RecordHeader, type Tone } from "@/components/record";
import { PagePending } from "@/components/route-states";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { getSuppressionFn, removeSuppressionFn, restoreSuppressionFn } from "@/functions/settings";
import { shownStatus } from "@/lib/email-status";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { listedRow, Ph, Sketch, useOpened, usePage } from "@/lib/sketch";

export const Route = createFileRoute("/_app/suppressions/$id")({
	validateSearch: z.object({
		/** Whose list (the brand's id), for an organization with several. */
		brand: z.string().optional(),
		/** Opened from the list filtered to that brand: the way back keeps the filter. */
		filtered: z.boolean().optional(),
	}),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: async ({ params, deps }) => {
		const s = await getSuppressionFn({ data: { address: params.id, brand: deps.brand } });
		if (!s) throw notFound();
		return s;
	},
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.suppression.address ?? "Suppression"} · Mailroom` }],
	}),
	component: SuppressionPage,
	pendingComponent: SuppressionSketch,
});

/** What it showed last time; the first time, the generic skeleton (the reasons vary too much). */
function SuppressionSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("suppression-page", params.id);
	if (!opened) return <PagePending />;
	return (
		<Sketch data={opened}>
			<SuppressionPage />
		</Sketch>
	);
}

type Data = Awaited<ReturnType<typeof getSuppressionFn>> & {};

const REASON: Record<string, { label: string; status: string; tone: Tone; icon: LucideIcon }> = {
	bounce: { label: "Hard bounce", status: "bounced", tone: "red", icon: MailX },
	complaint: { label: "Spam complaint", status: "complained", tone: "amber", icon: Flag },
	manual: { label: "Added by hand", status: "canceled", tone: "gray", icon: Ban },
};

/** How it got on the list. */
function sourceOf({ suppression: s, email }: Data) {
	if (s.reason === "bounce")
		return s.detail === "EmailValidationSuppressed" ||
			email?.bounce_type?.endsWith("/EmailValidationSuppressed")
			? "SES Auto Validation hold"
			: "SES bounce";
	if (s.reason === "complaint") return "SES complaint (feedback loop)";
	if (s.detail === "Added in the dashboard") return "Dashboard";
	return "API or AI assistant (MCP)";
}

/** The bounce's type and sub-type, as SES reported them. */
function bounceKind({ email, event }: Data) {
	const b = event?.data?.bounce as { type?: string; subType?: string } | undefined;
	if (b?.type) return [b.type, b.subType].filter(Boolean).join(" · ");
	// Only hard bounces put an address here.
	return email?.bounce_type?.split("/").filter(Boolean).join(" · ") || "Permanent";
}

/** SES's diagnostic for this address: the receiving server's own reply, when it gave one. */
function diagnosticOf({ suppression: s, email, event }: Data) {
	const b = event?.data?.bounce as { message?: string } | undefined;
	const text = b?.message || (s.reason === "bounce" ? s.detail : null) || email?.error;
	return text && text !== email?.bounce_type?.split("/")[1] ? text : null;
}

function SuppressionPage() {
	const { data, search } = usePage(Route);
	useOpened(
		"suppression-page",
		useMemo(() => ({ ...data, id: data.suppression.address }), [data]),
	);
	const navigate = useNavigate();
	const router = useRouter();
	const me = useMe();
	const canRemove = allows(me.active?.access, "recipients:unblock");
	const [removing, setRemoving] = useState(false);
	const { suppression: s, email, brand } = data;
	const reason = REASON[s.reason] ?? {
		label: s.reason,
		status: "canceled",
		tone: "gray" as Tone,
		icon: Ban,
	};
	const several = me.brands.length > 1;
	const back = search.filtered ? { brand: s.organization_id } : {};
	const diagnostic = diagnosticOf(data);
	const kind = bounceKind(data);
	const now = Date.now();
	const raw = {
		object: "suppression",
		address: s.address,
		reason: s.reason,
		detail: s.detail,
		email_id: s.email_id,
		created_at: s.created_at,
		brand_id: s.organization_id,
	};
	const path = `/suppressions/${encodeURIComponent(s.address)}${several ? `?brand=${s.organization_id}` : ""}`;

	const remove = async () => {
		const row = { ...s };
		try {
			await removeSuppressionFn({ data: { address: s.address, brand: s.organization_id } });
		} catch (error) {
			toast.error(await errorMessage(error));
			return;
		}
		// The list has it cached: it loads again rather than show the row for a moment.
		const list = () =>
			router.invalidate({ filter: (m) => m.routeId === "/_app/suppressions/" });
		await list();
		navigate({ to: "/suppressions", search: back });
		toast.success(`${s.address} can get emails again`, {
			action: {
				label: "Undo",
				onClick: async () => {
					try {
						await restoreSuppressionFn({
							data: {
								brand: row.organization_id,
								address: row.address,
								reason: row.reason as "bounce" | "complaint" | "manual",
								detail: row.detail,
								email_id: row.email_id,
								created_at: row.created_at,
							},
						});
						await list();
						toast.success(`${row.address} is suppressed again`);
						navigate({
							to: "/suppressions/$id",
							params: { id: row.address },
							search: several ? { brand: row.organization_id } : {},
						});
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				},
			},
		});
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/suppressions"
						search={back}
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Suppressions
					</Link>
				</nav>
				<RecordHeader
					icon={reason.icon}
					tone={reason.tone}
					kind="Suppression"
					title={s.address}
					actions={
						<>
							{canRemove && (
								<Button
									variant="outline"
									className="hidden sm:inline-flex"
									onClick={() => setRemoving(true)}
								>
									<Undo2 />
									Remove
								</Button>
							)}
							<ApiDrawer
								title="This suppression in the API"
								calls={[
									{ title: "Retrieve it", method: "GET", path },
									...(canRemove
										? [
												{
													title: "Send to it again",
													method: "DELETE" as const,
													path,
												},
											]
										: []),
								]}
							/>
							<MoreMenu
								address={s.address}
								canRemove={canRemove}
								onRemove={() => setRemoving(true)}
							/>
						</>
					}
				/>
			</div>
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
				onConfirm={() => void remove()}
			/>

			<Facts>
				<Fact
					label="Address"
					className="col-span-2"
				>
					<CopyValue value={s.address} />
				</Fact>
				<Fact label="Reason">
					<StatusBadge
						status={reason.status}
						label={reason.label}
					/>
				</Fact>
				<Fact label="Added">
					<span
						className="tabular-nums"
						title={formatDateTime(s.created_at)}
					>
						{formatRelative(s.created_at)}
					</span>
				</Fact>
				<Fact label="Source">{sourceOf(data)}</Fact>
				{s.reason === "bounce" && (
					<Fact label="Bounce type">
						<span title={kind}>{kind}</span>
					</Fact>
				)}
				{s.reason === "complaint" && (
					<Fact label="Feedback type">
						<span className="font-mono text-[13px]">{s.detail || "—"}</span>
					</Fact>
				)}
				{s.reason === "manual" && (
					<Fact label="Note">
						<span title={s.detail ?? undefined}>
							{(s.detail !== "Added in the dashboard" && s.detail) || "—"}
						</span>
					</Fact>
				)}
				{several && <Fact label="Brand">{brand?.name ?? "—"}</Fact>}
				<Fact
					label="Caused by"
					className="col-span-2"
				>
					{email ? (
						<Link
							to="/emails/$id"
							params={{ id: email.id }}
							className="flex min-w-0 items-center gap-1.5 underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
						>
							<Mail className="size-3.5 shrink-0 text-muted-foreground" />
							<Ph className="truncate">{email.subject || "(no subject)"}</Ph>
						</Link>
					) : (
						<span className="text-muted-foreground">
							{s.email_id ? "Email no longer kept" : "—"}
						</span>
					)}
				</Fact>
			</Facts>

			{(data.explanation || s.reason === "complaint") && (
				<Alert variant={s.reason === "complaint" ? "warning" : "destructive"}>
					<CircleAlert />
					<AlertTitle>
						<Ph>{data.explanation?.title ?? "Marked as spam"}</Ph>
					</AlertTitle>
					<AlertDescription>
						<p>
							<Ph>
								{data.explanation?.sentence ??
									"The recipient reported an email from you as spam, so Mailroom won't send to them again. Mailbox providers watch complaint rates closely."}
							</Ph>
						</p>
					</AlertDescription>
				</Alert>
			)}

			{diagnostic && (
				<Section
					title="SES diagnostic"
					description="What the receiving mail server answered."
				>
					<CodeBlock
						data
						code={diagnostic}
						lang="text"
						className="[&_code]:whitespace-pre-wrap [&_code]:break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
					/>
				</Section>
			)}

			{data.also.length > 0 && (
				<Section
					title="Other brands"
					description="These brands don't send to it either."
				>
					<TableCard>
						<ul>
							{data.also.map((a) => (
								<li
									key={a.organization_id}
									className="relative flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0"
								>
									<Link
										to="/suppressions/$id"
										params={{ id: a.address }}
										search={{ brand: a.organization_id }}
										className="min-w-0 flex-1 truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
									>
										<Ph>{a.brand ?? "A brand"}</Ph>
									</Link>
									<StatusBadge
										status={REASON[a.reason]?.status ?? "canceled"}
										label={REASON[a.reason]?.label ?? a.reason}
									/>
									<span
										className="w-16 text-right text-sm text-muted-foreground tabular-nums"
										title={formatDateTime(a.created_at)}
									>
										<Ph>{formatAgo(a.created_at, now)}</Ph>
									</span>
								</li>
							))}
						</ul>
					</TableCard>
				</Section>
			)}

			<Section
				title="Emails to this address"
				description={several ? `Sent from ${brand?.name ?? "this brand"}.` : undefined}
				actions={
					<>
						<Button
							variant="ghost"
							size="sm"
							asChild
						>
							{/* A lookup is logged in the access log: open it only on a click. */}
							<Link
								to="/recipients"
								search={{ address: s.address }}
								preload={false}
							>
								<UserSearch />
								<span className="hidden sm:inline">Look up recipient</span>
								<span className="sm:hidden">Look up</span>
							</Link>
						</Button>
						{data.emails.length > 0 && (
							<Button
								variant="ghost"
								size="sm"
								asChild
							>
								<Link
									to="/emails"
									search={{ q: s.address }}
								>
									All emails
								</Link>
							</Button>
						)}
					</>
				}
			>
				<TableCard>
					{data.emails.length === 0 ? (
						<p className="px-5 py-6 text-center text-sm text-muted-foreground">
							No emails to {s.address} are kept.
						</p>
					) : (
						<Table className="table-fixed">
							<TableHeader>
								<TableRow>
									<TableHead>Subject</TableHead>
									<TableHead className="w-32">Status</TableHead>
									<TableHead className="w-20 text-right">Sent</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.emails.map((e) => (
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
												<Ph>{e.subject || "(no subject)"}</Ph>
											</Link>
										</TableCell>
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
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
			</Section>

			{data.unsubscribed.length > 0 && (
				<Section
					title="Unsubscribed"
					description="They also left these groups with an email's one-click link."
				>
					<div className="flex flex-wrap gap-2">
						{data.unsubscribed.map((u) => (
							<Badge
								key={u.group}
								variant="secondary"
								className="font-mono"
								title={formatDateTime(u.created_at)}
							>
								<Ph>{u.group}</Ph>
							</Badge>
						))}
					</div>
				</Section>
			)}

			<Section title="Raw">
				<CodeBlock
					data
					code={JSON.stringify(raw, null, 2)}
					lang="json"
				/>
			</Section>
		</Page>
	);
}

function MoreMenu({
	address,
	canRemove,
	onRemove,
}: {
	address: string;
	canRemove: boolean;
	onRemove: () => void;
}) {
	const { copy } = useCopy();
	return (
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
				<DropdownMenuItem
					onSelect={() => {
						copy(address);
						toast.success("Address copied");
					}}
				>
					<Copy />
					Copy address
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						copy(window.location.href);
						toast.success("Link copied");
					}}
				>
					<Link2 />
					Copy link
				</DropdownMenuItem>
				{canRemove && (
					<>
						<DropdownMenuSeparator className="sm:hidden" />
						<DropdownMenuItem
							className="sm:hidden"
							variant="destructive"
							onSelect={onRemove}
						>
							<Undo2 />
							Remove suppression
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
