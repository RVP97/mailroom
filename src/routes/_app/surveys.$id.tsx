import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ClipboardCheck,
	Copy,
	ExternalLink,
	Inbox,
	Mail,
	MessageCircle,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm } from "@/components/confirm";
import { SwitchRow } from "@/components/design-controls";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { deleteSurveyFn, saveSurveyFn, surveyPageFn } from "@/functions/surveys";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { cn } from "@/lib/utils";

const PERIODS = { "30": 30, "90": 90, all: null } as const;

export const Route = createFileRoute("/_app/surveys/$id")({
	validateSearch: z.object({ period: z.enum(["30", "90", "all"]).optional() }),
	loaderDeps: ({ search }) => ({ period: search.period ?? "90" }),
	loader: ({ params, deps }) =>
		surveyPageFn({ data: { id: params.id, days: PERIODS[deps.period] } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.survey.name ?? "Survey"} · Mailroom` }],
	}),
	component: SurveyPage,
});

type Data = Awaited<ReturnType<typeof surveyPageFn>>;
type Survey = Data["survey"];

type Form = {
	name: string;
	question: string;
	options: string[];
	low_label: string;
	high_label: string;
	comment_prompt: string;
	thanks: string;
};

const formOf = (s: Survey): Form => ({
	name: s.name,
	question: s.question,
	options: s.options,
	low_label: s.low_label ?? "",
	high_label: s.high_label ?? "",
	comment_prompt: s.comment_prompt ?? "",
	thanks: s.thanks,
});

const KIND = { nps: "NPS", csat: "Satisfaction", choice: "Choice" } as const;
const SOURCE: Record<string, string> = {
	email: "Email",
	web: "Web page",
	chat: "Chat",
	conversation: "After support",
};
const GROUP_TONE: Record<string, string> = {
	promoter: "bg-emerald-500",
	passive: "bg-amber-400",
	detractor: "bg-red-500",
};

/** The score up top: NPS, % satisfied, or the most picked answer. */
function Headline({ s, r }: { s: Survey; r: Data["results"] }) {
	if (!r.total)
		return <p className="text-sm text-muted-foreground">No answers in this period yet.</p>;
	if (s.kind === "nps") {
		const parts = [
			["promoter", r.promoters, "Promoters (9-10)"],
			["passive", r.passives, "Passives (7-8)"],
			["detractor", r.detractors, "Detractors (0-6)"],
		] as const;
		return (
			<div className="flex flex-col gap-4">
				<div className="flex items-baseline gap-3">
					<span className="text-4xl font-semibold tabular-nums">
						{Number(r.nps) > 0 ? "+" : ""}
						{r.nps}
					</span>
					<span className="text-sm text-muted-foreground">
						NPS from {r.total.toLocaleString()} {r.total === 1 ? "answer" : "answers"}
					</span>
				</div>
				<div className="flex h-2.5 overflow-hidden rounded-full bg-muted">
					{parts.map(([g, n]) => (
						<span
							key={g}
							className={GROUP_TONE[g]}
							style={{ width: `${(Number(n) / r.total) * 100}%` }}
						/>
					))}
				</div>
				<div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
					{parts.map(([g, n, label]) => (
						<span
							key={g}
							className="flex items-center gap-1.5"
						>
							<span className={cn("size-2 rounded-full", GROUP_TONE[g])} />
							{label}: {Number(n).toLocaleString()}
						</span>
					))}
				</div>
			</div>
		);
	}
	if (s.kind === "csat")
		return (
			<div className="flex items-baseline gap-3">
				<span className="text-4xl font-semibold tabular-nums">{r.satisfied_pct}%</span>
				<span className="text-sm text-muted-foreground">
					satisfied (4 or 5) · {r.average} average · {r.total.toLocaleString()}{" "}
					{r.total === 1 ? "answer" : "answers"}
				</span>
			</div>
		);
	return (
		<div className="flex items-baseline gap-3">
			<span className="truncate text-2xl font-semibold">{r.top}</span>
			<span className="text-sm text-muted-foreground">
				most picked · {r.total.toLocaleString()} {r.total === 1 ? "answer" : "answers"}
			</span>
		</div>
	);
}

function Distribution({ s, r }: { s: Survey; r: Data["results"] }) {
	const max = Math.max(1, ...r.distribution.map((d) => d.count));
	if (s.kind === "choice")
		return (
			<ul className="flex flex-col gap-2.5">
				{r.distribution.map((d) => (
					<li
						key={d.value}
						className="flex flex-col gap-1"
					>
						<span className="flex justify-between text-sm">
							<span className="truncate">{d.label}</span>
							<span className="tabular-nums text-muted-foreground">
								{d.count} · {d.pct}%
							</span>
						</span>
						<span className="h-2 overflow-hidden rounded-full bg-muted">
							<span
								className="block h-full rounded-full bg-brand"
								style={{ width: `${(d.count / max) * 100}%` }}
							/>
						</span>
					</li>
				))}
			</ul>
		);
	return (
		<div className="flex h-36 items-end gap-1.5">
			{r.distribution.map((d) => {
				const g =
					s.kind === "nps"
						? d.value >= 9
							? "promoter"
							: d.value >= 7
								? "passive"
								: "detractor"
						: d.value >= 4
							? "promoter"
							: d.value === 3
								? "passive"
								: "detractor";
				return (
					<div
						key={d.value}
						className="flex h-full flex-1 flex-col items-center justify-end gap-1"
						title={`${d.label}: ${d.count} (${d.pct}%)`}
					>
						<span className="text-[10px] tabular-nums text-muted-foreground">
							{d.count || ""}
						</span>
						<span
							className={cn(
								"w-full rounded-t-sm",
								d.count ? GROUP_TONE[g] : "bg-muted",
							)}
							style={{ height: `${Math.max(3, (d.count / max) * 100)}%` }}
						/>
						<span className="text-xs tabular-nums">{d.label}</span>
					</div>
				);
			})}
		</div>
	);
}

function Places({ data }: { data: Data }) {
	const s = data.survey;
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(s.url);
			toast.success("Link copied");
		} catch {
			toast.error("Couldn't copy; select the link instead");
		}
	};
	const rows = [
		{
			icon: Mail,
			title: "In an email",
			body: (
				<>
					Add the <b>Survey</b> block in the email editor (broadcasts, templates,
					automations) and pick this survey. Each answer link is signed for its contact.
				</>
			),
		},
		{
			icon: ExternalLink,
			title: "On a web page",
			body: (
				<span className="flex min-w-0 items-center gap-2">
					<code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
						{s.url}
					</code>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 shrink-0"
						aria-label="Copy link"
						onClick={copy}
					>
						<Copy />
					</Button>
				</span>
			),
		},
		{
			icon: MessageCircle,
			title: "When a chat ends",
			body: (
				<>
					Pick it in your{" "}
					<Link
						to="/received/chat"
						className="underline"
					>
						website chat
					</Link>
					's settings, under “When a chat ends”.
				</>
			),
		},
		{
			icon: Inbox,
			title: "After a support conversation",
			body: (
				<>
					Pick it in an inbox's workflow, on the Ratings tab.{" "}
					<Link
						to="/received/inboxes"
						className="underline"
					>
						Inboxes
					</Link>
				</>
			),
		},
	];
	return (
		<Card className="gap-0 p-0">
			<div className="border-b border-border/70 px-5 py-4">
				<h2 className="font-medium">Where to ask it</h2>
			</div>
			<ul className="divide-y">
				{rows.map((r) => (
					<li
						key={r.title}
						className="flex gap-3 px-5 py-3.5"
					>
						<r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
						<div className="min-w-0 text-sm">
							<p className="font-medium">{r.title}</p>
							<div className="text-muted-foreground">{r.body}</div>
						</div>
					</li>
				))}
			</ul>
		</Card>
	);
}

function SurveyPage() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const s = data.survey;
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "surveys:edit");
	const [form, setForm] = useState<Form>(() => formOf(s));
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved survey changes
	useEffect(() => setForm(formOf(s)), [s.updated_at, s.id]);
	const dirty = JSON.stringify(form) !== JSON.stringify(formOf(s));
	const [busy, setBusy] = useState<"save" | "toggle" | null>(null);
	const [deleting, setDeleting] = useState(false);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	const save = async (extra: { enabled?: boolean } = {}) => {
		setBusy(extra.enabled === undefined ? "save" : "toggle");
		try {
			await saveSurveyFn({
				data: {
					id: s.id,
					fields: {
						...form,
						options: form.options.map((o) => o.trim()).filter(Boolean),
						low_label: form.low_label || null,
						high_label: form.high_label || null,
						comment_prompt: form.comment_prompt || null,
						...extra,
					},
				},
			});
			await router.invalidate();
			toast.success(
				extra.enabled === undefined
					? "Saved"
					: extra.enabled
						? "Survey open"
						: "Survey closed",
			);
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const r = data.results;
	return (
		<Page className="gap-8">
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete “${s.name}”?`}
				description="Its answers go too, and its links in emails already sent stop working. The answers stay in each contact's activity."
				action="Delete survey"
				onConfirm={async () => {
					try {
						await deleteSurveyFn({ data: { id: s.id } });
						toast.success("Survey deleted");
						await router.navigate({ to: "/surveys" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/surveys"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Surveys
					</Link>
				</nav>
				<RecordHeader
					icon={ClipboardCheck}
					tone={s.enabled ? "brand" : "gray"}
					kind={`${KIND[s.kind]} survey`}
					title={s.name}
					actions={
						<>
							<Button
								variant="outline"
								asChild
							>
								<a
									href={s.url}
									target="_blank"
									rel="noreferrer"
								>
									<ExternalLink />
									Open
								</a>
							</Button>
							{canEdit && (
								<>
									<Button
										disabled={!dirty || !!busy}
										onClick={() => save()}
									>
										{busy === "save" && <Spinner />}
										Save
									</Button>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Delete survey"
										onClick={() => setDeleting(true)}
									>
										<Trash2 />
									</Button>
								</>
							)}
						</>
					}
				/>
			</div>
			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">{s.enabled ? "Open" : "Closed"}</Fact>
				{data.brand && <Fact label="Brand">{data.brand.name}</Fact>}
				<Fact label="Answers">{r.total.toLocaleString()}</Fact>
				<Fact label="Edited">{formatRelative(s.updated_at)}</Fact>
				<Fact label="Id">
					<IdChip value={s.id} />
				</Fact>
			</Facts>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
				<div className="flex min-w-0 flex-col gap-6">
					<Card className="gap-6 p-5">
						<div className="flex flex-wrap items-center justify-between gap-3">
							<h2 className="font-medium">Results</h2>
							<ToggleGroup
								type="single"
								variant="outline"
								size="sm"
								value={search.period ?? "90"}
								onValueChange={(v) =>
									v &&
									navigate({
										search: { period: v as "30" | "90" | "all" },
										replace: true,
									})
								}
							>
								<ToggleGroupItem value="30">30 days</ToggleGroupItem>
								<ToggleGroupItem value="90">90 days</ToggleGroupItem>
								<ToggleGroupItem value="all">All time</ToggleGroupItem>
							</ToggleGroup>
						</div>
						<Headline
							s={s}
							r={r}
						/>
						{r.total > 0 && (
							<>
								<Distribution
									s={s}
									r={r}
								/>
								<div className="flex flex-wrap gap-2">
									{Object.entries(r.by_source).map(([k, n]) => (
										<Badge
											key={k}
											variant="secondary"
										>
											{SOURCE[k] ?? k}: {n}
										</Badge>
									))}
								</div>
							</>
						)}
					</Card>
					<Card className="gap-0 p-0">
						<div className="border-b border-border/70 px-5 py-4">
							<h2 className="font-medium">Answers</h2>
							<p className="text-sm text-muted-foreground">
								The latest first. A contact who answers again changes their answer.
							</p>
						</div>
						{data.responses.length === 0 ? (
							<p className="px-5 py-6 text-sm text-muted-foreground">
								Nothing yet. Answers show up here as they come in.
							</p>
						) : (
							<ul className="divide-y">
								{data.responses.map((x) => (
									<li
										key={x.id}
										className="flex gap-3 px-5 py-3"
									>
										<span
											className={cn(
												"flex h-8 min-w-8 shrink-0 items-center justify-center rounded-md px-2 text-sm font-semibold tabular-nums",
												x.group
													? `${GROUP_TONE[x.group]} text-white`
													: "bg-muted",
											)}
										>
											{s.kind === "choice" ? "•" : x.answer}
										</span>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm">
												{x.contact_id ? (
													<Link
														to="/contacts/$id"
														params={{ id: x.contact_id }}
														className="font-medium hover:underline"
													>
														{x.email ?? "A contact"}
													</Link>
												) : (
													<span className="font-medium">
														{x.email ?? "A visitor"}
													</span>
												)}
												{s.kind === "choice" && (
													<span className="text-muted-foreground">
														{" "}
														· {x.answer}
													</span>
												)}
											</p>
											{x.comment && (
												<p className="mt-0.5 text-sm whitespace-pre-line text-muted-foreground">
													“{x.comment}”
												</p>
											)}
											<p className="mt-0.5 text-xs text-muted-foreground">
												{SOURCE[x.source] ?? x.source} ·{" "}
												{formatRelative(x.updated_at)}
											</p>
										</div>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
				<div className="flex min-w-0 flex-col gap-6">
					<Card className="gap-5 p-5">
						<h2 className="font-medium">The survey</h2>
						{canEdit && (
							<SwitchRow
								label="Open for answers"
								hint="Closed: its links show that it's closed and nothing is recorded."
								checked={s.enabled}
								onChange={(enabled) => !busy && save({ enabled })}
							/>
						)}
						<Field>
							<FieldLabel htmlFor="s-name">Name</FieldLabel>
							<Input
								id="s-name"
								maxLength={80}
								disabled={!canEdit}
								value={form.name}
								onChange={(e) => set("name", e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="s-q">Question</FieldLabel>
							<Input
								id="s-q"
								maxLength={300}
								disabled={!canEdit}
								value={form.question}
								onChange={(e) => set("question", e.target.value)}
							/>
							<FieldDescription>
								An email's survey block keeps a copy: pick the survey again there
								after changing it.
							</FieldDescription>
						</Field>
						{s.kind === "choice" ? (
							<div className="flex flex-col gap-1.5">
								<span className="text-sm font-medium">Answers</span>
								{form.options.map((o, i) => (
									<div
										key={i}
										className="flex gap-1.5"
									>
										<Input
											value={o}
											disabled={!canEdit}
											aria-label={`Answer ${i + 1}`}
											onChange={(e) =>
												set(
													"options",
													form.options.map((x, j) =>
														j === i ? e.target.value : x,
													),
												)
											}
										/>
										<Button
											variant="ghost"
											size="icon"
											aria-label="Remove answer"
											disabled={!canEdit || form.options.length <= 2}
											onClick={() =>
												set(
													"options",
													form.options.filter((_, j) => j !== i),
												)
											}
										>
											<X />
										</Button>
									</div>
								))}
								{canEdit && form.options.length < 10 && (
									<Button
										variant="outline"
										size="sm"
										className="self-start"
										onClick={() =>
											set("options", [
												...form.options,
												`Answer ${form.options.length + 1}`,
											])
										}
									>
										<Plus />
										Add an answer
									</Button>
								)}
							</div>
						) : (
							<div className="grid gap-5 sm:grid-cols-2">
								<Field>
									<FieldLabel htmlFor="s-low">
										Under {s.kind === "nps" ? "0" : "1"}
									</FieldLabel>
									<Input
										id="s-low"
										maxLength={40}
										disabled={!canEdit}
										value={form.low_label}
										onChange={(e) => set("low_label", e.target.value)}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="s-high">
										Under {s.kind === "nps" ? "10" : "5"}
									</FieldLabel>
									<Input
										id="s-high"
										maxLength={40}
										disabled={!canEdit}
										value={form.high_label}
										onChange={(e) => set("high_label", e.target.value)}
									/>
								</Field>
							</div>
						)}
						<Field>
							<FieldLabel htmlFor="s-c">Ask for a comment</FieldLabel>
							<Input
								id="s-c"
								maxLength={200}
								disabled={!canEdit}
								placeholder="Leave empty for no comment box"
								value={form.comment_prompt}
								onChange={(e) => set("comment_prompt", e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="s-t">After they answer</FieldLabel>
							<Input
								id="s-t"
								maxLength={300}
								disabled={!canEdit}
								value={form.thanks}
								onChange={(e) => set("thanks", e.target.value)}
							/>
						</Field>
					</Card>
					<Places data={data} />
				</div>
			</div>
		</Page>
	);
}
