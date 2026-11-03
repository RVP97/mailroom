import { useRouter } from "@tanstack/react-router";
import {
	Check,
	Copy,
	Download,
	KeyRound,
	MoreHorizontal,
	RefreshCw,
	ShieldCheck,
	ShieldOff,
	Smartphone,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { renderSVG } from "uqr";
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
import { Checkbox } from "@/components/ui/checkbox";
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
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { removePasswordFn, setPasswordFn } from "@/functions/security";
import { authClient } from "@/lib/auth-client";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { forgetMe } from "@/lib/me";
import { Ph } from "@/lib/sketch";

/** Account › Password and Two-factor authentication. */

export type Security = {
	hasPassword: boolean;
	passwordChangedAt: string | null;
	twoFactor: boolean;
};

const MIN = 10;

function PasswordInput({
	id,
	label,
	value,
	onChange,
	autoComplete,
	autoFocus,
}: {
	id: string;
	label: string;
	value: string;
	onChange: (v: string) => void;
	autoComplete: "current-password" | "new-password";
	autoFocus?: boolean;
}) {
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input
				id={id}
				type="password"
				autoComplete={autoComplete}
				autoFocus={autoFocus}
				maxLength={128}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
		</Field>
	);
}

/** The status row inside a card: an icon, what's set, and a menu. */
function StatusRow({
	icon,
	title,
	detail,
	badge,
	menu,
}: {
	icon: React.ReactNode;
	title: React.ReactNode;
	detail: React.ReactNode;
	badge?: React.ReactNode;
	menu?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 border-t border-border/70 px-5 py-3">
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				{icon}
			</span>
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-2 truncate font-medium">
					{title}
					{badge}
				</p>
				<p className="truncate text-xs text-muted-foreground">{detail}</p>
			</div>
			{menu}
		</div>
	);
}

function EmptyNote({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<CardContent>
			<div className="flex items-center gap-3 rounded-lg bg-muted/60 px-4 py-3.5 text-sm">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-raised">
					{icon}
				</span>
				<p className="text-muted-foreground">{children}</p>
			</div>
		</CardContent>
	);
}

