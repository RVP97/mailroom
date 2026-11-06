import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
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
import { listEmails } from "@/server/queries";
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
			const [segments, mine, topics, properties, emails, engagement] = await Promise.all([
				listSegments(brand),
				segmentsOfContact(found.id),
				topicsOfContact(brand, found.id),
				listProperties(brand),
				listEmails(brand, { search: found.email, limit: 10 }),
				engagementOf(brand, [found]),
			]);
			const member = new Set(mine.map((m) => m.id));
			return {
				contact: contactView(found),
				engagement: engagement.get(found.id) ?? null,
				brand: brands.find((b) => b.id === brand) ?? null,
				segments: segments.map((s) => ({
					id: s.id,
					name: s.name,
					member: member.has(s.id),
				})),
				topics,
				properties: properties.map(propertyView),
				emails: emails.data.map((e) => ({
					id: e.id,
					subject: e.subject,
					status: e.last_event ?? e.status,
					created_at: e.created_at,
				})),
			};
		}),
	);

const contactFields = z.object({
	email: z.string(),
	first_name: z.string().nullable(),
	last_name: z.string().nullable(),
	unsubscribed: z.boolean().optional(),
	properties: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).optional(),
	segments: z.array(z.string()).optional(),
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
	.validator(z.object({ ...brandInput, id: z.string().optional(), name: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const brand = await brandOf(context.organizationId, data.brand);
			const s = data.id
				? await renameSegment(brand, data.id, { name: data.name })
				: await createSegment(brand, { name: data.name });
			return { id: s.id };
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
