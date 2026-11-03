import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";

/** What sending needs to know of a brand: its SES tenants and its domains. */
export interface OrgContext {
	id: string;
	tenant: string | null;
	configurationSet: string | null;
	/** Where its Marketing domains send (null until made). */
	marketing: { tenant: string; configurationSet: string } | null;
	ready: boolean;
	/** The brand is paused (by "you" or "mailroom"). */
	paused: { by: string; reason: string | null } | null;
	domains: {
		id: string;
		name: string;
		verified: boolean;
		open_tracking: boolean;
		click_tracking: boolean;
		tracking_host: string | null;
		tracking_status: string | null;
		purpose: string;
		paused: boolean;
		paused_reason: string | null;
	}[];
}

const cache = new Map<string, { value: OrgContext; until: number }>();
const TTL_MS = 15_000;

export async function orgContext(organizationId: string): Promise<OrgContext> {
	const hit = cache.get(organizationId);
	if (hit && hit.until > Date.now()) return hit.value;
	const [sending, domains] = await db.batch([
		db
			.select()
			.from(schema.orgSending)
			.where(eq(schema.orgSending.organization_id, organizationId)),
		db
			.select({
				id: schema.domains.id,
				name: schema.domains.name,
				status: schema.domains.status,
				open_tracking: schema.domains.open_tracking,
				click_tracking: schema.domains.click_tracking,
				tracking_host: schema.domains.tracking_host,
				tracking_status: schema.domains.tracking_status,
				purpose: schema.domains.purpose,
				paused_at: schema.domains.paused_at,
				paused_reason: schema.domains.paused_reason,
			})
			.from(schema.domains)
			// A domain only for receiving can't be sent from.
			.where(
				and(
					eq(schema.domains.organization_id, organizationId),
					eq(schema.domains.sending, true),
				),
			),
	]);
	const s = sending[0];
	const value: OrgContext = {
		id: organizationId,
		tenant: s?.tenant_name ?? null,
		configurationSet: s?.configuration_set ?? null,
		marketing:
			s?.marketing_tenant_name && s.marketing_configuration_set
				? {
						tenant: s.marketing_tenant_name,
						configurationSet: s.marketing_configuration_set,
					}
				: null,
		ready: s?.status === "ready",
		paused: s?.paused_at ? { by: s.paused_by ?? "you", reason: s.paused_reason ?? null } : null,
		domains: domains.map(({ status, paused_at, ...d }) => ({
			...d,
			verified: status === "verified",
			paused: !!paused_at,
		})),
	};
	cache.set(organizationId, { value, until: Date.now() + TTL_MS });
	return value;
}

/** After a change to a brand's domains, pause or SES setup. */
export const forgetOrg = (organizationId: string) => cache.delete(organizationId);

/** The brand's domain an address sends from (the domain itself or a subdomain of it). */
export function domainFor(ctx: OrgContext, address: string) {
	const host = address.split("@")[1]?.toLowerCase() ?? "";
	return (
		ctx.domains
			.filter((d) => host === d.name || host.endsWith(`.${d.name}`))
			.sort((a, b) => b.name.length - a.name.length)[0] ?? null
	);
}

/** SES's status of a tenant that still sends (null: not read yet). */
export const tenantSends = (status: string | null | undefined) =>
	status == null || status === "ENABLED" || status === "REINSTATED";
