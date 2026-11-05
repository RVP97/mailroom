import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { BellOff, Snowflake, Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { ContactsHeader } from "@/components/contacts-tabs";
import { LEVEL, type Level } from "@/components/engagement";
import { ListSelect } from "@/components/list-dialogs";
import { Page, TableCard } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Select,
	SelectContent,
	SelectItem,
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
import { cleanUpFn, engagementPageFn } from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/contacts/engagement")({
	validateSearch: z.object({
		brand: z.string().optional(),
		min: z.number().int().optional(),
		days: z.number().int().optional(),
	}),
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) =>
		engagementPageFn({
			data: { brand: deps.brand, min_emails: deps.min ?? 5, days: deps.days ?? 90 },
		}),
	head: () => ({ meta: [{ title: "Engagement · Mailroom" }] }),
	component: EngagementPage,
	pendingComponent: EngagementSketch,
});

type Data = Awaited<ReturnType<typeof engagementPageFn>>;

function EngagementSketch() {
	return (
		<Sketch
			data={
				{
					brand: "",
					brands: [],
					overview: {
						total: 0,
						levels: { champion: 0, engaged: 0, cooling: 0, cold: 0, new: 0 },
						open_rate: null,
						click_rate: null,
						window_days: 90,
					},
					cold: [],
					coldCount: 0,
					segments: [],
				} satisfies Data
			}
		>
			<EngagementPage />
		</Sketch>
	);
}

const ORDER: Level[] = ["champion", "engaged", "cooling", "cold", "new"];
const pct = (n: number | null) => (n === null ? "–" : `${(n * 100).toFixed(1)}%`);

