import { useEffect, useState } from "react";
import { CopyField } from "@/components/copy";
import { StatusBadge } from "@/components/status-badge";
import { Spinner } from "@/components/ui/spinner";
import { dmarcReportsFn } from "@/functions/settings";
import { formatNumber, formatRelative } from "@/lib/format";
import { keep, kept, useSketching } from "@/lib/sketch";
import { cn } from "@/lib/utils";

type Reports = Awaited<ReturnType<typeof dmarcReportsFn>>;

/** Kept per domain for the session, so coming back to the page shows them at once. */
const cache = new Map<string, Reports>();

const share = (part: number, whole: number) =>
	whole ? `${Math.round((part / whole) * 1000) / 10}%` : "–";

/** Who a source is, from what it signed with. */
function sender(s: Reports["sources"][number], domain: string) {
	const signed = s.dkim_domain ?? "";
	const envelope = s.spf_domain ?? "";
	if (/amazonses\.com$/.test(envelope) || envelope.endsWith(`.${domain}`) || signed === domain)
		return s.passed ? "Mailroom (Amazon SES)" : "Amazon SES";
	return signed || envelope || "Unknown sender";
}

/**
 * What Gmail, Yahoo, Outlook and others say about mail From the domain: their daily DMARC
 * reports (server/dmarc-reports.ts). Shows who sends as the domain and what fails, which is what
 * to check before moving DMARC to quarantine, or when a provider starts refusing mail.
 */
export function DmarcReports({ domain }: { domain: { id: string; name: string } }) {
	const [data, setData] = useState<Reports | null>(
		() =>
			cache.get(domain.id) ??
			(kept("dmarc-reports")[domain.id] as Reports | undefined) ??
			null,
	);
	const [failed, setFailed] = useState(false);
	const sketching = useSketching();
	useEffect(() => {
		if (sketching) return;
		let live = true;
		dmarcReportsFn({ data: { id: domain.id } })
			.then((r) => {
				cache.set(domain.id, r);
				keep("dmarc-reports", domain.id, r, 10);
				if (live) setData(r);
			})
			.catch(() => live && setFailed(true));
		return () => {
			live = false;
		};
	}, [domain.id, sketching]);

	if (failed && !data) return null;
	if (data && !data.address) return null;
	const failing = data ? data.messages - data.passed : 0;

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				DMARC reports
			</h2>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				<div className="flex items-start gap-3 px-5 pt-4 pb-3.5">
					<div className="min-w-0 flex-1">
						<h3 className="text-sm font-semibold">Who sends as {domain.name}</h3>
						<p className="mt-1 text-sm text-muted-foreground text-pretty">
							Gmail, Yahoo, Outlook and others report every day which servers sent
							mail From this domain and whether it passed DMARC. Apple doesn't send
							reports.
						</p>
					</div>
					{data ? (
						<StatusBadge
							status={data.receiving ? "verified" : "pending"}
							label={data.receiving ? "Receiving" : "Not set up"}
							className="mt-0.5"
						/>
					) : (
						<Spinner className="mt-1 size-4 text-muted-foreground" />
					)}
				</div>

				{data && !data.receiving && (
					<div className="flex flex-col gap-2 border-t border-border/70 px-5 py-4">
						{data.own ? (
							<>
								<p className="text-sm text-pretty">
									Change the domain's DMARC record to this, so reports come to
									Mailroom. It only adds where reports go; what providers do with
									failing mail stays the same.
								</p>
								<CopyField
									label={data.record.name}
									value={data.record.value}
								/>
							</>
						) : (
							<p className="text-sm text-pretty">
								{data.inheritedFrom
									? `${domain.name} uses ${data.inheritedFrom}'s DMARC record, which sends its reports elsewhere. `
									: ""}
								Add the DMARC record above: it includes Mailroom's report address,
								so reports start coming here. It only adds where reports go; what
								providers do with failing mail stays the same.
							</p>
						)}
					</div>
				)}

				{data && data.messages > 0 && (
					<>
						<div className="grid grid-cols-3 border-t border-border/70">
							<Stat
								label={`Reported, ${data.days} days`}
								value={formatNumber(data.messages)}
							/>
							<Stat
								label="Passed DMARC"
								value={share(data.passed, data.messages)}
							/>
							<Stat
								label="Failed"
								value={formatNumber(failing)}
								tone={failing ? "warning" : undefined}
							/>
						</div>
						<div className="border-t border-border/70 px-5 py-3">
							<p className="text-xs text-muted-foreground">
								From{" "}
								{data.reporters
									.map((r) => `${r.reporter} (${formatNumber(r.messages)})`)
									.join(", ")}
								{data.last_report_at
									? `. Last report ${formatRelative(data.last_report_at)}.`
									: "."}
							</p>
						</div>
						<div className="overflow-x-auto border-t border-border/70">
							<table className="w-full min-w-[520px] text-sm">
								<thead>
									<tr className="text-left text-xs text-muted-foreground">
										<th className="px-5 py-2 font-medium">Sender</th>
										<th className="px-2 py-2 font-medium">IP</th>
										<th className="px-2 py-2 text-right font-medium">Emails</th>
										<th className="px-5 py-2 text-right font-medium">Passed</th>
									</tr>
								</thead>
								<tbody>
									{data.sources.map((s) => (
										<tr
											key={`${s.source_ip}|${s.dkim_domain}|${s.spf_domain}`}
											className="border-t border-border/50"
										>
											<td className="max-w-[220px] truncate px-5 py-2">
												{sender(s, domain.name)}
											</td>
											<td className="px-2 py-2 font-mono text-xs text-muted-foreground">
												{s.source_ip}
											</td>
											<td className="px-2 py-2 text-right tabular-nums">
												{formatNumber(s.messages)}
											</td>
											<td
												className={cn(
													"px-5 py-2 text-right tabular-nums",
													s.passed < s.messages && "text-warning",
												)}
											>
												{share(s.passed, s.messages)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{failing > 0 && (
							<p className="border-t border-border/70 px-5 py-3 text-xs text-muted-foreground text-pretty">
								Failing rows that aren't Mailroom are another service sending as
								this domain (add its DKIM to the domain, or stop it) or someone
								spoofing it. Once only Mailroom shows up and passes, DMARC can move
								to quarantine.
							</p>
						)}
					</>
				)}

				{data?.receiving && data.messages === 0 && (
					<p className="border-t border-border/70 px-5 py-4 text-sm text-muted-foreground text-pretty">
						No reports yet. Providers send one a day for the mail they got, so the first
						ones arrive a day or two after the record changes.
					</p>
				)}
			</div>
		</section>
	);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warning" }) {
	return (
		<div className="flex flex-col gap-0.5 px-5 py-3.5 [&+&]:border-l [&+&]:border-border/70">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span
				className={cn(
					"text-lg font-semibold tabular-nums",
					tone === "warning" && "text-warning",
				)}
			>
				{value}
			</span>
		</div>
	);
}
