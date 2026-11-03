import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Download, Inbox, Search, Send, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { OrgAvatar } from "@/components/org-avatar";
import { Page, PageHeader, TableCard, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusBadge, StatusDot, statusLabel } from "@/components/status-badge";
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
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectSeparator,
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { exportEmailsFn, listEmailsFn, sendEmailFn } from "@/functions/emails";
import { explainBounce } from "@/lib/bounces";
import { downloadCsv } from "@/lib/csv";
import {
	EMAIL_FILTERS,
	type EmailFilterValue,
	FILTER_INFO,
	leftOutLabel,
	NOT_DELIVERED,
	shownStatus,
} from "@/lib/email-status";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime, formatDay } from "@/lib/format";
import { useMe } from "@/lib/me";
import { usePendingSearch } from "@/lib/pending";
import { PROVIDER_LABEL, PROVIDERS, type Provider } from "@/lib/providers";
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
import { cn } from "@/lib/utils";

/** The status filter's sections: how it went, still on its way, and what never arrived. */
const STATUS_GROUPS: { label: string; values: EmailFilterValue[] }[] = [
	{ label: "Delivered", values: ["delivered", "opened", "clicked", "complained"] },
	{ label: "On its way", values: ["sent", "delivery_delayed", "scheduled", "queued"] },
	{
		label: "Not delivered",
		values: [
			"not_delivered",
			"bounced",
			"soft_bounced",
			"failed",
			"suppressed",
			"firewall",
			"unsubscribed",
		],
	},
	{ label: "Other", values: ["canceled"] },
];

/** The dot a filter shows: a group or opened/clicked borrow the closest status's colour. */
const filterDot = (v: EmailFilterValue) =>
	v === "firewall" || v === "unsubscribed" ? "suppressed" : v;

export const Route = createFileRoute("/_app/emails/")({
	validateSearch: z.object({
		status: z.enum(EMAIL_FILTERS).optional(),
		q: z.string().optional(),
		days: z.number().int().min(1).max(365).optional(),
		/** One day (YYYY-MM-DD), by when the status happened: Overview's charts link here. */
		day: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/)
			.optional(),
		/** Sent from this domain. */
		domain: z.string().optional(),
		/** To this mailbox provider. */
		provider: z.enum(PROVIDERS as [Provider, ...Provider[]]).optional(),
		key: z.string().optional(),
		/** Carrying this tag: "name:value" (or "name" for any value). */
		tag: z.string().optional(),
		/** Made from this template. */
		template: z.string().optional(),
		/** One brand; without it, every brand of the organization. */
		brand: z.string().optional(),
		after: z.string().optional(),
	}),
	loaderDeps: ({ search }) => search,
	// New filters keep the page up (and the search box focused): only the rows turn into skeletons.
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) =>
		listEmailsFn({
			data: {
				status: deps.status,
				search: deps.q,
				days: deps.days,
				day: deps.day,
				domain: deps.domain,
				provider: deps.provider,
				key: deps.key,
				tag: deps.tag,
				template: deps.template,
				brand: deps.brand,
				after: deps.after,
			},
		}),
	head: () => ({ meta: [{ title: "Emails · Mailroom" }] }),
	component: Emails,
	pendingComponent: EmailsSketch,
});

function EmailsSketch() {
	const { search } = usePage(Route);
	const drill = Boolean((search.day || search.domain || search.provider) && !search.after);
	return (
		<Sketch
			data={{
				has_more: rememberedRows("emails:more", 0) > 0,
				keys: sample(rememberedRows("emails:keys", 1), (i) => ({
					id: `key-${i}`,
					name: "Production",
				})),
				brands: sample(rememberedRows("emails:brands", 0), (i) => ({
					id: `brand-${i}`,
					name: "Brand",
				})),
				tags: sample(rememberedRows("emails:tags", 0), (i) => ({
					name: "category",
					value: `tag-${i}`,
					count: 0,
				})),
				templateName: search.template ? "Template" : null,
				summary: drill
					? {
							all: 1000,
							delivered: 980,
							opened: 400,
							clicked: 80,
							not_delivered: 20,
							complained: 0,
							bounced: 12,
							soft_bounced: 4,
							failed: 0,
							suppressed: 4,
							firewall: 0,
							unsubscribed: 0,
						}
					: null,
				data: sample(rememberedRows("emails", 20), (i) => ({
					id: `sketch-${i}`,
					organization_id: "",
					to: [
						pick(i, [
							"guest@example.com",
							"maria.lopez@example.com",
							"reservations@example.org",
						]),
					],
					subject: pick(i, [
						"Your booking is confirmed",
						"Your invoice",
						"Reminder: check-in tomorrow",
					]),
					status: "delivered",
					opened_at: null,
					clicked_at: null,
					dropped: null,
					error: null,
					bounce_type: null,
					send_at: null,
					created_at: ago(i * 30),
				})),
			}}
		>
			<Emails />
		</Sketch>
	);
}

