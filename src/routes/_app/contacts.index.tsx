import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	FileUp,
	MoreHorizontal,
	Plus,
	Sparkles,
	Tags,
	Trash2,
	Users,
	UsersRound,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { Confirm } from "@/components/confirm";
import { ContactsHeader } from "@/components/contacts-tabs";
import { EngagementMeter } from "@/components/engagement";
import { ListSelect, TopicDialog } from "@/components/list-dialogs";
import { Page, TableCard, TablePager } from "@/components/page";
import { Stamp } from "@/components/record";
import { RowsPending } from "@/components/route-states";
import { SearchBox } from "@/components/search-box";
import { type EditedSegment, SegmentDialog } from "@/components/segment-dialog";
import { StatusBadge } from "@/components/status-badge";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectSeparator,
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
	contactsPageFn,
	deletePropertyFn,
	deleteSegmentFn,
	deleteTopicFn,
	importContactsFn,
	saveContactFn,
	savePropertyFn,
} from "@/functions/contacts";
import { parseCsv } from "@/lib/csv";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { usePendingSearch } from "@/lib/pending";
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

const TABS = ["contacts", "segments", "topics", "properties"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/contacts/")({
	validateSearch: z.object({
		tab: z.enum(TABS).optional(),
		q: z.string().optional(),
		segment: z.string().optional(),
		brand: z.string().optional(),
		after: z.string().optional(),
	}),
	loaderDeps: ({ search }) => ({
		q: search.q,
		segment: search.segment,
		brand: search.brand,
		after: search.after,
	}),
	pendingMs: Number.POSITIVE_INFINITY,
	loader: ({ deps }) =>
		contactsPageFn({
			data: { brand: deps.brand, search: deps.q, segment: deps.segment, after: deps.after },
		}),
	head: () => ({ meta: [{ title: "Contacts · Mailroom" }] }),
	component: Contacts,
	pendingComponent: ContactsSketch,
});

type Data = Awaited<ReturnType<typeof contactsPageFn>>;

function ContactsSketch() {
	return (
		<Sketch
			data={
				{
					brand: "",
					brands: [],
					counts: { total: 0, unsubscribed: 0 },
					contacts: sample(rememberedRows("contacts", 8), (i) => ({
						object: "contact",
						id: `sketch-${i}`,
						brand_id: "",
						email: pick(i, [
							"ana@example.com",
							"luis.garcia@example.com",
							"maria@example.mx",
						]),
						first_name: pick(i, ["Ana", "Luis", null]),
						last_name: pick(i, ["García", null, "López"]),
						unsubscribed: false,
						properties: {},
						timezone: null,
						pace: null,
						paused_until: null,
						created_at: ago(60 * 24 * (i + 1)),
						updated_at: ago(60),
						engagement: null,
					})),
					next: null,
					segments: [],
					topics: [],
					properties: [],
				} satisfies Data
			}
		>
			<Contacts />
		</Sketch>
	);
}

const nameOf = (c: { first_name: string | null; last_name: string | null }) =>
	[c.first_name, c.last_name].filter(Boolean).join(" ");

