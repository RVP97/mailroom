import { useRouter } from "@tanstack/react-router";
import { ExternalLink, RotateCw } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";
import { Section, TableCard } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { type accountStatusFn, refreshCostsFn } from "@/functions/admin";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

type AwsCosts = NonNullable<Awaited<ReturnType<typeof refreshCostsFn>>>;

const BILLING_URL = "https://console.aws.amazon.com/costmanagement/home#/home";

export function formatMoney(amount: number, unit = "USD"): string {
	if (amount > 0 && amount < 0.005) return `<${formatMoney(0.01, unit)}`;
	try {
		return new Intl.NumberFormat(undefined, { style: "currency", currency: unit }).format(
			amount,
		);
	} catch {
		return `${amount.toFixed(2)} ${unit}`;
	}
}

const monthName = (start: string) =>
	new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(
		new Date(`${start}T00:00:00Z`),
	);

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
	return (
		<div className="px-5 py-4">
			<p className="text-sm text-muted-foreground">{label}</p>
			<p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
			{note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
		</div>
	);
}

/** The AWS account's costs from Cost Explorer (kept a day: each call costs $0.01). */
export function AwsCostsSection({ costs }: { costs: AwsCosts | null }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	if (!costs) return null;
	const { thisMonth, lastMonth, unit } = costs;
	const money = (n: number) => formatMoney(n, unit);
	const credits = (c: number) => (c < 0 ? `${money(-c)} in credits` : undefined);
	return (
		<Section
			title="Costs"
			description={
				<>
					What AWS charges this account, from Cost Explorer. Updated{" "}
					{formatRelative(costs.fetchedAt)}; each update costs $0.02.
				</>
			}
			actions={
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						asChild
					>
						<a
							href={BILLING_URL}
							target="_blank"
							rel="noreferrer"
						>
							<ExternalLink />
							Billing console
						</a>
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await refreshCostsFn({ data: {} });
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy ? <Spinner /> : <RotateCw />}
						Update
					</Button>
				</div>
			}
		>
			{costs.error && (
				<Alert variant="warning">
					<AlertTitle>Cost Explorer didn't answer</AlertTitle>
					<AlertDescription className="[overflow-wrap:anywhere]">
						{costs.error}
					</AlertDescription>
				</Alert>
			)}
			{thisMonth && (
				<>
					<Card className="grid grid-cols-1 divide-y divide-border/70 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
						<Stat
							label={`${monthName(thisMonth.start)} so far`}
							value={money(thisMonth.total)}
							note={credits(thisMonth.credits) ?? "Charged at the end of the month."}
						/>
						<Stat
							label="Forecast for the month"
							value={
								costs.forecast === null ? "—" : money(Math.max(0, costs.forecast))
							}
							note={
								costs.forecast === null
									? "AWS needs more history to forecast."
									: "AWS's estimate of the whole month."
							}
						/>
						<Stat
							label={lastMonth ? monthName(lastMonth.start) : "Last month"}
							value={lastMonth ? money(lastMonth.total) : money(0)}
							note={
								lastMonth
									? [
											lastMonth.estimated ? "Not final yet" : "Final",
											credits(lastMonth.credits),
										]
											.filter(Boolean)
											.join(" · ")
									: "Nothing charged."
							}
						/>
					</Card>
					<TableCard>
						{thisMonth.byService.length === 0 ? (
							<CardContent className="py-8 text-center text-muted-foreground">
								Nothing charged this month yet.
							</CardContent>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Service this month</TableHead>
										<TableHead className="text-right">Cost</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{thisMonth.byService.map((s) => (
										<TableRow key={s.service}>
											<TableCell className="w-full max-w-0 truncate font-medium">
												{s.service}
											</TableCell>
											<TableCell className="text-right tabular-nums">
												{money(s.amount)}
											</TableCell>
										</TableRow>
									))}
									{thisMonth.credits < 0 && (
										<TableRow>
											<TableCell className="text-muted-foreground">
												Credits and discounts
											</TableCell>
											<TableCell className="text-right tabular-nums text-success">
												−{money(-thisMonth.credits)}
											</TableCell>
										</TableRow>
									)}
								</TableBody>
							</Table>
						)}
					</TableCard>
				</>
			)}
		</Section>
	);
}

