import type { ReactNode } from "react";
import { useState } from "react";
import { CopyIcon, useCopy } from "@/components/copy";
import { StatusBadge } from "@/components/status-badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Dmarc } from "@/lib/dmarc";
import { type DnsHost, recordNameForHost } from "@/lib/dns-hosts";
import { cn } from "@/lib/utils";

/** A DNS record to add, with what Mailroom last found of it (SES's SUCCESS / PENDING / …). */
export interface DnsRecord {
	type: string;
	name: string;
	value: string;
	priority?: number;
	status?: string;
	optional?: boolean;
}

const recordStatus = (r: DnsRecord) =>
	r.status === "SUCCESS" ? "verified" : (r.status?.toLowerCase() ?? "pending");

/** A group of records to add together, as a table (desktop) or label and value rows (phones). */
export function RecordGroup({
	title,
	tag,
	description,
	records,
	dmarc,
	note,
	found,
	host,
	root,
}: {
	title: string;
	tag: string;
	description: string;
	records: DnsRecord[];
	/** DMARC isn't checked by SES: Mailroom looks it up in DNS itself. */
	dmarc?: Dmarc;
	/** A record Mailroom looks up itself (BIMI): whether it's there as given. */
	found?: boolean;
	/** Shown above the records (DMARC's: what Mailroom found). */
	note?: ReactNode;
	/** The DNS host, to write names the way it wants them typed. */
	host: DnsHost | null;
	root: string;
}) {
	const name = (full: string) => recordNameForHost(full, root, host);
	const optional = records.every((r) => r.optional) && !dmarc;
	const all = dmarc ? dmarc.found : records.every((r) => r.status === "SUCCESS");
	return (
		<div className="overflow-hidden rounded-xl bg-card shadow-card">
			<div className="flex items-start gap-3 px-5 pt-4 pb-3.5">
				<div className="min-w-0 flex-1">
					<h3 className="flex items-center gap-2 text-sm font-semibold">
						{title}
						<span className="rounded-sm bg-muted px-1.5 py-px font-mono text-2xs font-medium text-muted-foreground">
							{tag}
						</span>
					</h3>
					<p className="mt-1 text-sm text-muted-foreground text-pretty">{description}</p>
				</div>
				{!optional && (
					<StatusBadge
						status={all ? "verified" : "pending"}
						label={dmarc ? (all ? "Found" : "Not found") : undefined}
						className="mt-0.5"
					/>
				)}
			</div>
			{note}
			{/* Desktop: a table. Phones: each record as label and value rows. */}
			<table className="hidden w-full table-fixed border-t border-border/70 text-sm md:table">
				<thead>
					<tr className="text-left text-xs text-muted-foreground">
						<th className="h-9 w-20 pl-5 font-medium">Type</th>
						<th className="h-9 w-[34%] px-3 font-medium">Name</th>
						<th className="h-9 px-3 font-medium">Content</th>
						<th className="h-9 w-16 px-3 font-medium">TTL</th>
						<th className="h-9 w-16 px-3 font-medium">Priority</th>
						<th className="h-9 w-28 pr-5 font-medium">Status</th>
					</tr>
				</thead>
				<tbody>
					{records.map((r) => (
						<tr
							key={`${r.type}${r.name}${r.value}`}
							className="border-t border-border/70"
						>
							<td className="h-11 pl-5 font-mono text-xs font-medium">{r.type}</td>
							<td className="px-3">
								<Value
									value={name(r.name)}
									full={r.name}
								/>
							</td>
							<td className="px-3">
								<Value value={r.value} />
							</td>
							<td className="px-3 font-mono text-xs text-muted-foreground">Auto</td>
							<td className="px-3 font-mono text-xs text-muted-foreground">
								{r.priority ?? "—"}
							</td>
							<td className="pr-5">
								<RecordStatus
									r={r}
									dmarc={dmarc}
									found={found}
								/>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<ul className="divide-y divide-border/70 border-t border-border/70 md:hidden">
				{records.map((r) => (
					<li
						key={`${r.type}${r.name}${r.value}`}
						className="flex flex-col gap-2 px-5 py-3.5"
					>
						<div className="flex items-center justify-between gap-3">
							<span className="font-mono text-xs font-medium">
								{r.type}
								{r.priority !== undefined && (
									<span className="text-muted-foreground">
										{" "}
										· priority {r.priority}
									</span>
								)}
							</span>
							<RecordStatus
								r={r}
								dmarc={dmarc}
								found={found}
							/>
						</div>
						<dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
							<dt className="text-muted-foreground">Name</dt>
							<dd className="min-w-0">
								<Value
									value={name(r.name)}
									full={r.name}
									wrap
								/>
							</dd>
							<dt className="text-muted-foreground">Content</dt>
							<dd className="min-w-0">
								<Value
									value={r.value}
									wrap
								/>
							</dd>
						</dl>
					</li>
				))}
			</ul>
		</div>
	);
}

function RecordStatus({ r, dmarc, found }: { r: DnsRecord; dmarc?: Dmarc; found?: boolean }) {
	if (found !== undefined)
		return (
			<StatusBadge
				status={found ? "verified" : "pending"}
				label={found ? "Found" : "Not found"}
			/>
		);
	if (dmarc)
		return dmarc.found ? (
			<StatusBadge
				status="verified"
				label={dmarc.inherited ? "Inherited" : "Found"}
			/>
		) : (
			<StatusBadge
				status="pending"
				label="Not found"
			/>
		);
	if (r.optional) return <span className="text-xs text-muted-foreground">Optional</span>;
	const s = recordStatus(r);
	return (
		<StatusBadge
			status={s}
			label={s === "verified" ? "Found" : undefined}
		/>
	);
}

/** A DNS value copied whole on click. Too long for its column, it loses its middle, not its end
 * (the domain), and shows whole on hover. */
function Value({
	value,
	full,
	wrap = false,
}: {
	value: string;
	/** The whole name, when `value` leaves out the zone. */
	full?: string;
	wrap?: boolean;
}) {
	const { copied, copy } = useCopy();
	const [hover, setHover] = useState(false);
	// Keep the last two labels whole: "….example.com".
	const cut = Math.max(value.length - 24, value.lastIndexOf(".", value.lastIndexOf(".") - 1));
	const tail = wrap || cut <= 0 ? "" : value.slice(cut);
	return (
		<Tooltip
			open={hover || copied}
			onOpenChange={setHover}
		>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={() => copy(value)}
					className="group/copy inline-flex max-w-full min-w-0 cursor-pointer items-center text-left font-mono text-xs text-foreground/90 hover:text-foreground"
				>
					{wrap ? (
						<span className="break-all">{value}</span>
					) : (
						<>
							<span className="truncate">
								{value.slice(0, value.length - tail.length)}
							</span>
							<span className="shrink-0">{tail}</span>
						</>
					)}
					<CopyIcon
						copied={copied}
						className={cn(
							"ml-1.5 size-3 text-faint transition-opacity duration-150",
							copied ? "opacity-100" : "opacity-0 group-hover/copy:opacity-100",
						)}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-96 font-mono font-normal break-all">
				{copied ? "Copied" : (full ?? value)}
			</TooltipContent>
		</Tooltip>
	);
}
