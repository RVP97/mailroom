import { Send } from "lucide-react";
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
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
	getDigestFn,
	sendCombinedDigestNowFn,
	sendDigestNowFn,
	setCombineDigestsFn,
	setDigestFn,
} from "@/functions/digest";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";

/** The weekly digest (src/server/digest.ts): per-org switch, optional multi-org combine, and send now. */
export function DigestCard({ canManage }: { canManage: boolean }) {
	const me = useMe();
	const multiOrg = me.organizations.length > 1 || me.isAdmin;
	const [on, setOn] = useState<boolean | null>(null);
	const [combine, setCombine] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [combineBusy, setCombineBusy] = useState(false);
	const [sending, setSending] = useState<"org" | "combined" | null>(null);
	useEffect(() => {
		getDigestFn()
			.then((d) => {
				setOn(d.on);
				setCombine(d.combine);
			})
			.catch(() => {});
	}, []);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Weekly digest</CardTitle>
				<CardDescription>
					Every Monday morning the owners and admins get last week in one email: what was
					sent and how it did against the week before, how long emails took to arrive, and
					anything that needs a look (blocklists, DNS, paused domains, a template that
					bounces).
				</CardDescription>
				<CardAction>
					<Switch
						checked={on ?? true}
						disabled={!canManage || busy || on === null}
						aria-label="Send the weekly digest"
						onCheckedChange={async (v) => {
							setBusy(true);
							try {
								await setDigestFn({ data: { on: v } });
								setOn(v);
								toast.success(v ? "Weekly digest on" : "Weekly digest off");
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(false);
							}
						}}
					/>
				</CardAction>
			</CardHeader>
			{multiOrg && (
				<div className="flex items-start justify-between gap-4 border-t border-border/70 px-5 py-4">
					<div className="min-w-0">
						<p className="text-sm font-medium">Combine across organizations</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							Put every organization's Monday report into one email instead of sending
							a separate email for each. Applies to your account.
						</p>
					</div>
					<Switch
						checked={combine ?? false}
						disabled={combineBusy || combine === null}
						aria-label="Combine weekly digests across organizations"
						onCheckedChange={async (v) => {
							setCombineBusy(true);
							try {
								await setCombineDigestsFn({ data: { combine: v } });
								setCombine(v);
								toast.success(
									v
										? "Weekly digests will arrive in one email"
										: "Weekly digests will arrive separately per organization",
								);
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setCombineBusy(false);
							}
						}}
					/>
				</div>
			)}
			<CardContent className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={sending !== null}
					onClick={async () => {
						setSending("org");
						try {
							const r = await sendDigestNowFn();
							if (r.sent) toast.success(`Sent last week's digest to ${r.to}`);
							else toast.info("Nothing was sent last week, so there's no digest yet");
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setSending(null);
						}
					}}
				>
					{sending === "org" ? <Spinner /> : <Send />}
					Send me last week's
				</Button>
				{multiOrg && (
					<Button
						variant="outline"
						size="sm"
						disabled={sending !== null}
						onClick={async () => {
							setSending("combined");
							try {
								const r = await sendCombinedDigestNowFn();
								if (r.sent)
									toast.success(
										`Sent combined digest (${r.count} ${r.count === 1 ? "organization" : "organizations"}) to ${r.to}`,
									);
								else
									toast.info(
										"Nothing was sent last week across your organizations",
									);
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setSending(null);
							}
						}}
					>
						{sending === "combined" ? <Spinner /> : <Send />}
						Send combined digest
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
