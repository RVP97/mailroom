import { and, desc, inArray, like, or, sql } from "drizzle-orm";
import { maskDigits } from "../lib/roles";
import { listConversations } from "./conversations";
import { db, schema } from "./db";
import type { InboxActor } from "./inboxes";

/**
 * Search everything (⌘K and the assistant): contacts, conversations, broadcasts and issues,
 * templates, segments, automations, newsletters, campaigns, surveys, help articles and domains of
 * the brands someone sees, a few of each, best first.
 */

export type SearchKind =
	| "contact"
	| "conversation"
	| "broadcast"
	| "template"
	| "segment"
	| "automation"
	| "newsletter"
	| "campaign"
	| "survey"
	| "article"
	| "domain";

export type SearchHit = {
	kind: SearchKind;
	id: string;
	title: string;
	/** A second line: an email, a status, a subject. */
	detail: string | null;
	brand: string | null;
	/** Its page in the dashboard. */
	path: string;
};

export const SEARCH_KINDS: SearchKind[] = [
	"contact",
	"conversation",
	"broadcast",
	"template",
	"segment",
	"automation",
	"newsletter",
	"campaign",
	"survey",
	"article",
	"domain",
];

/** `%term%` for LIKE, the term lowercased and its wildcards dropped. */
const pattern = (q: string) => `%${q.toLowerCase().replace(/[%_\\]/g, "")}%`;
const lower = (col: unknown) => sql`lower(${col})`;

