/**
 * Ready-made automations: a new one can start from one of these, as a draft with real words to
 * change (its quick emails come from the brand's first verified domain).
 */

export type RecipeContext = { from: string; team: string[] };

export type Recipe = {
	id: string;
	name: string;
	description: string;
	group: "Marketing" | "Sales" | "Support";
	build: (c: RecipeContext) => {
		name: string;
		trigger: Record<string, unknown>;
		steps: Record<string, unknown>[];
		goal_event?: string;
		reentry?: boolean;
	};
};

const email = (c: RecipeContext, subject: string, body: string) => ({
	type: "email",
	from: c.from,
	subject,
	body,
});

export const RECIPES: Recipe[] = [
	{
		id: "welcome",
		name: "Welcome series",
		description: "Two emails for new contacts, the second only if they missed the first.",
		group: "Marketing",
		build: (c) => ({
			name: "Welcome series",
			trigger: { type: "contact.created" },
			steps: [
				email(
					c,
					"Welcome, {{{FIRST_NAME|friend}}}",
					"Hi {{{FIRST_NAME|there}}},\n\nThanks for joining us. Here's what to expect from us, and how to get the most out of it.\n\nTalk soon.",
				),
				{ type: "wait", days: 3 },
				{
					type: "condition",
					engaged: "opened",
					no: [
						email(
							c,
							"In case you missed it",
							"Hi {{{FIRST_NAME|there}}},\n\nJust making sure our welcome reached you. Reply to this email any time: a person reads every one.",
						),
					],
				},
			],
		}),
	},
	{
		id: "welcome_ab",
		name: "A/B test a welcome",
		description: "Half get one welcome, half another: see which one people open more.",
		group: "Marketing",
		build: (c) => ({
			name: "Welcome A/B test",
			trigger: { type: "contact.created" },
			steps: [
				{
					type: "split",
					percent: 50,
					no: [
						email(
							c,
							"You're in, {{{FIRST_NAME|friend}}} 🎉",
							"Hi {{{FIRST_NAME|there}}},\n\nYou're in! Here's the one thing to do first.",
						),
					],
				},
				email(
					c,
					"Welcome to the family",
					"Hi {{{FIRST_NAME|there}}},\n\nWelcome. We're glad you're here. Here's where to start.",
				),
			],
		}),
	},
	{
		id: "abandoned",
		name: "Finish the booking",
		description: "When someone starts a booking and doesn't finish within a day, remind them.",
		group: "Sales",
		build: (c) => ({
			name: "Finish the booking",
			trigger: { type: "event", event: "booking.started" },
			reentry: true,
			goal_event: "booking.created",
			steps: [
				{
					type: "wait_event",
					event: "booking.created",
					days: 1,
					no: [
						email(
							c,
							"Still thinking it over?",
							"Hi {{{FIRST_NAME|there}}},\n\nYou were looking at {{{event.room|a room}}} with us. It's still available: pick up where you left off whenever you're ready.\n\nAny questions? Just reply.",
						),
					],
				},
			],
		}),
	},
	{
		id: "nurture",
		name: "Nurture new leads",
		description:
			"Three emails over a week for people who sign up on a form, stopping when they buy.",
		group: "Sales",
		build: (c) => ({
			name: "Nurture new leads",
			trigger: { type: "form.submitted" },
			goal_event: "purchase",
			steps: [
				email(
					c,
					"Here's what you asked for",
					"Hi {{{FIRST_NAME|there}}},\n\nThanks for signing up. Here's a quick guide to get started.",
				),
				{ type: "wait", days: 2 },
				email(
					c,
					"How others use it",
					"Hi {{{FIRST_NAME|there}}},\n\nA few stories from people like you, and what changed for them.",
				),
				{ type: "wait", days: 4 },
				email(
					c,
					"A little something to get started",
					"Hi {{{FIRST_NAME|there}}},\n\nIf you're ready, here's 10% off your first order. It's good for a week.",
				),
			],
		}),
	},
	{
		id: "birthday",
		name: "Happy birthday",
		description: "An email on each contact's birthday, every year (needs a birthday property).",
		group: "Marketing",
		build: (c) => ({
			name: "Happy birthday",
			trigger: { type: "date", key: "birthday", offset_days: 0, yearly: true },
			steps: [
				email(
					c,
					"Happy birthday, {{{FIRST_NAME|friend}}}! 🎂",
					"Hi {{{FIRST_NAME|there}}},\n\nHappy birthday from all of us. Here's a little gift: something on us next time you visit.",
				),
			],
		}),
	},
	{
		id: "winback",
		name: "Win back quiet contacts",
		description:
			"When someone hasn't opened anything in 60 days, check in, then try once more.",
		group: "Marketing",
		build: (c) => ({
			name: "Win back quiet contacts",
			trigger: { type: "inactive", days: 60 },
			steps: [
				email(
					c,
					"We miss you, {{{FIRST_NAME|friend}}}",
					"Hi {{{FIRST_NAME|there}}},\n\nIt's been a while. Still want to hear from us? Here's what's new since you last looked.",
				),
				{ type: "wait", days: 7 },
				{
					type: "condition",
					engaged: "opened",
					no: [
						email(
							c,
							"Should we stop writing?",
							"Hi {{{FIRST_NAME|there}}},\n\nWe don't want to crowd your inbox. If you'd rather not hear from us, the link below takes you off the list in one click. No hard feelings.",
						),
					],
				},
			],
		}),
	},
	{
		id: "review",
		name: "Ask for a review after a stay",
		description: "A day after your app says a stay ended, ask how it went.",
		group: "Marketing",
		build: (c) => ({
			name: "Ask for a review",
			trigger: { type: "event", event: "stay.ended" },
			reentry: true,
			steps: [
				{ type: "wait", days: 1 },
				email(
					c,
					"How was your stay, {{{FIRST_NAME|friend}}}?",
					"Hi {{{FIRST_NAME|there}}},\n\nThanks for staying with us. Would you take a minute to tell us how it went? Every review helps us get better.",
				),
			],
		}),
	},
	{
		id: "unhappy",
		name: "Catch unhappy customers",
		description:
			"A rating of 2 stars or less makes the conversation urgent and tells the team.",
		group: "Support",
		build: (c) => ({
			name: "Catch unhappy customers",
			trigger: { type: "conversation.rated", op: "at_most", rating: 2 },
			reentry: true,
			steps: [
				{ type: "conversation", action: "priority", value: "urgent" },
				{ type: "conversation", action: "tag", value: "unhappy" },
				...(c.team.length
					? [
							{
								type: "notify",
								to: c.team.slice(0, 1),
								message:
									"{{{FIRST_NAME|A customer}}} rated their conversation {{{event.rating}}} stars. Worth a personal reply today.",
							},
						]
					: []),
			],
		}),
	},
	{
		id: "followup",
		name: "Follow up after support",
		description: "Three days after a conversation is resolved, check everything's still fine.",
		group: "Support",
		build: (c) => ({
			name: "Follow up after support",
			trigger: { type: "conversation.resolved" },
			reentry: true,
			steps: [
				{ type: "wait", days: 3 },
				email(
					c,
					"All good, {{{FIRST_NAME|friend}}}?",
					"Hi {{{FIRST_NAME|there}}},\n\nJust checking in after we talked: is everything working as it should? Reply here if anything's still off.",
				),
			],
		}),
	},
	{
		id: "dunning",
		name: "Failed payment recovery (dunning)",
		description:
			"Triggered automatically by Stripe, Polar, or Lemon Squeezy when a payment fails; stops once paid.",
		group: "Sales",
		build: (c) => ({
			name: "Failed payment recovery",
			trigger: { type: "event", event: "billing.payment_failed" },
			reentry: true,
			goal_event: "billing.payment_succeeded",
			steps: [
				email(
					c,
					"Quick heads-up: your payment didn't go through",
					"Hi {{{FIRST_NAME|there}}},\n\nWe tried to renew your subscription, but the card on file was declined. Update your payment method so there's no interruption.\n\nReply here if you need a hand.",
				),
				{
					type: "wait_event",
					event: "billing.payment_succeeded",
					days: 3,
					no: [
						email(
							c,
							"Action needed: keep your account active",
							"Hi {{{FIRST_NAME|there}}},\n\nJust a quick reminder that your latest invoice is still unpaid. Update your billing details today or reply if you'd like us to extend the grace period.",
						),
					],
				},
			],
		}),
	},
	{
		id: "trial_ending",
		name: "Trial ending reminder",
		description:
			"Nudges trialing customers 3 days before their trial expires (works with Stripe billing.trial_ending).",
		group: "Sales",
		build: (c) => ({
			name: "Trial ending reminder",
			trigger: { type: "event", event: "billing.trial_ending" },
			goal_event: "billing.payment_succeeded",
			steps: [
				email(
					c,
					"Your trial wraps up in 3 days",
					"Hi {{{FIRST_NAME|there}}},\n\nYour trial ends soon. Have you had a chance to try everything you needed? Hit reply if you want a quick walkthrough or a few extra days.",
				),
			],
		}),
	},
	{
		id: "churn_winback",
		name: "Subscription churn feedback & win-back",
		description: "Asks why someone canceled right away, then checks back in 14 days later.",
		group: "Marketing",
		build: (c) => ({
			name: "Subscription churn win-back",
			trigger: { type: "event", event: "billing.subscription_canceled" },
			reentry: true,
			goal_event: "billing.subscription_started",
			steps: [
				email(
					c,
					"Sorry to see you go — one quick question?",
					"Hi {{{FIRST_NAME|there}}},\n\nWe saw you canceled your plan. If you have 10 seconds, what was the main reason? Every reply goes straight to our team.",
				),
				{ type: "wait", days: 14 },
				email(
					c,
					"We've shipped a few updates since you left",
					"Hi {{{FIRST_NAME|there}}},\n\nJust checking in — if anything was missing before, reply and let us know. Your workspace is still ready whenever you want to jump back in.",
				),
			],
		}),
	},
];
