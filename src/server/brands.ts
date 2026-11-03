import { and, eq, inArray, sql } from "drizzle-orm";
import { batch, db, raw, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { forgetOrg } from "./org";
import { moveDomainTenant, setUpOrganization } from "./provision";
import { inScope, type Scope } from "./queries";
import { iso } from "./time";

/**
 * Brands: who an organization's emails are from (schema.brands). The organization itself is its
 * default brand (same id); the others are rows of `organization` linked to it, each its own SES
 * tenant, so one hotel's bounces never pause another's mail. Members, API keys and webhooks are
 * the organization's and cover every brand.
 */

const parents = new Map<string, { value: string | null; until: number }>();
const TTL_MS = 60_000;

/** The organization a brand belongs to, or null for an organization (a default brand). */
export async function parentOf(brandId: string): Promise<string | null> {
	const hit = parents.get(brandId);
	if (hit && hit.until > Date.now()) return hit.value;
	const row = await db
		.select({ parent_id: schema.brands.parent_id })
		.from(schema.brands)
		.where(eq(schema.brands.id, brandId))
		.get();
	const value = row?.parent_id ?? null;
	parents.set(brandId, { value, until: Date.now() + TTL_MS });
	return value;
}

/** The organization whose brand this is (itself, for a default brand). */
export const orgOf = async (brandId: string) => (await parentOf(brandId)) ?? brandId;

const slugPart = (s: string) =>
	s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export interface BrandView {
	object: "brand";
	id: string;
	name: string;
	slug: string;
	/** The organization's own brand (its id is the organization's). */
	default: boolean;
	external_id: string | null;
	/** "not_set_up" | "ready" | "error". */
	sending: string;
	sending_error: string | null;
	/** SES's own status of its tenant (ENABLED, REINSTATED, DISABLED…), as last read. */
	ses_status: string | null;
	paused: { at: string; by: string; reason: string | null } | null;
	created_at: string;
}

/** Every brand of an organization, its default one first. */
export async function listBrands(organizationId: string): Promise<BrandView[]> {
	const o = schema.organization;
	const b = schema.brands;
	const s = schema.orgSending;
	const [self, rows] = await Promise.all([
		db
			.select({ org: o, sending: s })
			.from(o)
			.leftJoin(s, eq(s.organization_id, o.id))
			.where(eq(o.id, organizationId))
			.get(),
		db
			.select({ org: o, link: b, sending: s })
			.from(b)
			.innerJoin(o, eq(o.id, b.id))
			.leftJoin(s, eq(s.organization_id, b.id))
			.where(eq(b.parent_id, organizationId)),
	]);
	if (!self) throw notFound("Organization");
	const view = (
		org: typeof o.$inferSelect,
		sending: typeof s.$inferSelect | null,
		link: typeof b.$inferSelect | null,
	): BrandView => ({
		object: "brand",
		id: org.id,
		name: org.name,
		slug: org.slug,
		default: !link,
		external_id: link?.external_id ?? null,
		sending: sending?.status ?? "not_set_up",
		sending_error: sending?.status === "error" ? (sending.last_error ?? null) : null,
		ses_status: sending?.tenant_status ?? null,
		paused: sending?.paused_at
			? {
					at: sending.paused_at,
					by: sending.paused_by ?? "you",
					reason: sending.paused_reason ?? null,
				}
			: null,
		created_at: link?.created_at ?? iso(org.createdAt.getTime()),
	});
	return [
		view(self.org, self.sending, null),
		...rows
			.map((r) => view(r.org, r.sending, r.link))
			.sort((a, z) => a.name.localeCompare(z.name)),
	];
}

/** The ids of an organization's brands. */
export async function brandIds(organizationId: string): Promise<string[]> {
	const rows = await db
		.select({ id: schema.brands.id })
		.from(schema.brands)
		.where(eq(schema.brands.parent_id, organizationId));
	return [organizationId, ...rows.map((r) => r.id)];
}

/**
 * One of the organization's brands by its id, slug or external id (the API takes any); a brand
 * of another organization is not found.
 */
export async function brandIn(organizationId: string, ref: string): Promise<string> {
	const value = ref.trim();
	if (value === organizationId) return organizationId;
	const o = schema.organization;
	const b = schema.brands;
	const self = await db
		.select({ id: o.id })
		.from(o)
		.where(and(eq(o.id, organizationId), eq(o.slug, value)))
		.get();
	if (self) return organizationId;
	const row = await db
		.select({ id: b.id })
		.from(b)
		.innerJoin(o, eq(o.id, b.id))
		.where(
			and(
				eq(b.parent_id, organizationId),
				sql`(${b.id} = ${value} OR ${o.slug} = ${value} OR ${b.external_id} = ${value})`,
			),
		)
		.get();
	if (!row) throw notFound("Brand");
	return row.id;
}

export async function getBrand(organizationId: string, ref: string) {
	const id = await brandIn(organizationId, ref);
	const brand = (await listBrands(organizationId)).find((x) => x.id === id);
	if (!brand) throw notFound("Brand");
	return brand;
}

/**
 * A new brand of the organization, with its SES tenant set up. With an `externalId` the
 * organization already used, that brand instead (set up again if it isn't ready), so a retried
 * call never makes two.
 */
export async function createBrand(
	organizationId: string,
	input: { name: string; externalId?: string | null },
) {
	if (await parentOf(organizationId))
		throw new ApiError(403, "invalid_access", "A brand can't have brands of its own");
	const name = input.name.trim().slice(0, 80);
	if (!name) throw validation("A brand needs a name");
	const externalId = input.externalId?.trim() || null;
	if (externalId) {
		const existing = await db
			.select({ id: schema.brands.id })
			.from(schema.brands)
			.where(
				and(
					eq(schema.brands.parent_id, organizationId),
					eq(schema.brands.external_id, externalId),
				),
			)
			.get();
		if (existing) {
			const current = await getBrand(organizationId, existing.id);
			if (current.sending !== "ready") await trySetUp(existing.id);
			return { brand: await getBrand(organizationId, existing.id), created: false };
		}
	}
	const parent = await db
		.select()
		.from(schema.organization)
		.where(eq(schema.organization.id, organizationId))
		.get();
	if (!parent) throw notFound("Organization");
	const id = crypto.randomUUID().replace(/-/g, "");
	// The organization's slug first, so SES's tenant names show whose it is.
	const slug = `${parent.slug}-${slugPart(name).slice(0, 30) || "brand"}-${id.slice(0, 6)}`;
	const now = new Date();
	await db.batch([
		db.insert(schema.organization).values({ id, name, slug, createdAt: now }),
		db.insert(schema.brands).values({
			id,
			parent_id: organizationId,
			external_id: externalId,
			created_at: iso(now.getTime()),
		}),
	]);
	parents.delete(id);
	await trySetUp(id);
	return { brand: await getBrand(organizationId, id), created: true };
}

/** Sets up the SES tenant; a failure stays on the brand (sending: "error") to retry. */
async function trySetUp(brandId: string) {
	try {
		await setUpOrganization(brandId);
	} catch (error) {
		console.error("brands: set up failed", brandId, error);
	}
}

export async function renameBrand(organizationId: string, ref: string, name: string) {
	const id = await brandIn(organizationId, ref);
	const clean = name.trim().slice(0, 80);
	if (!clean) throw validation("A brand needs a name");
	await db.update(schema.organization).set({ name: clean }).where(eq(schema.organization.id, id));
	return getBrand(organizationId, id);
}

/**
 * Pauses a brand (its sends are refused and its queue waits) or resumes it. A pause Mailroom
 * placed (by: "mailroom") only the deployment's admins lift.
 */
export async function setBrandPaused(
	organizationId: string,
	ref: string,
	paused: boolean,
	o: { by?: "you" | "mailroom"; reason?: string | null; isAdmin?: boolean } = {},
) {
	const id = await brandIn(organizationId, ref);
	const s = schema.orgSending;
	const row = await db.select().from(s).where(eq(s.organization_id, id)).get();
	if (!row) throw new ApiError(409, "brand_not_ready", "Set up sending for this brand first");
	if (!paused && row.paused_by === "mailroom" && !o.isAdmin)
		throw new ApiError(
			403,
			"paused_by_mailroom",
			"Mailroom paused this brand; ask this deployment's admins to resume it",
		);
	await db
		.update(s)
		.set(
			paused
				? {
						paused_at: row.paused_at ?? iso(),
						paused_by: o.by ?? "you",
						paused_reason: o.reason ?? null,
						updated_at: iso(),
					}
				: { paused_at: null, paused_by: null, paused_reason: null, updated_at: iso() },
		)
		.where(eq(s.organization_id, id));
	forgetOrg(id);
	return getBrand(organizationId, id);
}

/**
 * Removes a brand: its domains move to `moveTo` (another brand of the organization, in SES too),
 * and so do its emails, suppressions, unsubscribes and numbers, so nothing it sent is lost. The
 * default brand can't be removed.
 */
export async function removeBrand(organizationId: string, ref: string, moveTo: string) {
	const id = await brandIn(organizationId, ref);
	if (id === organizationId)
		throw new ApiError(409, "default_brand", "The organization's own brand can't be removed");
	const target = await brandIn(organizationId, moveTo);
	if (target === id) throw validation("Move its domains to another brand");
	const s = schema.orgSending;
	const targetSending = await db.select().from(s).where(eq(s.organization_id, target)).get();
	if (targetSending?.status !== "ready")
		throw new ApiError(
			409,
			"brand_not_ready",
			"The brand that gets its domains isn't set up yet",
		);
	const domains = await db
		.select()
		.from(schema.domains)
		.where(eq(schema.domains.organization_id, id));
	for (const d of domains) await moveDomainTenant(d, id, target);
	const moves = [
		db
			.update(schema.domains)
			.set({ organization_id: target })
			.where(eq(schema.domains.organization_id, id)),
		db
			.update(schema.emails)
			.set({ organization_id: target })
			.where(eq(schema.emails.organization_id, id)),
		db
			.update(schema.emailEvents)
			.set({ organization_id: target })
			.where(eq(schema.emailEvents.organization_id, id)),
		raw(
			"INSERT OR IGNORE INTO suppressions (organization_id, address, reason, detail, email_id, created_at) SELECT ?, address, reason, detail, email_id, created_at FROM suppressions WHERE organization_id = ?",
			target,
			id,
		),
		raw(
			"INSERT OR IGNORE INTO unsubscribes (organization_id, `group`, address, email_id, created_at) SELECT ?, `group`, address, email_id, created_at FROM unsubscribes WHERE organization_id = ?",
			target,
			id,
		),
		raw(
			"INSERT OR IGNORE INTO inline_images (organization_id, hash, content_type, bytes, last_used_at) SELECT ?, hash, content_type, bytes, last_used_at FROM inline_images WHERE organization_id = ?",
			target,
			id,
		),
		raw(
			"INSERT INTO daily_stats (organization_id, day, sent, delivered, bounced, soft_bounced, complained, opened, clicked, failed, delayed, suppressed) SELECT ?, day, sent, delivered, bounced, soft_bounced, complained, opened, clicked, failed, delayed, suppressed FROM daily_stats WHERE organization_id = ? ON CONFLICT (organization_id, day) DO UPDATE SET sent = sent + excluded.sent, delivered = delivered + excluded.delivered, bounced = bounced + excluded.bounced, soft_bounced = soft_bounced + excluded.soft_bounced, complained = complained + excluded.complained, opened = opened + excluded.opened, clicked = clicked + excluded.clicked, failed = failed + excluded.failed, delayed = delayed + excluded.delayed, suppressed = suppressed + excluded.suppressed",
			target,
			id,
		),
		raw(
			"INSERT INTO domain_stats (organization_id, day, domain, sent, delivered, bounced, soft_bounced, complained, opened, clicked, failed, delayed, suppressed) SELECT ?, day, domain, sent, delivered, bounced, soft_bounced, complained, opened, clicked, failed, delayed, suppressed FROM domain_stats WHERE organization_id = ? ON CONFLICT (organization_id, day, domain) DO UPDATE SET sent = sent + excluded.sent, delivered = delivered + excluded.delivered, bounced = bounced + excluded.bounced, soft_bounced = soft_bounced + excluded.soft_bounced, complained = complained + excluded.complained, opened = opened + excluded.opened, clicked = clicked + excluded.clicked, failed = failed + excluded.failed, delayed = delayed + excluded.delayed, suppressed = suppressed + excluded.suppressed",
			target,
			id,
		),
		raw(
			"INSERT INTO provider_stats (organization_id, day, provider, sent, delivered, bounced, complained, opened) SELECT ?, day, provider, sent, delivered, bounced, complained, opened FROM provider_stats WHERE organization_id = ? ON CONFLICT (organization_id, day, provider) DO UPDATE SET sent = sent + excluded.sent, delivered = delivered + excluded.delivered, bounced = bounced + excluded.bounced, complained = complained + excluded.complained, opened = opened + excluded.opened",
			target,
			id,
		),
		db.delete(schema.dailyStats).where(eq(schema.dailyStats.organization_id, id)),
		db.delete(schema.providerStats).where(eq(schema.providerStats.organization_id, id)),
		db.delete(schema.domainStats).where(eq(schema.domainStats.organization_id, id)),
		db.delete(schema.organization).where(eq(schema.organization.id, id)),
	];
	await batch(moves);
	parents.delete(id);
	forgetOrg(id);
	forgetOrg(target);
	return { id, moved_to: target, domains: domains.length };
}

/**
 * What the dashboard shows an organization: all its brands, or the one `pick` names. With only
 * the default brand, `brands` is empty (nothing to pick between).
 */
export async function viewScope(
	organizationId: string,
	pick?: string | null,
): Promise<{ scope: Scope; brands: { id: string; name: string }[] }> {
	const o = schema.organization;
	const b = schema.brands;
	const [self, others] = await Promise.all([
		db.select({ id: o.id, name: o.name }).from(o).where(eq(o.id, organizationId)).get(),
		db
			.select({ id: o.id, name: o.name })
			.from(b)
			.innerJoin(o, eq(o.id, b.id))
			.where(eq(b.parent_id, organizationId)),
	]);
	if (!self || others.length === 0) return { scope: organizationId, brands: [] };
	const brands = [self, ...others.sort((a, z) => a.name.localeCompare(z.name))];
	if (pick && brands.some((x) => x.id === pick)) return { scope: pick, brands };
	return { scope: { org: organizationId }, brands };
}

/** Names of brands by id (for rows that say whose they are). */
export async function brandNames(ids: string[]) {
	const out = new Map<string, string>();
	const list = [...new Set(ids)];
	// D1 takes up to 100 parameters a statement.
	for (let i = 0; i < list.length; i += 90) {
		const rows = await db
			.select({ id: schema.organization.id, name: schema.organization.name })
			.from(schema.organization)
			.where(inArray(schema.organization.id, list.slice(i, i + 90)));
		for (const r of rows) out.set(r.id, r.name);
	}
	return out;
}

/**
 * Can the organization send right now, and if not, why not (GET /api/status): each brand's
 * state, paused domains and webhooks that are down.
 */
export async function sendingStatus(organizationId: string, brandId?: string | null) {
	const all = await listBrands(organizationId);
	const brands = brandId ? all.filter((b) => b.id === brandId) : all;
	const d = schema.domains;
	const [domains, hooks] = await Promise.all([
		db
			.select({
				id: d.id,
				name: d.name,
				brand_id: d.organization_id,
				status: d.status,
				paused_at: d.paused_at,
				paused_reason: d.paused_reason,
			})
			.from(d)
			.where(
				brandId
					? eq(d.organization_id, brandId)
					: inScope(d.organization_id, { org: organizationId }),
			),
		db
			.select({
				id: schema.webhooks.id,
				url: schema.webhooks.url,
				down_since: schema.webhooks.down_since,
			})
			.from(schema.webhooks)
			.where(eq(schema.webhooks.organization_id, organizationId)),
	]);
	const why = (b: BrandView) =>
		b.paused
			? { code: "brand_paused", by: b.paused.by, reason: b.paused.reason }
			: b.ses_status && b.ses_status !== "ENABLED" && b.ses_status !== "REINSTATED"
				? { code: "ses_paused", by: "ses", reason: `SES tenant status ${b.ses_status}` }
				: b.sending !== "ready"
					? { code: "brand_not_ready", by: null, reason: b.sending_error }
					: null;
	const view = brands.map((b) => {
		const stopped = why(b);
		const own = domains.filter((x) => x.brand_id === b.id);
		return {
			id: b.id,
			name: b.name,
			can_send: !stopped && own.some((x) => x.status === "verified" && !x.paused_at),
			stopped,
			domains: own.map((x) => ({
				id: x.id,
				name: x.name,
				status: x.status,
				paused: x.paused_at ? { at: x.paused_at, reason: x.paused_reason } : null,
			})),
		};
	});
	return {
		object: "status" as const,
		can_send: view.some((b) => b.can_send),
		brands: view,
		webhooks_down: hooks
			.filter((h) => h.down_since)
			.map((h) => ({ id: h.id, url: h.url, down_since: h.down_since })),
	};
}
