import { useRouter } from "@tanstack/react-router";
import { AtSign } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { setInboundAddressFn } from "@/functions/received";
import { errorMessage } from "@/lib/errors";
import type { InboundAddresses } from "@/server/inbound";

type Addresses = InboundAddresses;

/** The brand's own inbound address on one of its receiving domains, or the default one. */
export function InboundAddress({ brand, addresses }: { brand: string; addresses: Addresses }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [local, setLocal] = useState("");
	const [host, setHost] = useState("");
	const [busy, setBusy] = useState(false);
	const start = () => {
		const [l = "inbox", h = ""] = (addresses.picked ?? "").split("@");
		setLocal(addresses.picked ? l : "inbox");
		setHost(addresses.hosts.some((x) => x.host === h) ? h : (addresses.hosts[0]?.host ?? ""));
		setOpen(true);
	};
	const save = async (address: string | null) => {
		setBusy(true);
		try {
			await setInboundAddressFn({ data: { brand, address } });
			toast.success(
				address ? `Its address is now ${address}` : "Back to the default address",
			);
			setOpen(false);
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Button
				size="sm"
				variant="outline"
				className="mt-1"
				onClick={start}
			>
				<AtSign />
				{addresses.picked ? "Change address" : "Use your own domain"}
			</Button>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>The brand's inbound address</DialogTitle>
						<DialogDescription>
							Shown instead of the default address, on one of the brand's domains that
							receive.
							{addresses.fallback
								? ` ${addresses.fallback} keeps working either way.`
								: ""}
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						{addresses.hosts.length === 0 ? (
							<p className="text-muted-foreground text-sm">
								None of the brand's domains receive yet. Open a domain's page and
								turn receiving on (reply.yourdomain.com by default, with its MX
								record), then come back to pick an address there.
							</p>
						) : (
							<form
								id="inbound-address"
								className="flex flex-col gap-4"
								onSubmit={(e) => {
									e.preventDefault();
									save(`${local.trim()}@${host}`);
								}}
							>
								<Field>
									<FieldLabel htmlFor="inbound-local">Address</FieldLabel>
									<div className="flex items-center gap-2">
										<Input
											id="inbound-local"
											value={local}
											spellCheck={false}
											autoComplete="off"
											className="w-28 shrink-0 font-mono sm:w-36"
											onChange={(e) => setLocal(e.target.value)}
											required
										/>
										<span className="text-muted-foreground">@</span>
										<Select
											value={host}
											onValueChange={setHost}
										>
											<SelectTrigger className="min-w-0 flex-1 font-mono [&>span]:truncate">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{addresses.hosts.map((h) => (
													<SelectItem
														key={h.host}
														value={h.host}
														className="font-mono"
													>
														{h.host}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									<FieldDescription>
										{addresses.hosts.find((h) => h.host === host)?.active ===
										false
											? "This domain's MX doesn't point at SES yet: mail reaches it once it does (see the domain's page)."
											: "Any address at this domain already reaches the brand; this is the one Mailroom shows and suggests."}
									</FieldDescription>
								</Field>
							</form>
						)}
					</DialogBody>
					<DialogFooter>
						{addresses.picked && (
							<Button
								variant="ghost"
								className="mr-auto"
								disabled={busy}
								onClick={() => save(null)}
							>
								Use the default
							</Button>
						)}
						<Button
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						{addresses.hosts.length > 0 && (
							<Button
								type="submit"
								form="inbound-address"
								disabled={busy || !local.trim() || !host}
							>
								{busy && <Spinner />}
								Save
							</Button>
						)}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
