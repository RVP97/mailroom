import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	ExternalLink,
	KeyRound,
	MessageCircle,
	Monitor,
	Moon,
	ShieldCheck,
	ShieldOff,
	Smartphone,
	Sun,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import { Confirm } from "@/components/confirm";
import { Choice, ColorField, Group, Labeled, SwitchRow } from "@/components/design-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
	deleteChatWidgetFn,
	getChatSettingsFn,
	rotateChatKeyFn,
	saveChatSettingsFn,
} from "@/functions/chat";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * An inbox's website chat: the widget live on a sketch of a website in the middle, and how it
 * looks, what it says, where it runs and how to install it in the panel beside it. Chats arrive
 * in the inbox as conversations (received.$id.tsx).
 */
export const Route = createFileRoute("/_app/received/chat/$id")({
	loader: ({ params }) => getChatSettingsFn({ data: { inbox: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `Website chat · ${loaderData?.inbox.name ?? "Inbox"} · Mailroom` }],
	}),
	component: ChatSettingsPage,
});

type Data = Awaited<ReturnType<typeof getChatSettingsFn>>;
type Widget = NonNullable<Data["widget"]>;
type Design = Widget["design"];
type AskEmail = Widget["ask_email"];

type Fields = {
	enabled: boolean;
	origins: string;
	ask_email: AskEmail;
	notify: string;
	daily_limit: string;
	retention: string;
	design: Design;
};

const fieldsOf = (d: Data): Fields => ({
	enabled: d.widget?.enabled ?? true,
	origins: (d.widget?.origins ?? []).join("\n"),
	ask_email: d.widget?.ask_email ?? "optional",
	notify: (d.widget?.notify ?? []).join("\n"),
	daily_limit: String(d.widget?.daily_limit ?? 100),
	retention: d.retention_days == null ? "default" : String(d.retention_days),
	design: d.widget?.design ?? d.defaults,
});

const lines = (s: string) =>
	s
		.split(/[\n,]+/)
		.map((x) => x.trim())
		.filter(Boolean);

const RETENTION: [string, string][] = [
	["7", "7 days"],
	["30", "30 days"],
	["90", "90 days"],
	["180", "6 months"],
	["365", "1 year"],
	["730", "2 years"],
	["0", "Keep them"],
];

function ChatSettingsPage() {
	const data = Route.useLoaderData();
	if (!data.widget) return <TurnOn data={data} />;
	return (
		<Builder
			data={data}
			widget={data.widget}
			key={data.widget.public_key}
		/>
	);
}

// ── Not set up yet ──────────────────────────────────────────────────────────

