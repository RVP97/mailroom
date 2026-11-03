import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
	Fingerprint,
	KeyRound,
	Link2,
	Mail,
	MoreHorizontal,
	Plus,
	ShieldCheck,
	Trash2,
	Unlink,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PasswordCard, type Security, TwoFactorCard } from "@/components/account-security";
import { Confirm } from "@/components/confirm";
import { GoogleMark } from "@/components/google-mark";
import { UserAvatar } from "@/components/org-avatar";
import { Page, PageHeader } from "@/components/page";
import { TwoFactorChallenge } from "@/components/two-factor-challenge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { securityFn } from "@/functions/security";
import { signInOptionsFn } from "@/functions/sign-in";
import { authClient } from "@/lib/auth-client";
import { formatRelative } from "@/lib/format";
import { forgetMe, useMe } from "@/lib/me";
import { useOptimisticState } from "@/lib/optimistic";
import { PROVIDERS, usePasskeyRegistration } from "@/lib/passkeys";
import { ago, Ph, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

type Passkey = {
	id: string;
	name?: string | null;
	createdAt: Date | string;
	deviceType: string;
	aaguid?: string | null;
};

type Linked = { id: string; providerId: string; accountId: string; createdAt: Date | string };

export const Route = createFileRoute("/_app/account")({
	loader: async () => {
		const [keys, accounts, options, security] = await Promise.all([
			authClient.passkey.listUserPasskeys(),
			authClient.listAccounts(),
			signInOptionsFn(),
			securityFn(),
		]);
		return {
			keys: (keys.data as Passkey[] | null) ?? [],
			accounts: ((accounts.data as Linked[] | null) ?? []).filter(
				(a) => a.providerId === "google",
			),
			google: options.google,
			security,
		};
	},
	head: () => ({ meta: [{ title: "Account · Mailroom" }] }),
	component: Account,
	pendingComponent: () => (
		<Sketch
			data={{
				keys: sample(rememberedRows("passkeys", 1), (i) => ({
					id: `sketch-${i}`,
					name: "Passkey",
					createdAt: ago(60 * 24 * 30),
					deviceType: "multiDevice",
					aaguid: null,
				})),
				accounts: [],
				google: true,
				// What was set last time, so the cards keep their shape while loading.
				security: {
					hasPassword: rememberedRows("password", 0) > 0,
					passwordChangedAt: ago(60 * 24 * 30),
					twoFactor: rememberedRows("two-factor", 0) > 0,
				} satisfies Security,
			}}
		>
			<Account />
		</Sketch>
	),
});

/** The list without the one just deleted. */
const withoutKey = (keys: Passkey[], id: string) => keys.filter((k) => k.id !== id);

function Account() {
	const me = useMe();
	const { security } = usePage(Route).data;
	useRememberRows("password", security.hasPassword ? 1 : 0);
	useRememberRows("two-factor", security.twoFactor ? 1 : 0);
	return (
		<Page className="max-w-3xl">
			<PageHeader
				title="Account"
				description={<Ph>{me.user.email}</Ph>}
			/>
			<Name />
			<SignInMethods />
			<Passkeys />
			<PasswordCard
				security={security}
				email={me.user.email}
			/>
			<TwoFactorCard
				security={security}
				email={me.user.email}
			/>
		</Page>
	);
}

/** How they sign in: an emailed code always, and Google when it's linked. */
function SignInMethods() {
	const me = useMe();
	const router = useRouter();
	const { accounts, google, keys } = usePage(Route).data;
	const linked = accounts[0];
	const [busy, setBusy] = useState(false);
	const [unlinking, setUnlinking] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const unlink = async () => {
		const r = await authClient.unlinkAccount({ accountId: linked?.id ?? "" });
		if (r.error) {
			// Unlinking wants a recent sign-in: an emailed code makes it one, then it goes on.
			if (r.error.code === "SESSION_NOT_FRESH" || r.error.status === 403)
				return void setConfirming(true);
			return void toast.error(r.error.message ?? "Not unlinked");
		}
		toast.success("Google unlinked");
		await router.invalidate();
	};
	// Coming back from Google: its callback says what went wrong in ?error=.
	useEffect(() => {
		const url = new URL(window.location.href);
		const error = url.searchParams.get("error");
		if (url.searchParams.get("linked") === "google" && !error) {
			toast.success("Google linked. Next time, sign in with it.");
			window.history.replaceState(null, "", url.pathname);
			return;
		}
		if (!error) return;
		toast.error(
			/different.?email/i.test(error)
				? `That Google account isn't ${me.user.email}. Pick the one with this address.`
				: /already.?linked|account_already_linked/i.test(error)
					? "That Google account already signs in to another Mailroom account."
					: "Google wasn't linked. Try again.",
		);
		url.searchParams.delete("error");
		window.history.replaceState(null, "", url.pathname + url.search);
	}, [me.user.email]);
	const link = async () => {
		setBusy(true);
		const r = await authClient.linkSocial({
			provider: "google",
			callbackURL: "/account?linked=google",
			errorCallbackURL: "/account",
		});
		if (r.error) {
			setBusy(false);
			toast.error(r.error.message ?? "Google wasn't linked");
		}
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Ways to sign in</CardTitle>
				<CardDescription>
					A code emailed to you always works. Link Google to sign in with one click.
				</CardDescription>
			</CardHeader>
			<ul className="border-t border-border/70">
				<li className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
					<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<Mail className="size-4" />
					</span>
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium">Emailed code</p>
						<p className="truncate text-xs text-muted-foreground">
							<Ph>{me.user.email}</Ph>
						</p>
					</div>
				</li>
				{(google || linked) && (
					<li className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
							<GoogleMark />
						</span>
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium">Google</p>
							<p className="truncate text-xs text-muted-foreground">
								<Ph>
									{linked
										? `Linked ${formatRelative(new Date(linked.createdAt).toISOString())}`
										: `Not linked. Use the Google account for ${me.user.email}.`}
								</Ph>
							</p>
						</div>
						{linked ? (
							<Button
								size="sm"
								variant="outline"
								onClick={() => setUnlinking(true)}
							>
								<Unlink />
								Unlink
							</Button>
						) : (
							<Button
								size="sm"
								variant="outline"
								disabled={busy || !google}
								onClick={link}
							>
								{busy ? <Spinner /> : <Link2 />}
								Link Google
							</Button>
						)}
					</li>
				)}
			</ul>
			<Confirm
				open={unlinking}
				onOpenChange={setUnlinking}
				title="Unlink Google?"
				description={`You'll sign in with a code emailed to ${me.user.email}${
					keys.length ? " or a passkey" : ""
				} instead. You can link it again any time.`}
				action="Unlink Google"
				onConfirm={unlink}
			/>
			<ConfirmIdentity
				email={me.user.email}
				open={confirming}
				onOpenChange={setConfirming}
				onDone={async () => {
					setConfirming(false);
					await unlink();
				}}
			/>
		</Card>
	);
}

function Name() {
	const me = useMe();
	const router = useRouter();
	const [name, setName] = useState(me.user.name ?? "");
	const [busy, setBusy] = useState(false);
	const changed = name.trim() !== "" && name.trim() !== me.user.name;
	return (
		<Card>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (!changed) return;
					setBusy(true);
					const r = await authClient.updateUser({ name: name.trim() });
					setBusy(false);
					if (r.error) return void toast.error(r.error.message ?? "Not saved");
					toast.success("Name saved");
					forgetMe();
					await router.invalidate();
				}}
			>
				<CardHeader>
					<CardTitle>Your name</CardTitle>
					<CardDescription>As your teammates see it.</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex max-w-md items-center gap-3">
						<UserAvatar
							name={name || me.user.email}
							className="size-8 text-xs"
						/>
						<Input
							aria-label="Your name"
							autoComplete="name"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
				</CardContent>
				<CardFooter>
					<span className="mr-auto text-xs">Up to 64 characters.</span>
					<Button
						type="submit"
						size="sm"
						disabled={busy || !changed}
					>
						{busy && <Spinner />}
						Save
					</Button>
				</CardFooter>
			</form>
		</Card>
	);
}

