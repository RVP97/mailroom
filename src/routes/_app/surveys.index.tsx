import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ClipboardCheck, Inbox, Plus, Smile, Vote } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { ChoiceCards } from "@/components/choice-cards";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions, useRowAction } from "@/components/row-menu";
import { Badge } from "@/components/ui/badge";
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
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
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
import { deleteSurveyFn, saveSurveyFn, surveysPageFn } from "@/functions/surveys";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";

export const Route = createFileRoute("/_app/surveys/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => surveysPageFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Surveys · Mailroom" }] }),
	component: SurveysPage,
});

type Data = Awaited<ReturnType<typeof surveysPageFn>>;
type Kind = "nps" | "csat" | "choice";

const KIND_LABEL: Record<Kind, string> = {
	nps: "NPS",
	csat: "Satisfaction",
	choice: "Choice",
};

/** A survey's headline number, the way people read it. */
function headline(kind: string, r: Data["surveys"][number]["results"]) {
	if (!r?.total) return "—";
	if (kind === "nps")
		return r.nps === null || r.nps === undefined
			? "—"
			: `${Number(r.nps) > 0 ? "+" : ""}${r.nps}`;
	if (kind === "csat")
		return r.satisfied_pct === null || r.satisfied_pct === undefined
			? "—"
			: `${r.satisfied_pct}%`;
	return String(r.top ?? "—");
}

