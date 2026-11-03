import { createFileRoute, Link } from "@tanstack/react-router";
import { ScrollText, Search } from "lucide-react";
import { z } from "zod";
import { Method } from "@/components/api-drawer";
import { Page, PageHeader, TableCard, TablePager } from "@/components/page";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { StatusCode } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { listLogsFn } from "@/functions/logs";
import { formatAgo, formatDateTime } from "@/lib/format";
import { usePendingSearch } from "@/lib/pending";
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
import { userAgentLabel } from "@/lib/user-agent";

const STATUSES = ["2xx", "4xx", "5xx"] as const;
const PERIODS = [
	{ days: 1, label: "Last 24 hours" },
	{ days: 7, label: "Last 7 days" },
	{ days: 15, label: "Last 15 days" },
] as const;

const LOG_STATUS = {
	all: "All statuses",
	"2xx": "Succeeded",
	"4xx": "Client errors",
	"5xx": "Server errors",
} as const;

export const Route = createFileRoute("/_app/logs/")({
	validateSearch: z.object({
		q: z.string().optional(),
		status: z.enum(STATUSES).optional(),
		key: z.string().optional(),
		days: z.number().int().min(1).max(90).optional(),
		before: z.string().optional(),
	}),
	loaderDeps: ({ search }) => search,
	// New filters keep the page up (and the search box focused): only the rows turn into skeletons.
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) =>
		listLogsFn({
			data: {
				search: deps.q,
				status: deps.status,
				key: deps.key,
				days: deps.days,
				before: deps.before,
			},
		}),
	head: () => ({ meta: [{ title: "Logs · Mailroom" }] }),
	component: Logs,
	pendingComponent: () => (
		<Sketch
			data={{
				retention_days: 30,
				has_more: rememberedRows("logs:more", 0) > 0,
				next: null,
				keys: sample(rememberedRows("logs:keys", 1), (i) => ({
					id: `key-${i}`,
					name: "Production",
				})),
				data: sample(rememberedRows("logs", 20), (i) => ({
					id: `sketch-${i}`,
					method: pick(i, ["POST", "POST", "GET"]),
					path: pick(i, ["/emails", "/emails/batch", "/domains"]),
					status: 200,
					api_key_id: "key-0",
					user_agent: "node",
					created_at: ago(i * 20),
				})),
			}}
		>
			<Logs />
		</Sketch>
	),
});