function Passkeys() {
	// A removed passkey leaves the list at once; a failed removal puts it back.
	const [keys, save] = useOptimisticState(usePage(Route).data.keys, withoutKey);
	useRememberRows("passkeys", keys.length);
	const me = useMe();
	const router = useRouter();
	const remove = async (k: Passkey) => {
		const ok = await save(k.id, async () => {
			const r = await authClient.passkey.deletePasskey({ id: k.id });
			if (r.error) throw new Error(r.error.message || "Not removed");
		});
		if (ok) toast.success("Passkey removed");
	};
	const { supported, problem, adding, add, refresh } = usePasskeyRegistration(me.user.email);
	const [confirming, setConfirming] = useState(false);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Passkeys</CardTitle>
				<CardDescription>
					Sign in with Face ID, Touch ID, Windows Hello or a security key instead of an
					emailed code.
				</CardDescription>
			</CardHeader>
			{keys.length > 0 ? (
				<ul className="border-t border-border/70">
					{keys.map((k) => (
						<PasskeyRow
							key={k.id}
							k={k}
							onRemove={() => void remove(k)}
						/>
					))}
				</ul>
			) : (
				<CardContent>
					<div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3.5 text-sm">
						<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-raised">
							<Fingerprint className="size-4" />
						</span>
						<p className="text-muted-foreground">
							No passkeys yet. Add one and signing in takes a touch, not a trip to
							your inbox.
						</p>
					</div>
				</CardContent>
			)}
			<CardFooter>
				<span className="mr-auto text-xs">
					{supported === false
						? "This browser can't create passkeys."
						: problem === "not-fresh"
							? "To add a passkey, first confirm it's you."
							: "Each device or password manager gets its own passkey."}
				</span>
				{problem === "not-fresh" ? (
					<Button
						size="sm"
						onClick={() => setConfirming(true)}
					>
						<ShieldCheck />
						Confirm it's you
					</Button>
				) : (
					<Button
						size="sm"
						disabled={adding || !supported}
						onClick={async () => {
							const r = await add();
							if (r.ok) {
								toast.success("Passkey added. Next time, sign in with it.");
								await router.invalidate();
							} else if (r.error) toast.error(r.error);
						}}
					>
						{adding ? <Spinner /> : <Plus />}
						Add a passkey
					</Button>
				)}
			</CardFooter>
			<ConfirmIdentity
				email={me.user.email}
				open={confirming}
				onOpenChange={setConfirming}
				onDone={async () => {
					setConfirming(false);
					await refresh();
					toast.success("Confirmed. Now add your passkey.");
				}}
			/>
		</Card>
	);
}

