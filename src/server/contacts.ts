import { and, asc, count, eq, inArray, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { bareAddress } from "./aws/mime";
import { batch, db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { iso } from "./time";

/**
 * Contacts, segments, topics and contact properties, as Resend's (2025): a brand's list of people,
 * grouped in segments that broadcasts go to, with topics each can opt in or out of. Everything is
 * per brand, like suppressions: a hotel's guests aren't another hotel's.
 *
 * Unsubscribing ties in with Mailroom's unsubscribe groups: a broadcast's link is the group
 * `topic:<id>` (its topic) or `broadcasts` (none), and using it marks the contact (unsubscribeSync).
 */

export const ALL_BROADCASTS_GROUP = "broadcasts";
export const topicGroup = (topicId: string) => `topic:${topicId}`;

const ct = schema.contacts;
const sg = schema.segments;
const cs = schema.contactSegments;
const tp = schema.topics;
const ctp = schema.contactTopics;
const pr = schema.contactProperties;

export type Contact = typeof ct.$inferSelect;

const email = z
	.string()
	.trim()
	.max(320)
	.transform((a) => bareAddress(a).toLowerCase())
	.refine((a) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a), "is not a valid email address");
const name = z.string().trim().max(200).nullish();
const propertyValues = z.record(z.string(), z.union([z.string().max(2000), z.number()]).nullable());
const subscription = z.enum(["opt_in", "opt_out"]);
/** Segments as ids, or Resend's [{ id }]. */
const ids = z
	.array(z.union([z.string(), z.object({ id: z.string() })]))
	.max(100)
	.transform((v) => v.map((x) => (typeof x === "string" ? x : x.id)));
const topicChoices = z.array(z.object({ id: z.string(), subscription })).max(100);

export const contactInput = z.object({
	email,
	first_name: name,
	firstName: name,
	last_name: name,
	lastName: name,
	unsubscribed: z.boolean().optional(),
	properties: propertyValues.optional(),
	segments: ids.optional(),
	/** Resend's old name for a segment. */
	audience_id: z.string().optional(),
	audienceId: z.string().optional(),
	topics: topicChoices.optional(),
	/** Where they came from, for the growth page (a new contact only): "api" when left out. */
	source: z.string().trim().max(100).optional(),
	source_detail: z.string().trim().max(200).optional(),
	/** How often they want broadcasts: "weekly", "monthly", or null for every one. */
	pace: z.enum(["weekly", "monthly"]).nullable().optional(),
	/** No broadcasts or automation emails until then (an ISO time; null: not paused). */
	paused_until: z.string().datetime({ offset: true }).nullable().optional(),
});

/** How often they want broadcasts and their pause, when given. */
const paceFields = (v: { pace?: "weekly" | "monthly" | null; paused_until?: string | null }) => ({
	...(v.pace !== undefined ? { pace: v.pace } : {}),
	...(v.paused_until !== undefined
		? { paused_until: v.paused_until ? iso(Date.parse(v.paused_until)) : null }
		: {}),
});

/** unsubscribed_at follows a change of `unsubscribed` (kept while it stays the same). */
const unsubscribedAt = (out: boolean | undefined, now: number, was?: Contact) =>
	out === undefined
		? {}
		: out
			? { unsubscribed_at: was?.unsubscribed ? was.unsubscribed_at : iso(now) }
			: { unsubscribed_at: null };

// ── Properties ───────────────────────────────────────────────────────────────

const KEY = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_KEYS = ["email", "first_name", "last_name", "unsubscribed", "id"];

export const propertyInput = z.object({
	key: z
		.string()
		.trim()
		.regex(KEY, "keys take lowercase letters, numbers and _ (company_name)")
		.refine((k) => !RESERVED_KEYS.includes(k), "is a reserved name"),
	type: z.enum(["string", "number"]).default("string"),
	fallback_value: z.union([z.string().max(2000), z.number()]).nullish(),
});

export const propertyView = (p: typeof pr.$inferSelect) => ({
	object: "contact_property",
	id: p.id,
	key: p.key,
	type: p.type as "string" | "number",
	fallback_value:
		p.fallback_value === null
			? null
			: p.type === "number"
				? Number(p.fallback_value)
				: p.fallback_value,
	created_at: p.created_at,
});

export const listProperties = (brand: string) =>
	db.select().from(pr).where(eq(pr.organization_id, brand)).orderBy(asc(pr.key));

export async function createProperty(brand: string, raw: unknown) {
	const v = propertyInput.parse(raw);
	if (
		v.type === "number" &&
		v.fallback_value != null &&
		!Number.isFinite(Number(v.fallback_value))
	)
		throw validation("fallback_value must be a number");
	const row = {
		id: crypto.randomUUID(),
		organization_id: brand,
		key: v.key,
		type: v.type,
		fallback_value: v.fallback_value == null ? null : String(v.fallback_value),
		created_at: iso(),
	};
	const [made] = await db.insert(pr).values(row).onConflictDoNothing().returning();
	if (!made) throw new ApiError(409, "property_exists", `There's already a property ${v.key}`);
	return made;
}

async function propertyOf(brand: string, ref: string) {
	const row = await db
		.select()
		.from(pr)
		.where(and(eq(pr.organization_id, brand), or(eq(pr.id, ref), eq(pr.key, ref))))
		.get();
	if (!row) throw notFound("Contact property");
	return row;
}

export async function updateProperty(brand: string, ref: string, raw: unknown) {
	const p = await propertyOf(brand, ref);
	const v = z
		.object({ fallback_value: z.union([z.string().max(2000), z.number()]).nullish() })
		.parse(raw);
	const [row] = await db
		.update(pr)
		.set({ fallback_value: v.fallback_value == null ? null : String(v.fallback_value) })
		.where(eq(pr.id, p.id))
		.returning();
	return row as typeof p;
}

export async function deleteProperty(brand: string, ref: string) {
	const p = await propertyOf(brand, ref);
	await db.delete(pr).where(eq(pr.id, p.id));
	return p;
}

/** Values checked against the brand's properties (declared, of their type); null removes one. */
async function checkProperties(
	brand: string,
	given: Record<string, string | number | null> | undefined,
	o: { declare?: boolean } = {},
) {
	if (!given || !Object.keys(given).length) return given;
	let declared = new Map((await listProperties(brand)).map((p) => [p.key, p]));
	const missing = Object.keys(given).filter((k) => !declared.has(k));
	if (missing.length && o.declare) {
		// An import's extra columns become text properties.
		for (const key of missing)
			if (KEY.test(key) && !RESERVED_KEYS.includes(key))
				await createProperty(brand, { key, type: "string" }).catch(() => {});
		declared = new Map((await listProperties(brand)).map((p) => [p.key, p]));
	}
	const out: Record<string, string | number | null> = {};
	for (const [k, value] of Object.entries(given)) {
		const p = declared.get(k);
		if (!p)
			throw validation(
				`properties.${k}: no such contact property (create it first: POST /contact-properties)`,
			);
		if (value === null || value === "") out[k] = null;
		else if (p.type === "number") {
			const n = Number(value);
			if (!Number.isFinite(n)) throw validation(`properties.${k} must be a number`);
			out[k] = n;
		} else out[k] = String(value);
	}
	return out;
}

const merge = (
	base: Record<string, string | number> | null,
	change: Record<string, string | number | null> | undefined,
) => {
	if (!change) return base;
	const next = { ...(base ?? {}) };
	for (const [k, v] of Object.entries(change))
		if (v === null) delete next[k];
		else next[k] = v;
	return Object.keys(next).length ? next : null;
};

// ── Contacts ─────────────────────────────────────────────────────────────────

export const contactView = (c: Contact) => ({
	object: "contact",
	id: c.id,
	brand_id: c.organization_id,
	email: c.email,
	first_name: c.first_name,
	last_name: c.last_name,
	unsubscribed: c.unsubscribed,
	properties: c.properties ?? {},
	/** Learned from where they open and click; broadcasts sent at local time use it. */
	timezone: c.timezone,
	/** How often they want broadcasts ("weekly", "monthly"; null: every one), from their preferences. */
	pace: c.pace ?? null,
	/** They paused broadcasts and automation emails until then. */
	paused_until: c.paused_until ?? null,
	created_at: c.created_at,
	updated_at: c.updated_at,
});

/** A brand's contact by id or address. */
export async function getContact(brand: string, ref: string): Promise<Contact> {
	const r = decodeURIComponent(ref).trim();
	const row = await db
		.select()
		.from(ct)
		.where(
			and(
				eq(ct.organization_id, brand),
				r.includes("@") ? eq(ct.email, r.toLowerCase()) : eq(ct.id, r),
			),
		)
		.get();
	if (!row) throw notFound("Contact");
	return row;
}

/**
 * Adds a contact, or updates the one with that address (an app can call it on every sign-up).
 * Segments and topics given are added to the contact's.
 */
export async function upsertContact(brand: string, raw: unknown, now = Date.now()) {
	const v = contactInput.parse(raw);
	const properties = await checkProperties(brand, v.properties ?? undefined);
	const existing = await db
		.select()
		.from(ct)
		.where(and(eq(ct.organization_id, brand), eq(ct.email, v.email)))
		.get();
	const first = v.first_name ?? v.firstName;
	const last = v.last_name ?? v.lastName;
	let contact: Contact;
	if (existing) {
		const [row] = await db
			.update(ct)
			.set({
				...(first !== undefined ? { first_name: first || null } : {}),
				...(last !== undefined ? { last_name: last || null } : {}),
				...(v.unsubscribed !== undefined ? { unsubscribed: v.unsubscribed } : {}),
				...unsubscribedAt(v.unsubscribed, now, existing),
				...paceFields(v),
				properties: merge(existing.properties, properties),
				updated_at: iso(now),
			})
			.where(eq(ct.id, existing.id))
			.returning();
		contact = row as Contact;
	} else {
		const [row] = await db
			.insert(ct)
			.values({
				id: crypto.randomUUID(),
				organization_id: brand,
				email: v.email,
				first_name: first || null,
				last_name: last || null,
				unsubscribed: v.unsubscribed ?? false,
				unsubscribed_at: v.unsubscribed ? iso(now) : null,
				source: v.source || "api",
				source_detail: v.source_detail || null,
				...paceFields(v),
				properties: merge(null, properties),
				created_at: iso(now),
				updated_at: iso(now),
			})
			.returning();
		contact = row as Contact;
	}
	const segmentIds = [...(v.segments ?? []), v.audience_id ?? v.audienceId].filter(
		Boolean,
	) as string[];
	for (const s of segmentIds) await addToSegment(brand, contact.id, s, now);
	if (v.topics?.length) await setTopics(brand, contact.id, v.topics, now);
	if (v.unsubscribed !== undefined) await syncGlobalUnsubscribe(contact, v.unsubscribed);
	if (!existing) await contactAdded(brand, contact, segmentIds, now);
	else await contactChanged(existing, contact, now);
	return { contact, created: !existing };
}

/** Someone added (not by an import): automations that start then hear it. */
async function contactAdded(brand: string, c: Contact, segments: string[], now: number) {
	const { onContactAdded } = await import("./automations");
	await onContactAdded(brand, c, segments, now);
}

/** A contact changed: automations on unsubscribing or a property changing hear it. */
async function contactChanged(
	before: Pick<Contact, "unsubscribed" | "properties">,
	after: Contact,
	now: number,
) {
	const { onContactChanged } = await import("./automations");
	await onContactChanged(before, after, now);
}

export const contactPatch = contactInput.omit({ email: true }).extend({ email: email.optional() });

export async function updateContact(brand: string, ref: string, raw: unknown, now = Date.now()) {
	const c = await getContact(brand, ref);
	const v = contactPatch.parse(raw);
	const properties = await checkProperties(brand, v.properties ?? undefined);
	if (v.email && v.email !== c.email) {
		const taken = await db
			.select({ id: ct.id })
			.from(ct)
			.where(and(eq(ct.organization_id, brand), eq(ct.email, v.email)))
			.get();
		if (taken) throw new ApiError(409, "contact_exists", `${v.email} is already a contact`);
	}
	const first = v.first_name ?? v.firstName;
	const last = v.last_name ?? v.lastName;
	const [row] = await db
		.update(ct)
		.set({
			...(v.email ? { email: v.email } : {}),
			...(first !== undefined ? { first_name: first || null } : {}),
			...(last !== undefined ? { last_name: last || null } : {}),
			...(v.unsubscribed !== undefined ? { unsubscribed: v.unsubscribed } : {}),
			...unsubscribedAt(v.unsubscribed, now, c),
			...paceFields(v),
			properties: merge(c.properties, properties),
			updated_at: iso(now),
		})
		.where(eq(ct.id, c.id))
		.returning();
	const contact = row as Contact;
	for (const s of v.segments ?? []) await addToSegment(brand, contact.id, s, now);
	if (v.topics?.length) await setTopics(brand, contact.id, v.topics, now);
	if (v.unsubscribed !== undefined) await syncGlobalUnsubscribe(contact, v.unsubscribed);
	await contactChanged(c, contact, now);
	return contact;
}

export async function deleteContact(brand: string, ref: string) {
	const c = await getContact(brand, ref);
	await db.delete(ct).where(eq(ct.id, c.id));
	return c;
}

export async function listContacts(
	brand: string,
	o: {
		segment?: string | null;
		search?: string | null;
		after?: string | null;
		limit?: number;
		unsubscribed?: boolean | null;
	} = {},
) {
	const limit = Math.min(Math.max(o.limit ?? 50, 1), 100);
	const where = [eq(ct.organization_id, brand)];
	if (o.segment)
		where.push(
			inArray(
				ct.id,
				db.select({ id: cs.contact_id }).from(cs).where(eq(cs.segment_id, o.segment)),
			),
		);
	if (o.search) {
		const q = `%${o.search.trim().toLowerCase().replace(/[%_]/g, "")}%`;
		where.push(
			or(
				like(ct.email, q),
				like(sql`lower(${ct.first_name})`, q),
				like(sql`lower(${ct.last_name})`, q),
			) as ReturnType<typeof eq>,
		);
	}
	if (o.unsubscribed !== undefined && o.unsubscribed !== null)
		where.push(eq(ct.unsubscribed, o.unsubscribed));
	// Newest first; the cursor is the last row's created_at and id.
	if (o.after) {
		const [at, id] = o.after.split("|");
		if (at && id)
			where.push(
				or(
					sql`${ct.created_at} < ${at}`,
					and(eq(ct.created_at, at), sql`${ct.id} < ${id}`),
				) as ReturnType<typeof eq>,
			);
	}
	const rows = await db
		.select()
		.from(ct)
		.where(and(...where))
		.orderBy(sql`${ct.created_at} DESC, ${ct.id} DESC`)
		.limit(limit + 1);
	const data = rows.slice(0, limit);
	const last = data.at(-1);
	return {
		data,
		has_more: rows.length > limit,
		next: rows.length > limit && last ? `${last.created_at}|${last.id}` : null,
	};
}

export async function contactCount(brand: string) {
	const [all, out] = await Promise.all([
		db.select({ n: count() }).from(ct).where(eq(ct.organization_id, brand)).get(),
		db
			.select({ n: count() })
			.from(ct)
			.where(and(eq(ct.organization_id, brand), eq(ct.unsubscribed, true)))
			.get(),
	]);
	return { total: all?.n ?? 0, unsubscribed: out?.n ?? 0 };
}

export const importRow = z.object({
	email: z.string(),
	first_name: z.string().nullish(),
	last_name: z.string().nullish(),
	unsubscribed: z.boolean().nullish(),
	properties: z.record(z.string(), z.union([z.string(), z.number()]).nullable()).optional(),
});

/**
 * Many contacts at once (a CSV): new addresses are added, known ones get the names and properties
 * given (blank cells change nothing). Columns that aren't properties yet become text properties.
 * Rows with an address that isn't one are skipped and counted.
 */
export async function importContacts(
	brand: string,
	rows: z.input<typeof importRow>[],
	o: { segment?: string | null; now?: number } = {},
) {
	const now = iso(o.now);
	if (o.segment) await listSegmentOf(brand, o.segment);
	const keys = [...new Set(rows.flatMap((r) => Object.keys(r.properties ?? {})))];
	const declared = await checkProperties(brand, Object.fromEntries(keys.map((k) => [k, null])), {
		declare: true,
	});
	const types = new Map((await listProperties(brand)).map((p) => [p.key, p.type]));
	let skipped = 0;
	const clean = new Map<string, z.output<typeof importRow>>();
	for (const raw of rows) {
		const r = importRow.safeParse(raw);
		const address = r.success ? bareAddress(r.data.email.trim()).toLowerCase() : "";
		if (!r.success || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
			skipped++;
			continue;
		}
		const properties: Record<string, string | number> = {};
		for (const [k, v] of Object.entries(r.data.properties ?? {})) {
			if (!declared || !(k in declared) || v === null || v === "") continue;
			if (types.get(k) === "number") {
				const n = Number(v);
				if (Number.isFinite(n)) properties[k] = n;
			} else properties[k] = String(v);
		}
		clean.set(address, { ...r.data, email: address, properties });
	}
	const list = [...clean.values()];
	let added = 0;
	for (let i = 0; i < list.length; i += 50) {
		const chunk = list.slice(i, i + 50);
		const statements = chunk.map((r) =>
			db
				.insert(ct)
				.values({
					id: crypto.randomUUID(),
					organization_id: brand,
					email: r.email,
					first_name: r.first_name?.trim() || null,
					last_name: r.last_name?.trim() || null,
					unsubscribed: r.unsubscribed ?? false,
					unsubscribed_at: r.unsubscribed ? now : null,
					source: "import",
					properties: Object.keys(r.properties ?? {}).length
						? (r.properties as never)
						: null,
					created_at: now,
					updated_at: now,
				})
				.onConflictDoUpdate({
					target: [ct.organization_id, ct.email],
					set: {
						first_name: sql`COALESCE(excluded.first_name, ${ct.first_name})`,
						last_name: sql`COALESCE(excluded.last_name, ${ct.last_name})`,
						properties: sql`CASE WHEN excluded.properties IS NULL THEN ${ct.properties} ELSE json_patch(COALESCE(${ct.properties}, '{}'), excluded.properties) END`,
						updated_at: now,
					},
				})
				.returning({ id: ct.id, created_at: ct.created_at }),
		);
		const results = (await batch(statements)) as D1Result<{ id: string; created_at: string }>[];
		const made = results.flatMap((r) => r.results ?? []);
		added += made.filter((m) => m.created_at === now).length;
		if (o.segment && made.length)
			await batch(
				made.map((m) =>
					db
						.insert(cs)
						.values({
							contact_id: m.id,
							segment_id: o.segment as string,
							created_at: now,
						})
						.onConflictDoNothing(),
				),
			);
		// New contacts imported as unsubscribed are out of every broadcast email too, the same
		// as one who used the link (existing contacts keep what they chose).
		const out = chunk.filter(
			(r, k) => r.unsubscribed && results[k]?.results?.[0]?.created_at === now,
		);
		if (out.length)
			await batch(
				out.map((r) =>
					db
						.insert(u)
						.values({
							organization_id: brand,
							group: ALL_BROADCASTS_GROUP,
							address: r.email,
							created_at: now,
						})
						.onConflictDoNothing(),
				),
			);
	}
	return { imported: list.length, added, updated: list.length - added, skipped };
}

// ── Segments ─────────────────────────────────────────────────────────────────

export async function segmentOf(brand: string, id: string) {
	const row = await db
		.select()
		.from(sg)
		.where(and(eq(sg.organization_id, brand), eq(sg.id, id)))
		.get();
	if (!row) throw notFound("Segment");
	return row;
}

export const segmentView = (
	s: Pick<typeof sg.$inferSelect, "id" | "organization_id" | "name" | "created_at"> &
		Partial<Pick<typeof sg.$inferSelect, "rules" | "refreshed_at">>,
	contacts?: number,
) => ({
	object: "segment",
	id: s.id,
	brand_id: s.organization_id,
	name: s.name,
	created_at: s.created_at,
	/** Live: its members are whoever matches `rules` (src/server/live-segments.ts). */
	live: !!s.rules,
	rules: s.rules ?? null,
	refreshed_at: s.refreshed_at ?? null,
	...(contacts !== undefined ? { contacts } : {}),
});

const segmentInput = z.object({
	name: z.string().trim().min(1).max(120),
	/** Rules make it a live segment; null makes it a list again (its members stay). */
	rules: z.unknown().optional(),
});

export async function listSegments(brand: string) {
	const rows = await db
		.select({
			segment: sg,
			contacts: sql<number>`(SELECT COUNT(*) FROM contact_segments x WHERE x.segment_id = ${sg.id})`,
		})
		.from(sg)
		.where(eq(sg.organization_id, brand))
		.orderBy(asc(sg.name));
	return rows.map((r) => ({ ...r.segment, contacts: Number(r.contacts) }));
}

export async function createSegment(brand: string, raw: unknown) {
	const v = segmentInput.parse(raw);
	const { checkRules, refreshSegment } = await import("./live-segments");
	const rules = v.rules ? await checkRules(brand, v.rules) : null;
	const row = {
		id: crypto.randomUUID(),
		organization_id: brand,
		name: v.name,
		created_at: iso(),
		rules,
		refreshed_at: null,
	};
	await db.insert(sg).values(row);
	if (rules) await refreshSegment(row);
	return segmentOf(brand, row.id);
}

/** Renames a segment, and with `rules` makes it live (or, with null, a list again). */
export async function renameSegment(brand: string, id: string, raw: unknown) {
	await segmentOf(brand, id);
	const v = segmentInput.partial({ name: true }).parse(raw);
	const set: Partial<typeof sg.$inferInsert> = {};
	if (v.name) set.name = v.name;
	if (v.rules !== undefined) {
		const { checkRules } = await import("./live-segments");
		set.rules = v.rules ? await checkRules(brand, v.rules, id) : null;
		set.refreshed_at = null;
	}
	if (!Object.keys(set).length) return segmentOf(brand, id);
	const [row] = await db.update(sg).set(set).where(eq(sg.id, id)).returning();
	if (row?.rules) {
		const { refreshSegment } = await import("./live-segments");
		await refreshSegment(row);
	}
	return row as typeof sg.$inferSelect;
}

/** A list segment of the brand (not a live one): what people can be put in. */
export async function listSegmentOf(brand: string, id: string) {
	const s = await segmentOf(brand, id);
	notLive(s);
	return s;
}

/** Refuses hand changes to a live segment's members. */
function notLive(s: typeof sg.$inferSelect) {
	if (s.rules)
		throw validation(
			`${s.name} is a live segment: it fills itself from its rules, so people can't be added or taken out by hand`,
		);
}

export async function deleteSegment(brand: string, id: string) {
	const s = await segmentOf(brand, id);
	await db.delete(sg).where(eq(sg.id, id));
	return s;
}

/** Refuses a contact id that isn't this brand's: a segment only ever holds its own brand's contacts. */
async function ownContact(brand: string, contactId: string) {
	const row = await db
		.select({ id: ct.id })
		.from(ct)
		.where(and(eq(ct.id, contactId), eq(ct.organization_id, brand)))
		.get();
	if (!row) throw notFound("Contact");
}

export async function addToSegment(
	brand: string,
	contactId: string,
	segmentId: string,
	now = Date.now(),
) {
	notLive(await segmentOf(brand, segmentId));
	await ownContact(brand, contactId);
	const [row] = await db
		.insert(cs)
		.values({ contact_id: contactId, segment_id: segmentId, created_at: iso(now) })
		.onConflictDoNothing()
		.returning();
	if (row) {
		const { onSegmentJoined } = await import("./automations");
		await onSegmentJoined(brand, contactId, segmentId, now);
	}
	return !!row;
}

export async function removeFromSegment(brand: string, contactId: string, segmentId: string) {
	notLive(await segmentOf(brand, segmentId));
	await ownContact(brand, contactId);
	const r = await db
		.delete(cs)
		.where(and(eq(cs.contact_id, contactId), eq(cs.segment_id, segmentId)))
		.returning();
	return r.length > 0;
}

export async function segmentsOfContact(contactId: string) {
	return db
		.select({
			id: sg.id,
			name: sg.name,
			created_at: sg.created_at,
			organization_id: sg.organization_id,
		})
		.from(cs)
		.innerJoin(sg, eq(sg.id, cs.segment_id))
		.where(eq(cs.contact_id, contactId))
		.orderBy(asc(sg.name));
}

// ── Topics ───────────────────────────────────────────────────────────────────

export const topicInput = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).nullish(),
	default_subscription: subscription.default("opt_out"),
	visibility: z.enum(["public", "private"]).default("public"),
});

