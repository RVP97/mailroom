import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Building2, MessageSquare, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { DatePicker } from "@/components/date-picker";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { deleteCompanyFn, getCompanyFn, saveCompanyFn } from "@/functions/companies";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";

export const Route = createFileRoute("/_app/companies/$id")({
	loader: ({ params }) => getCompanyFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.company.name ?? "Company"} · Mailroom` }],
	}),
	component: CompanyDetailPage,
});

function CompanyDetailPage() {
	const data = Route.useLoaderData();
	const c = data.company;
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "contacts:edit");

	const [name, setName] = useState(c.name);
	const [domain, setDomain] = useState(c.domain ?? "");
	const [plan, setPlan] = useState(c.plan ?? "");
	const [mrr, setMrr] = useState(c.mrr != null ? String(c.mrr) : "");
	const [seats, setSeats] = useState(c.seats != null ? String(c.seats) : "");
	const [renewalAt, setRenewalAt] = useState(c.renewal_at ?? "");
	const [notes, setNotes] = useState(c.notes ?? "");
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);

	const save = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true);
		try {
			await saveCompanyFn({
				data: {
					brand: c.brand_id,
					id: c.id,
					fields: {
						name: name.trim(),
						domain: domain.trim() || null,
						plan: plan.trim() || null,
						mrr: mrr.trim() ? Number(mrr) : null,
						seats: seats.trim() ? Number(seats) : null,
						renewal_at: renewalAt.trim() || null,
						notes: notes.trim() || null,
					},
				},
			});
			toast.success("Company saved");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/companies"
						className="hover:text-foreground"
					>
						Companies
					</Link>
				</nav>
				<RecordHeader
					icon={Building2}
					tone="blue"
					kind="Company"
					title={c.name}
					actions={
						canEdit ? (
							<Button
								variant="ghost"
								size="icon"
								aria-label="Delete company"
								onClick={() => setDeleting(true)}
							>
								<Trash2 />
							</Button>
						) : undefined
					}
				/>
			</div>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Domain">{c.domain ?? "—"}</Fact>
				<Fact label="Plan">{c.plan ?? "—"}</Fact>
				<Fact label="MRR">{c.mrr != null ? `$${c.mrr.toLocaleString()}/mo` : "—"}</Fact>
				<Fact label="Seats">{c.seats ?? "—"}</Fact>
				<Fact label="Contacts">{data.contacts.length}</Fact>
				<Fact label="Id">
					<IdChip value={c.id} />
				</Fact>
			</Facts>

			<div className="grid items-start gap-6 lg:grid-cols-2">
				<Card className="p-5">
					<form
						className="flex flex-col gap-4"
						onSubmit={save}
					>
						<h2 className="text-sm font-semibold">Account details</h2>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="cd-name">Name</FieldLabel>
								<Input
									id="cd-name"
									value={name}
									disabled={!canEdit}
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cd-dom">Domain</FieldLabel>
								<Input
									id="cd-dom"
									value={domain}
									disabled={!canEdit}
									placeholder="acme.com"
									onChange={(e) => setDomain(e.target.value)}
								/>
							</Field>
						</div>
						<div className="grid gap-4 sm:grid-cols-3">
							<Field>
								<FieldLabel htmlFor="cd-plan">Plan</FieldLabel>
								<Input
									id="cd-plan"
									value={plan}
									disabled={!canEdit}
									placeholder="Enterprise"
									onChange={(e) => setPlan(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cd-mrr">MRR ($)</FieldLabel>
								<Input
									id="cd-mrr"
									type="number"
									min={0}
									value={mrr}
									disabled={!canEdit}
									onChange={(e) => setMrr(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cd-seats">Seats</FieldLabel>
								<Input
									id="cd-seats"
									type="number"
									min={0}
									value={seats}
									disabled={!canEdit}
									onChange={(e) => setSeats(e.target.value)}
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="cd-renewal">Renewal date</FieldLabel>
							<DatePicker
								id="cd-renewal"
								value={renewalAt}
								onChange={setRenewalAt}
								placeholder="No renewal date"
								clearable
								disabled={!canEdit}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="cd-notes">Account notes</FieldLabel>
							<Textarea
								id="cd-notes"
								rows={3}
								value={notes}
								disabled={!canEdit}
								placeholder="Key stakeholder, custom SLA, renewal context…"
								onChange={(e) => setNotes(e.target.value)}
							/>
						</Field>
						{canEdit && (
							<div>
								<Button
									type="submit"
									disabled={busy || !name.trim()}
								>
									{busy && <Spinner />}
									Save changes
								</Button>
							</div>
						)}
					</form>
				</Card>

				<div className="flex flex-col gap-6">
					<Card className="gap-0 p-0">
						<div className="flex items-center gap-2 border-b px-5 py-3.5">
							<Users className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">
								People ({data.contacts.length})
							</h2>
						</div>
						{data.contacts.length === 0 ? (
							<p className="px-5 py-4 text-sm text-muted-foreground">
								No linked contacts yet.
							</p>
						) : (
							<ul className="divide-y">
								{data.contacts.map((p) => (
									<li
										key={p.id}
										className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-5"
									>
										<Link
											to="/contacts/$id"
											params={{ id: p.id }}
											search={{ brand: c.brand_id }}
											className="min-w-0 flex-1 truncate font-medium hover:underline"
										>
											{[p.first_name, p.last_name]
												.filter(Boolean)
												.join(" ") || p.email}
										</Link>
										<span className="truncate text-xs text-muted-foreground sm:max-w-[50%]">
											{p.email}
										</span>
									</li>
								))}
							</ul>
						)}
					</Card>

					<Card className="gap-0 p-0">
						<div className="flex items-center gap-2 border-b px-5 py-3.5">
							<MessageSquare className="size-4 text-muted-foreground" />
							<h2 className="text-sm font-semibold">
								Conversations ({data.conversations.length})
							</h2>
						</div>
						{data.conversations.length === 0 ? (
							<p className="px-5 py-4 text-sm text-muted-foreground">
								No conversations from this company yet.
							</p>
						) : (
							<ul className="divide-y">
								{data.conversations.map((cv) => (
									<li
										key={cv.id}
										className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm"
									>
										<Link
											to="/received/$id"
											params={{ id: cv.id }}
											className="min-w-0 flex-1 truncate font-medium hover:underline"
										>
											{cv.subject || "(no subject)"}
										</Link>
										<div className="flex shrink-0 items-center gap-2">
											<Badge
												variant={
													cv.status === "open" ? "default" : "secondary"
												}
											>
												{cv.status}
											</Badge>
											<span className="text-xs text-muted-foreground">
												{formatRelative(cv.last_message_at)}
											</span>
										</div>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
			</div>

			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete ${c.name}?`}
				description="Its contacts and conversations stay intact."
				action="Delete company"
				onConfirm={async () => {
					try {
						await deleteCompanyFn({ data: { id: c.id } });
						toast.success("Company deleted");
						await router.navigate({ to: "/companies" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
		</Page>
	);
}
