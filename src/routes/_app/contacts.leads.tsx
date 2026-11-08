import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Flame, Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { ContactsHeader } from "@/components/contacts-tabs";
import { LEAD, LeadBadge, type LeadLevel } from "@/components/lead-score";
import { Page, TableCard } from "@/components/page";
import { ConditionEditor, newCondition, type RuleOptions } from "@/components/segment-rules";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
import { leadsPageFn, saveLeadScoringFn, segmentOptionsFn } from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useMe } from "@/lib/me";
import { Ph, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";
import type { ScoringRule } from "@/server/lead-score";

export const Route = createFileRoute("/_app/contacts/leads")({
	validateSearch: z.object({
		brand: z.string().optional(),
		level: z.enum(["hot", "warm", "cold"]).optional(),
	}),
	loaderDeps: ({ search }) => search,
	loader: ({ deps }) => leadsPageFn({ data: { brand: deps.brand, level: deps.level } }),
	head: () => ({ meta: [{ title: "Leads · Mailroom" }] }),
	component: LeadsPage,
});

type Data = Awaited<ReturnType<typeof leadsPageFn>>;

function LeadsPage() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, ...next }, replace: true });
	const { counts, scoring } = data;
	const tiles: { level: LeadLevel; n: number; hint: string }[] = [
		{ level: "hot", n: counts.hot, hint: `${scoring.hot}+ points` },
		{ level: "warm", n: counts.warm, hint: `${scoring.warm} to ${scoring.hot - 1} points` },
		{
			level: "cold",
			n: counts.total - counts.hot - counts.warm,
			hint: `Under ${scoring.warm} points`,
		},
	];
	return (
		<Page>
			<ContactsHeader
				current="leads"
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
				Who's most likely to buy, from what they did in the last {scoring.days} days: opens,
				clicks, the events your app sends, purchases, chats and anything a live segment can
				check. Live segments can pick hot leads ("Their lead score").
			</p>
			<div className="grid gap-3 sm:grid-cols-3">
				{tiles.map((t) => (
					<button
						key={t.level}
						type="button"
						onClick={() =>
							go({ level: search.level === t.level ? undefined : t.level })
						}
						className={cn(
							"flex items-center gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-accent/40",
							search.level === t.level && "ring-2 ring-brand",
						)}
					>
						<span
							className={cn(
								"flex size-9 items-center justify-center rounded-lg",
								LEAD[t.level].tone,
							)}
						>
							<Flame className="size-4.5" />
						</span>
						<span>
							<span className="block text-2xl leading-none font-semibold tabular-nums">
								<Ph>{t.n.toLocaleString()}</Ph>
							</span>
							<span className="mt-1 block text-xs text-muted-foreground">
								{LEAD[t.level].label} · {t.hint}
							</span>
						</span>
					</button>
				))}
			</div>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
				<TableCard>
					{data.leads.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Flame />
								</EmptyMedia>
								<EmptyTitle>
									{search.level ? `No ${search.level} leads` : "No points yet"}
								</EmptyTitle>
								<EmptyDescription>
									Contacts score as they open, click, buy, chat or do what your
									rules give points for.
								</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Contact</TableHead>
									<TableHead className="w-28">Lead</TableHead>
									<TableHead className="hidden w-32 sm:table-cell">
										Joined
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.leads.map((l) => (
									<TableRow key={l.id}>
										<TableCell className="max-w-0">
											<Link
												to="/contacts/$id"
												params={{ id: l.id }}
												className="block truncate font-medium hover:underline"
											>
												{l.name ?? l.email}
											</Link>
											{l.name && (
												<span className="block truncate text-xs text-muted-foreground">
													{l.email}
													{l.unsubscribed && " · unsubscribed"}
												</span>
											)}
										</TableCell>
										<TableCell>
											<LeadBadge
												level={l.level}
												score={l.score}
											/>
										</TableCell>
										<TableCell className="hidden text-muted-foreground sm:table-cell">
											{formatAgo(l.created_at)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
				<ScoringCard data={data} />
			</div>
		</Page>
	);
}

type Kind = "opened" | "clicked" | "received" | "event" | "purchase" | "match";

const KIND_LABEL: [Kind, string][] = [
	["opened", "Opened a marketing email"],
	["clicked", "Clicked a marketing email"],
	["received", "Got a marketing email"],
	["event", "Did something in your app"],
	["purchase", "Made a purchase"],
	["match", "Matches a rule"],
];

type MatchCondition = Extract<ScoringRule, { type: "match" }>["condition"];

const kindOf = (r: ScoringRule): Kind => (r.type === "email" ? r.action : r.type);

function newRule(k: Kind, o: RuleOptions | null): ScoringRule {
	if (k === "opened" || k === "clicked" || k === "received")
		return { type: "email", action: k, points: k === "clicked" ? 3 : 1, max: 30 };
	if (k === "event") return { type: "event", name: o?.events[0]?.name ?? "", points: 5, max: 25 };
	if (k === "purchase") return { type: "purchase", points: 15, max: 45 };
	return {
		type: "match",
		condition: (o
			? newCondition("chatted", o)
			: { type: "chatted", days: 90 }) as MatchCondition,
		points: 10,
	};
}

/** Points, -100 to 100; typing "-" first is kept until a digit follows. */
function PointsInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
	const [text, setText] = useState(String(value));
	useEffect(() => {
		setText((t) => (Number.parseInt(t, 10) === value ? t : String(value)));
	}, [value]);
	return (
		<Input
			aria-label="Points"
			inputMode="numeric"
			className="h-8 w-20 text-center tabular-nums"
			value={text}
			onChange={(e) => {
				const t = e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "");
				setText(t);
				const n = Number.parseInt(t, 10);
				if (Number.isFinite(n)) onChange(Math.max(-100, Math.min(100, n)));
			}}
		/>
	);
}

const toInt = (v: string, fallback: number) => {
	const n = Number.parseInt(v, 10);
	return Number.isFinite(n) ? n : fallback;
};

function ScoringCard({ data }: { data: Data }) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [rules, setRules] = useState<ScoringRule[]>(data.scoring.rules);
	const [days, setDays] = useState(String(data.scoring.days));
	const [hot, setHot] = useState(String(data.scoring.hot));
	const [warm, setWarm] = useState(String(data.scoring.warm));
	const [options, setOptions] = useState<RuleOptions | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!editing || options) return;
		segmentOptionsFn({ data: { brand: data.brand } })
			.then((o) => setOptions(o as RuleOptions))
			.catch(() => setOptions(null));
	}, [editing, options, data.brand]);
	const start = () => {
		setRules(data.scoring.rules);
		setDays(String(data.scoring.days));
		setHot(String(data.scoring.hot));
		setWarm(String(data.scoring.warm));
		setEditing(true);
	};
	const save = async (reset = false) => {
		setBusy(true);
		try {
			await saveLeadScoringFn({
				data: {
					brand: data.brand,
					reset,
					scoring: {
						rules,
						days: toInt(days, 90),
						hot: toInt(hot, 50),
						warm: toInt(warm, 20),
					},
				},
			});
			await router.invalidate();
			setEditing(false);
			toast.success(reset ? "Back to the starting rules" : "Lead scoring saved");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	const set = (i: number, r: ScoringRule) => setRules(rules.map((x, j) => (j === i ? r : x)));

	if (!editing)
		return (
			<Card className="gap-4 p-5">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 className="font-semibold">How leads are scored</h2>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{data.scoring.custom ? "Your rules" : "The starting rules"}, over the
							last {data.scoring.days} days. Never below 0.
						</p>
					</div>
					{data.canEdit && (
						<Button
							size="sm"
							variant="outline"
							onClick={start}
						>
							Edit
						</Button>
					)}
				</div>
				<ul className="flex flex-col gap-2 text-sm">
					{data.scoring.rules.map((r, i) => (
						<li
							key={`${i}-${data.labels[i]}`}
							className="flex items-center justify-between gap-3"
						>
							<span className="min-w-0 truncate text-muted-foreground">
								{data.labels[i]}
							</span>
							<span
								className={cn(
									"shrink-0 font-medium tabular-nums",
									r.points < 0 && "text-red-600 dark:text-red-400",
								)}
							>
								{r.points > 0 ? "+" : ""}
								{r.points}
								{r.type !== "match" && (
									<span className="font-normal text-muted-foreground">
										{" "}
										each{"max" in r && r.max ? `, up to ${r.max}` : ""}
									</span>
								)}
							</span>
						</li>
					))}
				</ul>
				<p className="border-t border-border/70 pt-3 text-xs text-muted-foreground">
					Hot from {data.scoring.hot} points, warm from {data.scoring.warm}.
				</p>
			</Card>
		);

	return (
		<Card className="gap-4 p-5">
			<h2 className="font-semibold">How leads are scored</h2>
			<ul className="flex flex-col gap-2">
				{rules.map((r, i) => (
					<li
						key={i}
						className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5"
					>
						<div className="flex items-center gap-2">
							<Select
								value={kindOf(r)}
								onValueChange={(k) => set(i, newRule(k as Kind, options))}
							>
								<SelectTrigger
									aria-label="What scores"
									className="h-8 flex-1"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{KIND_LABEL.map(([k, l]) => (
										<SelectItem
											key={k}
											value={k}
										>
											{l}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-8 shrink-0"
								aria-label="Remove this rule"
								onClick={() => setRules(rules.filter((_, j) => j !== i))}
							>
								<X />
							</Button>
						</div>
						{r.type === "event" && (
							<Input
								aria-label="Event name"
								list="lead-events"
								placeholder="booking.completed"
								className="h-8"
								value={r.name}
								onChange={(e) => set(i, { ...r, name: e.target.value.trim() })}
							/>
						)}
						{r.type === "match" &&
							(options ? (
								<div className="flex flex-wrap items-center gap-2">
									<ConditionEditor
										c={r.condition}
										set={(c) => set(i, { ...r, condition: c } as ScoringRule)}
										options={options}
										exclude={["engagement", "lead_score"]}
									/>
								</div>
							) : (
								<Spinner className="size-4" />
							))}
						<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
							<PointsInput
								value={r.points}
								onChange={(points) => set(i, { ...r, points })}
							/>
							<span>points{r.type === "match" ? "" : " each, up to"}</span>
							{r.type !== "match" && (
								<Input
									aria-label="Up to"
									inputMode="numeric"
									className="h-8 w-20 text-center tabular-nums"
									value={r.max === undefined ? "" : String(r.max)}
									placeholder="no limit"
									onChange={(e) => {
										const n = Number.parseInt(e.target.value, 10);
										set(i, {
											...r,
											max: Number.isFinite(n) && n > 0 ? n : undefined,
										});
									}}
								/>
							)}
						</div>
					</li>
				))}
			</ul>
			<datalist id="lead-events">
				{options?.events.map((e) => (
					<option
						key={e.name}
						value={e.name}
					/>
				))}
			</datalist>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="self-start"
				disabled={rules.length >= 30}
				onClick={() => setRules([...rules, newRule("event", options)])}
			>
				<Plus />
				Add a rule
			</Button>
			<div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
				<label
					htmlFor="ls-days"
					className="flex flex-col gap-1"
				>
					Last days
					<Input
						id="ls-days"
						inputMode="numeric"
						className="h-8"
						value={days}
						onChange={(e) => setDays(e.target.value)}
					/>
				</label>
				<label
					htmlFor="ls-warm"
					className="flex flex-col gap-1"
				>
					Warm from
					<Input
						id="ls-warm"
						inputMode="numeric"
						className="h-8"
						value={warm}
						onChange={(e) => setWarm(e.target.value)}
					/>
				</label>
				<label
					htmlFor="ls-hot"
					className="flex flex-col gap-1"
				>
					Hot from
					<Input
						id="ls-hot"
						inputMode="numeric"
						className="h-8"
						value={hot}
						onChange={(e) => setHot(e.target.value)}
					/>
				</label>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
				<Button
					disabled={busy}
					onClick={() => save()}
				>
					{busy && <Spinner />}
					Save
				</Button>
				<Button
					variant="outline"
					onClick={() => setEditing(false)}
				>
					Cancel
				</Button>
				{data.scoring.custom && (
					<Button
						variant="ghost"
						className="ml-auto"
						disabled={busy}
						onClick={() => save(true)}
					>
						<RotateCcw />
						Starting rules
					</Button>
				)}
			</div>
		</Card>
	);
}
