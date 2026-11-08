import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { getMarketingRulesFn, setMarketingRulesFn } from "@/functions/marketing-rules";
import { errorMessage } from "@/lib/errors";

type Rules = Awaited<ReturnType<typeof getMarketingRulesFn>>;

/** Quiet mode and the frequency cap (src/server/marketing-rules.ts), for broadcasts and automations. */
export function MarketingRulesCard({ canManage }: { canManage: boolean }) {
	const [rules, setRules] = useState<Rules | null>(null);
	const [busy, setBusy] = useState(false);
	const [count, setCount] = useState("3");
	const [days, setDays] = useState("7");
	useEffect(() => {
		getMarketingRulesFn()
			.then((r) => {
				setRules(r);
				if (r.cap) {
					setCount(String(r.cap.count));
					setDays(String(r.cap.days));
				}
			})
			.catch(() => {});
	}, []);
	const save = async (data: Parameters<typeof setMarketingRulesFn>[0]["data"], done: string) => {
		setBusy(true);
		try {
			setRules(await setMarketingRulesFn({ data }));
			toast.success(done);
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	const cap = { count: Number(count), days: Number(days) };
	const capValid =
		Number.isInteger(cap.count) &&
		cap.count >= 1 &&
		cap.count <= 100 &&
		Number.isInteger(cap.days) &&
		cap.days >= 1 &&
		cap.days <= 90;
	const capChanged =
		!!rules?.cap && (rules.cap.count !== cap.count || rules.cap.days !== cap.days);
	return (
		<>
			<Card>
				<CardHeader>
					<CardTitle>Quiet mode</CardTitle>
					<CardDescription>
						Support comes first. Someone with an urgent conversation still open, or who
						rated a conversation 2 or less in the last 14 days, gets no broadcasts or
						automation emails until that's behind them. Replies and emails sent through
						the API always go.
					</CardDescription>
					<CardAction>
						<Switch
							checked={rules?.quiet_mode ?? false}
							disabled={!canManage || busy || !rules}
							aria-label="Quiet mode"
							onCheckedChange={(v) =>
								save({ quiet_mode: v }, v ? "Quiet mode on" : "Quiet mode off")
							}
						/>
					</CardAction>
				</CardHeader>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>Frequency cap</CardTitle>
					<CardDescription>
						Nobody gets more broadcasts than this, across all of them. People over the
						cap are left out of the next one and the send dialog says how many.
						Automation emails count toward it but always go.
					</CardDescription>
					<CardAction>
						<Switch
							checked={!!rules?.cap}
							disabled={!canManage || busy || !rules || (!rules.cap && !capValid)}
							aria-label="Frequency cap"
							onCheckedChange={(v) =>
								save(
									{ cap: v ? cap : null },
									v ? "Frequency cap on" : "Frequency cap off",
								)
							}
						/>
					</CardAction>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap items-end gap-3">
						<div className="grid gap-1.5">
							<Label htmlFor="cap-count">At most</Label>
							<div className="flex items-center gap-2">
								<Input
									id="cap-count"
									inputMode="numeric"
									className="w-20"
									value={count}
									disabled={!canManage}
									onChange={(e) => setCount(e.target.value)}
								/>
								<span className="text-sm text-muted-foreground">broadcasts</span>
							</div>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="cap-days">Within</Label>
							<div className="flex items-center gap-2">
								<Input
									id="cap-days"
									inputMode="numeric"
									className="w-20"
									value={days}
									disabled={!canManage}
									onChange={(e) => setDays(e.target.value)}
								/>
								<span className="text-sm text-muted-foreground">days</span>
							</div>
						</div>
						{capChanged && (
							<Button
								size="sm"
								disabled={!capValid || busy}
								onClick={() => save({ cap }, "Frequency cap saved")}
							>
								{busy && <Spinner />}
								Save cap
							</Button>
						)}
					</div>
					{!capValid && (
						<p className="mt-2 text-sm text-destructive">
							Pick 1 to 100 broadcasts in 1 to 90 days.
						</p>
					)}
				</CardContent>
			</Card>
		</>
	);
}