export async function searchEverything(o: {
	organizationId: string;
	brands: string[];
	actor: InboxActor;
	q: string;
	names: Map<string, string>;
	masked: boolean;
	/** At most this many of each kind (default 5). */
	per?: number;
	kinds?: SearchKind[];
}) {
	const q = o.q.trim().slice(0, 100);
	if (q.length < 2) return { query: q, hits: [] as SearchHit[] };
	const per = Math.min(Math.max(o.per ?? 5, 1), 20);
	const p = pattern(q);
	const want = new Set(o.kinds?.length ? o.kinds : SEARCH_KINDS);
	const brands = o.brands.length ? o.brands : [o.organizationId];
	const many = brands.length > 1;
	const brandName = (id: string) => (many ? (o.names.get(id) ?? null) : null);
	const dots = (s: string | null) => (s && o.masked ? maskDigits(s) : s);
	const none = Promise.resolve([] as SearchHit[]);
	const s = schema;

	const contacts = want.has("contact")
		? db
				.select({
					id: s.contacts.id,
					organization_id: s.contacts.organization_id,
					email: s.contacts.email,
					first: s.contacts.first_name,
					last: s.contacts.last_name,
				})
				.from(s.contacts)
				.where(
					and(
						inArray(s.contacts.organization_id, brands),
						or(
							like(s.contacts.email, p),
							like(lower(s.contacts.first_name), p),
							like(lower(s.contacts.last_name), p),
							like(
								sql`lower(COALESCE(${s.contacts.first_name}, '') || ' ' || COALESCE(${s.contacts.last_name}, ''))`,
								p,
							),
						),
					),
				)
				.orderBy(
					// An exact address first, then where it starts with the term.
					sql`CASE WHEN ${s.contacts.email} = ${q.toLowerCase()} THEN 0 WHEN ${s.contacts.email} LIKE ${`${q.toLowerCase().replace(/[%_\\]/g, "")}%`} THEN 1 ELSE 2 END`,
					desc(s.contacts.created_at),
				)
				.limit(per)
				.then((rows) =>
					rows.map(
						(r): SearchHit => ({
							kind: "contact",
							id: r.id,
							title:
								[r.first, r.last].filter(Boolean).join(" ") ||
								(dots(r.email) ?? ""),
							detail: [r.first, r.last].some(Boolean) ? dots(r.email) : null,
							brand: brandName(r.organization_id),
							path: `/contacts/${r.id}`,
						}),
					),
				)
		: none;

	const conversations = want.has("conversation")
		? listConversations({ ...o.actor, brands }, { search: q, status: "all", limit: per }).then(
				(page) =>
					page.data.map(
						(c): SearchHit => ({
							kind: "conversation",
							id: c.id,
							title: c.subject || "(no subject)",
							detail: [dots(c.contact), c.status === "open" ? "Open" : "Resolved"]
								.filter(Boolean)
								.join(" · "),
							brand: brandName(c.brand_id),
							path: `/received/${c.id}`,
						}),
					),
			)
		: none;

	/** Rows of a table with a name-like column, matched on it (and a second column). */
	const named = <K extends SearchKind>(
		kind: K,
		run: () => Promise<
			{ id: string; organization_id: string; title: string; detail?: string | null }[]
		>,
		path: (id: string) => string,
	) =>
		want.has(kind)
			? run().then((rows) =>
					rows.map(
						(r): SearchHit => ({
							kind,
							id: r.id,
							title: dots(r.title) || "Untitled",
							detail: dots(r.detail ?? null),
							brand: brandName(r.organization_id),
							path: path(r.id),
						}),
					),
				)
			: none;

	const b = s.broadcasts;
	const broadcasts = named(
		"broadcast",
		() =>
			db
				.select({
					id: b.id,
					organization_id: b.organization_id,
					title: sql<string>`COALESCE(NULLIF(${b.name}, ''), NULLIF(${b.subject}, ''), 'Untitled broadcast')`,
					detail: sql<string>`${b.status} || CASE WHEN ${b.subject} != '' AND ${b.subject} != ${b.name} THEN ' · ' || ${b.subject} ELSE '' END`,
				})
				.from(b)
				.where(
					and(
						inArray(b.organization_id, brands),
						or(like(lower(b.name), p), like(lower(b.subject), p)),
					),
				)
				.orderBy(desc(b.updated_at))
				.limit(per),
		(id) => `/broadcasts/${id}`,
	);
	const t = s.templates;
	const templates = named(
		"template",
		() =>
			db
				.select({ id: t.id, organization_id: t.organization_id, title: t.name })
				.from(t)
				.where(
					and(
						inArray(t.organization_id, [...new Set([o.organizationId, ...brands])]),
						like(lower(t.name), p),
					),
				)
				.orderBy(desc(t.updated_at))
				.limit(per),
		(id) => `/templates/${id}`,
	);
	const sg = s.segments;
	const segments = named(
		"segment",
		() =>
			db
				.select({ id: sg.id, organization_id: sg.organization_id, title: sg.name })
				.from(sg)
				.where(and(inArray(sg.organization_id, brands), like(lower(sg.name), p)))
				.limit(per),
		(id) => `/contacts?segment=${encodeURIComponent(id)}`,
	);
	const au = s.automations;
	const automations = named(
		"automation",
		() =>
			db
				.select({
					id: au.id,
					organization_id: au.organization_id,
					title: au.name,
					detail: au.status,
				})
				.from(au)
				.where(and(inArray(au.organization_id, brands), like(lower(au.name), p)))
				.orderBy(desc(au.updated_at))
				.limit(per),
		(id) => `/automations/${id}`,
	);
	const nl = s.newsletters;
	const newsletters = named(
		"newsletter",
		() =>
			db
				.select({ id: nl.id, organization_id: nl.organization_id, title: nl.name })
				.from(nl)
				.where(and(inArray(nl.organization_id, brands), like(lower(nl.name), p)))
				.limit(per),
		(id) => `/newsletters/${id}`,
	);
	const cp = s.campaigns;
	const campaigns = named(
		"campaign",
		() =>
			db
				.select({
					id: cp.id,
					organization_id: cp.organization_id,
					title: cp.name,
					detail: cp.description,
				})
				.from(cp)
				.where(and(inArray(cp.organization_id, brands), like(lower(cp.name), p)))
				.limit(per),
		(id) => `/campaigns/${id}`,
	);
	const sv = s.surveys;
	const surveys = named(
		"survey",
		() =>
			db
				.select({
					id: sv.id,
					organization_id: sv.organization_id,
					title: sv.name,
					detail: sv.question,
				})
				.from(sv)
				.where(
					and(
						inArray(sv.organization_id, brands),
						or(like(lower(sv.name), p), like(lower(sv.question), p)),
					),
				)
				.limit(per),
		(id) => `/surveys/${id}`,
	);
	const ha = s.helpArticles;
	const articles = named(
		"article",
		() =>
			db
				.select({
					id: ha.id,
					organization_id: ha.organization_id,
					title: ha.title,
					detail: ha.status,
				})
				.from(ha)
				.where(and(inArray(ha.organization_id, brands), like(lower(ha.title), p)))
				.orderBy(desc(ha.updated_at))
				.limit(per),
		(id) => `/articles/${id}`,
	);
	const dm = s.domains;
	const domains = named(
		"domain",
		() =>
			db
				.select({
					id: dm.id,
					organization_id: dm.organization_id,
					title: dm.name,
					detail: dm.status,
				})
				.from(dm)
				.where(and(inArray(dm.organization_id, brands), like(dm.name, p)))
				.limit(per),
		(id) => `/domains/${id}`,
	);

	const groups = await Promise.all([
		contacts,
		conversations,
		broadcasts,
		templates,
		segments,
		automations,
		newsletters,
		campaigns,
		surveys,
		articles,
		domains,
	]);
	const seen = new Set<string>();
	const hits = groups.flat().filter((h) => {
		const key = `${h.kind}:${h.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { query: q, hits };
}
