import { createFileRoute, Link, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ArrowUpRight,
	BadgeCheck,
	Bot,
	CircleAlert,
	CircleCheck,
	Copy,
	FileCode2,
	Globe,
	type LucideIcon,
	MoreHorizontal,
	Pause,
	Play,
	Plus,
	RefreshCw,
	SearchCheck,
	Trash2,
	Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { BrandLogo } from "@/components/brand-logo";
import { PurposeBadge } from "@/components/brand-status";
import { Confirm } from "@/components/confirm";
import { CopyValue, useCopy } from "@/components/copy";
import { DmarcReports } from "@/components/dmarc-reports";
import { RecordGroup } from "@/components/dns-records";
import { DomainHealth } from "@/components/domain-health";
import { DomainReceiving } from "@/components/domain-receiving";
import { DomainTracking } from "@/components/domain-tracking";
import { Uses } from "@/components/domain-uses";
import { Page } from "@/components/page";
import { DnsHostMark, Flag } from "@/components/provider-marks";
import {
	Fact,
	Facts,
	IdChip,
	RecordHeader,
	type Step,
	Timeline,
	toneOf,
} from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
	bimiFn,
	dmarcFn,
	dnsHelpFn,
	listDomainsFn,
	removeDomainFn,
	trackingFn,
	updateDomainFn,
	verifyDomainFn,
} from "@/functions/settings";
import type { Bimi } from "@/lib/bimi";
import { type Dmarc, orgDomain } from "@/lib/dmarc";
import type { DnsHelp } from "@/lib/dns-hosts";
import { errorMessage } from "@/lib/errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import { forgetMe, useMe } from "@/lib/me";
import { patch, useOptimisticState } from "@/lib/optimistic";
import { allows } from "@/lib/permissions";
import { regionInfo } from "@/lib/regions";
import { ago, listedRow, Ph, Sketch, useOpened, usePage, useSketching } from "@/lib/sketch";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/domains/$id")({
	// Back from the DNS host's one-click setup (Domain Connect).
	validateSearch: (s: Record<string, unknown>): { connected?: 1 } =>
		s.connected ? { connected: 1 } : {},
	loader: async ({ params }) => {
		const domain = (await listDomainsFn()).find((d) => d.id === params.id);
		if (!domain) throw notFound();
		const org = orgDomain(domain.name);
		const [dmarc, orgDmarc, bimi, tracking] = await Promise.all([
			dmarcFn({ data: { name: domain.name } }).catch(() => null),
			org === domain.name ? null : dmarcFn({ data: { name: org } }).catch(() => null),
			bimiFn({ data: { name: domain.name } }).catch(() => null),
			trackingFn().catch(() => null),
		]);
		return { ...domain, dmarc, orgDmarc, bimi, tracking };
	},
	head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? "Domain"} · Mailroom` }] }),
	component: DomainPage,
	pendingComponent: DomainSketch,
});

/**
 * The domains list already had the domain (its records and their status); what's looked up
 * after (DMARC, BIMI) draws as found, the usual case.
 */
function DomainSketch() {
	const { params } = usePage(Route);
	const opened = listedRow<Partial<Domain>>("domain-page", params.id);
	const listed = listedRow<Awaited<ReturnType<typeof listDomainsFn>>[number]>(
		"domains",
		params.id,
	);
	const row = opened || listed ? { ...opened, ...listed } : undefined;
	const name = row?.name ?? "mail.example.com";
	const records = row?.records ?? standInRecords(name);
	return (
		<Sketch
			data={{
				id: params.id ?? "",
				organization_id: "",
				name,
				status: "verified",
				purpose: "transactional",
				region: "us-east-1",
				paused_at: null,
				paused_reason: null,
				open_tracking: true,
				click_tracking: true,
				tracking_host: null,
				tracking_status: null,
				sending: row?.sending ?? true,
				receiving: row?.receiving ?? false,
				receiving_status: row?.receiving_status ?? null,
				receiving_host: row?.receiving_host ?? null,
				created_at: ago(60 * 24 * 30),
				dmarc: {
					found: true,
					at: orgDomain(name),
					inherited: false,
					record: "v=DMARC1; p=none;",
					policy: "none",
					duplicate: false,
				},
				orgDmarc: null,
				bimi: null,
				tracking: null,
				...row,
				records,
			}}
		>
			<DomainPage />
		</Sketch>
	);
}

/** A domain's usual records, for a skeleton opened without its list (a link, a reload). */
function standInRecords(name: string): DnsRecord[] {
	const mailFrom = `send.${name}`;
	return [
		...[
			"a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6",
			"q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2",
			"g3h4i5j6k7l8m9n0o1p2q3r4s5t6u7v8",
		].map((t) => ({
			record: "DKIM" as const,
			type: "CNAME" as const,
			name: `${t}._domainkey.${name}`,
			value: `${t}.dkim.amazonses.com`,
			status: "SUCCESS",
		})),
		{
			record: "MX",
			type: "MX",
			name: mailFrom,
			value: "feedback-smtp.us-east-1.amazonses.com",
			priority: 10,
			status: "SUCCESS",
		},
		{
			record: "SPF",
			type: "TXT",
			name: mailFrom,
			value: '"v=spf1 include:amazonses.com ~all"',
			status: "SUCCESS",
		},
		{
			record: "DMARC",
			type: "TXT",
			name: `_dmarc.${name}`,
			value: '"v=DMARC1; p=none;"',
			optional: true,
		},
	];
}

type Domain = Awaited<ReturnType<typeof listDomainsFn>>[number] & {
	dmarc: Dmarc | null;
	orgDmarc: Dmarc | null;
	bimi: Bimi | null;
};

/**
 * The domain's DNS host and one-click link, looked up after the page shows (DNS over HTTPS and
 * the host's Domain Connect settings can take a moment). Kept per domain for the session, and
 * looked up again when its records change.
 */
const helpCache = new Map<string, DnsHelp>();
function useDnsHelp(id: string, key: string) {
	const cacheKey = `${id}:${key}`;
	const [help, setHelp] = useState<DnsHelp | null>(() => helpCache.get(cacheKey) ?? null);
	const sketching = useSketching();
	useEffect(() => {
		if (sketching) return;
		let live = true;
		const hit = helpCache.get(cacheKey);
		if (hit) setHelp(hit);
		dnsHelpFn({ data: { id } })
			.then((h) => {
				helpCache.set(cacheKey, h);
				if (live) setHelp(h);
			})
			.catch(() => null);
		return () => {
			live = false;
		};
	}, [id, cacheKey, sketching]);
	return help;
}

type DnsRecord = Domain["records"][number];

/** The records in the groups a person sets them up in, each with why it's there. */
function groups(d: Domain) {
	return [
		{
			key: "dkim",
			title: "Domain verification",
			tag: "DKIM",
			description: d.records.some((r) => r.record === "DKIM" && r.note)
				? `Proves emails from ${d.name} are really yours: SES signs each one with these keys. The organization is moving to another SES account: add the new keys too (keep the others), and it switches once they're verified there.`
				: `Proves emails from ${d.name} are really yours: SES signs each one with these keys.`,
			records: d.records.filter((r) => r.record === "DKIM"),
		},
		{
			key: "sending",
			title: "Bounces and SPF",
			tag: "MAIL FROM",
			description: `Bounces come back to SES through ${d.mail_from ?? "this subdomain"}, and SPF says SES may send for it.`,
			records: d.records.filter((r) => r.record === "MX" || r.record === "SPF"),
		},
		{
			key: "dmarc",
			title: "DMARC",
			tag: "Recommended",
			description:
				"Tells mailbox providers what to do with mail that fails the checks. Gmail and Yahoo require it for bulk senders.",
			records: d.records.filter((r) => r.record === "DMARC"),
		},
		{
			key: "tracking",
			title: "Tracking domain",
			tag: "CNAME",
			description: `Tracked links and the open image use ${d.tracking_host ?? "this host"}, on your own domain.`,
			records: d.records.filter((r) => r.record === "Tracking"),
		},
		{
			key: "receiving",
			title: "Receiving",
			tag: "MX",
			description: `Email to ${d.receiving_host ?? d.name} goes to SES, which hands it to Mailroom.`,
			records: d.records.filter((r) => r.record === "Receiving"),
		},
		{
			key: "bimi",
			title: "Brand logo",
			tag: "BIMI",
			description: "Points inboxes to the logo below.",
			records: d.records.filter((r) => r.record === "BIMI"),
		},
		{
			key: "gmail",
			title: "Gmail Postmaster Tools",
			tag: "TXT",
			description:
				"Lets Google show Mailroom Gmail's spam rate for this domain. Mailroom checks for it every 6 hours.",
			records: d.records.filter((r) => r.record === "Gmail"),
		},
	].filter((g) => g.records.length > 0);
}

