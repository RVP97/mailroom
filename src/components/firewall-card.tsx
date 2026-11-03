import { Link, useRouter } from "@tanstack/react-router";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { testFirewallFn, updateFirewallFn } from "@/functions/recipients";
import { errorMessage } from "@/lib/errors";
import { formatNumber, formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { patch, useOptimisticState } from "@/lib/optimistic";
import { Ph } from "@/lib/sketch";

export interface Firewall {
	block_disposable: boolean;
	block_free: boolean;
	block_plus: boolean;
	never: string[];
	always: string[];
	updated_at: string | null;
	/** Emails it left a recipient out of in the last 30 days, by rule. */
	blocked?: { total: number; never: number; disposable: number; free: number; plus: number };
}

type Check = "block_disposable" | "block_free" | "block_plus";

const CHECKS: {
	key: Check;
	rule: "disposable" | "plus" | "free";
	title: string;
	description: string;
}[] = [
	{
		key: "block_disposable",
		rule: "disposable",
		title: "Disposable addresses",
		description:
			"Throwaway inboxes like mailinator.com or 10minutemail.com. The list (about 5,000 domains) is refreshed daily.",
	},
	{
		key: "block_plus",
		rule: "plus",
		title: "Plus addresses",
		description:
			"ana+promo@gmail.com and the like. Real people use them too: turn this on only if sign-ups abuse them.",
	},
	{
		key: "block_free",
		rule: "free",
		title: "Free inboxes",
		description:
			"Gmail, Outlook, Yahoo, iCloud and other free providers. For business-only mail, like invoices to companies.",
	},
];

const lines = (v: string) =>
	v
		.split(/[\n,]/)
		.map((x) => x.trim())
		.filter(Boolean);

/**
 * A brand's email firewall: each check on its own switch (all off until turned on),
 * and two lists. «Always allow» wins over everything; a blocked recipient is left out of the
 * email with the rule that did it, like a suppressed one.
 */
export function FirewallCard({
	brand,
	firewall: saved,
	canManage,
	description = "Checks every recipient of this brand before an email is sent. Each check is optional. Blocked recipients are left out and the email shows which rule did it.",
}: {
	brand: string;
	firewall: Firewall;
	canManage: boolean;
	description?: string;
}) {
	const router = useRouter();
	// The switches move at once; a failed save puts them back.
	const [firewall, save] = useOptimisticState(saved, patch<Firewall>);
	const [never, setNever] = useState(firewall.never.join("\n"));
	const [always, setAlways] = useState(firewall.always.join("\n"));
	const [busy, setBusy] = useState(false);
	const listsChanged =
		lines(never).join("\n") !== firewall.never.join("\n") ||
		lines(always).join("\n") !== firewall.always.join("\n");

	const turn = (key: Check, on: boolean) =>
		save({ [key]: on }, () => updateFirewallFn({ data: { brand, [key]: on } }));
	const toggle = async (key: Check, on: boolean) => {
		if (!(await turn(key, on))) return;
		const title = CHECKS.find((c) => c.key === key)?.title ?? "Check";
		toast.success(on ? `${title}: blocked` : `${title}: allowed`, {
			action: { label: "Undo", onClick: () => void turn(key, !on) },
		});
	};

	return (
		<Card id="firewall">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					Email firewall
					<StatusBadge
						status={
							firewall.block_disposable ||
							firewall.block_free ||
							firewall.block_plus ||
							firewall.never.length
								? "ready"
								: "canceled"
						}
						label={
							firewall.block_disposable ||
							firewall.block_free ||
							firewall.block_plus ||
							firewall.never.length
								? "On"
								: "Off"
						}
					/>
				</CardTitle>
				<CardDescription>{description}</CardDescription>
				{saved.blocked && saved.blocked.total > 0 && (
					<Link
						to="/emails"
						search={{ status: "firewall", brand, days: 30 }}
						className="group mt-1 flex w-fit items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline"
					>
						<ShieldCheck className="size-4 text-success" />
						Blocked recipients on {formatNumber(saved.blocked.total)}{" "}
						{saved.blocked.total === 1 ? "email" : "emails"} in the last 30 days
						<ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
					</Link>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-5">
				<ul className="flex flex-col divide-y divide-border/70 rounded-lg shadow-[0_0_0_1px_var(--border)]">
					{CHECKS.map((c) => (
						<li
							key={c.key}
							className="flex items-start gap-4 px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<label
									htmlFor={`fw-${c.key}`}
									className="text-sm font-medium"
								>
									Block {c.title.toLowerCase()}
								</label>
								<p className="mt-0.5 text-sm text-muted-foreground text-pretty">
									{c.description}
								</p>
								<Blocked
									brand={brand}
									count={saved.blocked?.[c.rule]}
								/>
							</div>
							<Switch
								id={`fw-${c.key}`}
								className="mt-0.5"
								checked={firewall[c.key]}
								disabled={!canManage}
								onCheckedChange={(on) => toggle(c.key, on)}
							/>
						</li>
					))}
				</ul>
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="fw-never">Never send to</FieldLabel>
						<Textarea
							id="fw-never"
							rows={4}
							spellCheck={false}
							disabled={!canManage}
							placeholder={"competitor.com\n.ru\nold-list@example.com"}
							className="font-mono text-xs"
							value={never}
							onChange={(e) => setNever(e.target.value)}
						/>
						<FieldDescription>
							One a line: a domain (its subdomains too), an ending like .ru, or an
							address.
						</FieldDescription>
						<Blocked
							brand={brand}
							count={saved.blocked?.never}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="fw-always">Always allow</FieldLabel>
						<Textarea
							id="fw-always"
							rows={4}
							spellCheck={false}
							disabled={!canManage}
							placeholder={"yourcompany.com\nqa+tests@gmail.com"}
							className="font-mono text-xs"
							value={always}
							onChange={(e) => setAlways(e.target.value)}
						/>
						<FieldDescription>
							Passes every check, even «Never send to». For your team and test
							inboxes.
						</FieldDescription>
					</Field>
				</div>
				<TryAddress brand={brand} />
			</CardContent>
			{canManage && (
				<CardFooter>
					<span className="mr-auto text-xs">
						{firewall.updated_at
							? `Changed ${formatRelative(firewall.updated_at)}`
							: "Nothing is blocked until you turn a check on."}
					</span>
					<Button
						size="sm"
						disabled={busy || !listsChanged}
						onClick={async () => {
							setBusy(true);
							try {
								const saved = await updateFirewallFn({
									data: { brand, never: lines(never), always: lines(always) },
								});
								setNever(saved.never.join("\n"));
								setAlways(saved.always.join("\n"));
								toast.success("Lists saved");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						{busy && <Spinner />}
						Save lists
					</Button>
				</CardFooter>
			)}
		</Card>
	);
}

/** "Blocked 4 emails in 30 days", linking to them; nothing when the rule blocked none. */
function Blocked({ brand, count }: { brand: string; count: number | undefined }) {
	if (!count) return null;
	return (
		<Link
			to="/emails"
			search={{ status: "firewall", brand, days: 30 }}
			className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums underline-offset-4 hover:text-foreground hover:underline"
		>
			Blocked recipients on {formatNumber(count)} {count === 1 ? "email" : "emails"} in the
			last 30 days
			<ChevronRight className="size-3" />
		</Link>
	);
}

/** What the firewall would do with an address, without sending anything. */
function TryAddress({ brand }: { brand: string }) {
	const [address, setAddress] = useState("");
	const [result, setResult] = useState<{
		address: string;
		blocked: boolean;
		reason: string | null;
	} | null>(null);
	const [busy, setBusy] = useState(false);
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				try {
					setResult(await testFirewallFn({ data: { brand, address } }));
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			<div className="flex gap-2">
				<Input
					type="email"
					required
					aria-label="Try an address"
					placeholder="Try an address: someone@mailinator.com"
					value={address}
					onChange={(e) => {
						setAddress(e.target.value);
						setResult(null);
					}}
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={busy || !address.trim()}
				>
					{busy ? <Spinner /> : <ShieldCheck />}
					Check
				</Button>
			</div>
			{result && (
				<p
					role="status"
					className="text-sm text-muted-foreground"
				>
					{result.blocked ? (
						<>
							<span className="font-medium text-destructive">Blocked</span>:{" "}
							{result.reason}.
						</>
					) : (
						<>
							<span className="font-medium text-success">Allowed</span>: the firewall
							lets {result.address} through (suppressions still apply).
						</>
					)}
				</p>
			)}
		</form>
	);
}

/** Settings with several brands: each brand's firewall at a glance, set on the brand's page. */
export function FirewallsOverview({
	firewalls,
}: {
	firewalls: (Firewall & { brand_id: string; on: boolean })[];
}) {
	const me = useMe();
	const name = new Map(me.brands.map((b) => [b.id, b.name]));
	const summary = (f: Firewall) => {
		const parts = CHECKS.filter((c) => f[c.key]).map((c) => c.title.toLowerCase());
		if (f.never.length) parts.push(`${f.never.length} never send to`);
		const blocked = f.blocked?.total
			? ` · ${formatNumber(f.blocked.total)} ${f.blocked.total === 1 ? "email" : "emails"} in 30 days`
			: "";
		return parts.length ? `Blocks ${parts.join(", ")}${blocked}` : "Nothing blocked";
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Email firewall</CardTitle>
				<CardDescription>
					Each brand has its own, so a newsletter can refuse throwaway addresses while
					receipts still reach everyone. Set it on the brand's page.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<ul className="flex flex-col divide-y divide-border/70 rounded-lg shadow-[0_0_0_1px_var(--border)]">
					{firewalls.map((f) => (
						<li
							key={f.brand_id}
							className="relative"
						>
							<Link
								to="/brands/$id"
								params={{ id: f.brand_id }}
								hash="firewall"
								className="flex items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium">
										<Ph>{name.get(f.brand_id) ?? "Brand"}</Ph>
									</p>
									<p className="truncate text-sm text-muted-foreground">
										<Ph>{summary(f)}</Ph>
									</p>
								</div>
								<StatusBadge
									status={f.on ? "ready" : "canceled"}
									label={f.on ? "On" : "Off"}
								/>
								<ChevronRight className="size-4 text-muted-foreground" />
							</Link>
						</li>
					))}
				</ul>
			</CardContent>
		</Card>
	);
}
