import { createFileRoute, Link } from "@tanstack/react-router";
import { Globe, Mail, MailX, ScrollText, Webhook } from "lucide-react";
import { ApiDrawer } from "@/components/api-drawer";
import { CodeBlock } from "@/components/code-block";
import { Page, Section } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { StatusCode } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { getLogFn } from "@/functions/logs";
import { formatDateTime, formatRelative } from "@/lib/format";
import { ago, listedRow, Sketch, useOpened, usePage } from "@/lib/sketch";
import { userAgentLabel } from "@/lib/user-agent";

export const Route = createFileRoute("/_app/logs/$id")({
	loader: ({ params }) => getLogFn({ data: { id: params.id } }),
	head: ({ loaderData }) => ({
		meta: [
			{
				title: `${loaderData ? `${loaderData.method} ${loaderData.path}` : "Log"} · Mailroom`,
			},
		],
	}),
	component: LogPage,
	pendingComponent: LogSketch,
});

type Data = Awaited<ReturnType<typeof getLogFn>>;

type Listed = {
	id: string;
	method: string;
	path: string;
	status: number;
	user_agent: string | null;
	created_at: string;
};

/** Drawn from the row the logs list showed, when it did: its method, path and status decide the rest. */
function LogSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Data>("log-page", params.id);
	const row = listedRow<Listed>("logs", params.id);
	if (opened)
		return (
			<Sketch data={opened}>
				<LogPage />
			</Sketch>
		);
	const post = (row?.method ?? "POST") !== "GET";
	const email = row ? /^\/emails(\/batch)?$/.test(row.path) && row.status < 400 : true;
	return (
		<Sketch
			data={{
				id: "req_0000000000000000",
				method: "POST",
				path: "/emails",
				query: null,
				status: 200,
				created_at: ago(60),
				duration_ms: 120,
				user_agent: "node",
				key: { name: "Production", permission: "full" },
				response_body: '{\n  "id": "0000000000"\n}',
				...row,
				email_id: email ? "sketch" : null,
				email: email ? { id: "sketch", subject: "Your booking is confirmed" } : null,
				request_body: post ? '{\n  "from": "",\n  "to": "",\n  "subject": ""\n}' : null,
			}}
		>
			<LogPage />
		</Sketch>
	);
}

/**
 * The record a call's path names (/emails/{id}/cancel, /domains/{id}, /suppressions/{email}…),
 * to open it from here.
 */
function referenced(path: string) {
	const m = /^\/(emails|domains|webhooks|suppressions)\/([^/]+)/.exec(path);
	if (!m || m[2] === "batch") return null;
	return {
		kind: m[1] as "emails" | "domains" | "webhooks" | "suppressions",
		id: decodeURIComponent(m[2] as string),
	};
}

const REFERENCE = {
	emails: { label: "Email", icon: Mail, to: "/emails/$id" },
	domains: { label: "Domain", icon: Globe, to: "/domains/$id" },
	webhooks: { label: "Webhook", icon: Webhook, to: "/webhooks/$id" },
	suppressions: { label: "Suppression", icon: MailX, to: "/suppressions/$id" },
} as const;

function LogPage() {
	const log = usePage(Route).data;
	useOpened("log-page", log);
	const tone = log.status < 400 ? "green" : log.status < 500 ? "amber" : "red";
	const ref = log.email_id ? null : referenced(log.path);
	const kind = ref ? REFERENCE[ref.kind] : null;
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/logs"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Logs
					</Link>
				</nav>
				<RecordHeader
					icon={ScrollText}
					tone={tone}
					kind="Log"
					title={
						<>
							{log.method} <span className="font-mono">{log.path}</span>
						</>
					}
					actions={
						log.method === "GET" ? (
							<ApiDrawer
								title="This call"
								calls={[
									{
										title: "Make it again",
										method: "GET",
										path: `${log.path}${log.query ? `?${log.query}` : ""}`,
									},
								]}
							/>
						) : undefined
					}
				/>
			</div>

			<Facts>
				<Fact label="Endpoint">
					<span className="font-mono text-[13px]">
						{log.path}
						{log.query && <span className="text-muted-foreground">?{log.query}</span>}
					</span>
				</Fact>
				<Fact label="Date">
					<span
						className="tabular-nums"
						title={formatDateTime(log.created_at)}
					>
						{formatRelative(log.created_at)}
					</span>
				</Fact>
				<Fact label="Status">
					<StatusCode code={log.status} />
				</Fact>
				<Fact label="Duration">
					<span className="tabular-nums">
						{log.duration_ms != null ? `${log.duration_ms} ms` : "—"}
					</span>
				</Fact>
				<Fact label="Method">{log.method}</Fact>
				<Fact label="User agent">
					<span title={log.user_agent ?? undefined}>
						{userAgentLabel(log.user_agent)}
					</span>
				</Fact>
				<Fact label="API key">
					{log.key ? (
						<span className="flex min-w-0 items-center gap-1.5">
							<Link
								to="/api-keys"
								className="truncate transition-colors hover:text-muted-foreground"
							>
								{log.key.name}
							</Link>
							<Badge variant={log.key.permission === "full" ? "brand" : "secondary"}>
								{log.key.permission === "full" ? "Full access" : "Sending"}
							</Badge>
						</span>
					) : (
						<span className="text-muted-foreground">Deleted key</span>
					)}
				</Fact>
				<Fact label="Id">
					<IdChip value={log.id} />
				</Fact>
				{ref && kind && (
					<Fact
						label={kind.label}
						className="col-span-2"
					>
						<Link
							to={kind.to}
							params={{ id: ref.id }}
							className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
						>
							<kind.icon className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="truncate">{ref.id}</span>
						</Link>
					</Fact>
				)}
				{log.email_id && (
					<Fact
						label="Email"
						className="col-span-2"
					>
						{log.email ? (
							<Link
								to="/emails/$id"
								params={{ id: log.email.id }}
								className="flex min-w-0 items-center gap-1.5 underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
							>
								<Mail className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">
									{log.email.subject || "(no subject)"}
								</span>
							</Link>
						) : (
							<span className="text-muted-foreground">No longer kept</span>
						)}
					</Fact>
				)}
			</Facts>

			<Section title="Response body">
				<CodeBlock
					data
					code={log.response_body ?? "(empty)"}
					lang={log.response_body?.startsWith("{") ? "json" : "text"}
				/>
			</Section>
			{log.method !== "GET" && (
				<Section title="Request body">
					<CodeBlock
						data
						code={log.request_body ?? "(empty)"}
						lang={log.request_body?.match(/^[[{]/) ? "json" : "text"}
					/>
				</Section>
			)}
		</Page>
	);
}
