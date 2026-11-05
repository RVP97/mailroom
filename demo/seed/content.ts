/** What Acme's team wrote: automation emails, product broadcasts and the Journal's issues. */
import {
	ACME,
	appFooter,
	button,
	columns,
	divider,
	doc,
	footer,
	h,
	html,
	image,
	JOURNAL,
	JOURNAL_LOGO,
	logo,
	MEDIA,
	p,
	poll,
	quote,
	SITE,
	social,
	spacer,
} from "./designs";

const JOURNAL_SITE = "https://journal.acme.example";

/** Templates the automations send (they fill FIRST_NAME from the contact). */
export function automationTemplates() {
	const list = [
		{
			name: "Onboarding: first project",
			alias: "onboarding-tips",
			from: "Maya at Acme <maya@mail.acme.example>",
			subject: "Your first project in 10 minutes",
			design: doc(ACME, [
				logo(),
				h("Your first project in 10 minutes", 2),
				p(
					"Hi {{{FIRST_NAME|there}}}, the teams that stick with Acme do one thing in their first week: they move one real project in. Here's the shortest way:",
				),
				p(
					"<ol><li>Pick a project that's already in motion</li><li>Start from the Launch plan template</li><li>Invite the two people who ask you for updates</li></ol>",
				),
				button("Start from a template", `${SITE}/app/templates`),
				p("Maya, Customer success"),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Onboarding: nudge",
			alias: "onboarding-nudge",
			from: "Maya at Acme <maya@mail.acme.example>",
			subject: "Want a hand setting up?",
			design: doc(ACME, [
				logo(),
				p(
					"<p>Hi {{{FIRST_NAME|there}}},</p><p>I noticed you haven't started a project yet. If something got in the way, I'd love to hear it: reply and tell me what you're trying to do, and I'll set it up with you.</p><p>Or book 15 minutes with our team, whichever's easier.</p>",
				),
				button("Book a call", `${SITE}/onboarding-call`),
				p("Maya"),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Upgrade: thank you",
			alias: "upgrade-thanks",
			from: "Acme <hello@mail.acme.example>",
			subject: "You're on Acme Pro",
			design: doc(ACME, [
				logo(),
				h("Welcome to Pro, {{{FIRST_NAME|there}}}", 2),
				p(
					"Unlimited projects, guest access and reporting are on for your whole team. Two things worth a look today:",
				),
				columns(
					[h("Reports", 3), p("See what's slipping before the stand-up does.")],
					[h("Guests", 3), p("Bring clients into one project, nothing else.")],
				),
				button("Open reports", `${SITE}/app/reports`),
				divider(),
				appFooter(),
			]),
		},
		{
			name: "Journal: welcome",
			alias: "journal-welcome",
			from: "The Acme Journal <editors@journal.acme.example>",
			subject: "Welcome to The Acme Journal",
			design: doc(JOURNAL, [
				logo(JOURNAL_LOGO, "left", 150),
				h("Thanks for subscribing", 2),
				p(
					"<p>Hi {{{FIRST_NAME|there}}},</p><p>Every other Tuesday we send one long piece on how good teams plan, write and ship, and a few links we liked. No product pitches.</p><p>While you wait for the next issue, here are the three pieces readers forward most.</p>",
				),
				button("Read the favorites", `${JOURNAL_SITE}/best`),
				p("The editors"),
				footer("You're getting this because you subscribed to The Acme Journal."),
			]),
		},
		{
			name: "Journal: best of",
			alias: "journal-best-of",
			from: "The Acme Journal <editors@journal.acme.example>",
			subject: "Three pieces to start with",
			design: doc(JOURNAL, [
				logo(JOURNAL_LOGO, "left", 150),
				h("Three pieces to start with", 2),
				p(
					"<p><strong>Meetings that could have been documents</strong>: the memo culture that saved one team six hours a week.</p><p><strong>A quiet on-call</strong>: what changes when pages wake fewer people.</p><p><strong>Smaller releases</strong>: why shipping less, more often, felt slower and wasn't.</p>",
				),
				button("Read them", `${JOURNAL_SITE}/start`),
				footer("You're getting this because you subscribed to The Acme Journal."),
			]),
		},
	];
	return list.map((t) => ({ ...t, html: html(t.design, t.subject) }));
}

/** The Journal's issues, oldest first. */
export const ISSUES = [
	{
		subject: "Meetings that could have been documents",
		pre: "How one team got six hours a week back.",
		lede: "One team replaced its weekly status meeting with a two-paragraph memo. Six months in, nobody wants the meeting back.",
		art: "journal-1.svg",
	},
	{
		subject: "A quiet on-call",
		pre: "Fewer pages, better sleep, faster fixes.",
		lede: "When a page wakes three people, nobody owns it. When it wakes one, she fixes it. Notes from a year of quieter on-call.",
		art: "journal-2.svg",
	},
	{
		subject: "The case for smaller releases",
		pre: "Shipping less, more often, felt slower. It wasn't.",
		lede: "We cut our release size in half and our release count went up four times. Here's what the numbers said after a quarter.",
		art: "journal-3.svg",
	},
	{
		subject: "What 300 teams told us about planning",
		pre: "The survey results, and one surprise.",
		lede: "We asked 300 teams how far ahead they plan. Most said a quarter. The ones who hit their dates said two weeks.",
		art: "journal-4.svg",
		poll: true,
	},
	{
		subject: "Writing a bug report people read",
		pre: "Steps, expected, actual. And one more thing.",
		lede: "The best bug reports we've seen fit on a phone screen. A template, and the line most reports forget.",
		art: "journal-5.svg",
	},
	{
		subject: "Rituals that survive remote work",
		pre: "Which team habits last, and which quietly die.",
		lede: "Demos lasted. Retros lasted. The Friday all-hands didn't. What made the difference was who each ritual was for.",
		art: "journal-6.svg",
	},
	{
		subject: "Choosing boring technology, again",
		pre: "Every new tool costs an innovation token.",
		lede: "Ten years after the essay, the advice holds: spend your novelty where your product is different, and nowhere else.",
		art: "journal-7.svg",
	},
	{
		subject: "A field guide to roadmaps",
		pre: "Now, next, later, and why dates are a promise.",
		lede: "A roadmap is a conversation, not a contract. Three formats, when each one helps, and when it gets in the way.",
		art: "journal-8.svg",
	},
	{
		subject: "Notes on hiring your second engineer",
		pre: "The first hire is easy. The second one shapes the team.",
		lede: "Your first engineer is a partner. Your second is the first person who joins a team. What we look for, and what we ask.",
		art: "journal-9.svg",
	},
];

export function issueDesign(i: (typeof ISSUES)[number], number: number) {
	const url = `${JOURNAL_SITE}/issues/${number}`;
	return doc(JOURNAL, [
		logo(JOURNAL_LOGO, "left", 150),
		p(
			`<p style="font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#a8a29e">Issue ${number}</p>`,
		),
		h(i.subject, 1),
		image(`${MEDIA}/${i.art}`, i.subject, url),
		p(`<p>Hi {{{FIRST_NAME|there}}},</p><p>${i.lede}</p>`),
		button("Read the full piece", url),
		divider(),
		...(i.poll
			? [
					poll("How far ahead does your team plan?", [
						"Two weeks",
						"A month",
						"A quarter",
						"Longer",
					]),
					divider(),
				]
			: []),
		h("Worth your time", 3),
		p(
			`<ul><li><a href="${JOURNAL_SITE}/links/${number}-1">Why the best teams write things down</a></li><li><a href="${JOURNAL_SITE}/links/${number}-2">A short history of the stand-up</a></li><li><a href="${JOURNAL_SITE}/links/${number}-3">The two-pizza rule, revisited</a></li></ul>`,
		),
		quote("Plans are worthless, but planning is everything."),
		spacer(8),
		footer(
			"You're getting this because you subscribed to The Acme Journal. Forward it to a teammate who'd like it.",
		),
	]);
}

/** Acme's own product emails. */
export function productUpdate(title: string, lede: string, items: [string, string][], cta: string) {
	return doc(ACME, [
		logo(),
		image(`${MEDIA}/product-hero.svg`, title, `${SITE}/changelog`),
		h(title, 1),
		p(`Hi {{{FIRST_NAME|there}}}, ${lede}`),
		...items.flatMap(([t, d]) => [h(t, 3), p(d)]),
		button(cta, `${SITE}/changelog`),
		divider(),
		social(),
		footer(
			"Acme Inc. · 548 Market St, San Francisco, CA 94104<br>You're getting this because you use Acme.",
		),
	]);
}
