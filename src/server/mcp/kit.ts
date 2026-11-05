import { z } from "zod";
import { NO_PERMISSION_MESSAGE, PERMISSION_LABEL, type Permission } from "../../lib/permissions";
import { logActivity } from "../activity";
import { brandIds, brandIn } from "../brands";
import { db, schema } from "../db";
import { ApiError, notFound } from "../errors";
import { bimiLogoUrl, dnsRecords } from "../provision";
import { inScope, type Scope } from "../queries";
import type { McpContext, Membership } from "./tools";

/**
 * What every tool module shares: the tool's shape, the common inputs (organization, brand), and
 * how a call finds its organization and checks the person may do what the tool does there.
 */

export interface Tool {
	name: string;
	title: string;
	description: string;
	input: z.ZodRawShape;
	readOnly?: boolean;
	destructive?: boolean;
	/** Reaches outside Mailroom (sends email, writes to Cloudflare). */
	openWorld?: boolean;
	/** Only the deployment's admins see it. */
	adminOnly?: boolean;
	run: (args: Record<string, unknown>, ctx: McpContext) => Promise<unknown>;
}

export const organization = z
	.string()
	.optional()
	.describe("The organization's slug, id or name. Optional when you belong to only one.");

export const brand = z
	.string()
	.optional()
	.describe(
		"One of the organization's brands (id, slug or external id; see list_brands). Without it, every brand.",
	);

export const oneBrand = z
	.string()
	.optional()
	.describe(
		"One of the organization's brands (id, slug or external id; see list_brands). Without it, the organization's own brand.",
	);

/** One brand of the organization, or all of them. */
export const scopeOf = async (orgId: string, ref: unknown): Promise<Scope> =>
	typeof ref === "string" && ref.trim() ? brandIn(orgId, ref) : { org: orgId };

/** The brand a write names, or the organization's own. */
export const brandOf = async (orgId: string, ref: unknown) =>
	typeof ref === "string" && ref.trim() ? brandIn(orgId, ref) : orgId;

/** The brand named, or every brand of the organization. */
export const brandsOf = async (orgId: string, ref?: unknown) =>
	typeof ref === "string" && ref.trim() ? [await brandIn(orgId, ref)] : brandIds(orgId);

/** What a call needs: being a member, being an owner, or one permission. */
export type Need = "member" | "owner" | Permission;

export const forbidden = (org: Membership, p?: Permission) =>
	new ApiError(
		403,
		"forbidden",
		`${NO_PERMISSION_MESSAGE} (${org.name}${p ? `: ${PERMISSION_LABEL[p].toLowerCase()}` : ""}).`,
	);

/** The organization a call names (slug, id or name; optional with one), if the person may. */
export function orgAt(ctx: McpContext, ref: unknown, need: Need = "member"): Membership {
	const r = typeof ref === "string" ? ref.trim().toLowerCase() : "";
	const list = ctx.organizations;
	const org = r
		? list.find((o) => o.id === ref || o.slug === r || o.name.toLowerCase() === r)
		: list.length === 1
			? list[0]
			: undefined;
	if (!org)
		throw new ApiError(
			404,
			"not_found",
			r
				? `No organization "${String(ref)}" among yours: ${list.map((o) => o.slug).join(", ") || "none"}.`
				: `Name the organization: ${list.map((o) => o.slug).join(", ") || "you aren't in any"}.`,
		);
	if (need === "owner" && !org.access.owner) throw forbidden(org);
	if (need !== "member" && need !== "owner" && !org.access.can(need)) throw forbidden(org, need);
	return org;
}

/** Refuses unless the person has `p` in the organization. */
export function requires(org: Membership, p: Permission) {
	if (!org.access.can(p)) throw forbidden(org, p);
}

/** A change made through the assistant, in the organization's activity log. */
export const logged = (
	ctx: McpContext,
	org: Membership,
	action: string,
	subject: { type: string; id?: string | null; name?: string | null },
	detail?: Record<string, unknown>,
) =>
	logActivity({
		organizationId: org.id,
		userId: ctx.userId,
		action,
		subject,
		detail: { via: "assistant", ...(detail ?? {}) } as never,
	});

/** A domain of any of the organization's brands, by id or name. */
export async function domainOf(organizationId: string, ref: string) {
	const d = schema.domains;
	const rows = await db
		.select()
		.from(d)
		.where(inScope(d.organization_id, { org: organizationId }));
	const name = ref.trim().toLowerCase();
	const row = rows.find((r) => r.id === ref || r.name === name);
	if (!row) throw notFound("Domain");
	return row;
}

export const domainView = (d: typeof schema.domains.$inferSelect) => ({
	id: d.id,
	name: d.name,
	brand_id: d.organization_id,
	purpose: d.purpose,
	sending: d.sending,
	paused: d.paused_at ? { at: d.paused_at, reason: d.paused_reason } : null,
	status: d.status,
	region: d.region,
	checked_at: d.checked_at,
	open_tracking: d.open_tracking,
	click_tracking: d.click_tracking,
	tracking_domain: d.tracking_host ? { name: d.tracking_host, status: d.tracking_status } : null,
	receiving: d.receiving
		? { host: d.receiving_host ?? d.name, status: d.receiving_status ?? "pending" }
		: null,
	bimi_logo: d.bimi_logo ? { url: bimiLogoUrl(d), updated_at: d.bimi_updated_at } : null,
	records: dnsRecords(d),
});

/** The block design the dashboard's email editor makes, as agents write it. */
export const DESIGN_HELP =
	"The email as blocks (what the dashboard's editor makes; it's rendered to HTML for you): { version: 1, theme: { background, surface, text, heading, accent, button_text (\"#rrggbb\"), font, heading_font (modern|inter|helvetica|georgia|book|mono), width (px, e.g. 600), radius, padding, size (15–17) }, blocks: [{ id, type, … }] }. Block types: logo { src, alt, width, align, href }, heading { html, level 1–3, align }, text { html, align }, button { label, url, align, full, color }, image { src, alt, href, width, align }, quote { html }, divider, spacer { height }, social { links: [{ label, url }], align }, footer { html, unsubscribe }, html { html }, poll { question, options, align } (broadcasts), columns { ratio 1-1|1-2|2-1, columns: [[blocks], [blocks]] }. align: left|center|right. Images: upload_file. null drops the design (html stays).";

/** Splits "a@x.com, b@y.com" or takes a list. */
export const addressList = (v: unknown): string[] =>
	(Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\s]+/) : [])
		.map((a) => String(a).trim())
		.filter(Boolean);

/** Only the keys given (undefined left out), for partial updates. */
export const defined = (o: Record<string, unknown>, omit: string[] = []) =>
	Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && !omit.includes(k)));
