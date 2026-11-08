import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { CalendarDays, ChevronLeft, ChevronRight, Flag, Newspaper, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { createBroadcastFn } from "@/functions/broadcasts";
import { calendarFn, planBroadcastFn } from "@/functions/calendar";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

/** The weeks shown for a month: Monday of its first week to Sunday of its last. */
function monthSpan(month: string) {
	const [y, m] = month.split("-").map(Number) as [number, number];
	const first = new Date(Date.UTC(y, m - 1, 1));
	const last = new Date(Date.UTC(y, m, 0));
	const start = new Date(first);
	start.setUTCDate(1 - ((first.getUTCDay() + 6) % 7));
	const end = new Date(last);
	end.setUTCDate(last.getUTCDate() + (6 - ((last.getUTCDay() + 6) % 7)));
	const days: string[] = [];
	for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1))
		days.push(d.toISOString().slice(0, 10));
	return { from: days[0] as string, to: days[days.length - 1] as string, days };
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const shift = (month: string, n: number) => {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

export const Route = createFileRoute("/_app/calendar")({
	validateSearch: z.object({
		month: z
			.string()
			.regex(/^\d{4}-\d{2}$/)
			.optional(),
		brand: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({ month: search.month, brand: search.brand }),
	loader: ({ deps }) => {
		const { from, to } = monthSpan(deps.month ?? thisMonth());
		return calendarFn({ data: { from, to, brand: deps.brand } });
	},
	head: () => ({ meta: [{ title: "Calendar · Mailroom" }] }),
	component: CalendarPage,
});

type Data = Awaited<ReturnType<typeof calendarFn>>;
type Item = Data["items"][number];

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const STATE_LABEL: Record<Item["state"], string> = {
	sent: "Sent",
	sending: "Sending",
	scheduled: "Scheduled",
	planned: "Planned",
};

const chipTone: Record<Item["state"], string> = {
	sent: "border-transparent bg-muted text-muted-foreground",
	sending: "border-transparent bg-sky-500/15 text-sky-800 dark:text-sky-300",
	scheduled: "border-transparent bg-brand/15 text-foreground",
	planned: "border-dashed border-foreground/30 bg-background text-foreground",
};

/** Campaign colors, by position. */
const BARS = ["bg-violet-500", "bg-amber-500", "bg-emerald-500", "bg-rose-500", "bg-sky-500"];

/** Today in the deployment's zone. */
const todayIn = (tz: string) =>
	new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());

const dayLabel = (day: string, o: Intl.DateTimeFormatOptions) =>
	new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...o }).format(
		new Date(`${day}T12:00:00Z`),
	);

function Chip({
	item,
	draggable,
	onDragStart,
}: {
	item: Item;
	draggable: boolean;
	onDragStart: (id: string) => void;
}) {
	return (
		<Link
			to="/broadcasts/$id"
			params={{ id: item.id }}
			draggable={draggable}
			onDragStart={(e) => {
				e.dataTransfer.setData("text/plain", item.id);
				e.dataTransfer.effectAllowed = "move";
				onDragStart(item.id);
			}}
			title={`${STATE_LABEL[item.state]}${item.time ? ` at ${item.time}` : ""}: ${item.name}${item.brand ? ` (${item.brand})` : ""}`}
			className={cn(
				"flex items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs leading-5 transition-colors hover:brightness-95",
				chipTone[item.state],
				draggable && "cursor-grab active:cursor-grabbing",
			)}
		>
			{item.newsletter ? (
				<Newspaper className="size-3 shrink-0 opacity-70" />
			) : item.state === "scheduled" || item.state === "sending" ? (
				<span className="size-1.5 shrink-0 rounded-full bg-brand" />
			) : null}
			{item.time && <span className="shrink-0 tabular-nums opacity-70">{item.time}</span>}
			<span className="truncate">{item.name}</span>
		</Link>
	);
}