function NewSurvey({ brand }: { brand?: string }) {
	const router = useRouter();
	const me = useMe();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Kind>("nps");
	const [name, setName] = useState("");
	const [pickBrand, setPickBrand] = useState<string | undefined>(brand);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>
				<Plus />
				New survey
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-lg">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const s = await saveSurveyFn({
									data: {
										brand: pickBrand ?? brand,
										fields: { kind, ...(name.trim() ? { name } : {}) },
									},
								});
								await router.invalidate();
								await router.navigate({ to: "/surveys/$id", params: { id: s.id } });
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New survey</DialogTitle>
							<DialogDescription>
								One question, answered in one click from an email, on the web, in
								the chat or after a support conversation.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<ChoiceCards
								name="sv-kind"
								value={kind}
								onChange={setKind}
								className="sm:grid-cols-3"
								options={[
									{
										value: "nps",
										title: "NPS",
										description: "How likely they'd recommend you, 0 to 10.",
									},
									{
										value: "csat",
										title: "Satisfaction",
										description: "How satisfied they are, 1 to 5.",
									},
									{
										value: "choice",
										title: "A question",
										description: "One answer from a list you write.",
									},
								]}
							/>
							<Field>
								<FieldLabel htmlFor="sv-name">
									Name (only your team sees it)
								</FieldLabel>
								<Input
									id="sv-name"
									placeholder={
										kind === "nps"
											? "NPS"
											: kind === "csat"
												? "Satisfaction"
												: "Survey"
									}
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
							{me.brands.length > 1 && (
								<Field>
									<FieldLabel>Brand</FieldLabel>
									<BrandFilter
										brands={me.brands}
										value={pickBrand}
										all={null}
										onChange={setPickBrand}
										className="w-full sm:w-full"
									/>
								</Field>
							)}
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy}
							>
								{busy && <Spinner />}
								Create survey
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function SurveysPage() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const canEdit = allows(me.active?.access, "surveys:edit");
	const many = data.brands.length > 1;
	const act = useRowAction();
	const [deleting, setDeleting] = useState<Data["surveys"][number] | null>(null);
	const { surveys, other } = data;
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete “${deleting?.name ?? "this survey"}”?`}
				description="Its answers go too, and its links in emails already sent stop working. The answers stay in each contact's activity."
				action="Delete survey"
				onConfirm={() =>
					act(
						() => deleteSurveyFn({ data: { id: deleting?.id ?? "" } }),
						"Survey deleted",
					)
				}
			/>
			<PageHeader
				title="Surveys"
				description="Ask how you're doing (NPS, satisfaction, or any question) in emails, on a web page, in the website chat and after support conversations. Every answer lands on the contact, in live segments and in automations."
				actions={canEdit && surveys.length > 0 ? <NewSurvey brand={search.brand} /> : null}
			/>
			{many && (
				<div className="flex justify-end">
					<BrandFilter
						brands={data.brands}
						value={search.brand}
						onChange={(b) => navigate({ search: { brand: b }, replace: true })}
					/>
				</div>
			)}
			<TableCard>
				{surveys.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<ClipboardCheck />
							</EmptyMedia>
							<EmptyTitle>Ask your first question</EmptyTitle>
							<EmptyDescription>
								Start with an NPS: put it in your next newsletter, after support
								conversations, or at the end of a chat.
							</EmptyDescription>
						</EmptyHeader>
						{canEdit && (
							<EmptyContent>
								<NewSurvey brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Survey</TableHead>
								<TableHead className="hidden w-32 md:table-cell">Kind</TableHead>
								<TableHead className="w-24 text-right">Score</TableHead>
								<TableHead className="hidden w-28 text-right sm:table-cell">
									Answers
								</TableHead>
								<TableHead className="hidden w-36 lg:table-cell">
									Last answer
								</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{surveys.map((s) => (
								<TableRow
									key={s.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={ClipboardCheck}
												tone="brand"
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/surveys/$id"
													params={{ id: s.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													{s.name}
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													{[
														many && !search.brand ? s.brand : null,
														s.question,
													]
														.filter(Boolean)
														.join(" · ")}
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<span className="flex items-center gap-2">
											<Badge variant="secondary">{KIND_LABEL[s.kind]}</Badge>
											{!s.enabled && <Badge variant="outline">Closed</Badge>}
										</span>
									</TableCell>
									<TableCell className="truncate text-right font-medium tabular-nums">
										{headline(s.kind, s.results)}
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">
										{s.responses.toLocaleString()}
									</TableCell>
									<TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
										{s.last_answer_at ? formatRelative(s.last_answer_at) : "—"}
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${s.name} actions`}
											id={s.id}
											onDelete={canEdit ? () => setDeleting(s) : undefined}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<div className="grid gap-4 md:grid-cols-2">
				<Card className="gap-3 p-5">
					<div className="flex items-center gap-3">
						<Stamp
							icon={Smile}
							tone="green"
							className="size-8"
						/>
						<div>
							<h2 className="font-medium">Support ratings</h2>
							<p className="text-xs text-muted-foreground">
								The five faces after a conversation, last 90 days
							</p>
						</div>
					</div>
					<p className="text-sm">
						{other.ratings.count ? (
							<>
								<span className="text-2xl font-semibold tabular-nums">
									{other.ratings.satisfied_pct}%
								</span>{" "}
								<span className="text-muted-foreground">
									satisfied · {other.ratings.average} average ·{" "}
									{other.ratings.count.toLocaleString()}{" "}
									{other.ratings.count === 1 ? "rating" : "ratings"}
								</span>
							</>
						) : (
							<span className="text-muted-foreground">No ratings yet.</span>
						)}
					</p>
					<p className="text-xs text-muted-foreground">
						Each inbox's workflow can ask one of these surveys instead.{" "}
						<Link
							to="/received/reports"
							className="underline"
						>
							Inbox reports
						</Link>
					</p>
				</Card>
				<Card className="gap-3 p-5">
					<div className="flex items-center gap-3">
						<Stamp
							icon={Vote}
							tone="blue"
							className="size-8"
						/>
						<div>
							<h2 className="font-medium">Email polls</h2>
							<p className="text-xs text-muted-foreground">
								Poll blocks in broadcasts, last 90 days
							</p>
						</div>
					</div>
					<p className="text-sm">
						{other.polls.answers ? (
							<>
								<span className="text-2xl font-semibold tabular-nums">
									{other.polls.answers.toLocaleString()}
								</span>{" "}
								<span className="text-muted-foreground">
									answers in {other.polls.broadcasts}{" "}
									{other.polls.broadcasts === 1 ? "broadcast" : "broadcasts"}
								</span>
							</>
						) : (
							<span className="text-muted-foreground">No poll answers yet.</span>
						)}
					</p>
					<p className="text-xs text-muted-foreground">
						Each broadcast's page shows its poll's results.{" "}
						<Link
							to="/broadcasts"
							className="underline"
						>
							Broadcasts
						</Link>
					</p>
				</Card>
			</div>
			<p className="flex items-center gap-2 text-xs text-muted-foreground">
				<Inbox className="size-3.5" />
				Answers from a known contact are recorded as the event survey.answered, so
				automations can follow up and live segments can pick promoters or detractors.
			</p>
		</Page>
	);
}
