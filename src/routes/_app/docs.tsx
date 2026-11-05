import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ArrowUpRight, KeyRound, RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Method } from "@/components/api-drawer";
import { BrandFilter } from "@/components/brand-filter";
import { CodeBlock, CodeTabs } from "@/components/code-block";
import { Confirm } from "@/components/confirm";
import { CopyChip, CopyField } from "@/components/copy";
import { Page, PageHeader, Section, TableCard } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	createSmtpCredentialsFn,
	deleteSmtpCredentialsFn,
	sendingStatusFn,
	smtpCredentialsFn,
} from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { listedRow, Sketch, useOpened, usePage } from "@/lib/sketch";

type Tab = "api" | "endpoints" | "smtp" | "webhooks";
const TABS: Tab[] = ["api", "endpoints", "smtp", "webhooks"];

export const Route = createFileRoute("/_app/docs")({
	validateSearch: (s: Record<string, unknown>): { tab?: Tab; brand?: string } => ({
		...(TABS.includes(s.tab as Tab) && s.tab !== "api" ? { tab: s.tab as Tab } : {}),
		...(typeof s.brand === "string" && s.brand ? { brand: s.brand } : {}),
	}),
	loaderDeps: ({ search }) => ({ brand: search.brand }),
	loader: async ({ deps }) => {
		const data = { brand: deps.brand };
		const [sending, smtp] = await Promise.all([
			sendingStatusFn({ data }),
			smtpCredentialsFn({ data }),
		]);
		return { sending, smtp };
	},
	head: () => ({ meta: [{ title: "API & SMTP · Mailroom" }] }),
	component: Docs,
	pendingComponent: DocsSketch,
});

type Data = (typeof Route)["types"]["loaderData"];

/** The guide is the same for everyone; only the SMTP tab shows the brand's tenant and login. */
function DocsSketch() {
	const { search } = usePage(Route);
	const opened = listedRow<Data>("docs-page", search.brand ?? "");
	return (
		<Sketch data={opened ?? { sending: null, smtp: null }}>
			<Docs />
		</Sketch>
	);
}

type Endpoint = [method: "GET" | "POST" | "PATCH" | "DELETE", path: string, does: string];