export const topicView = (t: typeof tp.$inferSelect) => ({
	object: "topic",
	id: t.id,
	brand_id: t.organization_id,
	name: t.name,
	description: t.description,
	default_subscription: t.default_subscription as "opt_in" | "opt_out",
	visibility: t.visibility as "public" | "private",
	created_at: t.created_at,
});

export const listTopics = (brand: string) =>
	db.select().from(tp).where(eq(tp.organization_id, brand)).orderBy(asc(tp.name));

export async function topicOf(brand: string, id: string) {
	const row = await db
		.select()
		.from(tp)
		.where(and(eq(tp.organization_id, brand), eq(tp.id, id)))
		.get();
	if (!row) throw notFound("Topic");
	return row;
}

export async function createTopic(brand: string, raw: unknown) {
	const v = topicInput.parse(raw);
	const row = {
		id: crypto.randomUUID(),
		organization_id: brand,
		name: v.name,
		description: v.description ?? null,
		default_subscription: v.default_subscription,
		visibility: v.visibility,
		created_at: iso(),
	};
	await db.insert(tp).values(row);
	return row;
}

export async function updateTopic(brand: string, id: string, raw: unknown) {
	await topicOf(brand, id);
	// The default can't change: who's in would change under everyone's feet.
	const v = topicInput.omit({ default_subscription: true }).partial().parse(raw);
	const [row] = await db
		.update(tp)
		.set({
			...(v.name ? { name: v.name } : {}),
			...(v.description !== undefined ? { description: v.description ?? null } : {}),
			...(v.visibility ? { visibility: v.visibility } : {}),
		})
		.where(eq(tp.id, id))
		.returning();
	return row as typeof tp.$inferSelect;
}

