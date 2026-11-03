import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Check, RotateCw, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { AwsCostsSection, CostByOrganization } from "@/components/aws-costs";
import { CodeBlock } from "@/components/code-block";
import { RecordGroup } from "@/components/dns-records";
import { ErrorTrackingCard } from "@/components/error-tracking-card";
import { OrgAvatar } from "@/components/org-avatar";
import { CopyText, Page, PageHeader, Section, TableCard } from "@/components/page";
import { PostmasterCard } from "@/components/postmaster-card";
import { PagePending } from "@/components/route-states";
import { SendingLimitsCard } from "@/components/sending-limits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { accountStatusFn, setUpAccountFn } from "@/functions/admin";
import { setUpReceivingFn } from "@/functions/received";
import { orgDomain } from "@/lib/dmarc";
import { errorMessage } from "@/lib/errors";
import { formatNumber, formatPercent, formatRelative } from "@/lib/format";
import { IAM_POLICY } from "@/lib/iam-policy";
import { loadMe } from "@/lib/me";
import { listedRow, Sketch, useOpened, usePage } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/admin")({
	beforeLoad: async () => {
		if (!(await loadMe()).isAdmin) throw redirect({ to: "/" });
	},
	loader: () => accountStatusFn(),
	head: () => ({ meta: [{ title: "AWS account · Mailroom" }] }),
	component: Admin,
	pendingComponent: AdminSketch,
});

type Data = (typeof Route)["types"]["loaderData"];

/** What it showed last time; the first time, the generic skeleton. */
function AdminSketch() {
	const opened = listedRow<Data>("admin-page", "account");
	if (!opened) return <PagePending />;
	return (
		<Sketch data={opened}>
			<Admin />
		</Sketch>
	);
}

function Step({
	n,
	done,
	failed,
	title,
	children,
}: {
	n: number;
	done: boolean;
	failed?: boolean;
	title: ReactNode;
	children?: ReactNode;
}) {
	return (
		<li className="flex items-start gap-3 border-b border-border/70 px-5 py-3 last:border-0">
			<span
				className={cn(
					"mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums",
					failed
						? "bg-destructive text-white"
						: done
							? "bg-success text-white"
							: "text-muted-foreground shadow-[inset_0_0_0_1px_var(--border-strong)]",
				)}
			>
				{failed ? (
					<X
						className="size-3"
						strokeWidth={3}
					/>
				) : done ? (
					<Check
						className="size-3"
						strokeWidth={3}
					/>
				) : (
					n
				)}
			</span>
			<div className="min-w-0 flex-1">
				<p className={cn("font-medium", !done && !failed && "text-muted-foreground")}>
					{title}
				</p>
				{children && <div className="mt-0.5 text-xs text-muted-foreground">{children}</div>}
			</div>
		</li>
	);
}

