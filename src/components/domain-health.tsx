import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { checkDomainHealthFn, domainHealthFn } from "@/functions/deliverability";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useSketching } from "@/lib/sketch";

type Health = Awaited<ReturnType<typeof domainHealthFn>>;

/**
 * The deliverability watch's last look at a verified domain: its DNS still as Mailroom asked
 * (checked every day; a change emails the owners) and the domain blocklists.
 */
export function DomainHealth({
	domain,
	canManage,
}: {
	domain: { id: string; name: string };
	canManage: boolean;
}) {
	const [data, setData] = useState<Health | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	const sketching = useSketching();
	useEffect(() => {
		if (sketching) return;
		let live = true;
		domainHealthFn({ data: { id: domain.id } })
			.then((r) => live && setData(r))
			.catch(() => live && setData(null));
		return () => {
			live = false;
		};
	}, [domain.id, sketching]);

	const check = async () => {
		setBusy(true);
		try {
			setData(await checkDomainHealthFn({ data: { id: domain.id } }));
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const errors = data?.problems.filter((p) => p.level === "error") ?? [];
	const warnings = data?.problems.filter((p) => p.level === "warning") ?? [];
	const listed = data?.listings.filter((l) => l.status === "listed") ?? [];
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				Deliverability watch
			</h2>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				<div className="flex items-start gap-3 px-5 pt-4 pb-3.5">
					<div className="min-w-0 flex-1">
						<h3 className="text-sm font-semibold">DNS and blocklists</h3>
						<p className="mt-1 text-sm text-muted-foreground text-pretty">
							Every day Mailroom checks that {domain.name}'s records are still the
							ones SES needs, and looks it up on domain blocklists. Owners and admins
							get an email when something changes.
						</p>
					</div>
					{data === undefined ? (
						<Spinner className="mt-1 size-4 text-muted-foreground" />
					) : data ? (
						<StatusBadge
							status={data.ok ? "ready" : "failed"}
							label={data.ok ? "All good" : "Needs a look"}
							className="mt-0.5"
						/>
					) : (
						<StatusBadge
							status="not_started"
							label="Not checked yet"
							className="mt-0.5"
						/>
					)}
				</div>
				{data && (errors.length > 0 || listed.length > 0 || warnings.length > 0) && (
					<ul className="flex flex-col gap-2 border-t border-border/70 px-5 py-4 text-sm">
						{[...errors, ...warnings].map((p) => (
							<li
								key={`${p.record}:${p.name}`}
								className="flex flex-col"
							>
								<span className={p.level === "error" ? "text-destructive" : ""}>
									{p.record} at{" "}
									<span className="font-mono text-[13px]">{p.name}</span>{" "}
									{p.found.length ? "points elsewhere" : "is missing"}
								</span>
								<span className="text-xs break-all text-muted-foreground">
									Should be {p.expected}
									{p.found.length ? `; found ${p.found.join(", ")}` : ""}
								</span>
							</li>
						))}
						{listed.map((l) => (
							<li
								key={l.list}
								className="text-destructive"
							>
								Listed on {l.list}
								{l.detail ? ` (${l.detail})` : ""}
							</li>
						))}
					</ul>
				)}
				{data && (
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/70 px-5 py-3 text-xs text-muted-foreground">
						{data.listings.map((l) => (
							<span key={l.list}>
								{l.list}:{" "}
								{l.status === "clean"
									? "not listed"
									: l.status === "listed"
										? "listed"
										: "couldn't ask"}
							</span>
						))}
						<span className="ml-auto">Checked {formatRelative(data.checked_at)}</span>
					</div>
				)}
				{canManage && (
					<div className="border-t border-border/70 px-5 py-3">
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={check}
						>
							{busy ? <Spinner /> : <RefreshCw />}
							Check now
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}
