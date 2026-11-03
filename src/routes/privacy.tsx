import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { madeBy, operatorFn } from "@/functions/operator";

export const Route = createFileRoute("/privacy")({
	// Rendered on the server, so Google's branding review can read it.
	ssr: true,
	loader: () => operatorFn(),
	head: () => ({
		meta: [
			{ title: "Privacy policy · Mailroom" },
			{ name: "robots", content: "index, follow" },
		],
	}),
	component: Privacy,
});

function Privacy() {
	const operator = Route.useLoaderData();
	return (
		<LegalPage
			title="Privacy policy"
			updated="November 3, 2026"
		>
			<p>
				Mailroom{operator.host && ` (${operator.host})`} is a private email platform{" "}
				{madeBy(operator)}. It sends the transactional email and newsletters of the
				organizations on it through Amazon SES, receives email for their domains and
				monitors deliverability. This policy explains what data Mailroom collects, how it
				uses and protects it, and the choices you have. Only people invited to one of its
				organizations can sign in.
			</p>

			<h2>Data Mailroom collects</h2>
			<ul>
				<li>
					<strong>Account data:</strong> your name, email address and, if you add them,
					your passkeys or the Google account you sign in with. Mailroom also keeps your
					sign-in sessions (browser and IP address) to keep your account secure.
				</li>
				<li>
					<strong>Organization data:</strong> the sending domains, API keys (stored
					hashed), webhooks, templates and settings each organization configures.
				</li>
				<li>
					<strong>Email data:</strong> the emails the organizations send and receive
					(addresses, subject, content and attachments), their delivery events (delivered,
					bounced, complained, opened, clicked) and the contacts and suppression lists the
					organizations keep.
				</li>
				<li>
					<strong>Deliverability data:</strong> DNS checks, blocklist results, DMARC
					reports and, when connected, Gmail Postmaster Tools statistics for the
					organizations' own sending domains.
				</li>
			</ul>

			<h2>Data from Google</h2>
			<p>
				<strong>Sign in with Google.</strong> When you sign in with Google, Mailroom
				requests the openid, email and profile scopes and receives your name, email address
				and profile picture. It uses them only to identify you and sign you in to an account
				you were invited to. It doesn't create accounts for addresses that weren't invited.
			</p>
			<p>
				<strong>Gmail Postmaster Tools.</strong> When an administrator connects Gmail
				Postmaster Tools (the https://www.googleapis.com/auth/postmaster scope), Mailroom
				registers the organizations' own verified sending domains in that Postmaster Tools
				account and reads, once every six hours, the statistics Google reports for those
				domains: spam rate, SPF, DKIM and DMARC pass rates, TLS rates, delivery errors and
				bulk-sender compliance. Mailroom shows these statistics to the organizations'
				members in its Insights page. It stores the connection's refresh token and the
				connected account's email address in its database, which is encrypted at rest.
			</p>
			<p>
				Mailroom doesn't read, send or modify anyone's Gmail messages, contacts, calendar,
				files or any other Google data. It doesn't use Google data for advertising, doesn't
				sell it, doesn't transfer it to anyone except as needed to provide the features
				above, and doesn't use it to train AI or machine-learning models. No person reads
				Google data except with your permission, for security, or as the law requires.
			</p>
			<p>
				Mailroom's use and transfer of information received from Google APIs adheres to the{" "}
				<a href="https://developers.google.com/terms/api-services-user-data-policy">
					Google API Services User Data Policy
				</a>
				, including the Limited Use requirements.
			</p>

			<h2>How Mailroom uses data</h2>
			<ul>
				<li>To sign you in and keep your account secure.</li>
				<li>
					To send, receive and deliver the organizations' email and record what happened.
				</li>
				<li>
					To show the organizations their delivery, engagement and deliverability, and to
					alert their owners when something needs attention.
				</li>
				<li>To stop emailing addresses that bounced, complained or unsubscribed.</li>
			</ul>

			<h2>Sharing and service providers</h2>
			<p>
				Mailroom doesn't sell or rent personal data and doesn't share it for advertising. It
				uses these providers, which process data only on its behalf: Cloudflare (hosting,
				database and storage), Amazon Web Services (Amazon SES for sending and receiving
				email) and Google (sign-in and Postmaster Tools). Mailroom may disclose data if the
				law requires it.
			</p>

			<h2>Retention and deletion</h2>
			<p>
				Email content and events are kept for as long as each organization's retention
				setting says, then moved to that organization's archive until deletion is requested.
				Account data is kept while your account exists. When you disconnect Gmail Postmaster
				Tools, Mailroom deletes the stored token at once; the statistics it already showed
				stay with the organization's other reports. To have your account and its data
				deleted, write to {operator.contact || "its administrator"} and it will be done
				within 30 days.
			</p>

			<h2>Security</h2>
			<p>
				Data travels over HTTPS and is stored with Cloudflare and AWS, encrypted at rest.
				API keys are stored hashed. Access is limited to the members of each organization
				and to Mailroom's administrator.
			</p>

			<h2>Your choices</h2>
			<ul>
				<li>Add or remove passkeys from your account page.</li>
				<li>
					Remove Mailroom's access to your Google account at any time from{" "}
					<a href="https://myaccount.google.com/permissions">
						myaccount.google.com/permissions
					</a>
					, or ask an administrator to disconnect Postmaster Tools.
				</li>
				<li>Ask for a copy, correction or deletion of your data by email.</li>
			</ul>

			<h2>Changes and contact</h2>
			<p>
				If this policy changes, the date at the top changes too. Questions or requests:{" "}
				{[operator.name, operator.contact].filter(Boolean).join(", ") ||
					"Mailroom's administrator"}
				.
			</p>
		</LegalPage>
	);
}
