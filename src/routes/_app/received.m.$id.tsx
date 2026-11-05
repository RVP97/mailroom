import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	CircleAlert,
	CircleCheck,
	CircleX,
	Download,
	Forward,
	ImageOff,
	Inbox,
	Info,
	MessagesSquare,
	Paperclip,
	Reply,
	Send,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer, type Call } from "@/components/api-drawer";
import { CopyValue } from "@/components/copy";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getReceivedFn, receivedReportFn, replyReceivedFn } from "@/functions/received";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/** One received message whole: its preview, headers and deliverability report. Its conversation
 * (received.$id.tsx) is where it's answered. */
export const Route = createFileRoute("/_app/received/m/$id")({
	loader: ({ params }) => getReceivedFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.email.subject || "Received email"} · Mailroom` }],
	}),
	component: ReceivedPage,
	pendingComponent: ReceivedSketch,
});

type Data = Awaited<ReturnType<typeof getReceivedFn>>;

/** Drawn from the row the Received list showed, when it did. */
function ReceivedSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data & { id: string }>("received-page", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<ReceivedPage />
			</Sketch>
		);
	const listed = listedRow<{ from: string; to: string[]; subject: string; created_at: string }>(
		"received",
		params.id,
	);
	const data: Data = {
		email: {
			object: "email",
			id: params.id ?? "",
			brand_id: "",
			created_at: listed?.created_at ?? ago(30),
			from: listed?.from ?? "guest@example.com",
			to: listed?.to ?? ["reservas@example.com"],
			cc: [],
			bcc: [],
			message_id: null,
			spam: false,
			attachments: [],
			reply_to: [],
			subject: listed?.subject ?? "Question about my booking",
			in_reply_to: null,
			in_reply_to_email_id: null,
			actions: [],
			recipients: [],
			size: 20_000,
			verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
			html: "<p></p>",
			text: " ",
			headers: null,
		},
		attachments: [],
		answers: null,
		brand: null,
		conversationId: null,
	};
	return (
		<Sketch data={data}>
			<ReceivedPage />
		</Sketch>
	);
}

/** Nothing in the preview reaches out: no scripts (the frame's sandbox), no remote images or
 * fonts (a sender would learn it was read) until the reader asks for images. */
const csp = (images: boolean) =>
	`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${images ? " https: http:" : ""}; font-src data:">`;
const BASE = '<base target="_blank">';
// First thing in the document, always: a sender's "<head>" inside a comment or a string can't
// push it past their own content (the parser puts a leading <meta> in the head either way).
const preview = (html: string, images: boolean) => `${csp(images)}${BASE}${html}`;
const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?https?:/i.test(html);

const VERDICTS = [
	["spam", "Spam"],
	["virus", "Virus"],
	["spf", "SPF"],
	["dkim", "DKIM"],
	["dmarc", "DMARC"],
] as const;

/** A verdict as a badge: a pass is good news, except for spam and viruses, where it's clean. */
function Verdict({ name, value }: { name: string; value: string | null }) {
	const status =
		value === "PASS"
			? "verified"
			: value === "FAIL"
				? "failed"
				: value
					? "pending"
					: "canceled";
	const label =
		value === "PASS"
			? name === "Spam" || name === "Virus"
				? `${name}: clean`
				: `${name}: pass`
			: value === "FAIL"
				? name === "Spam" || name === "Virus"
					? `${name}: found`
					: `${name}: fail`
				: `${name}: ${value?.toLowerCase().replace(/_/g, " ") ?? "not checked"}`;
	return (
		<StatusBadge
			status={status}
			label={label}
		/>
	);
}

const size = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1)} MB`
		: `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

