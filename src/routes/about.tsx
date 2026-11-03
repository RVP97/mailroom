import { createFileRoute, Link } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { madeBy, operatorFn } from "@/functions/operator";

/** Mailroom's public home page, which Google's OAuth branding verification looks at. */
export const Route = createFileRoute("/about")({
	// Rendered on the server, so Google's branding review can read it.
	ssr: true,
	loader: () => operatorFn(),
	head: ({ loaderData }) => ({
		meta: [
			{ title: "Mailroom" },
			{
				name: "description",
				content: `Mailroom is a private email platform${loaderData?.name ? ` by ${loaderData.name}` : ""}: sending, receiving and deliverability on Amazon SES.`,
			},
		],
	}),
	component: About,
});

function About() {
	const operator = Route.useLoaderData();
	return (
		<LegalPage title="Mailroom">
			<p>
				Mailroom is a private email platform {madeBy(operator)}. It sends the transactional
				email and newsletters of the organizations on it through Amazon SES, receives email
				for their domains, and watches deliverability: bounces, complaints, DMARC reports
				and blocklists.
			</p>
			<p>
				Mailroom can connect to Gmail Postmaster Tools to show each sending domain's spam
				rate and authentication statistics from Google. It can also let invited people sign
				in with their Google account.
			</p>
			<p>
				Mailroom isn't open for sign-ups. Only people invited to one of its organizations
				can use it.
			</p>
			<p>
				<Link to="/login">Sign in</Link> · <Link to="/privacy">Privacy policy</Link> ·{" "}
				<Link to="/terms">Terms of service</Link>
				{operator.contact && ` · Contact: ${operator.contact}`}
			</p>
		</LegalPage>
	);
}
