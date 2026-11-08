import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { maskDigits } from "@/lib/roles";
import { logActivity } from "@/server/activity";
import { brandIn, viewScope } from "@/server/brands";
import {
	addToSegment,
	contactCount,
	contactView,
	createProperty,
	createSegment,
	createTopic,
	deleteContact,
	deleteProperty,
	deleteSegment,
	deleteTopic,
	getContact,
	importContacts,
	importRow,
	listContacts,
	listProperties,
	listSegments,
	listTopics,
	propertyView,
	removeFromSegment,
	renameSegment,
	segmentsOfContact,
	segmentView,
	setTopics,
	topicsOfContact,
	topicView,
	updateContact,
	updateTopic,
	upsertContact,
} from "@/server/contacts";
import {
	cleanUpCold,
	cleanUpInput,
	coldContacts,
	coldInput,
	engagementOf,
	engagementOverview,
} from "@/server/engagement";
import { can, orgMiddleware } from "@/server/middleware";
import type { TimelineItem } from "@/server/timeline";
import { call } from "./call";

/** The Contacts pages: one brand's contacts, segments, topics and properties at a time. */

/** The brand picked (one of the organization's), or the organization's own. */
const brandOf = (organizationId: string, brand?: string | null) =>
	brand ? call(() => brandIn(organizationId, brand)) : Promise.resolve(organizationId);

const brandInput = { brand: z.string().nullish() };

export const contactsPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			...brandInput,
			segment: z.string().nullish(),
			search: z.string().max(200).nullish(),
			after: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const brand = await brandOf(context.organizationId, data.brand);
		// A live segment picked: its members as of now (at most a few minutes old).
		if (data.segment) {
			const { freshSegment } = await import("@/server/live-segments");
			await call(() => freshSegment(brand, data.segment as string, 5 * 60_000));
		}
		const [{ brands }, page, counts, segments, topics, properties] = await Promise.all([
			viewScope(context.organizationId),
			listContacts(brand, {
				segment: data.segment,
				search: data.search,
				after: data.after,
				limit: 50,
			}),
			contactCount(brand),
			listSegments(brand),
			listTopics(brand),
			listProperties(brand),
		]);
		const engagement = await engagementOf(brand, page.data);
		return {
			brand,
			brands,
			counts,
			contacts: page.data.map((c) => ({
				...contactView(c),
				engagement: engagement.get(c.id) ?? null,
			})),
			next: page.next,
			segments: segments.map((s) => segmentView(s, s.contacts)),
			topics: topics.map(topicView),
			properties: properties.map(propertyView),
		};
	});

export const getContactFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			// The contact's brand: the one picked, else whichever of the organization's has it.
			const { brands } = await viewScope(context.organizationId);
			const candidates = data.brand
				? [await brandIn(context.organizationId, data.brand)]
				: brands.length
					? brands.map((b) => b.id)
					: [context.organizationId];
			let found: Awaited<ReturnType<typeof getContact>> | null = null;
			for (const b of candidates) {
				found = await getContact(b, data.id).catch(() => null);
				if (found) break;
			}
			if (!found) throw new Response("Contact not found", { status: 404 });
			const brand = found.organization_id;
			const { contactReferrals } = await import("@/server/referrals");
			const { contactTimeline } = await import("@/server/timeline");
			const { contactLeadScore } = await import("@/server/lead-score");
			const { contactNotes, teamMembers } = await import("@/server/contact-notes");
			const [
				segments,
				mine,
				topics,
				properties,
				timeline,
				engagement,
				referrals,
				lead,
				notes,
				team,
				across,
			] = await Promise.all([
				listSegments(brand),
				segmentsOfContact(found.id),
				topicsOfContact(brand, found.id),
				listProperties(brand),
				contactTimeline(brand, found, { limit: 30 }),
				engagementOf(brand, [found]),
				contactReferrals(found),
				contactLeadScore(brand, found.id),
				contactNotes(brand, found),
				teamMembers(context.organizationId),
				// The same person in the organization's other brands (when it has several).
				brands.length > 1
					? import("@/server/person-across").then((m) =>
							m.personAcrossBrands(context.organizationId, found.email),
						)
					: null,
			]);
			const member = new Set(mine.map((m) => m.id));
			return {
				contact: contactView(found),
				engagement: engagement.get(found.id) ?? null,
				lead,
				notes,
				canNote: context.access.can("contacts:edit") || context.access.can("inbox:reply"),
				me: context.userId,
				team,
				across,
				referrals,
				brand: brands.find((b) => b.id === brand) ?? null,
				segments: segments.map((s) => ({
					id: s.id,
					name: s.name,
					live: !!s.rules,
					member: member.has(s.id),
				})),
				topics,
				properties: properties.map(propertyView),
				timeline: masked(timeline, context),
			};
		}),
	);