/** Every endpoint, one method to a row, grouped by what it acts on (as Resend's reference is). */
const ENDPOINTS: [group: string, Endpoint[]][] = [
	[
		"Emails",
		[
			[
				"POST",
				"/emails",
				"Send an email, now or at scheduled_at. Takes an Idempotency-Key header, and template: { id, variables } instead of html and text.",
			],
			[
				"POST",
				"/emails/batch",
				"Send up to 100 emails in one call, queued at the account's rate.",
			],
			[
				"GET",
				"/emails",
				"List emails (status, day, domain, provider, search, after, limit). status: delivered, opened, clicked, complained, sent, delivery_delayed, scheduled, queued, bounced (hard bounce), soft_bounced, failed, suppressed, firewall, unsubscribed, or not_delivered for every way it didn't arrive.",
			],
			["GET", "/emails/:id", "An email with its body and every event."],
			["PATCH", "/emails/:id", "Reschedule a scheduled email."],
			["POST", "/emails/:id/cancel", "Cancel a scheduled email."],
		],
	],
	[
		"Templates",
		[
			["GET", "/templates", "List templates."],
			[
				"POST",
				"/templates",
				"Create one: name, html, and optionally alias, from, subject, reply_to, text, variables (key, type, fallback_value), publish.",
			],
			["GET", "/templates/:id", "A template by id or alias, with its draft."],
			["PATCH", "/templates/:id", "Change its draft (sends keep the published version)."],
			["POST", "/templates/:id/publish", "Make the draft what sends use."],
			["POST", "/templates/:id/duplicate", "Copy it as a new draft."],
			["DELETE", "/templates/:id", "Delete it."],
		],
	],
	[
		"Broadcasts",
		[
			["GET", "/broadcasts", "List broadcasts (brand to see one brand's)."],
			[
				"POST",
				"/broadcasts",
				"Create a draft: segment_id, from, subject, html or template { id, variables }, and optionally topic_id, preview_text, reply_to, text; send: true (with scheduled_at) sends it.",
			],
			["GET", "/broadcasts/:id", "A broadcast with its content and email counts."],
			["PATCH", "/broadcasts/:id", "Change a draft."],
			[
				"POST",
				"/broadcasts/:id/send",
				"Send it now, or at scheduled_at (up to 30 days ahead).",
			],
			[
				"POST",
				"/broadcasts/:id/cancel",
				"Unschedule it (back to draft), or stop one that's sending.",
			],
			["DELETE", "/broadcasts/:id", "Delete a draft or scheduled broadcast."],
		],
	],
	[
		"Deliverability",
		[
			[
				"POST",
				"/emails/check",
				"Check content before sending (subject, html, text, marketing): Gmail clipping, all-caps subjects, image-only bodies, URL shorteners and more.",
			],
			[
				"GET",
				"/domains/:id/health",
				"The daily check of the domain's DNS against what SES needs, and the domain blocklists.",
			],
			["POST", "/domains/:id/health", "Check the domain's DNS and blocklists now."],
		],
	],
	[
		"Archive",
		[
			[
				"GET",
				"/archive",
				"The brand's long-term archive in R2 (kind: emails, bodies or received; cursor): what retention took, as gzip NDJSON by day.",
			],
			["GET", "/archive/file?key=…", "Download one archive file."],
		],
	],
	[
		"Inbound rules",
		[
			["GET", "/inbound-rules", "List inbound rules, in the order they're checked."],
			[
				"POST",
				"/inbound-rules",
				"Create one: name, match_to (address, *@domain, name@* or *), match_from, match_subject, action (forward with forward_to, or drop), continue, enabled.",
			],
			["GET", "/inbound-rules/:id", "A rule."],
			["PATCH", "/inbound-rules/:id", "Change a rule."],
			["DELETE", "/inbound-rules/:id", "Delete a rule."],
		],
	],
	[
		"Automations",
		[
			[
				"POST",
				"/events",
				"An event about a contact (event, email or contact_id, data): automations listening for it start.",
			],
			["GET", "/automations", "List automations."],
			[
				"POST",
				"/automations",
				"Create one: name, trigger (contact.created, segment.joined or event), steps (wait, send, condition), status.",
			],
			["GET", "/automations/:id", "An automation."],
			["PATCH", "/automations/:id", "Change it, or turn it on (status: active) or pause it."],
			["GET", "/automations/:id/runs", "How many runs are in each state, and the latest."],
			["DELETE", "/automations/:id", "Delete it (runs under way stop)."],
		],
	],
	[
		"Contacts",
		[
			[
				"GET",
				"/contacts",
				"List a brand's contacts (segment_id, search, unsubscribed, after).",
			],
			[
				"POST",
				"/contacts",
				"Add a contact, or update the one with that address: names, unsubscribed, properties, segments, topics.",
			],
			["GET", "/contacts/:id", "A contact by id or address."],
			["PATCH", "/contacts/:id", "Change a contact."],
			["DELETE", "/contacts/:id", "Delete a contact."],
			["POST", "/contacts/:id/segments/:segment_id", "Add a contact to a segment."],
			["DELETE", "/contacts/:id/segments/:segment_id", "Take a contact out of a segment."],
			["GET", "/contacts/:id/topics", "Each topic and whether the contact gets it."],
			["PATCH", "/contacts/:id/topics", "Opt a contact in or out: [{ id, subscription }]."],
			["GET", "/segments", "List segments with their contact counts (/audiences works too)."],
			["POST", "/segments", "Create a segment."],
			["DELETE", "/segments/:id", "Delete a segment (its contacts stay)."],
			["GET", "/topics", "List topics."],
			[
				"POST",
				"/topics",
				"Create a topic: name, description, default_subscription, visibility.",
			],
			["DELETE", "/topics/:id", "Delete a topic."],
			["GET", "/contact-properties", "List contact properties."],
			["POST", "/contact-properties", "Create one: key, type, fallback_value."],
			["DELETE", "/contact-properties/:id", "Delete one."],
			["GET", "/signup-forms", "List the brand's sign-up forms."],
			[
				"POST",
				"/signup-forms",
				"Create one: name, title, from, segment_id, topic_id, website, redirect_url, ask_name, design (button, description, success, accent, background, text, layout, radius, font…). Answers with its html and hosted url.",
			],
			[
				"GET",
				"/signup-forms/:id",
				"A form with its embed html and whether Turnstile guards it.",
			],
			["PATCH", "/signup-forms/:id", "Change a form, or turn it off (enabled: false)."],
			["DELETE", "/signup-forms/:id", "Delete a form (contacts it added stay)."],
		],
	],
	[
		"Domains",
		[
			["GET", "/domains", "List domains."],
			["POST", "/domains", "Add a domain."],
			["GET", "/domains/:id", "A domain with its DNS records."],
			[
				"PATCH",
				"/domains/:id",
				"Change its purpose (transactional or marketing), pause it, or turn tracking on or off.",
			],
			["DELETE", "/domains/:id", "Remove a domain."],
			["POST", "/domains/:id/verify", "Check its verification now."],
		],
	],
	[
		"API keys",
		[
			["GET", "/api-keys", "List API keys."],
			["POST", "/api-keys", "Create an API key."],
			["DELETE", "/api-keys/:id", "Delete an API key."],
		],
	],
	[
		"Webhooks",
		[
			["GET", "/webhooks", "List webhook endpoints."],
			["POST", "/webhooks", "Add an endpoint."],
			["PATCH", "/webhooks/:id", "Change an endpoint."],
			["DELETE", "/webhooks/:id", "Delete an endpoint."],
			[
				"POST",
				"/webhooks/:id/replay_failed",
				"Send again what it gave up on in the last 7 days.",
			],
		],
	],
	[
		"Suppressions",
		[
			["GET", "/suppressions", "List suppressed addresses."],
			[
				"GET",
				"/suppressions/:email",
				"Retrieve one (the newest brand's; ?brand= picks one).",
			],
			["POST", "/suppressions", "Suppress an address."],
			["DELETE", "/suppressions/:email", "Send to an address again."],
		],
	],
	[
		"Unsubscribes",
		[
			["GET", "/unsubscribes", "List people who left an unsubscribe group (group, search)."],
			["POST", "/unsubscribes", "Take someone out of a group."],
			[
				"DELETE",
				"/unsubscribes/:group/:email",
				"Put someone back in a group, when they ask.",
			],
		],
	],
	[
		"Brands",
		[
			["GET", "/brands", "List brands (the organization's own first)."],
			[
				"POST",
				"/brands",
				"Add a brand (name, external_id): its own SES tenant and suppression list.",
			],
			["GET", "/brands/:id", "A brand by id, slug or external_id."],
			["PATCH", "/brands/:id", "Rename it, or pause and resume its sending."],
			["DELETE", "/brands/:id?move_domains_to=:id", "Remove it, moving its domains."],
		],
	],
	[
		"Recipients",
		[
			[
				"GET",
				"/recipients/:email",
				"Can they get email and why not, their unsubscribes and last 50 emails. Logged.",
			],
		],
	],
	[
		"Firewall",
		[
			[
				"GET",
				"/firewall",
				"A brand's firewall (?brand=, or the organization's own): which checks are on, and the never and always lists.",
			],
			[
				"PATCH",
				"/firewall",
				"brand, block_disposable, block_free, block_plus, never, always: each optional.",
			],
		],
	],
	[
		"Status and stats",
		[
			[
				"GET",
				"/status",
				"Can each brand send now, and why not; paused domains and webhooks down.",
			],
			[
				"GET",
				"/stats?days=30",
				"Counts by day, bounce and complaint rates, and by mailbox provider.",
			],
		],
	],
];

