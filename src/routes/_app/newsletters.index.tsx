import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ExternalLink, Newspaper, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions, useRowAction } from "@/components/row-menu";
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
import { deleteNewsletterFn, newslettersPageFn, saveNewsletterFn } from "@/functions/newsletters";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { DEFAULT_LOOK } from "@/lib/newsletter-look";
import { allows } from "@/lib/permissions";
import {
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

export const Route = createFileRoute("/_app/newsletters/")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ deps }) => newslettersPageFn({ data: { brand: deps.brand } }),
	head: () => ({ meta: [{ title: "Newsletters · Mailroom" }] }),
	component: Newsletters,
	pendingComponent: NewslettersSketch,
});

type Data = Awaited<ReturnType<typeof newslettersPageFn>>;

function NewslettersSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					newsletters: sample(rememberedRows("newsletters", 2), (i) => ({
						object: "newsletter",
						id: `sketch-${i}`,
						brand_id: "",
						name: pick(i, ["Hotel news", "The weekly letter"]),
						slug: "news",
						url: "",
						feed_url: "",
						description: null,
						segment_id: null,
						topic_id: null,
						from: "",
						form_id: null,
						public: true,
						accent: null,
						rss_url: null,
						rss_mode: "draft",
						rss_style: "full",
						rss_intro: null,
						look: DEFAULT_LOOK,
						rss_checked_at: null,
						rss_error: null,
						referrals: false,
						referral_rewards: [],
						created_at: "",
						updated_at: "",
						brand: null,
						issues: 12,
					})),
				} satisfies Data
			}
		>
			<Newsletters />
		</Sketch>
	);
}

export function NewNewsletter({
	brand,
	label = "New newsletter",
}: {
	brand?: string;
	label?: string;
}) {
	const router = useRouter();
	const me = useMe();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [pickBrand, setPickBrand] = useState<string | undefined>(brand);
	const [busy, setBusy] = useState(false);
	return (
		<>
			<Button onClick={() => setOpen(true)}>
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
								const n = await saveNewsletterFn({
									data: { brand: pickBrand ?? brand, fields: { name } },
								});
								await router.invalidate();
								await router.navigate({
									to: "/newsletters/$id",
									params: { id: n.id },
								});
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New newsletter</DialogTitle>
							<DialogDescription>
								A newsletter keeps its issues on a public page with its sign-up
								form. You set who it goes to and how it looks next.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="nl-name">Name</FieldLabel>
								<Input
									id="nl-name"
									autoFocus
									placeholder="Harbor Inn News"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
								<FieldDescription>
									Readers see it on the archive page.
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
								disabled={busy || !name.trim()}
							>
								{busy && <Spinner />}
								Create newsletter
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}

function Newsletters() {
	const { data, search } = usePage(Route);
	const navigate = useNavigate({ from: Route.fullPath });
	const me = useMe();
	const canManage = allows(me.active?.access, "newsletters:edit");
	const { newsletters } = data;
	useRememberRows("newsletters", newsletters.length);
	useListed("newsletters", newsletters);
	const many = data.brands.length > 1;
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof newsletters)[number] | null>(null);
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this newsletter"}?`}
				description="Its public page goes away. Its issues stay, as broadcasts on their own."
				action="Delete newsletter"
				onConfirm={() =>
					act(
						() => deleteNewsletterFn({ data: { id: deleting?.id ?? "" } }),
						"Newsletter deleted",
					)
				}
			/>
			<PageHeader
				title="Newsletters"
				description="What your issues have in common: who they go to, who they're from, and a public page with every past issue and a sign-up form. It can also send your blog's new posts and run a referral program."
				actions={
					canManage && newsletters.length > 0 && <NewNewsletter brand={search.brand} />
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
				{newsletters.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Newspaper />
							</EmptyMedia>
							<EmptyTitle>Start a newsletter</EmptyTitle>
							<EmptyDescription>
								Its issues are broadcasts that also go on its own web page, where
								anyone can read past issues and subscribe.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<NewNewsletter brand={search.brand} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Newsletter</TableHead>
								<TableHead className="hidden w-40 md:table-cell">Extras</TableHead>
								<TableHead className="w-20 text-right sm:w-24">Issues</TableHead>
								<TableHead className="hidden w-32 text-right sm:table-cell">
									Page
								</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{newsletters.map((n) => (
								<TableRow
									key={n.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={Newspaper}
												tone="blue"
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/newsletters/$id"
													params={{ id: n.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{n.name}</Ph>
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															many && !search.brand ? n.brand : null,
															`/n/${n.slug}`,
														]
															.filter(Boolean)
															.join(" · ")}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden text-sm text-muted-foreground md:table-cell">
										<Ph>
											{[
												n.rss_url ? "RSS" : null,
												n.referrals ? "Referrals" : null,
											]
												.filter(Boolean)
												.join(", ") || "—"}
										</Ph>
									</TableCell>
									<TableCell className="text-right tabular-nums">
										<Ph>{n.issues.toLocaleString()}</Ph>
									</TableCell>
									<TableCell className="hidden text-right sm:table-cell">
										{n.public ? (
											<a
												href={n.url}
												target="_blank"
												rel="noreferrer"
												className="relative z-10 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
											>
												Open
												<ExternalLink className="size-3.5" />
											</a>
										) : (
											<span className="text-sm text-muted-foreground">
												Private
											</span>
										)}
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${n.name} actions`}
											id={n.id}
											onDelete={canManage ? () => setDeleting(n) : undefined}
										/>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}
