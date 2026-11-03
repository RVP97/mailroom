import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { AuthShell, AuthTitle } from "@/components/auth-shell";
import { GoogleMark } from "@/components/google-mark";
import { TwoFactorChallenge } from "@/components/two-factor-challenge";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Spinner } from "@/components/ui/spinner";
import { signInOptionsFn } from "@/functions/sign-in";
import { authClient } from "@/lib/auth-client";
import { forgetMe } from "@/lib/me";
import { usePasskeySignIn } from "@/lib/passkeys";

export const Route = createFileRoute("/login")({
	validateSearch: z.object({
		invitation: z.string().optional(),
		next: z.string().optional(),
		/** Back from Google: finish signing in (accept the invitation, go on). */
		google: z.literal(1).optional(),
		/** Better Auth's error code after a failed Google sign-in. */
		error: z.string().optional(),
	}),
	loader: () => signInOptionsFn(),
	head: () => ({ meta: [{ title: "Sign in · Mailroom" }] }),
	component: Login,
});

function Login() {
	const { invitation, next, google, error: googleError } = Route.useSearch();
	const options = Route.useLoaderData();
	const navigate = useNavigate();
	const [step, setStep] = useState<"email" | "code" | "two-factor" | "reset-sent">("email");
	// An emailed code, or a password (remembered: whoever set one keeps using it).
	const [method, setMethod] = useState<"code" | "password">("code");
	useEffect(() => {
		try {
			if (localStorage.getItem("mailroom:sign-in") === "password") setMethod("password");
		} catch {}
	}, []);
	const chooseMethod = (m: "code" | "password") => {
		setMethod(m);
		setError(null);
		try {
			localStorage.setItem("mailroom:sign-in", m);
		} catch {}
	};
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState<"code" | "verify" | "password" | "reset" | null>(null);
	const [error, setError] = useState<string | null>(
		googleError
			? /unable_to_create_user|forbidden|invitation/i.test(googleError)
				? "That Google account's address has no invitation. Ask an admin of your organization to invite it."
				: "Google sign-in didn't work. Try again, or continue with email."
			: null,
	);
	const [googleBusy, setGoogleBusy] = useState(false);
	const [resent, setResent] = useState(false);

	async function done() {
		forgetMe();
		if (invitation) {
			const r = await authClient.organization.acceptInvitation({ invitationId: invitation });
			if (r.data?.member)
				await authClient.organization.setActive({
					organizationId: r.data.member.organizationId,
				});
		}
		await navigate({ to: next?.startsWith("/") ? next : "/", replace: true });
	}

	const passkey = usePasskeySignIn(done);

	// Back from Google with a session: the same steps as any other sign-in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once, on the way back
	useEffect(() => {
		if (!google) return;
		void authClient.getSession().then((r) => {
			if (r.data?.session) void done();
		});
	}, []);

	async function signInWithGoogle() {
		setError(null);
		setGoogleBusy(true);
		const back = new URLSearchParams({ google: "1" });
		if (invitation) back.set("invitation", invitation);
		if (next) back.set("next", next);
		const r = await authClient.signIn.social({
			provider: "google",
			callbackURL: `/login?${back}`,
			errorCallbackURL: `/login${invitation ? `?invitation=${encodeURIComponent(invitation)}` : ""}`,
		});
		if (r.error) {
			setGoogleBusy(false);
			setError(r.error.message ?? "Google sign-in didn't work");
		}
	}

	async function sendCode(e?: React.FormEvent) {
		e?.preventDefault();
		setError(null);
		setBusy("code");
		const r = await authClient.emailOtp.sendVerificationOtp({
			email: email.trim(),
			type: "sign-in",
		});
		setBusy(null);
		if (r.error) return setError(r.error.message ?? "We couldn't send the code");
		setCode("");
		if (step === "code") setResent(true);
		setStep("code");
	}

	async function verify(value = code) {
		if (value.length !== 6) return;
		setError(null);
		setBusy("verify");
		const r = await authClient.signIn.emailOtp({ email: email.trim(), otp: value });
		if (r.error) {
			setBusy(null);
			setCode("");
			return setError(r.error.message ?? "That code didn't work");
		}
		if (needsSecondFactor(r.data)) {
			setBusy(null);
			return setStep("two-factor");
		}
		await done();
	}

	async function signInWithPassword(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setBusy("password");
		const r = await authClient.signIn.email({
			email: email.trim(),
			password,
			rememberMe: true,
		});
		if (r.error) {
			setBusy(null);
			return setError(
				r.error.status === 429
					? "Too many tries. Wait a minute, or continue with an emailed code."
					: /invalid/i.test(r.error.message ?? "")
						? "That email and password don't match. No password yet? Sign in with an emailed code and set one in Account."
						: (r.error.message ?? "That didn't work"),
			);
		}
		setPassword("");
		if (needsSecondFactor(r.data)) {
			setBusy(null);
			return setStep("two-factor");
		}
		await done();
	}

	async function forgotPassword() {
		if (!email.trim()) return setError("Enter your email first.");
		setError(null);
		setBusy("reset");
		const r = await authClient.requestPasswordReset({
			email: email.trim(),
			redirectTo: "/reset-password",
		});
		setBusy(null);
		if (r.error) return setError(r.error.message ?? "We couldn't send the link");
		setStep("reset-sent");
	}

	const shownError = error ?? passkey.error;

	return (
		<AuthShell
			showcase
			footer={
				step === "email"
					? "Only people invited to an organization can sign in."
					: step === "two-factor"
						? "Codes change every 30 seconds. Each backup code works once."
						: "Can't find it? Check your spam folder, or send a new code."
			}
		>
			{step === "two-factor" ? (
				<>
					<AuthTitle
						align="start"
						title="Two-factor authentication"
					>
						Enter the 6-digit code from your authenticator app.
					</AuthTitle>
					<TwoFactorChallenge onDone={done} />
					<button
						type="button"
						className="mt-6 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
						onClick={() => {
							setStep("email");
							setCode("");
							setError(null);
						}}
					>
						<ArrowLeft className="size-3.5" />
						Start over
					</button>
				</>
			) : step === "reset-sent" ? (
				<>
					<AuthTitle
						align="start"
						title="Check your email"
					>
						If <span className="font-medium text-foreground">{email}</span> has a
						Mailroom account, we sent it a link to choose a new password. It works for
						an hour.
					</AuthTitle>
					<Button
						variant="outline"
						size="lg"
						className="w-full"
						onClick={() => {
							setStep("email");
							setError(null);
						}}
					>
						<ArrowLeft />
						Back to sign in
					</Button>
				</>
			) : step === "email" ? (
				<>
					<AuthTitle
						align="start"
						title={invitation ? "Accept your invitation" : "Sign in to Mailroom"}
					>
						{invitation
							? "Sign in with the address you were invited at."
							: method === "password"
								? "Sign in with your email and password."
								: "We'll email you a code. No password needed."}
					</AuthTitle>
					<form
						onSubmit={method === "password" ? signInWithPassword : sendCode}
						className="flex flex-col gap-4"
					>
						<Field data-invalid={(!!shownError && method === "code") || undefined}>
							<FieldLabel htmlFor="email">Email</FieldLabel>
							<Input
								id="email"
								type="email"
								autoComplete="username webauthn"
								autoFocus
								required
								className="h-10 px-3 md:text-base"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="you@company.com"
							/>
							{shownError && method === "code" && (
								<FieldError>{shownError}</FieldError>
							)}
						</Field>
						{method === "password" && (
							<Field data-invalid={!!shownError || undefined}>
								<div className="flex items-center justify-between">
									<FieldLabel htmlFor="password">Password</FieldLabel>
									<button
										type="button"
										className="text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
										onClick={forgotPassword}
										disabled={!!busy}
									>
										{busy === "reset" ? "Sending…" : "Forgot it?"}
									</button>
								</div>
								<Input
									id="password"
									type="password"
									autoComplete="current-password"
									required
									className="h-10 px-3 md:text-base"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
								/>
								{shownError && <FieldError>{shownError}</FieldError>}
							</Field>
						)}
						<Button
							type="submit"
							size="lg"
							disabled={!!busy || passkey.busy}
						>
							{(busy === "code" || busy === "password") && <Spinner />}
							{method === "password" ? "Sign in" : "Continue with email"}
						</Button>
						<button
							type="button"
							className="self-center text-sm text-muted-foreground transition-colors hover:text-foreground"
							onClick={() =>
								chooseMethod(method === "password" ? "code" : "password")
							}
						>
							{method === "password"
								? "Email me a code instead"
								: "Sign in with a password"}
						</button>
					</form>
					{(passkey.supported || options.google) && (
						<div className="my-5 flex items-center gap-3 text-xs text-faint">
							<span className="h-px flex-1 bg-border" />
							or
							<span className="h-px flex-1 bg-border" />
						</div>
					)}
					<div className="flex flex-col gap-2">
						{options.google && (
							<Button
								type="button"
								variant="outline"
								size="lg"
								className="w-full"
								onClick={signInWithGoogle}
								disabled={!!busy || passkey.busy || googleBusy}
							>
								{googleBusy ? <Spinner /> : <GoogleMark />}
								Continue with Google
							</Button>
						)}
						{passkey.supported && (
							<Button
								type="button"
								variant="outline"
								size="lg"
								className="w-full"
								onClick={passkey.signIn}
								disabled={!!busy || passkey.busy || googleBusy}
							>
								{passkey.busy ? <Spinner /> : <Fingerprint />}
								Sign in with a passkey
							</Button>
						)}
					</div>
				</>
			) : (
				<>
					<AuthTitle
						align="start"
						title="Check your email"
					>
						We sent a 6-digit code to{" "}
						<span className="font-medium text-foreground">{email}</span>. It works for
						10 minutes.
					</AuthTitle>
					<div className="flex flex-col gap-4">
						<Field data-invalid={!!error || undefined}>
							<InputOTP
								maxLength={6}
								value={code}
								onChange={(v) => {
									setCode(v);
									if (v.length === 6) void verify(v);
								}}
								autoFocus
								disabled={busy === "verify"}
								containerClassName="w-full"
							>
								<InputOTPGroup className="w-full">
									{[0, 1, 2, 3, 4, 5].map((i) => (
										<InputOTPSlot
											key={i}
											index={i}
											className="h-12 flex-1 text-lg"
										/>
									))}
								</InputOTPGroup>
							</InputOTP>
							{error && <FieldError>{error}</FieldError>}
						</Field>
						<Button
							size="lg"
							className="w-full"
							onClick={() => verify()}
							disabled={code.length !== 6 || !!busy}
						>
							{busy === "verify" && <Spinner />}
							Sign in
						</Button>
						<div className="flex w-full items-center justify-between text-sm">
							<button
								type="button"
								className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
								onClick={() => {
									setStep("email");
									setError(null);
									setResent(false);
								}}
							>
								<ArrowLeft className="size-3.5" />
								Use another email
							</button>
							<button
								type="button"
								className="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
								onClick={() => sendCode()}
								disabled={!!busy}
							>
								{busy === "code"
									? "Sending…"
									: resent
										? "Sent again"
										: "Send a new code"}
							</button>
						</div>
					</div>
				</>
			)}
		</AuthShell>
	);
}

/** A password or emailed code was right, and the account also asks for its 2FA code. */
const needsSecondFactor = (data: unknown) =>
	!!data && typeof data === "object" && "twoFactorRedirect" in data && !!data.twoFactorRedirect;
