import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	saveSendingLimitsFn,
	sendingLimitsFn,
	setOrganizationActionsFn,
} from "@/functions/sending-limits";
import { errorMessage } from "@/lib/errors";

type Loaded = Awaited<ReturnType<typeof sendingLimitsFn>>;
type Limits = Loaded["limits"];
type Action = "alert" | "pause";

const ACTION: Record<Action, string> = { alert: "Alert only", pause: "Alert and pause" };
const STREAMS = [
	["transactional", "Transactional", "Receipts, bookings, codes"],
	["marketing", "Marketing", "Newsletters and broadcasts"],
] as const;

/** Percent text ↔ a rate (0.03 ↔ "3"). */
const toPct = (v: number) => String(Number((v * 100).toFixed(3)));
const fromPct = (s: string) => Number(s.replace(",", ".")) / 100;

function useLimits() {
	const [data, setData] = useState<Loaded | null>(null);
	useEffect(() => {
		sendingLimitsFn()
			.then(setData)
			.catch((error) => toast.error(errorMessage(error)));
	}, []);
	return [data, setData] as const;
}

/** Admin › Sending limits: the deployment's warning and act levels, and the default actions. */
export function SendingLimitsCard() {
	const [data] = useLimits();
	const [form, setForm] = useState<Record<string, string> | null>(null);
	const [actions, setActions] = useState<Limits["actions"] | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!data) return;
		const l = data.limits;
		setForm({
			min_sent: String(l.min_sent),
			bounce_warning: toPct(l.bounce.warning),
			bounce_danger: toPct(l.bounce.danger),
			complaint_warning: toPct(l.complaint.warning),
			complaint_danger: toPct(l.complaint.danger),
			soft: toPct(l.soft_bounce_warning),
		});
		setActions(l.actions);
	}, [data]);
	if (!form || !actions) return null;
	const field = (key: string, label: string, suffix = "%") => (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={`limit-${key}`}>{label}</Label>
			<div className="relative">
				<Input
					id={`limit-${key}`}
					inputMode="decimal"
					value={form[key] ?? ""}
					onChange={(e) => setForm({ ...form, [key]: e.target.value })}
					className="pr-8"
				/>
				<span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground text-sm">
					{suffix}
				</span>
			</div>
		</div>
	);
	const save = async () => {
		setBusy(true);
		try {
			await saveSendingLimitsFn({
				data: {
					min_sent: Math.round(Number(form.min_sent)),
					bounce: {
						warning: fromPct(form.bounce_warning ?? ""),
						danger: fromPct(form.bounce_danger ?? ""),
					},
					complaint: {
						warning: fromPct(form.complaint_warning ?? ""),
						danger: fromPct(form.complaint_danger ?? ""),
					},
					soft_bounce_warning: fromPct(form.soft ?? ""),
					actions,
				},
			});
			toast.success("Sending limits saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Sending limits</CardTitle>
				<CardDescription>
					Checked every hour over each brand's last 7 days, transactional and marketing
					domains apart. Crossing a warning level emails the organization's owners and
					you; crossing an act level does what its kind says. SES reviews an account at 5%
					bounces or 0.1% complaints and may pause it at 10% or 0.5%, so these stay under
					that.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				<div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
					{field("bounce_warning", "Bounces: warn at")}
					{field("bounce_danger", "Bounces: act at")}
					{field("complaint_warning", "Complaints: warn at")}
					{field("complaint_danger", "Complaints: act at")}
					{field("soft", "Soft bounces: warn at")}
					{field("min_sent", "Judged from", "emails")}
				</div>
				<div className="grid gap-4 sm:grid-cols-2">
					{STREAMS.map(([key, label, hint]) => (
						<div
							key={key}
							className="flex flex-col gap-1.5"
						>
							<Label>
								{label}{" "}
								<span className="font-normal text-muted-foreground">· {hint}</span>
							</Label>
							<Select
								value={actions[key]}
								onValueChange={(v) =>
									setActions({ ...actions, [key]: v as Action })
								}
							>
								<SelectTrigger aria-label={`${label}: at the act level`}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="alert">{ACTION.alert}</SelectItem>
									<SelectItem value="pause">{ACTION.pause}</SelectItem>
								</SelectContent>
							</Select>
						</div>
					))}
				</div>
				<p className="text-muted-foreground text-xs">
					Bounces are hard bounces (addresses that don't exist), the ones SES counts. Soft
					bounces only ever warn. "Alert and pause" pauses that brand's domains of that
					kind; only this deployment's admins can resume them. Each organization can have
					its own action in its Settings.
				</p>
			</CardContent>
			<CardFooter className="justify-end">
				<Button
					onClick={save}
					disabled={busy}
				>
					Save limits
				</Button>
			</CardFooter>
		</Card>
	);
}

/** Settings › Sending limits: the organization's actions (only the deployment's admins change them). */
export function OrganizationLimitsCard() {
	const [data, setData] = useLimits();
	const [busy, setBusy] = useState(false);
	if (!data) return null;
	const { limits, actions, canEdit } = data;
	const pct = (v: number) => `${toPct(v)}%`;
	const change = async (key: "transactional" | "marketing", v: string) => {
		setBusy(true);
		try {
			const next = await setOrganizationActionsFn({
				data: { [key]: v === "default" ? null : (v as Action) },
			});
			setData({ ...data, actions: next });
			toast.success("Saved");
		} catch (error) {
			toast.error(errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Sending limits</CardTitle>
				<CardDescription>
					Over the last 7 days (from {limits.min_sent} emails on): a warning at{" "}
					{pct(limits.bounce.warning)} bounces or {pct(limits.complaint.warning)}{" "}
					complaints, and Mailroom acts at {pct(limits.bounce.danger)} or{" "}
					{pct(limits.complaint.danger)}.
					{canEdit ? "" : " This deployment's admins set what happens then."}
				</CardDescription>
			</CardHeader>
			<CardContent className="grid gap-4 sm:grid-cols-2">
				{STREAMS.map(([key, label, hint]) => (
					<div
						key={key}
						className="flex flex-col gap-1.5"
					>
						<Label>
							{label}{" "}
							<span className="font-normal text-muted-foreground">· {hint}</span>
						</Label>
						<Select
							value={actions[key] ?? "default"}
							onValueChange={(v) => change(key, v)}
							disabled={!canEdit || busy}
						>
							<SelectTrigger aria-label={`${label}: at the act level`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">
									Mailroom's default ({ACTION[limits.actions[key]].toLowerCase()})
								</SelectItem>
								<SelectItem value="alert">{ACTION.alert}</SelectItem>
								<SelectItem value="pause">{ACTION.pause}</SelectItem>
							</SelectContent>
						</Select>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