/** Subjects and event data can carry codes: masked for people who see digits masked. */
function masked<T extends { data: TimelineItem[] }>(page: T, context: { masked: boolean }) {
	if (!context.masked) return page;
	return {
		...page,
		data: page.data.map((x) =>
			"subject" in x ? { ...x, subject: maskDigits(x.subject) } : x,
		) as TimelineItem[],
	};
}

/** Older items of a contact's timeline (the page shows the first ones). */
export const contactTimelineFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, id: z.string(), before: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const c = await getContact(brand, data.id);
			const { contactTimeline } = await import("@/server/timeline");
			return masked(await contactTimeline(brand, c, { before: data.before }), context);
		}),
	);

/** Folds another contact (by address) into this one. */
export const mergeContactFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:delete")])
	.validator(z.object({ ...brandInput, id: z.string(), merge: z.string().min(1).max(320) }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { mergeContacts } = await import("@/server/timeline");
			const out = await mergeContacts(brand, data.id, data.merge);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "contact.merged",
				subject: { type: "contact", id: out.kept, name: out.email },
				detail: { merged: out.merged_email },
			});
			return out;
		}),
	);

const contactFields = z.object({
	email: z.string(),
	first_name: z.string().nullable(),
	last_name: z.string().nullable(),
	unsubscribed: z.boolean().optional(),
	properties: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).optional(),
	segments: z.array(z.string()).optional(),
	pace: z.enum(["weekly", "monthly"]).nullable().optional(),
	paused_until: z.string().nullable().optional(),
});

export const saveContactFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ ...brandInput, id: z.string().optional(), fields: contactFields }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			if (data.id) {
				const c = await updateContact(brand, data.id, data.fields);
				return { id: c.id };
			}
			const { contact, created } = await upsertContact(brand, {
				source: "dashboard",
				...(data.fields as object),
			});
			return { id: contact.id, created };
		}),
	);

export const deleteContactFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:delete")])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteContact(await brandOf(context.organizationId, data.brand), data.id);
			return { ok: true };
		}),
	);

export const setContactSegmentFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({ ...brandInput, id: z.string(), segment: z.string(), member: z.boolean() }),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const contact = await getContact(brand, data.id);
			if (data.member) await addToSegment(brand, contact.id, data.segment);
			else await removeFromSegment(brand, contact.id, data.segment);
			return { ok: true };
		}),
	);

export const setContactTopicFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			...brandInput,
			id: z.string(),
			topic: z.string(),
			subscription: z.enum(["opt_in", "opt_out"]),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			await setTopics(brand, data.id, [{ id: data.topic, subscription: data.subscription }]);
			return { ok: true };
		}),
	);

/** Up to 1,000 rows a call (the page sends a big file in parts). */
export const importContactsFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:import")])
	.validator(
		z.object({
			...brandInput,
			segment: z.string().nullish(),
			rows: z.array(importRow).max(1000),
		}),
	)
	.handler(({ data, context }) =>
		call(async () =>
			importContacts(await brandOf(context.organizationId, data.brand), data.rows, {
				segment: data.segment,
			}),
		),
	);

export const saveSegmentFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			...brandInput,
			id: z.string().optional(),
			name: z.string(),
			/** A live segment's rules; null: a list (undefined leaves it as it is). */
			rules: z.unknown().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const fields = {
				name: data.name,
				...(data.rules !== undefined ? { rules: data.rules } : {}),
			};
			const s = data.id
				? await renameSegment(brand, data.id, fields)
				: await createSegment(brand, fields);
			return { id: s.id };
		}),
	);

/** Who a live segment's rules match now: how many, and a few of them. */
export const previewSegmentFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, rules: z.unknown() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { previewRules } = await import("@/server/live-segments");
			const p = await previewRules(brand, data.rules);
			return {
				count: p.count,
				sample: p.sample.map((c) => ({
					...c,
					email: context.masked ? maskDigits(c.email) : c.email,
				})),
			};
		}),
	);

/** What live segments' rules can pick from: the brand's event names, forms and recent polls. */
export const segmentOptionsFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { segmentOptions } = await import("@/server/live-segments");
			return segmentOptions(brand);
		}),
	);

export const deleteSegmentFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteSegment(await brandOf(context.organizationId, data.brand), data.id);
			return { ok: true };
		}),
	);

export const saveTopicFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			...brandInput,
			id: z.string().optional(),
			name: z.string(),
			description: z.string().nullable(),
			default_subscription: z.enum(["opt_in", "opt_out"]).optional(),
			visibility: z.enum(["public", "private"]),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { brand: _b, id, ...fields } = data;
			const t = id ? await updateTopic(brand, id, fields) : await createTopic(brand, fields);
			return { id: t.id };
		}),
	);

export const deleteTopicFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteTopic(await brandOf(context.organizationId, data.brand), data.id);
			return { ok: true };
		}),
	);