export async function deleteTopic(brand: string, id: string) {
	const t = await topicOf(brand, id);
	await db.delete(tp).where(eq(tp.id, id));
	return t;
}

/** Each of the brand's topics and whether the contact gets it. */
export async function topicsOfContact(brand: string, contactId: string) {
	const [all, chosen] = await Promise.all([
		listTopics(brand),
		db.select().from(ctp).where(eq(ctp.contact_id, contactId)),
	]);
	const by = new Map(chosen.map((c) => [c.topic_id, c.subscription]));
	return all.map((t) => ({
		...topicView(t),
		subscription: (by.get(t.id) ?? t.default_subscription) as "opt_in" | "opt_out",
	}));
}

export async function setTopics(
	brand: string,
	contactId: string,
	choices: { id: string; subscription: "opt_in" | "opt_out" }[],
	now = Date.now(),
) {
	const contact = await db.select().from(ct).where(eq(ct.id, contactId)).get();
	if (!contact || contact.organization_id !== brand) throw notFound("Contact");
	for (const c of choices) {
		await topicOf(brand, c.id);
		const was = await db
			.select({ subscription: ctp.subscription })
			.from(ctp)
			.where(and(eq(ctp.contact_id, contactId), eq(ctp.topic_id, c.id)))
			.get();
		await db
			.insert(ctp)
			.values({
				contact_id: contactId,
				topic_id: c.id,
				subscription: c.subscription,
				updated_at: iso(now),
			})
			.onConflictDoUpdate({
				target: [ctp.topic_id, ctp.contact_id],
				set: { subscription: c.subscription, updated_at: iso(now) },
			});
		// The unsubscribe group behind the topic's links follows.
		await syncGroup(brand, topicGroup(c.id), contact.email, c.subscription === "opt_out");
		if (was?.subscription !== c.subscription) {
			const { onTopicChanged } = await import("./automations");
			await onTopicChanged(brand, contactId, c.id, c.subscription, now);
		}
	}
}

