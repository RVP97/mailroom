import { Link } from "@tanstack/react-router";
import {
	ArrowUpRight,
	Building2,
	CheckCircle2,
	CircleDot,
	Link2,
	Plus,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { companyForEmailFn } from "@/functions/companies";
import {
	linkConversationIssueFn,
	listConversationIssuesFn,
	unlinkConversationIssueFn,
} from "@/functions/issue-links";
import { errorMessage } from "@/lib/errors";

type CompanySummary = Awaited<ReturnType<typeof companyForEmailFn>>;
type IssueRow = Awaited<ReturnType<typeof listConversationIssuesFn>>[number];

/**
 * Right-rail cards inside the Inbox conversation sidebar:
 *  1. B2B Company / Account summary (plan, MRR, seats, team size)
 *  2. Linked GitHub / Linear issues (auto-reopens conversation when closed)
 */
export function CompanyAndIssuesCards({
	brandId,
	contactEmail,
	conversationId,
	canEdit,
}: {
	brandId: string;
	contactEmail: string | null | undefined;
	conversationId: string;
	canEdit: boolean;
}) {
	const [company, setCompany] = useState<CompanySummary>(null);
	const [issues, setIssues] = useState<IssueRow[]>([]);
	const [adding, setAdding] = useState(false);
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		if (!conversationId || conversationId.startsWith("sketch-")) return;
		const [cmp, iss] = await Promise.all([
			contactEmail
				? companyForEmailFn({ data: { brand: brandId, email: contactEmail } }).catch(
						() => null,
					)
				: Promise.resolve(null),
			listConversationIssuesFn({ data: { conversationId } }).catch(() => []),
		]);
		setCompany(cmp);
		setIssues(iss);
	}, [brandId, contactEmail, conversationId]);

	useEffect(() => {
		void load();
	}, [load]);

	const addIssue = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!url.trim()) return;
		setBusy(true);
		try {
			await linkConversationIssueFn({
				data: {
					brand: brandId,
					conversationId,
					url: url.trim(),
					title: title.trim() || undefined,
				},
			});
			setUrl("");
			setTitle("");
			setAdding(false);
			toast.success("Issue linked — conversation reopens automatically when closed");
			await load();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			{/* B2B Company Card */}
			{company && (
				<div className="flex flex-col gap-2 border-t border-border pt-4">
					<div className="flex items-center justify-between gap-2">
						<h3 className="eyebrow flex items-center gap-1.5">
							<Building2 className="size-3" />
							Company
						</h3>
						<Link
							to="/companies/$id"
							params={{ id: company.id }}
							className="inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
						>
							Open
							<ArrowUpRight className="size-3" />
						</Link>
					</div>
					<div className="rounded-lg border border-border/70 bg-background p-2.5 text-xs">
						<div className="flex items-center justify-between gap-2">
							<span className="truncate font-semibold text-sm">{company.name}</span>
							{company.plan && (
								<Badge
									variant="secondary"
									className="h-5 px-1.5 text-[10px]"
								>
									{company.plan}
								</Badge>
							)}
						</div>
						<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground tabular-nums">
							{company.mrr != null && (
								<span>
									<strong className="text-foreground">
										${company.mrr.toLocaleString()}
									</strong>
									/mo
								</span>
							)}
							{company.seats != null && <span>{company.seats} seats</span>}
							<span>
								{company.contacts_count}{" "}
								{company.contacts_count === 1 ? "contact" : "contacts"}
							</span>
						</div>
					</div>
				</div>
			)}

			{/* Linked GitHub / Linear Issues */}
			<div className="flex flex-col gap-2 border-t border-border pt-4">
				<div className="flex items-center justify-between gap-2">
					<h3 className="eyebrow flex items-center gap-1.5">
						<Link2 className="size-3" />
						Linked issues {issues.length > 0 ? `(${issues.length})` : ""}
					</h3>
					{canEdit && (
						<button
							type="button"
							onClick={() => setAdding((v) => !v)}
							className="inline-flex items-center gap-0.5 text-[11px] font-medium text-brand hover:underline"
						>
							<Plus className="size-3" />
							Link
						</button>
					)}
				</div>

				{adding && (
					<form
						onSubmit={addIssue}
						className="space-y-2 rounded-lg border border-border/70 bg-background p-2.5"
					>
						<Input
							className="h-7 text-xs"
							placeholder="https://github.com/org/repo/issues/42"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							required
						/>
						<Input
							className="h-7 text-xs"
							placeholder="Short title (optional)"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
						<div className="flex justify-end gap-1.5">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => setAdding(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								className="h-6 px-2 text-xs"
								disabled={busy || !url.trim()}
							>
								{busy && <Spinner className="size-3" />}
								Link
							</Button>
						</div>
					</form>
				)}

				{issues.length === 0 && !adding ? (
					<p className="text-xs text-muted-foreground">
						Link a GitHub or Linear issue to reopen this thread automatically when it
						ships.
					</p>
				) : (
					<ul className="space-y-1">
						{issues.map((iss) => (
							<li
								key={iss.id}
								className="group flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
							>
								{iss.status === "closed" ? (
									<CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
								) : (
									<CircleDot className="size-3.5 shrink-0 text-amber-600" />
								)}
								<a
									href={iss.url}
									target="_blank"
									rel="noreferrer"
									className="min-w-0 flex-1 truncate font-medium hover:underline"
								>
									{iss.title}
								</a>
								{canEdit && (
									<button
										type="button"
										aria-label={`Unlink ${iss.title}`}
										onClick={async () => {
											try {
												await unlinkConversationIssueFn({
													data: { conversationId, id: iss.id },
												});
												await load();
											} catch (error) {
												toast.error(await errorMessage(error));
											}
										}}
										className="text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
									>
										<Trash2 className="size-3" />
									</button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</>
	);
}