/** A tab's sections, with a hairline between them. */
const PANEL =
	"flex flex-col gap-10 [&>section+section]:border-t [&>section+section]:border-border/70 [&>section+section]:pt-10";

/** Inline code in running text. */
const C = ({ children }: { children: ReactNode }) => (
	<code className="rounded bg-muted px-1 py-px font-mono whitespace-nowrap text-[0.92em] text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
		{children}
	</code>
);

/** Short facts under an example, one to a line. */
function Notes({ children }: { children: ReactNode }) {
	return (
		<ul className="flex flex-col gap-1.5 text-sm text-muted-foreground text-pretty [&>li]:relative [&>li]:pl-4 [&>li]:before:absolute [&>li]:before:top-[0.55em] [&>li]:before:left-1 [&>li]:before:size-1 [&>li]:before:rounded-full [&>li]:before:bg-border-strong">
			{children}
		</ul>
	);
}

const SEND = {
	from: "Acme <hello@mail.acme.com>",
	to: '["customer@example.com"]',
	subject: "Your receipt",
	html: "<p>Thanks for your order.</p>",
};

function Docs() {
	const { data, search } = usePage(Route);
	const { sending, smtp } = data;
	// Kept for the skeleton without the SMTP username (only its length).
	useOpened(
		"docs-page",
		useMemo(
			() => ({
				...data,
				id: search.brand ?? "",
				smtp: data.smtp && {
					...data.smtp,
					username: "0".repeat(data.smtp.username.length),
				},
			}),
			[data, search.brand],
		),
	);
	const me = useMe();
	const canManage = allows(me.active?.access, "developers:keys");
	const { brand } = search;
	// New credentials, until the page is left: the only time the password can be seen.
	const [fresh, setFresh] = useState<{ username: string; password: string } | null>(null);
	const smtpUser = fresh?.username ?? smtp?.username;
	const tab = search.tab ?? "api";
	const navigate = Route.useNavigate();
	// Each brand has its own SMTP login and SES tenant.
	useEffect(() => setFresh(null), []);
	// The server's first paint draws this page as its own skeleton, where there is no window.
	const base = `${typeof window === "undefined" ? "" : window.location.origin}/api`;
	const region = sending?.tenant_arn?.split(":")[3] ?? "us-east-1";
	const host = `email-smtp.${region}.amazonaws.com`;
	const configurationSet = sending?.configuration_set ?? "mailroom-<organization>";
	const tenant = sending?.tenant_name ?? "mailroom-<organization>";

	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="API & SMTP"
				description="Send from code with the API (it follows Resend's), or from any app that speaks SMTP."
				actions={
					<Button
						variant="outline"
						asChild
					>
						<Link to="/api-keys">
							<KeyRound />
							API keys
						</Link>
					</Button>
				}
			/>

			<Tabs
				value={tab}
				onValueChange={(v) =>
					navigate({
						search: { ...(v === "api" ? {} : { tab: v as Tab }), brand },
						replace: true,
						resetScroll: false,
					})
				}
				className="gap-8"
			>
				<div className="-mt-1 border-b border-border/70">
					<TabsList
						variant="line"
						className="justify-start gap-5 overflow-x-auto [scrollbar-width:none] *:after:bottom-0"
					>
						<TabsTrigger value="api">API</TabsTrigger>
						<TabsTrigger value="endpoints">Endpoints</TabsTrigger>
						<TabsTrigger value="smtp">SMTP</TabsTrigger>
						<TabsTrigger value="webhooks">Webhooks</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent
					value="api"
					className={PANEL}
				>
					<Section
						title="Send with the API"
						description="Authenticate with an API key as a bearer token. Resend's SDKs work too, pointed at this base URL."
					>
						<Card className="grid gap-4 p-5 sm:grid-cols-2">
							<CopyField
								label="Base URL"
								value={base}
							/>
							<LinkField
								label="API key"
								placeholder="Bearer mr_…"
								action="Create one"
								to="/api-keys"
							/>
						</Card>
						<CodeTabs
							title="POST /emails"
							tabs={[
								{
									label: "cURL",
									lang: "bash",
									code: `curl -X POST ${base}/emails \\\n  -H "Authorization: Bearer $MAILROOM_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: order-1234-receipt" \\\n  -d '{\n    "from": "${SEND.from}",\n    "to": ${SEND.to},\n    "subject": "${SEND.subject}",\n    "html": "${SEND.html}"\n  }'`,
								},
								{
									label: "Node.js",
									lang: "js",
									code: `// npm install resend\n// RESEND_BASE_URL=${base} (the SDK reads it)\nimport { Resend } from "resend";\n\nconst resend = new Resend(process.env.MAILROOM_API_KEY);\n\nconst { data, error } = await resend.emails.send({\n  from: "${SEND.from}",\n  to: ${SEND.to},\n  subject: "${SEND.subject}",\n  html: "${SEND.html}",\n  tags: [{ name: "kind", value: "receipt" }],\n});`,
								},
								{
									label: "Python",
									lang: "python",
									code: `import os, requests\n\nr = requests.post(\n    "${base}/emails",\n    headers={"Authorization": f"Bearer {os.environ['MAILROOM_API_KEY']}"},\n    json={\n        "from": "${SEND.from}",\n        "to": ${SEND.to},\n        "subject": "${SEND.subject}",\n        "html": "${SEND.html}",\n    },\n)\nprint(r.json())  # {"id": "..."}`,
								},
								{
									label: "PHP",
									lang: "php",
									code: `// composer require resend/resend-php\n$resend = Resend::client(getenv('MAILROOM_API_KEY'), '${base}');\n\n$resend->emails->send([\n  'from' => '${SEND.from}',\n  'to' => ['customer@example.com'],\n  'subject' => '${SEND.subject}',\n  'html' => '${SEND.html}',\n]);`,
								},
							]}
						/>
						<Notes>
							<li>
								Errors come back as <C>{"{ statusCode, name, message }"}</C>.
							</li>
							<li>
								Suppressed recipients, those whose domain takes no email, and
								first-time addresses whose mailbox doesn't exist (checked once with
								Emailable, when the deployment has it on) are left out and listed in{" "}
								<C>dropped_recipients</C>. An email with nobody left is recorded as
								suppressed and not sent.
							</li>
						</Notes>
					</Section>
					<Section
						title="Unsubscribe links"
						description={
							<>
								Pass <C>unsubscribe_group</C> (an id of yours, such as a customer's
								or a newsletter's) and Mailroom adds a one-click unsubscribe link
								and the <C>List-Unsubscribe</C> headers mail clients turn into their
								own button.
							</>
						}
					>
						<CodeBlock
							title="POST /emails"
							lang="json"
							code={`{\n  "from": "Acme <hola@acme.mx>",\n  "to": ["ana@example.com"],\n  "subject": "Su factura",\n  "html": "<p>…</p><p><a href=\\"{{{MAILROOM_UNSUBSCRIBE_URL}}}\\">Darse de baja</a></p>",\n  "unsubscribe_group": "customer_123"\n}`}
						/>
						<Notes>
							<li>
								Put <C>{"{{{MAILROOM_UNSUBSCRIBE_URL}}}"}</C> (or Resend's{" "}
								<C>{"{{{RESEND_UNSUBSCRIBE_URL}}}"}</C>) where the link goes.
								Without it, a line is added at the bottom of the HTML and the text.
							</li>
							<li>
								Someone who unsubscribes is left out of later emails in that group
								only, and <C>dropped_recipients</C> says{" "}
								<C>unsubscribed (customer_123)</C>. Emails in other groups, or
								without one, still reach them.
							</li>
							<li>
								Each address gets its own link, so send one email per recipient when
								it matters who left.
							</li>
							<li>
								Webhooks hear <C>email.unsubscribed</C> with{" "}
								<C>{"{ unsubscribed: { email, group } }"}</C>. Bounces and
								complaints stay on the suppression list, for every group.
							</li>
						</Notes>
					</Section>
				</TabsContent>
				<TabsContent
					value="endpoints"
					className={PANEL}
				>
					<Section
						title="Every endpoint"
						description={
							<>
								All under <C>/api</C>, with the same API key.
							</>
						}
					>
						<TableCard>
							{ENDPOINTS.map(([group, rows]) => (
								<div
									key={group}
									className="border-t border-border/70 first:border-t-0"
								>
									<h3 className="bg-muted/50 px-5 py-2 text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
										{group}
									</h3>
									<ul className="divide-y divide-border/70 border-t border-border/70">
										{rows.map(([m, p, d]) => (
											<li
												key={`${m}${p}`}
												className="grid gap-x-6 gap-y-1 px-5 py-2.5 text-sm md:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] md:items-center"
											>
												<span className="flex min-w-0 items-center gap-2.5">
													<Method m={m} />
													<code
														className="min-w-0 truncate font-mono text-xs"
														title={p}
													>
														{p}
													</code>
												</span>
												<span className="text-muted-foreground text-pretty">
													{d}
												</span>
											</li>
										))}
									</ul>
								</div>
							))}
						</TableCard>
					</Section>
				</TabsContent>
				<TabsContent
					value="smtp"
					className={PANEL}
				>
					<Section
						title="Send over SMTP"
						description="For apps that only speak SMTP (WordPress, a hotel PMS, a printer). They connect to Amazon SES directly; the two headers put each email in its brand, so its events show up here."
						actions={
							<BrandFilter
								brands={me.brands}
								value={brand ?? me.brands[0]?.id}
								all={null}
								onChange={(b) =>
									navigate({
										search: (s) => ({
											...s,
											brand: b === me.brands[0]?.id ? undefined : b,
										}),
										replace: true,
										resetScroll: false,
									})
								}
							/>
						}
					>
						<Card className="divide-y divide-border/70">
							<div className="grid gap-4 p-5 sm:grid-cols-2">
								<CopyField
									label="Host"
									value={host}
								/>
								<CopyField
									label="Port"
									value="587"
									hint={
										<p className="leading-6">
											With STARTTLS; <CopyChip value="2587" /> works too. TLS
											from the start: <CopyChip value="465" /> or{" "}
											<CopyChip value="2465" />
										</p>
									}
								/>
								<SmtpLogin
									saved={smtp}
									fresh={fresh}
									onCreated={setFresh}
									canManage={canManage}
									brand={brand}
								/>
							</div>
							<div className="flex flex-col gap-4 p-5">
								<div>
									<h3 className="text-sm font-medium">Headers</h3>
									<p className="mt-0.5 text-sm text-muted-foreground">
										Add both to every email, if the app lets you.
									</p>
								</div>
								<div className="grid gap-4 sm:grid-cols-2">
									<CopyField
										label={
											<span className="font-mono text-xs">X-SES-TENANT</span>
										}
										value={tenant}
									/>
									<CopyField
										label={
											<span className="font-mono text-xs">
												X-SES-CONFIGURATION-SET
											</span>
										}
										value={configurationSet}
									/>
								</div>
								{sending?.marketing_tenant_name && (
									<p className="text-sm text-muted-foreground text-pretty">
										From a marketing domain, use{" "}
										<CopyChip value={sending.marketing_tenant_name} /> and{" "}
										<CopyChip
											value={sending.marketing_configuration_set ?? ""}
										/>{" "}
										instead, so newsletters keep their own reputation.
									</p>
								)}
							</div>
						</Card>
						<CodeTabs
							data
							title="SMTP"
							tabs={[
								{
									label: "Node.js",
									lang: "js",
									code: `// npm install nodemailer\nimport nodemailer from "nodemailer";\n\nconst smtp = nodemailer.createTransport({\n  host: "${host}",\n  port: 587,\n  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },\n});\n\nawait smtp.sendMail({\n  from: "${SEND.from}",\n  to: "customer@example.com",\n  subject: "${SEND.subject}",\n  html: "${SEND.html}",\n  headers: {\n    "X-SES-TENANT": "${tenant}",\n    "X-SES-CONFIGURATION-SET": "${configurationSet}",\n  },\n});`,
								},
								{
									label: "Python",
									lang: "python",
									code: `import os, smtplib\nfrom email.message import EmailMessage\n\nmsg = EmailMessage()\nmsg["From"] = "${SEND.from}"\nmsg["To"] = "customer@example.com"\nmsg["Subject"] = "${SEND.subject}"\nmsg["X-SES-TENANT"] = "${tenant}"\nmsg["X-SES-CONFIGURATION-SET"] = "${configurationSet}"\nmsg.add_alternative("${SEND.html}", subtype="html")\n\nwith smtplib.SMTP("${host}", 587) as smtp:\n    smtp.starttls()\n    smtp.login(os.environ["SMTP_USER"], os.environ["SMTP_PASSWORD"])\n    smtp.send_message(msg)`,
								},
								{
									label: ".env",
									lang: "bash",
									code: `SMTP_HOST=${host}\nSMTP_PORT=587\nSMTP_USER=${smtpUser ?? ""}\nSMTP_PASSWORD=${fresh?.password ?? ""}`,
								},
							]}
						/>
						<Notes>
							<li>
								An app that can't add headers still works: the configuration set is
								each domain's default in SES (Mailroom sets it when it adds a
								domain), so events arrive anyway.
							</li>
							<li>
								The From address must be at one of this organization's verified{" "}
								<Link
									to="/domains"
									className="font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
								>
									domains
								</Link>
								.
							</li>
							<li>
								SMTP sends skip Mailroom's suppression list and address checks;
								SES's own account-wide suppression list still applies.
							</li>
						</Notes>
					</Section>
				</TabsContent>
				<TabsContent
					value="webhooks"
					className={PANEL}
				>
					<Section
						title="Verify webhooks"
						description={
							<>
								Each POST carries <C>webhook-id</C>, <C>webhook-timestamp</C> and{" "}
								<C>webhook-signature</C> (also as <C>svix-*</C>), the Standard
								Webhooks scheme Resend uses.
							</>
						}
						actions={
							<a
								href="https://www.standardwebhooks.com/"
								target="_blank"
								rel="noreferrer"
								className="inline-flex items-center gap-1 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
							>
								Standard Webhooks
								<ArrowUpRight className="size-3.5" />
							</a>
						}
					>
						<CodeTabs
							title="Verify a delivery"
							tabs={[
								{
									label: "Node.js",
									lang: "js",
									code: `// npm install standardwebhooks\nimport { Webhook } from "standardwebhooks";\n\nconst wh = new Webhook(process.env.MAILROOM_WEBHOOK_SECRET); // whsec_...\nconst event = wh.verify(rawBody, {\n  "webhook-id": req.headers["webhook-id"],\n  "webhook-timestamp": req.headers["webhook-timestamp"],\n  "webhook-signature": req.headers["webhook-signature"],\n});\n// event.type: "email.delivered", "email.bounced", …\n// event.data.email_id, event.data.to, event.data.bounce, …`,
								},
								{
									label: "Python",
									lang: "python",
									code: `# pip install standardwebhooks\nimport os\nfrom standardwebhooks.webhooks import Webhook\n\nwh = Webhook(os.environ["MAILROOM_WEBHOOK_SECRET"])  # whsec_...\nevent = wh.verify(raw_body, request.headers)\n# event["type"]: "email.delivered", "email.bounced", …`,
								},
							]}
						/>
					</Section>
				</TabsContent>
			</Tabs>
		</Page>
	);
}