/** The records as lines of a BIND zone file. */
const zone = (d: Domain) =>
	d.records
		.map((r) =>
			[
				`${r.name}.`,
				"300",
				"IN",
				r.type,
				r.priority ?? "",
				r.type === "TXT" ? r.value : `${r.value}.`,
			]
				.filter((x) => x !== "")
				.join("\t"),
		)
		.join("\n");

/** Instructions an AI assistant (or a colleague) can follow at the DNS provider. */
const prompt = (d: Domain) =>
	`Add these DNS records for ${d.name} at my DNS provider, so Amazon SES can send email from it. Keep any existing records. If the provider proxies records (like Cloudflare), set these to "DNS only". Use automatic TTL.\n\n${d.records
		.map(
			(r) =>
				`- ${r.type} ${r.name}${r.priority !== undefined ? ` priority ${r.priority}` : ""} → ${r.value}${r.optional ? " (recommended)" : ""}`,
		)
		.join("\n")}`;

function steps(d: Domain): Step[] {
	const dkim = d.records.filter((r) => r.record === "DKIM");
	const found = dkim.length > 0 && dkim.every((r) => r.status === "SUCCESS");
	const verified = d.status === "verified";
	return [
		{
			key: "added",
			label: "Domain added",
			icon: Plus,
			tone: "gray",
			at: d.created_at,
			hint: "Mailroom created its identity in SES and the records below.",
		},
		{
			key: "dns",
			label: "DNS records found",
			icon: SearchCheck,
			tone: found ? "green" : "gray",
			at: found ? d.checked_at : null,
			waiting: !found,
			hint: found
				? "SES found the DKIM records."
				: "Waiting for SES to find the records at your DNS provider.",
		},
		{
			key: "verified",
			label: verified ? "Verified" : d.status === "failed" ? "Failed" : "Verified",
			icon: verified ? BadgeCheck : d.status === "failed" ? CircleAlert : BadgeCheck,
			tone: verified ? "green" : d.status === "failed" ? "red" : "gray",
			at: verified || d.status === "failed" ? d.checked_at : null,
			waiting: !verified && d.status !== "failed",
			hint: verified
				? d.sending
					? "Ready to send."
					: "Ready to receive."
				: d.status === "failed"
					? "SES gave up looking for the records. Check them, then check DNS again."
					: d.sending
						? "Sending opens once SES verifies the domain."
						: "Receiving opens once SES verifies the domain.",
		},
	];
}