function TurnOn({ data }: { data: Data }) {
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	const [busy, setBusy] = useState(false);
	return (
		<div className="flex flex-col">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
				<BackLink inbox={data.inbox.id} />
				<span className="text-[15px] font-semibold">Website chat</span>
			</header>
			<div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-6 px-4 py-16 text-center">
				<span className="flex size-14 items-center justify-center rounded-2xl bg-brand/10 text-brand">
					<MessageCircle className="size-7" />
				</span>
				<div className="flex flex-col gap-2">
					<h1 className="text-2xl font-semibold tracking-tight">
						Chat with your website's visitors
					</h1>
					<p className="text-balance text-muted-foreground">
						A chat bubble on your site. Visitors write there and see your answers live;
						you get each chat by email at {data.me} and answer by replying, or here in{" "}
						{data.inbox.address}. If they leave, the answer reaches their email.
					</p>
				</div>
				<ul className="grid w-full gap-3 text-left text-sm sm:grid-cols-3">
					{[
						["Live", "Answers and “typing…” show up at once, both ways."],
						["By email", "Reply from your mailbox; it lands in the chat."],
						["Yours", "Kept as long as you choose, then deleted."],
					].map(([t, d]) => (
						<li
							key={t}
							className="rounded-xl border border-border/70 bg-card px-4 py-3"
						>
							<b className="block font-medium">{t}</b>
							<span className="text-muted-foreground">{d}</span>
						</li>
					))}
				</ul>
				<Button
					size="lg"
					disabled={busy || !canManage}
					title={canManage ? undefined : "Your role can't set up inboxes"}
					onClick={async () => {
						setBusy(true);
						try {
							await saveChatSettingsFn({
								data: { inbox: data.inbox.id, settings: {} },
							});
							toast.success("Website chat is ready. Put it on your site next.");
							await router.invalidate();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					{busy ? <Spinner /> : <MessageCircle />}
					Set up website chat
				</Button>
			</div>
		</div>
	);
}

function BackLink({ inbox }: { inbox: string }) {
	return (
		<Button
			variant="ghost"
			size="icon"
			asChild
		>
			<Link
				to="/received/inboxes/$id"
				params={{ id: inbox }}
				aria-label="Back to the inbox"
			>
				<ArrowLeft />
			</Link>
		</Button>
	);
}

// ── The builder ─────────────────────────────────────────────────────────────

function Builder({ data, widget }: { data: Data; widget: Widget }) {
	const router = useRouter();
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:agents");
	const [v, setV] = useState<Fields>(() => fieldsOf(data));
	const [saved, setSaved] = useState(() => JSON.stringify(fieldsOf(data)));
	const [busy, setBusy] = useState(false);
	const [tab, setTab] = useState(widget.origins.length ? "design" : "install");
	const set = <K extends keyof Fields>(k: K, x: Fields[K]) => setV((f) => ({ ...f, [k]: x }));
	const look = (x: Partial<Design>) => setV((f) => ({ ...f, design: { ...f.design, ...x } }));
	const dirty = JSON.stringify(v) !== saved;

	const retentionDays =
		v.retention === "default" ? data.default_retention : Number(v.retention) || 0;
	// What the widget is told, as the page would serve it with these settings.
	const config = useMemo(
		() =>
			data.preview && {
				...data.preview,
				title: v.design.title || data.brand_name,
				subtitle: v.design.subtitle,
				greeting: v.design.greeting,
				placeholder: v.design.placeholder,
				color: v.design.color,
				position: v.design.position,
				theme: v.design.theme,
				launcher: v.design.launcher,
				launcher_text: v.design.launcher_text,
				logo: v.design.show_logo ? (data.preview.logo ?? null) : null,
				away: v.design.away,
				ask_email: v.ask_email,
				ask_name: v.design.ask_name,
				offset_x: v.design.offset_x,
				offset_y: v.design.offset_y,
				retention: v.design.show_retention && retentionDays > 0 ? retentionDays : null,
			},
		[data, v, retentionDays],
	);

	const save = async () => {
		setBusy(true);
		try {
			const daily = Number(v.daily_limit);
			const out = await saveChatSettingsFn({
				data: {
					inbox: data.inbox.id,
					settings: {
						enabled: v.enabled,
						origins: lines(v.origins),
						ask_email: v.ask_email,
						notify: lines(v.notify),
						daily_limit: Number.isFinite(daily) && daily > 0 ? Math.round(daily) : 100,
						retention_days: v.retention === "default" ? null : Number(v.retention),
						design: v.design,
					},
				},
			});
			setSaved(JSON.stringify(v));
			if (out.turnstile) toast.warning(out.turnstile);
			else toast.success("Saved. Websites show the changes within a few minutes.");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const missing = !lines(v.origins).length
		? "Add your website in Install"
		: !lines(v.notify).length
			? "Add who gets the chats by email, in Settings"
			: null;

	return (
		<div className="flex flex-col lg:h-[calc(100svh-1rem)]">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
				<BackLink inbox={data.inbox.id} />
				<div className="flex min-w-0 flex-col leading-tight">
					<span className="truncate text-[15px] font-semibold">Website chat</span>
					<span className="truncate text-xs text-muted-foreground">
						{data.inbox.name} · {data.inbox.address}
					</span>
				</div>
				{data.stats && (
					<span className="ml-3 hidden items-center gap-3 text-xs text-muted-foreground xl:flex">
						<Link
							to="/received"
							search={{ inbox: data.inbox.id }}
							className="hover:text-foreground"
						>
							<b className="font-semibold text-foreground tabular-nums">
								{data.stats.open}
							</b>{" "}
							open
						</Link>
						<span>
							<b className="font-semibold text-foreground tabular-nums">
								{data.stats.month}
							</b>{" "}
							in 30 days
						</span>
					</span>
				)}
				<span className="flex-1" />
				<span className="hidden text-xs text-muted-foreground md:inline">
					{dirty ? "Unsaved changes" : "All changes saved"}
				</span>
				<Badge
					variant={v.enabled ? "secondary" : "outline"}
					className="hidden sm:inline-flex"
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							v.enabled ? "bg-emerald-500" : "bg-muted-foreground/50",
						)}
					/>
					{v.enabled ? "On" : "Off"}
				</Badge>
				<Button
					variant="outline"
					className="hidden sm:inline-flex"
					asChild
				>
					<a
						href={widget.test_page}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink />
						Try it
					</a>
				</Button>
				<Button
					disabled={busy || !dirty || !canManage}
					title={missing ?? undefined}
					onClick={save}
				>
					{busy && <Spinner />}
					Save
				</Button>
			</header>
			{missing && !dirty && (
				<div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-sm text-amber-900 dark:text-amber-200">
					{missing}.
				</div>
			)}
			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				<Canvas
					widget={widget}
					config={config}
					host={lines(v.origins)[0] ?? "yourwebsite.com"}
					brand={data.brand_name}
				/>
				<aside className="flex min-h-0 w-full shrink-0 flex-col border-border/70 lg:w-[400px] lg:border-l">
					<Tabs
						value={tab}
						onValueChange={setTab}
						className="min-h-0 flex-1 gap-0"
					>
						<div className="border-b border-border/70 px-5">
							<TabsList variant="line">
								<TabsTrigger value="design">Design</TabsTrigger>
								<TabsTrigger value="messages">Messages</TabsTrigger>
								<TabsTrigger value="settings">
									Settings
									{!lines(v.notify).length && (
										<span className="size-1.5 rounded-full bg-amber-500" />
									)}
								</TabsTrigger>
								<TabsTrigger value="install">
									Install
									{!lines(v.origins).length && (
										<span className="size-1.5 rounded-full bg-amber-500" />
									)}
								</TabsTrigger>
							</TabsList>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<TabsContent value="design">
								<DesignPanel
									design={v.design}
									look={look}
									hasLogo={!!data.preview?.logo}
								/>
							</TabsContent>
							<TabsContent value="messages">
								<MessagesPanel
									v={v}
									look={look}
									defaults={data.defaults}
									brand={data.brand_name}
								/>
							</TabsContent>
							<TabsContent value="settings">
								<SettingsPanel
									v={v}
									set={set}
									look={look}
									data={data}
								/>
							</TabsContent>
							<TabsContent value="install">
								<InstallPanel
									v={v}
									set={set}
									data={data}
									widget={widget}
									canManage={canManage}
								/>
							</TabsContent>
						</div>
					</Tabs>
				</aside>
			</div>
		</div>
	);
}

// ── The canvas ──────────────────────────────────────────────────────────────

/** A sketch of a website with the real widget on it, in preview mode (it sends nothing). */
const sitePage = (o: { script: string; dark: boolean; brand: string }) => {
	const fg = o.dark ? "#e5e7eb" : "#111827";
	const bg = o.dark ? "#0b0f17" : "#ffffff";
	const block = o.dark ? "#1f2937" : "#f1f5f9";
	const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:${bg};color:${fg}}
nav{display:flex;align-items:center;gap:24px;padding:18px 28px;border-bottom:1px solid ${block}}
nav b{font-size:17px;margin-right:auto}nav i{display:block;width:56px;height:8px;border-radius:4px;background:${block}}
main{max-width:980px;margin:0 auto;padding:56px 28px}
h1{font-size:clamp(28px,5vw,44px);line-height:1.1;margin:0 0 16px;letter-spacing:-.02em}
p.l{width:min(520px,100%);height:12px;border-radius:6px;background:${block};margin:10px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:20px;margin-top:48px}
.card{height:180px;border-radius:14px;background:${block}}
@media(max-width:600px){nav i{display:none}main{padding:32px 20px}}
</style></head><body><nav><b>${esc(o.brand)}</b><i></i><i></i><i></i></nav><main><h1>Welcome to ${esc(o.brand)}</h1><p class="l"></p><p class="l" style="width:min(420px,80%)"></p><p class="l" style="width:min(300px,60%)"></p><div class="grid"><div class="card"></div><div class="card"></div><div class="card"></div></div></main>
<script src="${o.script}" async></script></body></html>`;
};

function Canvas({
	widget,
	config,
	host,
	brand,
}: {
	widget: Widget;
	config: unknown;
	host: string;
	brand: string;
}) {
	const [phone, setPhone] = useState(false);
	const [site, setSite] = useState<"light" | "dark">("light");
	const frame = useRef<HTMLIFrameElement>(null);
	const script = `${new URL(widget.test_page).origin}/chat/${widget.public_key}.js?preview=1`;
	const doc = useMemo(
		() => sitePage({ script, dark: site === "dark", brand }),
		[script, site, brand],
	);
	const push = useCallback(() => {
		frame.current?.contentWindow?.postMessage({ type: "mailroom-chat-design", config }, "*");
	}, [config]);
	// The widget loads after the page; tell it the settings again until it's there.
	useEffect(() => {
		push();
		const t = [300, 900, 2000].map((ms) => setTimeout(push, ms));
		return () => t.forEach(clearTimeout);
	}, [push]);
	const seg =
		"flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground";
	const on =
		"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]";
	return (
		<section className="relative flex min-h-[640px] min-w-0 flex-1 flex-col bg-muted/40 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px] lg:min-h-0">
			<div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-4">
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{(
						[
							["light", Sun, "Light website"],
							["dark", Moon, "Dark website"],
						] as const
					).map(([x, Icon, l]) => (
						<button
							key={x}
							type="button"
							aria-label={l}
							title={l}
							aria-pressed={site === x}
							onClick={() => setSite(x)}
							className={cn(seg, site === x && on)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{(
						[
							[false, Monitor, "Desktop"],
							[true, Smartphone, "Phone"],
						] as const
					).map(([x, Icon, l]) => (
						<button
							key={l}
							type="button"
							aria-label={l}
							title={l}
							aria-pressed={phone === x}
							onClick={() => setPhone(x)}
							className={cn(seg, phone === x && on)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
				<span className="text-xs text-muted-foreground">
					A preview: write in it to see how it feels.
				</span>
			</div>
			<div className="flex min-h-0 flex-1 items-stretch justify-center p-4 sm:p-6">
				<div
					className={cn(
						"flex w-full flex-col overflow-hidden border border-border/80 bg-background shadow-[0_1px_2px_var(--shadow-color),0_24px_48px_-24px_var(--shadow-color-strong)] transition-[max-width] duration-300",
						phone ? "max-w-[390px] rounded-[28px]" : "max-w-[1180px] rounded-xl",
					)}
				>
					<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border/70 bg-muted/50 px-3">
						{!phone && (
							<span className="flex gap-1.5">
								<i className="size-2.5 rounded-full bg-[#ff5f57]" />
								<i className="size-2.5 rounded-full bg-[#febc2e]" />
								<i className="size-2.5 rounded-full bg-[#28c840]" />
							</span>
						)}
						<span className="mx-auto max-w-[60%] truncate rounded-md bg-background/80 px-3 py-0.5 text-[11px] text-muted-foreground">
							{host}
						</span>
						{!phone && <span className="w-[42px]" />}
					</div>
					<iframe
						ref={frame}
						key={`${site}-${phone}`}
						title="How the chat looks on a website"
						sandbox="allow-scripts"
						srcDoc={doc}
						onLoad={push}
						className="block min-h-[600px] w-full flex-1"
					/>
				</div>
			</div>
		</section>
	);
}

// ── Panels ──────────────────────────────────────────────────────────────────

const PRESETS = ["#2563eb", "#0f766e", "#16a34a", "#9333ea", "#db2777", "#ea580c", "#111827"];

function DesignPanel({
	design: d,
	look,
	hasLogo,
}: {
	design: Design;
	look: (x: Partial<Design>) => void;
	hasLogo: boolean;
}) {
	return (
		<>
			<Group title="Color">
				<ColorField
					label="Accent"
					value={d.color ?? "#2563eb"}
					onChange={(color) => look({ color })}
					swatches={PRESETS.map((value) => ({ name: "", value }))}
				/>
				<Labeled label="Theme">
					<Choice
						value={d.theme ?? "auto"}
						onChange={(theme) => look({ theme })}
						options={[
							["auto", "Auto"],
							["light", "Light"],
							["dark", "Dark"],
						]}
					/>
				</Labeled>
				<p className="text-xs text-muted-foreground">
					Auto follows the visitor's device (light or dark).
				</p>
			</Group>
			<Group title="Launcher">
				<Labeled label="Shape">
					<Choice
						value={d.launcher ?? "bubble"}
						onChange={(launcher) => look({ launcher })}
						options={[
							["bubble", "Bubble"],
							["label", "With text"],
						]}
					/>
				</Labeled>
				{d.launcher === "label" && (
					<Labeled label="Text">
						<Input
							value={d.launcher_text ?? ""}
							maxLength={40}
							placeholder="Chat with us"
							onChange={(e) => look({ launcher_text: e.target.value })}
						/>
					</Labeled>
				)}
				<Labeled label="Corner">
					<Choice
						value={d.position ?? "right"}
						onChange={(position) => look({ position })}
						options={[
							["left", "Bottom left"],
							["right", "Bottom right"],
						]}
					/>
				</Labeled>
				<Labeled label="Spacing">
					<div className="grid grid-cols-2 gap-2">
						<NumberIn
							label="From the side"
							value={d.offset_x ?? 20}
							onChange={(offset_x) => look({ offset_x })}
						/>
						<NumberIn
							label="From the bottom"
							value={d.offset_y ?? 20}
							onChange={(offset_y) => look({ offset_y })}
						/>
					</div>
				</Labeled>
			</Group>
			<Group title="Header">
				<SwitchRow
					label="Show the brand's logo"
					hint={
						hasLogo
							? "The logo from the brand's settings."
							: "This brand has no logo yet: add one in Settings › Brand."
					}
					checked={!!d.show_logo}
					onChange={(show_logo) => look({ show_logo })}
				/>
			</Group>
		</>
	);
}

function NumberIn({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<span className="relative">
			<Input
				type="number"
				min={0}
				max={200}
				aria-label={label}
				title={label}
				value={value}
				onChange={(e) => onChange(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
				className="pr-7 tabular-nums"
			/>
			<span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
				px
			</span>
		</span>
	);
}

function MessagesPanel({
	v,
	look,
	defaults,
	brand,
}: {
	v: Fields;
	look: (x: Partial<Design>) => void;
	defaults: Data["defaults"];
	brand: string;
}) {
	const d = v.design;
	return (
		<>
			<Group title="Header">
				<Field>
					<FieldLabel htmlFor="chat-title">Title</FieldLabel>
					<Input
						id="chat-title"
						maxLength={60}
						placeholder={brand}
						value={d.title ?? ""}
						onChange={(e) => look({ title: e.target.value || null })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="chat-subtitle">Under it</FieldLabel>
					<Input
						id="chat-subtitle"
						maxLength={120}
						placeholder={defaults.subtitle ?? ""}
						value={d.subtitle ?? ""}
						onChange={(e) => look({ subtitle: e.target.value || null })}
					/>
					<FieldDescription>When you usually answer, or anything short.</FieldDescription>
				</Field>
			</Group>
			<Group title="The conversation">
				<Field>
					<FieldLabel htmlFor="chat-greeting">Greeting</FieldLabel>
					<Textarea
						id="chat-greeting"
						rows={2}
						maxLength={500}
						placeholder={defaults.greeting ?? ""}
						value={d.greeting ?? ""}
						onChange={(e) => look({ greeting: e.target.value || null })}
					/>
					<FieldDescription>The first thing visitors read, from you.</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="chat-placeholder">Where they write</FieldLabel>
					<Input
						id="chat-placeholder"
						maxLength={80}
						placeholder={defaults.placeholder ?? ""}
						value={d.placeholder ?? ""}
						onChange={(e) => look({ placeholder: e.target.value || null })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="chat-away">When nobody's here</FieldLabel>
					<Textarea
						id="chat-away"
						rows={3}
						maxLength={300}
						placeholder={defaults.away ?? ""}
						value={d.away ?? ""}
						onChange={(e) => look({ away: e.target.value || null })}
					/>
					<FieldDescription>
						Shown after their first message when nobody on your team has the chat open.
					</FieldDescription>
				</Field>
			</Group>
		</>
	);
}

function SettingsPanel({
	v,
	set,
	look,
	data,
}: {
	v: Fields;
	set: <K extends keyof Fields>(k: K, x: Fields[K]) => void;
	look: (x: Partial<Design>) => void;
	data: Data;
}) {
	const defaultLabel = data.default_retention
		? `This deployment's default (${data.default_retention} days)`
		: "This deployment's default";
	return (
		<>
			<Group title="Visitors">
				<Field>
					<FieldLabel>Their email</FieldLabel>
					<Choice
						value={v.ask_email}
						onChange={(x) => set("ask_email", x)}
						options={[
							["off", "Don't ask"],
							["optional", "Ask"],
							["required", "Before chatting"],
						]}
					/>
					<FieldDescription>
						{v.ask_email === "required"
							? "They leave it before their first message."
							: v.ask_email === "optional"
								? "Asked after their first message, so answers reach them if they leave."
								: "Answers only reach them while the chat is open on your site."}
					</FieldDescription>
				</Field>
				{v.ask_email !== "off" && (
					<SwitchRow
						label="Ask for their name too"
						checked={!!v.design.ask_name}
						onChange={(ask_name) => look({ ask_name })}
					/>
				)}
			</Group>
			<Group title="Your team">
				<Field>
					<FieldLabel htmlFor="chat-notify">Email the chats to</FieldLabel>
					<Textarea
						id="chat-notify"
						rows={3}
						spellCheck={false}
						placeholder={data.me}
						value={v.notify}
						onChange={(e) => set("notify", e.target.value)}
					/>
					<FieldDescription>
						One address per line. A minute's messages come in one email; reply to it and
						the visitor sees your answer in the chat. Skipped when someone already read
						them here.
					</FieldDescription>
				</Field>
			</Group>
			<Group title="Keeping chats">
				<Field>
					<FieldLabel>Delete chats</FieldLabel>
					<Select
						value={v.retention}
						onValueChange={(x) => set("retention", x)}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{RETENTION.map(([x, l]) => (
								<SelectItem
									key={x}
									value={x}
								>
									{x === "0" ? "Never: keep them" : `${l} after the last message`}
								</SelectItem>
							))}
							<SelectItem value="default">{defaultLabel}</SelectItem>
						</SelectContent>
					</Select>
					<FieldDescription>
						For everything in this inbox: chats with their files, and emails. Archived
						to your R2 bucket first when the organization's archive is on.
					</FieldDescription>
				</Field>
				<SwitchRow
					label="Tell visitors"
					hint="A line under the chat says how long it's kept."
					checked={!!v.design.show_retention}
					onChange={(show_retention) => look({ show_retention })}
				/>
			</Group>
			<Group title="Limits">
				<Field>
					<FieldLabel htmlFor="chat-daily">New chats a day, at most</FieldLabel>
					<Input
						id="chat-daily"
						type="number"
						min={1}
						max={10000}
						value={v.daily_limit}
						onChange={(e) => set("daily_limit", e.target.value)}
						className="tabular-nums"
					/>
					<FieldDescription>
						Past it, visitors are asked to email you instead. Each visitor can also
						start 6 chats an hour and write 20 messages a minute.
					</FieldDescription>
				</Field>
				<TurnstileState data={data} />
			</Group>
		</>
	);
}

function TurnstileState({ data }: { data: Data }) {
	const t = data.turnstile;
	const ok = t.on && !t.error;
	return (
		<div
			className={cn(
				"flex gap-3 rounded-lg border px-3 py-2.5 text-sm",
				ok ? "border-border/70" : "border-amber-500/30 bg-amber-500/5",
			)}
		>
			{ok ? (
				<ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
			) : (
				<ShieldOff className="mt-0.5 size-4 shrink-0 text-amber-600" />
			)}
			<span className="flex flex-col gap-0.5">
				<b className="font-medium">
					{ok ? "Bots are kept out (Turnstile)" : "Turnstile isn't on"}
				</b>
				<span className="text-xs text-muted-foreground">
					{ok
						? `Cloudflare checks each new chat quietly, on ${t.domains.length} website${t.domains.length === 1 ? "" : "s"}.`
						: t.error ||
							(t.configured
								? "It turns on when you save the chat's websites."
								: "This deployment has no Cloudflare Turnstile token, so chats rely on the limits above.")}
				</span>
			</span>
		</div>
	);
}

function InstallPanel({
	v,
	set,
	data,
	widget,
	canManage,
}: {
	v: Fields;
	set: <K extends keyof Fields>(k: K, x: Fields[K]) => void;
	data: Data;
	widget: Widget;
	canManage: boolean;
}) {
	const router = useRouter();
	const api = `<!-- Open it from your own button -->
<button onclick="MailroomChat.open()">Chat with us</button>

<script>
  // Signed-in visitors: skip asking for their email.
  window.addEventListener("load", () =>
    window.MailroomChat?.identify({ email: "ana@example.com", name: "Ana" })
  );
</script>`;
	return (
		<>
			<Group title="Your websites">
				<Field>
					<FieldLabel htmlFor="chat-origins">Where it runs</FieldLabel>
					<Textarea
						id="chat-origins"
						rows={3}
						spellCheck={false}
						placeholder={"harborinn.com\nbook.harborinn.com"}
						value={v.origins}
						onChange={(e) => set("origins", e.target.value)}
					/>
					<FieldDescription>
						One per line; their subdomains too. Other sites can't use it, even with the
						code.
					</FieldDescription>
				</Field>
				<SwitchRow
					label="Chat is on"
					hint="Off, the bubble disappears from your sites and nobody can start a chat."
					checked={v.enabled}
					onChange={(x) => set("enabled", x)}
				/>
			</Group>
			<Group title="Put it on your site">
				<p className="text-sm text-muted-foreground">
					Paste this before <code className="font-mono text-xs">&lt;/body&gt;</code> on
					every page (or in your site builder's “custom code”).
				</p>
				<CodeBlock
					code={widget.snippet}
					lang="text"
				/>
				<Button
					variant="outline"
					asChild
				>
					<a
						href={widget.test_page}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink />
						Try it on a test page
					</a>
				</Button>
				<p className="text-xs text-muted-foreground">
					Links ending in <code className="font-mono">#mailroom-chat</code> open the chat
					(for an email's “Chat with us”).
				</p>
			</Group>
			<Group title="From your own code (optional)">
				<CodeBlock
					code={api}
					lang="text"
				/>
			</Group>
			{canManage && (
				<Group title="Key">
					<p className="text-sm text-muted-foreground">
						A new key stops the current code at once: use it if someone copies your chat
						to another site.
					</p>
					<div className="flex flex-wrap gap-2">
						<Confirm
							trigger={
								<Button variant="outline">
									<KeyRound />
									New key
								</Button>
							}
							title="Make a new key?"
							description="The code on your websites stops working until you paste the new one."
							action="Make a new key"
							onConfirm={async () => {
								try {
									await rotateChatKeyFn({ data: { inbox: data.inbox.id } });
									toast.success("New key: paste the new code on your sites");
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
						<Confirm
							trigger={
								<Button variant="ghost">
									<Trash2 />
									Remove the chat
								</Button>
							}
							title="Remove the website chat?"
							description="The bubble disappears from your sites and its settings are deleted. Chats so far stay in the inbox until their retention."
							action="Remove"
							onConfirm={async () => {
								try {
									await deleteChatWidgetFn({ data: { inbox: data.inbox.id } });
									toast.success("Website chat removed");
									await router.navigate({
										to: "/received/inboxes/$id",
										params: { id: data.inbox.id },
									});
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						/>
					</div>
				</Group>
			)}
		</>
	);
}