/**
 * A field Mailroom can't fill (SES SMTP credentials are made in the AWS console and shown there
 * once; an API key is shown once when created): where it's made stands where the value would be.
 */
function LinkField({
	label,
	placeholder,
	action,
	href,
	to,
}: {
	label: string;
	placeholder: string;
	action: string;
	href?: string;
	to?: "/api-keys";
}) {
	const className =
		"group flex h-9 min-w-0 items-center gap-2 rounded-lg border border-dashed border-border-strong pr-2.5 pl-3 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground";
	const body = (
		<>
			<span className="min-w-0 flex-1 truncate">{placeholder}</span>
			<span className="flex shrink-0 items-center gap-0.5 text-xs font-medium text-foreground">
				{action}
				<ArrowUpRight className="size-3.5 text-faint group-hover:text-foreground" />
			</span>
		</>
	);
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="text-sm text-muted-foreground">{label}</span>
			{to ? (
				<Link
					to={to}
					className={className}
				>
					{body}
				</Link>
			) : (
				<a
					href={href}
					target="_blank"
					rel="noreferrer"
					className={className}
				>
					{body}
				</a>
			)}
		</div>
	);
}

/**
 * The SMTP username and password: made by Mailroom in one click (an IAM user that can only send
 * from this organization's domains). The password shows only right after it's made.
 */
