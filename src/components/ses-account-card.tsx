import {
	ArrowRightLeft,
	CheckCircle2,
	CircleDashed,
	Cloud,
	KeyRound,
	RotateCw,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatMoney } from "@/components/aws-costs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import { Spinner } from "@/components/ui/spinner";
import {
	connectOwnSesAccountFn,
	disconnectOwnSesAccountFn,
	ownSesAccountFn,
	ownSesCostsFn,
	ownSesMoveFn,
} from "@/functions/ses-account";
import { errorMessage } from "@/lib/errors";

type Data = Awaited<ReturnType<typeof ownSesAccountFn>>;

const when = (iso: string | null) =>
	iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";

/**
 * Settings › Amazon SES account (src/server/org-aws.ts): the organization sends through the
 * deployment's account, or, optionally, its own. Admins connect, replace or remove it.
 */
export function SesAccountCard() {
	const [data, setData] = useState<Data | null>(null);
	const [failed, setFailed] = useState(false);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		ownSesAccountFn({ data: {} })
			.then(setData)
			.catch(() => setFailed(true));
	}, []);
	if (failed)
		return (
			<Card>
				<CardHeader>
					<CardTitle>Amazon SES account</CardTitle>
					<CardDescription>The account couldn't be read.</CardDescription>
				</CardHeader>
			</Card>
		);
	if (!data) return null;
	const moving = !!data.move;
	// SMTP credentials are IAM users in the account: they can't move with it.
	const bound = data.smtp > 0;
	const domainsText = `${data.domains} ${data.domains === 1 ? "domain" : "domains"}`;
	const footerNote = moving
		? "Finish or cancel the move before changing the account again."
		: bound
			? "Its SMTP credentials live in this account: delete them first to change accounts."
			: data.domains
				? data.domains === 1
					? "Changing accounts moves its domain: it keeps sending here until it's verified in the other one."
					: `Changing accounts moves its ${domainsText}: they keep sending here until they're verified in the other one.`
				: "Brands, domains and SMTP credentials are made in whichever account it uses.";
	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center gap-2">
					Amazon SES account
					{data.connected ? (
						<Badge variant="brand">
							<Cloud />
							Own account
						</Badge>
					) : (
						<Badge variant="secondary">Deployment's account</Badge>
					)}
				</CardTitle>
				<CardDescription>
					{data.connected ? (
						<>
							This organization sends through its own Amazon SES account. Its brands'
							domains, sending reputation, quota and bill are there, apart from the
							rest of this deployment.
						</>
					) : (
						<>
							This organization sends through this deployment's Amazon SES account (
							{data.defaultRegion}), like the others. Optionally, give it its own, so
							its bounces and complaints never count against the others' account and
							its sending is billed to it.
						</>
					)}
				</CardDescription>
			</CardHeader>
			{data.credentialsError && (
				<CardContent>
					<Alert variant="destructive">
						<TriangleAlert />
						<AlertTitle>AWS is refusing this account's keys</AlertTitle>
						<AlertDescription>
							Since {when(data.credentialsError.at)}:{" "}
							{data.credentialsError.message.replace(/\.$/, "")}. Its emails are
							waiting, not failed, and go out by themselves once the keys work again
							(for up to 3 days).
							{data.connected && data.canEdit ? " Replace the keys below." : ""}
						</AlertDescription>
					</Alert>
				</CardContent>
			)}
			{data.connected && (
				<CardContent>
					<dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
						<dt className="text-muted-foreground">Account</dt>
						<dd className="font-mono">
							{data.accountId} · {data.region}
						</dd>
						<dt className="text-muted-foreground">Access key</dt>
						<dd className="font-mono">{data.accessKey}</dd>
						<dt className="text-muted-foreground">SES</dt>
						<dd>
							{data.error ? (
								<span className="text-destructive">{data.error}</span>
							) : data.ses ? (
								<>
									{data.ses.ProductionAccessEnabled
										? "Production access"
										: "In the SES sandbox (only verified addresses)"}
									{data.ses.SendingEnabled === false ? " · sending paused" : ""}
									{data.ses.SendQuota?.Max24HourSend != null &&
										` · ${data.ses.SendQuota.Max24HourSend.toLocaleString()} a day, ${data.ses.SendQuota.MaxSendRate ?? "?"} a second`}
								</>
							) : (
								"—"
							)}
						</dd>
						<dt className="text-muted-foreground">Events</dt>
						<dd className="flex items-center gap-1.5">
							{data.subscriptionConfirmedAt ? (
								<>
									<CheckCircle2 className="size-4 text-brand" />
									Subscribed
									{data.lastEventAt ? `, last one ${when(data.lastEventAt)}` : ""}
								</>
							) : (
								<>
									<CircleDashed className="size-4 text-muted-foreground" />
									Waiting for SNS to confirm the subscription
								</>
							)}
						</dd>
						<dt className="text-muted-foreground">Pace</dt>
						<dd>
							{data.maxSendRate
								? `Up to ${data.maxSendRate.toLocaleString()} emails a second, apart from the deployment's account`
								: "1 email a second until SES's rate is read"}
						</dd>
						<dt className="text-muted-foreground">Receiving</dt>
						<dd>
							{data.receivingSetUp
								? "Its domains receive in this account (its own S3 drop box and rule set)"
								: "Set up in this account the first time one of its domains turns receiving on"}
						</dd>
					</dl>
				</CardContent>
			)}
			{data.move && (
				<MovePanel
					move={data.move}
					canEdit={data.canEdit}
					onChange={setData}
				/>
			)}
			{data.connected && data.canEdit && <Costs />}
			{editing && data.canEdit ? (
				<ConnectForm
					data={data}
					onDone={(next) => {
						setData(next);
						setEditing(false);
					}}
					onCancel={() => setEditing(false)}
				/>
			) : data.canEdit ? (
				<CardFooter className="flex-wrap gap-2">
					<span className="mr-auto text-muted-foreground text-xs">{footerNote}</span>
					{data.connected && (
						<Disconnect
							disabled={bound || moving}
							domains={data.domains}
							onDone={setData}
						/>
					)}
					<Button
						size="sm"
						variant={data.connected ? "outline" : "default"}
						disabled={!data.connected && (bound || moving)}
						onClick={() => setEditing(true)}
					>
						<KeyRound />
						{data.connected ? "Replace keys" : "Use its own account"}
					</Button>
				</CardFooter>
			) : (
				<CardFooter>
					<span className="text-muted-foreground text-xs">
						This deployment's admins choose the account.
					</span>
				</CardFooter>
			)}
		</Card>
	);
}

