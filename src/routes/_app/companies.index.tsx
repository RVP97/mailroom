import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Building2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions } from "@/components/row-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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
import { deleteCompanyFn, listCompaniesFn, saveCompanyFn } from "@/functions/companies";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";

export const Route = createFileRoute("/_app/companies/")({
	validateSearch: z.object({
		brand: z.string().optional(),
		q: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({ brand: search.brand, q: search.q }),
	loader: ({ deps }) => listCompaniesFn({ data: { brand: deps.brand, search: deps.q } }),
	head: () => ({ meta: [{ title: "Companies · Mailroom" }] }),
	component: CompaniesPage,
});

type Row = Awaited<ReturnType<typeof listCompaniesFn>>["companies"][number];

const money = (mrr: number | null) =>
	mrr == null ? "—" : `$${mrr.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo`;

function CompaniesPage() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "contacts:edit");
	const [q, setQ] = useState(search.q ?? "");
	const [creating, setCreating] = useState(false);
	const [deleting, setDeleting] = useState<Row | null>(null);

	return (
		<Page>
			<PageHeader
				title="Companies"
				description="B2B accounts grouped by email domain — track plan, MRR, seats, and every teammate's conversations."
				actions={
					<div className="flex flex-wrap items-center gap-2">
						{data.brands.length > 1 && (
							<BrandFilter
								brands={data.brands}
								value={search.brand}
								onChange={(brand) => navigate({ search: { ...search, brand } })}
							/>
						)}
						{canEdit && (
							<Button onClick={() => setCreating(true)}>
								<Plus />
								New company
							</Button>
						)}
					</div>
				}
			/>

			<form
				className="flex max-w-sm items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void navigate({ search: { ...search, q: q.trim() || undefined } });
				}}
			>
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-8"
						placeholder="Search name, domain or plan…"
						value={q}
						onChange={(e) => setQ(e.target.value)}
					/>
				</div>
				<Button
					type="submit"
					variant="outline"
					size="sm"
				>
					Search
				</Button>
			</form>

			<TableCard>
				{data.companies.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Building2 />
							</EmptyMedia>
							<EmptyTitle>No companies yet</EmptyTitle>
							<EmptyDescription>
								Add a B2B account (like acme.com) to automatically group contacts by
								domain and show plan &amp; MRR right inside the Inbox sidebar.
							</EmptyDescription>
						</EmptyHeader>
						{canEdit && (
							<EmptyContent>
								<Button onClick={() => setCreating(true)}>
									<Plus />
									Add company
								</Button>
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Company</TableHead>
								<TableHead className="w-24 sm:w-28">Plan</TableHead>
								<TableHead className="w-20 text-right sm:w-24">MRR</TableHead>
								<TableHead className="hidden w-20 text-right sm:table-cell">
									Seats
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Contacts
								</TableHead>
								<TableHead className="w-10" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.companies.map((c) => (
								<TableRow
									key={c.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Building2}
												tone="blue"
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/companies/$id"
													params={{ id: c.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													{c.name}
												</Link>
												<span className="block truncate font-mono text-xs text-muted-foreground">
													{c.domain ?? "No domain"}
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell>
										{c.plan ? (
											<Badge variant="secondary">{c.plan}</Badge>
										) : (
											<span className="text-muted-foreground">—</span>
										)}
									</TableCell>
									<TableCell className="text-right font-medium tabular-nums">
										{money(c.mrr)}
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">
										{c.seats ?? "—"}
									</TableCell>
									<TableCell className="hidden text-right tabular-nums sm:table-cell">
										{c.contacts_count}
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${c.name} actions`}
											id={c.id}
											onDelete={canEdit ? () => setDeleting(c) : undefined}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>

			<NewCompanyDialog
				open={creating}
				brand={search.brand}
				onClose={() => setCreating(false)}
				onCreated={async (id) => {
					setCreating(false);
					await router.invalidate();
					await router.navigate({ to: "/companies/$id", params: { id } });
				}}
			/>

			<Confirm
				open={Boolean(deleting)}
				onOpenChange={(o) => {
					if (!o) setDeleting(null);
				}}
				title={`Delete ${deleting?.name ?? "company"}?`}
				description="Its contacts stay untouched; only the company record is removed."
				action="Delete company"
				onConfirm={async () => {
					if (!deleting) return;
					try {
						await deleteCompanyFn({ data: { id: deleting.id } });
						toast.success("Company deleted");
						setDeleting(null);
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
		</Page>
	);
}

function NewCompanyDialog({
	open,
	brand,
	onClose,
	onCreated,
}: {
	open: boolean;
	brand?: string;
	onClose: () => void;
	onCreated: (id: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [domain, setDomain] = useState("");
	const [plan, setPlan] = useState("");
	const [mrr, setMrr] = useState("");
	const [seats, setSeats] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const created = await saveCompanyFn({
								data: {
									brand,
									fields: {
										name: name.trim(),
										domain: domain.trim() || null,
										plan: plan.trim() || null,
										mrr: mrr.trim() ? Number(mrr) : null,
										seats: seats.trim() ? Number(seats) : null,
									},
								},
							});
							toast.success(`Added ${created.name}`);
							setName("");
							setDomain("");
							setPlan("");
							setMrr("");
							setSeats("");
							await onCreated(created.id);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>New company</DialogTitle>
						<DialogDescription>
							Contacts whose email ends in this domain automatically link to the
							account.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						<Field>
							<FieldLabel htmlFor="cmp-name">Company name</FieldLabel>
							<Input
								id="cmp-name"
								autoFocus
								placeholder="Acme Corp"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="cmp-dom">Email domain</FieldLabel>
							<Input
								id="cmp-dom"
								placeholder="acme.com"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
							/>
							<FieldDescription>
								Optional. Matches contacts like ana@acme.com automatically.
							</FieldDescription>
						</Field>
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
							<Field>
								<FieldLabel htmlFor="cmp-plan">Plan</FieldLabel>
								<Input
									id="cmp-plan"
									placeholder="Enterprise"
									value={plan}
									onChange={(e) => setPlan(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cmp-mrr">MRR ($)</FieldLabel>
								<Input
									id="cmp-mrr"
									type="number"
									min={0}
									placeholder="499"
									value={mrr}
									onChange={(e) => setMrr(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="cmp-seats">Seats</FieldLabel>
								<Input
									id="cmp-seats"
									type="number"
									min={0}
									placeholder="25"
									value={seats}
									onChange={(e) => setSeats(e.target.value)}
								/>
							</Field>
						</div>
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
							disabled={busy || !name.trim()}
						>
							{busy && <Spinner />}
							Create company
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
