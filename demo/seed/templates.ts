/** Acme's transactional templates: what its app sends through the API by alias. */
import { ACME, appFooter, button, divider, doc, h, html, logo, p, SITE } from "./designs";

const v = (key: string, fallback?: string | number, type: "string" | "number" = "string") => ({
	key,
	type,
	...(fallback !== undefined ? { fallback_value: fallback } : {}),
});

export function templates() {
	const list = [
		{
			name: "Welcome",
			alias: "welcome",
			from: "Acme <hello@mail.acme.example>",
			subject: "Welcome to Acme, {{{NAME}}}",
			variables: [v("NAME", "there"), v("DASHBOARD_URL", `${SITE}/app`)],
			design: doc(ACME, [
				logo(),
				h("Welcome to Acme, {{{NAME}}}"),
				p("Your workspace is ready. Three things most teams do first:"),
				p(
					"<ol><li>Invite the people you work with</li><li>Connect your calendar</li><li>Create your first project from a template</li></ol>",
				),
				button("Open your workspace", "{{{DASHBOARD_URL}}}"),
				p("If you get stuck, reply to this email: a person reads every one.", "left"),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Sign-in code",
			alias: "sign-in-code",
			from: "Acme <security@mail.acme.example>",
			subject: "{{{CODE}}} is your Acme sign-in code",
			variables: [v("CODE"), v("DEVICE", "a new device")],
			design: doc(ACME, [
				logo(),
				h("Your sign-in code", 2),
				p("Enter this code to finish signing in on {{{DEVICE}}}. It works for 10 minutes."),
				h(
					'<span style="letter-spacing:6px;font-family:monospace">{{{CODE}}}</span>',
					1,
					"center",
				),
				p(
					"Didn't try to sign in? You can ignore this email; nobody gets in without the code.",
				),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Password reset",
			alias: "password-reset",
			from: "Acme <security@mail.acme.example>",
			subject: "Reset your Acme password",
			variables: [v("NAME", "there"), v("RESET_URL")],
			design: doc(ACME, [
				logo(),
				h("Reset your password", 2),
				p(
					"Hi {{{NAME}}}, someone asked to reset the password of your Acme account. The link works for one hour.",
				),
				button("Choose a new password", "{{{RESET_URL}}}"),
				p("If it wasn't you, nothing changes until the link is used."),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Payment receipt",
			alias: "receipt",
			from: "Acme Billing <billing@mail.acme.example>",
			subject: "Receipt for your Acme {{{PLAN}}} plan",
			variables: [
				v("PLAN", "Pro"),
				v("AMOUNT", "$24.00"),
				v("INVOICE", "INV-0000"),
				v("INVOICE_URL", `${SITE}/billing`),
			],
			design: doc(ACME, [
				logo(),
				h("Thanks for your payment", 2),
				p(
					"<p><strong>{{{AMOUNT}}}</strong> for Acme {{{PLAN}}}, invoice {{{INVOICE}}}.</p><p>The card on file was charged. A PDF copy is on the billing page.</p>",
				),
				button("View invoice", "{{{INVOICE_URL}}}"),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Trial ending",
			alias: "trial-ending",
			from: "Acme <hello@mail.acme.example>",
			subject: "Your Acme trial ends in {{{DAYS_LEFT}}} days",
			variables: [v("NAME", "there"), v("DAYS_LEFT", 3, "number")],
			design: doc(ACME, [
				logo(),
				h("Your trial ends in {{{DAYS_LEFT}}} days", 2),
				p(
					"Hi {{{NAME}}}, everything you made stays when the trial ends. Pick a plan to keep your team's projects in sync.",
				),
				button("Choose a plan", `${SITE}/pricing`),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Team invitation",
			alias: "team-invite",
			from: "Acme <hello@mail.acme.example>",
			subject: "{{{INVITER}}} invited you to {{{TEAM}}} on Acme",
			variables: [v("INVITER"), v("TEAM"), v("INVITE_URL", `${SITE}/join`)],
			design: doc(ACME, [
				logo(),
				h("Join {{{TEAM}}} on Acme", 2),
				p("{{{INVITER}}} wants you on the team. Accept to see its projects and boards."),
				button("Accept the invitation", "{{{INVITE_URL}}}"),
				divider(),
				appFooter(),
			]),
		},
	];
	return list.map((t) => ({ ...t, html: html(t.design, t.subject) }));
}

/** A template still being written: saved, never published. */
export function draftTemplate() {
	const design = doc(ACME, [
		logo(),
		h("Your week in Acme", 2),
		p("{{{COMPLETED}}} tasks done, {{{OPEN}}} still open. Here's what moved."),
		button("See the report", `${SITE}/app/reports`),
		divider(),
		appFooter(),
	]);
	return {
		name: "Weekly summary",
		alias: "weekly-summary",
		from: "Acme <hello@mail.acme.example>",
		subject: "Your week in Acme",
		variables: [v("COMPLETED", 0, "number"), v("OPEN", 0, "number")],
		design,
		html: html(design),
	};
}
