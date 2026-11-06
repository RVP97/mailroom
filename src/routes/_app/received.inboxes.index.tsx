import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Bot, KeyRound, MessageCircle, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { InboxMenu } from "@/components/inbox-menu";
import { Page, PageHeader, TableCard } from "@/components/page";
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
	DialogTrigger,
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { createInboxFn, listInboxesFn } from "@/functions/inboxes";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { DEFAULT_INBOX_SETTINGS } from "@/lib/inbox-settings";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { Ph, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

/** Agent inboxes: an address of its own for each agent, and the credentials that reach it. */
export const Route = createFileRoute("/_app/received/inboxes/")({
	loader: () => listInboxesFn(),
	head: () => ({ meta: [{ title: "Agent inboxes · Mailroom" }] }),
	component: InboxesPage,
	pendingComponent: InboxesSketch,
});

type Data = Awaited<ReturnType<typeof listInboxesFn>>;

function InboxesSketch() {
	const data: Data = {
		brands: [],
		own: "",
		slugs: {},
		mailroomDomain: null,
		hosts: [],
		inboxes: sample(rememberedRows("inboxes", 2), (i) => ({
			object: "inbox",
			id: `sketch-${i}`,
			brand_id: "",
			name: "Support agent",
			address: "support@example.com",
			domain_id: null,
			reply_from: null,
			send_allow: [],
			send_block: [],
			description: null,
			settings: DEFAULT_INBOX_SETTINGS,
			created_at: "",
			updated_at: "",
			credentials: 1,
			last_used_at: null,
			open: 0,
			chat: null,
		})),
	};
	return (
		<Sketch data={data}>
			<InboxesPage />
		</Sketch>
	);
}

function InboxesPage() {
	const data = usePage(Route).data;
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	useRememberRows("inboxes", data.inboxes.length);
	const names = new Map(data.brands.map((b) => [b.id, b.name]));
	const now = Date.now();
	return (
		<Page>
			<nav
				aria-label="Breadcrumb"
				className="text-sm text-muted-foreground"
			>
				<Link
					to="/received"
					className="rounded-sm transition-colors hover:text-foreground"
				>
					Received
				</Link>
			</nav>
			<PageHeader
				title="Agent inboxes"
				description="Give an agent an address of its own. Its credential reaches only that inbox: reading by default, and drafting or sending only when you grant it."
				actions={
					<>
						{canManage && <CreateInbox data={data} />}
						<ApiDrawer
							title="Inboxes in the API"
							description="Creating inboxes and credentials takes a full-access key."
							calls={[
								{ title: "List inboxes", method: "GET", path: "/inboxes" },
								{
									title: "Create an inbox",
									method: "POST",
									path: "/inboxes",
									body: { name: "Support agent", local_part: "support" },
								},
								{
									title: "Give it a credential (read-only unless you add more)",
									method: "POST",
									path: `/inboxes/${data.inboxes[0]?.id ?? "<id>"}/credentials`,
									body: { name: "Support bot", permissions: ["read", "draft"] },
								},
							]}
						/>
					</>
				}
			/>
			<TableCard>
				{data.inboxes.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<Bot />
							</EmptyMedia>
							<EmptyTitle>No agent inboxes yet</EmptyTitle>
							<EmptyDescription>
								An inbox is an address (support@ one of your receiving domains, or
								on the Mailroom address) whose conversations an agent can read and
								answer with its own credential, through the API or MCP.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<CreateInbox data={data} />
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableBody>
							{data.inboxes.map((i) => (
								<TableRow
									key={i.id}
									className="relative"
								>
									<TableCell className="py-3">
										<Link
											to="/received/inboxes/$id"
											params={{ id: i.id }}
											className="block truncate font-medium outline-none after:absolute after:inset-0 focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
										>
											<Ph>{i.name}</Ph>
										</Link>
										<span className="mt-0.5 block truncate text-sm text-muted-foreground">
											<Ph>
												{i.address}
												{names.size > 1 && names.get(i.brand_id)
													? ` · ${names.get(i.brand_id)}`
													: ""}
											</Ph>
											{i.chat && (
												<span className="ml-2 inline-flex items-center gap-1 align-middle text-xs">
													<MessageCircle className="size-3" />
													{i.chat.enabled
														? "Website chat"
														: "Website chat (off)"}
												</span>
											)}
										</span>
									</TableCell>
									<TableCell className="hidden w-32 py-3 text-sm sm:table-cell">
										<Ph>{i.open} open</Ph>
									</TableCell>
									<TableCell className="w-40 py-3 text-right text-sm">
										{i.credentials > 0 ? (
											<span
												className="text-muted-foreground"
												title={
													i.last_used_at
														? `Last used ${formatDateTime(i.last_used_at)}`
														: undefined
												}
											>
												<KeyRound className="mr-1 inline size-3.5" />
												<Ph>
													{i.credentials}
													{i.last_used_at
														? `, used ${formatAgo(i.last_used_at, now)}`
														: ", never used"}
												</Ph>
											</span>
										) : (
											<Badge variant="outline">No credential</Badge>
										)}
									</TableCell>
									<TableCell className="w-14 py-3 pr-3 text-right">
										<InboxMenu
											inbox={i}
											className="relative z-10 size-8"
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

const MAILROOM = "mailroom";

function CreateInbox({ data }: { data: Data }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [brand, setBrand] = useState(data.own);
	const [name, setName] = useState("");
	const [local, setLocal] = useState("");
	const hosts = data.hosts.filter((h) => h.brand === brand);
	const [domain, setDomain] = useState<string>(
		hosts[0]?.id ?? (data.mailroomDomain ? MAILROOM : ""),
	);
	const [busy, setBusy] = useState(false);
	const host = hosts.find((h) => h.id === domain);
	const part = local.trim().toLowerCase() || "support";
	const address = host
		? `${part}@${host.host}`
		: data.mailroomDomain
			? `${data.slugs[brand] || "brand"}+${part}@${data.mailroomDomain}`
			: "";
	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				// Picked on opening, from the page's data as it is now: the first paint (its
				// skeleton) has no domains yet, so a choice made then would skip the person's own.
				if (o) {
					const b = brand || data.own;
					setBrand(b);
					const first = data.hosts.find((h) => h.brand === b);
					setDomain(first?.id ?? (data.mailroomDomain ? MAILROOM : ""));
				}
				setOpen(o);
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus />
					Create inbox
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const inbox = await createInboxFn({
								data: {
									brand: data.brands.length ? brand : null,
									name: name.trim(),
									local_part: part,
									domain: host ? host.id : null,
								},
							});
							toast.success("Inbox created");
							setOpen(false);
							await router.navigate({
								to: "/received/inboxes/$id",
								params: { id: inbox.id },
							});
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Create an agent inbox</DialogTitle>
						<DialogDescription>
							Mail to it (and to anything+tag at it) becomes its conversations. MX
							records aren't touched: it uses a domain that already receives, or the
							Mailroom address.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						{data.brands.length > 1 && (
							<Field>
								<FieldLabel htmlFor="inbox-brand">Brand</FieldLabel>
								<Select
									value={brand}
									onValueChange={(v) => {
										setBrand(v);
										const first = data.hosts.find((h) => h.brand === v);
										setDomain(
											first?.id ?? (data.mailroomDomain ? MAILROOM : ""),
										);
									}}
								>
									<SelectTrigger id="inbox-brand">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{data.brands.map((b) => (
											<SelectItem
												key={b.id}
												value={b.id}
											>
												{b.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
						)}
						<Field>
							<FieldLabel htmlFor="inbox-name">Name</FieldLabel>
							<Input
								id="inbox-name"
								required
								placeholder="Support agent"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</Field>
						<div className="grid gap-4 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="inbox-local">Address</FieldLabel>
								<Input
									id="inbox-local"
									required
									placeholder="support"
									value={local}
									onChange={(e) => setLocal(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="inbox-domain">At</FieldLabel>
								<Select
									value={domain}
									onValueChange={setDomain}
								>
									<SelectTrigger id="inbox-domain">
										<SelectValue placeholder="No receiving domain" />
									</SelectTrigger>
									<SelectContent>
										{hosts.map((h) => (
											<SelectItem
												key={h.id}
												value={h.id}
											>
												{h.host}
											</SelectItem>
										))}
										{data.mailroomDomain && (
											<SelectItem value={MAILROOM}>
												{data.mailroomDomain} (no DNS needed)
											</SelectItem>
										)}
									</SelectContent>
								</Select>
							</Field>
						</div>
						{address && (
							<FieldDescription>
								Its address:{" "}
								<span className="font-mono text-foreground">{address}</span>
								{!host &&
									". Its replies need a From on one of your sending domains: set it on the inbox's page."}
							</FieldDescription>
						)}
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
							disabled={busy || !name.trim() || !address}
						>
							{busy ? <Spinner /> : <Plus />}
							Create inbox
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
