import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AuthShell, AuthTitle } from "@/components/auth-shell";
import { OrgAvatar } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { forgetMe, loadMe } from "@/lib/me";

export const Route = createFileRoute("/new")({
	// The deployment's admins create organizations; an organization's own brands are made in
	// Brands.
	beforeLoad: async () => {
		const me = await loadMe().catch(() => null);
		if (!me) throw redirect({ to: "/login" });
		if (!me.isAdmin) throw redirect({ to: "/brands" });
	},
	head: () => ({ meta: [{ title: "New organization · Mailroom" }] }),
	component: NewOrganization,
});

const slugify = (s: string) =>
	s
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);

function NewOrganization() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const finalSlug = touched ? slug : slugify(name);
	return (
		<AuthShell
			footer={
				<button
					type="button"
					className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
					onClick={() => router.history.back()}
				>
					<ArrowLeft className="size-3.5" />
					Back
				</button>
			}
		>
			<AuthTitle title="New organization">
				A company with its own people, API keys and webhooks. The brands it sends as (each
				with its own SES reputation) are added in Brands.
			</AuthTitle>
			<form
				className="flex flex-col gap-5"
				onSubmit={async (e) => {
					e.preventDefault();
					setBusy(true);
					const r = await authClient.organization.create({
						name: name.trim(),
						slug: finalSlug,
					});
					if (r.error || !r.data) {
						setBusy(false);
						return void toast.error(r.error?.message ?? "Not created");
					}
					const id = r.data.id;
					await authClient.organization.setActive({ organizationId: id });
					forgetMe();
					router.clearCache();
					await router.navigate({ to: "/" });
				}}
			>
				<Field>
					<FieldLabel htmlFor="name">Name</FieldLabel>
					<div className="flex items-center gap-2.5">
						{name.trim() ? (
							<OrgAvatar
								name={name}
								className="size-9 rounded-lg text-sm"
							/>
						) : (
							<span
								aria-hidden="true"
								className="size-9 shrink-0 rounded-lg border border-dashed border-border-strong"
							/>
						)}
						<Input
							id="name"
							required
							autoFocus
							autoComplete="organization"
							className="h-9"
							placeholder="Acme Inc."
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
				</Field>
				<Field>
					<FieldLabel htmlFor="slug">Short name</FieldLabel>
					<div className="control flex h-9 items-center rounded-md pl-2.5 font-mono text-sm">
						<span className="text-faint">mailroom-</span>
						<input
							id="slug"
							required
							pattern="[a-z0-9\-]+"
							spellCheck={false}
							className="h-full min-w-0 flex-1 bg-transparent pr-2.5 outline-none"
							value={finalSlug}
							onChange={(e) => {
								setTouched(true);
								setSlug(slugify(e.target.value));
							}}
						/>
					</div>
					<FieldDescription>
						Names its SES tenant. It can't change later.
					</FieldDescription>
				</Field>
				<Button
					type="submit"
					size="lg"
					disabled={busy || !name.trim() || !finalSlug}
				>
					{busy && <Spinner />}
					Create organization
				</Button>
			</form>
		</AuthShell>
	);
}