function Logs() {
	const { data: page, search: current } = usePage(Route);
	const { search, loading } = usePendingSearch(current);
	useRememberRows("logs", loading ? undefined : page.data.length);
	useListed("logs", page.data);
	useRememberRows("logs:keys", page.keys.length);
	useRememberRows("logs:more", loading ? undefined : page.has_more ? 1 : 0);
	const navigate = Route.useNavigate();
	const filtered = Boolean(search.q || search.status || search.key || search.days);
	const keyName = (id: string | null) => page.keys.find((k) => k.id === id)?.name;
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, before: undefined, ...next }, replace: true });
	const now = Date.now();
	return (
		<Page>
			<PageHeader
				title="Logs"
				description={
					<>
						Every call to the API with this organization's keys, kept{" "}
						<Ph>{page.retention_days} days</Ph>.
					</>
				}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<SearchBox
					className="basis-full sm:basis-0"
					placeholder="Search a path or a log id"
					value={search.q ?? ""}
					onChange={(q) => go({ q: q || undefined })}
				/>
				<Select
					value={String(search.days ?? "all")}
					onValueChange={(v) => go({ days: v === "all" ? undefined : Number(v) })}
				>
					<SelectTrigger className="flex-1 sm:w-40 sm:flex-none">
						{/* Labels written out, so the server's first paint has them too. */}
						<SelectValue>
							{PERIODS.find((p) => p.days === search.days)?.label ?? (
								<>
									Last <Ph>{page.retention_days}</Ph> days
								</>
							)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent align="end">
						<SelectItem value="all">
							Last <Ph>{page.retention_days}</Ph> days
						</SelectItem>
						<SelectSeparator />
						{PERIODS.filter((p) => p.days < page.retention_days).map((p) => (
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
						go({ status: v === "all" ? undefined : (v as (typeof STATUSES)[number]) })
					}
				>
					<SelectTrigger className="flex-1 sm:w-36 sm:flex-none">
						<SelectValue>{LOG_STATUS[search.status ?? "all"]}</SelectValue>
					</SelectTrigger>
					<SelectContent align="end">
						<SelectItem value="all">{LOG_STATUS.all}</SelectItem>
						<SelectSeparator />
						<SelectItem value="2xx">{LOG_STATUS["2xx"]}</SelectItem>
						<SelectItem value="4xx">{LOG_STATUS["4xx"]}</SelectItem>
						<SelectItem value="5xx">{LOG_STATUS["5xx"]}</SelectItem>
					</SelectContent>
				</Select>
				{page.keys.length > 1 && (
					<Select
						value={search.key ?? "all"}
						onValueChange={(v) => go({ key: v === "all" ? undefined : v })}
					>
						<SelectTrigger className="flex-1 sm:w-44 sm:flex-none">
							<SelectValue>
								{page.keys.find((k) => k.id === search.key)?.name ?? "All API keys"}
							</SelectValue>
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value="all">All API keys</SelectItem>
							<SelectSeparator />
							{page.keys.map((k) => (
								<SelectItem
									key={k.id}
									value={k.id}
								>
									{k.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}
			</div>
			<TableCard>
				<SketchWhile loading={loading && page.data.length > 0}>
					{loading && page.data.length === 0 ? (
						<RowsPending />
					) : page.data.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									{filtered ? <Search /> : <ScrollText />}
								</EmptyMedia>
								<EmptyTitle>
									{filtered ? "No logs match" : "No API calls yet"}
								</EmptyTitle>
								<EmptyDescription>
									{filtered ? (
										"Try another search, or clear the filters."
									) : (
										<>
											Each call made with an API key shows up here, with what
											it sent and what came back.{" "}
											<Link
												to="/docs"
												className="underline underline-offset-2 hover:text-foreground"
											>
												Send your first one
											</Link>
											.
										</>
									)}
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
									<TableHead>Endpoint</TableHead>
									<TableHead className="w-20">Status</TableHead>
									<TableHead className="hidden w-44 lg:table-cell">
										API key
									</TableHead>
									<TableHead className="hidden w-48 md:table-cell">
										User agent
									</TableHead>
									<TableHead className="w-16 text-right md:w-20">
										Created
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{page.data.map((l) => (
									<TableRow
										key={l.id}
										className="relative cursor-pointer"
									>
										<TableCell className="py-2.5">
											<Link
												to="/logs/$id"
												params={{ id: l.id }}
												className="flex min-w-0 items-center gap-2.5 outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
											>
												<Ph>
													<Method m={l.method} />
												</Ph>
												<span className="truncate font-mono text-[13px]">
													<Ph>{l.path}</Ph>
												</span>
											</Link>
										</TableCell>
										<TableCell>
											<StatusCode code={l.status} />
										</TableCell>
										<TableCell className="hidden truncate text-muted-foreground lg:table-cell">
											<Ph>{keyName(l.api_key_id) ?? "Deleted key"}</Ph>
										</TableCell>
										<TableCell
											className="hidden truncate text-muted-foreground md:table-cell"
											title={l.user_agent ?? undefined}
										>
											<Ph>{userAgentLabel(l.user_agent)}</Ph>
										</TableCell>
										<TableCell
											className="text-right text-muted-foreground tabular-nums"
											title={formatDateTime(l.created_at)}
										>
											<Ph>{formatAgo(l.created_at, now)}</Ph>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{(page.has_more || search.before) && (
						<TablePager
							label={`${page.data.length} ${page.data.length === 1 ? "call" : "calls"}${search.before ? ", older page" : ""}`}
							previousLabel="Newest"
							nextLabel="Older"
							onPrevious={
								search.before
									? () => navigate({ search: { ...search, before: undefined } })
									: undefined
							}
							onNext={
								page.next
									? () =>
											navigate({
												search: {
													...search,
													before: page.next ?? undefined,
												},
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
