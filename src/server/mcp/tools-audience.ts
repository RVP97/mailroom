import { inArray } from "drizzle-orm";
import { z } from "zod";
import { broadcastView } from "../broadcasts";
import {
	broadcastStats,
	campaignBroadcasts,
	campaignCounts,
	campaignReport,
	campaignView,
	createCampaign,
	deleteCampaign,
	getCampaign,
	listCampaigns,
	updateCampaign,
} from "../campaigns";
import {
	addToSegment,
	contactCount,
	createProperty,
	createSegment,
	createTopic,
	deleteProperty,
	deleteSegment,
	deleteTopic,
	getContact,
	importContacts,
	importRow,
	listProperties,
	listSegments,
	propertyView,
	removeFromSegment,
	renameSegment,
	segmentsOfContact,
	segmentView,
	setTopics,
	topicView,
	updateProperty,
	updateTopic,
} from "../contacts";
import { db, schema } from "../db";
import { cleanUpCold, coldContacts, engagementOverview } from "../engagement";
import { ApiError, validation } from "../errors";
import { growth } from "../growth";
import {
	checkFeed,
	createNewsletter,
	deleteNewsletter,
	getNewsletter,
	issueCounts,
	issuesOf,
	listNewsletters,
	newsletterView,
	updateNewsletter,
	webUrl,
} from "../newsletters";
import { orgContext } from "../org";
import { leaderboard, referralTotals } from "../referrals";
import {
	createForm,
	deleteForm,
	formEmbed,
	formView,
	getForm,
	listForms,
	turnstileFor,
	updateForm,
} from "../signup-forms";
import { brandWidget } from "../turnstile";
import {
	brand,
	brandOf,
	brandsOf,
	defined,
	logged,
	oneBrand,
	orgAt,
	organization,
	type Tool,
} from "./kit";

/** Contacts beyond the basics, sign-up forms, growth, newsletters and campaigns. */

const brandName = async (ids: string[]) => {
	const rows = await db
		.select({ id: schema.organization.id, name: schema.organization.name })
		.from(schema.organization)
		.where(inArray(schema.organization.id, ids));
	return new Map(rows.map((r) => [r.id, r.name]));
};

/** Sign-up forms with how to put them on a site. */
async function formsWithEmbed(ids: string[], only?: string) {
	const forms = (await listForms(ids)).filter((f) => !only || f.id === only);
	const widgets = new Map(
		(
			await db
				.select()
				.from(schema.turnstileWidgets)
				.where(inArray(schema.turnstileWidgets.organization_id, ids))
		).map((w) => [w.organization_id, w]),
	);
	return Promise.all(
		forms.map(async (f) => {
			const w = widgets.get(f.organization_id);
			const sitekey = w?.sitekey && w.secret ? w.sitekey : null;
			return {
				...formView(f),
				...(await formEmbed(f, { sitekey })),
				bot_protection: { on: !!sitekey, error: w?.error ?? null },
			};
		}),
	);
}

const subscription = z.enum(["opt_in", "opt_out"]);

