import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { LayoutTemplate, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { Confirm } from "@/components/confirm";
import { Page, PageHeader, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowActions, useRowAction } from "@/components/row-menu";
import { TemplateStatus } from "@/components/template-status";
import { Button } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import {
	createTemplateFn,
	deleteTemplateFn,
	duplicateTemplateFn,
	listTemplatesFn,
} from "@/functions/templates";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	useListed,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

export const Route = createFileRoute("/_app/templates/")({
	loader: async () => ({ templates: await listTemplatesFn() }),
	head: () => ({ meta: [{ title: "Templates · Mailroom" }] }),
	component: Templates,
	pendingComponent: TemplatesSketch,
});

function TemplatesSketch() {
	return (
		<Sketch
			data={{
				templates: sample(rememberedRows("templates", 3), (i) => ({
					id: `sketch-${i}`,
					name: pick(i, ["Welcome", "Password reset", "Booking confirmed"]),
					alias: pick(i, ["welcome", "password-reset", null]),
					status: "published",
					has_unpublished_changes: false,
					subject: "Welcome to Mailroom",
					variables: 2,
					updated_at: ago(60 * 24 * (i + 1)),
				})),
			}}
		>
			<Templates />
		</Sketch>
	);
}

function NewTemplate({ variant }: { variant?: "outline" }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			variant={variant}
			disabled={busy}
			onClick={async () => {
				setBusy(true);
				try {
					const { id } = await createTemplateFn({ data: {} });
					await router.invalidate();
					await router.navigate({ to: "/templates/$id", params: { id } });
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			{busy ? <Spinner /> : <Plus />}
			New template
		</Button>
	);
}

function Templates() {
	const { templates } = usePage(Route).data;
	useRememberRows("templates", templates.length);
	useListed("templates", templates);
	const now = Date.now();
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "templates:edit");
	const act = useRowAction();
	const [deleting, setDeleting] = useState<(typeof templates)[number] | null>(null);
	return (
		<Page>
			<Confirm
				open={!!deleting}
				onOpenChange={(o) => !o && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this template"}?`}
				description="Sends that name it are refused from then on. Emails already sent keep their content."
				action="Delete template"
				onConfirm={() =>
					act(
						() => deleteTemplateFn({ data: { id: deleting?.id ?? "" } }),
						"Template deleted",
					)
				}
			/>
			<PageHeader
				title="Templates"
				description="Emails you design once and send by name, with {{{VARIABLES}}} filled in for each one. Broadcasts and automations use them too."
				actions={
					<>
						<ApiDrawer
							title="Templates in the API"
							description="Resend's Templates API. Needs a full-access key."
							calls={[
								{ title: "List templates", method: "GET", path: "/templates" },
								{
									title: "Send one",
									method: "POST",
									path: "/emails",
									body: {
										to: "ana@example.com",
										template: { id: "welcome", variables: { NAME: "Ana" } },
									},
								},
							]}
						/>
						{templates.length > 0 && <NewTemplate />}
					</>
				}
			/>
			<TableCard>
				{templates.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LayoutTemplate />
							</EmptyMedia>
							<EmptyTitle>Make your first template</EmptyTitle>
							<EmptyDescription>
								Write the HTML once, publish it, and send it from the API with only
								the values that change.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<NewTemplate />
						</EmptyContent>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Template</TableHead>
								<TableHead className="hidden w-48 sm:table-cell">Status</TableHead>
								<TableHead className="hidden w-28 md:table-cell">
									Variables
								</TableHead>
								<TableHead className="w-24 text-right">Edited</TableHead>
								<TableHead className="w-12">
									<span className="sr-only">Actions</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{templates.map((t) => (
								<TableRow
									key={t.id}
									className="relative"
								>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={LayoutTemplate}
												tone={t.status === "draft" ? "gray" : "blue"}
												className="size-7"
											/>
											<span className="min-w-0">
												<Link
													to="/templates/$id"
													params={{ id: t.id }}
													className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
												>
													<Ph>{t.name}</Ph>
												</Link>
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{t.alias ? (
															<span className="font-mono">
																{t.alias}
															</span>
														) : (
															(t.subject ?? "No subject")
														)}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden sm:table-cell">
										<TemplateStatus t={t} />
									</TableCell>
									<TableCell className="hidden text-muted-foreground tabular-nums md:table-cell">
										<Ph>{t.variables}</Ph>
									</TableCell>
									<TableCell
										className="text-right text-muted-foreground tabular-nums"
										title={formatDateTime(t.updated_at)}
									>
										<Ph>{formatAgo(t.updated_at, now)}</Ph>
									</TableCell>
									<TableCell className="pr-3 text-right">
										<RowActions
											label={`${t.name} actions`}
											id={t.id}
											onDuplicate={
												canEdit
													? () =>
															act(
																() =>
																	duplicateTemplateFn({
																		data: { id: t.id },
																	}),
																"Template duplicated",
																({ id }) =>
																	router.navigate({
																		to: "/templates/$id",
																		params: { id },
																	}),
															)
													: undefined
											}
											onDelete={canEdit ? () => setDeleting(t) : undefined}
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
