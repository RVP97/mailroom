import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	KeyRound,
	Mail,
	MoreHorizontal,
	Plus,
	ScrollText,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { ChoiceCards } from "@/components/choice-cards";
import { Confirm } from "@/components/confirm";
import { CopyIcon, useCopy } from "@/components/copy";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
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
import { createKeyFn, deleteKeyFn, listDomainsFn, listKeysFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useOptimisticState } from "@/lib/optimistic";
import {
	ago,
	Ph,
	pick,
	rememberedRows,
	Sketch,
	sample,
	usePage,
	useRememberRows,
} from "@/lib/sketch";

export const Route = createFileRoute("/_app/api-keys")({
	loader: async () => {
		const [keys, domains] = await Promise.all([listKeysFn(), listDomainsFn()]);
		return { keys, domains };
	},
	head: () => ({ meta: [{ title: "API keys · Mailroom" }] }),
	component: ApiKeys,
	pendingComponent: ApiKeysSketch,
});

function ApiKeysSketch() {
	return (
		<Sketch
			data={{
				domains: [],
				keys: sample(rememberedRows("api-keys", 2), (i) => ({
					id: `sketch-${i}`,
					name: pick(i, ["Production", "Staging server", "Website"]),
					start: "mr_ab12",
					permission: "full",
					domain_id: null,
					last_used_at: ago(60 * 3),
					created_at: ago(60 * 24 * 30),
				})),
			}}
		>
			<ApiKeys />
		</Sketch>
	);
}

type Key = Awaited<ReturnType<typeof listKeysFn>>[number];

/** The list without the one just deleted. */
const withoutKey = (keys: Key[], id: string) => keys.filter((k) => k.id !== id);

