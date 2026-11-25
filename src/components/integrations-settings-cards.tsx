import { Check, Copy, CreditCard, GitBranch, Mail, Plus, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
	deleteBillingConnectorFn,
	listBillingConnectorsFn,
	saveBillingConnectorFn,
} from "@/functions/billing-connectors";
import { listWebhookIntegrationsFn, saveWebhookIntegrationFn } from "@/functions/issue-links";
import {
	getBrandTransportFn,
	importContactsBundleFn,
	importHelpArticlesBundleFn,
	saveBrandTransportFn,
} from "@/functions/platform";
import {
	BILLING_PROVIDER_LABELS,
	BILLING_PROVIDERS,
	type BillingProvider,
} from "@/lib/billing-providers";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { TRANSPORT_LABELS, TRANSPORT_PROVIDERS, type TransportProvider } from "@/lib/transports";

function CopyUrlButton({ value }: { value: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			className="h-6 px-1.5 text-xs"
			onClick={async () => {
				await navigator.clipboard?.writeText(value).catch(() => {});
				setCopied(true);
				toast.success("Webhook URL copied");
				setTimeout(() => setCopied(false), 1400);
			}}
		>
			{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			Copy URL
		</Button>
	);
}

/** 1. Stripe / Polar / Lemon Squeezy zero-glue billing webhook sync. */
export function BillingConnectorsCard({ canEdit }: { canEdit: boolean }) {
	const [rows, setRows] = useState<
		Awaited<ReturnType<typeof listBillingConnectorsFn>>["connectors"] | null
	>(null);
	const [adding, setAdding] = useState(false);
	const [provider, setProvider] = useState<BillingProvider>("stripe");
	const [name, setName] = useState("Production Stripe");
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		if (!canEdit) return;
		try {
			const res = await listBillingConnectorsFn();
			setRows(res.connectors);
		} catch {
			setRows([]);
		}
	}, [canEdit]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!canEdit) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<CreditCard className="size-4 text-muted-foreground" />
					Billing sync (Stripe, Polar &amp; Lemon Squeezy)
				</CardTitle>
				<CardDescription>
					Automatically sync paying customers to Contacts &amp; Companies and fire{" "}
					<code>billing.*</code> events (with revenue attribution) to power dunning,
					onboarding, and churn win-back automations.
				</CardDescription>
				<CardAction>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setAdding(true)}
					>
						<Plus />
						Connect billing
					</Button>
				</CardAction>
			</CardHeader>
			<CardContent>
				{rows === null ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> Loading…
					</div>
				) : rows.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No billing connectors yet. Add Stripe, Polar, or Lemon Squeezy to sync
						plans, MRR, and billing events automatically with zero backend glue code.
					</p>
				) : (
					<div className="divide-y divide-border/70 rounded-lg border border-border/70">
						{rows.map((r) => (
							<div
								key={r.id}
								className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium">{r.name}</span>
										<Badge variant="outline">
											{BILLING_PROVIDER_LABELS[r.provider]}
										</Badge>
										<span className="text-xs text-muted-foreground tabular-nums">
											{r.events_processed} events
											{r.last_event_at
												? ` · last ${formatRelative(r.last_event_at)}`
												: ""}
										</span>
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-2">
										<code className="truncate font-mono text-xs text-muted-foreground">
											{r.webhook_url}
										</code>
										<CopyUrlButton value={r.webhook_url} />
									</div>
									{r.last_error && (
										<p className="mt-1 text-xs text-destructive">
											{r.last_error}
										</p>
									)}
								</div>
								<Button
									variant="ghost"
									size="icon"
									aria-label={`Delete ${r.name}`}
									onClick={async () => {
										try {
											await deleteBillingConnectorFn({ data: { id: r.id } });
											toast.success("Connector removed");
											await load();
										} catch (error) {
											toast.error(await errorMessage(error));
										}
									}}
								>
									<Trash2 className="size-4" />
								</Button>
							</div>
						))}
					</div>
				)}
			</CardContent>
			<Dialog
				open={adding}
				onOpenChange={setAdding}
			>
				<DialogContent className="sm:max-w-md">
					<form
						className="contents"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							try {
								await saveBillingConnectorFn({
									data: {
										provider,
										name: name.trim(),
										signing_secret: secret.trim(),
									},
								});
								toast.success("Billing connector saved — copy its webhook URL");
								setSecret("");
								setAdding(false);
								await load();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						<DialogHeader>
							<DialogTitle>Connect billing webhook</DialogTitle>
							<DialogDescription>
								Paste your signing secret (e.g. <code>whsec_…</code>). After saving,
								copy the generated Mailroom webhook URL into your provider.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="gap-4">
							<Field>
								<FieldLabel htmlFor="bc-prov">Provider</FieldLabel>
								<Select
									value={provider}
									onValueChange={(v) => setProvider(v as BillingProvider)}
								>
									<SelectTrigger id="bc-prov">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{BILLING_PROVIDERS.map((p) => (
											<SelectItem
												key={p}
												value={p}
											>
												{BILLING_PROVIDER_LABELS[p]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
							<Field>
								<FieldLabel htmlFor="bc-name">Name</FieldLabel>
								<Input
									id="bc-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="bc-sec">Webhook signing secret</FieldLabel>
								<Input
									id="bc-sec"
									type="password"
									value={secret}
									onChange={(e) => setSecret(e.target.value)}
									placeholder="whsec_…"
								/>
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setAdding(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								disabled={busy || !name.trim() || secret.trim().length < 6}
							>
								{busy && <Spinner />}
								Save connector
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</Card>
	);
}

/** 2. GitHub, Linear & Two-Way Slack inbound webhook signing secrets. */
export function IssueAndSlackSyncCard({ canEdit }: { canEdit: boolean }) {
	const [items, setItems] = useState<Awaited<
		ReturnType<typeof listWebhookIntegrationsFn>
	> | null>(null);
	const [secrets, setSecrets] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState<string | null>(null);

	const load = useCallback(async () => {
		if (!canEdit) return;
		try {
			setItems(await listWebhookIntegrationsFn());
		} catch {
			setItems([]);
		}
	}, [canEdit]);

	useEffect(() => {
		void load();
	}, [load]);

	if (!canEdit) return null;

	const LABELS = {
		github: {
			name: "GitHub Issues",
			desc: "Auto-reopen linked conversations & post a note when a GitHub issue closes.",
		},
		linear: {
			name: "Linear Issues",
			desc: "Auto-reopen linked conversations & post a note when a Linear issue ships.",
		},
		slack: {
			name: "Two-way Slack replies",
			desc: "Reply from Slack by referencing a conversation id (conv_…) to answer live chats or add notes.",
		},
	} as const;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<GitBranch className="size-4 text-muted-foreground" />
					GitHub, Linear &amp; two-way Slack sync
				</CardTitle>
				<CardDescription>
					Verify inbound webhooks from GitHub, Linear, and Slack Events API so issue
					closures and Slack replies sync straight into your Inbox.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3">
				{items === null ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner /> Loading…
					</div>
				) : (
					items.map((item) => {
						const meta = LABELS[item.kind];
						return (
							<div
								key={item.kind}
								className="space-y-2 rounded-lg border border-border/70 p-3.5"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div>
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">{meta.name}</span>
											{item.configured ? (
												<Badge variant="default">
													Connected ({item.secret_hint})
												</Badge>
											) : (
												<Badge variant="secondary">Not configured</Badge>
											)}
										</div>
										<p className="mt-0.5 text-xs text-muted-foreground">
											{meta.desc}
										</p>
									</div>
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<code className="truncate rounded bg-muted px-2 py-1 font-mono text-[11px]">
										{item.webhook_url}
									</code>
									<CopyUrlButton value={item.webhook_url} />
								</div>
								<div className="flex flex-wrap items-center gap-2">
									<Input
										type="password"
										className="h-8 max-w-xs text-xs"
										placeholder={
											item.configured
												? `Replace signing secret (${item.secret_hint})`
												: "Paste webhook signing secret"
										}
										value={secrets[item.kind] ?? ""}
										onChange={(e) =>
											setSecrets((s) => ({
												...s,
												[item.kind]: e.target.value,
											}))
										}
									/>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={
											saving === item.kind ||
											(secrets[item.kind] ?? "").trim().length < 6
										}
										onClick={async () => {
											setSaving(item.kind);
											try {
												await saveWebhookIntegrationFn({
													data: {
														kind: item.kind,
														secret: (secrets[item.kind] ?? "").trim(),
														enabled: true,
													},
												});
												setSecrets((s) => ({ ...s, [item.kind]: "" }));
												toast.success(`${meta.name} signing secret saved`);
												await load();
											} catch (error) {
												toast.error(await errorMessage(error));
											} finally {
												setSaving(null);
											}
										}}
									>
										{saving === item.kind && <Spinner className="size-3" />}
										Save secret
									</Button>
								</div>
							</div>
						);
					})
				)}
			</CardContent>
		</Card>
	);
}

/** 3. Pluggable sending transport per brand (Amazon SES default, or Resend / Postmark starter). */
export function SendingTransportCard({ canEdit }: { canEdit: boolean }) {
	const [provider, setProvider] = useState<TransportProvider>("ses");
	const [hint, setHint] = useState<string | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!canEdit) return;
		getBrandTransportFn()
			.then((t) => {
				setProvider(t.provider);
				setHint(t.api_key_hint);
			})
			.catch(() => {});
	}, [canEdit]);

	if (!canEdit) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Mail className="size-4 text-muted-foreground" />
					Email transport
				</CardTitle>
				<CardDescription>
					Amazon SES is the default ($0.10 / 1,000 emails). Need to start sending in 2
					minutes while waiting for SES production approval? Plug in a Resend or Postmark
					key here — all templates, logs, tracking, and inbox features work identically.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="tr-prov">Provider</FieldLabel>
						<Select
							value={provider}
							onValueChange={(v) => setProvider(v as TransportProvider)}
						>
							<SelectTrigger id="tr-prov">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TRANSPORT_PROVIDERS.map((p) => (
									<SelectItem
										key={p}
										value={p}
									>
										{TRANSPORT_LABELS[p]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					{provider !== "ses" && (
						<Field>
							<FieldLabel htmlFor="tr-key">API key</FieldLabel>
							<Input
								id="tr-key"
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={
									hint ? `Saved (${hint}) — paste to replace` : "Paste API key"
								}
							/>
							<FieldDescription>Encrypted with AES-GCM at rest.</FieldDescription>
						</Field>
					)}
				</div>
				<Button
					type="button"
					size="sm"
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							const saved = await saveBrandTransportFn({
								data: {
									provider,
									...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
									enabled: provider !== "ses",
								},
							});
							setHint(saved.api_key_hint);
							setApiKey("");
							toast.success(
								provider === "ses"
									? "Switched back to Amazon SES"
									: `Active transport: ${provider}`,
							);
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy && <Spinner />}
					Save transport
				</Button>
			</CardContent>
		</Card>
	);
}