function ReceivedPage() {
	const data = usePage(Route).data;
	const me = useMe();
	const canManage = allows(me.active?.access, "inbox:reply");
	const [replying, setReplying] = useState(false);
	// Reloaded, its skeleton draws from this (bodies left out: they're drawn as placeholders).
	useOpened(
		"received-page",
		useMemo(
			() => ({
				...data,
				id: data.email.id,
				email: {
					...data.email,
					html: data.email.html ? "<p></p>" : null,
					text: data.email.text ? " " : null,
				},
			}),
			[data],
		),
	);
	const { email, attachments, brand } = data;
	const [tab, setTab] = useState(email.html ? "preview" : "text");
	const [images, setImages] = useState(false);
	const srcDoc = useMemo(
		() => (email.html ? preview(email.html, images) : ""),
		[email.html, images],
	);
	const remote = email.html ? hasRemoteImages(email.html) : false;
	const replyTo = email.reply_to[0] ?? email.from;
	const calls: Call[] = [
		{ title: "Retrieve this email", method: "GET", path: `/emails/receiving/${email.id}` },
		{
			title: "Its attachments, with download links",
			method: "GET",
			path: `/emails/receiving/${email.id}/attachments`,
		},
		{
			title: "Reply in the same thread",
			method: "POST",
			path: "/emails",
			body: {
				from: email.to[0] ?? "you@example.com",
				to: [replyTo],
				subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
				text: "…",
				...(email.message_id
					? { headers: { "In-Reply-To": email.message_id, References: email.message_id } }
					: {}),
			},
		},
	];
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
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
					{brand && (
						<>
							<span aria-hidden="true"> / </span>
							<Link
								to="/received"
								search={{ brand: brand.id }}
								className="rounded-sm transition-colors hover:text-foreground"
							>
								{brand.name}
							</Link>
						</>
					)}
				</nav>
				<RecordHeader
					icon={Inbox}
					tone={email.spam ? "amber" : "blue"}
					kind="Received email"
					title={email.subject || "(no subject)"}
					actions={
						<>
							{data.conversationId && (
								<Button
									variant="outline"
									asChild
								>
									<Link
										to="/received/$id"
										params={{ id: data.conversationId }}
									>
										<MessagesSquare />
										Conversation
									</Link>
								</Button>
							)}
							{canManage && (
								<Button onClick={() => setReplying(true)}>
									<Reply />
									Reply
								</Button>
							)}
							<ApiDrawer
								title="This email in the API"
								calls={calls}
							/>
						</>
					}
				/>
			</div>

			<Facts>
				<Fact label="From">
					<CopyValue value={email.from} />
				</Fact>
				<Fact label="To">
					<CopyValue value={email.to.join(", ") || email.recipients.join(", ")} />
				</Fact>
				{email.cc.length > 0 && (
					<Fact label="Cc">
						<CopyValue value={email.cc.join(", ")} />
					</Fact>
				)}
				{email.reply_to.length > 0 && (
					<Fact label="Reply to">
						<CopyValue value={email.reply_to.join(", ")} />
					</Fact>
				)}
				<Fact label="Received">{formatDateTime(email.created_at)}</Fact>
				{data.answers && (
					<Fact label="Answers">
						<Link
							to="/emails/$id"
							params={{ id: data.answers.id }}
							className="truncate underline-offset-2 hover:underline"
						>
							{data.answers.subject || "(no subject)"}
						</Link>
					</Fact>
				)}
				<Fact label="Size">{size(email.size)}</Fact>
				<Fact label="Id">
					<IdChip value={email.id} />
				</Fact>
			</Facts>

			<ReplyDialog
				open={replying}
				onOpenChange={setReplying}
				email={email}
			/>
			{email.actions.length > 0 && (
				<ul className="flex flex-col gap-1 rounded-lg bg-muted/60 px-4 py-3 text-sm">
					{email.actions.map((a) => (
						<li
							key={a}
							className="flex items-center gap-2"
						>
							<Forward className="size-4 text-muted-foreground" />
							{a}
						</li>
					))}
				</ul>
			)}

			<div className="flex flex-wrap gap-2">
				{VERDICTS.map(([key, name]) => (
					<Verdict
						key={key}
						name={name}
						value={email.verdicts[key]}
					/>
				))}
			</div>

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
							{email.html && <TabsTrigger value="preview">Preview</TabsTrigger>}
							<TabsTrigger value="text">Plain text</TabsTrigger>
							{email.headers && <TabsTrigger value="headers">Headers</TabsTrigger>}
							{email.headers && (
								<TabsTrigger value="report">Deliverability</TabsTrigger>
							)}
						</TabsList>
						{tab === "preview" && remote && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setImages((v) => !v)}
							>
								<ImageOff />
								{images ? "Hide images" : "Show images"}
							</Button>
						)}
					</div>
					{email.html && (
						<TabsContent value="preview">
							<div className="bg-muted/60">
								<iframe
									title="Preview"
									sandbox="allow-popups allow-popups-to-escape-sandbox"
									srcDoc={srcDoc}
									className="mx-auto block h-[480px] w-full bg-white sm:h-[640px]"
								/>
							</div>
						</TabsContent>
					)}
					<TabsContent value="text">
						<pre
							className={cn(
								"max-h-[640px] overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap",
								!email.text && "font-sans text-sm text-muted-foreground",
							)}
						>
							<Ph>
								{email.text ??
									(email.html
										? "No plain-text part: see the preview."
										: "The message is no longer kept (past its retention).")}
							</Ph>
						</pre>
					</TabsContent>
					{email.headers && tab === "report" && (
						<TabsContent value="report">
							<Report id={email.id} />
						</TabsContent>
					)}
					{email.headers && (
						<TabsContent value="headers">
							<pre className="max-h-[640px] overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
								{Object.entries(email.headers)
									.map(([k, v]) => `${k}: ${v}`)
									.join("\n")}
							</pre>
						</TabsContent>
					)}
				</Tabs>
				{attachments.length > 0 && (
					<div className="flex flex-wrap gap-2 border-t border-border/70 px-5 py-3">
						{attachments.map((a) => (
							<a
								key={a.id}
								href={a.download_url}
								className="inline-flex h-7 items-center gap-1.5 rounded-md bg-muted px-2 text-xs hover:text-foreground"
							>
								<Paperclip className="size-3 text-muted-foreground" />
								{a.filename ?? a.id}
								<span className="text-muted-foreground tabular-nums">
									{size(a.size)}
								</span>
								<Download className="size-3 text-muted-foreground" />
							</a>
						))}
					</div>
				)}
			</Card>
		</Page>
	);
}