function Contacts() {
	const { data, search: current } = usePage(Route);
	const { search, loading } = usePendingSearch(current);
	const navigate = Route.useNavigate();
	const me = useMe();
	const canManage = allows(me.active?.access, "contacts:edit");
	const canImport = allows(me.active?.access, "contacts:import");
	const tab: Tab = search.tab ?? "contacts";
	useRememberRows("contacts", loading ? undefined : data.contacts.length);
	useListed("contacts", data.contacts);
	const go = (next: Partial<typeof search>) =>
		navigate({ search: { ...search, after: undefined, ...next }, replace: true });
	const brand = search.brand;

	return (
		<Page>
			<Tabs
				value={tab}
				onValueChange={(v) => go({ tab: v === "contacts" ? undefined : (v as Tab) })}
				className="gap-4"
			>
				<ContactsHeader
					current={tab}
					brand={brand}
					counts={{
						contacts: data.counts.total,
						segments: data.segments.length,
						topics: data.topics.length,
						properties: data.properties.length,
					}}
					filters={
						<BrandFilter
							brands={me.brands}
							value={brand}
							all={null}
							onChange={(b) => go({ brand: b, segment: undefined })}
						/>
					}
					actions={
						<>
							<ApiDrawer
								title="Contacts in the API"
								description="Resend's Contacts, Segments, Topics and Contact Properties. Needs a full-access key."
								calls={[
									{
										title: "Add or update a contact",
										method: "POST",
										path: "/contacts",
										body: {
											email: "ana@example.com",
											first_name: "Ana",
											segments: [data.segments[0]?.id ?? "<segment id>"],
										},
									},
									{ title: "List contacts", method: "GET", path: "/contacts" },
									{ title: "List segments", method: "GET", path: "/segments" },
								]}
							/>
							{canImport && (
								<ImportContacts
									brand={brand}
									segments={data.segments}
								/>
							)}
							{canManage && <AddContact brand={brand} />}
						</>
					}
				/>
				<TabsContent
					value="contacts"
					className="flex flex-col gap-4"
				>
					<div className="flex flex-wrap items-center gap-2">
						<SearchBox
							className="basis-full sm:basis-0"
							placeholder="Search an address or name"
							value={search.q ?? ""}
							onChange={(q) => go({ q: q || undefined })}
						/>
						{data.segments.length > 0 && (
							<Select
								value={search.segment ?? "all"}
								onValueChange={(v) => go({ segment: v === "all" ? undefined : v })}
							>
								<SelectTrigger className="flex-1 sm:w-52 sm:flex-none">
									<SelectValue />
								</SelectTrigger>
								<SelectContent align="end">
									<SelectItem value="all">Every contact</SelectItem>
									<SelectSeparator />
									{data.segments.map((s) => (
										<SelectItem
											key={s.id}
											value={s.id}
										>
											<span className="truncate">{s.name}</span>
											<span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
												{s.contacts}
											</span>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						)}
					</div>
					<TableCard>
						{loading ? (
							<RowsPending rows={rememberedRows("contacts", 8)} />
						) : data.contacts.length === 0 ? (
							<Empty>
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<UsersRound />
									</EmptyMedia>
									<EmptyTitle>
										{search.q || search.segment
											? "No contact matches"
											: "No contacts yet"}
									</EmptyTitle>
									<EmptyDescription>
										{search.q || search.segment
											? "Try another search or segment."
											: "Import a CSV, add them one by one, or let your app add them with POST /contacts."}
									</EmptyDescription>
								</EmptyHeader>
								{canManage && !search.q && !search.segment && (
									<EmptyContent className="flex-row justify-center">
										<ImportContacts
											brand={brand}
											segments={data.segments}
										/>
										<AddContact brand={brand} />
									</EmptyContent>
								)}
							</Empty>
						) : (
							<>
								<Table className="table-fixed">
									<TableHeader>
										<TableRow>
											<TableHead>Contact</TableHead>
											<TableHead className="hidden w-44 md:table-cell">
												Engagement
											</TableHead>
											<TableHead className="hidden w-40 sm:table-cell">
												Status
											</TableHead>
											<TableHead className="w-24 text-right">Added</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{data.contacts.map((c) => (
											<TableRow
												key={c.id}
												className="relative"
											>
												<TableCell className="h-14">
													<span className="flex min-w-0 items-center gap-3">
														<Stamp
															icon={Users}
															tone={c.unsubscribed ? "gray" : "green"}
															className="size-7"
														/>
														<span className="min-w-0">
															<Link
																to="/contacts/$id"
																params={{ id: c.id }}
																search={{ brand }}
																className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
															>
																<Ph>{c.email}</Ph>
															</Link>
															<span className="block truncate text-xs text-muted-foreground">
																<Ph>{nameOf(c) || "No name"}</Ph>
															</span>
														</span>
													</span>
												</TableCell>
												<TableCell className="hidden md:table-cell">
													<EngagementMeter e={c.engagement} />
												</TableCell>
												<TableCell className="hidden sm:table-cell">
													<StatusBadge
														status={
															c.unsubscribed
																? "unsubscribed"
																: "ready"
														}
														label={
															c.unsubscribed
																? "Unsubscribed"
																: "Subscribed"
														}
													/>
												</TableCell>
												<TableCell
													className="text-right text-muted-foreground tabular-nums"
													title={formatDateTime(c.created_at)}
												>
													<Ph>{formatAgo(c.created_at)}</Ph>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
								{(data.next || search.after) && (
									<TablePager
										label={`${data.contacts.length} shown`}
										previousLabel="First page"
										onPrevious={search.after ? () => go({}) : undefined}
										onNext={
											data.next
												? () =>
														navigate({
															search: {
																...search,
																after: data.next ?? undefined,
															},
														})
												: undefined
										}
									/>
								)}
							</>
						)}
					</TableCard>
				</TabsContent>
				<TabsContent value="segments">
					<Segments
						data={data}
						brand={brand}
						canManage={canManage}
						onOpen={(segment) => go({ tab: undefined, segment })}
					/>
				</TabsContent>
				<TabsContent value="topics">
					<Topics
						data={data}
						brand={brand}
						canManage={canManage}
					/>
				</TabsContent>
				<TabsContent value="properties">
					<Properties
						data={data}
						brand={brand}
						canManage={canManage}
					/>
				</TabsContent>
			</Tabs>
		</Page>
	);
}

/** A row's menu with Delete (and maybe more). */
function RowMenu({ label, children }: { label: string; children: ReactNode }) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={label}
					className="relative z-10 size-8"
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">{children}</DropdownMenuContent>
		</DropdownMenu>
	);
}

function useDelete(fn: () => Promise<unknown>, done: string) {
	const router = useRouter();
	return async () => {
		try {
			await fn();
			toast.success(done);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		}
	};
}

function Segments({
	data,
	brand,
	canManage,
	onOpen,
}: {
	data: Data;
	brand?: string;
	canManage: boolean;
	onOpen: (id: string) => void;
}) {
	const [editing, setEditing] = useState<EditedSegment | null>(null);
	const [deleting, setDeleting] = useState<Data["segments"][number] | null>(null);
	const remove = useDelete(
		() => deleteSegmentFn({ data: { brand, id: deleting?.id ?? "" } }),
		"Segment deleted",
	);
	return (
		<div className="flex flex-col gap-4">
			{canManage && (
				<div className="flex justify-end">
					<Button
						variant="outline"
						onClick={() => setEditing({ name: "", rules: null })}
					>
						<Plus /> New segment
					</Button>
				</div>
			)}
			<TableCard>
				{data.segments.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<UsersRound />
							</EmptyMedia>
							<EmptyTitle>No segments yet</EmptyTitle>
							<EmptyDescription>
								A segment is a list a broadcast goes to: guests, newsletter readers,
								customers on a plan.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Segment</TableHead>
								<TableHead className="w-28 text-right">Contacts</TableHead>
								<TableHead className="hidden w-28 text-right sm:table-cell">
									Created
								</TableHead>
								{canManage && <TableHead className="w-12" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.segments.map((s) => (
								<TableRow
									key={s.id}
									className="relative"
								>
									<TableCell className="h-12 font-medium">
										<button
											type="button"
											onClick={() => onOpen(s.id)}
											className="truncate text-left outline-none after:absolute after:inset-0"
										>
											{s.name}
										</button>
										{s.live && (
											<span
												className="ml-2 inline-flex items-center gap-1 align-middle text-xs font-normal text-muted-foreground"
												title={
													s.refreshed_at
														? `Updated ${formatDateTime(s.refreshed_at)}`
														: undefined
												}
											>
												<Sparkles className="size-3" /> Live
											</span>
										)}
									</TableCell>
									<TableCell className="text-right tabular-nums">
										{s.contacts}
									</TableCell>
									<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
										{formatAgo(s.created_at)}
									</TableCell>
									{canManage && (
										<TableCell className="text-right">
											<RowMenu label={`${s.name} actions`}>
												<DropdownMenuItem
													onSelect={() =>
														setEditing({
															id: s.id,
															name: s.name,
															rules: s.rules,
														})
													}
												>
													{s.live ? "Edit rules" : "Rename"}
												</DropdownMenuItem>
												<DropdownMenuItem
													variant="destructive"
													onSelect={() => setDeleting(s)}
												>
													<Trash2 /> Delete
												</DropdownMenuItem>
											</RowMenu>
										</TableCell>
									)}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<SegmentDialog
				segment={editing}
				onOpenChange={(v) => !v && setEditing(null)}
				brand={brand}
			/>
			<Confirm
				open={!!deleting}
				onOpenChange={(v) => !v && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this segment"}?`}
				description="Its contacts stay; they're only no longer in it. Broadcasts sent to it keep their numbers."
				action="Delete segment"
				onConfirm={remove}
			/>
		</div>
	);
}

function Topics({ data, brand, canManage }: { data: Data; brand?: string; canManage: boolean }) {
	const [open, setOpen] = useState(false);
	const [deleting, setDeleting] = useState<Data["topics"][number] | null>(null);
	const remove = useDelete(
		() => deleteTopicFn({ data: { brand, id: deleting?.id ?? "" } }),
		"Topic deleted",
	);
	return (
		<div className="flex flex-col gap-4">
			{canManage && (
				<div className="flex justify-end">
					<Button
						variant="outline"
						onClick={() => setOpen(true)}
					>
						<Plus /> New topic
					</Button>
				</div>
			)}
			<TableCard>
				{data.topics.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Tags />
							</EmptyMedia>
							<EmptyTitle>No topics yet</EmptyTitle>
							<EmptyDescription>
								Topics are what people pick on the preferences page: the newsletter,
								offers, product news. A broadcast's unsubscribe link leaves only its
								topic.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Topic</TableHead>
								<TableHead className="hidden w-40 sm:table-cell">
									Who gets it
								</TableHead>
								<TableHead className="hidden w-28 md:table-cell">Shown</TableHead>
								{canManage && <TableHead className="w-12" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.topics.map((t) => (
								<TableRow key={t.id}>
									<TableCell className="h-14">
										<span className="block truncate font-medium">{t.name}</span>
										{t.description && (
											<span className="block truncate text-xs text-muted-foreground">
												{t.description}
											</span>
										)}
									</TableCell>
									<TableCell className="hidden text-muted-foreground sm:table-cell">
										{t.default_subscription === "opt_in"
											? "Who opts in"
											: "Everyone until they leave"}
									</TableCell>
									<TableCell className="hidden text-muted-foreground md:table-cell">
										{t.visibility === "public" ? "Preferences page" : "Hidden"}
									</TableCell>
									{canManage && (
										<TableCell className="text-right">
											<RowMenu label={`${t.name} actions`}>
												<DropdownMenuItem
													variant="destructive"
													onSelect={() => setDeleting(t)}
												>
													<Trash2 /> Delete
												</DropdownMenuItem>
											</RowMenu>
										</TableCell>
									)}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
			<TopicDialog
				open={open}
				onOpenChange={setOpen}
				brand={brand}
			/>
			<Confirm
				open={!!deleting}
				onOpenChange={(v) => !v && setDeleting(null)}
				title={`Delete ${deleting?.name ?? "this topic"}?`}
				description="Everyone's choices about it go too."
				action="Delete topic"
				onConfirm={remove}
			/>
		</div>
	);
}

function Properties({
	data,
	brand,
	canManage,
}: {
	data: Data;
	brand?: string;
	canManage: boolean;
}) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [key, setKey] = useState("");
	const [type, setType] = useState<"string" | "number">("string");
	const [fallback, setFallback] = useState("");
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState<Data["properties"][number] | null>(null);
	const remove = useDelete(
		() => deletePropertyFn({ data: { brand, id: deleting?.id ?? "" } }),
		"Property deleted",
	);
	return (
		<div className="flex flex-col gap-4">
			{canManage && (
				<div className="flex justify-end">
					<Button
						variant="outline"
						onClick={() => setOpen(true)}
					>
						<Plus /> New property
					</Button>
				</div>
			)}
			<TableCard>
				{data.properties.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Tags />
							</EmptyMedia>
							<EmptyTitle>No properties yet</EmptyTitle>
							<EmptyDescription>
								Your own fields on each contact (city, plan, room), written in
								templates as{" "}
								<span className="font-mono">{"{{{contact.city}}}"}</span>. A CSV's
								extra columns become properties.
							</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Property</TableHead>
								<TableHead className="w-28">Type</TableHead>
								<TableHead className="hidden w-48 sm:table-cell">
									Fallback
								</TableHead>
								{canManage && <TableHead className="w-12" />}
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.properties.map((p) => (
								<TableRow key={p.id}>
									<TableCell className="h-12">
										<span className="block truncate font-mono text-[13px]">
											{`{{{contact.${p.key}}}}`}
										</span>
									</TableCell>
									<TableCell className="text-muted-foreground">
										{p.type === "number" ? "Number" : "Text"}
									</TableCell>
									<TableCell className="hidden truncate text-muted-foreground sm:table-cell">
										{p.fallback_value ?? "—"}
									</TableCell>
									{canManage && (
										<TableCell className="text-right">
											<RowMenu label={`${p.key} actions`}>
												<DropdownMenuItem
													variant="destructive"
													onSelect={() => setDeleting(p)}
												>
													<Trash2 /> Delete
												</DropdownMenuItem>
											</RowMenu>
										</TableCell>
									)}
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
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
								await savePropertyFn({
									data: {
										brand,
										key: key.trim(),
										type,
										fallback_value: fallback || null,
									},
								});
								setOpen(false);
								setKey("");
								setFallback("");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>New property</DialogTitle>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="prop-key">Key</FieldLabel>
								<Input
									id="prop-key"
									required
									autoFocus
									className="font-mono"
									placeholder="city"
									value={key}
									onChange={(e) =>
										setKey(
											e.target.value
												.toLowerCase()
												.replace(/[^a-z0-9_]/g, "_"),
										)
									}
								/>
							</Field>
							<Field>
								<FieldLabel>Type</FieldLabel>
								<Select
									value={type}
									onValueChange={(v) => setType(v as typeof type)}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="string">Text</SelectItem>
										<SelectItem value="number">Number</SelectItem>
									</SelectContent>
								</Select>
							</Field>
							<Field>
								<FieldLabel htmlFor="prop-fallback">Fallback</FieldLabel>
								<Input
									id="prop-fallback"
									placeholder="Optional"
									value={fallback}
									onChange={(e) => setFallback(e.target.value)}
								/>
								<FieldDescription>
									Used in templates when a contact has no value.
								</FieldDescription>
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="ghost"
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !key.trim()}
							>
								{busy && <Spinner />}
								Create property
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<Confirm
				open={!!deleting}
				onOpenChange={(v) => !v && setDeleting(null)}
				title={`Delete ${deleting?.key ?? "this property"}?`}
				description="Contacts keep their values, but templates can't use it and new values are refused."
				action="Delete property"
				onConfirm={remove}
			/>
		</div>
	);
}

function AddContact({ brand }: { brand?: string }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [email, setEmail] = useState("");
	const [first, setFirst] = useState("");
	const [last, setLast] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
		>
			<Button onClick={() => setOpen(true)}>
				<Plus /> Add contact
			</Button>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const { id } = await saveContactFn({
								data: {
									brand,
									fields: {
										email,
										first_name: first || null,
										last_name: last || null,
									},
								},
							});
							setOpen(false);
							setEmail("");
							setFirst("");
							setLast("");
							await router.invalidate();
							await router.navigate({
								to: "/contacts/$id",
								params: { id },
								search: { brand },
							});
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Add contact</DialogTitle>
						<DialogDescription>
							An address already here gets the names given.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="contact-email">Email</FieldLabel>
							<Input
								id="contact-email"
								type="email"
								required
								autoFocus
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</Field>
						<div className="grid gap-5 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="contact-first">First name</FieldLabel>
								<Input
									id="contact-first"
									value={first}
									onChange={(e) => setFirst(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="contact-last">Last name</FieldLabel>
								<Input
									id="contact-last"
									value={last}
									onChange={(e) => setLast(e.target.value)}
								/>
							</Field>
						</div>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !email.trim()}
						>
							{busy && <Spinner />}
							Add contact
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** Column names that mean an address, a first and a last name (English and Spanish). */
const EMAIL_COLS = ["email", "e-mail", "correo", "correo electrónico", "email address", "mail"];
const FIRST_COLS = ["first_name", "first name", "firstname", "nombre", "name", "given name"];
const LAST_COLS = ["last_name", "last name", "lastname", "apellido", "apellidos", "surname"];

function readCsv(text: string) {
	const [head, ...rows] = parseCsv(text);
	if (!head) return null;
	const cols = head.map((h) => h.trim().toLowerCase());
	const find = (names: string[]) => cols.findIndex((c) => names.includes(c));
	let e = find(EMAIL_COLS);
	if (e < 0) e = cols.findIndex((_, i) => rows.slice(0, 5).some((r) => /@/.test(r[i] ?? "")));
	if (e < 0) return null;
	const f = find(FIRST_COLS);
	const l = find(LAST_COLS);
	const extra = cols
		.map((c, i) => ({
			i,
			key: c
				.normalize("NFD")
				.replace(/[̀-ͯ]/g, "")
				.replace(/[^a-z0-9]+/g, "_")
				.replace(/^_+|_+$/g, "")
				.replace(/^(\d)/, "p_$1"),
		}))
		.filter((c) => c.i !== e && c.i !== f && c.i !== l && c.key);
	return {
		columns: extra.map((c) => c.key),
		rows: rows.map((r) => ({
			email: (r[e] ?? "").trim(),
			first_name: f >= 0 ? r[f]?.trim() || null : null,
			last_name: l >= 0 ? r[l]?.trim() || null : null,
			properties: Object.fromEntries(extra.map((c) => [c.key, r[c.i]?.trim() || null])),
		})),
	};
}

function ImportContacts({ brand, segments }: { brand?: string; segments: Data["segments"] }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<{ name: string; parsed: ReturnType<typeof readCsv> } | null>(
		null,
	);
	const [segment, setSegment] = useState<string>("none");
	const [progress, setProgress] = useState<number | null>(null);
	const rows = file?.parsed?.rows ?? [];
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					setFile(null);
					setProgress(null);
				}
			}}
		>
			<Button
				variant="outline"
				onClick={() => setOpen(true)}
			>
				<FileUp /> Import CSV
			</Button>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						if (!rows.length) return;
						const total = { added: 0, updated: 0, skipped: 0 };
						try {
							for (let i = 0; i < rows.length; i += 1000) {
								setProgress(i / rows.length);
								const r = await importContactsFn({
									data: {
										brand,
										segment: segment === "none" ? null : segment,
										rows: rows.slice(i, i + 1000),
									},
								});
								total.added += r.added;
								total.updated += r.updated;
								total.skipped += r.skipped;
							}
							toast.success(
								`${total.added} added, ${total.updated} updated${total.skipped ? `, ${total.skipped} skipped (no valid address)` : ""}`,
							);
							setOpen(false);
							setFile(null);
							await router.invalidate();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setProgress(null);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Import contacts</DialogTitle>
						<DialogDescription>
							A CSV with an email column; first and last names (or nombre, apellido)
							are read too, and other columns become properties. Known addresses are
							updated.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="csv-file">File</FieldLabel>
							<Input
								id="csv-file"
								type="file"
								accept=".csv,text/csv"
								onChange={async (e) => {
									const f = e.target.files?.[0];
									if (!f) return setFile(null);
									setFile({ name: f.name, parsed: readCsv(await f.text()) });
								}}
							/>
							{file && (
								<FieldDescription>
									{file.parsed
										? `${rows.length.toLocaleString()} rows${
												file.parsed.columns.length
													? `; properties: ${file.parsed.columns.join(", ")}`
													: ""
											}`
										: "No email column found in this file."}
								</FieldDescription>
							)}
						</Field>
						<Field>
							<FieldLabel htmlFor="import-segment">Add them to a segment</FieldLabel>
							<ListSelect
								kind="segment"
								id="import-segment"
								brand={brand}
								value={segment === "none" ? "" : segment}
								onChange={(x) => setSegment(x || "none")}
								items={segments.filter((s) => !s.live)}
								none="No segment"
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={progress !== null || !rows.length}
						>
							{progress !== null && <Spinner />}
							{progress !== null
								? `Importing ${Math.round(progress * 100)}%`
								: `Import ${rows.length ? rows.length.toLocaleString() : ""} contacts`}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