/* ------------------------------------------------------------------------------------------ */
/* Password                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export function PasswordCard({ security, email }: { security: Security; email: string }) {
	const router = useRouter();
	const [dialog, setDialog] = useState<"set" | "change" | "remove" | null>(null);
	const refresh = async () => {
		setDialog(null);
		forgetMe();
		await router.invalidate();
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Password</CardTitle>
				<CardDescription>
					Sign in with your email and a password, besides emailed codes and passkeys.
				</CardDescription>
			</CardHeader>
			{security.hasPassword ? (
				<StatusRow
					icon={<KeyRound className="size-4" />}
					title="Password"
					detail={
						<Ph>
							{security.passwordChangedAt
								? `Set ${formatRelative(security.passwordChangedAt)}`
								: "Set"}
						</Ph>
					}
					menu={
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="More for your password"
								>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => setDialog("change")}>
									<RefreshCw />
									Change password
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onSelect={() => setDialog("remove")}
								>
									<Trash2 />
									Remove password
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					}
				/>
			) : (
				<EmptyNote icon={<KeyRound className="size-4" />}>
					No password. You sign in with an emailed code
					{security.twoFactor ? " and your authenticator app" : ""}, a passkey or Google.
				</EmptyNote>
			)}
			<CardFooter>
				<span className="mr-auto text-xs">At least {MIN} characters.</span>
				{security.hasPassword ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => setDialog("change")}
					>
						Change password
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() => setDialog("set")}
					>
						<KeyRound />
						Set a password
					</Button>
				)}
			</CardFooter>
			<SetPasswordDialog
				open={dialog === "set"}
				onOpenChange={(v) => setDialog(v ? "set" : null)}
				onDone={refresh}
			/>
			<ChangePasswordDialog
				email={email}
				open={dialog === "change"}
				onOpenChange={(v) => setDialog(v ? "change" : null)}
				onDone={refresh}
			/>
			<RemovePasswordDialog
				open={dialog === "remove"}
				onOpenChange={(v) => setDialog(v ? "remove" : null)}
				onDone={refresh}
			/>
		</Card>
	);
}

function SetPasswordDialog({
	open,
	onOpenChange,
	onDone,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onDone: () => Promise<void>;
}) {
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const reset = () => {
		setPassword("");
		setConfirm("");
		setError(null);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				onOpenChange(v);
				if (!v) reset();
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						if (password.length < MIN)
							return setError(`Use at least ${MIN} characters.`);
						if (password !== confirm) return setError("The two passwords don't match.");
						setBusy(true);
						setError(null);
						try {
							await setPasswordFn({ data: { password } });
						} catch (err) {
							setBusy(false);
							return setError(await errorMessage(err));
						}
						setBusy(false);
						reset();
						try {
							localStorage.setItem("mailroom:sign-in", "password");
						} catch {}
						toast.success("Password set. Next time, sign in with it.");
						await onDone();
					}}
				>
					<DialogHeader>
						<DialogTitle>Set a password</DialogTitle>
						<DialogDescription>
							Emailed codes and passkeys keep working too.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<PasswordInput
							id="set-password"
							label="Password"
							autoComplete="new-password"
							autoFocus
							value={password}
							onChange={setPassword}
						/>
						<Field data-invalid={!!error || undefined}>
							<FieldLabel htmlFor="set-password-again">Type it again</FieldLabel>
							<Input
								id="set-password-again"
								type="password"
								autoComplete="new-password"
								maxLength={128}
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
							/>
							{error ? (
								<FieldError>{error}</FieldError>
							) : (
								<FieldDescription>At least {MIN} characters.</FieldDescription>
							)}
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="submit"
							disabled={busy || !password || !confirm}
						>
							{busy && <Spinner />}
							Set password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ChangePasswordDialog({
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
	const [current, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [signOutOthers, setSignOutOthers] = useState(true);
	const [busy, setBusy] = useState<"save" | "link" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reset = () => {
		setCurrent("");
		setPassword("");
		setConfirm("");
		setError(null);
	};
	const sendLink = async () => {
		setBusy("link");
		const r = await authClient.requestPasswordReset({ email, redirectTo: "/reset-password" });
		setBusy(null);
		if (r.error) return void toast.error(r.error.message ?? "We couldn't send the link");
		toast.success(`We emailed ${email} a link to choose a new password.`);
		onOpenChange(false);
		reset();
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				onOpenChange(v);
				if (!v) reset();
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						if (password.length < MIN)
							return setError(`Use at least ${MIN} characters.`);
						if (password !== confirm) return setError("The two passwords don't match.");
						setBusy("save");
						setError(null);
						const r = await authClient.changePassword({
							currentPassword: current,
							newPassword: password,
							revokeOtherSessions: signOutOthers,
						});
						setBusy(null);
						if (r.error)
							return setError(
								/invalid password/i.test(r.error.message ?? "")
									? "Your current password isn't right."
									: (r.error.message ?? "Not changed"),
							);
						reset();
						toast.success(
							signOutOthers
								? "Password changed. Other devices were signed out."
								: "Password changed",
						);
						await onDone();
					}}
				>
					<DialogHeader>
						<DialogTitle>Change password</DialogTitle>
						<DialogDescription>
							Forgot it?{" "}
							<button
								type="button"
								className="font-medium text-foreground underline-offset-4 hover:underline disabled:opacity-50"
								onClick={sendLink}
								disabled={!!busy}
							>
								{busy === "link" ? "Sending…" : "Email me a reset link"}
							</button>
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<PasswordInput
							id="current-password"
							label="Current password"
							autoComplete="current-password"
							autoFocus
							value={current}
							onChange={setCurrent}
						/>
						<PasswordInput
							id="new-password"
							label="New password"
							autoComplete="new-password"
							value={password}
							onChange={setPassword}
						/>
						<Field data-invalid={!!error || undefined}>
							<FieldLabel htmlFor="new-password-again">Type it again</FieldLabel>
							<Input
								id="new-password-again"
								type="password"
								autoComplete="new-password"
								maxLength={128}
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
							/>
							{error && <FieldError>{error}</FieldError>}
						</Field>
						<div className="flex items-center gap-2.5 text-sm">
							<Checkbox
								id="sign-out-others"
								checked={signOutOthers}
								onCheckedChange={(v) => setSignOutOthers(v === true)}
							/>
							<label
								htmlFor="sign-out-others"
								className="text-muted-foreground"
							>
								Sign out my other devices
							</label>
						</div>
					</DialogBody>
					<DialogFooter>
						<Button
							type="submit"
							disabled={!!busy || !current || !password || !confirm}
						>
							{busy === "save" && <Spinner />}
							Change password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function RemovePasswordDialog({
	open,
	onOpenChange,
	onDone,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onDone: () => Promise<void>;
}) {
	const [current, setCurrent] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				onOpenChange(v);
				if (!v) {
					setCurrent("");
					setError(null);
				}
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setError(null);
						try {
							await removePasswordFn({ data: { password: current } });
						} catch (err) {
							setBusy(false);
							return setError(await errorMessage(err));
						}
						setBusy(false);
						setCurrent("");
						try {
							localStorage.setItem("mailroom:sign-in", "code");
						} catch {}
						toast.success("Password removed");
						await onDone();
					}}
				>
					<DialogHeader>
						<DialogTitle>Remove your password?</DialogTitle>
						<DialogDescription>
							You'll sign in with an emailed code, a passkey or Google. You can set a
							new password any time.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Field data-invalid={!!error || undefined}>
							<FieldLabel htmlFor="remove-password">Current password</FieldLabel>
							<Input
								id="remove-password"
								type="password"
								autoComplete="current-password"
								autoFocus
								value={current}
								onChange={(e) => setCurrent(e.target.value)}
							/>
							{error && <FieldError>{error}</FieldError>}
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="submit"
							variant="destructive"
							disabled={busy || !current}
						>
							{busy && <Spinner />}
							Remove password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/* ------------------------------------------------------------------------------------------ */