export const savePropertyFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(
		z.object({
			...brandInput,
			key: z.string(),
			type: z.enum(["string", "number"]),
			fallback_value: z.string().nullable(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const p = await createProperty(brand, {
				key: data.key,
				type: data.type,
				fallback_value: data.fallback_value || null,
			});
			return { id: p.id };
		}),
	);

export const deletePropertyFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			await deleteProperty(await brandOf(context.organizationId, data.brand), data.id);
			return { ok: true };
		}),
	);

/** The Engagement page: how engaged a brand's contacts are, and its cold ones to clean up. */
export const engagementPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, ...coldInput.shape }))
	.handler(async ({ data, context }) => {
		const brand = await brandOf(context.organizationId, data.brand);
		const [{ brands }, overview, cold, segments] = await Promise.all([
			viewScope(context.organizationId),
			engagementOverview(brand),
			coldContacts(brand, { min_emails: data.min_emails, days: data.days }),
			listSegments(brand),
		]);
		return {
			brand,
			brands,
			overview,
			cold: cold.slice(0, 25),
			coldCount: cold.length,
			segments: segments.map((x) => ({ id: x.id, name: x.name })),
		};
	});

export const cleanUpFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:delete")])
	.validator(z.object({ ...brandInput, ...cleanUpInput.shape }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brand: b, ...rest } = data;
			return cleanUpCold(await brandOf(context.organizationId, b), rest);
		}),
	);

/** The Leads page: a brand's hottest contacts and how it scores them. */
export const leadsPageFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, level: z.enum(["hot", "warm", "cold"]).nullish() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { topLeads, ruleLabel, DEFAULT_SCORING } = await import("@/server/lead-score");
			const [{ brands }, top] = await Promise.all([
				viewScope(context.organizationId),
				topLeads(brand, { limit: 100, level: data.level ?? undefined }),
			]);
			return {
				brand,
				brands,
				...top,
				leads: top.leads.map((l) =>
					context.masked ? { ...l, email: maskDigits(l.email) } : l,
				),
				labels: top.scoring.rules.map(ruleLabel),
				defaults: DEFAULT_SCORING,
				canEdit: context.access.can("contacts:edit"),
			};
		}),
	);

export const saveLeadScoringFn = createServerFn({ method: "POST" })
	.middleware([can("contacts:edit")])
	.validator(z.object({ ...brandInput, scoring: z.unknown(), reset: z.boolean().optional() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const { saveScoring, resetScoring } = await import("@/server/lead-score");
			const s = data.reset
				? await resetScoring(brand)
				: await saveScoring(brand, data.scoring, context.userId);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "lead_scoring.edited",
				subject: { type: "brand", id: brand, name: "Lead scoring" },
			});
			return s;
		}),
	);

// ── Notes and follow-ups ────────────────────────────────────────────────────────────────

const contactName = (brand: string, id: string) =>
	getContact(brand, id)
		.then((c) => c.email)
		.catch(() => "a contact");

/** Notes are for people who edit contacts or answer them in the inbox. */
function mayNote(context: { access: { can: (p: "contacts:edit" | "inbox:reply") => boolean } }) {
	if (!context.access.can("contacts:edit") && !context.access.can("inbox:reply"))
		throw new Response("You need to be able to edit contacts or reply in the inbox", {
			status: 403,
		});
}

export const saveContactNoteFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			...brandInput,
			contact_id: z.string(),
			id: z.string().nullish(),
			text: z.string().optional(),
			due_at: z.string().nullish(),
			assignee_id: z.string().nullish(),
			done: z.boolean().optional(),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			mayNote(context);
			const brand = await brandOf(context.organizationId, data.brand);
			const { addContactNote, updateContactNote } = await import("@/server/contact-notes");
			const author = {
				type: "person" as const,
				id: context.userId,
				name: context.name || context.email,
			};
			const { brand: _b, contact_id, id, ...input } = data;
			const note = id
				? await updateContactNote({
						organizationId: context.organizationId,
						brand,
						id,
						author,
						input,
					})
				: await addContactNote({
						organizationId: context.organizationId,
						brand,
						contactId: contact_id,
						author,
						input: { ...input, text: input.text ?? "" },
					});
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: id
					? data.done
						? "contact_note.done"
						: "contact_note.edited"
					: note.kind === "follow_up"
						? "contact_note.follow_up"
						: "contact_note.added",
				subject: {
					type: "contact",
					id: contact_id,
					name: await contactName(brand, contact_id),
				},
			});
			return note;
		}),
	);

export const deleteContactNoteFn = createServerFn({ method: "POST" })
	.middleware([orgMiddleware])
	.validator(z.object({ ...brandInput, id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			mayNote(context);
			const brand = await brandOf(context.organizationId, data.brand);
			const { deleteContactNote } = await import("@/server/contact-notes");
			const row = await deleteContactNote(brand, data.id);
			await logActivity({
				organizationId: context.organizationId,
				userId: context.userId,
				action: "contact_note.deleted",
				subject: {
					type: "contact",
					id: row.contact_id,
					name: await contactName(brand, row.contact_id),
				},
			});
			return { ok: true };
		}),
	);
