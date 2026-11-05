/**
 * Months of Acme's email, played forward through the app's own code: its app signing people up and
 * sending through the API, the team's broadcasts and newsletter, sign-up forms, automations, and
 * the cron that moves them all. An agenda of what happened when, with the cron's hourly run between.
 */

import { and, eq } from "drizzle-orm";
import { createAutomation } from "@/server/automations";
import { createBroadcast, resendBroadcast, sendBroadcast } from "@/server/broadcasts";
import { createCampaign } from "@/server/campaigns";
import { createProperty, createSegment, createTopic, importContacts } from "@/server/contacts";
import { runCron } from "@/server/cron";
import { db, schema } from "@/server/db";
import { createNewsletter } from "@/server/newsletters";
import { handlePoll, pollBase } from "@/server/polls";
import { referralCode } from "@/server/referrals";
import { confirmToken, createForm, handleSubscribe } from "@/server/signup-forms";
import { createTemplate } from "@/server/templates";
import { unsubscribe } from "@/server/unsubscribes";
import { createWebhook } from "@/server/webhook-admin";
import { at, realNow } from "../clock";
import { flushSes } from "../ses";
import { runDispatcher, settle } from "../shims/cloudflare-workers";
import { api } from "./api";
import { automationTemplates, ISSUES, issueDesign, productUpdate } from "./content";
import { ORG } from "./ids";
import { type Person, people } from "./people";
import { type Ctx, DAY, HOUR } from "./setup";
import { random } from "./time";

type Step = { t: number; label: string; run: () => Promise<unknown> };

const COMPANIES = [
	"Northwind",
	"Initech",
	"Umbrella Labs",
	"Stark Studio",
	"Wayne Logistics",
	"Hooli",
	"Vandelay",
	"Soylent",
	"Tyrell",
	"Cyberdyne",
	"Wonka",
	"Gringotts",
];