// ── Unsubscribes ─────────────────────────────────────────────────────────────

const u = schema.unsubscribes;

/** The unsubscribe group's row follows the contact (so plain sends to the group agree). */
async function syncGroup(brand: string, group: string, address: string, out: boolean) {
	if (out)
		await db
			.insert(u)
			.values({ organization_id: brand, group, address, created_at: iso() })
			.onConflictDoNothing();
	else
		await db
			.delete(u)
			.where(and(eq(u.organization_id, brand), eq(u.group, group), eq(u.address, address)));
}

export async function syncGlobalUnsubscribe(
	c: Pick<Contact, "organization_id" | "email">,
	out: boolean,
) {
	await syncGroup(c.organization_id, ALL_BROADCASTS_GROUP, c.email, out);
}

/**
 * Someone used an unsubscribe link (or was put back): their contact, if they're one, follows. A
 * topic's group opts them out of the topic; the broadcasts group unsubscribes them from all.
 */
export async function unsubscribeSync(brand: string, group: string, address: string, out: boolean) {
	const contact = await db
		.select()
		.from(ct)
		.where(and(eq(ct.organization_id, brand), eq(ct.email, address.toLowerCase())))
		.get();
	if (!contact) return;
	const now = iso();
	if (group === ALL_BROADCASTS_GROUP) {
		await db
			.update(ct)
			.set({
				unsubscribed: out,
				unsubscribed_at: out
					? contact.unsubscribed
						? contact.unsubscribed_at
						: now
					: null,
				updated_at: now,
			})
			.where(eq(ct.id, contact.id));
		if (out && !contact.unsubscribed)
			await contactChanged(contact, { ...contact, unsubscribed: true }, Date.parse(now));
	} else if (group.startsWith("topic:")) {
		const topicId = group.slice("topic:".length);
		const topic = await db
			.select({ id: tp.id })
			.from(tp)
			.where(and(eq(tp.id, topicId), eq(tp.organization_id, brand)))
			.get();
		if (!topic) return;
		const value = out ? "opt_out" : "opt_in";
		const was = await db
			.select({ subscription: ctp.subscription })
			.from(ctp)
			.where(and(eq(ctp.contact_id, contact.id), eq(ctp.topic_id, topicId)))
			.get();
		await db
			.insert(ctp)
			.values({
				contact_id: contact.id,
				topic_id: topicId,
				subscription: value,
				updated_at: now,
			})
			.onConflictDoUpdate({
				target: [ctp.topic_id, ctp.contact_id],
				set: { subscription: value, updated_at: now },
			});
		if (was?.subscription !== value) {
			const { onTopicChanged } = await import("./automations");
			await onTopicChanged(brand, contact.id, topicId, value, Date.parse(now));
		}
	}
}

/** The values a contact fills in a template: FIRST_NAME, LAST_NAME, EMAIL and contact.<key>. */
export async function contactValues(brand: string, c: Contact) {
	const props = await listProperties(brand);
	const values: Record<string, string | number> = {
		FIRST_NAME: c.first_name ?? "",
		LAST_NAME: c.last_name ?? "",
		EMAIL: c.email,
		"contact.email": c.email,
		"contact.first_name": c.first_name ?? "",
		"contact.last_name": c.last_name ?? "",
	};
	for (const p of props) {
		const v = c.properties?.[p.key];
		const fallback =
			p.fallback_value === null
				? ""
				: p.type === "number"
					? Number(p.fallback_value)
					: p.fallback_value;
		values[`contact.${p.key}`] = v ?? fallback;
	}
	return values;
}
