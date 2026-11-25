import {
	Activity,
	ArrowUpRight,
	BookOpen,
	Flame,
	Globe,
	MessageCircle,
	Plus,
	Trash2,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CopyField } from "@/components/copy";
import { DatePicker, dayString } from "@/components/date-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	addKnowledgeSourceFn,
	createStatusIncidentFn,
	deleteAiActionFn,
	deleteKnowledgeSourceFn,
	deleteStatusComponentFn,
	getStatusPageFn,
	listAiAgentExtrasFn,
	listOmnichannelFn,
	postIncidentUpdateFn,
	saveAiActionFn,
	saveDomainWarmupFn,
	savePublicPagesFn,
	saveStatusComponentFn,
	saveTelegramFn,
	saveWhatsAppFn,
} from "@/functions/v3-platform";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";

type OmniData = Awaited<ReturnType<typeof listOmnichannelFn>>;
type AiExtrasData = Awaited<ReturnType<typeof listAiAgentExtrasFn>>;
type StatusData = Awaited<ReturnType<typeof getStatusPageFn>>;

export function OmnichannelCard({ canEdit }: { canEdit: boolean }) {
	const [data, setData] = useState<OmniData | null>(null);
	const [waPhone, setWaPhone] = useState("");
	const [waVerify, setWaVerify] = useState("");
	const [waSecret, setWaSecret] = useState("");
	const [waToken, setWaToken] = useState("");
	const [tgUser, setTgUser] = useState("");
	const [tgToken, setTgToken] = useState("");
	const [tgSecret, setTgSecret] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await listOmnichannelFn().catch(() => null);
		if (!res) return;
		setData(res);
		setWaPhone(res.whatsapp.phone_number_id);
		setTgUser(res.telegram.bot_username);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<MessageCircle className="size-4 text-muted-foreground" />
					Omnichannel Inbox (WhatsApp &amp; Telegram)
				</CardTitle>
				<CardDescription>
					Route WhatsApp Business Cloud API and Telegram Bot messages straight into your
					3-pane Shared Inbox and reply directly from Mailroom.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-3 rounded-lg border border-border/70 p-4">
					<div className="flex items-center justify-between">
						<span className="text-sm font-medium">WhatsApp Business Cloud API</span>
						<Badge variant={data?.whatsapp.enabled ? "default" : "secondary"}>
							{data?.whatsapp.enabled ? "Connected" : "Off"}
						</Badge>
					</div>
					{data?.whatsapp.webhook_url && (
						<CopyField
							label="Meta Webhook URL"
							value={data.whatsapp.webhook_url}
						/>
					)}
					{canEdit && (
						<form
							className="grid gap-3 sm:grid-cols-2"
							onSubmit={async (e) => {
								e.preventDefault();
								setBusy("wa");
								try {
									await saveWhatsAppFn({
										data: {
											phone_number_id: waPhone.trim(),
											...(waVerify.trim()
												? { verify_token: waVerify.trim() }
												: {}),
											...(waSecret.trim()
												? { app_secret: waSecret.trim() }
												: {}),
											...(waToken.trim()
												? { access_token: waToken.trim() }
												: {}),
											enabled: true,
										},
									});
									setWaVerify("");
									setWaSecret("");
									setWaToken("");
									toast.success("WhatsApp connected");
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							<Field>
								<FieldLabel>Phone Number ID</FieldLabel>
								<Input
									required
									value={waPhone}
									placeholder="123456789012345"
									onChange={(e) => setWaPhone(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>Verify Token</FieldLabel>
								<Input
									type="password"
									required={!data?.whatsapp.configured}
									value={waVerify}
									placeholder={
										data?.whatsapp.verify_token_hint
											? `Saved (${data.whatsapp.verify_token_hint})`
											: "my_verify_token"
									}
									onChange={(e) => setWaVerify(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>App Secret</FieldLabel>
								<Input
									type="password"
									value={waSecret}
									placeholder={
										data?.whatsapp.configured
											? "Saved (leave blank to keep)"
											: "Meta App Secret"
									}
									onChange={(e) => setWaSecret(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>Permanent Access Token</FieldLabel>
								<Input
									type="password"
									value={waToken}
									placeholder={
										data?.whatsapp.secret_hint
											? `Saved (${data.whatsapp.secret_hint})`
											: "EAAG…"
									}
									onChange={(e) => setWaToken(e.target.value)}
								/>
							</Field>
							<div className="sm:col-span-2">
								<Button
									type="submit"
									size="sm"
									disabled={busy === "wa"}
								>
									{busy === "wa" && <Spinner className="size-3.5" />}
									Save WhatsApp
								</Button>
							</div>
						</form>
					)}
				</div>

				<div className="space-y-3 rounded-lg border border-border/70 p-4">
					<div className="flex items-center justify-between">
						<span className="text-sm font-medium">Telegram Bot</span>
						<Badge variant={data?.telegram.enabled ? "default" : "secondary"}>
							{data?.telegram.enabled ? "Connected" : "Off"}
						</Badge>
					</div>
					{data?.telegram.webhook_url && (
						<CopyField
							label="Telegram setWebhook URL"
							value={data.telegram.webhook_url}
						/>
					)}
					{canEdit && (
						<form
							className="grid gap-3 sm:grid-cols-3"
							onSubmit={async (e) => {
								e.preventDefault();
								setBusy("tg");
								try {
									await saveTelegramFn({
										data: {
											bot_username: tgUser.trim() || undefined,
											...(tgToken.trim()
												? { bot_token: tgToken.trim() }
												: {}),
											...(tgSecret.trim()
												? { secret_token: tgSecret.trim() }
												: {}),
											enabled: true,
										},
									});
									setTgToken("");
									setTgSecret("");
									toast.success("Telegram bot connected");
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							<Field>
								<FieldLabel>Bot Username</FieldLabel>
								<Input
									value={tgUser}
									placeholder="@AcmeSupportBot"
									onChange={(e) => setTgUser(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>Bot Token</FieldLabel>
								<Input
									type="password"
									value={tgToken}
									placeholder={
										data?.telegram.secret_hint
											? `Saved (${data.telegram.secret_hint})`
											: "123456:ABC…"
									}
									onChange={(e) => setTgToken(e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel>Webhook Secret Token</FieldLabel>
								<Input
									type="password"
									value={tgSecret}
									placeholder="X-Telegram-Bot-Api-Secret-Token"
									onChange={(e) => setTgSecret(e.target.value)}
								/>
							</Field>
							<div className="sm:col-span-3">
								<Button
									type="submit"
									size="sm"
									disabled={busy === "tg"}
								>
									{busy === "tg" && <Spinner className="size-3.5" />}
									Save Telegram
								</Button>
							</div>
						</form>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function AiKnowledgeAndActionsCard({ canEdit }: { canEdit: boolean }) {
	const [data, setData] = useState<AiExtrasData | null>(null);
	const [kind, setKind] = useState<"url" | "sitemap" | "markdown">("url");
	const [title, setTitle] = useState("");
	const [url, setUrl] = useState("");
	const [content, setContent] = useState("");
	const [actName, setActName] = useState("");
	const [actDesc, setActDesc] = useState("");
	const [actUrl, setActUrl] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await listAiAgentExtrasFn().catch(() => null);
		if (res) setData(res);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<BookOpen className="size-4 text-muted-foreground" />
					AI Agent Knowledge &amp; Custom Actions
				</CardTitle>
				<CardDescription>
					Crawl your docs URL, sitemap.xml, or paste Markdown guides so AI Copilot &amp;
					Auto-Responder answer with full context, plus attach safe HTTPS tools.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-6">
				<div className="space-y-3">
					<h4 className="text-sm font-medium">
						Knowledge Sources ({data?.sources.length ?? 0})
					</h4>
					{data?.sources.map((s) => (
						<div
							key={s.id}
							className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-xs"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2 font-medium">
									<Globe className="size-3.5 text-muted-foreground" />
									<span className="truncate">{s.title}</span>
									<Badge variant="secondary">{s.kind}</Badge>
									<span className="text-muted-foreground">
										{s.chunks_count} chunks
									</span>
								</div>
								{s.url && (
									<div className="truncate text-muted-foreground">{s.url}</div>
								)}
							</div>
							{canEdit && (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={`Delete ${s.title}`}
									onClick={async () => {
										await deleteKnowledgeSourceFn({ data: { id: s.id } });
										await load();
									}}
								>
									<Trash2 className="size-3.5" />
								</Button>
							)}
						</div>
					))}
					{canEdit && (
						<form
							className="grid gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-3"
							onSubmit={async (e) => {
								e.preventDefault();
								setBusy("ks");
								try {
									await addKnowledgeSourceFn({
										data: {
											kind,
											title: title.trim(),
											...(kind !== "markdown" ? { url: url.trim() } : {}),
											...(kind === "markdown" ? { content } : {}),
										},
									});
									setTitle("");
									setUrl("");
									setContent("");
									toast.success("Knowledge source indexed");
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							<Select
								value={kind}
								onValueChange={(v) => setKind(v as "url" | "sitemap" | "markdown")}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="url">Web Page URL</SelectItem>
									<SelectItem value="sitemap">Sitemap XML</SelectItem>
									<SelectItem value="markdown">Markdown / Text</SelectItem>
								</SelectContent>
							</Select>
							<Input
								required
								placeholder="Title (e.g. API Docs)"
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
							{kind !== "markdown" ? (
								<Input
									required
									placeholder={
										kind === "sitemap"
											? "https://docs.app.com/sitemap.xml"
											: "https://docs.app.com/pricing"
									}
									value={url}
									onChange={(e) => setUrl(e.target.value)}
								/>
							) : (
								<div className="sm:col-span-3">
									<Textarea
										required
										rows={3}
										placeholder="Paste product docs, refund policy, or FAQs…"
										value={content}
										onChange={(e) => setContent(e.target.value)}
									/>
								</div>
							)}
							<div className="sm:col-span-3">
								<Button
									type="submit"
									size="sm"
									disabled={busy === "ks"}
								>
									{busy === "ks" ? (
										<Spinner className="size-3.5" />
									) : (
										<Plus className="size-3.5" />
									)}
									Index knowledge source
								</Button>
							</div>
						</form>
					)}
				</div>

				<div className="space-y-3 border-t border-border/60 pt-4">
					<h4 className="flex items-center gap-1.5 text-sm font-medium">
						<Wrench className="size-3.5 text-muted-foreground" />
						Custom AI HTTP Actions ({data?.actions.length ?? 0})
					</h4>
					{data?.actions.map((a) => (
						<div
							key={a.id}
							className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2 text-xs"
						>
							<div className="min-w-0 flex-1">
								<div className="font-mono font-medium">
									{a.method} {a.name}
								</div>
								<div className="truncate text-muted-foreground">
									{a.description} · {a.url}
								</div>
							</div>
							{canEdit && (
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={`Delete ${a.name}`}
									onClick={async () => {
										await deleteAiActionFn({ data: { id: a.id } });
										await load();
									}}
								>
									<Trash2 className="size-3.5" />
								</Button>
							)}
						</div>
					))}
					{canEdit && (
						<form
							className="grid gap-2.5 rounded-lg border border-border/60 bg-muted/20 p-3 sm:grid-cols-3"
							onSubmit={async (e) => {
								e.preventDefault();
								setBusy("act");
								try {
									await saveAiActionFn({
										data: {
											name: actName.trim(),
											description: actDesc.trim(),
											method: "GET",
											url: actUrl.trim(),
										},
									});
									setActName("");
									setActDesc("");
									setActUrl("");
									toast.success("AI action saved");
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							<Input
								required
								placeholder="lookup_order"
								value={actName}
								onChange={(e) => setActName(e.target.value)}
							/>
							<Input
								required
								placeholder="Look up order status by email"
								value={actDesc}
								onChange={(e) => setActDesc(e.target.value)}
							/>
							<Input
								required
								placeholder="https://api.app.com/orders?email={{email}}"
								value={actUrl}
								onChange={(e) => setActUrl(e.target.value)}
							/>
							<div className="sm:col-span-3">
								<Button
									type="submit"
									size="sm"
									disabled={busy === "act"}
								>
									{busy === "act" ? (
										<Spinner className="size-3.5" />
									) : (
										<Plus className="size-3.5" />
									)}
									Add HTTP action
								</Button>
							</div>
						</form>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function StatusPageAndPortalCard({ canEdit }: { canEdit: boolean }) {
	const me = useMe();
	const slug = me.active?.slug ?? "";
	const [data, setData] = useState<StatusData | null>(null);
	const [compName, setCompName] = useState("");
	const [incTitle, setIncTitle] = useState("");
	const [incMsg, setIncMsg] = useState("");
	const [busy, setBusy] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await getStatusPageFn().catch(() => null);
		if (res) setData(res);
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Activity className="size-4 text-muted-foreground" />
					Public Status Page &amp; B2B Support Portal
				</CardTitle>
				<CardDescription>
					Post live incidents to /status/{slug || "<slug>"} (automatically displays an
					outage banner inside your Chat Widget) and give B2B customers a magic-link
					ticket portal at /portal/{slug || "<slug>"}.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-5">
				<div className="grid gap-3 rounded-lg border border-border/70 p-3 sm:grid-cols-2">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="text-xs font-medium">Public Status Page</div>
							<div className="truncate text-[11px] text-muted-foreground">
								/status/{slug || "<slug>"}
							</div>
						</div>
						<Switch
							checked={Boolean(data?.enabled)}
							disabled={!canEdit || busy === "pages"}
							onCheckedChange={async (checked) => {
								setBusy("pages");
								try {
									await savePublicPagesFn({
										data: { status_page_enabled: checked },
									});
									toast.success(
										checked ? "Status page enabled" : "Status page disabled",
									);
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						/>
					</div>
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<div className="text-xs font-medium">B2B Support Portal</div>
							<div className="truncate text-[11px] text-muted-foreground">
								/portal/{slug || "<slug>"}
							</div>
						</div>
						<Switch
							checked={Boolean(data?.portal_enabled)}
							disabled={!canEdit || busy === "pages"}
							onCheckedChange={async (checked) => {
								setBusy("pages");
								try {
									await savePublicPagesFn({ data: { portal_enabled: checked } });
									toast.success(
										checked
											? "Support portal enabled"
											: "Support portal disabled",
									);
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						/>
					</div>
				</div>

				{slug && (data?.enabled || data?.portal_enabled) && (
					<div className="flex flex-wrap gap-2">
						{data?.enabled && (
							<Button
								variant="outline"
								size="sm"
								asChild
							>
								<a
									href={`/status/${encodeURIComponent(slug)}`}
									target="_blank"
									rel="noreferrer"
								>
									Public Status Page
									<ArrowUpRight className="size-3.5" />
								</a>
							</Button>
						)}
						{data?.portal_enabled && (
							<Button
								variant="outline"
								size="sm"
								asChild
							>
								<a
									href={`/portal/${encodeURIComponent(slug)}`}
									target="_blank"
									rel="noreferrer"
								>
									B2B Support Portal
									<ArrowUpRight className="size-3.5" />
								</a>
							</Button>
						)}
					</div>
				)}

				<div className="space-y-2">
					<div className="flex items-center justify-between text-xs">
						<span className="font-medium">
							Components ({data?.components.length ?? 0})
						</span>
						<Badge
							variant={data?.overall === "operational" ? "secondary" : "destructive"}
						>
							{data?.overall?.replace(/_/g, " ") ?? "operational"}
						</Badge>
					</div>
					{data?.components.map((c) => (
						<div
							key={c.id}
							className="flex items-center justify-between rounded-md border border-border/60 px-3 py-1.5 text-xs"
						>
							<span className="font-medium">{c.name}</span>
							<div className="flex items-center gap-2">
								<Badge variant="outline">{c.status.replace(/_/g, " ")}</Badge>
								{canEdit && (
									<button
										type="button"
										aria-label={`Delete ${c.name}`}
										className="text-muted-foreground hover:text-destructive"
										onClick={async () => {
											await deleteStatusComponentFn({ data: { id: c.id } });
											await load();
										}}
									>
										<Trash2 className="size-3.5" />
									</button>
								)}
							</div>
						</div>
					))}
					{canEdit && (
						<form
							className="flex gap-2"
							onSubmit={async (e) => {
								e.preventDefault();
								if (!compName.trim()) return;
								setBusy("comp");
								try {
									await saveStatusComponentFn({
										data: { name: compName.trim(), status: "operational" },
									});
									setCompName("");
									await load();
								} catch (err) {
									toast.error(await errorMessage(err));
								} finally {
									setBusy(null);
								}
							}}
						>
							<Input
								placeholder="Add component (e.g. API, Webhooks, Dashboard)"
								value={compName}
								onChange={(e) => setCompName(e.target.value)}
							/>
							<Button
								type="submit"
								size="sm"
								disabled={busy === "comp"}
							>
								Add
							</Button>
						</form>
					)}
				</div>

				{data && data.active_incidents.length > 0 && (
					<div className="space-y-2 border-t border-border/60 pt-3">
						<span className="text-xs font-medium">Active Incidents</span>
						{data.active_incidents.map((inc) => (
							<div
								key={inc.id}
								className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
							>
								<div>
									<div className="font-medium">{inc.title}</div>
									<div className="text-muted-foreground">{inc.status}</div>
								</div>
								{canEdit && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={async () => {
											await postIncidentUpdateFn({
												data: {
													incident_id: inc.id,
													status: "resolved",
													message:
														"Issue resolved; systems are back to normal.",
												},
											});
											toast.success("Incident resolved");
											await load();
										}}
									>
										Resolve
									</Button>
								)}
							</div>
						))}
					</div>
				)}

				{canEdit && (
					<form
						className="space-y-2 border-t border-border/60 pt-3"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy("inc");
							try {
								await createStatusIncidentFn({
									data: {
										title: incTitle.trim(),
										message: incMsg.trim(),
										impact: "minor",
										status: "investigating",
									},
								});
								setIncTitle("");
								setIncMsg("");
								toast.success("Incident posted — outage banner is live");
								await load();
							} catch (err) {
								toast.error(await errorMessage(err));
							} finally {
								setBusy(null);
							}
						}}
					>
						<span className="text-xs font-medium">Report Incident</span>
						<Input
							required
							placeholder="Incident title (e.g. Elevated webhook latency)"
							value={incTitle}
							onChange={(e) => setIncTitle(e.target.value)}
						/>
						<Textarea
							required
							rows={2}
							placeholder="Initial status update…"
							value={incMsg}
							onChange={(e) => setIncMsg(e.target.value)}
						/>
						<Button
							type="submit"
							size="sm"
							variant="outline"
							disabled={busy === "inc"}
						>
							{busy === "inc" && <Spinner className="size-3.5" />}
							Post incident
						</Button>
					</form>
				)}
			</CardContent>
		</Card>
	);
}

export function DomainWarmupCard({
	domainId,
	initial,
	canManage,
}: {
	domainId: string;
	initial?: {
		enabled: boolean;
		start_date: string;
		daily_start: number;
		daily_max: number;
		ramp_days: number;
		pause_bounce_rate?: number;
	} | null;
	canManage: boolean;
}) {
	const [enabled, setEnabled] = useState(initial?.enabled ?? false);
	const [startDate, setStartDate] = useState(initial?.start_date ?? dayString(new Date()));
	const [dailyStart, setDailyStart] = useState(String(initial?.daily_start ?? 100));
	const [dailyMax, setDailyMax] = useState(String(initial?.daily_max ?? 25000));
	const [rampDays, setRampDays] = useState(String(initial?.ramp_days ?? 14));
	const [pauseBouncePct, setPauseBouncePct] = useState(
		String(Math.round((initial?.pause_bounce_rate ?? 0.03) * 1000) / 10),
	);
	const [busy, setBusy] = useState(false);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Flame className="size-4 text-muted-foreground" />
					Automated Domain Warm-Up
				</CardTitle>
				<CardDescription>
					Gradually ramp daily send volume on a new domain to build sender reputation and
					auto-hold excess mail if bounce rates spike.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form
					className="space-y-4"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const pct = Number(pauseBouncePct);
							const pauseRate = Number.isFinite(pct)
								? Math.min(0.2, Math.max(0.005, pct / 100))
								: (initial?.pause_bounce_rate ?? 0.03);
							await saveDomainWarmupFn({
								data: {
									domain_id: domainId,
									enabled,
									start_date: startDate,
									daily_start: Number(dailyStart) || 100,
									daily_max: Number(dailyMax) || 25000,
									ramp_days: Number(rampDays) || 14,
									pause_bounce_rate: pauseRate,
								},
							});
							toast.success(enabled ? "Warm-up ramp saved" : "Warm-up disabled");
						} catch (err) {
							toast.error(await errorMessage(err));
						} finally {
							setBusy(false);
						}
					}}
				>
					<div className="flex items-center justify-between">
						<span className="text-sm font-medium">Enable warm-up ramp</span>
						<Switch
							checked={enabled}
							disabled={!canManage}
							onCheckedChange={setEnabled}
						/>
					</div>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
						<Field>
							<FieldLabel>Start date</FieldLabel>
							<DatePicker
								value={startDate}
								onChange={setStartDate}
								disabled={!canManage || !enabled}
							/>
						</Field>
						<Field>
							<FieldLabel>Day 1 cap</FieldLabel>
							<Input
								type="number"
								min={10}
								disabled={!canManage || !enabled}
								value={dailyStart}
								onChange={(e) => setDailyStart(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel>Target daily max</FieldLabel>
							<Input
								type="number"
								min={50}
								disabled={!canManage || !enabled}
								value={dailyMax}
								onChange={(e) => setDailyMax(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel>Ramp days</FieldLabel>
							<Input
								type="number"
								min={3}
								max={90}
								disabled={!canManage || !enabled}
								value={rampDays}
								onChange={(e) => setRampDays(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel>Pause bounce %</FieldLabel>
							<Input
								type="number"
								step="0.5"
								min={0.5}
								max={20}
								disabled={!canManage || !enabled}
								value={pauseBouncePct}
								onChange={(e) => setPauseBouncePct(e.target.value)}
							/>
							<FieldDescription>Auto-pauses if bounces exceed this</FieldDescription>
						</Field>
					</div>
					{canManage && (
						<Button
							type="submit"
							size="sm"
							disabled={busy}
						>
							{busy && <Spinner className="size-3.5" />}
							Save warm-up
						</Button>
					)}
				</form>
			</CardContent>
		</Card>
	);
}
