import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Mail, MoreHorizontal, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Confirm } from "@/components/confirm";
import { EngagementCard } from "@/components/engagement";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
	deleteContactFn,
	getContactFn,
	saveContactFn,
	setContactSegmentFn,
	setContactTopicFn,
} from "@/functions/contacts";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, usePage } from "@/lib/sketch";

export const Route = createFileRoute("/_app/contacts/$id")({
	validateSearch: z.object({ brand: z.string().optional() }),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: ({ params, deps }) => getContactFn({ data: { id: params.id, brand: deps.brand } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.contact.email ?? "Contact"} · Mailroom` }],
	}),
	component: ContactPage,
	pendingComponent: ContactSketch,
});

type Data = Awaited<ReturnType<typeof getContactFn>>;

function ContactSketch() {
	const { params } = usePage(Route);
	const row = listedRow<Data["contact"]>("contacts", params.id);
	return (
		<Sketch
			data={
				{
					contact: row ?? {
						object: "contact",
						id: params.id ?? "",
						brand_id: "",
						email: "someone@example.com",
						first_name: "Ana",
						last_name: null,
						unsubscribed: false,
						properties: {},
						timezone: null,
						created_at: ago(60 * 24),
						updated_at: ago(60),
					},
					engagement: null,
					brand: null,
					segments: [],
					topics: [],
					properties: [],
					emails: [],
				} satisfies Data
			}
		>
			<ContactPage />
		</Sketch>
	);
}

function ContactPage() {
	const { data, search } = usePage(Route);
	const { contact } = data;
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "contacts:edit");
	const brand = search.brand ?? contact.brand_id;
	const [first, setFirst] = useState(contact.first_name ?? "");
	const [last, setLast] = useState(contact.last_name ?? "");
	const [props, setProps] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset when the saved contact changes
	useEffect(() => {
		setFirst(contact.first_name ?? "");
		setLast(contact.last_name ?? "");
		setProps(
			Object.fromEntries(
				data.properties.map((p) => [p.key, String(contact.properties[p.key] ?? "")]),
			),
		);
	}, [contact.updated_at, contact.id]);
	const saved = {
		first: contact.first_name ?? "",
		last: contact.last_name ?? "",
		props: Object.fromEntries(
			data.properties.map((p) => [p.key, String(contact.properties[p.key] ?? "")]),
		),
	};
	const dirty =
		first !== saved.first ||
		last !== saved.last ||
		data.properties.some((p) => (props[p.key] ?? "") !== saved.props[p.key]);

	const run = async (fn: () => Promise<unknown>, done?: string) => {
		try {
			await fn();
			if (done) toast.success(done);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};
	const save = async () => {
		setBusy(true);
		await run(
			() =>
				saveContactFn({
					data: {
						brand,
						id: contact.id,
						fields: {
							email: contact.email,
							first_name: first || null,
							last_name: last || null,
							properties: Object.fromEntries(
								data.properties.map((p) => [
									p.key,
									props[p.key] ? props[p.key] : null,
								]),
							) as Record<string, string | null>,
						},
					},
				}),
			"Contact saved",
		);
		setBusy(false);
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/contacts"
						search={{ brand: search.brand }}
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Contacts
					</Link>
				</nav>
				<RecordHeader
					icon={Users}
					tone={contact.unsubscribed ? "gray" : "green"}
					kind={data.brand ? `Contact of ${data.brand.name}` : "Contact"}
					title={contact.email}
					actions={
						canManage && (
							<>
								<Button
									disabled={!dirty || busy}
									onClick={save}
								>
									{busy && <Spinner />}
									Save
								</Button>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="outline"
											size="icon"
											aria-label="More"
										>
											<MoreHorizontal />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											variant="destructive"
											onSelect={() => setDeleting(true)}
										>
											<Trash2 /> Delete contact
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</>
						)
					}
				/>
			</div>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this contact?"
				description="They leave every segment and their topic choices go. Emails already sent stay in the log."
				action="Delete contact"
				onConfirm={async () => {
					try {
						await deleteContactFn({ data: { brand, id: contact.id } });
						toast.success("Contact deleted");
						await router.navigate({ to: "/contacts", search: { brand: search.brand } });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">
					<StatusBadge
						status={contact.unsubscribed ? "unsubscribed" : "ready"}
						label={contact.unsubscribed ? "Unsubscribed from all" : "Subscribed"}
					/>
				</Fact>
				<Fact label="Added">
					<span title={formatDateTime(contact.created_at)}>
						{formatAgo(contact.created_at)}
					</span>
				</Fact>
				<Fact label="Segments">{data.segments.filter((s) => s.member).length}</Fact>
				<Fact label="Id">
					<IdChip value={contact.id} />
				</Fact>
			</Facts>

			<div className="grid items-start gap-6 lg:grid-cols-2">
				<Card className="gap-5 p-5">
					<h2 className="font-semibold">Details</h2>
					<div className="grid gap-5 sm:grid-cols-2">
						<Field>
							<FieldLabel htmlFor="c-first">First name</FieldLabel>
							<Input
								id="c-first"
								disabled={!canManage}
								value={first}
								onChange={(e) => setFirst(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="c-last">Last name</FieldLabel>
							<Input
								id="c-last"
								disabled={!canManage}
								value={last}
								onChange={(e) => setLast(e.target.value)}
							/>
						</Field>
						{data.properties.map((p) => (
							<Field key={p.id}>
								<FieldLabel
									htmlFor={`c-${p.key}`}
									className="font-mono text-[13px]"
								>
									{p.key}
								</FieldLabel>
								<Input
									id={`c-${p.key}`}
									disabled={!canManage}
									inputMode={p.type === "number" ? "decimal" : undefined}
									placeholder={
										p.fallback_value === null
											? ""
											: `${p.fallback_value} (fallback)`
									}
									value={props[p.key] ?? ""}
									onChange={(e) =>
										setProps((x) => ({ ...x, [p.key]: e.target.value }))
									}
								/>
							</Field>
						))}
					</div>
					<div className="flex items-center justify-between gap-4 border-t border-border/70 pt-4 text-sm">
						<label htmlFor="c-unsubscribed">
							<span className="font-medium">Unsubscribed from all broadcasts</span>
							<span className="block text-muted-foreground">
								Their emails from your app (receipts, sign-in codes) still go.
							</span>
						</label>
						<Switch
							id="c-unsubscribed"
							disabled={!canManage}
							checked={contact.unsubscribed}
							onCheckedChange={(v) =>
								run(
									() =>
										saveContactFn({
											data: {
												brand,
												id: contact.id,
												fields: {
													email: contact.email,
													first_name: contact.first_name,
													last_name: contact.last_name,
													unsubscribed: v,
												},
											},
										}),
									v ? "Unsubscribed from all broadcasts" : "Subscribed again",
								)
							}
						/>
					</div>
				</Card>

				<div className="flex flex-col gap-6">
					<EngagementCard e={data.engagement} />
					<Card className="gap-4 p-5">
						<h2 className="font-semibold">Segments</h2>
						{data.segments.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								This brand has no segments yet (Contacts › Segments).
							</p>
						) : (
							<ul className="flex flex-col gap-2.5">
								{data.segments.map((s) => (
									<li key={s.id}>
										<div className="flex items-center gap-2.5 text-sm">
											<Checkbox
												id={`seg-${s.id}`}
												disabled={!canManage}
												checked={s.member}
												onCheckedChange={(v) =>
													run(() =>
														setContactSegmentFn({
															data: {
																brand,
																id: contact.id,
																segment: s.id,
																member: v === true,
															},
														}),
													)
												}
											/>
											<label htmlFor={`seg-${s.id}`}>{s.name}</label>
										</div>
									</li>
								))}
							</ul>
						)}
					</Card>
					<Card className="gap-4 p-5">
						<h2 className="font-semibold">Topics</h2>
						{data.topics.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								This brand has no topics yet (Contacts › Topics).
							</p>
						) : (
							<ul className="flex flex-col gap-3">
								{data.topics.map((t) => (
									<li
										key={t.id}
										className="flex items-center justify-between gap-4 text-sm"
									>
										<span className="min-w-0">
											<span className="block truncate">{t.name}</span>
											{t.description && (
												<span className="block truncate text-xs text-muted-foreground">
													{t.description}
												</span>
											)}
										</span>
										<Switch
											disabled={!canManage}
											aria-label={t.name}
											checked={t.subscription === "opt_in"}
											onCheckedChange={(v) =>
												run(() =>
													setContactTopicFn({
														data: {
															brand,
															id: contact.id,
															topic: t.id,
															subscription: v ? "opt_in" : "opt_out",
														},
													}),
												)
											}
										/>
									</li>
								))}
							</ul>
						)}
					</Card>
					<Card className="gap-3 p-5">
						<h2 className="font-semibold">Last emails</h2>
						{data.emails.length === 0 ? (
							<p className="text-sm text-muted-foreground">
								Nothing sent to them yet.
							</p>
						) : (
							<ul className="-mx-2 flex flex-col">
								{data.emails.map((e) => (
									<li key={e.id}>
										<Link
											to="/emails/$id"
											params={{ id: e.id }}
											className="flex h-10 items-center gap-3 rounded-md px-2 text-sm hover:bg-accent"
										>
											<Mail className="size-4 shrink-0 text-faint" />
											<span className="min-w-0 flex-1 truncate">
												<Ph>{e.subject}</Ph>
											</span>
											<StatusBadge
												status={e.status.replace(/^email\./, "")}
											/>
											<span className="w-16 text-right text-xs text-muted-foreground tabular-nums">
												{formatAgo(e.created_at)}
											</span>
										</Link>
									</li>
								))}
							</ul>
						)}
					</Card>
				</div>
			</div>
		</Page>
	);
}