type Split = NonNullable<Awaited<ReturnType<typeof accountStatusFn>>["split"]>;

/**
 * The bill split by organization: each one's share of the month's emails (sent and received)
 * times what the month came to, with its brands under it.
 */
export function CostByOrganization({ split }: { split: Split }) {
	const [month, setMonth] = useState<"this" | "last">("this");
	const m = month === "this" ? split.thisMonth : (split.lastMonth ?? split.thisMonth);
	const money = (n: number) => formatMoney(n, m.unit);
	const [open, setOpen] = useState<string | null>(null);
	return (
		<Section
			title="Cost by organization"
			description="Each organization's share of the month's emails, sent and received, times what the month came to. SES charges per email, and the rest of the bill grows with it."
			actions={
				split.lastMonth && (
					<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5 text-sm">
						{(["this", "last"] as const).map((k) => (
							<button
								key={k}
								type="button"
								aria-pressed={month === k}
								onClick={() => setMonth(k)}
								className={cn(
									"rounded-[5px] px-2.5 py-1 text-muted-foreground transition-colors hover:text-foreground",
									month === k &&
										"bg-background text-foreground shadow-[0_0_0_1px_var(--border)] dark:bg-white/[0.1]",
								)}
							>
								{monthName(
									k === "this"
										? split.thisMonth.start
										: (split.lastMonth?.start ?? ""),
								)}
							</button>
						))}
					</div>
				)
			}
		>
			<TableCard>
				{m.organizations.length === 0 ? (
					<CardContent className="py-8 text-center text-muted-foreground">
						No email sent or received in {monthName(m.start)} yet.
					</CardContent>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Organization</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Sent
								</TableHead>
								<TableHead className="hidden w-24 text-right sm:table-cell">
									Received
								</TableHead>
								<TableHead className="hidden w-20 text-right md:table-cell">
									Share
								</TableHead>
								<TableHead className="w-24 text-right">Cost</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{m.organizations.map((o) => (
								<Fragment key={o.id}>
									<TableRow
										className={cn(o.brands.length > 0 && "cursor-pointer")}
										onClick={() =>
											o.brands.length > 0 &&
											setOpen(open === o.id ? null : o.id)
										}
									>
										<TableCell className="truncate font-medium">
											{o.name}
											{o.brands.length > 0 && (
												<span className="ml-2 text-xs font-normal text-muted-foreground">
													{o.brands.length}{" "}
													{o.brands.length === 1 ? "brand" : "brands"}{" "}
													{open === o.id ? "▴" : "▾"}
												</span>
											)}
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{o.sent.toLocaleString()}
										</TableCell>
										<TableCell className="hidden text-right tabular-nums sm:table-cell">
											{o.received.toLocaleString()}
										</TableCell>
										<TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
											{(o.share * 100).toFixed(1)}%
										</TableCell>
										<TableCell className="text-right tabular-nums">
											{money(o.amount)}
										</TableCell>
									</TableRow>
									{open === o.id &&
										o.brands.map((b) => (
											<TableRow
												key={b.id}
												className="bg-muted/40"
											>
												<TableCell className="truncate pl-8 text-muted-foreground">
													{b.name}
												</TableCell>
												<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
													{b.sent.toLocaleString()}
												</TableCell>
												<TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
													{b.received.toLocaleString()}
												</TableCell>
												<TableCell className="hidden md:table-cell" />
												<TableCell className="text-right text-muted-foreground tabular-nums">
													{money(b.amount)}
												</TableCell>
											</TableRow>
										))}
								</Fragment>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Section>
	);
}
