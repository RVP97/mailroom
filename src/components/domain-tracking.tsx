import { useRouter } from "@tanstack/react-router";
import { Eye, Link2, MousePointerClick, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { setTrackingFn, trackingHostFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { patch, useOptimisticState } from "@/lib/optimistic";

/**
 * A domain's open and click tracking: on or off, and where tracked links point (the domain's
 * own links.<domain> (or track.<domain>…, when links. is taken by another app), or Mailroom's
 * address until that's set up).
 */
export function DomainTracking({
	domain: d,
	tracking,
	canManage,
}: {
	domain: {
		id: string;
		name: string;
		open_tracking: boolean;
		click_tracking: boolean;
		tracking_host: string | null;
		tracking_status: string | null;
	};
	tracking: { own: boolean; customHost: boolean; target: string; base: string } | null;
	canManage: boolean;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [removing, setRemoving] = useState(false);
	const [prefix, setPrefix] = useState("links");
	const label = prefix.trim().toLowerCase() || "links";
	const host = `${label}.${d.name}`;
	const active = d.tracking_status === "active";
	const shownHost =
		active && d.tracking_host
			? d.tracking_host
			: tracking?.base
				? new URL(tracking.base).host
				: // The server's first paint draws the page as its skeleton, where there is no location.
					typeof location === "undefined"
					? ""
					: location.host;

	async function run(what: string, fn: () => Promise<unknown>, done?: string) {
		setBusy(what);
		try {
			await fn();
			if (done) toast.success(done);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	}

	// The switches move at once; a failed save puts them back.
	const [shown, save] = useOptimisticState(d, patch<typeof d>);
	const toggle = async (key: "open" | "click", value: boolean) => {
		const ok = await save({ [`${key}_tracking`]: value }, () =>
			setTrackingFn({ data: { id: d.id, [key]: value } }),
		);
		if (ok)
			toast.success(`${key === "open" ? "Open" : "Click"} tracking ${value ? "on" : "off"}`);
	};

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				Tracking
			</h2>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				<Row
					icon={<MousePointerClick className="size-4" />}
					title="Click tracking"
					description={`Links in HTML emails go through ${shownHost}, which records the click and sends the reader on. Plain-text parts and unsubscribe links stay as they are.`}
				>
					<Switch
						checked={shown.click_tracking}
						disabled={!canManage || busy !== null}
						onCheckedChange={(v) => toggle("click", v)}
						aria-label="Click tracking"
					/>
				</Row>
				<Row
					icon={<Eye className="size-4" />}
					title="Open tracking"
					description="A 1×1 image at the end of HTML emails records when it loads. Apple Mail loads images for privacy, so opens run high: read them as a trend."
				>
					<Switch
						checked={shown.open_tracking}
						disabled={!canManage || busy !== null}
						onCheckedChange={(v) => toggle("open", v)}
						aria-label="Open tracking"
					/>
				</Row>
				<div className="flex flex-col gap-3 border-t border-border/70 px-5 py-4">
					<div className="flex items-start gap-3">
						<span className="mt-0.5 text-muted-foreground">
							<Link2 className="size-4" />
						</span>
						<div className="min-w-0 flex-1">
							<h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
								Tracking domain
								{d.tracking_host && (
									<StatusBadge
										status={
											active
												? "verified"
												: d.tracking_status === "failed"
													? "failed"
													: "pending"
										}
										label={
											active
												? "Active"
												: d.tracking_status === "failed"
													? "Failed"
													: "Waiting for DNS"
										}
									/>
								)}
							</h3>
							<p className="mt-1 text-sm text-muted-foreground text-pretty">
								{d.tracking_host
									? active
										? `Emails from ${d.name} use ${d.tracking_host} for tracked links, the open image, the unsubscribe page, "view in browser", polls, referral links and images. Your newsletter's public page is there too, so readers never see ${shownHost}.`
										: `Add the Tracking record above (CNAME ${d.tracking_host} → ${tracking?.target ?? ""}). Once it's found and its certificate is issued, links and pages move to it; until then they use ${shownHost}.`
									: `Tracked links, the unsubscribe page, "view in browser" and your newsletter's page use ${shownHost}. On a subdomain of ${d.name} instead, they match the sender, which spam filters and careful readers like. Pick a name nothing else uses: if links.${d.name} already serves another email service's tracking, use track or go.`}
							</p>
							{!d.tracking_host && tracking && !tracking.customHost && (
								<p className="mt-1.5 text-xs text-muted-foreground text-pretty">
									This deployment hasn't set up Cloudflare for SaaS yet, which
									serves each domain's tracking host (see the README).
								</p>
							)}
						</div>
					</div>
					{canManage && tracking?.customHost && (
						<div className="flex flex-wrap gap-2 pl-7">
							{!d.tracking_host ? (
								<>
									<div className="flex h-8 items-center overflow-hidden rounded-md border border-input bg-background text-sm focus-within:ring-2 focus-within:ring-ring/50">
										<Input
											value={prefix}
											onChange={(e) => setPrefix(e.target.value)}
											aria-label="Tracking subdomain"
											spellCheck={false}
											className="h-8 w-20 rounded-none border-0 bg-transparent px-2 text-right font-mono shadow-none focus-visible:ring-0"
										/>
										<span className="pr-2.5 font-mono text-muted-foreground">
											.{d.name}
										</span>
									</div>
									<Button
										size="sm"
										variant="outline"
										disabled={busy !== null}
										onClick={() =>
											run(
												"host",
												() =>
													trackingHostFn({
														data: {
															id: d.id,
															action: "add",
															prefix: label,
														},
													}),
												`${host} added: add its record above`,
											)
										}
									>
										{busy === "host" ? <Spinner /> : <Link2 />}
										Use {host}
									</Button>
								</>
							) : (
								<>
									{!active && (
										<Button
											size="sm"
											variant="outline"
											disabled={busy !== null}
											onClick={() =>
												run("check", () =>
													trackingHostFn({
														data: { id: d.id, action: "check" },
													}),
												)
											}
										>
											{busy === "check" ? <Spinner /> : <RefreshCw />}
											Check again
										</Button>
									)}
									<Button
										size="sm"
										variant="ghost"
										disabled={busy !== null}
										onClick={() => setRemoving(true)}
									>
										<Trash2 />
										Stop using {d.tracking_host}
									</Button>
								</>
							)}
						</div>
					)}
					{tracking && !tracking.own && (
						<p className="pl-7 text-xs text-muted-foreground text-pretty">
							For now SES still tracks opens and clicks, on its shared awstrack.me
							domain. Mailroom takes over once an admin updates the IAM policy
							(scripts/update-iam.sh).
						</p>
					)}
				</div>
			</div>
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title={`Stop using ${d.tracking_host}?`}
				description={`New emails track on ${new URL(tracking?.base || "https://mailroom").host} instead. Links in emails already sent keep working only while ${d.tracking_host} still points here, so leave its record for a while.`}
				action="Stop using it"
				cancel="Keep it"
				onConfirm={() =>
					run(
						"remove",
						() => trackingHostFn({ data: { id: d.id, action: "remove" } }),
						"Tracking domain removed",
					)
				}
			/>
		</section>
	);
}

function Row({
	icon,
	title,
	description,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<div className="flex items-start gap-3 border-b border-border/70 px-5 py-4 last:border-b-0">
			<span className="mt-0.5 text-muted-foreground">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="block text-sm font-semibold">{title}</span>
				<span className="mt-1 block text-sm text-muted-foreground text-pretty">
					{description}
				</span>
			</span>
			<span className="mt-0.5">{children}</span>
		</div>
	);
}