function PlanDialog({
	day,
	data,
	brand,
	onClose,
}: {
	day: string | null;
	data: Data;
	brand: string | undefined;
	onClose: () => void;
}) {
	const router = useRouter();
	const [name, setName] = useState("");
	const [pickBrand, setPickBrand] = useState<string | undefined>(brand);
	const [newsletter, setNewsletter] = useState("none");
	const [campaign, setCampaign] = useState("none");
	const [busy, setBusy] = useState(false);
	const [on, setOn] = useState(day ?? "");
	useEffect(() => {
		if (day) {
			setOn(day);
			setName("");
			setNewsletter("none");
			setCampaign("none");
			setPickBrand(brand);
		}
	}, [day, brand]);
	const own = pickBrand ?? data.brands[0]?.id;
	const newsletters = data.newsletters.filter((n) => n.brand === own);
	const campaigns = data.campaign_choices.filter((c) => c.brand === own);
	return (
		<Dialog
			open={!!day}
			onOpenChange={(o) => !o && onClose()}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) {
							toast.error("Pick a day");
							return;
						}
						setBusy(true);
						try {
							const { id } = await createBroadcastFn({
								data: {
									brand: own,
									name: name.trim() || null,
									planned_on: on,
									newsletter: newsletter === "none" ? null : newsletter,
									campaign: campaign === "none" ? null : campaign,
								},
							});
							await router.invalidate();
							onClose();
							toast.success("Planned on the calendar", {
								action: {
									label: "Write it",
									onClick: () =>
										router.navigate({ to: "/broadcasts/$id", params: { id } }),
								},
							});
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Plan an email</DialogTitle>
						<DialogDescription>
							A draft on that day. Nothing goes out until you schedule or send it.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="plan-name">What it's about</FieldLabel>
							<Input
								id="plan-name"
								autoFocus
								placeholder="Weekend offer"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="plan-day">Day</FieldLabel>
							<Input
								id="plan-day"
								type="date"
								value={on}
								onChange={(e) => setOn(e.target.value)}
							/>
						</Field>
						{data.brands.length > 1 && (
							<Field>
								<FieldLabel>Brand</FieldLabel>
								<BrandFilter
									brands={data.brands}
									value={own}
									all={null}
									onChange={(b) => {
										setPickBrand(b);
										setNewsletter("none");
										setCampaign("none");
									}}
									className="w-full sm:w-full"
								/>
							</Field>
						)}
						{newsletters.length > 0 && (
							<Field>
								<FieldLabel>Newsletter</FieldLabel>
								<Select
									value={newsletter}
									onValueChange={setNewsletter}
								>
									<SelectTrigger
										aria-label="Newsletter"
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											Not an issue (a one-off email)
										</SelectItem>
										{newsletters.map((n) => (
											<SelectItem
												key={n.id}
												value={n.id}
											>
												An issue of {n.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						)}
						{campaigns.length > 0 && (
							<Field>
								<FieldLabel>Campaign</FieldLabel>
								<Select
									value={campaign}
									onValueChange={setCampaign}
								>
									<SelectTrigger
										aria-label="Campaign"
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">No campaign</SelectItem>
										{campaigns.map((c) => (
											<SelectItem
												key={c.id}
												value={c.id}
											>
												{c.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy}
						>
							{busy && <Spinner />}
							Plan it
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function CalendarPage() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const month = search.month ?? thisMonth();
	const { days } = useMemo(() => monthSpan(month), [month]);
	const today = todayIn(data.timezone);
	const [moved, setMoved] = useState<Record<string, string>>({});
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<string | null>(null);
	const [planning, setPlanning] = useState<string | null>(null);
	// A move shows at once; the server's answer replaces it.
	const items = data.items.map((x) => (moved[x.id] ? { ...x, day: moved[x.id] as string } : x));
	const byDay = new Map<string, Item[]>();
	for (const x of items) byDay.set(x.day, [...(byDay.get(x.day) ?? []), x]);
	const campaignsOn = (day: string) =>
		data.campaigns
			.map((c, i) => ({ ...c, color: BARS[i % BARS.length] as string }))
			.filter((c) => c.starts_on <= day && c.ends_on >= day);
	const go = (m: string) => navigate({ search: { ...search, month: m } });
	const drop = async (day: string) => {
		const id = dragging;
		setDragging(null);
		setOver(null);
		const x = items.find((i) => i.id === id);
		if (!id || !x || x.state !== "planned" || x.day === day) return;
		if (day < today) {
			toast.error("Plan it for today or a day ahead");
			return;
		}
		setMoved((m) => ({ ...m, [id]: day }));
		const settle = () =>
			setMoved((m) => {
				const { [id]: _, ...rest } = m;
				return rest;
			});
		try {
			await planBroadcastFn({ data: { id, planned_on: day } });
			await router.invalidate();
			settle();
		} catch (error) {
			settle();
			toast.error(await errorMessage(error));
		}
	};
	const monthName = dayLabel(`${month}-01`, { month: "long", year: "numeric" });
	const counts = {
		sent: items.filter((x) => x.state === "sent" && x.day.startsWith(month)).length,
		scheduled: items.filter((x) => x.state === "scheduled").length,
		planned: items.filter((x) => x.state === "planned").length,
	};
	const agenda = days.filter((d) => d.startsWith(month) && (byDay.get(d)?.length ?? 0) > 0);
	return (
		<Page>
			<PlanDialog
				day={planning}
				data={data}
				brand={search.brand}
				onClose={() => setPlanning(null)}
			/>
			<PageHeader
				title="Calendar"
				description="Every broadcast and newsletter issue on its day: what went out, what's scheduled and the drafts you've planned. Drag a planned draft to move it; campaigns run along the days they cover."
			/>
			<div className="flex flex-wrap items-center gap-2">
				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="icon"
						aria-label="Previous month"
						onClick={() => go(shift(month, -1))}
					>
						<ChevronLeft />
					</Button>
					<Button
						variant="outline"
						size="icon"
						aria-label="Next month"
						onClick={() => go(shift(month, 1))}
					>
						<ChevronRight />
					</Button>
				</div>
				<h2 className="text-lg font-semibold capitalize">{monthName}</h2>
				{month !== thisMonth() && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => go(thisMonth())}
					>
						Today
					</Button>
				)}
				<div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
					<span>{counts.sent} sent</span>
					<span>{counts.scheduled} scheduled</span>
					<span>{counts.planned} planned</span>
					<BrandFilter
						brands={data.brands}
						value={search.brand}
						onChange={(b) =>
							navigate({ search: { ...search, brand: b }, replace: true })
						}
					/>
				</div>
			</div>
			{data.campaigns.length > 0 && (
				<div className="flex flex-wrap gap-3 text-xs">
					{data.campaigns.map((c, i) => (
						<Link
							key={c.id}
							to="/campaigns/$id"
							params={{ id: c.id }}
							className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
						>
							<span className={cn("h-1.5 w-4 rounded-full", BARS[i % BARS.length])} />
							{c.name}
							{c.brand && <span className="opacity-70">· {c.brand}</span>}
						</Link>
					))}
				</div>
			)}
			<Card className="hidden gap-0 overflow-hidden p-0 sm:block">
				<div className="grid grid-cols-7 border-b bg-muted/40 text-xs font-medium text-muted-foreground">
					{WEEKDAYS.map((d) => (
						<div
							key={d}
							className="px-2 py-1.5"
						>
							{d}
						</div>
					))}
				</div>
				<div className="grid grid-cols-7">
					{days.map((day, i) => {
						const list = byDay.get(day) ?? [];
						const inMonth = day.startsWith(month);
						const bars = campaignsOn(day);
						return (
							<div
								key={day}
								onDragOver={(e) => {
									if (!dragging) return;
									e.preventDefault();
									setOver(day);
								}}
								onDragLeave={() => setOver((o) => (o === day ? null : o))}
								onDrop={(e) => {
									e.preventDefault();
									drop(day);
								}}
								className={cn(
									"group relative flex min-h-28 flex-col gap-1 border-b p-1.5",
									i % 7 !== 6 && "border-r",
									!inMonth && "bg-muted/30",
									over === day && "bg-brand/10 ring-2 ring-brand ring-inset",
								)}
							>
								<div className="flex items-center justify-between">
									<span
										className={cn(
											"flex size-6 items-center justify-center rounded-full text-xs tabular-nums",
											!inMonth && "text-muted-foreground",
											day === today &&
												"bg-brand font-semibold text-brand-foreground",
										)}
									>
										{Number(day.slice(8))}
									</span>
									{data.canEdit && day >= today && (
										<button
											type="button"
											aria-label={`Plan an email on ${day}`}
											onClick={() => setPlanning(day)}
											className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-accent focus-visible:opacity-100"
										>
											<Plus className="size-3.5" />
										</button>
									)}
								</div>
								{bars.length > 0 && (
									<div className="flex flex-col gap-0.5">
										{bars.map((c) => (
											<div
												key={c.id}
												title={c.name}
												className={cn(
													"h-1 rounded-full opacity-80",
													c.color,
													c.starts_on === day && "ml-1",
													c.ends_on === day && "mr-1",
												)}
											/>
										))}
									</div>
								)}
								{list.map((x) => (
									<Chip
										key={x.id}
										item={x}
										draggable={data.canEdit && x.state === "planned"}
										onDragStart={setDragging}
									/>
								))}
							</div>
						);
					})}
				</div>
			</Card>
			<div className="flex flex-col gap-3 sm:hidden">
				{agenda.length === 0 && (
					<Card className="items-center gap-2 p-8 text-center text-sm text-muted-foreground">
						<CalendarDays className="size-5" />
						Nothing on the calendar this month.
					</Card>
				)}
				{agenda.map((day) => (
					<Card
						key={day}
						className="gap-2 p-3"
					>
						<div className="flex items-center justify-between text-sm font-medium">
							<span className={cn(day === today && "text-brand")}>
								{dayLabel(day, { weekday: "long", day: "numeric", month: "short" })}
							</span>
						</div>
						{campaignsOn(day).map((c) => (
							<div
								key={c.id}
								className="flex items-center gap-1.5 text-xs text-muted-foreground"
							>
								<Flag className="size-3" />
								{c.name}
							</div>
						))}
						{(byDay.get(day) ?? []).map((x) => (
							<Chip
								key={x.id}
								item={x}
								draggable={false}
								onDragStart={() => {}}
							/>
						))}
					</Card>
				))}
				{data.canEdit && (
					<Button
						variant="outline"
						onClick={() => setPlanning(today)}
					>
						<Plus />
						Plan an email
					</Button>
				)}
			</div>
			<p className="text-xs text-muted-foreground">Days and times are in {data.timezone}.</p>
		</Page>
	);
}