export const AUDIENCE_TOOLS: Tool[] = [
	// ── One person, everywhere ──
	{
		name: "contact_timeline",
		title: "A contact's timeline",
		description:
			"Everything about one contact, newest first: their app's events (and poll answers, referral milestones), emails sent to them with opens and clicks, their conversations and website chats with ratings, automations they went through, friends they brought, when they joined and unsubscribed. Page with `before` (the `next` of the last page).",
		input: {
			organization,
			brand: oneBrand,
			contact: z.string().describe("The contact's id or email address"),
			before: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			const c = await getContact(b, a.contact as string);
			const { contactTimeline } = await import("../timeline");
			return contactTimeline(b, c, {
				before: a.before as string | undefined,
				limit: a.limit as number | undefined,
			});
		},
	},
	{
		name: "list_events",
		title: "List contacts' events",
		description:
			"Events kept from the app (POST /api/events, send_event) and Mailroom's own (poll.answered, referral.milestone). With `contact`: that person's; with `event`: every contact's of that name; with neither: the brand's event names and how often each happened in the last 90 days.",
		input: {
			organization,
			brand: oneBrand,
			contact: z.string().optional().describe("A contact's id or email address"),
			event: z.string().optional(),
			before: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			const { eventNames, eventView, listContactEvents } = await import("../contact-events");
			if (!a.contact && !a.event) return { object: "list", data: await eventNames(b) };
			const contact = a.contact ? (await getContact(b, a.contact as string)).id : null;
			const page = await listContactEvents(b, {
				contact,
				name: a.event as string | undefined,
				before: a.before as string | undefined,
				limit: a.limit as number | undefined,
			});
			return { object: "list", next: page.next, data: page.data.map(eventView) };
		},
	},
	{
		name: "merge_contacts",
		title: "Merge two contacts",
		description:
			"The same person under two addresses: `merge` is folded into `keep` (its segments, topic choices, missing properties and names, events, poll answers, automation runs and referrals move over) and then deleted. Emails and conversations stay under the address they were for.",
		input: {
			organization,
			brand: oneBrand,
			keep: z.string().describe("The contact to keep (id or email)"),
			merge: z.string().describe("The contact folded into it and deleted (id or email)"),
		},
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:delete");
			const b = await brandOf(org.id, a.brand);
			const { mergeContacts } = await import("../timeline");
			const out = await mergeContacts(b, a.keep as string, a.merge as string);
			await logged(
				ctx,
				org,
				"contact.merged",
				{ type: "contact", id: out.kept, name: out.email },
				{ merged: out.merged_email },
			);
			return out;
		},
	},
	// ── Segments, topics and properties ──
	{
		name: "save_segment",
		title: "Create or edit a segment",
		description:
			"Creates a segment (a group of contacts broadcasts go to) in a brand, or with `segment` renames or changes one. With `rules` it's a live segment: its members are whoever matches, kept up to date by itself (null turns it back into a list). Rules: { match: all|any, conditions: [...] }, each condition one of: { type: property, key, op: is|is_not|contains|set|not_set|gt|lt, value }, { type: email, op: ends_with|contains, value }, { type: subscribed, value: bool }, { type: source, value: form|form:<id>|referral|import|api|dashboard|automation|event }, { type: joined, op: within|before, days }, { type: topic, topic_id, value: opt_in|opt_out }, { type: segment, segment_id (a list segment), value: bool }, { type: engagement, levels: [champion|engaged|cooling|cold|new] }, { type: email_activity, action: received|opened|clicked, did: bool, days, min?, broadcast_id? }, { type: event, name, did: bool, days?, min?, key?, value? (event data key = value) }, { type: poll, broadcast_id, poll_id?, answer (option index) }, { type: referrals, min }, { type: conversation, status: open|any, did: bool, days? }, { type: rating, op: at_most|at_least, value 1–5, days? } (their latest support rating), { type: survey, survey_id, answer: any|promoter|passive|detractor|at_least|at_most|choice, value? (a score, or the choice's index), days? } (their latest answer to a survey), { type: chatted, page?, days? }, { type: lead_score, op: hot|warm|cold|at_least|at_most, value? } (their lead score, get_lead_scoring). Try rules first with preview_segment.",
		input: {
			organization,
			brand: oneBrand,
			segment: z.string().optional().describe("Its id, to change it"),
			name: z.string().min(1).max(200),
			rules: z
				.unknown()
				.optional()
				.describe("A live segment's rules (see the description); null: a list"),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const b = await brandOf(org.id, a.brand);
			const fields = { name: a.name, ...(a.rules !== undefined ? { rules: a.rules } : {}) };
			const s = a.segment
				? await renameSegment(b, a.segment as string, fields)
				: await createSegment(b, fields);
			await logged(ctx, org, "segment.saved", { type: "segment", id: s.id, name: s.name });
			const n = (await listSegments(b)).find((x) => x.id === s.id)?.contacts ?? 0;
			return segmentView(s, n);
		},
	},
	{
		name: "preview_segment",
		title: "Preview a live segment's rules",
		description:
			"How many of a brand's contacts match some rules now (the same rules save_segment takes), and a few of them. Saves nothing.",
		input: { organization, brand: oneBrand, rules: z.unknown() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			const { previewRules } = await import("../live-segments");
			return previewRules(b, a.rules);
		},
	},
	{
		name: "delete_segment",
		title: "Delete a segment",
		description:
			"Deletes a segment. Its contacts stay (only the group goes); broadcasts and automations that use it stop finding it.",
		input: { organization, brand: oneBrand, segment: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			await deleteSegment(await brandOf(org.id, a.brand), a.segment as string);
			await logged(ctx, org, "segment.deleted", { type: "segment", id: a.segment as string });
			return { deleted: a.segment };
		},
	},
	{
		name: "save_topic",
		title: "Create or edit a topic",
		description:
			"Creates a topic (what contacts opt in or out of on their preferences page), or with `topic` edits one. default_subscription opt_out: everyone gets it until they leave; opt_in: only who joins. visibility public shows it on the preferences page.",
		input: {
			organization,
			brand: oneBrand,
			topic: z.string().optional().describe("Its id, to edit it"),
			name: z.string().min(1).max(200).optional(),
			description: z.string().max(1000).nullable().optional(),
			default_subscription: subscription.optional(),
			visibility: z.enum(["public", "private"]).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const b = await brandOf(org.id, a.brand);
			const fields = defined(a, ["organization", "brand", "topic"]);
			if (!a.topic && !fields.name)
				throw new ApiError(422, "validation_error", "name: required");
			const t = a.topic
				? await updateTopic(b, a.topic as string, fields)
				: await createTopic(b, fields);
			await logged(ctx, org, "topic.saved", { type: "topic", id: t.id, name: t.name });
			return topicView(t);
		},
	},
	{
		name: "delete_topic",
		title: "Delete a topic",
		description: "Deletes a topic and every contact's choice about it.",
		input: { organization, brand: oneBrand, topic: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			await deleteTopic(await brandOf(org.id, a.brand), a.topic as string);
			await logged(ctx, org, "topic.deleted", { type: "topic", id: a.topic as string });
			return { deleted: a.topic };
		},
	},
	{
		name: "list_properties",
		title: "List contact properties",
		description:
			"A brand's contact properties (custom fields like plan or city): key, type and fallback value. Emails use them as {{{contact.<key>}}}.",
		input: { organization, brand: oneBrand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			return (await listProperties(await brandOf(org.id, a.brand))).map(propertyView);
		},
	},
	{
		name: "save_property",
		title: "Create or edit a contact property",
		description:
			"Declares a contact property (key: letters, numbers and _; type string or number; fallback_value used when a contact has none), or with `property` (its id or key) changes one's fallback.",
		input: {
			organization,
			brand: oneBrand,
			property: z.string().optional(),
			key: z.string().optional(),
			type: z.enum(["string", "number"]).optional(),
			fallback_value: z.union([z.string(), z.number()]).nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const b = await brandOf(org.id, a.brand);
			const fields = defined(a, ["organization", "brand", "property"]);
			const p = a.property
				? await updateProperty(b, a.property as string, fields)
				: await createProperty(b, fields);
			return propertyView(p);
		},
	},
	{
		name: "delete_property",
		title: "Delete a contact property",
		description: "Deletes a property and its value on every contact.",
		input: { organization, brand: oneBrand, property: z.string().describe("Its id or key") },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			await deleteProperty(await brandOf(org.id, a.brand), a.property as string);
			return { deleted: a.property };
		},
	},
	{
		name: "update_contact_lists",
		title: "Change a contact's segments and topics",
		description:
			"Adds a contact (by id or address) to segments (add_segments), takes it out of others (remove_segments), and sets its topic choices ([{ id, subscription: opt_in|opt_out }]). Returns the segments it's in afterwards.",
		input: {
			organization,
			brand: oneBrand,
			contact: z.string(),
			add_segments: z.array(z.string()).max(100).optional(),
			remove_segments: z.array(z.string()).max(100).optional(),
			topics: z
				.array(z.object({ id: z.string(), subscription }))
				.max(100)
				.optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const b = await brandOf(org.id, a.brand);
			const c = await getContact(b, a.contact as string);
			for (const s of (a.add_segments as string[] | undefined) ?? [])
				await addToSegment(b, c.id, s);
			for (const s of (a.remove_segments as string[] | undefined) ?? [])
				await removeFromSegment(b, c.id, s);
			if (a.topics)
				await setTopics(
					b,
					c.id,
					a.topics as { id: string; subscription: "opt_in" | "opt_out" }[],
				);
			await logged(ctx, org, "contact.edited", { type: "contact", id: c.id, name: c.email });
			return {
				contact_id: c.id,
				segments: (await segmentsOfContact(c.id)).map((s) => ({ id: s.id, name: s.name })),
			};
		},
	},
	{
		name: "add_person_to",
		title: "Subscribe someone or start an automation for them",
		description:
			"For one address (say, someone who wrote to support): makes them a contact (action contact), puts them in or takes them out of a list segment (segment + segment_action add|remove), subscribes or unsubscribes them from a newsletter (newsletter + newsletter_action subscribe|unsubscribe), or starts an automation that's on for them (automation; started false means they've been through it and it doesn't let people in twice). Not a contact yet: they become one first.",
		input: {
			organization,
			brand: oneBrand,
			email: z.string().email(),
			action: z.enum(["contact", "segment", "newsletter", "automation"]),
			segment: z.string().optional().describe("A list segment's id"),
			segment_action: z.enum(["add", "remove"]).optional(),
			newsletter: z.string().optional().describe("A newsletter's id"),
			newsletter_action: z.enum(["subscribe", "unsubscribe"]).optional(),
			automation: z.string().optional().describe("An automation's id"),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:edit");
			const b = await brandOf(org.id, a.brand);
			const need = (v: unknown, what: string) => {
				if (typeof v !== "string" || !v) throw validation(`Give the ${what}`);
				return v;
			};
			const { actForPerson } = await import("../automations");
			const r = await actForPerson(
				b,
				a.email as string,
				a.action === "segment"
					? {
							type: "segment",
							segment_id: need(a.segment, "segment"),
							action: (a.segment_action as "add" | "remove") ?? "add",
						}
					: a.action === "newsletter"
						? {
								type: "newsletter",
								newsletter_id: need(a.newsletter, "newsletter"),
								action:
									(a.newsletter_action as "subscribe" | "unsubscribe") ??
									"subscribe",
							}
						: a.action === "automation"
							? {
									type: "automation",
									automation_id: need(a.automation, "automation"),
								}
							: { type: "contact" },
			);
			await logged(ctx, org, "contact.edited", {
				type: "contact",
				id: r.contact_id,
				name: a.email as string,
			});
			return r;
		},
	},
	{
		name: "import_contacts",
		title: "Import contacts",
		description:
			"Adds up to 1,000 contacts a call (call again for more): new addresses are added, known ones get the names and properties given (missing values change nothing). Property keys that don't exist yet become text properties. segment_id puts every row in that segment. Rows without a real address are skipped and counted.",
		input: {
			organization,
			brand: oneBrand,
			segment_id: z.string().optional(),
			rows: z.array(importRow).min(1).max(1000),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "contacts:import");
			const b = await brandOf(org.id, a.brand);
			const r = await importContacts(b, a.rows as never, {
				segment: a.segment_id as string | undefined,
			});
			await logged(
				ctx,
				org,
				"contacts.imported",
				{ type: "contacts", id: b },
				{
					rows: (a.rows as unknown[]).length,
				},
			);
			return r;
		},
	},
	{
		name: "get_engagement",
		title: "Contact engagement",
		description:
			"How engaged a brand's contacts are (highly engaged, engaged, cold, by opens and clicks; new: fewer than 5 marketing emails in 90 days, too few to score), and its cold contacts: subscribed ones that got at least min_emails marketing emails in `days` and opened and clicked none (the first 50, and how many). clean_up_contacts acts on them.",
		input: {
			organization,
			brand: oneBrand,
			min_emails: z.number().int().min(1).max(50).optional(),
			days: z.number().int().min(7).max(365).optional(),
		},
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			const [overview, cold, count] = await Promise.all([
				engagementOverview(b),
				coldContacts(b, { min_emails: a.min_emails, days: a.days }),
				contactCount(b),
			]);
			return {
				brand_id: b,
				contacts: count,
				overview,
				cold: { count: cold.length, first: cold.slice(0, 50) },
			};
		},
	},
	{
		name: "clean_up_contacts",
		title: "Clean up cold contacts",
		description:
			"Does something with a brand's cold contacts (see get_engagement, same min_emails and days): action segment puts them in segment_id (to win them back), unsubscribe unsubscribes them, delete deletes them. ids: only these of the cold ones. Confirm with the person first.",
		input: {
			organization,
			brand: oneBrand,
			action: z.enum(["segment", "unsubscribe", "delete"]),
			segment_id: z.string().optional(),
			min_emails: z.number().int().min(1).max(50).optional(),
			days: z.number().int().min(7).max(365).optional(),
			ids: z.array(z.string()).max(5000).optional(),
		},
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(
				ctx,
				a.organization,
				a.action === "segment" ? "contacts:edit" : "contacts:delete",
			);
			const b = await brandOf(org.id, a.brand);
			const r = await cleanUpCold(b, defined(a, ["organization", "brand"]));
			await logged(
				ctx,
				org,
				"contacts.cleaned_up",
				{ type: "contacts", id: b },
				{
					action: a.action,
				},
			);
			return r;
		},
	},
	{
		name: "get_growth",
		title: "Subscriber growth",
		description:
			"A brand's subscriber growth over `days` (7–365, default 30): sign-ups, unsubscribes and net growth per day, by source (form, referral, import, API, dashboard…) and UTM, plus referral totals.",
		input: { organization, brand: oneBrand, days: z.number().int().min(7).max(365).optional() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const b = await brandOf(org.id, a.brand);
			const [g, referrals] = await Promise.all([
				growth(b, { days: a.days as number | undefined }),
				referralTotals(b),
			]);
			return { brand_id: b, growth: g, referrals };
		},
	},

	// ── Sign-up forms ──
	{
		name: "list_signup_forms",
		title: "List sign-up forms",
		description:
			"The organization's public sign-up forms (or one brand's): where they put people (segment, topic), their From, whether on, their design, their hosted page, the HTML and script to paste on a site, and whether bot protection (Turnstile) is on.",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			return formsWithEmbed(await brandsOf(org.id, a.brand));
		},
	},
	{
		name: "get_signup_form",
		title: "Get a sign-up form",
		description: "One sign-up form with its whole design, hosted page and embed code.",
		input: { organization, form: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const ids = await brandsOf(org.id);
			const f = await getForm(ids, a.form as string);
			const [x] = await formsWithEmbed([f.organization_id], f.id);
			return x;
		},
	},
	{
		name: "save_signup_form",
		title: "Create or edit a sign-up form",
		description:
			"Creates a sign-up form in a brand (name and from required: the confirmation email goes from an address on one of its verified domains), or with `form` edits one. segment_id / topic_id: where sign-ups go. website: the site it's on (for bot protection); redirect_url: where people go after. design: how it looks and what it says (template card|minimal|split|banner|spotlight, display inline|popup|slide_in|bar, texts, colors, font, radius…; keys left out keep their value; get_signup_form shows every key).",
		input: {
			organization,
			brand: oneBrand,
			form: z.string().optional().describe("Its id, to edit it"),
			name: z.string().max(200).optional(),
			title: z.string().max(200).optional(),
			from: z.string().max(320).optional(),
			segment_id: z.string().nullable().optional(),
			topic_id: z.string().nullable().optional(),
			ask_name: z.boolean().optional(),
			website: z.string().nullable().optional(),
			redirect_url: z.string().nullable().optional(),
			enabled: z.boolean().optional(),
			design: z.record(z.string(), z.unknown()).optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "forms:edit");
			const fields = defined(a, ["organization", "brand", "form"]);
			let row: Awaited<ReturnType<typeof getForm>>;
			if (a.form) {
				const x = await getForm(await brandsOf(org.id), a.form as string);
				row = await updateForm(x.organization_id, x.id, fields);
			} else row = await createForm(await brandOf(org.id, a.brand), fields);
			await logged(ctx, org, "form.edited", { type: "form", id: row.id, name: row.name });
			const [x] = await formsWithEmbed([row.organization_id], row.id);
			return x;
		},
	},
	{
		name: "delete_signup_form",
		title: "Delete a sign-up form",
		description: "Deletes a sign-up form; where it's pasted it stops taking sign-ups.",
		input: { organization, form: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "forms:edit");
			const x = await getForm(await brandsOf(org.id), a.form as string);
			await deleteForm(x.organization_id, x.id);
			await logged(ctx, org, "form.deleted", { type: "form", id: x.id, name: x.name });
			return { deleted: x.id };
		},
	},
	{
		name: "retry_bot_protection",
		title: "Set up a brand's bot protection again",
		description:
			"Tries again to create the brand's Cloudflare Turnstile widget for its forms (after the deployment's Cloudflare token got the permission it lacked). Returns whether it's on and the error if not.",
		input: { organization, brand: oneBrand },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "forms:edit");
			const b = await brandOf(org.id, a.brand);
			const error = await turnstileFor(b);
			return { error, on: !!(await brandWidget(b)) };
		},
	},

	// ── Newsletters ──
	{
		name: "list_newsletters",
		title: "List newsletters",
		description:
			"The organization's newsletters (or one brand's): each has a sender, an audience (segment, topic), a sign-up form, an optional public archive page, RSS-to-email and referrals; broadcasts that are its issues go to its archive.",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const rows = await listNewsletters(await brandsOf(org.id, a.brand));
			const counts = await issueCounts(rows.map((r) => r.id));
			const names = await brandName([...new Set(rows.map((r) => r.organization_id))]);
			return Promise.all(
				rows.map(async (n) => ({
					...newsletterView(n, await orgContext(n.organization_id)),
					brand: names.get(n.organization_id) ?? null,
					issues: counts.get(n.id) ?? 0,
				})),
			);
		},
	},
	{
		name: "get_newsletter",
		title: "Get a newsletter",
		description:
			"One newsletter with its settings and look, its issues (broadcasts, with their public URLs and stats: sent, delivered, opened, clicked, bounced, unsubscribed), the referral leaderboard and totals.",
		input: { organization, newsletter: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const n = await getNewsletter(await brandsOf(org.id), a.newsletter as string);
			const [c, issues, board, totals] = await Promise.all([
				orgContext(n.organization_id),
				issuesOf(n.id),
				leaderboard(n.organization_id),
				referralTotals(n.organization_id),
			]);
			const stats = await broadcastStats(issues.map((x) => x.id));
			return {
				...newsletterView(n, c),
				issues: issues.map((x) => ({
					id: x.id,
					name: x.name,
					subject: x.subject,
					status: x.status,
					web: x.web,
					started_at: x.started_at,
					queued: x.queued,
					url: webUrl(x, n),
					stats: stats[x.id] ?? null,
				})),
				referrals: { ...totals, leaderboard: board },
			};
		},
	},
	{
		name: "save_newsletter",
		title: "Create or edit a newsletter",
		description:
			"Creates a newsletter in a brand (name required), or with `newsletter` edits one. Fields: slug (its public page /n/<slug>), description, segment_id, topic_id, from, form_id (its sign-up form), public (archive page on), accent (#rrggbb), rss_url + rss_mode (draft: new posts make a draft issue; send: they go out) + rss_style (full|compact|titles) + rss_intro, referrals (on/off) + referral_rewards ([{ count, reward, template_id? }]), look ({ logo: brand|none|URL, cover, font, heading_font, theme auto|light|dark, background, layout list|cards, align, form_position top|bottom, links: [{ label, url }], logo_shape original|rounded|circle, logo_size small|medium|large, corners square|soft|round, borders (true: thin line, false: shadow), bar glass|solid|none, show_count, show_rss, words: { issues_heading (a dash hides it), empty, subscribe, cta_title, cta_text, more, footer } where {name} is the newsletter's name and an empty one is the default }). New issues: save_broadcast with newsletter_id.",
		input: {
			organization,
			brand: oneBrand,
			newsletter: z.string().optional().describe("Its id, to edit it"),
			name: z.string().max(200).optional(),
			slug: z.string().optional(),
			description: z.string().nullable().optional(),
			segment_id: z.string().nullable().optional(),
			topic_id: z.string().nullable().optional(),
			from: z.string().nullable().optional(),
			form_id: z.string().nullable().optional(),
			public: z.boolean().optional(),
			accent: z.string().nullable().optional(),
			rss_url: z.string().nullable().optional(),
			rss_mode: z.enum(["draft", "send"]).optional(),
			rss_style: z.enum(["full", "compact", "titles"]).optional(),
			rss_intro: z.string().nullable().optional(),
			referrals: z.boolean().optional(),
			referral_rewards: z
				.array(
					z.object({
						count: z.number().int(),
						reward: z.string(),
						template_id: z.string().nullable().optional(),
					}),
				)
				.optional(),
			look: z.record(z.string(), z.unknown()).nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "newsletters:edit");
			const fields = defined(a, ["organization", "brand", "newsletter"]);
			let row: Awaited<ReturnType<typeof getNewsletter>>;
			if (a.newsletter) {
				const n = await getNewsletter(await brandsOf(org.id), a.newsletter as string);
				row = await updateNewsletter(n.organization_id, n.id, fields);
			} else row = await createNewsletter(await brandOf(org.id, a.brand), fields);
			await logged(ctx, org, "newsletter.edited", {
				type: "newsletter",
				id: row.id,
				name: row.name,
			});
			return newsletterView(row, await orgContext(row.organization_id));
		},
	},
	{
		name: "delete_newsletter",
		title: "Delete a newsletter",
		description:
			"Deletes a newsletter and its public archive page. Its issues stay as broadcasts.",
		input: { organization, newsletter: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "newsletters:edit");
			const n = await getNewsletter(await brandsOf(org.id), a.newsletter as string);
			await deleteNewsletter(n.organization_id, n.id);
			await logged(ctx, org, "newsletter.deleted", {
				type: "newsletter",
				id: n.id,
				name: n.name,
			});
			return { deleted: n.id };
		},
	},
	{
		name: "check_newsletter_feed",
		title: "Read a newsletter's RSS feed now",
		description:
			"Reads the newsletter's RSS feed now instead of waiting (a first read only notes what's there). Returns the issue it made, if any, and the feed's error.",
		input: { organization, newsletter: z.string() },
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "newsletters:edit");
			const ids = await brandsOf(org.id);
			const n = await getNewsletter(ids, a.newsletter as string);
			const made = await checkFeed(n);
			const after = await getNewsletter(ids, n.id);
			return {
				broadcast_id: made,
				error: after.rss_error,
				seen: after.rss_seen?.length ?? 0,
			};
		},
	},

	// ── Campaigns ──
	{
		name: "list_campaigns",
		title: "List campaigns",
		description:
			"The organization's campaigns (or one brand's): a campaign groups several broadcasts (different emails to different segments) with dates, a utm_campaign added to their links, and one combined report.",
		input: { organization, brand },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const rows = await listCampaigns(await brandsOf(org.id, a.brand));
			const counts = await campaignCounts(rows.map((r) => r.id));
			return rows.map((x) => ({
				...campaignView(x),
				broadcasts: counts.get(x.id)?.total ?? 0,
				sent: counts.get(x.id)?.sent ?? 0,
			}));
		},
	},
	{
		name: "get_campaign",
		title: "Get a campaign",
		description:
			"One campaign with its broadcasts (each with its segment and stats), the combined totals, and the revenue credited to its broadcasts (each currency apart).",
		input: { organization, campaign: z.string() },
		readOnly: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const x = await getCampaign(await brandsOf(org.id), a.campaign as string);
			const [list, report, segments] = await Promise.all([
				campaignBroadcasts(x.id),
				campaignReport(x.id),
				listSegments(x.organization_id),
			]);
			const segmentName = new Map(segments.map((s) => [s.id, s.name]));
			return {
				...campaignView(x),
				broadcasts: list.map((b) => {
					const {
						html: _h,
						text: _t,
						design: _d,
						...v
					} = broadcastView(b) as Record<string, unknown>;
					return {
						...v,
						segment: b.segment_id ? (segmentName.get(b.segment_id) ?? null) : null,
						stats: report.by_broadcast[b.id] ?? null,
					};
				}),
				totals: report.totals,
				revenue: await import("../revenue").then((m) => m.revenueOf("campaign", x.id)),
			};
		},
	},
	{
		name: "save_campaign",
		title: "Create or edit a campaign",
		description:
			"Creates a campaign in a brand (name required), or with `campaign` edits one: description, utm_campaign (added to its broadcasts' links; null or \"\" leaves links as written; made from the name when left out on create), starts_on and ends_on (YYYY-MM-DD). Add broadcasts with save_broadcast's campaign_id.",
		input: {
			organization,
			brand: oneBrand,
			campaign: z.string().optional().describe("Its id, to edit it"),
			name: z.string().max(200).optional(),
			description: z.string().nullable().optional(),
			utm_campaign: z.string().nullable().optional(),
			starts_on: z.string().nullable().optional(),
			ends_on: z.string().nullable().optional(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const fields = defined(a, ["organization", "brand", "campaign"]);
			let row: Awaited<ReturnType<typeof getCampaign>>;
			if (a.campaign) {
				const x = await getCampaign(await brandsOf(org.id), a.campaign as string);
				row = await updateCampaign(x.organization_id, x.id, { name: x.name, ...fields });
			} else row = await createCampaign(await brandOf(org.id, a.brand), fields);
			await logged(ctx, org, "campaign.edited", {
				type: "campaign",
				id: row.id,
				name: row.name,
			});
			return campaignView(row);
		},
	},
	{
		name: "delete_campaign",
		title: "Delete a campaign",
		description: "Deletes a campaign. Its broadcasts stay, outside any campaign.",
		input: { organization, campaign: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const x = await getCampaign(await brandsOf(org.id), a.campaign as string);
			await deleteCampaign(x.organization_id, x.id);
			await logged(ctx, org, "campaign.deleted", {
				type: "campaign",
				id: x.id,
				name: x.name,
			});
			return { deleted: x.id };
		},
	},
];
