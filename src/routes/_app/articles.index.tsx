import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ExternalLink,
	FileText,
	LifeBuoy,
	MessageCircleQuestion,
	Plus,
	Settings2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { SwitchRow } from "@/components/design-controls";
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
import { Textarea } from "@/components/ui/textarea";
import {
	deleteArticleFn,
	dismissGapFn,
	helpPageFn,
	saveArticleFn,
	saveHelpCenterFn,
} from "@/functions/help-center";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";

export const Route = createFileRoute("/_app/articles/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => helpPageFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Help center · Mailroom" }] }),
	component: HelpCenterPage,
});

type Data = Awaited<ReturnType<typeof helpPageFn>>;

function NewArticle({
	brand,
	title: initial = "",
	label = "New article",
	variant = "default",
}: {
	brand?: string;
	title?: string;
	label?: string;
	variant?: "default" | "outline";
}) {
	const router = useRouter();
	const me = useMe();
	const [open, setOpen] = useState(false);
	const [title, setTitle] = useState(initial);
	const [pickBrand, setPickBrand] = useState<string | undefined>(brand);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button
				variant={variant}
				size={variant === "outline" ? "sm" : "default"}
				onClick={() => {
					setTitle(initial);
					setOpen(true);
				}}
			>
				<Plus />
				{label}
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-md">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const a = await saveArticleFn({
									data: { brand: pickBrand ?? brand, fields: { title } },
								});
								await router.invalidate();
								await router.navigate({
									to: "/articles/$id",
									params: { id: a.id },
								});
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New article</DialogTitle>
							<DialogDescription>
								You write it in the email editor. It stays a draft until you publish
								it.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="art-title">Title</FieldLabel>
								<Input
									id="art-title"
									autoFocus
									placeholder="How do I change my booking?"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
								/>
								<FieldDescription>
									Write it as the question people ask.
								</FieldDescription>
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
								disabled={busy || !title.trim()}
							>
								{busy && <Spinner />}
								Create article
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function CenterSettings({ data, brand }: { data: Data; brand?: string }) {
	const router = useRouter();
	const c = data.center;
	const [open, setOpen] = useState(false);
	const [f, setF] = useState({ title: "", intro: "", slug: "", enabled: true });
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button
				variant="outline"
				onClick={() => {
					setF({
						title: c?.title ?? "",
						intro: c?.intro ?? "",
						slug: c?.slug ?? "",
						enabled: c?.enabled ?? true,
					});
					setOpen(true);
				}}
			>
				<Settings2 />
				Public page
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:max-w-md">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								await saveHelpCenterFn({
									data: {
										brand: brand ?? data.brand,
										fields: {
											...(f.title.trim() ? { title: f.title } : {}),
											intro: f.intro || null,
											...(f.slug.trim() ? { slug: f.slug } : {}),
											enabled: f.enabled,
										},
									},
								});
								await router.invalidate();
								setOpen(false);
								toast.success("Help center saved");
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>Help center page</DialogTitle>
							<DialogDescription>
								Its public page lists your published articles with a search box, on
								the same address as your newsletters.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="hc-title">Title</FieldLabel>
								<Input
									id="hc-title"
									maxLength={80}
									placeholder="Harbor Inn help center"
									value={f.title}
									onChange={(e) => setF({ ...f, title: e.target.value })}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="hc-intro">Under it</FieldLabel>
								<Textarea
									id="hc-intro"
									rows={2}
									maxLength={300}
									placeholder="Answers about bookings, rooms and your stay."
									value={f.intro}
									onChange={(e) => setF({ ...f, intro: e.target.value })}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="hc-slug">Address</FieldLabel>
								<Input
									id="hc-slug"
									maxLength={64}
									placeholder="harbor-inn"
									value={f.slug}
									onChange={(e) =>
										setF({ ...f, slug: e.target.value.toLowerCase() })
									}
								/>
								<FieldDescription>/help/{f.slug || "…"}</FieldDescription>
							</Field>
							<SwitchRow
								label="On"
								hint="Off, its pages and the chat's suggestions go away; the articles stay."
								checked={f.enabled}
								onChange={(enabled) => setF({ ...f, enabled })}
							/>
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
								Save
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function HelpCenterPage() {
	const data = Route.useLoaderData();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "help:edit");
	const { articles, center, gaps } = data;
	const many = data.brands.length > 1;
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof articles)[number] | null>(null);
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete “${deleting?.title ?? "this article"}”?`}
				description="It leaves the help center at once, and links to it stop working."
				action="Delete article"
				onConfirm={() =>
					act(
						() => deleteArticleFn({ data: { id: deleting?.id ?? "" } }),
						"Article deleted",
					)
				}
			/>
			<PageHeader
				title="Help center"
				description="Answers people find on their own: public articles you write in the email editor. The website chat suggests them before your team answers, saved replies can link to them, and agents can read them."
				actions={
					<div className="flex gap-2">
						{center?.enabled && (
							<Button
								variant="outline"
								asChild
							>
								<a
									href={center.url}
									target="_blank"
									rel="noreferrer"
								>
									<ExternalLink />
									Open
								</a>
							</Button>
						)}
						{canEdit && (
							<CenterSettings
								data={data}
								brand={search.brand}
							/>
						)}
						{canEdit && articles.length > 0 && <NewArticle brand={search.brand} />}
					</div>
				}
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
				{articles.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LifeBuoy />
							</EmptyMedia>
							<EmptyTitle>Write your first article</EmptyTitle>
							<EmptyDescription>
								Start with the question your team answers most. Published articles
								go on your help center's page and into the chat's suggestions.
							</EmptyDescription>
						</EmptyHeader>
						{canEdit && (
							<EmptyContent>
								<NewArticle brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Article</TableHead>
								<TableHead className="hidden w-36 md:table-cell">
									Category
								</TableHead>
								<TableHead className="w-28">Status</TableHead>
								<TableHead className="hidden w-20 text-right sm:table-cell">
									Views
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Helpful
								</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{articles.map((a) => {
								const votes = a.helpful + a.unhelpful;
								return (
									<TableRow
										key={a.id}
										className="relative"
									>
										<TableCell className="h-14">
											<span className="flex min-w-0 items-center gap-3">
												<Stamp
													icon={FileText}
													tone="blue"
													className="size-7"
												/>
												<span className="min-w-0">
													<Link
														to="/articles/$id"
														params={{ id: a.id }}
														className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
													>
														{a.title}
													</Link>
													<span className="block truncate text-xs text-muted-foreground">
														{[
															many && !search.brand ? a.brand : null,
															a.description,
														]
															.filter(Boolean)
															.join(" · ") ||
															`Edited ${formatRelative(a.updated_at)}`}
													</span>
												</span>
											</span>
										</TableCell>
										<TableCell className="hidden truncate text-sm text-muted-foreground md:table-cell">
											{a.category ?? "—"}
										</TableCell>
										<TableCell>
											<Badge
												variant={
													a.status === "published"
														? "default"
														: "secondary"
												}
											>
												{a.status === "published" ? "Published" : "Draft"}
											</Badge>
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{a.views.toLocaleString()}
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{votes
												? `${Math.round((a.helpful / votes) * 100)}%`
												: "—"}
										</TableCell>
										<TableCell className="pr-3 text-right">
											<RowActions
												label={`${a.title} actions`}
												id={a.id}
												onDelete={
													canEdit ? () => setDeleting(a) : undefined
												}
											/>
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<Card className="gap-0 p-0">
				<div className="flex items-start gap-3 border-b px-5 py-4">
					<MessageCircleQuestion className="mt-0.5 size-5 text-muted-foreground" />
					<div>
						<h2 className="font-medium">Questions with no article yet</h2>
						<p className="text-sm text-muted-foreground">
							What people asked the chat or searched for in the last 30 days that no
							published article answered, most asked first.
						</p>
					</div>
				</div>
				{gaps.length === 0 ? (
					<p className="px-5 py-6 text-sm text-muted-foreground">
						Nothing yet. When the chat or your help center's search finds no answer, the
						question shows up here.
					</p>
				) : (
					<ul className="divide-y">
						{gaps.map((g) => (
							<li
								key={`${g.brand_id}:${g.question}`}
								className="flex flex-wrap items-center gap-3 px-5 py-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">“{g.question}”</p>
									<p className="text-xs text-muted-foreground">
										{g.times === 1 ? "Once" : `${g.times} times`} ·{" "}
										{g.source === "chat" ? "in the chat" : "in search"} ·{" "}
										{formatRelative(g.last_at)}
									</p>
								</div>
								{canEdit && (
									<div className="flex gap-2">
										<NewArticle
											brand={search.brand}
											title={g.question.slice(0, 160)}
											label="Write an article"
											variant="outline"
										/>
										<Button
											variant="ghost"
											size="sm"
											onClick={async () => {
												try {
													await dismissGapFn({
														data: { question: g.question },
													});
													await router.invalidate();
												} catch (error) {
													toast.error(await errorMessage(error));
												}
											}}
										>
											Dismiss
										</Button>
									</div>
								)}
							</li>
						))}
					</ul>
				)}
			</Card>
		</Page>
	);
}