function ReplyDialog({
	open,
	onOpenChange,
	email,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	email: Data["email"];
}) {
	const router = useRouter();
	const [from, setFrom] = useState(email.recipients[0] ?? email.to[0] ?? "");
	const [to, setTo] = useState(
		(email.reply_to.length ? email.reply_to : [email.from]).join(", "),
	);
	const [subject, setSubject] = useState(
		/^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
	);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-lg">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const r = await replyReceivedFn({
								data: { id: email.id, from, to, subject, text },
							});
							toast.success("Reply sent");
							onOpenChange(false);
							setText("");
							if (r.id)
								await router.navigate({ to: "/emails/$id", params: { id: r.id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Reply</DialogTitle>
						<DialogDescription>
							It goes in the same thread in their inbox, and their answer comes back
							here.
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-4">
						<Field>
							<FieldLabel htmlFor="reply-from">From</FieldLabel>
							<Input
								id="reply-from"
								required
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
							<FieldDescription>
								An address on one of your verified domains.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor="reply-to">To</FieldLabel>
							<Input
								id="reply-to"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="reply-subject">Subject</FieldLabel>
							<Input
								id="reply-subject"
								required
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="reply-text">Message</FieldLabel>
							<Textarea
								id="reply-text"
								required
								rows={8}
								value={text}
								onChange={(e) => setText(e.target.value)}
							/>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !text.trim()}
						>
							{busy ? <Spinner /> : <Send />}
							Send reply
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

type ReportData = Awaited<ReturnType<typeof receivedReportFn>>;

const REPORT_ICON = {
	pass: [CircleCheck, "text-success"],
	warn: [CircleAlert, "text-warning"],
	fail: [CircleX, "text-destructive"],
	info: [Info, "text-muted-foreground"],
} as const;

const GROUPS = [
	["authentication", "Authentication"],
	["headers", "Headers and filters"],
	["content", "Content"],
] as const;

/**
 * How a mailbox provider sees this email (mail-tester style): send your own email to a Mailroom
 * address to test it before it goes to customers.
 */
function Report({ id }: { id: string }) {
	const [report, setReport] = useState<ReportData | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		receivedReportFn({ data: { id } })
			.then(setReport)
			.catch(async (e) => setError(await errorMessage(e)));
	}, [id]);
	if (error) return <p className="p-5 text-sm text-destructive">{error}</p>;
	if (!report)
		return (
			<div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
				<Spinner /> Checking…
			</div>
		);
	return (
		<div className="flex flex-col gap-5 p-5">
			<div className="flex items-baseline gap-3">
				<span
					className={cn(
						"text-3xl font-semibold tabular-nums",
						report.score >= 9
							? "text-success"
							: report.score >= 7
								? "text-warning"
								: "text-destructive",
					)}
				>
					{report.score}
				</span>
				<span className="text-sm text-muted-foreground">
					out of 10. Two off for each failure and half a point for each warning.
				</span>
			</div>
			{GROUPS.map(([group, label]) => {
				const checks = report.checks.filter((c) => c.group === group);
				if (!checks.length) return null;
				return (
					<section
						key={group}
						className="flex flex-col gap-2"
					>
						<h3 className="eyebrow">{label}</h3>
						<ul className="flex flex-col gap-2.5">
							{checks.map((c) => {
								const [Icon, color] = REPORT_ICON[c.status];
								return (
									<li
										key={c.id}
										className="flex gap-2.5 text-sm"
									>
										<Icon className={cn("mt-0.5 size-4 shrink-0", color)} />
										<span className="min-w-0">
											<span className="font-medium">{c.title}</span>
											{c.detail && (
												<span className="block text-muted-foreground break-words">
													{c.detail}
												</span>
											)}
										</span>
									</li>
								);
							})}
						</ul>
					</section>
				);
			})}
		</div>
	);
}
