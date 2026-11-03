import { useRouter } from "@tanstack/react-router";
import { ImageUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { setBimiLogoFn } from "@/functions/settings";
import { type Bimi, dmarcEnforces } from "@/lib/bimi";
import type { Dmarc } from "@/lib/dmarc";
import { errorMessage } from "@/lib/errors";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/**
 * A domain's brand logo (BIMI): upload it, see it as inboxes will (in a circle), and what's
 * still missing for them to show it.
 */
export function BrandLogo({
	domain,
	canManage,
}: {
	domain: {
		id: string;
		name: string;
		has_logo: boolean;
		bimi_updated_at: string | null;
		records: { record: string; value: string }[];
		dmarc: Dmarc | null;
		/** The organizational domain's DMARC, for a subdomain with its own record. */
		orgDmarc: Dmarc | null;
		bimi: Bimi | null;
	};
	canManage: boolean;
}) {
	const d = domain;
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [removing, setRemoving] = useState(false);
	const url = `/bimi/${d.name}.svg`;
	const record = d.records.find((r) => r.record === "BIMI")?.value ?? "";
	const ours = /l=([^;"]+)/.exec(record)?.[1]?.trim() ?? "";
	const own = d.dmarc ? dmarcEnforces(d.dmarc) : false;
	// BIMI also wants the organizational domain's own policy to enforce.
	const parentWeak = !!d.orgDmarc?.found && !dmarcEnforces(d.orgDmarc);
	const enforces = own && !parentWeak;
	const pointsHere = !!d.bimi?.found && d.bimi.logo === ours;

	async function upload(file: File | undefined) {
		if (!file) return;
		if (!/\.svg$/i.test(file.name) && file.type !== "image/svg+xml") {
			toast.error("Upload the logo as an SVG file.");
			return;
		}
		setBusy(true);
		try {
			await setBimiLogoFn({ data: { id: d.id, svg: await file.text() } });
			toast.success(d.has_logo ? "Logo replaced" : "Logo added");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	}

	const steps = [
		{
			done: d.has_logo,
			label: "Logo uploaded",
			hint: d.has_logo
				? "Mailroom serves it in BIMI's format (SVG Tiny PS)."
				: "A square SVG. Mailroom makes it SVG Tiny PS, the format BIMI requires.",
		},
		{
			done: enforces,
			label: "DMARC enforces",
			hint: enforces
				? `p=${d.dmarc?.policy} at _dmarc.${d.dmarc?.at}.`
				: own && parentWeak
					? `_dmarc.${d.name} enforces, but _dmarc.${d.orgDmarc?.at} has p=${d.orgDmarc?.policy ?? "?"}. BIMI also needs the parent domain's policy at p=quarantine or p=reject; check what else sends from ${d.orgDmarc?.at} first.`
					: d.dmarc?.found
						? `_dmarc.${d.dmarc.at} has p=${d.dmarc.policy ?? "?"}. Inboxes only show logos with p=quarantine or p=reject on all mail; the DMARC record above has the value.`
						: "Add the DMARC record above, with p=quarantine.",
		},
		{
			done: pointsHere,
			label: "BIMI record found",
			hint: pointsHere
				? `default._bimi.${d.bimi?.at} points to this logo.`
				: d.bimi?.found
					? `default._bimi.${d.bimi.at} points to ${d.bimi.logo ?? "no logo"}, not this one. Replace it with the BIMI record above.`
					: d.has_logo
						? "Add the BIMI record above."
						: "Upload the logo to get the record.",
		},
	];
	const ready = steps.every((s) => s.done);

	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				Brand logo
			</h2>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				<div className="flex items-start gap-3 px-5 pt-4 pb-3.5">
					<div className="min-w-0 flex-1">
						<h3 className="flex items-center gap-2 text-sm font-semibold">
							Logo in inboxes
							<span className="rounded-sm bg-muted px-1.5 py-px font-mono text-2xs font-medium text-muted-foreground">
								BIMI
							</span>
						</h3>
						<p className="mt-1 text-sm text-muted-foreground text-pretty">
							Shows your logo beside emails from {d.name} instead of an initial.
						</p>
					</div>
					<StatusBadge
						status={ready ? "verified" : "pending"}
						label={ready ? "Ready" : d.has_logo ? "Not ready" : "No logo"}
						className="mt-0.5"
					/>
				</div>
				<div className="flex flex-col gap-5 border-t border-border/70 px-5 py-4 sm:flex-row">
					<button
						type="button"
						disabled={!canManage || busy}
						onClick={() => input.current?.click()}
						onDragOver={(e) => {
							if (!canManage) return;
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							if (canManage) upload(e.dataTransfer.files[0]);
						}}
						aria-label={d.has_logo ? "Replace the logo" : "Upload a logo"}
						className={cn(
							"group relative flex size-28 shrink-0 items-center justify-center self-center overflow-hidden rounded-full transition-shadow enabled:cursor-pointer sm:self-start",
							d.has_logo
								? "shadow-[0_0_0_1px_var(--border)]"
								: "border border-dashed border-border bg-muted/40",
							dragging && "ring-2 ring-primary ring-offset-2 ring-offset-card",
						)}
					>
						{d.has_logo ? (
							<img
								src={`${url}?v=${d.bimi_updated_at ?? ""}`}
								alt={`${d.name} logo`}
								className="size-full object-cover"
							/>
						) : (
							<span className="flex flex-col items-center gap-1 px-3 text-xs text-muted-foreground">
								<ImageUp className="size-5" />
								{canManage ? "Drop an SVG" : "No logo"}
							</span>
						)}
						{busy && (
							<span className="absolute inset-0 flex items-center justify-center bg-background/70">
								<Spinner />
							</span>
						)}
					</button>
					<input
						ref={input}
						type="file"
						accept=".svg,image/svg+xml"
						className="hidden"
						onChange={(e) => upload(e.target.files?.[0])}
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-3">
						<ol className="flex flex-col gap-2.5">
							{steps.map((s) => (
								<li
									key={s.label}
									className="flex items-start gap-2.5 text-sm"
								>
									<StatusBadge
										status={s.done ? "verified" : "pending"}
										label={s.done ? "Done" : "To do"}
										className="mt-px w-16 justify-start"
									/>
									<div className="min-w-0">
										<p className="font-medium">{s.label}</p>
										<p className="text-xs text-muted-foreground text-pretty break-words">
											<Ph>{s.hint}</Ph>
										</p>
									</div>
								</li>
							))}
						</ol>
						<p className="text-xs text-muted-foreground text-pretty">
							With these, Yahoo, AOL and Fastmail show the logo. Apple Mail takes it
							from Apple Business Connect (Branded Mail). Gmail also requires a mark
							certificate (VMC, for a registered trademark, or CMC), added to the BIMI
							record as <code className="font-mono">a=</code>.
						</p>
						{canManage && (
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => input.current?.click()}
								>
									<ImageUp />
									{d.has_logo ? "Replace logo" : "Upload logo"}
								</Button>
								{d.has_logo && (
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => setRemoving(true)}
									>
										<Trash2 />
										Remove
									</Button>
								)}
							</div>
						)}
					</div>
				</div>
			</div>
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title="Remove the logo?"
				description={`Inboxes stop showing it for ${d.name} once they notice; remove the BIMI record too.`}
				action="Remove logo"
				cancel="Keep it"
				onConfirm={async () => {
					try {
						await setBimiLogoFn({ data: { id: d.id, svg: null } });
						toast.success("Logo removed");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
		</section>
	);
}