function Admin() {
	const data = usePage(Route).data;
	const { status, byOrg, all, costs, split } = data;
	// What setup returned, shown at once (the page's own data catches up on its next load).
	const [receivingNow, setReceivingNow] = useState<Data["receiving"] | null>(null);
	const receiving = receivingNow ?? data.receiving;
	useOpened(
		"admin-page",
		useMemo(() => ({ ...data, id: "account" }), [data]),
	);
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [receivingBusy, setReceivingBusy] = useState(false);
	const ses = status.ses;
	const quota = ses?.SendQuota;
	const used = quota?.Max24HourSend ? (quota.SentLast24Hours ?? 0) / quota.Max24HourSend : 0;
	const healthy = ses?.EnforcementStatus === "HEALTHY";
	return (
		<Page className="max-w-5xl">
			<PageHeader
				title="AWS account"
				description="The one SES account every organization sends through. Only this deployment's admins see this page."
			/>
			{ses && !ses.ProductionAccessEnabled && (
				<Alert variant="warning">
					<AlertTitle>Still in the SES sandbox</AlertTitle>
					<AlertDescription>
						It only sends to verified addresses. Request production access in the SES
						console.
					</AlertDescription>
				</Alert>
			)}
			{ses && (
				<Card className="grid grid-cols-1 divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
					<div className="px-5 py-4">
						<p className="text-sm text-muted-foreground">Sent in the last 24 hours</p>
						<p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
							{formatNumber(quota?.SentLast24Hours ?? 0)}
							<span className="text-sm font-normal text-muted-foreground">
								{" "}
								of {formatNumber(quota?.Max24HourSend ?? 0)}
							</span>
						</p>
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="mt-1.5 cursor-default py-1.5">
									<div className="h-1 overflow-hidden rounded-full bg-muted">
										<div
											className={cn(
												"h-full rounded-full",
												used > 0.8 ? "bg-warning" : "bg-brand",
											)}
											style={{
												width: `${Math.min(100, Math.max(used * 100, used > 0 ? 1 : 0))}%`,
											}}
										/>
									</div>
								</div>
							</TooltipTrigger>
							<TooltipContent className="text-xs">
								{formatPercent(used, 1)} of today's quota ·{" "}
								{formatNumber(
									Math.max(
										0,
										(quota?.Max24HourSend ?? 0) - (quota?.SentLast24Hours ?? 0),
									),
								)}{" "}
								left
							</TooltipContent>
						</Tooltip>
					</div>
					<div className="px-5 py-4">
						<p className="text-sm text-muted-foreground">Maximum send rate</p>
						<p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
							{formatNumber(quota?.MaxSendRate ?? 0)}
							<span className="text-sm font-normal text-muted-foreground">
								{" "}
								per second
							</span>
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							Set MAX_SEND_RATE to this value.
						</p>
					</div>
					<div className="px-5 py-4">
						<p className="text-sm text-muted-foreground">Account status</p>
						<p
							className={cn(
								"mt-1 text-2xl font-semibold tracking-tight",
								!healthy && "text-destructive",
							)}
						>
							{healthy ? "Healthy" : (ses.EnforcementStatus ?? "—")}
						</p>
						<p className="mt-2 text-xs text-muted-foreground">
							{ses.SendingEnabled ? "Sending enabled" : "Sending disabled"} ·{" "}
							{ses.ProductionAccessEnabled ? "production" : "sandbox"}
						</p>
					</div>
				</Card>
			)}
			<Card>
				<CardHeader>
					<CardTitle>Setup</CardTitle>
					<CardDescription>
						Region {status.region}. Each step can run again safely.
					</CardDescription>
				</CardHeader>
				<ol className="border-t border-border/70">
					<Step
						n={1}
						done={status.configured}
						title="AWS credentials"
					>
						{status.configured ? (
							"Set as Worker secrets."
						) : (
							<>
								Missing:{" "}
								<code className="font-mono">
									wrangler secret put AWS_ACCESS_KEY_ID
								</code>{" "}
								and <code className="font-mono">AWS_SECRET_ACCESS_KEY</code>
							</>
						)}
					</Step>
					<Step
						n={2}
						done={!!ses}
						failed={!!status.error}
						title={`SES answers${status.accountId ? ` (account ${status.accountId})` : ""}`}
					>
						{status.error && (
							<span className="text-destructive [overflow-wrap:anywhere]">
								{status.error}
							</span>
						)}
					</Step>
					<Step
						n={3}
						done={!!status.topicArn}
						title="SNS topic for SES's events"
					>
						{status.topicArn && <CopyText value={status.topicArn} />}
					</Step>
					<Step
						n={4}
						done={!!status.subscriptionConfirmedAt}
						title="SNS subscribed"
					>
						<span className="font-mono">{status.endpoint}</span>
						{status.subscriptionConfirmedAt &&
							` · confirmed ${formatRelative(status.subscriptionConfirmedAt)}`}
					</Step>
					<Step
						n={5}
						done={!!status.lastEventAt}
						title="Events arriving"
					>
						{status.lastEventAt
							? `Last one ${formatRelative(status.lastEventAt)}`
							: "None yet."}
					</Step>
				</ol>
				<CardFooter>
					<span className="mr-auto text-xs">
						Creates the SNS topic and subscribes this deployment.
					</span>
					<Button
						size="sm"
						variant={status.topicArn ? "outline" : "default"}
						disabled={busy || !status.configured}
						onClick={async () => {
							setBusy(true);
							try {
								await setUpAccountFn({ data: {} });
								toast.success(
									"Topic created and subscribed. SNS confirms in a few seconds.",
								);
								setTimeout(() => router.invalidate(), 4000);
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? <Spinner /> : <RotateCw />}
						{status.topicArn ? "Run setup again" : "Set up events"}
					</Button>
				</CardFooter>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Receiving</CardTitle>
					<CardDescription>
						Email to domains with receiving on (and to each brand's Mailroom address)
						goes to SES, which drops it in S3; Mailroom moves it to R2 at once and
						deletes it from S3.
					</CardDescription>
				</CardHeader>
				<ol className="border-t border-border/70">
					<Step
						n={1}
						done={!!status.subscriptionConfirmedAt}
						title="Events set up"
					>
						Receiving uses the same SNS topic and subscription.
					</Step>
					<Step
						n={2}
						done={receiving.storage}
						title="R2 bucket for messages"
					>
						{receiving.storage
							? "The INBOUND binding is there."
							: "Add the INBOUND R2 binding in wrangler.jsonc and deploy."}
					</Step>
					<Step
						n={3}
						done={!!receiving.bucket}
						title="S3 drop box"
					>
						{receiving.bucket ? (
							<CopyText value={receiving.bucket} />
						) : (
							"A bucket SES may write to, which empties itself after a day."
						)}
					</Step>
					<Step
						n={4}
						done={!!receiving.ruleSet}
						title="Receipt rules"
					>
						{receiving.ruleSet
							? `In the account's active rule set, ${receiving.ruleSet}.`
							: "Mailroom joins the active rule set, or makes one if there's none."}
					</Step>
					{receiving.domain && (
						<Step
							n={5}
							done={receiving.verified === true}
							title={`Mailroom addresses at ${receiving.domain}`}
						>
							{receiving.records.length > 1
								? receiving.verified
									? `Verified. Each brand gets <slug>@${receiving.domain}.`
									: "Add the records below where its DNS is. Mailroom checks them each time setup runs."
								: "Set up receiving to get its DNS records."}
						</Step>
					)}
				</ol>
				<CardFooter>
					<span className="mr-auto text-xs">
						Adds receive permissions to the IAM user first (scripts/update-iam.sh).
					</span>
					<Button
						size="sm"
						variant={receiving.setUp ? "outline" : "default"}
						disabled={receivingBusy || !status.subscriptionConfirmedAt}
						onClick={async () => {
							setReceivingBusy(true);
							try {
								setReceivingNow(await setUpReceivingFn({ data: {} }));
								toast.success("Receiving set up");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setReceivingBusy(false);
							}
						}}
					>
						{receivingBusy ? <Spinner /> : <RotateCw />}
						{receiving.setUp ? "Run setup again" : "Set up receiving"}
					</Button>
				</CardFooter>
			</Card>
			{receiving.domain && receiving.records.length > 1 && (
				<RecordGroup
					title={`Mailroom addresses at ${receiving.domain}`}
					tag="MX · DKIM"
					description="Lets SES take email for every brand's Mailroom address and sign as the domain. Add them where its DNS is; it's a subdomain, so nothing else at the parent domain changes."
					records={receiving.records}
					host={null}
					root={orgDomain(receiving.domain)}
				/>
			)}
			<AwsCostsSection costs={costs} />
			{split && <CostByOrganization split={split} />}
			<SendingLimitsCard />
			<PostmasterCard />
			<ErrorTrackingCard />
			<Section
				title="Organizations"
				description={`The last 7 days each. The whole account over 30 days: ${formatNumber(all.totals.sent)} sent, ${formatPercent(all.health.bounceRate)} bounced, ${formatPercent(all.health.complaintRate, 3)} complaints.`}
			>
				<TableCard>
					{byOrg.length === 0 ? (
						<CardContent className="py-8 text-center text-muted-foreground">
							Nothing sent yet.
						</CardContent>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Organization</TableHead>
									<TableHead className="text-right">Sent</TableHead>
									<TableHead className="hidden text-right sm:table-cell">
										Delivered
									</TableHead>
									<TableHead className="text-right">Bounces</TableHead>
									<TableHead className="text-right">Complaints</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{byOrg.map((o) => (
									<TableRow key={o.organization_id}>
										<TableCell className="w-full max-w-0 font-medium">
											<span className="flex min-w-0 items-center gap-2.5">
												<OrgAvatar name={o.name ?? "?"} />
												<span className="truncate">{o.name}</span>
											</span>
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{formatNumber(o.sent)}
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{formatNumber(o.delivered)}
										</TableCell>
										<TableCell
											className={cn(
												"text-right tabular-nums",
												o.bounce === "danger" && "text-destructive",
												o.bounce === "warning" && "text-warning",
											)}
										>
											{formatPercent(o.bounceRate)}
										</TableCell>
										<TableCell
											className={cn(
												"text-right tabular-nums",
												o.complaint === "danger" && "text-destructive",
												o.complaint === "warning" && "text-warning",
											)}
										>
											{formatPercent(o.complaintRate, 3)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</TableCard>
			</Section>
			<Section
				title="IAM policy"
				description="What the mailroom IAM user needs, and nothing more."
			>
				<CodeBlock
					data
					code={IAM_POLICY}
					lang="json"
					className="max-h-96 overflow-auto"
				/>
			</Section>
		</Page>
	);
}