function ConnectForm({
	data,
	onDone,
	onCancel,
}: {
	data: Data;
	onDone: (d: Data) => void;
	onCancel: () => void;
}) {
	const [accessKeyId, setKey] = useState("");
	const [secretAccessKey, setSecret] = useState("");
	const [region, setRegion] = useState(data.region ?? data.defaultRegion);
	const [busy, setBusy] = useState(false);
	return (
		<form
			onSubmit={async (e) => {
				e.preventDefault();
				setBusy(true);
				try {
					const next = await connectOwnSesAccountFn({
						data: { accessKeyId, secretAccessKey, region },
					});
					toast.success(
						next.move
							? "Move started: its domains need their new DNS records"
							: data.connected
								? "Keys replaced"
								: "Connected: its brands now send there",
					);
					onDone(next);
				} catch (error) {
					toast.error(await errorMessage(error));
				} finally {
					setBusy(false);
				}
			}}
		>
			<CardContent className="flex flex-col gap-4 border-t pt-4">
				<p className="text-muted-foreground text-sm">
					An IAM user's access key in the other AWS account, with the same policy as
					Mailroom's own user (see the README, "An organization's own SES account").
					Mailroom checks it, makes the events topic there and subscribes{" "}
					<code className="font-mono text-xs">{data.endpoint}</code> to it. The secret is
					kept encrypted.
					{data.domains > 0 &&
						` Keys for a different account start a move: its ${data.domains === 1 ? "domain is" : "domains are"} added there and keep sending here until each is verified there.`}
				</p>
				<div className="grid gap-4 sm:grid-cols-[1fr_1fr_10rem]">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ses-key">Access key ID</Label>
						<Input
							id="ses-key"
							value={accessKeyId}
							autoComplete="off"
							spellCheck={false}
							placeholder="AKIA…"
							className="font-mono"
							onChange={(e) => setKey(e.target.value)}
							required
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ses-secret">Secret access key</Label>
						<Input
							id="ses-secret"
							type="password"
							value={secretAccessKey}
							autoComplete="new-password"
							className="font-mono"
							onChange={(e) => setSecret(e.target.value)}
							required
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="ses-region">Region</Label>
						<Input
							id="ses-region"
							value={region}
							spellCheck={false}
							className="font-mono"
							onChange={(e) => setRegion(e.target.value)}
							required
						/>
					</div>
				</div>
			</CardContent>
			<CardFooter className="justify-end gap-2 pt-4">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onCancel}
					disabled={busy}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					size="sm"
					disabled={busy || !accessKeyId || !secretAccessKey || !region}
				>
					{busy && <Spinner />}
					{data.connected ? "Replace keys" : "Check and connect"}
				</Button>
			</CardFooter>
		</form>
	);
}