function EngagementPage() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const { overview: o } = data;
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, ...next }, replace: true });

	return (
		<Page>
			<ContactsHeader
				current="engagement"
				brand={search.brand}
				filters={
					<BrandFilter
						brands={me.brands}
						value={search.brand}
						all={null}
						onChange={(b) => go({ brand: b })}
					/>
				}
			/>
			<p className="-mt-2 max-w-3xl text-sm text-muted-foreground">
				How much each contact opens and clicks what you send them, from the last 90 days of
				broadcasts and automations. Clean out the ones who stopped reading to keep your
				sending reputation up.
			</p>

			<Card className="gap-0 p-0">
				<div className="grid gap-px overflow-hidden rounded-t-xl bg-border/70 sm:grid-cols-3">
					{(
						[
							["Subscribed contacts", o.total.toLocaleString()],
							["Open rate", pct(o.open_rate)],
							["Click rate", pct(o.click_rate)],
						] as const
					).map(([k, v]) => (
						<div
							key={k}
							className="flex flex-col gap-1 bg-card px-5 py-4"
						>
							<span className="text-xs text-muted-foreground">{k}</span>
							<span className="text-2xl font-semibold tabular-nums">
								<Ph>{v}</Ph>
							</span>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-5 border-t border-border/70 px-5 py-5">
					<div
						className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
						role="img"
						aria-label="Contacts by engagement"
					>
						{ORDER.map((l) =>
							o.levels[l] ? (
								<span
									key={l}
									className={cn(
										"h-full first:rounded-l-full last:rounded-r-full",
										LEVEL[l].bar,
									)}
									style={{
										width: `${(o.levels[l] / Math.max(1, o.total)) * 100}%`,
									}}
									title={`${LEVEL[l].label}: ${o.levels[l]}`}
								/>
							) : null,
						)}
					</div>
					<ul className="grid gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
						{ORDER.map((l) => (
							<li
								key={l}
								className="flex flex-col gap-1"
							>
								<span className="flex items-center gap-2 text-sm font-medium">
									<span className={cn("size-2 rounded-full", LEVEL[l].bar)} />
									{LEVEL[l].label}
								</span>
								<span className="flex items-baseline gap-1.5">
									<span className="text-xl font-semibold tabular-nums">
										<Ph>{o.levels[l].toLocaleString()}</Ph>
									</span>
									<span className="text-xs text-muted-foreground tabular-nums">
										{o.total
											? `${Math.round((o.levels[l] / o.total) * 100)}%`
											: ""}
									</span>
								</span>
								<span className="text-xs text-muted-foreground">
									{LEVEL[l].hint}
								</span>
							</li>
						))}
					</ul>
				</div>
			</Card>

			<Cleanup />
		</Page>
	);
}

function Cleanup() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "contacts:delete");
	const min = search.min ?? 5;
	const days = search.days ?? 90;
	const [segment, setSegment] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<"unsubscribe" | "delete" | null>(null);
	const n = data.coldCount;
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, ...next }, replace: true });

	const act = async (action: "segment" | "unsubscribe" | "delete") => {
		setBusy(action);
		try {
			const res = await cleanUpFn({
				data: {
					brand: search.brand,
					min_emails: min,
					days,
					action,
					segment_id: action === "segment" ? segment : null,
				},
			});
			const who = `${res.count.toLocaleString()} ${res.count === 1 ? "contact" : "contacts"}`;
			toast.success(
				action === "segment"
					? `${who} added to ${data.segments.find((s) => s.id === segment)?.name ?? "the segment"}`
					: action === "unsubscribe"
						? `${who} unsubscribed`
						: `${who} deleted`,
			);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	return (
		<section className="flex flex-col gap-4">
			<Card className="gap-0 p-0">
				<div className="flex flex-col gap-4 px-5 py-5">
					<div className="flex items-start gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-400">
							<Snowflake className="size-[18px]" />
						</span>
						<div className="min-w-0">
							<h2 className="font-semibold">Clean up cold contacts</h2>
							<p className="mt-0.5 text-sm text-muted-foreground">
								Sending to people who never open tells Gmail and Outlook your email
								isn't wanted. Send them a last “Still want these?” email first, then
								unsubscribe whoever stays quiet.
							</p>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
						<span>Contacts who got at least</span>
						<Select
							value={String(min)}
							onValueChange={(v) => go({ min: Number(v) })}
						>
							<SelectTrigger
								size="sm"
								aria-label="Emails"
								className="w-auto"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[3, 5, 10, 20].map((v) => (
									<SelectItem
										key={v}
										value={String(v)}
									>
										{v} emails
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span>in the last</span>
						<Select
							value={String(days)}
							onValueChange={(v) => go({ days: Number(v) })}
						>
							<SelectTrigger
								size="sm"
								aria-label="Days"
								className="w-auto"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[30, 60, 90, 180, 365].map((v) => (
									<SelectItem
										key={v}
										value={String(v)}
									>
										{v} days
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span>and opened or clicked none of them.</span>
					</div>
				</div>
				<div className="flex flex-wrap items-center justify-between gap-4 border-t border-border/70 bg-muted/40 px-5 py-4">
					<p className="flex items-baseline gap-2">
						<span className="text-2xl font-semibold tabular-nums">
							<Ph>{n.toLocaleString()}</Ph>
						</span>
						<span className="text-sm text-muted-foreground">
							cold {n === 1 ? "contact" : "contacts"}
						</span>
					</p>
					{canManage && (
						<div className="flex flex-wrap items-center gap-2">
							<div className="flex items-center gap-2">
								<ListSelect
									kind="segment"
									ariaLabel="Segment"
									brand={search.brand ?? (data.brand || null)}
									canCreate
									value={segment}
									onChange={setSegment}
									items={data.segments}
									none="Pick a segment"
									noneDisabled
								/>
								<Button
									variant="outline"
									disabled={!n || !segment || !!busy}
									onClick={() => act("segment")}
								>
									{busy === "segment" ? <Spinner /> : <UserPlus />}
									Add to segment
								</Button>
							</div>
							<Button
								variant="outline"
								disabled={!n || !!busy}
								onClick={() => setConfirm("unsubscribe")}
							>
								<BellOff />
								Unsubscribe
							</Button>
							<Button
								variant="outline"
								className="text-destructive hover:text-destructive"
								disabled={!n || !!busy}
								onClick={() => setConfirm("delete")}
							>
								<Trash2 />
								Delete
							</Button>
						</div>
					)}
				</div>
			</Card>
			<Confirm
				open={confirm !== null}
				onOpenChange={(v) => !v && setConfirm(null)}
				title={
					confirm === "delete"
						? `Delete ${n.toLocaleString()} cold ${n === 1 ? "contact" : "contacts"}?`
						: `Unsubscribe ${n.toLocaleString()} cold ${n === 1 ? "contact" : "contacts"}?`
				}
				description={
					confirm === "delete"
						? "They're gone from this brand, with their segments and properties. Emails already sent stay in the log. This can't be undone."
						: "They stop getting broadcasts and automation emails. You can subscribe any of them again from their page."
				}
				action={confirm === "delete" ? "Delete them" : "Unsubscribe them"}
				onConfirm={() => act(confirm ?? "unsubscribe")}
			/>

			{n > 0 && (
				<TableCard>
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Contact</TableHead>
								<TableHead className="w-28 text-right">Emails got</TableHead>
								<TableHead className="hidden w-36 text-right sm:table-cell">
									Last sent
								</TableHead>
								<TableHead className="hidden w-28 text-right sm:table-cell">
									Added
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.cold.map((c) => (
								<TableRow
									key={c.id}
									className="relative"
								>
									<TableCell className="h-12">
										<Link
											to="/contacts/$id"
											params={{ id: c.id }}
											search={{ brand: search.brand }}
											className="block truncate font-medium outline-none after:absolute after:inset-0"
										>
											<Ph>{c.email}</Ph>
										</Link>
										{(c.first_name || c.last_name) && (
											<span className="block truncate text-xs text-muted-foreground">
												{[c.first_name, c.last_name]
													.filter(Boolean)
													.join(" ")}
											</span>
										)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{c.sent}
									</TableCell>
									<TableCell
										className="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
										title={
											c.last_sent_at
												? formatDateTime(c.last_sent_at)
												: undefined
										}
									>
										{c.last_sent_at ? formatAgo(c.last_sent_at) : "–"}
									</TableCell>
									<TableCell
										className="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
										title={formatDateTime(c.created_at)}
									>
										{formatAgo(c.created_at)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					{n > data.cold.length && (
						<p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
							Showing {data.cold.length} of {n.toLocaleString()}. Actions apply to all
							of them.
						</p>
					)}
				</TableCard>
			)}
		</section>
	);
}
