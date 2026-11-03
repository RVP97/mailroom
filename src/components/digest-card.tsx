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
import { getDigestFn, sendDigestNowFn, setDigestFn } from "@/functions/digest";
import { errorMessage } from "@/lib/errors";

/** The weekly digest (src/server/digest.ts): a switch, and a copy now to whoever asks. */
export function DigestCard({ canManage }: { canManage: boolean }) {
	const [on, setOn] = useState<boolean | null>(null);
	const [busy, setBusy] = useState(false);
	const [sending, setSending] = useState(false);
	useEffect(() => {
		getDigestFn()
			.then((d) => setOn(d.on))
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
			<CardContent>
				<Button
					variant="outline"
					size="sm"
					disabled={sending}
					onClick={async () => {
						setSending(true);
						try {
							const r = await sendDigestNowFn();
							if (r.sent) toast.success(`Sent last week's digest to ${r.to}`);
							else toast.info("Nothing was sent last week, so there's no digest yet");
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setSending(false);
						}
					}}
				>
					{sending ? <Spinner /> : <Send />}
					Send me last week's
				</Button>
			</CardContent>
		</Card>
	);
}