function ApiKeys() {
	const { keys: savedKeys, domains } = usePage(Route).data;
	// A deleted key leaves the list at once; a failed delete puts it back.
	const [keys, save] = useOptimisticState(savedKeys, withoutKey);
	useRememberRows("api-keys", keys.length);
	const remove = async (k: Key) => {
		const ok = await save(k.id, () => deleteKeyFn({ data: { id: k.id } }));
		if (ok) toast.success("Key deleted");
	};
	const domainName = (id: string | null) => domains.find((d) => d.id === id)?.name;
	const now = Date.now();
	return (
		<Page>
			<PageHeader
				title="API keys"
				description="Keys send as this organization. Keep them on your servers, never in a browser or an app."
				actions={
					<>
						<ApiDrawer
							title="API keys in the API"
							description="Needs a full-access key."
							calls={[
								{ title: "List keys", method: "GET", path: "/api-keys" },
								{
									title: "Create a key",
									method: "POST",
									path: "/api-keys",
									body: { name: "Production", permission: "sending_access" },
								},
								{ title: "Delete a key", method: "DELETE", path: "/api-keys/{id}" },
							]}
						/>
						{keys.length > 0 && <CreateKey domains={domains} />}
					</>
				}
			/>
			<TableCard>
				{keys.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<KeyRound />
							</EmptyMedia>
							<EmptyTitle>Create your first API key</EmptyTitle>
							<EmptyDescription>
								Send with the API, or with Resend's SDKs pointed at Mailroom.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<CreateKey domains={domains} />
						</EmptyContent>
					</Empty>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Name</TableHead>
								<TableHead className="hidden sm:table-cell">Token</TableHead>
								<TableHead>Access</TableHead>
								<TableHead className="hidden md:table-cell">Last used</TableHead>
								<TableHead className="hidden md:table-cell">Created</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{keys.map((k) => (
								<TableRow key={k.id}>
									<TableCell className="w-full max-w-0">
										<p className="truncate font-medium">
											<Ph>{k.name}</Ph>
										</p>
										<p className="font-mono text-xs text-muted-foreground sm:hidden">
											<Ph>{k.start}…</Ph>
										</p>
									</TableCell>
									<TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
										<Ph>{k.start}…</Ph>
									</TableCell>
									<TableCell>
										<Badge
											data-ph
											variant={
												k.permission === "full" ? "brand" : "secondary"
											}
										>
											{k.permission === "full" ? "Full access" : "Sending"}
										</Badge>
										{k.permission !== "full" && domainName(k.domain_id) && (
											<span className="ml-1.5 hidden text-xs text-muted-foreground lg:inline">
												<Ph>{domainName(k.domain_id)}</Ph>
											</span>
										)}
									</TableCell>
									<TableCell
										className="hidden text-muted-foreground tabular-nums md:table-cell"
										title={
											k.last_used_at
												? formatDateTime(k.last_used_at)
												: undefined
										}
									>
										<Ph>
											{k.last_used_at
												? formatAgo(k.last_used_at, now)
												: "Never"}
										</Ph>
									</TableCell>
									<TableCell
										className="hidden text-muted-foreground tabular-nums md:table-cell"
										title={formatDateTime(k.created_at)}
									>
										<Ph>{formatAgo(k.created_at, now)}</Ph>
									</TableCell>
									<TableCell className="text-right">
										<KeyMenu
											k={k}
											onDelete={() => void remove(k)}
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

function KeyMenu({ k, onDelete }: { k: Key; onDelete: () => void }) {
	const [deleting, setDeleting] = useState(false);
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`More for ${k.name}`}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem asChild>
						<Link
							to="/logs"
							search={{ key: k.id }}
						>
							<ScrollText />
							View its logs
						</Link>
					</DropdownMenuItem>
					<DropdownMenuItem asChild>
						<Link
							to="/emails"
							search={{ key: k.id }}
						>
							<Mail />
							Emails it sent
						</Link>
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						variant="destructive"
						onSelect={() => setDeleting(true)}
					>
						<Trash2 />
						Delete key
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title={`Delete “${k.name}”?`}
				description="Anything using this key stops sending at once. This can't be undone."
				action="Delete key"
				onConfirm={onDelete}
			/>
		</>
	);
}

function CreateKey({ domains }: { domains: { id: string; name: string }[] }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [permission, setPermission] = useState<"full" | "sending">("sending");
	const [domainId, setDomainId] = useState("all");
	const [busy, setBusy] = useState(false);
	const [token, setToken] = useState<string | null>(null);
	const { copied, copy } = useCopy(2000);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					setToken(null);
					setName("");
					setPermission("sending");
					setDomainId("all");
					void router.invalidate();
				}
			}}
		>
			<DialogTrigger asChild>
				<Button>
					<Plus /> Create API key
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				{token ? (
					<>
						<DialogHeader>
							<DialogTitle>Copy your API key</DialogTitle>
							<DialogDescription>
								Store it somewhere safe, like your app's secrets. It won't be shown
								again.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<button
								type="button"
								onClick={() => copy(token)}
								className="pressable group flex w-full items-center gap-3 rounded-lg bg-muted px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--border)]"
							>
								<code className="min-w-0 flex-1 truncate font-mono text-[13px]">
									{token}
								</code>
								<span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground group-hover:text-foreground">
									<CopyIcon copied={copied} />
									{copied ? "Copied" : "Copy"}
								</span>
							</button>
							<p className="flex items-start gap-2 text-xs text-muted-foreground">
								<TriangleAlert className="mt-px size-3.5 shrink-0 text-warning" />
								Send it as{" "}
								<code className="font-mono">
									Authorization: Bearer {token.slice(0, 7)}…
								</code>
							</p>
						</DialogBody>
						<DialogFooter>
							<Button onClick={() => setOpen(false)}>Done</Button>
						</DialogFooter>
					</>
				) : (
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								const r = await createKeyFn({
									data: {
										name: name.trim(),
										permission,
										domainId:
											permission === "sending" && domainId !== "all"
												? domainId
												: null,
									},
								});
								setToken(r.token);
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>Create an API key</DialogTitle>
							<DialogDescription>
								Give each app its own key, so you can delete one without stopping
								the others.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-5">
							<Field>
								<FieldLabel htmlFor="key-name">Name</FieldLabel>
								<Input
									id="key-name"
									autoFocus
									required
									autoComplete="off"
									placeholder="Production"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>Access</FieldLabel>
								<ChoiceCards
									name="permission"
									value={permission}
									onChange={setPermission}
									options={[
										{
											value: "sending",
											title: "Sending",
											description:
												"Sends emails, nothing else. Best for apps.",
										},
										{
											value: "full",
											title: "Full access",
											description:
												"Also reads emails and manages domains, keys and webhooks.",
										},
									]}
								/>
							</Field>
							{permission === "sending" && domains.length > 0 && (
								<Field>
									<FieldLabel>Domain</FieldLabel>
									<Select
										value={domainId}
										onValueChange={setDomainId}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">
												Any domain of this organization
											</SelectItem>
											{domains.map((d) => (
												<SelectItem
													key={d.id}
													value={d.id}
												>
													Only {d.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
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
								disabled={busy || !name.trim()}
							>
								{busy && <Spinner />}
								Create key
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