function PasskeyRow({ k, onRemove }: { k: Passkey; onRemove: () => void }) {
	const [removing, setRemoving] = useState(false);
	const provider = k.aaguid ? PROVIDERS[k.aaguid] : undefined;
	return (
		<li className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0">
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				<KeyRound className="size-4" />
			</span>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium">
					<Ph>{k.name || "Passkey"}</Ph>
				</p>
				<p className="truncate text-xs text-muted-foreground">
					<Ph>
						{provider ??
							(k.deviceType === "multiDevice" ? "Synced" : "This device only")}{" "}
						· added {formatRelative(new Date(k.createdAt).toISOString())}
					</Ph>
				</p>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={`More for ${k.name || "this passkey"}`}
					>
						<MoreHorizontal />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						variant="destructive"
						onSelect={() => setRemoving(true)}
					>
						<Trash2 />
						Remove passkey
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title="Remove this passkey?"
				description="You can still sign in with an emailed code. Delete it from your password manager too."
				action="Remove passkey"
				onConfirm={onRemove}
			/>
		</li>
	);
}

/** Adding a passkey needs a sign-in from the last day; an emailed code renews it. */
function ConfirmIdentity({
	email,
	open,
	onOpenChange,
	onDone,
}: {
	email: string;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onDone: () => Promise<void>;
}) {
	const [sent, setSent] = useState(false);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [secondFactor, setSecondFactor] = useState(false);
	const send = async () => {
		setBusy(true);
		setError(null);
		const r = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
		setBusy(false);
		if (r.error) return setError(r.error.message ?? "We couldn't send the code");
		setSent(true);
	};
	const verify = async (otp: string) => {
		setBusy(true);
		setError(null);
		const r = await authClient.signIn.emailOtp({ email, otp });
		setBusy(false);
		if (r.error) {
			setCode("");
			return setError(r.error.message ?? "That code didn't work");
		}
		setCode("");
		// With 2FA on, the code alone isn't a sign-in: the authenticator's code finishes it.
		if (r.data && "twoFactorRedirect" in r.data && r.data.twoFactorRedirect)
			return setSecondFactor(true);
		setSent(false);
		await onDone();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				// Halfway through 2FA there's no session anymore: sign in again from the start.
				if (!v && secondFactor) return window.location.reload();
				onOpenChange(v);
				if (!v) {
					setSent(false);
					setCode("");
					setError(null);
				}
			}}
		>
			<DialogContent className="sm:max-w-sm">
				{secondFactor ? (
					<>
						<DialogHeader>
							<DialogTitle>Confirm it's you</DialogTitle>
							<DialogDescription>
								Now enter the 6-digit code from your authenticator app.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<TwoFactorChallenge
								large={false}
								trustOption={false}
								onDone={async () => {
									setSecondFactor(false);
									setSent(false);
									await onDone();
								}}
							/>
						</DialogBody>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>Confirm it's you</DialogTitle>
							<DialogDescription>
								{sent ? (
									<>
										Enter the code we sent to{" "}
										<span className="font-medium text-foreground">{email}</span>
										.
									</>
								) : (
									"You signed in more than a day ago. We'll email you a code before adding a passkey."
								)}
							</DialogDescription>
						</DialogHeader>
						{sent && (
							<DialogBody className="items-center">
								<InputOTP
									maxLength={6}
									value={code}
									autoFocus
									disabled={busy}
									onChange={(v) => {
										setCode(v);
										if (v.length === 6) void verify(v);
									}}
								>
									<InputOTPGroup>
										{[0, 1, 2, 3, 4, 5].map((i) => (
											<InputOTPSlot
												key={i}
												index={i}
											/>
										))}
									</InputOTPGroup>
								</InputOTP>
								{error && <FieldError>{error}</FieldError>}
							</DialogBody>
						)}
						{!sent && error && (
							<DialogBody>
								<FieldError>{error}</FieldError>
							</DialogBody>
						)}
						<DialogFooter>
							{sent ? (
								<Button
									variant="ghost"
									disabled={busy}
									onClick={send}
								>
									Send a new code
								</Button>
							) : (
								<Button
									disabled={busy}
									onClick={send}
								>
									{busy && <Spinner />}
									Email me a code
								</Button>
							)}
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
