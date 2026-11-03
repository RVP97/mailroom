import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { memberAccess } from "@/server/access";
import { listBrands } from "@/server/brands";
import { roleName } from "@/server/roles";
import { db, schema } from "@/server/db";
import { sessionMiddleware } from "@/server/middleware";
import { orgLogos } from "@/server/org-logos";
import { inScope } from "@/server/queries";

/** Who is signed in, their organizations, the one in use and its brands. */
export const getMe = createServerFn({ method: "GET" })
	.middleware([sessionMiddleware])
	.handler(async ({ context }) => {
		const m = schema.member;
		const o = schema.organization;
		const rows = await db
			.select({ id: o.id, name: o.name, slug: o.slug, role: m.role, joined: m.createdAt })
			.from(m)
			.innerJoin(o, eq(o.id, m.organizationId))
			.where(eq(m.userId, context.userId))
			.orderBy(asc(o.name));
		// Each one's logo for the switcher: its own, or a domain's brand logo.
		const logos = await orgLogos(rows.map((r) => r.id));
		const orgs = rows.map(({ joined: _, ...r }) => ({ ...r, logo: logos.get(r.id) ?? null }));
		// Without one chosen, the first joined: the one orgMiddleware acts on, so what shows is
		// what a save changes.
		const first = rows.reduce<(typeof rows)[number] | null>(
			(a, r) => (!a || r.joined < a.joined ? r : a),
			null,
		);
		const chosen =
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