export async function timeline(ctx: Ctx) {
	const r = random(11);
	const agenda: Step[] = [];
	const add = (t: number, label: string, run: () => Promise<unknown>) =>
		agenda.push({ t, label, run });
	const pick = <T>(list: T[]) => list[Math.floor(r() * list.length)] as T;
	const send = (body: Record<string, unknown>, agent = 0) =>
		api(ctx.token, "POST", "/emails", body, { agent, ok: false });
	const tpl = (id: string, variables: Record<string, unknown>) => ({ id, variables });
	const ids: Record<string, string> = {};

	// ── Acme, the app ───────────────────────────────────────────────────────────────────────
	const customers = people(240, 3).map((x) => ({
		...x,
		plan: x.plan === "free" ? "pro" : x.plan,
	}));
	const signups = people(700, 5).filter((x) => !customers.some((c) => c.email === x.email));
	const active: Person[] = [...customers];

	add(ctx.ago(170, 9), "automation templates", async () => {
		for (const t of automationTemplates()) {
			const row = await createTemplate(ORG, t, { publish: true });
			ids[t.alias] = row.id;
		}
	});
	add(ctx.ago(126, 9), "acme audience", async () => {
		await createProperty(ORG, { key: "plan", type: "string", fallback_value: "free" });
		await createProperty(ORG, { key: "company", type: "string" });
		await createProperty(ORG, { key: "seats", type: "number", fallback_value: 1 });
		ids.customers = (await createSegment(ORG, { name: "Customers" })).id;
		ids.trials = (await createSegment(ORG, { name: "Trial users" })).id;
		ids.beta = (await createSegment(ORG, { name: "Beta testers" })).id;
		ids.product = (
			await createTopic(ORG, {
				name: "Product updates",
				description: "What's new in Acme, about once a month.",
				default_subscription: "opt_out",
			})
		).id;
		ids.events = (
			await createTopic(ORG, {
				name: "Webinars and events",
				description: "Live sessions with the team.",
				default_subscription: "opt_in",
			})
		).id;
		await importContacts(
			ORG,
			customers.map((c) => ({
				email: c.email,
				first_name: c.first,
				last_name: c.last,
				properties: {
					plan: c.plan,
					company: pick(COMPANIES),
					seats: c.plan === "team" ? 5 + Math.floor(r() * 40) : 1 + Math.floor(r() * 4),
				},
			})),
			{ segment: ids.customers },
		);
		// A few of them test new features.
		for (const c of customers.slice(0, 36))
			await api(
				ctx.token,
				"POST",
				`/contacts/${encodeURIComponent(c.email)}/segments/${ids.beta}`,
			);
	});

	add(ctx.ago(124, 15), "acme automations", async () => {
		await createAutomation(ORG, {
			name: "Trial onboarding",
			status: "active",
			trigger: { type: "segment.joined", segment_id: ids.trials },
			steps: [
				{ type: "wait", days: 1 },
				{ type: "send", template_id: ids["onboarding-tips"] },
				{ type: "wait", days: 4 },
				{
					type: "condition",
					engaged: "clicked",
					no: [{ type: "send", template_id: ids["onboarding-nudge"] }],
				},
				{ type: "wait", days: 6 },
				{ type: "condition", segment_id: ids.trials, no: [] },
				{
					type: "send",
					template_id: (await tplId("trial-ending")) as string,
					variables: { DAYS_LEFT: 3 },
				},
			],
		});
		await createAutomation(ORG, {
			name: "Upgrade to Pro",
			status: "active",
			trigger: { type: "event", event: "plan.upgraded" },
			steps: [
				{ type: "segment", action: "remove", segment_id: ids.trials },
				{ type: "segment", action: "add", segment_id: ids.customers },
				{ type: "property", key: "plan", value: "pro" },
				{ type: "send", template_id: ids["upgrade-thanks"] },
			],
		});
	});
	// Webhooks, lately (each delivery is kept, and there are many).
	add(ctx.ago(21, 16), "webhooks", async () => {
		await createWebhook(ORG, {
			url: "https://api.acme.example/hooks/mailroom",
			events: ["email.bounced", "email.complained", "email.clicked", "email.failed"],
		});
		await createWebhook(ORG, {
			url: "https://hooks.acme.example/crm-sync",
			events: ["email.bounced", "email.complained", "email.unsubscribed"],
		});
	});
	add(ctx.ago(8, 16), "acme draft automation", () =>
		createAutomation(ORG, {
			name: "Win back quiet customers",
			status: "draft",
			trigger: { type: "event", event: "account.inactive" },
			steps: [
				{
					type: "send",
					template_id: ids["onboarding-nudge"],
					subject: "We miss you at Acme",
				},
				{ type: "wait", days: 7 },
				{
					type: "condition",
					engaged: "opened",
					no: [{ type: "property", key: "plan", value: "churn-risk" }],
				},
			],
		}),
	);

	// Every day: sign-ups, sign-in codes, resets, receipts, invitations.
	for (let d = 92; d >= 0; d--) {
		const growth = 1 + (92 - d) / 60;
		const n = Math.round((2 + r() * 3) * growth);
		for (let i = 0; i < n && signups.length; i++) {
			const x = signups.shift() as Person;
			const t = ctx.ago(d, 7 + Math.floor(r() * 15)) + Math.floor(r() * 50) * 60_000;
			add(t, "signup", async () => {
				await api(ctx.token, "POST", "/contacts", {
					email: x.email,
					first_name: x.first,
					last_name: x.last,
					properties: { plan: "trial", company: pick(COMPANIES), seats: 1 },
					segments: [ids.trials],
					source: "app",
				});
				await send({
					to: x.email,
					template: tpl("welcome", {
						NAME: x.first,
						DASHBOARD_URL: "https://acme.example/app",
					}),
					tags: [{ name: "kind", value: "welcome" }],
				});
				await send({
					to: x.email,
					template: tpl("sign-in-code", {
						CODE: String(100000 + Math.floor(r() * 899999)),
						DEVICE: pick([
							"Chrome on macOS",
							"Safari on iPhone",
							"Firefox on Windows",
							"the Acme app for Android",
						]),
					}),
					tags: [{ name: "kind", value: "auth" }],
				});
				active.push(x);
			});
			// About a third upgrade before their trial ends.
			if (r() < 0.34) {
				const up = t + (8 + r() * 6) * DAY;
				if (up < ctx.now - HOUR) {
					add(up, "upgrade", async () => {
						await api(ctx.token, "POST", "/events", {
							event: "plan.upgraded",
							email: x.email,
							data: { plan: "pro", seats: 3 },
						});
						await send({
							to: x.email,
							template: tpl("receipt", {
								PLAN: "Pro",
								AMOUNT: "$24.00",
								INVOICE: `INV-${2400 + agenda.length}`,
							}),
							tags: [{ name: "kind", value: "billing" }],
						});
					});
					for (let m = up + 30 * DAY; m < ctx.now; m += 30 * DAY)
						add(m, "renewal", () =>
							send({
								to: x.email,
								template: tpl("receipt", {
									PLAN: "Pro",
									AMOUNT: "$24.00",
									INVOICE: `INV-${3100 + Math.floor(r() * 900)}`,
								}),
								tags: [{ name: "kind", value: "billing" }],
							}),
						);
				}
			}
		}
		const t = (h: number) => ctx.ago(d, h) + Math.floor(r() * 59) * 60_000;
		add(t(8), "daily", async () => {
			for (let i = 0; i < 3 + Math.floor(r() * 4); i++) {
				const x = pick(active);
				await send(
					{
						to: x.email,
						template: tpl("sign-in-code", {
							CODE: String(100000 + Math.floor(r() * 899999)),
						}),
						tags: [{ name: "kind", value: "auth" }],
					},
					1,
				);
			}
		});
		add(t(14), "resets", async () => {
			for (let i = 0; i < 1 + Math.floor(r() * 3); i++) {
				const x = pick(active);
				await send(
					{
						to: x.email,
						template: tpl("password-reset", {
							NAME: x.first,
							RESET_URL: `https://acme.example/reset/${Math.floor(r() * 1e9).toString(36)}`,
						}),
						tags: [{ name: "kind", value: "auth" }],
					},
					1,
				);
			}
		});
		// Customers imported earlier renew on their own day of the month.
		add(t(6), "renewals", async () => {
			for (const c of customers.filter((_, i) => i % 30 === d % 30))
				await send(
					{
						to: c.email,
						template: tpl("receipt", {
							PLAN: c.plan === "team" ? "Team" : "Pro",
							AMOUNT: c.plan === "team" ? "$96.00" : "$24.00",
							INVOICE: `INV-${1000 + Math.floor(r() * 9000)}`,
						}),
						tags: [{ name: "kind", value: "billing" }],
					},
					2,
				);
		});
		if (r() < 0.7)
			add(t(11), "invite", async () => {
				const from = pick(active);
				const to = `${pick(["sam", "alex", "jo", "kai", "lee", "max", "rae", "ivy"])}.${pick(["ortiz", "park", "berg", "mensah", "hale"])}${Math.floor(r() * 99)}@example.com`;
				await send({
					to,
					template: tpl("team-invite", {
						INVITER: `${from.first} ${from.last}`,
						TEAM: pick(COMPANIES),
						INVITE_URL: "https://acme.example/join/t",
					}),
					tags: [{ name: "kind", value: "invite" }],
				});
			});
		// Now and then, an address that's gone (it bounces, then the next send is suppressed).
		if (d % 9 === 4)
			add(t(16), "bad address", async () => {
				const to = `old-address.${d}@example.com`;
				await send({ to, template: tpl("welcome", { NAME: "there" }) });
				await at(Date.now() + 2 * HOUR, () =>
					send({
						to,
						template: tpl("password-reset", {
							NAME: "there",
							RESET_URL: "https://acme.example/reset/x",
						}),
					}),
				);
			});
	}
	// A reminder the app scheduled for tomorrow.
	add(ctx.ago(0, 1), "scheduled", () =>
		send({
			to: customers[3]?.email,
			template: tpl("trial-ending", { NAME: customers[3]?.first ?? "there", DAYS_LEFT: 1 }),
			scheduled_at: new Date(ctx.now + 20 * HOUR).toISOString(),
		}),
	);

	// ── Acme's broadcasts ───────────────────────────────────────────────────────────────────
	const news = "Acme <news@news.acme.example>";
	const broadcast = (
		when: number,
		label: string,
		body: Record<string, unknown>,
		o: { ab?: string[]; at?: number; key?: string } = {},
	) =>
		add(when, label, async () => {
			const x = await createBroadcast(
				ORG,
				ORG,
				{ from: news, topic_id: ids.product, segment_id: ids.customers, ...body },
				Date.now(),
				"user_jonas",
			);
			if (o.key) ids[o.key] = x.id;
			await at(Date.now() + 40 * 60_000, () =>
				sendBroadcast(
					ORG,
					x.id,
					o.at ? new Date(o.at).toISOString() : null,
					Date.now(),
					o.ab
						? {
								ab_test: {
									subjects: o.ab,
									metric: "opens",
									size: 20,
									wait_minutes: 240,
								},
							}
						: {},
				),
			);
		});
	broadcast(ctx.ago(74, 15), "september", {
		name: "September product update",
		subject: "What's new in Acme: September",
		preview_text: "Recurring tasks, faster search, and a dark mode.",
		design: productUpdate(
			"What's new in September",
			"here's what shipped this month.",
			[
				["Recurring tasks", "Weekly reports and monthly reviews now make themselves."],
				["Search in a blink", "Results show as you type, across every project."],
				["Dark mode", "Easier on the eyes after six."],
			],
			"See the changelog",
		),
	});
	broadcast(ctx.ago(43, 15), "october", {
		name: "October product update",
		subject: "What's new in Acme: October",
		preview_text: "Guest access, a calendar view, and Slack threads.",
		design: productUpdate(
			"What's new in October",
			"three things you asked for most.",
			[
				["Guest access", "Bring a client into one project, and nothing else."],
				["Calendar view", "Every due date on one screen, drag to move it."],
				["Slack threads", "Comments on a task land in the thread it came from."],
			],
			"See the changelog",
		),
	});
	add(ctx.ago(30, 10), "campaign", async () => {
		ids.launch = (
			await createCampaign(ORG, {
				name: "Acme 3.0 launch",
				description: "Teaser, launch day and the webinar.",
				starts_on: isoDay(ctx.ago(18)),
				ends_on: isoDay(ctx.now + 5 * DAY),
			})
		).id;
	});
	add(ctx.ago(18, 16), "teaser", async () => {
		const x = await createBroadcast(
			ORG,
			ORG,
			{
				from: news,
				name: "3.0 teaser",
				subject: "Something big on the 22nd",
				preview_text: "A first look at Acme 3.0.",
				campaign_id: ids.launch,
				segment_id: ids.customers,
				topic_id: ids.product,
				design: productUpdate(
					"Acme 3.0 is almost here",
					"next week we're shipping the biggest update since we started. A first look:",
					[
						[
							"Plans that update themselves",
							"Move one date and everything after it follows.",
						],
						[
							"A home for every team",
							"Each team gets its own space, settings and views.",
						],
					],
					"Save your seat for the webinar",
				),
			},
			Date.now(),
			"user_jonas",
		);
		await at(Date.now() + 30 * 60_000, () =>
			sendBroadcast(ORG, x.id, null, Date.now(), {
				ab_test: {
					subjects: [
						"A first look at Acme 3.0",
						"Plans that update themselves: Acme 3.0",
					],
					metric: "opens",
					size: 20,
					wait_minutes: 240,
				},
			}),
		);
	});
	add(ctx.ago(13, 14), "launch", async () => {
		const x = await createBroadcast(
			ORG,
			ORG,
			{
				from: news,
				name: "3.0 launch",
				subject: "Acme 3.0 is here",
				preview_text: "Plans that update themselves, and a home for every team.",
				campaign_id: ids.launch,
				segment_id: ids.customers,
				topic_id: ids.product,
				design: productUpdate(
					"Acme 3.0 is here",
					"it's live for every workspace today. What's new:",
					[
						[
							"Plans that update themselves",
							"Move one date and everything after it follows.",
						],
						[
							"A home for every team",
							"Each team gets its own space, settings and views.",
						],
						[
							"Reports you'll actually read",
							"One page a week, in your inbox on Monday.",
						],
					],
					"See what's new",
				),
			},
			Date.now(),
			"user_jonas",
		);
		ids.launchBroadcast = x.id;
		await at(Date.now() + 20 * 60_000, () => sendBroadcast(ORG, x.id));
	});
	add(ctx.ago(11, 15), "resend", async () => {
		const copy = await resendBroadcast(
			ORG,
			ids.launchBroadcast as string,
			{ subject: "In case you missed it: Acme 3.0", audience: "unopened" } as never,
		).catch((e) => {
			console.warn("[demo] resend", e.message);
			return null;
		});
		if (copy) await at(Date.now() + 10 * 60_000, () => sendBroadcast(ORG, copy.id));
	});
	add(ctx.ago(1, 11), "webinar", async () => {
		const x = await createBroadcast(
			ORG,
			ORG,
			{
				from: news,
				name: "Webinar invitation",
				subject: "Live: planning a quarter with Acme 3.0",
				preview_text: "45 minutes, with questions at the end.",
				campaign_id: ids.launch,
				segment_id: ids.customers,
				topic_id: ids.events,
				design: productUpdate(
					"Planning a quarter with Acme 3.0",
					"join Maya and Jonas for 45 minutes on how teams plan with 3.0, with time for your questions.",
					[["Thursday, 5 pm UTC", "A recording goes to everyone who signs up."]],
					"Save your seat",
				),
			},
			Date.now(),
			"user_jonas",
		);
		await sendBroadcast(ORG, x.id, new Date(ctx.now + 2 * DAY + 3 * HOUR).toISOString());
	});
	add(ctx.ago(0, 2), "november draft", async () => {
		const x = await createBroadcast(
			ORG,
			ORG,
			{
				from: news,
				name: "November product update",
				subject: "What's new in Acme: November",
				preview_text: "Templates for every team, and offline mode.",
				segment_id: ids.customers,
				topic_id: ids.product,
				design: productUpdate(
					"What's new in November",
					"the first update since 3.0.",
					[
						["Team templates", "Start a project the way your team always does."],
						["Offline mode", "Keep working on a plane; it syncs when you land."],
					],
					"See the changelog",
				),
			},
			Date.now(),
			"user_priya",
		);
		await db
			.update(schema.broadcasts)
			.set({
				review: "requested",
				review_requested_by: "user_priya",
				review_requested_at: new Date().toISOString(),
			})
			.where(eq(schema.broadcasts.id, x.id));
	});

	// ── The Acme Journal ────────────────────────────────────────────────────────────────────
	const J = ctx.journal;
	const founding = people(300, 21);
	const readers = people(460, 23).filter((x) => !founding.some((f) => f.email === x.email));
	const subscribed: Person[] = [...founding];
	add(ctx.ago(158, 10), "journal setup", async () => {
		ids.jsubs = (await createSegment(J, { name: "Subscribers" })).id;
		ids.jfounding = (await createSegment(J, { name: "Founding readers" })).id;
		ids.jissue = (
			await createTopic(J, {
				name: "The Journal",
				description: "Every other Tuesday.",
				default_subscription: "opt_out",
			})
		).id;
		ids.jjobs = (
			await createTopic(J, {
				name: "Job board",
				description: "Jobs at teams we like, monthly.",
				default_subscription: "opt_in",
			})
		).id;
		const form = await createForm(J, {
			name: "Website footer",
			title: "The Acme Journal",
			segment_id: ids.jsubs,
			from: "The Acme Journal <editors@journal.acme.example>",
			ask_name: true,
			website: "https://journal.acme.example",
			design: {
				heading: "Get the Journal",
				text: "One long piece every other Tuesday. No spam.",
				button: "Subscribe",
				accent: "#b45309",
			},
		});
		ids.form = form.id;
		ids.form2 = (
			await createForm(J, {
				name: "Article pop-up",
				title: "The Acme Journal",
				segment_id: ids.jsubs,
				from: "The Acme Journal <editors@journal.acme.example>",
				website: "https://journal.acme.example",
				design: {
					heading: "Liked this piece?",
					text: "Get the next one in your inbox.",
					button: "Send me the next one",
				},
			})
		).id;
		ids.newsletter = (
			await createNewsletter(J, {
				name: "The Acme Journal",
				slug: "journal",
				description: "Notes on how good teams plan, write and ship. Every other Tuesday.",
				segment_id: ids.jsubs,
				topic_id: ids.jissue,
				from: "The Acme Journal <editors@journal.acme.example>",
				form_id: ids.form,
				accent: "#b45309",
				referrals: true,
				referral_rewards: [
					{ count: 3, reward: "The Journal's planning template" },
					{ count: 10, reward: "A Journal mug" },
				],
			})
		).id;
		await importContacts(
			J,
			founding.map((x) => ({ email: x.email, first_name: x.first, last_name: x.last })),
			{ segment: ids.jsubs },
		);
		for (const x of founding.slice(0, 120))
			await api(
				ctx.token,
				"POST",
				`/contacts/${encodeURIComponent(x.email)}/segments/${ids.jfounding}`,
				undefined,
				{ brand: J },
			);
	});
	add(ctx.ago(157, 12), "journal welcome series", async () => {
		await createAutomation(J, {
			name: "Welcome series",
			status: "active",
			trigger: { type: "contact.created", segment_id: ids.jsubs },
			steps: [
				{ type: "send", template_id: ids["journal-welcome"] },
				{ type: "wait", days: 3 },
				{ type: "send", template_id: ids["journal-best-of"] },
			],
		});
	});
	// Sign-ups through the forms, a few through a reader's referral link.
	for (let d = 150; d >= 0; d--) {
		const n = Math.floor(r() * 4.2 * (1 + (150 - d) / 200));
		for (let i = 0; i < n && readers.length; i++) {
			const x = readers.shift() as Person;
			const t = ctx.ago(d, 6 + Math.floor(r() * 17)) + Math.floor(r() * 59) * 60_000;
			const form = r() < 0.7 ? "form" : "form2";
			const referred = r() < 0.12 && d < 120;
			const utm = pick([null, null, "twitter", "linkedin", "hn", "google"]);
			add(t, "journal signup", async () => {
				const f = ids[form] as string;
				const ref = referred
					? await referralCode(await contactOf(J, pick(subscribed.slice(0, 40)).email))
					: "";
				await handleSubscribe(
					new Request(`https://mailroom.example.com/subscribe/${f}`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json",
							"cf-connecting-ip": "203.0.113.7",
							referer: "https://journal.acme.example/",
						},
						body: JSON.stringify({
							email: x.email,
							first_name: x.first,
							...(utm ? { utm_source: utm } : {}),
							...(ref ? { ref } : {}),
						}),
					}),
				);
				// Most confirm within the hour; a few never do.
				if (r() < 0.9)
					await at(Date.now() + (3 + r() * 50) * 60_000, async () => {
						const token = await confirmToken({
							f,
							e: x.email,
							n: x.first,
							...(ref ? { r: ref } : {}),
							...(utm ? { s: utm } : {}),
						});
						await handleSubscribe(
							new Request(
								`https://mailroom.example.com/subscribe/confirm?t=${token}`,
							),
						);
						subscribed.push(x);
					});
			});
		}
	}
	// An issue every other Tuesday.
	const issueDays = ISSUES.map((_, i) => 4 + (ISSUES.length - 1 - i) * 14);
	ISSUES.forEach((issue, i) => {
		const when = ctx.ago(issueDays[i] as number, 13);
		add(when, `issue ${i + 1}`, async () => {
			const x = await createBroadcast(
				J,
				J,
				{
					name: `Issue ${i + 1}: ${issue.subject}`,
					subject: issue.subject,
					preview_text: issue.pre,
					from: "The Acme Journal <editors@journal.acme.example>",
					segment_id: ids.jsubs,
					topic_id: ids.jissue,
					newsletter_id: ids.newsletter,
					design: issueDesign(issue, i + 1),
				},
				Date.now(),
				i % 2 ? "user_priya" : "user_jonas",
			);
			ids[`issue${i + 1}`] = x.id;
			await at(Date.now() + 60 * 60_000, () =>
				sendBroadcast(
					J,
					x.id,
					null,
					Date.now(),
					i === 6
						? {
								ab_test: {
									subjects: ["Boring technology, ten years on"],
									metric: "opens",
									size: 30,
									wait_minutes: 180,
								},
							}
						: {},
				),
			);
		});
		// The next days: some readers answer the poll, a few leave.
		add(when + 2 * DAY, `issue ${i + 1} after`, async () => {
			const id = ids[`issue${i + 1}`] as string;
			const sent = await db
				.select()
				.from(schema.emails)
				.where(eq(schema.emails.broadcast_id, id));
			const stored = await db
				.select({ design: schema.broadcasts.design })
				.from(schema.broadcasts)
				.where(eq(schema.broadcasts.id, id))
				.get();
			const pollId = issue.poll && stored?.design ? findPoll(stored.design) : null;
			for (const e of sent) {
				const to = (e.to as string[])[0] as string;
				const roll = r();
				if (pollId && e.opened_at && roll < 0.35) {
					const c = await contactOf(J, to);
					const answer = weighted(r(), [0.46, 0.27, 0.2, 0.07]);
					await at(Date.parse(e.opened_at) + 60_000, async () =>
						handlePoll(new Request(`${await pollBase(id, c.id)}/${pollId}/${answer}`)),
					);
				}
				if (roll > 0.994 && e.unsubscribe_group)
					await at(Date.parse(e.created_at) + (2 + r() * 30) * HOUR, () =>
						unsubscribe({
							organizationId: e.organization_id,
							group: e.unsubscribe_group as string,
							address: to,
							emailId: e.id,
						}),
					);
			}
		});
	});
	// The next issue, scheduled; and one being written.
	add(ctx.ago(0, 3), "next issue", async () => {
		const issue = {
			subject: "The quiet power of a changelog",
			pre: "Writing down what changed is a product.",
			lede: "A good changelog is the cheapest marketing a software team has, and the most honest. How three teams write theirs.",
			art: "journal-3.svg",
		};
		const x = await createBroadcast(
			J,
			J,
			{
				name: `Issue ${ISSUES.length + 1}: ${issue.subject}`,
				subject: issue.subject,
				preview_text: issue.pre,
				from: "The Acme Journal <editors@journal.acme.example>",
				segment_id: ids.jsubs,
				topic_id: ids.jissue,
				newsletter_id: ids.newsletter,
				design: issueDesign(issue, ISSUES.length + 1),
			},
			Date.now(),
			"user_priya",
		);
		await sendBroadcast(
			J,
			x.id,
			new Date(ctx.now + 10 * DAY - 4 * DAY + 13 * HOUR - (ctx.now % DAY)).toISOString(),
		);
	});

	await play(agenda, ctx);
	return ids;

	async function tplId(alias: string) {
		return (
			await db
				.select({ id: schema.templates.id })
				.from(schema.templates)
				.where(
					and(
						eq(schema.templates.organization_id, ORG),
						eq(schema.templates.alias, alias),
					),
				)
				.get()
		)?.id;
	}
}

