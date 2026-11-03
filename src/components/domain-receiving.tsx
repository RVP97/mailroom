import { Link, useRouter } from "@tanstack/react-router";
import { Inbox, Send } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { StatusBadge } from "@/components/status-badge";
import { Switch } from "@/components/ui/switch";
import { setDomainReceivingFn, updateDomainFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";

/**
 * What a domain is for: sending from it, receiving at it, or both. Receiving takes every email
 * sent to the domain through SES and shows it on the Received page and to webhooks, so its MX
 * must point at SES: to keep a domain's own mailboxes (Google Workspace, Outlook…), add a
 * subdomain such as reply.<domain> as its own domain and receive there. One of the two stays on:
 * a domain for neither is removed instead.
 */
export function DomainReceiving({
	domain: d,
	canManage,
}: {
	domain: {
		id: string;
		name: string;
		sending: boolean;
		receiving: boolean;
		receiving_status: string | null;
		receiving_host: string | null;
	};
	canManage: boolean;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [sending, setSending] = useState(d.sending);
	const [on, setOn] = useState(d.receiving);
	const [taken, setTaken] = useState<string | null>(null);
	const host = d.receiving_host ?? d.name;

	async function saveSending(value: boolean) {
		setBusy(true);
		setSending(value);
		try {
			await updateDomainFn({ data: { id: d.id, sending: value } });
			toast.success(
				value
					? `${d.name} can send: add the new records above`
					: `${d.name} only receives now`,
			);
			await router.invalidate();
		} catch (error) {
			setSending(d.sending);
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	}

	async function save(value: boolean, replaceMx = false) {
		setBusy(true);
		setOn(value);
		try {
			await setDomainReceivingFn({ data: { id: d.id, on: value, replaceMx, prefix: "" } });
			toast.success(
				value ? `Receiving at ${d.name}: add the MX record above` : "Receiving off",
			);
			await router.invalidate();
		} catch (error) {
			setOn(d.receiving);
			const message = await errorMessage(error);
			if (/already receives email/.test(message)) setTaken(message);
			else toast.error(message);
		} finally {
			setBusy(false);
		}
	}

	const active = d.receiving_status === "active";
	return (
		<section className="flex flex-col gap-3">
			<h2 className="text-[11px] font-medium tracking-[0.07em] text-faint uppercase">
				Used for
			</h2>
			<div className="overflow-hidden rounded-xl bg-card shadow-card">
				<Row
					icon={<Send className="size-4" />}
					title={`Send from ${d.name}`}
					description={
						sending
							? `Emails from any address at ${d.name}, signed with its DKIM keys.`
							: `Turn on to send from ${d.name} too: Mailroom adds the DKIM, bounce and SPF records.`
					}
					control={
						<Switch
							checked={sending}
							disabled={!canManage || busy || (sending && !on)}
							onCheckedChange={(v) => saveSending(v)}
							aria-label="Sending"
						/>
					}
				/>
				<Row
					border
					icon={<Inbox className="size-4" />}
					title={
						<>
							Receive email at {host}
							{d.receiving && (
								<StatusBadge
									status={active ? "verified" : "pending"}
									label={active ? "Active" : "Waiting for the MX"}
								/>
							)}
						</>
					}
					description={
						d.receiving ? (
							active ? (
								<>
									Every email to an address at {host} shows in{" "}
									<Link
										to="/received"
										className="underline underline-offset-2 hover:text-foreground"
									>
										Received
									</Link>{" "}
									and goes to your webhooks as email.received.
								</>
							) : (
								`Add the Receiving record above (MX ${host} → SES). Mail arrives as soon as DNS has it.`
							)
						) : (
							`Replies and anything else sent to ${d.name} come to Mailroom, checked for spam and viruses. To keep ${d.name}'s own mailboxes, add a subdomain like reply.${d.name} as its own domain instead.`
						)
					}
					control={
						<Switch
							checked={on}
							disabled={!canManage || busy || (on && !sending)}
							onCheckedChange={(v) => save(v)}
							aria-label="Receiving"
						/>
					}
				/>
			</div>
			{!(sending && on) && canManage && (
				<p className="text-xs text-muted-foreground text-pretty">
					A domain is for sending, receiving or both. To stop using it for{" "}
					{sending ? "sending" : "receiving"}, remove it instead.
				</p>
			)}
			<Confirm
				open={taken !== null}
				onOpenChange={(v) => !v && setTaken(null)}
				title={`Take ${d.name}'s email?`}
				description={taken ?? ""}
				action="Receive here instead"
				cancel="Keep its mailbox"
				onConfirm={async () => {
					setTaken(null);
					await save(true, true);
				}}
			/>
		</section>
	);
}

function Row({
	icon,
	title,
	description,
	control,
	border,
}: {
	icon: ReactNode;
	title: ReactNode;
	description: ReactNode;
	control: ReactNode;
	border?: boolean;
}) {
	return (
		<div
			className={`flex items-start gap-3 px-5 py-4 ${border ? "border-t border-border/70" : ""}`}
		>
			<span className="mt-0.5 text-muted-foreground">{icon}</span>
			<span className="min-w-0 flex-1">
				<span className="flex flex-wrap items-center gap-2 text-sm font-semibold [overflow-wrap:anywhere]">
					{title}
				</span>
				<span className="mt-1 block text-sm text-muted-foreground text-pretty">
					{description}
				</span>
			</span>
			{control}
		</div>
	);
}