/* Two-factor authentication                                                                  */
/* ------------------------------------------------------------------------------------------ */

export function TwoFactorCard({ security, email }: { security: Security; email: string }) {
	const router = useRouter();
	const [dialog, setDialog] = useState<"enable" | "codes" | "disable" | null>(null);
	const refresh = async () => {
		forgetMe();
		await router.invalidate();
	};
	return (
		<Card>
			<CardHeader>
				<CardTitle>Two-factor authentication</CardTitle>
				<CardDescription>
					After your password or an emailed code, Mailroom also asks for a code from an
					authenticator app (1Password, Google Authenticator, Authy…). Passkeys and Google
					don't need it.
				</CardDescription>
			</CardHeader>
			{security.twoFactor ? (
				<StatusRow
					icon={<Smartphone className="size-4" />}
					title="Authenticator app"
					badge={<Badge variant="brand">On</Badge>}
					detail="Lost your phone? Sign in with one of your backup codes."
					menu={
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label="More for two-factor authentication"
								>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => setDialog("codes")}>
									<RefreshCw />
									New backup codes
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									variant="destructive"
									onSelect={() => setDialog("disable")}
								>
									<ShieldOff />
									Turn off
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					}
				/>
			) : (
				<EmptyNote icon={<ShieldCheck className="size-4" />}>
					Off. Turn it on and a stolen password or inbox isn't enough to get in.
				</EmptyNote>
			)}
			<CardFooter>
				<span className="mr-auto text-xs">
					{security.twoFactor
						? "Each backup code works once."
						: "You'll get 10 backup codes for when your phone isn't with you."}
				</span>
				{security.twoFactor ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => setDialog("codes")}
					>
						New backup codes
					</Button>
				) : (
					<Button
						size="sm"
						onClick={() => setDialog("enable")}
					>
						<ShieldCheck />
						Turn on
					</Button>
				)}
			</CardFooter>
			<EnableTwoFactorDialog
				email={email}
				needsPassword={security.hasPassword}
				open={dialog === "enable"}
				onOpenChange={(v) => setDialog(v ? "enable" : null)}
				onEnabled={refresh}
			/>
			<BackupCodesDialog
				needsPassword={security.hasPassword}
				open={dialog === "codes"}
				onOpenChange={(v) => setDialog(v ? "codes" : null)}
			/>
			<DisableTwoFactorDialog
				needsPassword={security.hasPassword}
				open={dialog === "disable"}
				onOpenChange={(v) => setDialog(v ? "disable" : null)}
				onDone={async () => {
					setDialog(null);
					await refresh();
				}}
			/>
		</Card>
	);
}

