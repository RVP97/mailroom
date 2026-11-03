import { createFileRoute, redirect } from "@tanstack/react-router";
import { Check, Plug, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { AuthShell, AuthTitle } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { approveFn, consentFn } from "@/functions/oauth";
import { errorMessage } from "@/lib/errors";

/** Where an AI assistant (Claude, ChatGPT) asks to connect to Mailroom's MCP server. */
export const Route = createFileRoute("/oauth/authorize")({
	loader: async ({ location }) => {
		const query = location.searchStr ?? "";
		try {
			const r = await consentFn({ data: { query } });
			if ("redirectTo" in r) {
				window.location.href = r.redirectTo ?? "/";
				return null;
			}
			return { ...r, query };
		} catch (error) {
			if (error instanceof Response && error.status === 401)
				throw redirect({ to: "/login", search: { next: location.href } });
			return { failed: await errorMessage(error) };
		}
	},
	head: () => ({ meta: [{ title: "Connect an app · Mailroom" }] }),
	component: Consent,
});

const CAN = [
	"Read your emails, events and stats",
	"Send emails and manage domains, webhooks and suppressions, as your role allows",
	"Never see API key or webhook secret values",
];

function Consent() {
	const data = Route.useLoaderData();
	const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
	const [error, setError] = useState<string | null>(null);
	if (!data) return null;
	if ("failed" in data)
		return (
			<AuthShell>
				<div className="flex flex-col items-center text-center">
					<span className="mb-4 flex size-10 items-center justify-center rounded-[10px] bg-card text-warning shadow-raised">
						<TriangleAlert className="size-[18px]" />
					</span>
					<AuthTitle title="This link didn't work">{data.failed}</AuthTitle>
				</div>
			</AuthShell>
		);
	const request = data;

	async function answer(allow: boolean) {
		setError(null);
		setBusy(allow ? "allow" : "deny");
		try {
			const r = await approveFn({ data: { query: request.query, allow } });
			window.location.href = r.redirectTo;
		} catch (e) {
			setBusy(null);
			setError(await errorMessage(e));
		}
	}

	return (
		<AuthShell footer={`You'll go back to ${request.client.redirectHost}.`}>
			<div className="flex flex-col items-center">
				<span className="mb-4 flex size-10 items-center justify-center rounded-[10px] bg-muted text-muted-foreground">
					<Plug className="size-[18px]" />
				</span>
				<AuthTitle title={`Connect ${request.client.name} to Mailroom`}>
					{request.client.domain ? `${request.client.domain} ` : ""}will act as{" "}
					<span className="font-medium text-foreground">{request.email}</span> in your
					organizations.
				</AuthTitle>
			</div>
			<ul className="mb-6 flex flex-col gap-2.5 rounded-lg bg-muted/60 p-4 text-sm">
				{CAN.map((c) => (
					<li
						key={c}
						className="flex gap-2.5"
					>
						<Check
							className="mt-0.5 size-3.5 shrink-0 text-success"
							strokeWidth={2.5}
						/>
						{c}
					</li>
				))}
			</ul>
			{error && <p className="mb-3 text-center text-sm text-destructive">{error}</p>}
			<div className="flex flex-col gap-2">
				<Button
					size="lg"
					onClick={() => answer(true)}
					disabled={!!busy}
				>
					{busy === "allow" && <Spinner />}
					Allow access
				</Button>
				<Button
					variant="ghost"
					size="lg"
					onClick={() => answer(false)}
					disabled={!!busy}
				>
					{busy === "deny" && <Spinner />}
					Cancel
				</Button>
			</div>
		</AuthShell>
	);
}
