import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { madeBy, operatorFn } from "@/functions/operator";

export const Route = createFileRoute("/terms")({
	// Rendered on the server, so Google's branding review can read it.
	ssr: true,
	loader: () => operatorFn(),
	head: () => ({ meta: [{ title: "Terms · Mailroom" }] }),
	component: Terms,
});

function Terms() {
	const operator = Route.useLoaderData();
	return (
		<LegalPage
			title="Terms of service"
			updated="November 3, 2026"
		>
			<p>
				Mailroom is a private email platform {madeBy(operator)}. It isn't offered to the
				public: only people invited to one of its organizations may use it.
			</p>
			<h2>Using Mailroom</h2>
			<ul>
				<li>Send only email that its recipients asked for or expect.</li>
				<li>
					Don't send spam, phishing or anything that breaks the law or Amazon SES's terms.
				</li>
				<li>Keep your passkey and sign-in codes to yourself.</li>
			</ul>
			<h2>Access</h2>
			<p>
				An organization's owners and admins decide who belongs to it. Access can be removed
				at any time, and sending can be paused when bounces or spam reports are too high.
			</p>
			<h2>No warranty</h2>
			<p>
				Mailroom is provided as it is, without guarantees that every email arrives or that
				the service is always available.
			</p>
			{operator.contact && (
				<>
					<h2>Contact</h2>
					<p>Questions: {operator.contact}.</p>
				</>
			)}
		</LegalPage>
	);
}
