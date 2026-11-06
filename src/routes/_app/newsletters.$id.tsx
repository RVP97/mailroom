import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ExternalLink,
	Gift,
	Globe,
	Newspaper,
	Plus,
	RefreshCw,
	Rss,
	Trash2,
	Trophy,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { BroadcastStatus } from "@/components/broadcast-status";
import { Confirm } from "@/components/confirm";
import { CopyButton } from "@/components/copy";
import { SwitchRow } from "@/components/design-controls";
import { ListSelect } from "@/components/list-dialogs";
import { LookEditor } from "@/components/newsletter-look-editor";
import { Page, Section, TableCard } from "@/components/page";
import { RecordHeader } from "@/components/record";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createBroadcastFn } from "@/functions/broadcasts";
import {
	checkFeedFn,
	deleteNewsletterFn,
	newsletterPageFn,
	saveNewsletterFn,
} from "@/functions/newsletters";
import { errorMessage } from "@/lib/errors";
import { formatAgo, formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { DEFAULT_LOOK, type Look } from "@/lib/newsletter-look";
import { allows } from "@/lib/permissions";
import { Ph, Sketch, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

const TABS = ["issues", "settings", "page", "referrals"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/newsletters/$id")({
	validateSearch: z.object({ tab: z.enum(TABS).optional().catch(undefined) }),
	loader: ({ params }) => newsletterPageFn({ data: { id: params.id } }),
	head: () => ({ meta: [{ title: "Newsletter · Mailroom" }] }),
	component: NewsletterPage,
	pendingComponent: NewsletterSketch,
});

type Data = Awaited<ReturnType<typeof newsletterPageFn>>;
type N = Data["newsletter"];

function NewsletterSketch() {
	return (
		<Sketch
			data={
				{
					newsletter: {
						object: "newsletter",
						id: "",
						brand_id: "",
						name: "Newsletter",
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
					},
					brand: null,
					segments: [],
					topics: [],
					forms: [],
					domains: [],
					templates: [],
					issues: [],
					leaderboard: [],
					referrals: { referred: 0, referrers: 0 },
					brand_logo: false,
				} satisfies Data
			}
		>
			<NewsletterPage />
		</Sketch>
	);
}

type Reward = { count: number; reward: string; template_id: string | null };
type Form = {
	name: string;
	slug: string;
	description: string;
	segment_id: string;
	topic_id: string;
	from: string;
	form_id: string;
	public: boolean;
	accent: string;
	rss_url: string;
	rss_mode: "draft" | "send";
	rss_style: "full" | "compact" | "titles";
	rss_intro: string;
	look: Look;
	referrals: boolean;
	referral_rewards: Reward[];
};

const formOf = (n: N): Form => ({
	name: n.name,
	slug: n.slug,
	description: n.description ?? "",
	segment_id: n.segment_id ?? "",
	topic_id: n.topic_id ?? "",
	from: n.from,
	form_id: n.form_id ?? "",
	public: n.public,
	accent: n.accent ?? "",
	rss_url: n.rss_url ?? "",
	rss_mode: n.rss_mode,
	rss_style: n.rss_style,
	rss_intro: n.rss_intro ?? "",
	look: n.look,
	referrals: n.referrals,
	referral_rewards: n.referral_rewards.map((r) => ({
		count: r.count,
		reward: r.reward,
		template_id: r.template_id ?? null,
	})),
});

const toFields = (f: Form) => ({
	name: f.name.trim(),
	slug: f.slug.trim(),
	description: f.description.trim() || null,
	segment_id: f.segment_id || null,
	topic_id: f.topic_id || null,
	from: f.from.trim() || null,
	form_id: f.form_id || null,
	public: f.public,
	accent: f.accent || null,
	rss_url: f.rss_url.trim() || null,
	rss_mode: f.rss_mode,
	rss_style: f.rss_style,
	rss_intro: f.rss_intro.trim() || null,
	look: {
		...f.look,
		links: f.look.links
			.map((l) => ({ label: l.label.trim(), url: l.url.trim() }))
			.filter((l) => l.label && l.url),
		words: Object.fromEntries(
			Object.entries(f.look.words)
				.map(([k, v]) => [k, (v ?? "").trim()])
				.filter(([, v]) => v),
		),
	},
	referrals: f.referrals,
	referral_rewards: f.referral_rewards.filter((r) => r.reward.trim() && r.count > 0),
});

const rate = (n: number, of: number) => (of ? `${((n / of) * 100).toFixed(1)}%` : "–");

function NewsletterPage() {
	const { data, search } = usePage(Route);
	const n = data.newsletter;
	const router = useRouter();
	const navigate = useNavigate();
	const tab: Tab = search.tab ?? "issues";
	const setTab = (t: string) =>
		navigate({
			to: ".",
			search: (s: Record<string, unknown>) => ({
				...s,
				tab: t === "issues" ? undefined : (t as Tab),
			}),
			replace: true,
			resetScroll: false,
		});
	const me = useMe();
	const canManage = allows(me.active?.access, "newsletters:edit");
	const [form, setForm] = useState<Form>(() => formOf(n));
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved newsletter changes
	useEffect(() => setForm(formOf(n)), [n.updated_at, n.id]);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	const dirty = JSON.stringify(toFields(form)) !== JSON.stringify(toFields(formOf(n)));
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [checking, setChecking] = useState(false);
	const [creating, setCreating] = useState(false);

	const save = async () => {
		setBusy(true);
		try {
			await saveNewsletterFn({ data: { id: n.id, fields: toFields(form) } });
			toast.success("Newsletter saved");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const newIssue = async () => {
		setCreating(true);
		try {
			const { id } = await createBroadcastFn({
				data: { brand: n.brand_id, newsletter: n.id },
			});
			await router.navigate({ to: "/broadcasts/$id", params: { id } });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setCreating(false);
		}
	};

	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/newsletters"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Newsletters
					</Link>
				</nav>
				<RecordHeader
					icon={Newspaper}
					tone="blue"
					kind={data.brand ? `Newsletter of ${data.brand.name}` : "Newsletter"}
					title={n.name}
					actions={
						<>
							{n.public && (
								<Button
									variant="outline"
									asChild
								>
									<a
										href={n.url}
										target="_blank"
										rel="noreferrer"
									>
										<ExternalLink />
										<span className="hidden sm:inline">Public page</span>
									</a>
								</Button>
							)}
							{canManage && (
								<Button
									variant="outline"
									className="hidden sm:inline-flex"
									disabled={!dirty || busy}
									onClick={save}
								>
									{busy && <Spinner />}
									Save
								</Button>
							)}
							{canManage && (
								<Button
									disabled={creating}
									onClick={newIssue}
								>
									{creating ? <Spinner /> : <Plus />}
									New issue
								</Button>
							)}
						</>
					}
				/>
			</div>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this newsletter?"
				description="Its public page goes away. Its issues stay, as broadcasts on their own."
				action="Delete newsletter"
				onConfirm={async () => {
					try {
						await deleteNewsletterFn({ data: { id: n.id } });
						toast.success("Newsletter deleted");
						await router.navigate({ to: "/newsletters" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Tabs
				value={tab}
				onValueChange={setTab}
				className="gap-6"
			>
				<div className="-mx-1 overflow-x-auto border-b border-border/70 px-1">
					<TabsList variant="line">
						<TabsTrigger value="issues">
							Issues
							<span className="text-muted-foreground tabular-nums">
								{data.issues.length}
							</span>
						</TabsTrigger>
						<TabsTrigger value="settings">Settings</TabsTrigger>
						<TabsTrigger value="page">Public page</TabsTrigger>
						<TabsTrigger value="referrals">
							Referrals
							{n.referrals && data.referrals.referred > 0 && (
								<span className="text-muted-foreground tabular-nums">
									{data.referrals.referred}
								</span>
							)}
						</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent
					value="issues"
					className="flex flex-col gap-6"
				>
					<Issues data={data} />
				</TabsContent>

				<TabsContent value="settings">
					<div className="grid items-start gap-6 lg:grid-cols-2">
						<Card className="gap-5 p-5">
							<h2 className="font-semibold">About it</h2>
							<Field>
								<FieldLabel htmlFor="n-name">Name</FieldLabel>
								<Input
									id="n-name"
									disabled={!canManage}
									value={form.name}
									onChange={(e) => set("name", e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="n-desc">Description</FieldLabel>
								<Textarea
									id="n-desc"
									rows={2}
									disabled={!canManage}
									placeholder="News, offers and what's on in town, once a month."
									value={form.description}
									onChange={(e) => set("description", e.target.value)}
								/>
								<FieldDescription>
									Under its name on the public page.
								</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor="n-slug">Address</FieldLabel>
								<div className="flex items-center gap-1.5">
									<span className="text-sm text-muted-foreground">/n/</span>
									<Input
										id="n-slug"
										spellCheck={false}
										disabled={!canManage}
										value={form.slug}
										onChange={(e) =>
											set(
												"slug",
												e.target.value
													.toLowerCase()
													.replace(/[^a-z0-9-]/g, "-"),
											)
										}
									/>
								</div>
							</Field>
							<SwitchRow
								label="Public page"
								hint="Past issues and the sign-up form on the web, with an RSS feed."
								checked={form.public}
								onChange={(v) => canManage && set("public", v)}
							/>
						</Card>

						<Card className="gap-5 p-5">
							<h2 className="font-semibold">Issues go</h2>
							<Field>
								<FieldLabel htmlFor="n-segment">To</FieldLabel>
								<ListSelect
									kind="segment"
									id="n-segment"
									brand={n.brand_id}
									value={form.segment_id}
									onChange={(v) => set("segment_id", v)}
									items={data.segments.map((s) => ({
										id: s.id,
										name: `${s.name} (${(s.contacts ?? 0).toLocaleString()})`,
									}))}
									none="Pick a segment"
									disabled={!canManage}
								/>
								<FieldDescription>
									New issues start with it; each can pick another.
								</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor="n-topic">Topic</FieldLabel>
								<ListSelect
									kind="topic"
									id="n-topic"
									brand={n.brand_id}
									value={form.topic_id}
									onChange={(v) => set("topic_id", v)}
									items={data.topics}
									none="None"
									disabled={!canManage}
								/>
								<FieldDescription>
									Its unsubscribe link leaves only this newsletter.
								</FieldDescription>
							</Field>
							<Field>
								<FieldLabel htmlFor="n-from">From</FieldLabel>
								<Input
									id="n-from"
									spellCheck={false}
									list="n-from-domains"
									disabled={!canManage}
									placeholder={`${data.brand?.name ?? "News"} <news@${data.domains[0] ?? "your-domain.com"}>`}
									value={form.from}
									onChange={(e) => set("from", e.target.value)}
								/>
								<datalist id="n-from-domains">
									{data.domains.map((d) => (
										<option
											key={d}
											value={`${data.brand?.name ?? "News"} <news@${d}>`}
										/>
									))}
								</datalist>
							</Field>
							<Field>
								<FieldLabel htmlFor="n-form">Sign-up form</FieldLabel>
								<Select
									value={form.form_id || "none"}
									onValueChange={(v) => set("form_id", v === "none" ? "" : v)}
									disabled={!canManage}
								>
									<SelectTrigger id="n-form">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">None</SelectItem>
										{data.forms.map((f) => (
											<SelectItem
												key={f.id}
												value={f.id}
											>
												{f.name}
												{f.enabled ? "" : " (off)"}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<FieldDescription>
									On the public page, and where referral links lead.{" "}
									<Link
										to="/contacts/forms"
										className="underline underline-offset-2"
									>
										Sign-up forms
									</Link>
								</FieldDescription>
							</Field>
						</Card>

						<Card className="gap-5 p-5">
							<div className="flex items-start gap-3">
								<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/12 text-orange-600 dark:text-orange-400">
									<Rss className="size-[18px]" />
								</span>
								<div className="min-w-0">
									<h2 className="font-semibold">RSS to email</h2>
									<p className="mt-0.5 text-sm text-muted-foreground">
										Mailroom reads your blog's feed every hour, and its new
										posts become an issue. The posts already there when you add
										it are never sent.
									</p>
								</div>
							</div>
							<Field>
								<FieldLabel htmlFor="n-rss">Feed address</FieldLabel>
								<Input
									id="n-rss"
									spellCheck={false}
									disabled={!canManage}
									placeholder="https://blog.example.com/feed.xml"
									value={form.rss_url}
									onChange={(e) => set("rss_url", e.target.value)}
								/>
							</Field>
							{form.rss_url && (
								<Field>
									<FieldLabel htmlFor="n-rss-mode">New posts</FieldLabel>
									<Select
										value={form.rss_mode}
										onValueChange={(v) =>
											set("rss_mode", v as "draft" | "send")
										}
										disabled={!canManage}
									>
										<SelectTrigger id="n-rss-mode">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="draft">
												Become a draft issue to review and send
											</SelectItem>
											<SelectItem value="send">
												Are sent right away
											</SelectItem>
										</SelectContent>
									</Select>
								</Field>
							)}
							{form.rss_url && (
								<Field>
									<FieldLabel>How the posts look</FieldLabel>
									<div className="grid grid-cols-3 gap-2">
										{(
											[
												[
													"full",
													"Full",
													"Picture, title, summary and a button",
												],
												[
													"compact",
													"Compact",
													"Small picture beside each title",
												],
												["titles", "Titles", "A list of linked titles"],
											] as const
										).map(([v, label, hint]) => (
											<button
												key={v}
												type="button"
												disabled={!canManage}
												aria-pressed={form.rss_style === v}
												onClick={() => set("rss_style", v)}
												className="flex flex-col gap-2 rounded-lg border border-border/80 p-2.5 text-left transition-colors hover:border-foreground/30 aria-pressed:border-primary aria-pressed:bg-muted/50 aria-pressed:ring-2 aria-pressed:ring-primary/25"
											>
												<RssSketch kind={v} />
												<span className="text-sm font-medium">{label}</span>
												<span className="text-xs leading-snug text-muted-foreground">
													{hint}
												</span>
											</button>
										))}
									</div>
								</Field>
							)}
							{form.rss_url && (
								<Field>
									<FieldLabel htmlFor="n-rss-intro">Opening line</FieldLabel>
									<Input
										id="n-rss-intro"
										disabled={!canManage}
										placeholder="Here's what's new on the blog this week."
										value={form.rss_intro}
										onChange={(e) => set("rss_intro", e.target.value)}
									/>
									<FieldDescription>
										Above the posts. Issues use this newsletter's color and
										fonts, and stay editable when they're drafts.
									</FieldDescription>
								</Field>
							)}
							{n.rss_url && (
								<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 px-3.5 py-2.5 text-sm">
									<span
										className={
											n.rss_error
												? "text-destructive"
												: "text-muted-foreground"
										}
									>
										{n.rss_error ??
											(n.rss_checked_at
												? `Read ${formatAgo(n.rss_checked_at, Date.now())}`
												: "Not read yet")}
									</span>
									{canManage && (
										<Button
											variant="outline"
											size="sm"
											disabled={checking || dirty}
											title={dirty ? "Save first" : undefined}
											onClick={async () => {
												setChecking(true);
												try {
													const r = await checkFeedFn({
														data: { id: n.id },
													});
													if (r.error) toast.error(r.error);
													else if (r.broadcast_id) {
														toast.success(
															"New posts: an issue is ready",
														);
														await router.navigate({
															to: "/broadcasts/$id",
															params: { id: r.broadcast_id },
														});
														return;
													} else
														toast.success(
															`Read: ${r.seen} posts, nothing new to send`,
														);
													await router.invalidate();
												} catch (error) {
													toast.error(await errorMessage(error));
												} finally {
													setChecking(false);
												}
											}}
										>
											{checking ? <Spinner /> : <RefreshCw />}
											Read now
										</Button>
									)}
								</div>
							)}
						</Card>
					</div>
				</TabsContent>

				<TabsContent value="referrals">
					<Referrals
						form={form}
						set={set}
						data={data}
						canManage={canManage}
					/>
				</TabsContent>

				<TabsContent value="page">
					{form.public ? (
						<Section
							title="How the public page looks"
							description="Its logo, cover, colors and fonts. Issues on the web, poll results and the referral page wear the same."
						>
							<LookEditor
								id={n.id}
								look={form.look}
								accent={form.accent}
								onLook={(l) => set("look", l)}
								onAccent={(v) => set("accent", v)}
								disabled={!canManage}
								brandLogo={data.brand_logo}
								fields={{
									name: form.name,
									description: form.description,
									accent: form.accent,
									form_id: form.form_id,
									look: toFields(form).look,
								}}
							/>
						</Section>
					) : (
						<Card className="items-center gap-3 px-5 py-12 text-center">
							<span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
								<Globe className="size-5" />
							</span>
							<div>
								<p className="font-medium">The public page is off</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Turn it on to put past issues and the sign-up form on the web,
									with an RSS feed, and design how it looks.
								</p>
							</div>
							{canManage && (
								<Button
									variant="outline"
									onClick={() => set("public", true)}
								>
									Turn it on
								</Button>
							)}
						</Card>
					)}
				</TabsContent>

				{canManage && tab !== "issues" && (
					<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-6">
						{tab === "settings" ? (
							<Button
								variant="outline"
								onClick={() => setDeleting(true)}
							>
								<Trash2 />
								Delete newsletter
							</Button>
						) : (
							<span />
						)}
						<Button
							disabled={!dirty || busy}
							onClick={save}
						>
							{busy && <Spinner />}
							Save changes
						</Button>
					</div>
				)}
			</Tabs>
		</Page>
	);
}

type Issue = Data["issues"][number];

/** The issues tab: how the recent ones did on average, then each one with its numbers. */
function Issues({ data }: { data: Data }) {
	const n = data.newsletter;
	const sent = data.issues.filter((x) => x.stats && x.stats.sent > 0);
	const recent = sent.slice(0, 10);
	const sum = (k: keyof NonNullable<Issue["stats"]>) =>
		recent.reduce((a, x) => a + (x.stats?.[k] ?? 0), 0);
	const total = sum("sent");
	const top = (k: "opened" | "clicked") =>
		Math.max(0, ...recent.map((x) => (x.stats ? x.stats[k] / x.stats.sent : 0)));
	const best =
		recent.length > 1
			? { opened: top("opened"), clicked: top("clicked") }
			: { opened: 2, clicked: 2 };
	const tiles: [string, string, string | null][] = [
		[
			"Issues sent",
			data.issues.length.toLocaleString(),
			data.issues[0]?.started_at
				? `latest ${formatAgo(data.issues[0].started_at, Date.now())}`
				: null,
		],
		[
			"Average reach",
			recent.length ? Math.round(total / recent.length).toLocaleString() : "–",
			"people an issue",
		],
		[
			"Open rate",
			rate(sum("opened"), total),
			recent.length ? `last ${recent.length} issues` : null,
		],
		[
			"Click rate",
			rate(sum("clicked"), total),
			recent.length ? `last ${recent.length} issues` : null,
		],
		[
			"Unsubscribed",
			sum("unsubscribed").toLocaleString(),
			total ? `${rate(sum("unsubscribed"), total)} of sent` : null,
		],
	];
	return (
		<>
			<Card className="grid grid-cols-2 gap-0 p-0 sm:grid-cols-3 lg:grid-cols-5">
				{tiles.map(([k, v, sub]) => (
					<div
						key={k}
						className="flex flex-col gap-1 border-border/70 px-5 py-4 not-last:border-r max-lg:nth-[n+4]:border-t max-sm:nth-[n+3]:border-t max-sm:even:border-r-0"
					>
						<span className="text-xs text-muted-foreground">{k}</span>
						<span className="text-xl font-semibold tabular-nums">
							<Ph>{v}</Ph>
						</span>
						{sub && (
							<span className="text-xs text-muted-foreground tabular-nums">
								<Ph>{sub}</Ph>
							</span>
						)}
					</div>
				))}
			</Card>
			<Section
				title="Issues"
				description={
					n.public
						? "Sent issues are on the public page unless one was kept off it."
						: "The public page is off: issues are only emailed."
				}
			>
				<TableCard>
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Issue</TableHead>
								<TableHead className="hidden w-32 xl:table-cell">Status</TableHead>
								<TableHead className="hidden w-24 text-right md:table-cell">
									Recipients
								</TableHead>
								<TableHead className="w-20 text-right">Opens</TableHead>
								<TableHead className="hidden w-20 text-right sm:table-cell">
									Clicks
								</TableHead>
								<TableHead className="hidden w-24 text-right lg:table-cell">
									Unsubscribed
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Sent
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.issues.length === 0 ? (
								<TableRow>
									<TableCell
										colSpan={7}
										className="h-20 text-center text-muted-foreground"
									>
										No issue sent yet. Write one with New issue.
									</TableCell>
								</TableRow>
							) : (
								data.issues.map((x) => (
									<TableRow
										key={x.id}
										className="relative"
									>
										<TableCell className="h-12">
											<Link
												to="/broadcasts/$id"
												params={{ id: x.id }}
												className="block truncate font-medium after:absolute after:inset-0"
											>
												<Ph>{x.name}</Ph>
											</Link>
											{n.public && x.web && (
												<a
													href={x.url}
													target="_blank"
													rel="noreferrer"
													className="relative z-10 block truncate text-xs text-muted-foreground hover:underline"
												>
													{x.url.replace(/^https?:\/\/[^/]+/, "")}
												</a>
											)}
										</TableCell>
										<TableCell className="hidden xl:table-cell">
											<BroadcastStatus status={x.status} />
										</TableCell>
										<TableCell className="hidden text-right tabular-nums md:table-cell">
											{(x.stats?.sent || x.queued).toLocaleString()}
										</TableCell>
										<RateCell
											n={x.stats?.opened}
											of={x.stats?.sent}
											best={best.opened}
										/>
										<RateCell
											n={x.stats?.clicked}
											of={x.stats?.sent}
											best={best.clicked}
											className="hidden sm:table-cell"
										/>
										<TableCell className="hidden text-right text-muted-foreground tabular-nums lg:table-cell">
											{x.stats ? x.stats.unsubscribed.toLocaleString() : "–"}
										</TableCell>
										<TableCell
											className="hidden text-right text-muted-foreground tabular-nums sm:table-cell"
											title={
												x.started_at
													? formatDateTime(x.started_at)
													: undefined
											}
										>
											{x.started_at
												? formatAgo(x.started_at, Date.now())
												: "—"}
										</TableCell>
									</TableRow>
								))
							)}
						</TableBody>
					</Table>
				</TableCard>
			</Section>
		</>
	);
}

/** A rate in the issues table, with a small bar, and the best of the recent issues picked out. */
function RateCell({
	n,
	of,
	best,
	className,
}: {
	n: number | undefined;
	of: number | undefined;
	best: number;
	className?: string;
}) {
	const r = n !== undefined && of ? n / of : null;
	return (
		<TableCell className={cn("text-right tabular-nums", className)}>
			{r === null ? (
				<span className="text-muted-foreground">–</span>
			) : (
				<span className="inline-flex flex-col items-end gap-1">
					<span className={cn(r > 0 && r >= best && "font-medium text-success")}>
						{(r * 100).toFixed(1)}%
					</span>
					<span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
						<span
							className="block h-full rounded-full bg-primary/60"
							style={{ width: `${Math.min(100, r * 100)}%` }}
						/>
					</span>
				</span>
			)}
		</TableCell>
	);
}

function Referrals({
	form,
	set,
	data,
	canManage,
}: {
	form: Form;
	set: <K extends keyof Form>(k: K, v: Form[K]) => void;
	data: Data;
	canManage: boolean;
}) {
	const rewards = form.referral_rewards;
	const change = (i: number, next: Partial<Reward>) =>
		set(
			"referral_rewards",
			rewards.map((r, j) => (j === i ? { ...r, ...next } : r)),
		);
	const saved = data.newsletter.referral_rewards
		.filter((r) => r.count > 0)
		.sort((a, b) => a.count - b.count);
	const reached = (count: number) => saved.filter((r) => r.count <= count).at(-1)?.reward;
	const most = data.leaderboard[0]?.referrals ?? 0;
	const [all, setAll] = useState(false);
	const tiles: [string, string, string | null][] = [
		[
			"Program",
			data.newsletter.referrals ? "On" : "Off",
			data.newsletter.referrals
				? `${saved.length} ${saved.length === 1 ? "milestone" : "milestones"}`
				: null,
		],
		["Subscribers referred", data.referrals.referred.toLocaleString(), "confirmed friends"],
		[
			"Subscribers who shared",
			data.referrals.referrers.toLocaleString(),
			"brought at least one",
		],
		[
			"Top referrer",
			most ? most.toLocaleString() : "–",
			most
				? [data.leaderboard[0]?.first_name, data.leaderboard[0]?.last_name]
						.filter(Boolean)
						.join(" ") ||
					data.leaderboard[0]?.email ||
					null
				: null,
		],
	];
	return (
		<div className="flex flex-col gap-6">
			<Card className="grid grid-cols-2 gap-0 p-0 lg:grid-cols-4">
				{tiles.map(([k, v, sub]) => (
					<div
						key={k}
						className="flex min-w-0 flex-col gap-1 border-border/70 px-5 py-4 not-last:border-r max-lg:nth-[n+3]:border-t max-lg:even:border-r-0"
					>
						<span className="text-xs text-muted-foreground">{k}</span>
						<span className="text-xl font-semibold tabular-nums">
							<Ph>{v}</Ph>
						</span>
						{sub && (
							<span className="truncate text-xs text-muted-foreground">
								<Ph>{sub}</Ph>
							</span>
						)}
					</div>
				))}
			</Card>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
				<Card className="gap-5 p-5">
					<div className="flex items-start gap-3">
						<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-600 dark:text-violet-400">
							<Gift className="size-[18px]" />
						</span>
						<div className="min-w-0">
							<h2 className="font-semibold">Referral program</h2>
							<p className="mt-0.5 text-sm text-muted-foreground">
								Each subscriber gets a share link. A friend counts once they confirm
								their subscription, and rewards go out at the milestones you set.
							</p>
						</div>
					</div>
					<SwitchRow
						label="Referrals on"
						hint={
							form.form_id
								? "Links open this newsletter's page and its sign-up form."
								: "Pick a sign-up form first: that's where links lead."
						}
						checked={form.referrals}
						onChange={(v) => canManage && set("referrals", v)}
					/>
					{form.referrals && (
						<div className="flex flex-col gap-2">
							<p className="text-sm font-medium">Rewards</p>
							{rewards.length === 0 && (
								<p className="text-sm text-muted-foreground">
									No milestones yet: referrals are only counted.
								</p>
							)}
							{rewards.map((r, i) => (
								<div
									key={i}
									className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-[4.5rem_minmax(0,1fr)_minmax(0,11rem)_auto]"
								>
									<Input
										type="number"
										min={1}
										aria-label="Referrals needed"
										disabled={!canManage}
										value={r.count}
										onChange={(e) =>
											change(i, { count: Number(e.target.value) || 0 })
										}
									/>
									<Input
										aria-label="Reward"
										placeholder="A free night"
										disabled={!canManage}
										value={r.reward}
										onChange={(e) => change(i, { reward: e.target.value })}
									/>
									<Select
										value={r.template_id ?? "none"}
										onValueChange={(v) =>
											change(i, { template_id: v === "none" ? null : v })
										}
										disabled={!canManage}
									>
										<SelectTrigger aria-label="Reward email">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">No email</SelectItem>
											{data.templates.map((t) => (
												<SelectItem
													key={t.id}
													value={t.id}
												>
													Email: {t.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Remove reward"
										disabled={!canManage}
										onClick={() =>
											set(
												"referral_rewards",
												rewards.filter((_, j) => j !== i),
											)
										}
									>
										<Trash2 />
									</Button>
								</div>
							))}
							{canManage && (
								<Button
									variant="outline"
									size="sm"
									className="self-start"
									onClick={() =>
										set("referral_rewards", [
											...rewards,
											{
												count: (rewards.at(-1)?.count ?? 0) + 3,
												reward: "",
												template_id: null,
											},
										])
									}
								>
									<Plus />
									Add a milestone
								</Button>
							)}
							<p className="text-xs text-muted-foreground">
								A milestone emails its template, filled with{" "}
								<code className="rounded bg-muted px-1">{"{{{REWARD}}}"}</code> and
								the contact's values, and starts automations waiting for the{" "}
								<code className="rounded bg-muted px-1">referral.milestone</code>{" "}
								event.
							</p>
						</div>
					)}
				</Card>
				<div className="flex flex-col gap-6">
					<Card className="gap-0 overflow-hidden p-0">
						<div className="flex items-center gap-2 border-b border-border/70 px-5 py-3.5">
							<Trophy className="size-4 text-amber-500" />
							<h2 className="font-semibold">Top referrers</h2>
						</div>
						{data.leaderboard.length === 0 ? (
							<p className="px-5 py-8 text-center text-sm text-muted-foreground">
								Nobody has brought a friend yet. Their names show here as soon as
								one does.
							</p>
						) : (
							<ol className="flex flex-col divide-y divide-border/70">
								{data.leaderboard.slice(0, all ? undefined : 8).map((c, i) => {
									const name = [c.first_name, c.last_name]
										.filter(Boolean)
										.join(" ");
									const reward = reached(c.referrals);
									return (
										<li
											key={c.id}
											className="relative flex items-center gap-3 px-5 py-2.5 text-sm hover:bg-muted/40"
										>
											<span
												className={cn(
													"flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums",
													i === 0
														? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
														: i < 3
															? "bg-muted text-foreground"
															: "text-muted-foreground",
												)}
											>
												{i + 1}
											</span>
											<span className="flex min-w-0 flex-1 flex-col">
												<Link
													to="/contacts/$id"
													params={{ id: c.id }}
													search={{ brand: data.newsletter.brand_id }}
													className="truncate font-medium after:absolute after:inset-0"
												>
													{name || c.email}
												</Link>
												<span className="truncate text-xs text-muted-foreground">
													{reward
														? `Unlocked: ${reward}`
														: name
															? c.email
															: "No reward yet"}
												</span>
											</span>
											<span className="flex w-16 shrink-0 flex-col items-end gap-1">
												<span className="font-medium tabular-nums">
													{c.referrals}
												</span>
												<span className="h-1 w-full overflow-hidden rounded-full bg-muted">
													<span
														className="block h-full rounded-full bg-amber-500/80"
														style={{
															width: `${most ? (c.referrals / most) * 100 : 0}%`,
														}}
													/>
												</span>
											</span>
										</li>
									);
								})}
							</ol>
						)}
						{data.leaderboard.length > 8 && (
							<button
								type="button"
								onClick={() => setAll((v) => !v)}
								className="border-t border-border/70 px-5 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
							>
								{all ? "Show the top 8" : `Show all ${data.leaderboard.length}`}
							</button>
						)}
					</Card>
					{form.referrals && (
						<div className="flex flex-col gap-1.5 rounded-xl border border-border/70 px-5 py-4 text-sm">
							<p className="font-medium">Put it in your issues</p>
							<p className="text-muted-foreground">
								Each subscriber gets their own. The referral page shows their count,
								what they unlock next, and buttons to share on WhatsApp, X, Facebook
								and email: link a "Share and get rewards" button to it.
							</p>
							<div className="mt-1 grid gap-1.5">
								{(
									[
										["{{{REFERRAL_PAGE_URL}}}", "Their referral page"],
										["{{{REFERRAL_URL}}}", "Their share link"],
										["{{{REFERRAL_COUNT}}}", "How many they've brought"],
									] as const
								).map(([tag, label]) => (
									<div
										key={tag}
										className="flex items-center gap-2"
									>
										<code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">
											{tag}
										</code>
										<CopyButton value={tag} />
										<span className="truncate text-xs text-muted-foreground">
											{label}
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** A thumbnail of how an issue of new posts is laid out. */
function RssSketch({ kind }: { kind: "full" | "compact" | "titles" }) {
	const bar = (w: string, strong = false) => (
		<span
			className={`block h-1 rounded-full ${strong ? "bg-foreground/50" : "bg-foreground/15"}`}
			style={{ width: w }}
		/>
	);
	return (
		<span className="flex h-16 flex-col gap-1 overflow-hidden rounded-md bg-muted/70 p-2">
			{kind === "full" && (
				<>
					<span className="block h-6 rounded-sm bg-foreground/15" />
					{bar("70%", true)}
					{bar("90%")}
					<span className="mt-0.5 block h-2 w-8 rounded-full bg-foreground/40" />
				</>
			)}
			{kind === "compact" &&
				[0, 1].map((i) => (
					<span
						key={i}
						className="flex items-center gap-1.5"
					>
						<span className="block size-5 shrink-0 rounded-sm bg-foreground/15" />
						<span className="flex flex-1 flex-col gap-1">
							{bar("80%", true)}
							{bar("100%")}
						</span>
					</span>
				))}
			{kind === "titles" &&
				[0, 1, 2].map((i) => (
					<span
						key={i}
						className="flex flex-col gap-0.5"
					>
						{bar(`${75 - i * 10}%`, true)}
						{bar("95%")}
					</span>
				))}
		</span>
	);
}