function DomainPage() {
	// Pausing and the purpose show at once; a failed save puts them back.
	const { data: saved, search } = usePage(Route);
	const sketching = useSketching();
	useOpened("domain-page", saved);
	const router = useRouter();
	const [d, save] = useOptimisticState(saved, patch<typeof saved>, async () => {
		forgetMe();
		await router.invalidate();
	});
	const me = useMe();
	const canManage = allows(me.active?.access, "domains:manage");
	const brand = me.brands.find((b) => b.id === d.organization_id);
	const [pausing, setPausing] = useState(false);
	const pause = (paused: boolean) =>
		save(
			paused
				? { paused_at: new Date().toISOString(), paused_reason: null }
				: { paused_at: null, paused_reason: null },
			() => updateDomainFn({ data: { id: d.id, paused } }),
		);
	const setPaused = async (paused: boolean) => {
		if (!(await pause(paused))) return;
		toast.success(paused ? `${d.name} is paused` : `${d.name} is sending again`, {
			action: { label: "Undo", onClick: () => void pause(!paused) },
		});
	};
	const setPurpose = async (purpose: "transactional" | "marketing") => {
		const ok = await save({ purpose }, () => updateDomainFn({ data: { id: d.id, purpose } }));
		if (ok)
			toast.success(
				purpose === "marketing"
					? `${d.name} now sends on the brand's marketing reputation`
					: `${d.name} now sends on the brand's transactional reputation`,
			);
	};
	const [checking, setChecking] = useState(false);
	const [removing, setRemoving] = useState(false);
	const verified = d.status === "verified";
	const required = d.records.filter((r) => !r.optional);
	const done = required.filter((r) => r.status === "SUCCESS").length;
	const help = useDnsHelp(
		d.id,
		`${d.records.map((r) => r.status ?? "").join()}|${d.dmarc?.found}|${d.bimi?.found}`,
	);
	const region = regionInfo(d.region);
	async function check(quiet = false) {
		setChecking(true);
		try {
			const r = await verifyDomainFn({ data: { id: d.id } });
			if (r.status === "verified") toast.success(`${d.name} is verified`);
			else if (!quiet) toast.info("Not verified yet. DNS can take a few minutes.");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setChecking(false);
		}
	}
	// Back from the DNS host: check at once (SES often sees the records within a minute).
	const navigate = useNavigate();
	const returned = useRef(false);
	useEffect(() => {
		if (sketching || !search.connected || returned.current) return;
		returned.current = true;
		toast.success(
			`Records added at ${help?.host?.name ?? "your DNS host"}. Checking them now…`,
		);
		navigate({ to: ".", search: {}, replace: true });
		check(true);
	});
	return (
		<Page className="gap-8">
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/domains"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Domains
					</Link>
				</nav>
				<RecordHeader
					icon={Globe}
					tone={toneOf(d.status)}
					kind="Domain"
					title={d.name}
					actions={
						<>
							<Button
								variant={verified ? "outline" : "default"}
								className="hidden sm:inline-flex"
								disabled={checking}
								onClick={() => check()}
							>
								{checking ? <Spinner /> : <RefreshCw />}
								Check DNS
							</Button>
							<ApiDrawer
								title="This domain in the API"
								calls={[
									{
										title: "Retrieve it",
										method: "GET",
										path: `/domains/${d.id}`,
									},
									{
										title: "Check its DNS now",
										method: "POST",
										path: `/domains/${d.id}/verify`,
									},
									{
										title: "Turn tracking on or off",
										method: "PATCH",
										path: `/domains/${d.id}`,
										body: {
											open_tracking: d.open_tracking,
											click_tracking: d.click_tracking,
										},
									},
									...(canManage
										? [
												{
													title: "Remove it",
													method: "DELETE" as const,
													path: `/domains/${d.id}`,
												},
											]
										: []),
								]}
							/>
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
										className="sm:hidden"
										onSelect={() => check()}
									>
										<RefreshCw />
										Check DNS
									</DropdownMenuItem>
									<CopyItem
										icon={Copy}
										label="Copy domain id"
										value={d.id}
									/>
									{canManage &&
										d.sending &&
										(d.paused_at ? (
											<DropdownMenuItem onSelect={() => setPaused(false)}>
												<Play />
												Resume sending
											</DropdownMenuItem>
										) : (
											<DropdownMenuItem onSelect={() => setPausing(true)}>
												<Pause />
												Pause sending
											</DropdownMenuItem>
										))}
									{canManage && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												variant="destructive"
												onSelect={() => setRemoving(true)}
											>
												<Trash2 />
												Remove domain
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</>
					}
				/>
			</div>
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title={`Remove ${d.name}?`}
				description={
					d.ses_owned
						? "It's deleted from SES too: emails from this domain stop at once, and adding it back means verifying it again."
						: "It's unlinked from this organization (SES keeps the identity, since it was there before Mailroom). Emails from it stop at once."
				}
				action="Remove domain"
				cancel="Keep it"
				onConfirm={async () => {
					try {
						await removeDomainFn({ data: { id: d.id } });
						toast.success("Domain removed");
						await router.navigate({ to: "/domains" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>

			<Confirm
				open={pausing}
				onOpenChange={setPausing}
				title={`Pause ${d.name}?`}
				description="Emails from it are refused with domain_paused, and queued ones wait until you resume it. Its other settings and records stay as they are."
				action="Pause sending"
				cancel="Keep sending"
				onConfirm={() => void setPaused(true)}
			/>
			{d.paused_at && (
				<Alert variant="warning">
					<Pause />
					<AlertTitle>
						Sending from {d.name} is paused
						<span className="font-normal text-muted-foreground">
							{" "}
							· {formatRelative(d.paused_at)}
						</span>
					</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						{d.paused_reason === "unknown_recipients"
							? "Mailroom paused it: too many of its emails went to addresses that don't exist, which gets SES to pause the whole brand. Clean the list it sends to, then resume."
							: d.paused_reason === "sending_limits"
								? "Mailroom paused it: its bounces or complaints went over this deployment's sending limits. Clean the list it sends to; this deployment's admins can resume it."
								: "Someone on your team paused it."}
						{canManage && (d.paused_reason !== "sending_limits" || me.isAdmin) && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setPaused(false)}
							>
								<Play />
								Resume sending
							</Button>
						)}
					</AlertDescription>
				</Alert>
			)}
			<Facts>
				<Fact label="Status">
					<StatusBadge status={d.status} />
				</Fact>
				{me.brands.length > 1 && brand && (
					<Fact label="Brand">
						<Link
							to="/brands/$id"
							params={{ id: brand.id }}
							className="truncate underline-offset-4 hover:underline"
						>
							{brand.name}
						</Link>
					</Fact>
				)}
				<Fact label="Used for">
					<Uses domain={d} />
				</Fact>
				{d.sending && (
					<Fact
						label="Purpose"
						className="[&>dd]:overflow-visible"
					>
						{canManage ? (
							<Select
								value={d.purpose}
								onValueChange={(v) =>
									setPurpose(v as "transactional" | "marketing")
								}
							>
								<SelectTrigger
									size="sm"
									className="h-7 w-auto gap-1.5 px-2.5"
									aria-label="Purpose"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="transactional">Transactional</SelectItem>
									<SelectItem value="marketing">Marketing</SelectItem>
								</SelectContent>
							</Select>
						) : (
							<PurposeBadge purpose={d.purpose} />
						)}
					</Fact>
				)}
				<Fact label="Provider">
					<Provider help={help} />
				</Fact>
				<Fact label="Region">
					<span
						className="inline-flex max-w-full items-center gap-2"
						title={`Amazon SES, ${d.region}`}
					>
						{region && <Flag country={region.country} />}
						<span className="truncate">
							{region?.name ?? d.region}
							{region && <span className="text-muted-foreground"> ({d.region})</span>}
						</span>
					</span>
				</Fact>
				<Fact label="Added">
					<span className="tabular-nums">{formatDateTime(d.created_at)}</span>
				</Fact>
				<Fact label="Last checked">
					<span
						className="tabular-nums"
						title={formatDateTime(d.checked_at)}
					>
						{d.checked_at ? formatRelative(d.checked_at) : "Never"}
					</span>
				</Fact>
				{d.mail_from && (
					<Fact label="Bounces through">
						<CopyValue
							value={d.mail_from}
							className="font-mono text-xs"
						/>
					</Fact>
				)}
				<Fact label="Id">
					<IdChip value={d.id} />
				</Fact>
			</Facts>

			{verified ? (
				<Alert variant="success">
					<CircleCheck />
					<AlertTitle>{d.sending ? "Ready to send" : "Verified"}</AlertTitle>
					<AlertDescription>
						{d.sending
							? `SES verified ${d.name}. Emails from any address at it are signed and aligned.`
							: `SES verified ${d.name}, so it can take its mail once the MX points at SES.`}
					</AlertDescription>
				</Alert>
			) : d.status === "failed" ? (
				<Alert variant="destructive">
					<CircleAlert />
					<AlertTitle>SES stopped looking for the records</AlertTitle>
					<AlertDescription>
						Check them at your DNS provider against the ones below, then check DNS
						again.
					</AlertDescription>
				</Alert>
			) : (
				<Alert variant="warning">
					<CircleAlert />
					<AlertTitle>
						{done} of {required.length} records found
					</AlertTitle>
					<AlertDescription>
						Add the records below at your DNS provider. It usually takes a few minutes,
						at most 72 hours.
					</AlertDescription>
				</Alert>
			)}

			{help && (help.connect || (!verified && help.host)) && (
				<DnsSetup
					help={help}
					verified={verified}
				/>
			)}

			<Timeline
				title="Domain events"
				steps={steps(d)}
			/>

			<section className="flex flex-col gap-3">
				<div className="flex items-center justify-between gap-3">
					<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
						DNS records
					</h2>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
							>
								<Copy />
								Copy records
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<CopyItem
								icon={Bot}
								label="As instructions for an AI assistant"
								value={prompt(d)}
							/>
							<CopyItem
								icon={FileCode2}
								label="As a zone file (BIND)"
								value={zone(d)}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<div className="flex flex-col gap-4">
					{groups(d).map((g) => (
						<RecordGroup
							key={g.key}
							title={g.title}
							tag={g.tag}
							description={g.description}
							records={g.records}
							dmarc={g.key === "dmarc" ? (d.dmarc ?? undefined) : undefined}
							note={
								g.key === "dmarc" && d.dmarc ? (
									<DmarcNote
										dmarc={d.dmarc}
										domain={d.name}
									/>
								) : undefined
							}
							found={
								g.key === "bimi"
									? !!d.bimi?.found &&
										g.records.some((r) =>
											r.value.includes(`l=${d.bimi?.logo};`),
										)
									: undefined
							}
							host={help?.host ?? null}
							root={help?.root ?? orgDomain(d.name)}
						/>
					))}
				</div>
				{help?.host && !help.host.fullNames && (
					<p className="text-xs text-muted-foreground text-pretty">
						Names are shown the way {help.host.name} wants them typed, without{" "}
						<span className="font-mono">.{help.root}</span>. Hover one for the full
						name.
					</p>
				)}
			</section>

			<DomainReceiving
				domain={d}
				canManage={canManage}
			/>

			{verified && (
				<DomainHealth
					domain={d}
					canManage={canManage}
				/>
			)}

			{d.sending && (
				<>
					<DmarcReports domain={d} />

					<DomainTracking
						domain={d}
						tracking={d.tracking}
						canManage={canManage}
					/>

					<BrandLogo
						domain={d}
						canManage={canManage}
					/>
				</>
			)}
		</Page>
	);
}

/** The DNS host, with its logo and a link to its DNS page (Resend-style). */
function Provider({ help }: { help: DnsHelp | null }) {
	if (!help) return <span className="inline-block h-4 w-24 animate-pulse rounded bg-muted" />;
	if (!help.host)
		return (
			<span className="inline-flex items-center gap-2 text-muted-foreground">
				<DnsHostMark id={null} />
				Unknown
			</span>
		);
	const body = (
		<>
			<DnsHostMark id={help.host.id} />
			<span className="truncate">{help.host.name}</span>
			{help.host.dnsUrl && (
				<ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
			)}
		</>
	);
	return help.host.dnsUrl ? (
		<a
			href={help.host.dnsUrl}
			target="_blank"
			rel="noreferrer"
			className="inline-flex max-w-full items-center gap-2 rounded-sm transition-colors hover:text-foreground/80"
			title={`Open ${help.host.name}'s DNS settings for ${help.root}`}
		>
			{body}
		</a>
	) : (
		<span className="inline-flex max-w-full items-center gap-2">{body}</span>
	);
}

/**
 * The quickest way to add the records: one click at the DNS host when it runs Domain Connect,
 * else a link to its DNS page.
 */
function DnsSetup({ help, verified }: { help: DnsHelp; verified: boolean }) {
	const host = help.host;
	const connect = help.connect;
	const name = connect?.providerName || host?.name || "your DNS host";
	return (
		<div className="flex flex-col gap-4 rounded-xl bg-card px-5 py-4 shadow-card sm:flex-row sm:items-center">
			<div className="flex min-w-0 flex-1 items-start gap-3">
				<DnsHostMark
					id={host?.id ?? null}
					className="mt-0.5 size-8 [&>svg]:size-[18px]"
				/>
				<div className="min-w-0">
					<h3 className="text-sm font-semibold">
						{connect
							? verified
								? `Add the rest at ${name} in one click`
								: `Set up ${name} in one click`
							: `Add the records at ${name}`}
					</h3>
					<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
						{connect
							? `Sign in at ${name}, approve, and it adds every record this domain still needs. You come back here and Mailroom checks them.`
							: `Open ${name}'s DNS settings and add the records below. It usually takes a few minutes.`}
					</p>
				</div>
			</div>
			{connect ? (
				<Button
					asChild
					className="shrink-0"
				>
					<a href={connect.url}>
						<Zap />
						Connect {name}
					</a>
				</Button>
			) : (
				host?.dnsUrl && (
					<Button
						asChild
						variant="outline"
						className="shrink-0"
					>
						<a
							href={host.dnsUrl}
							target="_blank"
							rel="noreferrer"
						>
							Open {host.name} DNS
							<ArrowUpRight />
						</a>
					</Button>
				)
			)}
		</div>
	);
}

/** What Mailroom found for DMARC, and what to do about it. */
function DmarcNote({ dmarc, domain }: { dmarc: Dmarc; domain: string }) {
	const text = !dmarc.found
		? `Nothing at _dmarc.${domain} yet. Add the record below; p=none only reports, so it can't stop any mail.`
		: dmarc.duplicate
			? `_dmarc.${dmarc.at} has more than one DMARC record, so providers ignore them all. Keep one.`
			: dmarc.inherited
				? `Covered by ${dmarc.at}'s record: subdomains inherit it. Add this one too to get the domain's DMARC reports in Mailroom.`
				: dmarc.policy === "none"
					? "Found, with p=none: providers only report on mail that fails. Once the reports below look clean, move to p=quarantine."
					: `Found, with p=${dmarc.policy ?? "?"}: providers ${dmarc.policy === "reject" ? "refuse" : "send to spam"} mail that fails the checks.`;
	return (
		<div
			className={cn(
				"mx-5 mb-3.5 flex flex-col gap-1.5 rounded-lg px-3 py-2.5 text-xs",
				dmarc.found && !dmarc.duplicate
					? "bg-success/[0.07] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--success)_20%,transparent)]"
					: "bg-warning/[0.08] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--warning)_26%,transparent)]",
			)}
		>
			<p className="text-pretty">
				<Ph>{text}</Ph>
			</p>
			{dmarc.record && (
				<code className="font-mono break-all text-muted-foreground">
					<Ph>
						_dmarc.{dmarc.at}: {dmarc.record}
					</Ph>
				</code>
			)}
		</div>
	);
}

function CopyItem({
	icon: Icon,
	label,
	value,
}: {
	icon: LucideIcon;
	label: string;
	value: string;
}) {
	const { copy } = useCopy();
	return (
		<DropdownMenuItem
			onSelect={() => {
				copy(value);
				toast.success("Copied");
			}}
		>
			<Icon />
			{label}
		</DropdownMenuItem>
	);
}
