import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
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
import {
	postmasterConnectFn,
	postmasterDisconnectFn,
	postmasterStatusFn,
	postmasterSyncFn,
} from "@/functions/postmaster";
import { errorMessage } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";

type Status = Awaited<ReturnType<typeof postmasterStatusFn>>;

/**
 * Gmail Postmaster Tools (src/server/postmaster.ts): connect the Google account whose Postmaster
 * Tools Mailroom registers the sending domains with and reads Gmail's numbers from.
 */
export function PostmasterCard() {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	useEffect(() => {
		postmasterStatusFn()
			.then(setStatus)
			.catch(() => {});
	}, []);
	const run = async (what: string, fn: () => Promise<unknown>) => {
		setBusy(what);
		try {
			await fn();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Gmail Postmaster Tools</CardTitle>
				<CardDescription>
					Gmail doesn't tell SES when people mark email as spam, so Gmail's spam rate is
					only in Google's Postmaster Tools. Connect a Google account and Mailroom adds
					every verified sending domain to it, shows the TXT record Google checks on each
					domain's page, and brings Gmail's spam rate, authentication, TLS and bulk-sender
					compliance into <Link to="/insights">Insights</Link> every 6 hours.
				</CardDescription>
				{status?.connected && (
					<CardAction>
						<Button
							variant="outline"
							size="sm"
							disabled={!!busy}
							onClick={() =>
								run("sync", async () => {
									setStatus(await postmasterSyncFn({ data: {} }));
									toast.success("Domains registered and read");
								})
							}
						>
							{busy === "sync" ? <Spinner /> : <RefreshCw />}
							Check now
						</Button>
					</CardAction>
				)}
			</CardHeader>
			<CardContent className="flex flex-wrap items-center gap-3 text-sm">
				{!status ? (
					<Spinner />
				) : !status.configured ? (
					<p className="text-muted-foreground">
						Needs a Google OAuth client: in Google Cloud, enable the Gmail Postmaster
						Tools API, make an OAuth client (Web application) with the redirect URI{" "}
						<code className="font-mono text-xs">
							{typeof window === "undefined" ? "" : window.location.origin}
							/postmaster/callback
						</code>
						, and set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.
					</p>
				) : status.connected ? (
					<>
						<span>
							Connected as{" "}
							<span className="font-medium">{status.account || "Google"}</span>
							{status.connectedAt && (
								<span className="text-muted-foreground">
									{" "}
									since {formatDateTime(status.connectedAt)}
								</span>
							)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							disabled={!!busy}
							onClick={() =>
								run("disconnect", async () =>
									setStatus(await postmasterDisconnectFn({ data: {} })),
								)
							}
						>
							Disconnect
						</Button>
					</>
				) : (
					<Button
						disabled={!!busy}
						onClick={() =>
							run("connect", async () => {
								const { url } = await postmasterConnectFn({ data: {} });
								window.location.href = url;
							})
						}
					>
						{busy === "connect" && <Spinner />}
						Connect Google
					</Button>
				)}
			</CardContent>
		</Card>
	);
}
