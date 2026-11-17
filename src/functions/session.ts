import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { isOrgHandle } from "@/lib/org-handle";
import { memberAccess } from "@/server/access";
import { auth } from "@/server/auth";
import { listBrands } from "@/server/brands";
import { db, schema } from "@/server/db";
import { orgUnavailable, sessionMiddleware } from "@/server/middleware";
import { handleOf } from "@/server/org-handles";
import { orgLogos } from "@/server/org-logos";
import { inScope } from "@/server/queries";
import { roleName } from "@/server/roles";

/** Who is signed in, their organizations, the one in use and its brands. */
export const getMe = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) => {
		const m = schema.member;
		const o = schema.organization;
		const listed = await db
			.select({
				id: o.id,
				name: o.name,
				slug: o.slug,
				handle: o.handle,
				role: m.role,
				joined: m.createdAt,
			})
			.from(m)
			.innerJoin(o, eq(o.id, m.organizationId))
			.where(eq(m.userId, context.userId))
			.orderBy(asc(o.name));
		// Every organization's URL handle (one made before its hook ran gets it now).
		const rows = await Promise.all(
			listed.map(async (r) =>
				isOrgHandle(r.handle) ? r : { ...r, handle: (await handleOf(r.id)) ?? null },
			),
		);
		// Each one's logo for the switcher: its own, or a domain's brand logo.
		const logos = await orgLogos(rows.map((r) => r.id));
		const orgs = rows.map(({ joined: _, ...r }) => ({ ...r, logo: logos.get(r.id) ?? null }));
		// The tab's organization (its address), checked here like every call: one that doesn't
		// exist or isn't theirs is refused the same way, never replaced by another one.
		const named = context.namedOrganization
			? orgs.find((x) => x.id === context.activeOrganizationId)
			: undefined;
		if (context.namedOrganization && !named) throw orgUnavailable();
		// The one a link without an organization (/emails) opens next: the last one opened.
		if (named && named.id !== context.sessionOrganizationId)
			await auth()
				.api.setActiveOrganization({
					headers: getRequest().headers,
					body: { organizationId: named.id },
				})
				.catch(() => {});
		// Without one chosen, the first joined: the one orgMiddleware acts on, so what shows is
		// what a save changes.
		const first = rows.reduce<(typeof rows)[number] | null>(
			(a, r) => (!a || r.joined < a.joined ? r : a),
			null,
		);
		const chosen =
			named ??
			orgs.find((x) => x.id === context.activeOrganizationId) ??
			orgs.find((x) => x.id === first?.id) ??
			null;
		// What they may do there (the screens hide the rest; the server checks it again).
		const active = chosen
			? {
					...chosen,
					access: (await memberAccess(chosen.id, context.userId)).summary(),
					roleName: await roleName(chosen.id, chosen.role),
				}
			: null;
		// The brand pickers read these: names, and whether each is paused.
		const brands = active
			? (await listBrands(active.id)).map((b) => ({
					id: b.id,
					name: b.name,
					default: b.default,
					sending: b.sending,
					paused: b.paused,
					sesStatus: b.ses_status,
				}))
			: [];
		// Paused domains, for the banner that says why sending stopped.
		const d = schema.domains;
		const pausedDomains = active
			? await db
					.select({ id: d.id, name: d.name, reason: d.paused_reason })
					.from(d)
					.where(
						and(inScope(d.organization_id, { org: active.id }), isNotNull(d.paused_at)),
					)
					.limit(20)
			: [];
		return {
			pausedDomains,
			user: { id: context.userId, email: context.email, name: context.name },
			isAdmin: context.isAdmin,
			organizations: orgs,
			active,
			brands,
		};
	});

/**
 * The person's organizations, whichever one the tab names: for the page that says the tab's
 * organization doesn't exist or isn't theirs, which offers these instead.
 */
export const getMyOrganizations = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) => {
		const m = schema.member;
		const o = schema.organization;
		const listed = await db
			.select({ id: o.id, name: o.name, handle: o.handle, role: m.role })
			.from(m)
			.innerJoin(o, eq(o.id, m.organizationId))
			.where(eq(m.userId, context.userId))
			.orderBy(asc(o.name));
		const logos = await orgLogos(listed.map((r) => r.id));
		const organizations = await Promise.all(
			listed.map(async (r) => ({
				...r,
				handle: isOrgHandle(r.handle) ? r.handle : ((await handleOf(r.id)) ?? null),
				logo: logos.get(r.id) ?? null,
			})),
		);
		return { email: context.email, isAdmin: context.isAdmin, organizations };
	});
