import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

/**
 * The second step of a sign-in with two-factor authentication on: the 6-digit code from an
 * authenticator app, or one of the backup codes. Better Auth holds the half-done sign-in in a
 * cookie for 10 minutes; a right code turns it into a session.
 */
export function TwoFactorChallenge({
	onDone,
	trustOption = true,
	large = true,
}: {
	onDone: () => void | Promise<void>;
	/** Offer "Don't ask again on this device for 30 days". */
	trustOption?: boolean;
	large?: boolean;
}) {
	const [mode, setMode] = useState<"totp" | "backup">("totp");
	const [code, setCode] = useState("");
	const [trust, setTrust] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function verify(value = code) {
		const clean = value.trim();
		if (busy || (mode === "totp" ? clean.length !== 6 : clean.length < 6)) return;
		setBusy(true);
		setError(null);
		const r =
			mode === "totp"
				? await authClient.twoFactor.verifyTotp({ code: clean, trustDevice: trust })
				: await authClient.twoFactor.verifyBackupCode({ code: clean, trustDevice: trust });
		if (r.error) {
			setBusy(false);
			setCode("");
			return setError(
				/cookie|expired/i.test(r.error.message ?? "")
					? "This sign-in took too long. Start again."
					: r.error.status === 429 || /locked|too many/i.test(r.error.message ?? "")
						? "Too many wrong codes. Wait a few minutes and start again."
						: "That code didn't work. Try the newest one.",
			);
		}
		await onDone();
		setBusy(false);
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				void verify();
			}}
		>
			<Field data-invalid={!!error || undefined}>
				{mode === "totp" ? (
					<InputOTP
						maxLength={6}
						value={code}
						inputMode="numeric"
						autoComplete="one-time-code"
						onChange={(v) => {
							setCode(v);
							if (v.length === 6) void verify(v);
						}}
						autoFocus
						// Not disabled while checking: a disabled input loses focus, and after a
						// wrong code the next one should go straight in.
						readOnly={busy}
						containerClassName="w-full"
					>
						<InputOTPGroup className="w-full">
							{[0, 1, 2, 3, 4, 5].map((i) => (
								<InputOTPSlot
									key={i}
									index={i}
									className={large ? "h-12 flex-1 text-lg" : "flex-1"}
								/>
							))}
						</InputOTPGroup>
					</InputOTP>
				) : (
					<>
						<FieldLabel htmlFor="backup-code">Backup code</FieldLabel>
						<Input
							id="backup-code"
							autoFocus
							autoComplete="off"
							spellCheck={false}
							className="h-10 px-3 font-mono md:text-base"
							placeholder="xxxxx-xxxxx"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							disabled={busy}
						/>
					</>
				)}
				{error && <FieldError>{error}</FieldError>}
			</Field>
			{trustOption && (
				<div className="flex items-center gap-2.5 text-sm">
					<Checkbox
						id="trust-device"
						checked={trust}
						onCheckedChange={(v) => setTrust(v === true)}
					/>
					<label
						htmlFor="trust-device"
						className="text-muted-foreground"
					>
						Don't ask again on this device for 30 days
					</label>
				</div>
			)}
			<Button
				type="submit"
				size={large ? "lg" : "default"}
				className="w-full"
				disabled={busy || (mode === "totp" ? code.length !== 6 : code.trim().length < 6)}
			>
				{busy && <Spinner />}
				Verify
			</Button>
			<button
				type="button"
				className="self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
				onClick={() => {
					setMode(mode === "totp" ? "backup" : "totp");
					setCode("");
					setError(null);
				}}
			>
				{mode === "totp"
					? "Lost your phone? Use a backup code"
					: "Use your authenticator app"}
			</button>
		</form>
	);
}