/** The password step some dialogs start with (only when the account has one). */
function ConfirmPassword({
	value,
	onChange,
	error,
	description,
}: {
	value: string;
	onChange: (v: string) => void;
	error: string | null;
	description?: string;
}) {
	return (
		<Field data-invalid={!!error || undefined}>
			<FieldLabel htmlFor="confirm-2fa-password">Your password</FieldLabel>
			<Input
				id="confirm-2fa-password"
				type="password"
				autoComplete="current-password"
				autoFocus
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
			{error ? (
				<FieldError>{error}</FieldError>
			) : (
				description && <FieldDescription>{description}</FieldDescription>
			)}
		</Field>
	);
}

const passwordError = (message?: string) =>
	/invalid password/i.test(message ?? "")
		? "That password isn't right."
		: (message ?? "That didn't work");

function EnableTwoFactorDialog({
	email,
	needsPassword,
	open,
	onOpenChange,
	onEnabled,
}: {
	email: string;
	needsPassword: boolean;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onEnabled: () => Promise<void>;
}) {
	const [step, setStep] = useState<"start" | "scan" | "codes">("start");
	const [password, setPassword] = useState("");
	const [setup, setSetup] = useState<{ uri: string; codes: string[] } | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reset = () => {
		setStep("start");
		setPassword("");
		setSetup(null);
		setCode("");
		setError(null);
	};

	const begin = async () => {
		setBusy(true);
		setError(null);
		const r = await authClient.twoFactor.enable({
			...(needsPassword ? { password } : {}),
			issuer: "Mailroom",
		});
		setBusy(false);
		const data = r.data as { totpURI?: string; backupCodes?: string[] } | null;
		if (r.error || !data?.totpURI) return setError(passwordError(r.error?.message));
		setSetup({ uri: data.totpURI, codes: data.backupCodes ?? [] });
		setPassword("");
		setStep("scan");
	};

	const verify = async (value: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		const r = await authClient.twoFactor.verifyTotp({ code: value });
		setBusy(false);
		if (r.error) {
			setCode("");
			return setError(
				/invalid/i.test(r.error.message ?? "")
					? "That code didn't work. Check your phone's time, and try the newest code."
					: (r.error.message ?? "That code didn't work"),
			);
		}
		setStep("codes");
		await onEnabled();
	};

	const finishing = step === "codes";
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				// Leaving before the code is checked leaves 2FA off.
				onOpenChange(v);
				if (!v) reset();
			}}
		>
			<DialogContent className="sm:max-w-md">
				{step === "start" && (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void begin();
						}}
					>
						<DialogHeader>
							<DialogTitle>Turn on two-factor authentication</DialogTitle>
							<DialogDescription>
								You'll need an authenticator app on your phone or in your password
								manager.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							{needsPassword ? (
								<ConfirmPassword
									value={password}
									onChange={setPassword}
									error={error}
									description="To make sure it's you."
								/>
							) : (
								error && <FieldError>{error}</FieldError>
							)}
						</DialogBody>
						<DialogFooter>
							<Button
								type="submit"
								disabled={busy || (needsPassword && !password)}
							>
								{busy && <Spinner />}
								Continue
							</Button>
						</DialogFooter>
					</form>
				)}
				{step === "scan" && setup && (
					<>
						<DialogHeader>
							<DialogTitle>Scan this with your app</DialogTitle>
							<DialogDescription>
								Then enter the 6-digit code it shows for {email}.
							</DialogDescription>
						</DialogHeader>
						<DialogBody className="items-center">
							<TotpQr uri={setup.uri} />
							<SecretKey uri={setup.uri} />
							<Field
								data-invalid={!!error || undefined}
								className="items-center"
							>
								<InputOTP
									maxLength={6}
									value={code}
									inputMode="numeric"
									autoComplete="one-time-code"
									autoFocus
									containerClassName="justify-center"
									readOnly={busy}
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
								{error && <FieldError className="text-center">{error}</FieldError>}
							</Field>
						</DialogBody>
						<DialogFooter>
							<Button
								disabled={busy || code.length !== 6}
								onClick={() => verify(code)}
							>
								{busy && <Spinner />}
								Turn on
							</Button>
						</DialogFooter>
					</>
				)}
				{finishing && setup && (
					<>
						<DialogHeader>
							<DialogTitle>Two-factor authentication is on</DialogTitle>
							<DialogDescription>
								Save these backup codes somewhere safe, like your password manager.
								Each one signs you in once if your phone isn't with you. You won't
								see them again.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<BackupCodeList codes={setup.codes} />
						</DialogBody>
						<DialogFooter>
							<Button
								onClick={() => {
									onOpenChange(false);
									reset();
								}}
							>
								I saved them
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function TotpQr({ uri }: { uri: string }) {
	const svg = useMemo(
		() => renderSVG(uri, { border: 2, whiteColor: "#ffffff", blackColor: "#111111" }),
		[uri],
	);
	return (
		<div
			role="img"
			aria-label="QR code for your authenticator app"
			className="size-44 overflow-hidden rounded-lg bg-white p-1 shadow-raised [&>svg]:size-full"
			// biome-ignore lint/security/noDangerouslySetInnerHtml: uqr's own SVG of the otpauth URI
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}

/** The secret as text, in groups of four, for apps that can't scan. */
function SecretKey({ uri }: { uri: string }) {
	const secret = useMemo(() => {
		try {
			return new URL(uri).searchParams.get("secret") ?? "";
		} catch {
			return "";
		}
	}, [uri]);
	const [copied, setCopied] = useState(false);
	if (!secret) return null;
	return (
		<div className="flex w-full flex-col items-center gap-1 text-center">
			<span className="text-xs text-muted-foreground">Can't scan? Enter this key:</span>
			<button
				type="button"
				className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-sm tracking-wide transition-colors hover:bg-muted"
				onClick={async () => {
					await navigator.clipboard.writeText(secret);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{secret.match(/.{1,4}/g)?.join(" ")}
				{copied ? (
					<Check className="size-3.5 text-success" />
				) : (
					<Copy className="size-3.5 text-muted-foreground" />
				)}
			</button>
		</div>
	);
}

function BackupCodeList({ codes }: { codes: string[] }) {
	const text = codes.join("\n");
	return (
		<div className="flex flex-col gap-3">
			<ol className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg bg-muted/60 px-5 py-4 font-mono text-sm">
				{codes.map((c) => (
					<li key={c}>{c}</li>
				))}
			</ol>
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="outline"
					onClick={async () => {
						await navigator.clipboard.writeText(text);
						toast.success("Backup codes copied");
					}}
				>
					<Copy />
					Copy
				</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						const a = document.createElement("a");
						a.href = URL.createObjectURL(
							new Blob(
								[
									`Mailroom backup codes (${location.host})\nEach one works once.\n\n${text}\n`,
								],
								{ type: "text/plain" },
							),
						);
						a.download = "mailroom-backup-codes.txt";
						a.click();
						URL.revokeObjectURL(a.href);
					}}
				>
					<Download />
					Download
				</Button>
			</div>
		</div>
	);
}

function BackupCodesDialog({
	needsPassword,
	open,
	onOpenChange,
}: {
	needsPassword: boolean;
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [password, setPassword] = useState("");
	const [codes, setCodes] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const close = () => {
		onOpenChange(false);
		setPassword("");
		setCodes(null);
		setError(null);
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				if (!v) close();
				else onOpenChange(v);
			}}
		>
			<DialogContent className="sm:max-w-md">
				{codes ? (
					<>
						<DialogHeader>
							<DialogTitle>Your new backup codes</DialogTitle>
							<DialogDescription>
								The old ones don't work anymore. Save these somewhere safe.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							<BackupCodeList codes={codes} />
						</DialogBody>
						<DialogFooter>
							<Button onClick={close}>I saved them</Button>
						</DialogFooter>
					</>
				) : (
					<form
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							setError(null);
							const r = await authClient.twoFactor.generateBackupCodes(
								needsPassword ? { password } : {},
							);
							setBusy(false);
							if (r.error || !r.data?.backupCodes)
								return setError(passwordError(r.error?.message));
							setCodes(r.data.backupCodes);
							setPassword("");
						}}
					>
						<DialogHeader>
							<DialogTitle>Make new backup codes?</DialogTitle>
							<DialogDescription>
								You get 10 new codes, and the ones you have now stop working.
							</DialogDescription>
						</DialogHeader>
						<DialogBody>
							{needsPassword ? (
								<ConfirmPassword
									value={password}
									onChange={setPassword}
									error={error}
								/>
							) : (
								error && <FieldError>{error}</FieldError>
							)}
						</DialogBody>
						<DialogFooter>
							<Button
								type="submit"
								disabled={busy || (needsPassword && !password)}
							>
								{busy && <Spinner />}
								Make new codes
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function DisableTwoFactorDialog({
	needsPassword,
	open,
	onOpenChange,
	onDone,
}: {
	needsPassword: boolean;
	open: boolean;
	onOpenChange: (v: boolean) => void;
	onDone: () => Promise<void>;
}) {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			open={open}
			onOpenChange={(v) => {
				if (busy) return;
				onOpenChange(v);
				if (!v) {
					setPassword("");
					setError(null);
				}
			}}
		>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						setError(null);
						const r = await authClient.twoFactor.disable(
							needsPassword ? { password } : {},
						);
						setBusy(false);
						if (r.error) return setError(passwordError(r.error.message));
						setPassword("");
						toast.success("Two-factor authentication is off");
						await onDone();
					}}
				>
					<DialogHeader>
						<DialogTitle>Turn off two-factor authentication?</DialogTitle>
						<DialogDescription>
							Signing in will only need your password or an emailed code. Your backup
							codes stop working. Remove Mailroom from your authenticator app too.
						</DialogDescription>
					</DialogHeader>
					{needsPassword && (
						<DialogBody>
							<ConfirmPassword
								value={password}
								onChange={setPassword}
								error={error}
							/>
						</DialogBody>
					)}
					{!needsPassword && error && (
						<DialogBody>
							<FieldError>{error}</FieldError>
						</DialogBody>
					)}
					<DialogFooter>
						<Button
							type="submit"
							variant="destructive"
							disabled={busy || (needsPassword && !password)}
						>
							{busy && <Spinner />}
							Turn off
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