const PERIODS = [
	{ days: 1, label: "Last 24 hours" },
	{ days: 7, label: "Last 7 days" },
	{ days: 30, label: "Last 30 days" },
	{ days: 90, label: "Last 90 days" },
] as const;

function Emails() {
	const { data: page, search: current } = usePage(Route);
	const { search, loading } = usePendingSearch(current);
	useRememberRows("emails", loading ? undefined : page.data.length);
	useRememberRows("emails:more", loading ? undefined : page.has_more ? 1 : 0);
	useRememberRows("emails:keys", page.keys.length);
	useRememberRows("emails:brands", page.brands.length);
	useRememberRows("emails:tags", page.tags.length);
	useListed("emails", page.data);
	const navigate = Route.useNavigate();
	const me = useMe();
	const filtered = Boolean(
		search.status ||
			search.q ||
			search.days ||
			search.key ||
			search.tag ||
			search.brand ||
			search.day ||
			search.domain ||
			search.provider ||
			search.template,
	);
	const chips = [
		search.day && { key: "day" as const, label: formatDay(search.day) },
		search.domain && { key: "domain" as const, label: `From ${search.domain}` },
		search.provider && {
			key: "provider" as const,
			label: `To ${PROVIDER_LABEL[search.provider]}`,
		},
		search.template && {
			key: "template" as const,
			label: `Template ${page.templateName ?? ""}`.trim(),
		},
	].filter(Boolean) as { key: "day" | "domain" | "provider" | "template"; label: string }[];
	const names = new Map(page.brands.map((o) => [o.id, o.name]));
	const keyNames = new Map(page.keys.map((k) => [k.id, k.name]));
	// Every brand: each row says whose it is.
	const showOrg = page.brands.length > 0 && !search.brand;
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, after: undefined, ...next }, replace: true });
	const now = Date.now();
	return (
		<Page>
			<PageHeader
				title="Emails"
				description={
					showOrg ? (
						<>
							Everything <Ph>{me.active?.name ?? "this organization"}</Ph>'s brands
							sent, newest first.
						</>
					) : (
						<>
							Everything{" "}
							<Ph>
								{(search.brand && names.get(search.brand)) ||
									me.active?.name ||
									"this organization"}
							</Ph>{" "}
							sent, by API, SMTP or from here.
						</>
					)
				}
				actions={
					<>
						<ApiDrawer
							title="Emails in the API"
							calls={[
								{
									title: "Send an email",
									method: "POST",
									path: "/emails",
									body: {
										from: "Acme <hello@mail.acme.com>",
										to: ["customer@example.com"],
										subject: "Your receipt",
										html: "<p>Thanks for your order.</p>",
									},
								},
								{
									title: "Send up to 100 at once",
									method: "POST",
									path: "/emails/batch",
									body: [
										{
											from: "Acme <hello@mail.acme.com>",
											to: ["a@example.com"],
											subject: "Hi",
											text: "…",
										},
									],
								},
								{
									title: "List emails",
									method: "GET",
									path: "/emails?status=bounced&limit=50",
								},
								{ title: "Retrieve an email", method: "GET", path: "/emails/{id}" },
							]}
						/>
						<SendTest />
					</>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<SearchBox
					className="basis-full sm:basis-0"
					placeholder="Search emails"
					value={search.q ?? ""}
					onChange={(q) => go({ q: q || undefined })}
				/>
				<Select
					value={String(search.days ?? "all")}
					onValueChange={(v) => go({ days: v === "all" ? undefined : Number(v) })}
				>
					<SelectTrigger className="flex-1 sm:w-40 sm:flex-none">
						{/* Its label written out, so the server's first paint has it too. */}
						<SelectValue>
							{PERIODS.find((p) => p.days === search.days)?.label ?? "All time"}
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="end">
						<SelectItem value="all">All time</SelectItem>
						<SelectSeparator />
						{PERIODS.map((p) => (
							<SelectItem
								key={p.days}
								value={String(p.days)}
							>
								{p.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Select
					value={search.status ?? "all"}
					onValueChange={(v) =>
						go({ status: v === "all" ? undefined : (v as EmailFilterValue) })
					}
				>
					<SelectTrigger
						aria-label="Status"
						className="flex-1 sm:w-48 sm:flex-none"
					>
						<SelectValue>
							{search.status ? (
								<>
									<StatusDot status={filterDot(search.status)} />
									{search.status === "not_delivered"
										? "All not delivered"
										: FILTER_INFO[search.status].label}
								</>
							) : (
								"All statuses"
							)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent
						align="end"
						className="sm:min-w-56"
					>
						<SelectItem value="all">All statuses</SelectItem>
						{STATUS_GROUPS.map((g) => (
							<SelectGroup key={g.label}>
								<SelectSeparator />
								<SelectLabel>{g.label}</SelectLabel>
								{g.values.map((v) => (
									<SelectItem
										key={v}
										value={v}
									>
										<StatusDot status={filterDot(v)} />
										{v === "not_delivered"
											? "All not delivered"
											: FILTER_INFO[v].label}
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
				<BrandFilter
					brands={page.brands}
					value={search.brand}
					onChange={(brand) => go({ brand })}
				/>
				{(page.keys.length > 1 || page.tags.length > 0 || search.key || search.tag) && (
					<Select
						value={
							search.key
								? `key:${search.key}`
								: search.tag
									? `tag:${search.tag}`
									: "all"
						}
						onValueChange={(v) =>
							go({
								key: v.startsWith("key:") ? v.slice(4) : undefined,
								tag: v.startsWith("tag:") ? v.slice(4) : undefined,
							})
						}
					>
						<SelectTrigger
							aria-label="Sent by"
							className="flex-1 sm:w-48 sm:flex-none"
						>
							<SelectValue>
								{search.key
									? (keyNames.get(search.key) ?? "API key")
									: search.tag
										? search.tag.replace(":", ": ")
										: "Sent by anyone"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent
							align="end"
							className="sm:min-w-56"
						>
							<SelectItem value="all">Sent by anyone</SelectItem>
							{page.keys.length > 0 && (
								<SelectGroup>
									<SelectSeparator />
									<SelectLabel>API key</SelectLabel>
									{page.keys.map((k) => (
										<SelectItem
											key={k.id}
											value={`key:${k.id}`}
										>
											{k.name}
										</SelectItem>
									))}
								</SelectGroup>
							)}
							{(page.tags.length > 0 || search.tag) && (
								<SelectGroup>
									<SelectSeparator />
									<SelectLabel>Tag</SelectLabel>
									{search.tag &&
										!page.tags.some((t) => tagParam(t) === search.tag) && (
											<SelectItem value={`tag:${search.tag}`}>
												{search.tag.replace(":", ": ")}
											</SelectItem>
										)}
									{page.tags.map((t) => (
										<SelectItem
											key={tagParam(t)}
											value={`tag:${tagParam(t)}`}
										>
											<span className="truncate">
												{t.name}: {t.value}
											</span>
											<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
												{t.count.toLocaleString("en-US")}
											</span>
										</SelectItem>
									))}
								</SelectGroup>
							)}
						</SelectContent>
					</Select>
				)}
				<ExportEmails
					search={search}
					keyNames={keyNames}
					disabled={page.data.length === 0}
				/>
			</div>
			{(search.status || chips.length > 0) && (
				<div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
					{search.status && (
						<p className="flex min-w-0 items-center gap-2 text-muted-foreground">
							<StatusDot status={filterDot(search.status)} />
							<span className="font-medium text-foreground">
								{FILTER_INFO[search.status].label}
							</span>
							<span className="truncate">
								{FILTER_INFO[search.status].description}
							</span>
						</p>
					)}
					{chips.map((c) => (
						<button
							key={c.key}
							type="button"
							onClick={() => go({ [c.key]: undefined })}
							className="inline-flex h-6 items-center gap-1 rounded-full bg-muted pr-1.5 pl-2.5 text-xs font-medium shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-accent"
							aria-label={`Remove ${c.label}`}
						>
							{c.label}
							<X className="size-3 text-muted-foreground" />
						</button>
					))}
				</div>
			)}
			{page.summary && (
				<DrillSummary
					summary={page.summary}
					status={search.status}
					onPick={(status) =>
						go({ status: status === search.status ? undefined : status })
					}
				/>
			)}
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
									{filtered ? "No emails match" : "No emails yet"}
								</EmptyTitle>
								<EmptyDescription>
									{filtered
										? "Try another search, or clear the filters."
										: "Send one with the API, over SMTP, or with Send test email."}
								</EmptyDescription>
							</EmptyHeader>
							{filtered && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => navigate({ search: {} })}
								>
									Clear filters
								</Button>
							)}
						</Empty>
					) : (
						<Table className="table-fixed">
							<TableHeader>
								<TableRow>
									<TableHead className="md:w-[36%]">To</TableHead>
									{showOrg && (
										<TableHead className="hidden w-44 lg:table-cell">
											Brand
										</TableHead>
									)}
									<TableHead className="hidden w-40 sm:table-cell">
										Status
									</TableHead>
									<TableHead className="hidden w-44 xl:table-cell">
										Sent by
									</TableHead>
									<TableHead className="hidden md:table-cell">Subject</TableHead>
									<TableHead className="w-14 text-right md:w-20">Sent</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{page.data.map((e) => (
									<TableRow
										key={e.id}
										className="relative cursor-pointer"
									>
										<TableCell className="py-2.5 sm:py-0">
											<Link
												to="/emails/$id"
												params={{ id: e.id }}
												className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
											>
												<Ph>{e.to.join(", ")}</Ph>
											</Link>
											<div className="mt-1 flex min-w-0 items-center gap-2 md:hidden">
												<StatusBadge
													status={shownStatus(e)}
													className="sm:hidden"
												/>
												<span className="truncate text-muted-foreground">
													<Ph>{e.subject}</Ph>
												</span>
											</div>
										</TableCell>
										{showOrg && (
											<TableCell className="hidden lg:table-cell">
												<span className="flex min-w-0 items-center gap-2">
													<OrgAvatar
														name={names.get(e.organization_id) ?? "?"}
														className="size-5 text-[10px]"
													/>
													<span className="truncate text-muted-foreground">
														<Ph>
															{names.get(e.organization_id) ?? "—"}
														</Ph>
													</span>
												</span>
											</TableCell>
										)}
										<TableCell className="hidden sm:table-cell">
											<StatusBadge status={shownStatus(e)} />
										</TableCell>
										<TableCell className="hidden truncate text-muted-foreground xl:table-cell">
											<Ph>{sentBy(e, keyNames)}</Ph>
										</TableCell>
										<TableCell className="hidden truncate text-muted-foreground md:table-cell">
											{whyNot(e) && (
												<span
													data-ph
													className="mr-2 inline-flex h-5 max-w-[60%] items-center truncate rounded-md px-1.5 align-middle text-xs font-medium text-foreground/80 shadow-[inset_0_0_0_1px_var(--border)]"
												>
													{whyNot(e)}
												</span>
											)}
											<Ph>{e.subject}</Ph>
										</TableCell>
										<TableCell
											className="text-right text-muted-foreground tabular-nums"
											title={formatDateTime(
												e.status === "scheduled" ? e.send_at : e.created_at,
											)}
										>
											<Ph>
												{formatAgo(
													e.status === "scheduled"
														? e.send_at
														: e.created_at,
													now,
												)}
											</Ph>
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

/** A tag as the `tag` filter takes it. */
const tagParam = (t: { name: string; value: string }) => `${t.name}:${t.value}`;

/** Which app sent it: its API key's name (each app has its own), or where else it came from. */
function sentBy(e: { source: string; api_key_id: string | null }, keyNames: Map<string, string>) {
	if (e.api_key_id)
		return (
			keyNames.get(e.api_key_id) ??
			(e.source === "smtp" ? "SMTP, deleted key" : "Deleted key")
		);
	if (e.source === "dashboard") return "Mailroom (Send test)";
	if (e.source === "system") return "Mailroom";
	return e.source === "smtp" ? "SMTP" : "—";
}

/**
 * Why an email wasn't delivered, in a few words: the firewall rule or suppression that left its
 * recipient out, the bounce in plain words, or SES's refusal.
 */
function whyNot(e: {
	status: string;
	dropped: Record<string, string> | null;
	error: string | null;
	bounce_type: string | null;
	to: string[];
}) {
	const firewall = Object.values(e.dropped ?? {}).find((r) => r.startsWith("firewall: "));
	if (firewall) return leftOutLabel(firewall).label;
	if (e.status === "suppressed") {
		const first = Object.values(e.dropped ?? {})[0];
		return first ? leftOutLabel(first).label : null;
	}
	if ((e.status === "bounced" || e.status === "soft_bounced") && e.bounce_type)
		return explainBounce({
			type: e.bounce_type.split("/")[0],
			subType: e.bounce_type.split("/")[1],
			message: e.error,
			recipient: e.to.length === 1 ? e.to[0] : null,
		}).title.replace(/^Soft bounce: /, "");
	if (e.status === "failed" && e.error) return e.error.slice(0, 60);
	return null;
}

function ExportEmails({
	search,
	keyNames,
	disabled,
}: {
	search: ReturnType<typeof Route.useSearch>;
	keyNames: Map<string, string>;
	disabled: boolean;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label="Download CSV"
					disabled={disabled || busy}
					onClick={async () => {
						setBusy(true);
						try {
							const { data, brands } = await exportEmailsFn({
								data: {
									status: search.status,
									search: search.q,
									days: search.days,
									day: search.day,
									domain: search.domain,
									provider: search.provider,
									key: search.key,
									tag: search.tag,
									template: search.template,
									brand: search.brand,
								},
							});
							const names = new Map(brands.map((o) => [o.id, o.name]));
							downloadCsv("emails.csv", [
								[
									"id",
									...(brands.length ? ["brand"] : []),
									"created_at",
									"from",
									"to",
									"subject",
									"status",
									"source",
									"api_key",
									"tags",
									"opens",
									"clicks",
								],
								...data.map((e) => [
									e.id,
									...(brands.length
										? [names.get(e.organization_id) ?? e.organization_id]
										: []),
									e.created_at,
									e.from,
									e.to.join(", "),
									e.subject,
									e.status,
									e.source,
									(e.api_key_id && keyNames.get(e.api_key_id)) ??
										e.api_key_id ??
										"",
									(e.tags ?? []).map((t) => `${t.name}:${t.value}`).join("; "),
									e.open_count,
									e.click_count,
								]),
							]);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? <Spinner /> : <Download />}
				</Button>
			</TooltipTrigger>
			<TooltipContent>Download CSV (up to 5,000)</TooltipContent>
		</Tooltip>
	);
}

function SendTest() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [form, setForm] = useState({
		from: "",
		to: "",
		subject: "Hello from Mailroom",
		text: "It works.",
	});
	const set =
		(k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
			setForm({ ...form, [k]: e.target.value });
	async function send(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		try {
			const r = await sendEmailFn({ data: form });
			toast.success(
				r.status === "sent"
					? "Sent"
					: `Email ${statusLabel(r.status ?? "queued").toLowerCase()}`,
			);
			setOpen(false);
			await router.invalidate();
			if (r.id) await router.navigate({ to: "/emails/$id", params: { id: r.id } });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			<DialogTrigger asChild>
				<Button>
					<Send />
					Send test email
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<form
					onSubmit={send}
					className="contents"
				>
					<DialogHeader>
						<DialogTitle>Send a test email</DialogTitle>
						<DialogDescription>
							It goes through SES like any other email and shows up here with its
							events.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="from">From</FieldLabel>
								<Input
									id="from"
									required
									placeholder="Acme <hello@mail.acme.com>"
									value={form.from}
									onChange={set("from")}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="to">To</FieldLabel>
								<Input
									id="to"
									type="email"
									required
									placeholder="you@example.com"
									value={form.to}
									onChange={set("to")}
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="subject">Subject</FieldLabel>
							<Input
								id="subject"
								required
								value={form.subject}
								onChange={set("subject")}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="text">Message</FieldLabel>
							<Textarea
								id="text"
								rows={5}
								value={form.text}
								onChange={set("text")}
							/>
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
							disabled={busy}
						>
							{busy ? <Spinner /> : <Send />}
							Send
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type Summary = NonNullable<Awaited<ReturnType<typeof listEmailsFn>>["summary"]>;

const pct = (n: number, of: number) =>
	of ? `${(Math.round((n / of) * 1000) / 10).toLocaleString("en-US")}%` : "";

/**
 * A drill-down's numbers (a day, domain or provider from Overview): how many of its emails
 * arrived, were opened or clicked, didn't arrive (and why) or got a complaint. Each one narrows
 * the list to those emails; clicking it again shows them all.
 */
function DrillSummary({
	summary,
	status,
	onPick,
}: {
	summary: Summary;
	status: EmailFilterValue | undefined;
	onPick: (status: EmailFilterValue | undefined) => void;
}) {
	const tiles: { key: EmailFilterValue | undefined; label: string; n: number; rate: string }[] = [
		{ key: undefined, label: "All", n: summary.all, rate: "" },
		{
			key: "delivered",
			label: "Delivered",
			n: summary.delivered,
			rate: pct(summary.delivered, summary.all),
		},
		{
			key: "opened",
			label: "Opened",
			n: summary.opened,
			rate: pct(summary.opened, summary.delivered),
		},
		{
			key: "clicked",
			label: "Clicked",
			n: summary.clicked,
			rate: pct(summary.clicked, summary.delivered),
		},
		{
			key: "not_delivered",
			label: "Not delivered",
			n: summary.not_delivered,
			rate: pct(summary.not_delivered, summary.all),
		},
		{
			key: "complained",
			label: "Complained",
			n: summary.complained,
			rate: pct(summary.complained, summary.delivered),
		},
	];
	const kinds = NOT_DELIVERED.filter((k) => summary[k] > 0);
	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-[0_0_0_1px_var(--border)]">
			<div className="grid grid-cols-3 gap-px bg-border sm:grid-cols-6">
				{tiles.map((t) => {
					const active = t.key === status || (!t.key && !status);
					return (
						<button
							key={t.label}
							type="button"
							onClick={() => onPick(t.key)}
							aria-pressed={active}
							className={cn(
								"flex flex-col items-start gap-1 bg-card px-4 py-3 text-left transition-colors outline-none hover:bg-accent focus-visible:bg-accent",
								active && "bg-accent shadow-[inset_0_-2px_0_var(--primary)]",
							)}
						>
							<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
								{t.key && <StatusDot status={filterDot(t.key)} />}
								{t.label}
							</span>
							<span className="flex items-baseline gap-1.5">
								<span className="text-lg font-semibold tabular-nums">
									<Ph>{t.n.toLocaleString("en-US")}</Ph>
								</span>
								{t.rate && (
									<span className="text-xs text-muted-foreground tabular-nums">
										<Ph>{t.rate}</Ph>
									</span>
								)}
							</span>
						</button>
					);
				})}
			</div>
			{kinds.length > 0 && (
				<div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-border px-3 py-2 text-xs">
					<span className="px-1 text-muted-foreground">Not delivered:</span>
					{kinds.map((k) => (
						<button
							key={k}
							type="button"
							onClick={() => onPick(k)}
							aria-pressed={status === k}
							className={cn(
								"inline-flex h-6 items-center gap-1.5 rounded-full px-2 font-medium transition-colors outline-none hover:bg-accent focus-visible:bg-accent",
								status === k && "bg-accent",
							)}
						>
							<StatusDot status={k} />
							{FILTER_INFO[k].label}
							<span className="text-muted-foreground tabular-nums">
								<Ph>{summary[k].toLocaleString("en-US")}</Ph>
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
