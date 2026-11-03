import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	Ban,
	BellOff,
	CalendarClock,
	ChevronDown,
	ChevronsDownUp,
	ChevronsUpDown,
	CircleAlert,
	CircleCheck,
	Clock,
	Eye,
	Flag,
	ImageOff,
	Link2,
	type LucideIcon,
	Mail,
	MailCheck,
	MailX,
	Monitor,
	MoreHorizontal,
	MousePointerClick,
	Paperclip,
	ScrollText,
	Send,
	Smartphone,
	Sparkles,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer, type Call, pretty } from "@/components/api-drawer";
import { Confirm } from "@/components/confirm";
import { CopyIcon, CopyValue, useCopy } from "@/components/copy";
import { Page } from "@/components/page";
import {
	Fact,
	Facts,
	IdChip,
	RecordHeader,
	type Step,
	Timeline,
	toneOf,
} from "@/components/record";
import { StatusBadge, statusLabel } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cancelEmailFn, getEmailFn } from "@/functions/emails";
import { explainBounce } from "@/lib/bounces";
import { leftOutLabel, shownStatus, statusInfo } from "@/lib/email-status";
import { errorMessage } from "@/lib/errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import { formatHtml, type HtmlKind, type HtmlLine, type HtmlSeg } from "@/lib/format-html";
import { ago, listedRow, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/emails/$id")({
	loader: ({ params }) => getEmailFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.email.subject || "Email"} · Mailroom` }],
	}),
	component: EmailPage,
	pendingComponent: EmailSketch,
});

/**
 * Drawn from the row the emails list showed, when it did (its recipient, subject, status and the
 * events its status implies); otherwise a delivered email.
 */
function EmailSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("email-page", params.id);
	const row = listedRow<Partial<Data["email"]>>("emails", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<EmailPage />
			</Sketch>
		);
	const at = row?.created_at ?? ago(60);
	const status = row?.status ?? "delivered";
	const happened = [
		status !== "queued" && status !== "scheduled" && status !== "suppressed" && "email.sent",
		["delivered", "complained"].includes(status) && "email.delivered",
		row?.opened_at && "email.opened",
		row?.clicked_at && "email.clicked",
		["bounced", "soft_bounced"].includes(status) && "email.bounced",
		status === "complained" && "email.complained",
		status === "delivery_delayed" && "email.delivery_delayed",
	].filter((t): t is string => !!t);
	const email = {
		id: params.id ?? "",
		organization_id: "",
		message_id: "0000000000000000-00000000-0000-0000-0000-000000000000-000000",
		from: "Organization <hello@mail.example.com>",
		to: ["guest@example.com"],
		cc: null,
		bcc: null,
		reply_to: null,
		subject: "Your booking is confirmed",
		tags: null,
		status,
		error: null,
		dropped: null,
		source: "api",
		send_at: null,
		created_at: at,
		bounce_type: null,
		...row,
	};
	return (
		<Sketch
			data={{
				email,
				html: "<p></p>",
				text: "",
				headers: null,
				attachments: [],
				inline: {},
				replies: [],
				apiKey: { name: "Production", permission: "full" },
				brand: null,
				log:
					email.source === "api"
						? { id: "sketch", method: "POST", path: "/emails" }
						: null,
				events: happened.map((type, i) => ({
					id: `sketch-${i}`,
					type,
					at,
					recipient: null,
					data: null,
				})),
			}}
		>
			<EmailPage />
		</Sketch>
	);
}

type Data = Awaited<ReturnType<typeof getEmailFn>>;

const ICON: Record<string, LucideIcon> = {
	"email.created": Sparkles,
	"email.scheduled": CalendarClock,
	"email.sent": Send,
	"email.delivered": MailCheck,
	"email.opened": Eye,
	"email.clicked": MousePointerClick,
	"email.bounced": MailX,
	"email.complained": Flag,
	"email.failed": CircleAlert,
	"email.delivery_delayed": Clock,
	"email.suppressed": Ban,
	"email.unsubscribed": BellOff,
};

const HINT: Record<string, string> = {
	"email.created": "Mailroom took it and queued it to send.",
	"email.scheduled": "It waits until its scheduled time.",
	"email.sent": "SES accepted it and is handing it to the recipient's mail server.",
	"email.delivered": "The recipient's mail server accepted it.",
	"email.opened":
		"The recipient opened it (its images loaded). Apple Mail can open emails on its own.",
	"email.clicked": "The recipient clicked a link in it.",
	"email.bounced": "The recipient's mail server refused it.",
	"email.complained": "The recipient marked it as spam.",
	"email.failed": "SES couldn't send it.",
	"email.delivery_delayed": "The recipient's server asked SES to try again later.",
	"email.suppressed": "Skipped: the address is on this brand's suppression list.",
	"email.unsubscribed":
		"The recipient used its one-click unsubscribe: this group's emails skip them from now on.",
};

const SOFT_BOUNCE_HINT =
	"The recipient's mail server didn't take it (full, down, looping or refused by policy). The address is fine and stays off the suppression list.";

const SOURCES: Record<string, string> = {
	api: "API",
	smtp: "SMTP",
	dashboard: "Dashboard",
	system: "Mailroom",
	mcp: "AI assistant (MCP)",
};

function eventDetail(type: string, data: Record<string, unknown> | null) {
	if (!data) return null;
	const bounce = data.bounce as { type?: string; subType?: string; message?: string } | undefined;
	if (bounce)
		return (
			[bounce.type, bounce.subType].filter(Boolean).join(" · ") +
			(bounce.message ? `: ${bounce.message}` : "")
		);
	const click = data.click as { link?: string } | undefined;
	if (click?.link) return click.link;
	const failed = data.failed as { reason?: string } | undefined;
	if (failed?.reason) return failed.reason;
	if (type === "email.complained") return "They won't get more emails from this brand.";
	return null;
}

/** The email's life as timeline steps: repeated opens and clicks fold into one step each. */
function steps({ email, events }: Data): Step[] {
	const out: (Step & { count: number })[] = [];
	const first =
		email.source === "smtp"
			? "email.sent"
			: email.status === "scheduled"
				? "email.scheduled"
				: "email.created";
	out.push({
		key: "created",
		label: first === "email.created" ? "Created" : statusLabel(first),
		icon: ICON[first] ?? Sparkles,
		tone: "gray",
		at: email.created_at,
		hint: HINT[first],
		count: 1,
	});
	for (const ev of events) {
		const same = out.find((s) => s.key.startsWith(ev.type) && /opened|clicked/.test(ev.type));
		const detail = eventDetail(ev.type, ev.data);
		if (same) {
			same.count++;
			same.label = `${statusLabel(ev.type)} ×${same.count}`;
			continue;
		}
		// A soft bounce: the receiving server, not the address, kept it out. Not a bounce.
		const soft =
			ev.type === "email.bounced" &&
			(ev.data?.bounce as { type?: string } | undefined)?.type === "Transient";
		out.push({
			key: `${ev.type}-${ev.id}`,
			label: soft ? "Soft bounce" : statusLabel(ev.type),
			icon: ICON[ev.type] ?? Send,
			tone: soft ? "amber" : toneOf(ev.type),
			at: ev.at,
			hint: [
				soft ? SOFT_BOUNCE_HINT : HINT[ev.type],
				email.to.length > 1 ? ev.recipient : null,
				detail,
			]
				.filter(Boolean)
				.join(" "),
			count: 1,
		});
	}
	const types = new Set(events.map((e) => e.type));
	const ended = ["email.bounced", "email.failed", "email.suppressed", "email.delivered"].some(
		(t) => types.has(t),
	);
	const shown = shownStatus(email);
	// Kept out before SES (suppressed, blocked, failed) or with no event kept: the end as a step.
	if (!ended && ["suppressed", "failed", "soft_bounced", "bounced"].includes(email.status))
		out.push({
			key: "end",
			count: 1,
			label: statusLabel(shown),
			icon:
				email.status === "failed"
					? CircleAlert
					: email.status === "suppressed"
						? Ban
						: MailX,
			tone: email.status === "soft_bounced" ? "amber" : toneOf(shown),
			at: email.last_event_at ?? email.created_at,
			hint: statusInfo(shown).description,
		});
	else if (!ended && email.status !== "canceled")
		out.push({
			key: "waiting",
			count: 1,
			label: email.status === "scheduled" ? "Sent" : "Delivered",
			icon: email.status === "scheduled" ? Send : MailCheck,
			tone: "gray",
			waiting: true,
			hint:
				email.status === "scheduled"
					? `Goes out ${formatRelative(email.send_at)}.`
					: "Waiting for the recipient's mail server to answer.",
		});
	return out;
}

/** Why a recipient was left out, as a labelled pill: whose rule it was and what it said. */
function LeftOut({ why }: { why: string }) {
	const { kind, label } = leftOutLabel(why);
	return (
		<StatusBadge
			status={kind}
			label={label}
		/>
	);
}

type Insight = { ok: boolean; title: string; detail: string; value?: string };

const SHORTENERS = /https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly)\//i;

/** What a deliverability review would say about this email, from what Mailroom kept of it. */
function insights({ email, html, text, headers }: Data): Insight[] {
	const out: Insight[] = [];
	if (html) {
		out.push(
			text
				? {
						ok: true,
						title: "Has a plain-text version",
						detail: "Clients that don't show HTML, and spam filters, read it.",
					}
				: {
						ok: false,
						title: "No plain-text version",
						detail: "Send a text part next to the HTML. Some spam filters score emails without one lower.",
					},
		);
		const kb = new Blob([html]).size / 1024;
		out.push(
			kb < 102
				? {
						ok: true,
						title: "Gmail shows it whole",
						detail: `Its HTML is ${Math.ceil(kb)} KB; Gmail cuts emails off at 102 KB.`,
					}
				: {
						ok: false,
						title: "Gmail will clip it",
						detail: `Its HTML is ${Math.ceil(kb)} KB. Gmail hides everything after 102 KB behind «View entire message», including the open-tracking pixel.`,
					},
		);
		const insecure = /href=["']http:\/\/[^"']+/i.exec(html)?.[0]?.slice(6);
		out.push(
			insecure
				? {
						ok: false,
						title: "A link isn't HTTPS",
						detail: "Browsers warn on plain HTTP links, and filters trust them less.",
						value: insecure,
					}
				: { ok: true, title: "Links use HTTPS", detail: "Every link is encrypted." },
		);
		const short = SHORTENERS.exec(html)?.[0];
		out.push(
			short
				? {
						ok: false,
						title: "Uses a link shortener",
						detail: "Spammers hide links behind shorteners, so filters distrust them. Link to your own domain.",
						value: short,
					}
				: {
						ok: true,
						title: "No link shorteners",
						detail: "Links show where they go.",
					},
		);
		const noAlt = /<img(?![^>]*\balt=)[^>]*>/i.exec(html)?.[0];
		out.push(
			noAlt
				? {
						ok: false,
						title: "An image has no alt text",
						detail: "Many clients block images at first: alt text says what's there, and screen readers read it.",
						value: noAlt.slice(0, 160),
					}
				: { ok: true, title: "Images have alt text", detail: "Readable with images off." },
		);
	}
	out.push(
		email.subject.length > 0 && email.subject.length <= 78
			? {
					ok: true,
					title: "Subject fits",
					detail: `${email.subject.length} characters: phones show about 40, desktops about 78.`,
				}
			: {
					ok: false,
					title: email.subject ? "Long subject" : "No subject",
					detail: email.subject
						? `${email.subject.length} characters: phones cut it after about 40, so lead with what matters.`
						: "Emails without a subject look like spam to people and to filters.",
				},
	);
	const noReply = /\b(no-?reply|do-?not-?reply)@/i.test(email.from);
	if (noReply && !email.reply_to?.length)
		out.push({
			ok: false,
			title: "Replies go nowhere",
			detail: "It comes from a no-reply address with no Reply-To. Replies are a good signal to mailbox providers; add a Reply-To people can write to.",
			value: email.from,
		});
	else
		out.push({
			ok: true,
			title: "People can reply",
			detail: email.reply_to?.length
				? `Replies go to ${email.reply_to.join(", ")}.`
				: "Replies go to the sender.",
		});
	const unsubscribe = headers
		? Object.keys(headers).some((k) => k.toLowerCase() === "list-unsubscribe")
		: false;
	if (unsubscribe || email.unsubscribe_group)
		out.push({
			ok: true,
			title: "One-click unsubscribe",
			detail: email.unsubscribe_group
				? `Mailroom added it for the group ${email.unsubscribe_group}: whoever uses it stops getting that group's emails. Gmail and Yahoo require it for bulk and marketing email.`
				: "Gmail and Yahoo require it for bulk and marketing email.",
		});
	return out;
}