async function contactOf(brand: string, email: string) {
	const c = await db
		.select()
		.from(schema.contacts)
		.where(and(eq(schema.contacts.organization_id, brand), eq(schema.contacts.email, email)))
		.get();
	if (!c) throw new Error(`no contact ${email}`);
	return c;
}

function findPoll(d: { blocks: { type: string; id: string }[] }) {
	return d.blocks.find((b) => b.type === "poll")?.id ?? null;
}

function weighted(x: number, shares: number[]) {
	for (const [i, s] of shares.entries()) {
		x -= s;
		if (x < 0) return i;
	}
	return shares.length - 1;
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Runs the agenda in order, with the cron's run every hour between, as the Worker would. */
async function play(agenda: Step[], ctx: Ctx) {
	agenda.sort((a, z) => a.t - z.t);
	const end = Math.min(ctx.now - 60_000, realNow());
	let tick = Math.ceil((agenda[0]?.t ?? end) / HOUR) * HOUR + 60_000;
	const started = realNow();
	let i = 0;
	const cron = async (t: number) => {
		await flushSes(t);
		await at(t, async () => {
			await runCron(t);
			await runDispatcher();
		});
		await settle();
	};
	for (const step of agenda) {
		while (tick < step.t && tick < end) {
			await cron(tick);
			tick += HOUR;
		}
		if (step.t >= end) continue;
		await flushSes(step.t);
		await at(step.t, async () => {
			try {
				await step.run();
			} catch (error) {
				console.warn(`[demo] ${step.label} failed:`, (error as Error).message);
			}
			await runDispatcher();
		});
		await settle();
		if (++i % 500 === 0)
			console.log(
				`[demo] ${i}/${agenda.length} steps, ${((realNow() - started) / 1000).toFixed(0)}s`,
			);
	}
	while (tick < end) {
		await cron(tick);
		tick += HOUR;
	}
	await flushSes(end);
	await settle();
}