function Disconnect({
	disabled,
	domains,
	onDone,
}: {
	disabled: boolean;
	domains: number;
	onDone: (d: Data) => void;
}) {
	const [busy, setBusy] = useState(false);
	return (
		<AlertDialog>
			<AlertDialogTrigger asChild>
				<Button
					size="sm"
					variant="ghost"
					disabled={disabled}
				>
					Use the deployment's account
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Go back to the deployment's account?</AlertDialogTitle>
					<AlertDialogDescription>
						{domains > 0
							? `Its ${domains === 1 ? "domain is" : `${domains} domains are`} added to this deployment's account and keep sending from the organization's own until each is verified here (new DKIM records, shown on each domain's page). Then the move finishes by itself and its keys are forgotten.`
							: "Its brands get their tenants in this deployment's account again. What Mailroom made in the organization's account (its events topic, tenants and configuration sets) stays there, unused, and its keys are forgotten."}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								const next = await disconnectOwnSesAccountFn();
								onDone(next);
								toast.success(
									next.move
										? "Move started: its domains need their new DNS records"
										: "It sends through the deployment's account again",
								);
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					>
						Go back
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** A move between accounts: its domains, each verified in the account it's going to or not. */
function MovePanel({
	move,
	canEdit,
	onChange,
}: {
	move: NonNullable<Data["move"]>;
	canEdit: boolean;
	onChange: (d: Data) => void;
}) {
	const [busy, setBusy] = useState<"check" | "cancel" | null>(null);
	const done = move.domains.filter((d) => d.verified).length;
	const target = move.to
		? `its own account ${move.to.accountId} · ${move.to.region}`
		: "this deployment's account";
	const act = async (action: "check" | "cancel") => {
		setBusy(action);
		try {
			const next = await ownSesMoveFn({ data: { action } });
			onChange(next);
			if (action === "cancel") toast.success("Move cancelled: it stays where it was");
			else if (!next.move) toast.success("Move finished: it sends from the new account");
			else toast.message("Not all domains are verified there yet");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<CardContent>
			<div className="rounded-lg border p-4">
				<p className="flex items-center gap-2 font-medium text-sm">
					<ArrowRightLeft className="size-4 text-brand" />
					Moving to {target}
				</p>
				<p className="mt-1 text-muted-foreground text-sm">
					Started {when(move.startedAt)}. Its emails keep going out from the current
					account until every domain is verified in the new one; each domain's page shows
					the DKIM records to add for it. Mailroom checks every 5 minutes and finishes by
					itself.
				</p>
				{move.error && <p className="mt-2 text-destructive text-sm">{move.error}</p>}
				<ul className="mt-3 flex flex-col gap-1.5 text-sm">
					{move.domains.map((d) => (
						<li
							key={d.id}
							className="flex items-center gap-2"
						>
							{d.verified ? (
								<CheckCircle2 className="size-4 text-brand" />
							) : (
								<CircleDashed className="size-4 text-muted-foreground" />
							)}
							<span className="font-mono">{d.name}</span>
							<span className="text-muted-foreground">
								{d.verified ? "verified there" : "waiting for its DNS records"}
							</span>
						</li>
					))}
				</ul>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<span className="mr-auto text-muted-foreground text-xs">
						{done} of {move.domains.length} verified
					</span>
					{canEdit && (
						<>
							<Button
								size="sm"
								variant="ghost"
								disabled={!!busy}
								onClick={() => act("cancel")}
							>
								{busy === "cancel" && <Spinner />}
								Cancel move
							</Button>
							<Button
								size="sm"
								variant="outline"
								disabled={!!busy}
								onClick={() => act("check")}
							>
								{busy === "check" ? <Spinner /> : <RotateCw />}
								Check now
							</Button>
						</>
					)}
				</div>
			</div>
		</CardContent>
	);
}

type Costs = Awaited<ReturnType<typeof ownSesCostsFn>>;

/** What AWS charges the organization's own account (Cost Explorer, kept a day). */
function Costs() {
	const [costs, setCosts] = useState<Costs | undefined>(undefined);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		ownSesCostsFn({ data: {} })
			.then(setCosts)
			.catch(() => setCosts(null));
	}, []);
	if (costs === undefined) return null;
	const money = (n: number) => formatMoney(n, costs?.unit);
	return (
		<CardContent>
			<div className="rounded-lg border p-4">
				<div className="flex flex-wrap items-center gap-2">
					<p className="mr-auto font-medium text-sm">Its AWS costs</p>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								setCosts(await ownSesCostsFn({ data: { force: true } }));
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
				{!costs ? (
					<p className="text-muted-foreground text-sm">The costs couldn't be read.</p>
				) : costs.error && !costs.thisMonth ? (
					<p className="text-muted-foreground text-sm">
						{costs.error}
						{/not authorized|AccessDenied/i.test(costs.error) &&
							" Its IAM user needs the MailroomCosts policy (see the README)."}
					</p>
				) : (
					<dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
						<dt className="text-muted-foreground">This month</dt>
						<dd className="tabular-nums">
							{costs.thisMonth ? money(costs.thisMonth.total) : "—"}
							{costs.forecast != null &&
								` · about ${money(costs.forecast)} by its end`}
						</dd>
						<dt className="text-muted-foreground">Last month</dt>
						<dd className="tabular-nums">
							{costs.lastMonth ? money(costs.lastMonth.total) : "—"}
						</dd>
						<dt className="text-muted-foreground">Updated</dt>
						<dd>{when(costs.fetchedAt)} (each update costs AWS $0.02)</dd>
					</dl>
				)}
			</div>
		</CardContent>
	);
}
