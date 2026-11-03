import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { AuthShell, AuthTitle } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";

/** Where the emailed "Reset your password" link lands (Better Auth adds the token). */
export const Route = createFileRoute("/reset-password")({
	validateSearch: z.object({
		token: z.string().optional(),
		error: z.string().optional(),
	}),
	head: () => ({ meta: [{ title: "Choose a new password · Mailroom" }] }),
	component: ResetPassword,
});

function ResetPassword() {
	const { token, error: linkError } = Route.useSearch();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);

	if (!token || linkError)
		return (
			<AuthShell>
				<AuthTitle title="This link doesn't work anymore">
					Reset links work once, for an hour. Ask for a new one from the sign-in page.
				</AuthTitle>
				<Button
					asChild
					size="lg"
					className="w-full"
				>
					<Link to="/login">Back to sign in</Link>
				</Button>
			</AuthShell>
		);

	if (done)
		return (
			<AuthShell>
				<AuthTitle title="Password changed">
					Sign in with your new password. Every device that was signed in has been signed
					out.
				</AuthTitle>
				<Button
					asChild
					size="lg"
					className="w-full"
				>
					<Link to="/login">Sign in</Link>
				</Button>
			</AuthShell>
		);

	return (
		<AuthShell>
			<AuthTitle title="Choose a new password">At least 10 characters.</AuthTitle>
			<form
				className="flex flex-col gap-4"
				onSubmit={async (e) => {
					e.preventDefault();
					if (password !== confirm) return setError("The two passwords don't match.");
					setBusy(true);
					setError(null);
					const r = await authClient.resetPassword({ newPassword: password, token });
					setBusy(false);
					if (r.error)
						return setError(
							/token/i.test(r.error.message ?? "")
								? "This link doesn't work anymore. Ask for a new one."
								: (r.error.message ?? "Not changed"),
						);
					try {
						localStorage.setItem("mailroom:sign-in", "password");
					} catch {}
					setDone(true);
				}}
			>
				<Field>
					<FieldLabel htmlFor="new-password">New password</FieldLabel>
					<Input
						id="new-password"
						type="password"
						autoComplete="new-password"
						autoFocus
						required
						minLength={10}
						maxLength={128}
						className="h-10 px-3 md:text-base"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</Field>
				<Field data-invalid={!!error || undefined}>
					<FieldLabel htmlFor="confirm-password">Type it again</FieldLabel>
					<Input
						id="confirm-password"
						type="password"
						autoComplete="new-password"
						required
						className="h-10 px-3 md:text-base"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
					{error ? (
						<FieldError>{error}</FieldError>
					) : (
						<FieldDescription>You'll be signed out everywhere else.</FieldDescription>
					)}
				</Field>
				<Button
					type="submit"
					size="lg"
					disabled={busy || password.length < 10 || !confirm}
				>
					{busy && <Spinner />}
					Change password
				</Button>
				<Link
					to="/login"
					className="inline-flex items-center gap-1 self-center text-sm text-muted-foreground transition-colors hover:text-foreground"
				>
					<ArrowLeft className="size-3.5" />
					Back to sign in
				</Link>
			</form>
		</AuthShell>
	);
}