/** The email as the API's GET /emails/:id returns it. */
function raw({ email, html, text, events }: Data) {
	return pretty({
		object: "email",
		id: email.id,
		from: email.from,
		to: email.to,
		cc: email.cc,
		bcc: email.bcc,
		reply_to: email.reply_to,
		subject: email.subject,
		html,
		text,
		status: email.status,
		last_event: email.last_event ?? email.status,
		scheduled_at: email.status === "scheduled" ? email.send_at : null,
		created_at: email.created_at,
		tags: email.tags,
		unsubscribe_group: email.unsubscribe_group,
		error: email.error,
		dropped_recipients: email.dropped,
		events: events.map((e) => ({
			type: e.type,
			at: e.at,
			recipient: e.recipient,
			data: e.data,
		})),
	});
}

/** Where an inline image (src="cid:logo") goes and Mailroom has no copy of it (sent before it
 * kept them, or too big): a placeholder named after the image instead of a broken one. */
const cidPlaceholder = (name: string) => {
	const label = (name.split("@")[0] || "image").replace(/[<>&"']/g, "").slice(0, 24);
	const w = Math.round(Math.max(132, 46 + label.length * 6.8));
	return `data:image/svg+xml,${encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="36" viewBox="0 0 ${w} 36"><rect x=".5" y=".5" width="${w - 1}" height="35" rx="6" fill="#f4f5f7" stroke="#d5d8de" stroke-dasharray="3 3"/><g fill="none" stroke="#8a909a" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="12" y="11" width="15" height="14" rx="2"/><circle cx="17" cy="16" r="1.4"/><path d="m27 21-3.5-3.5L15 25"/></g><text x="35" y="22" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="11" fill="#6b717c">${label}</text></svg>`,
	)}`;
};
const CID = /(src\s*=\s*["'])cid:([^"']*)(["'])/gi;
/** Links in the preview open in a new tab (the frame itself never navigates). */
const BASE = '<base target="_blank">';
const withBase = (html: string) =>
	/<head[^>]*>/i.test(html)
		? html.replace(/<head[^>]*>/i, (h) => `${h}${BASE}`)
		: `${BASE}${html}`;
/** The HTML with each cid: image as its kept copy (a data: URL), or a placeholder, and links
 * that open in a new tab. */
const preview = (html: string, inline: Record<string, string>) =>
	withBase(html).replace(
		CID,
		(_, open: string, name: string, close: string) =>
			`${open}${inline[name] ?? cidPlaceholder(name)}${close}`,
	);
/** The cid: images the HTML uses that Mailroom has no copy of. */
const missingImages = (html: string, inline: Record<string, string>) => [
	...new Set([...html.matchAll(CID)].map((m) => m[2] as string).filter((n) => !inline[n])),
];

const list = (a: string[] | null | undefined) => (a?.length ? a.join(", ") : null);

function EmailPage() {
	const data = usePage(Route).data;
	// Reloaded, its skeleton draws from this (bodies left out: they're drawn as placeholders).
	useOpened(
		"email-page",
		useMemo(
			() => ({
				...data,
				id: data.email.id,
				html: data.html ? "<p></p>" : data.html,
				text: data.text ? " " : data.text,
			}),
			[data],
		),
	);
	const { email, html, text, headers, attachments, inline: kept, apiKey } = data;
	const router = useRouter();
	const [tab, setTab] = useState(html ? "preview" : "text");
	const [phone, setPhone] = useState(false);
	/** The document the preview has painted, so a new email fades in too. */
	const [painted, setPainted] = useState<string | null>(null);
	const srcDoc = useMemo(() => (html ? preview(html, kept) : ""), [html, kept]);
	const missing = useMemo(() => (html ? missingImages(html, kept) : []), [html, kept]);
	const found = insights(data);
	const attention = found.filter((i) => !i.ok);
	const json = raw(data);
	// A soft bounce: the receiving server (full, down, looping) kept it out, not the address.
	const soft = email.bounce_type?.startsWith("Transient") ?? false;
	// A bounce in plain words, naming the receiving provider when it's a known one.
	const bounce = email.bounce_type
		? explainBounce({
				type: email.bounce_type.split("/")[0],
				subType: email.bounce_type.split("/")[1],
				message: email.error,
				recipient: email.to.length === 1 ? email.to[0] : null,
			})
		: null;
	const body =
		text ??
		(html
			? null
			: email.source === "smtp"
				? "Sent over SMTP: the body goes straight to SES, so Mailroom never sees it."
				: "The body is no longer kept (past its retention).");
	const copyable: Record<string, string | null> = {
		html,
		text,
		raw: json,
		headers: headers ? JSON.stringify(headers, null, 2) : null,
	};
	const calls: Call[] = [
		{ title: "Retrieve this email", method: "GET", path: `/emails/${email.id}` },
		...(email.status === "scheduled"
			? ([
					{
						title: "Reschedule it",
						method: "PATCH",
						path: `/emails/${email.id}`,
						body: { scheduled_at: email.send_at },
					},
					{ title: "Cancel it", method: "POST", path: `/emails/${email.id}/cancel` },
				] satisfies Call[])
			: []),
		{
			title: "Send one like it",
			method: "POST",
			path: "/emails",
			body: {
				from: email.from,
				to: email.to,
				subject: email.subject,
				...(html ? { html: "<p>…</p>" } : {}),
				...(text ? { text: "…" } : {}),
				...(email.tags?.length ? { tags: email.tags } : {}),
			},
		},
	];
	const more = email.to.length > 1 ? ` +${email.to.length - 1}` : "";
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/emails"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Emails
					</Link>
					{data.brand && (
						<>
							<span aria-hidden="true"> / </span>
							<Link
								to="/emails"
								search={{ brand: data.brand.id }}
								className="rounded-sm transition-colors hover:text-foreground"
							>
								{data.brand.name}
							</Link>
						</>
					)}
				</nav>
				<RecordHeader
					icon={Mail}
					tone={soft ? "amber" : toneOf(email.status)}
					kind="Email"
					title={
						<>
							{email.to[0] ?? "(no recipient)"}
							{more && <span className="text-muted-foreground">{more}</span>}
						</>
					}
					actions={
						<>
							{email.status === "scheduled" && (
								<Confirm
									trigger={<Button variant="outline">Cancel sending</Button>}
									title="Cancel this email?"
									description={`It was going out ${formatRelative(email.send_at)}. It won't be sent, and you can't undo this.`}
									action="Cancel email"
									cancel="Keep it"
									onConfirm={async () => {
										try {
											await cancelEmailFn({ data: { id: email.id } });
											toast.success("Email canceled");
											await router.invalidate();
										} catch (error) {
											toast.error(await errorMessage(error));
										}
									}}
								/>
							)}
							<ApiDrawer
								title="This email in the API"
								calls={calls}
							/>
							<MoreMenu id={email.id} />
						</>
					}
				/>
			</div>

			<Facts>
				<Fact label="From">
					<CopyValue value={email.from} />
				</Fact>
				<Fact label="Subject">
					{email.subject ? (
						<CopyValue value={email.subject} />
					) : (
						<span className="text-muted-foreground">(no subject)</span>
					)}
				</Fact>
				<Fact label="To">
					<CopyValue value={list(email.to) ?? ""} />
				</Fact>
				<Fact label="Id">
					<IdChip value={email.id} />
				</Fact>
				<Fact label="Status">
					<span className="flex min-w-0 flex-col gap-1">
						<StatusBadge status={shownStatus(email)} />
						<span className="text-xs text-muted-foreground text-pretty">
							{statusInfo(shownStatus(email)).description}
						</span>
					</span>
				</Fact>
				{list(email.cc) && (
					<Fact label="Cc">
						<CopyValue value={list(email.cc) ?? ""} />
					</Fact>
				)}
				{list(email.bcc) && (
					<Fact label="Bcc">
						<CopyValue value={list(email.bcc) ?? ""} />
					</Fact>
				)}
				{list(email.reply_to) && (
					<Fact label="Reply-to">
						<CopyValue value={list(email.reply_to) ?? ""} />
					</Fact>
				)}
				<Fact label={email.status === "scheduled" ? "Scheduled for" : "Created"}>
					<span className="tabular-nums">
						{formatDateTime(
							email.status === "scheduled" ? email.send_at : email.created_at,
						)}
					</span>
				</Fact>
				<Fact label="Sent with">
					{SOURCES[email.source] ?? email.source}
					{apiKey && (
						<Link
							to="/api-keys"
							className="text-muted-foreground transition-colors hover:text-foreground"
						>
							{" · "}
							{apiKey.name}
						</Link>
					)}
				</Fact>
				{data.log && (
					<Fact label="Log">
						<Link
							to="/logs/$id"
							params={{ id: data.log.id }}
							className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
						>
							<ScrollText className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="truncate">
								{data.log.method} {data.log.path}
							</span>
						</Link>
					</Fact>
				)}
				{email.message_id && (
					<Fact label="SES message id">
						<IdChip value={email.message_id} />
					</Fact>
				)}
				{email.tags?.length ? (
					<Fact
						label="Tags"
						className="sm:col-span-2"
					>
						<span className="flex flex-wrap gap-1">
							{email.tags.map((t) => (
								<span
									key={t.name}
									className="inline-flex h-6 items-center rounded-md bg-muted px-2 font-mono text-xs shadow-[inset_0_0_0_1px_var(--border)]"
								>
									<span className="text-muted-foreground">{t.name}:</span>
									&nbsp;{t.value}
								</span>
							))}
						</span>
					</Fact>
				) : null}
				{data.replies.length > 0 && (
					<Fact label={data.replies.length === 1 ? "Reply" : "Replies"}>
						<span className="flex flex-col gap-0.5">
							{data.replies.map((r) => (
								<Link
									key={r.id}
									to="/received/$id"
									params={{ id: r.id }}
									className="truncate underline-offset-2 hover:underline"
									title={formatDateTime(r.created_at)}
								>
									{r.from}
								</Link>
							))}
						</span>
					</Fact>
				)}
			</Facts>

			{(email.error || email.dropped) && (
				<Alert
					variant={
						email.error && !soft && email.status !== "suppressed"
							? "destructive"
							: "warning"
					}
				>
					<CircleAlert />
					<AlertTitle>
						{!email.error || email.dropped
							? email.status === "suppressed" || email.status === "failed"
								? "Not sent: nobody left to send to"
								: "Some recipients were left out"
							: soft
								? bounce?.category === "blocked"
									? `${bounce.title} (soft bounce)`
									: "The recipient's mail server couldn't take it (soft bounce)"
								: bounce
									? bounce.title
									: "SES didn't take this email"}
					</AlertTitle>
					<AlertDescription>
						{bounce && <p>{bounce.sentence}</p>}
						{email.error && !email.dropped && (
							<p className={cn(bounce && "font-mono text-xs text-muted-foreground")}>
								{email.error}
							</p>
						)}
						{email.dropped && (
							<ul className="mt-1 flex w-full flex-col gap-1.5">
								{Object.entries(email.dropped).map(([a, why]) => (
									<li
										key={a}
										className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
									>
										<span className="truncate font-medium text-foreground">
											{a}
										</span>
										<LeftOut why={why} />
									</li>
								))}
							</ul>
						)}
					</AlertDescription>
				</Alert>
			)}

			<Timeline
				title="Email events"
				steps={steps(data)}
			/>

			<Card className="min-w-0 gap-0 overflow-hidden p-0">
				<Tabs
					value={tab}
					onValueChange={setTab}
					className="gap-0"
				>
					<div className="flex items-center gap-2 border-b border-border/70 pr-3 pl-5">
						<TabsList
							variant="line"
							className="min-w-0 flex-1 justify-start overflow-x-auto [scrollbar-width:none] *:after:bottom-0"
						>
							{html && <TabsTrigger value="preview">Preview</TabsTrigger>}
							<TabsTrigger value="text">Plain text</TabsTrigger>
							{html && <TabsTrigger value="html">HTML</TabsTrigger>}
							{headers && <TabsTrigger value="headers">Headers</TabsTrigger>}
							<TabsTrigger value="raw">Raw</TabsTrigger>
							<TabsTrigger value="insights">
								Insights
								{attention.length > 0 && (
									<span className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning/15 px-1 text-2xs font-semibold text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)] tabular-nums">
										{attention.length}
									</span>
								)}
							</TabsTrigger>
						</TabsList>
						{tab === "preview" && (
							<div className="hidden items-center gap-0.5 rounded-md bg-muted p-0.5 sm:flex">
								{[
									{ on: false, icon: Monitor, label: "Desktop width" },
									{ on: true, icon: Smartphone, label: "Phone width" },
								].map((w) => (
									<button
										key={w.label}
										type="button"
										aria-label={w.label}
										title={w.label}
										aria-pressed={phone === w.on}
										onClick={() => setPhone(w.on)}
										className={cn(
											"flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:text-foreground",
											phone === w.on &&
												"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
										)}
									>
										<w.icon className="size-3.5" />
									</button>
								))}
							</div>
						)}
						{copyable[tab] && <CopyTab value={copyable[tab] ?? ""} />}
					</div>
					{html && (
						<TabsContent
							value="preview"
							forceMount
							className="data-[state=inactive]:hidden"
						>
							{/* Kept mounted between tabs, so the email isn't loaded again each time,
							    and faded in once it has painted instead of flashing white. */}
							{missing.length > 0 && (
								<p className="flex items-start gap-2 border-b border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
									<ImageOff className="mt-px size-3.5 shrink-0 text-faint" />
									<span>
										{missing.length === 1
											? "The inline image "
											: "The inline images "}
										<span className="font-mono text-foreground/80">
											{missing.map((n) => `cid:${n}`).join(", ")}
										</span>{" "}
										went out with the email, but Mailroom has no copy (it was
										sent before inline images were kept, or is over 300 KB), so
										the preview only marks where{" "}
										{missing.length === 1 ? "it goes" : "they go"}.
									</span>
								</p>
							)}
							<div
								className={cn(
									"bg-muted/60 transition-[padding] duration-300 ease-out",
									phone && "px-4 py-6",
								)}
							>
								<iframe
									title="Preview"
									sandbox="allow-popups allow-popups-to-escape-sandbox"
									srcDoc={srcDoc}
									onLoad={() => setPainted(srcDoc)}
									className={cn(
										"mx-auto block h-[480px] w-full bg-white transition-opacity duration-200 ease-out sm:h-[640px]",
										painted === srcDoc ? "opacity-100" : "opacity-0",
										phone &&
											"max-w-[390px] rounded-2xl shadow-[0_0_0_1px_var(--border),0_8px_24px_-8px_var(--shadow-color-strong)]",
									)}
								/>
							</div>
						</TabsContent>
					)}
					<TabsContent value="text">
						<pre
							className={cn(
								"max-h-[640px] overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap",
								!text && "font-sans text-sm text-muted-foreground",
							)}
						>
							{body ?? "This email has no plain-text part."}
						</pre>
					</TabsContent>
					{html && (
						<TabsContent value="html">
							<HtmlSource html={html} />
						</TabsContent>
					)}
					{headers && (
						<TabsContent value="headers">
							<dl className="divide-y divide-border/70 font-mono text-xs">
								{Object.entries(headers).map(([k, v]) => (
									<div
										key={k}
										className="grid gap-1 px-5 py-2.5 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4"
									>
										<dt className="text-muted-foreground">{k}</dt>
										<dd className="break-all">{String(v)}</dd>
									</div>
								))}
							</dl>
						</TabsContent>
					)}
					<TabsContent value="raw">
						<Code value={json} />
					</TabsContent>
					<TabsContent value="insights">
						<Insights items={found} />
					</TabsContent>
				</Tabs>
				{attachments.length > 0 && (
					<div className="flex flex-wrap gap-2 border-t border-border/70 px-5 py-3">
						{attachments.map((a) => (
							<span
								key={a.filename}
								className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs"
							>
								<Paperclip className="size-3 text-muted-foreground" />
								{a.filename}
								<span className="text-muted-foreground tabular-nums">
									{Math.ceil(a.size / 1024)} KB
								</span>
							</span>
						))}
					</div>
				)}
			</Card>
		</Page>
	);
}

/** Source code with line numbers, JSON keys and HTML tags tinted. */
function Code({ value }: { value: string }) {
	const lines = value.split("\n");
	return (
		<div className="max-h-[640px] overflow-auto py-4 font-mono text-xs leading-[1.7]">
			<table className="border-collapse">
				<tbody>
					{lines.map((line, i) => (
						<tr key={i}>
							<td className="w-12 pr-3 pl-3 text-right align-top text-faint select-none tabular-nums sm:pr-4 sm:pl-5">
								{i + 1}
							</td>
							<td className="pr-5 whitespace-pre-wrap [overflow-wrap:anywhere]">
								<Tint line={line} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const HTML_TINT: Record<HtmlKind, string> = {
	punct: "text-faint",
	tag: "text-[oklch(0.55_0.17_330)] dark:text-[oklch(0.74_0.14_330)]",
	attr: "text-brand",
	value: "text-success",
	comment: "text-faint italic",
	doctype: "text-muted-foreground",
	text: "",
};

/**
 * Where each line's block ends, as a code editor folds by indent: a line followed by deeper lines
 * folds them, up to the next line back at its depth (its closing tag, which stays in sight).
 */
function foldEnds(lines: HtmlLine[]): (number | null)[] {
	const ends: (number | null)[] = lines.map(() => null);
	const open: number[] = [];
	lines.forEach((line, i) => {
		while (
			open.length &&
			(lines[open[open.length - 1] as number] as HtmlLine).depth >= line.depth
		)
			ends[open.pop() as number] = i - 1;
		if ((lines[i + 1]?.depth ?? -1) > line.depth) open.push(i);
	});
	for (const at of open) ends[at] = lines.length - 1;
	return ends;
}

/** The tag a line opens ("head" for `<head>`), if it opens one. */
const opens = (line: HtmlLine) =>
	line.segs[0]?.[0] === "punct" && line.segs[0][1] === "<" ? line.segs[1]?.[1] : undefined;

/** The email's HTML laid out to read (src/lib/format-html.ts) and highlighted, with line
 * numbers. A wrapped line keeps its indent, plus a little, so the tree still reads. Blocks fold
 * from the gutter like in an editor; <head> starts folded, since the body is what one reads. */
function HtmlSource({ html }: { html: string }) {
	const lines = useMemo(() => {
		try {
			return formatHtml(html);
		} catch {
			return html.split("\n").map((l) => ({ depth: 0, segs: [["text", l]] as HtmlSeg[] }));
		}
	}, [html]);
	const ends = useMemo(() => foldEnds(lines), [lines]);
	const [folded, setFolded] = useState<Set<number>>(
		() =>
			new Set(
				lines.flatMap((l, i) => (opens(l) === "head" && (ends[i] ?? i) - i > 3 ? [i] : [])),
			),
	);
	const toggle = (i: number) =>
		setFolded((f) => {
			const next = new Set(f);
			if (!next.delete(i)) next.add(i);
			return next;
		});
	const foldable = ends.flatMap((end, i) => (end !== null ? [i] : []));
	// Below the top level only, so "Fold all" leaves <html>, <head> and <body> in sight.
	const deep = foldable.filter((i) => (lines[i] as HtmlLine).depth >= 2);
	const rows: { line: HtmlLine; i: number; hidden: number }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const end = folded.has(i) ? (ends[i] ?? i) : i;
		rows.push({ line: lines[i] as HtmlLine, i, hidden: end - i });
		i = end;
	}
	return (
		<div>
			{/* Its own row above the code: floating over it, it covered the first lines on phones. */}
			{foldable.length > 0 && (
				<div className="flex justify-end gap-1 border-b px-3 py-1.5">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs text-muted-foreground"
						onClick={() => setFolded(new Set(deep))}
					>
						<ChevronsDownUp />
						Fold all
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-2 text-xs text-muted-foreground"
						disabled={folded.size === 0}
						onClick={() => setFolded(new Set())}
					>
						<ChevronsUpDown />
						Unfold all
					</Button>
				</div>
			)}
			<div className="max-h-[640px] overflow-auto py-4 font-mono text-xs leading-[1.7]">
				<table className="w-full border-collapse">
					<tbody>
						{rows.map(({ line, i, hidden }) => (
							<tr
								key={i}
								className="group/line"
							>
								<td className="w-12 pr-1 pl-3 text-right align-top text-faint select-none tabular-nums sm:pl-5">
									{i + 1}
								</td>
								<td className="w-5 align-top select-none">
									{ends[i] !== null && (
										<button
											type="button"
											onClick={() => toggle(i)}
											aria-label={hidden ? "Unfold" : "Fold"}
											aria-expanded={!hidden}
											className={cn(
												"flex h-[1.7em] w-4 items-center justify-center rounded pointer-coarse:w-5 text-faint transition-opacity outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100",
												hidden
													? "opacity-100"
													: "opacity-0 group-hover/line:opacity-100 pointer-coarse:opacity-100",
											)}
										>
											<ChevronDown
												className={cn(
													"size-3 transition-transform",
													hidden && "-rotate-90",
												)}
											/>
										</button>
									)}
								</td>
								<td
									className="pr-3 whitespace-pre-wrap [overflow-wrap:anywhere] sm:pr-5"
									style={{
										// Capped, so a deep tree still leaves a phone room for the code.
										paddingLeft: `calc(min(${line.depth * 2}ch, 25%) + 2ch)`,
										textIndent: "-2ch",
									}}
								>
									{line.segs.map(([kind, text], j) =>
										kind === "text" ? (
											text
										) : (
											<span
												key={j}
												className={HTML_TINT[kind]}
											>
												{text}
											</span>
										),
									)}
									{hidden > 0 && (
										<button
											type="button"
											onClick={() => toggle(i)}
											className="mx-1.5 rounded bg-muted px-1.5 align-baseline text-[11px] text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)] [text-indent:0] hover:bg-accent hover:text-foreground"
										>
											⋯ {hidden.toLocaleString("en-US")}{" "}
											{hidden === 1 ? "line" : "lines"}
										</button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

const TOKEN =
	/("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|(<\/?[a-zA-Z][\w-]*)|(\b(?:true|false|null)\b)/g;

function Tint({ line }: { line: string }) {
	const parts: React.ReactNode[] = [];
	let last = 0;
	for (const m of line.matchAll(TOKEN)) {
		const at = m.index ?? 0;
		if (at > last) parts.push(line.slice(last, at));
		const cls = m[1]
			? "text-brand"
			: m[2]
				? "text-success"
				: m[3]
					? "text-[oklch(0.7_0.15_330)]"
					: "text-warning";
		parts.push(
			<span
				key={at}
				className={cls}
			>
				{m[0]}
			</span>,
		);
		last = at + m[0].length;
	}
	parts.push(line.slice(last));
	return <>{parts}</>;
}

function Insights({ items }: { items: Insight[] }) {
	const groups = [
		{ title: "Needs attention", items: items.filter((i) => !i.ok) },
		{ title: "Doing great", items: items.filter((i) => i.ok) },
	].filter((g) => g.items.length > 0);
	return (
		<div className="flex flex-col gap-6 p-5">
			{groups.map((g) => (
				<section key={g.title}>
					<h3 className="mb-2 text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
						{g.title}
					</h3>
					<ul className="divide-y divide-border/70 overflow-hidden rounded-lg shadow-[0_0_0_1px_var(--border)]">
						{g.items.map((i) => (
							<li
								key={i.title}
								className="flex gap-3 px-4 py-3"
							>
								{i.ok ? (
									<CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
								) : (
									<TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
								)}
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">{i.title}</p>
									<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
										{i.detail}
									</p>
									{i.value && (
										<code className="mt-2 block truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
											{i.value}
										</code>
									)}
								</div>
							</li>
						))}
					</ul>
				</section>
			))}
			<p className="text-xs text-faint">
				Checked from what Mailroom kept of this email. A clean report doesn't promise the
				inbox: your domain's reputation matters most.
			</p>
		</div>
	);
}

function CopyTab({ value }: { value: string }) {
	const { copied, copy } = useCopy();
	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => copy(value)}
		>
			<CopyIcon copied={copied} />
			{copied ? "Copied" : "Copy"}
		</Button>
	);
}

function MoreMenu({ id }: { id: string }) {
	const { copy } = useCopy();
	return (
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
					onSelect={() => {
						copy(id);
						toast.success("Email id copied");
					}}
				>
					<CopyIcon copied={false} />
					Copy email id
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						copy(window.location.href);
						toast.success("Link copied");
					}}
				>
					<Link2 />
					Copy link
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