/** 4. One-click Migration Importers (Mailchimp / Beehiiv / Loops / Resend / Intercom). */
export function MigrationImporterCard({ canEdit }: { canEdit: boolean }) {
	const [kind, setKind] = useState<"contacts" | "articles">("contacts");
	const [content, setContent] = useState("");
	const [busy, setBusy] = useState(false);

	if (!canEdit) return null;

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Upload className="size-4 text-muted-foreground" />
					One-click migration importer
				</CardTitle>
				<CardDescription>
					Switching from Mailchimp, Beehiiv, Loops, Resend, or Intercom? Paste a CSV or
					JSON export to import Contacts (+ auto-create B2B Companies) or Help Center
					articles immediately.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="flex gap-2">
					<Button
						type="button"
						size="sm"
						variant={kind === "contacts" ? "default" : "outline"}
						onClick={() => setKind("contacts")}
					>
						Contacts (CSV / JSON)
					</Button>
					<Button
						type="button"
						size="sm"
						variant={kind === "articles" ? "default" : "outline"}
						onClick={() => setKind("articles")}
					>
						Help Center articles (JSON)
					</Button>
				</div>
				<Textarea
					rows={6}
					className="font-mono text-xs"
					value={content}
					onChange={(e) => setContent(e.target.value)}
					placeholder={
						kind === "contacts"
							? "email,first_name,last_name,company,plan\nana@acme.com,Ana,Lopez,Acme Corp,Enterprise"
							: '[{"title":"How billing works","category":"Billing","body":"<p>Manage invoices in Settings.</p>"}]'
					}
				/>
				<Button
					type="button"
					size="sm"
					disabled={busy || !content.trim()}
					onClick={async () => {
						setBusy(true);
						try {
							if (kind === "contacts") {
								const trimmed = content.trim();
								const source =
									trimmed.startsWith("[") || trimmed.startsWith("{")
										? "json"
										: "csv";
								const res = await importContactsBundleFn({
									data: { source, content: trimmed },
								});
								toast.success(
									`Imported ${res.imported} contact${res.imported === 1 ? "" : "s"}${res.companies_synced ? ` and synced ${res.companies_synced} companies` : ""}`,
								);
							} else {
								const res = await importHelpArticlesBundleFn({
									data: { content: content.trim(), publish: false },
								});
								toast.success(
									`Imported ${res.imported} Help Center draft${res.imported === 1 ? "" : "s"}`,
								);
							}
							setContent("");
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy && <Spinner />}
					Run import
				</Button>
			</CardContent>
		</Card>
	);
}