function SmtpLogin({
	saved,
	fresh,
	onCreated,
	canManage,
	brand,
}: {
	saved: { username: string; created_at: string } | null;
	fresh: { username: string; password: string } | null;
	onCreated: (c: { username: string; password: string } | null) => void;
	canManage: boolean;
	brand: string | undefined;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [replacing, setReplacing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const create = async () => {
		setBusy(true);
		try {
			const c = await createSmtpCredentialsFn({ data: { brand } });
			onCreated(c);
			toast.success("SMTP credentials created. Copy the password now.");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	const username = fresh?.username ?? saved?.username;
	if (!username)
		return (
			<div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-strong p-4 sm:col-span-2 sm:flex-row sm:items-center">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">Username and password</p>
					<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
						Mailroom makes them in AWS for this organization. They can only send from
						its domains.
					</p>
				</div>
				{canManage ? (
					<Button
						disabled={busy}
						onClick={create}
					>
						{busy ? <Spinner /> : <KeyRound />}
						Create SMTP credentials
					</Button>
				) : (
					<p className="text-sm text-muted-foreground">
						An owner or admin can create them.
					</p>
				)}
			</div>
		);
	return (
		<>
			<CopyField
				label="Username"
				value={username}
			/>
			{fresh ? (
				<CopyField
					label="Password"
					value={fresh.password}
					hint={
						<span className="font-medium text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]">
							Copy it now: it's shown only this once.
						</span>
					}
				/>
			) : (
				<div className="flex min-w-0 flex-col gap-1.5">
					<span className="text-sm text-muted-foreground">Password</span>
					<div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-dashed border-border-strong pr-1 pl-3 text-[13px] text-muted-foreground">
						<span
							className="min-w-0 flex-1 truncate"
							title={
								saved ? `Created ${formatRelative(saved.created_at)}` : undefined
							}
						>
							Shown once, when created
						</span>
						{canManage && (
							<Button
								variant="ghost"
								size="xs"
								onClick={() => setReplacing(true)}
							>
								<RotateCw />
								New
							</Button>
						)}
					</div>
				</div>
			)}
			{canManage && (
				<div className="-mt-1 flex justify-end sm:col-span-2">
					<button
						type="button"
						onClick={() => setDeleting(true)}
						className="text-xs text-muted-foreground transition-colors hover:text-destructive"
					>
						Delete SMTP credentials
					</button>
				</div>
			)}
			<Confirm
				open={replacing}
				onOpenChange={setReplacing}
				title="Make a new password?"
				description="The current password stops working at once. Apps that use it need the new one."
				action="Make a new one"
				cancel="Keep it"
				onConfirm={create}
			/>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete the SMTP credentials?"
				description="Apps that send with them stop being able to. You can create new ones any time."
				action="Delete credentials"
				onConfirm={async () => {
					try {
						await deleteSmtpCredentialsFn({ data: { brand } });
						onCreated(null);
						toast.success("SMTP credentials deleted");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
		</>
	);
}
