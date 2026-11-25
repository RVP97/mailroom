import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "./db";
import { notFound } from "./errors";
import { organizationOf } from "./org-aws";
import { publicUrl, shownHere } from "./public-host";
import { iso } from "./time";

/**
 * Built-in Public Status Page (/status/<slug>, /status/<slug>/status.json, /status/<slug>/feed.xml)
 * plus live Outage Banner surfaced automatically inside the Website Chat Widget and Help Center.
 */

export const COMPONENT_STATUSES = [
	"operational",
	"degraded",
	"partial_outage",
	"major_outage",
] as const;
export type ComponentStatus = (typeof COMPONENT_STATUSES)[number];

export const INCIDENT_IMPACTS = ["none", "minor", "major", "critical"] as const;
export const INCIDENT_STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const;

const componentInput = z.object({
	id: z.string().optional(),
	name: z.string().trim().min(1).max(80),
	description: z.string().trim().max(240).nullable().optional(),
	status: z.enum(COMPONENT_STATUSES).default("operational"),
	position: z.number().int().min(0).max(1000).optional(),
});

const incidentInput = z.object({
	title: z.string().trim().min(2).max(160),
	impact: z.enum(INCIDENT_IMPACTS).default("minor"),
	status: z.enum(INCIDENT_STATUSES).default("investigating"),
	message: z.string().trim().min(2).max(4000),
	component_ids: z.array(z.string()).max(20).optional(),
	component_status: z.enum(COMPONENT_STATUSES).optional(),
});

const updateInput = z.object({
	incident_id: z.string().min(1),
	status: z.enum(INCIDENT_STATUSES),
	message: z.string().trim().min(2).max(4000),
	component_status: z.enum(COMPONENT_STATUSES).optional(),
});

const esc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const xmlEsc = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");

const publicPagesInput = z.object({
	status_page_enabled: z.boolean().optional(),
	portal_enabled: z.boolean().optional(),
});

export async function getPublicPagesSettings(organizationId: string) {
	const org = await organizationOf(organizationId);
	const row = await db
		.select()
		.from(schema.orgPublicPages)
		.where(eq(schema.orgPublicPages.organization_id, org))
		.get();
	return {
		status_page_enabled: Boolean(row?.status_page_enabled),
		portal_enabled: Boolean(row?.portal_enabled),
		updated_at: row?.updated_at ?? null,
	};
}

export async function savePublicPagesSettings(
	organizationId: string,
	raw: unknown,
	now = Date.now(),
) {
	const v = publicPagesInput.parse(raw ?? {});
	const org = await organizationOf(organizationId);
	const existing = await getPublicPagesSettings(org);
	const next = {
		organization_id: org,
		status_page_enabled: v.status_page_enabled ?? existing.status_page_enabled,
		portal_enabled: v.portal_enabled ?? existing.portal_enabled,
		updated_at: iso(now),
	};
	await db
		.insert(schema.orgPublicPages)
		.values(next)
		.onConflictDoUpdate({
			target: schema.orgPublicPages.organization_id,
			set: {
				status_page_enabled: next.status_page_enabled,
				portal_enabled: next.portal_enabled,
				updated_at: next.updated_at,
			},
		});
	return {
		status_page_enabled: next.status_page_enabled,
		portal_enabled: next.portal_enabled,
		updated_at: next.updated_at,
	};
}

export async function getStatusPageData(organizationId: string) {
	const org = await organizationOf(organizationId);
	const [components, incidents, pages] = await Promise.all([
		db
			.select()
			.from(schema.statusComponents)
			.where(eq(schema.statusComponents.organization_id, org))
			.orderBy(asc(schema.statusComponents.position), asc(schema.statusComponents.name)),
		db
			.select()
			.from(schema.statusIncidents)
			.where(eq(schema.statusIncidents.organization_id, org))
			.orderBy(desc(schema.statusIncidents.created_at))
			.limit(20),
		getPublicPagesSettings(org),
	]);
	const incIds = incidents.map((i) => i.id);
	const updates = incIds.length
		? await db
				.select()
				.from(schema.statusIncidentUpdates)
				.where(inArray(schema.statusIncidentUpdates.incident_id, incIds))
				.orderBy(desc(schema.statusIncidentUpdates.created_at))
		: [];
	const byInc = new Map<string, typeof updates>();
	for (const u of updates) {
		byInc.set(u.incident_id, [...(byInc.get(u.incident_id) ?? []), u]);
	}

	const activeIncidents = incidents.filter((i) => i.status !== "resolved");
	const worstComponent = components.reduce<ComponentStatus>((acc, c) => {
		const rank: Record<ComponentStatus, number> = {
			operational: 0,
			degraded: 1,
			partial_outage: 2,
			major_outage: 3,
		};
		const cur = (c.status as ComponentStatus) ?? "operational";
		return rank[cur] > rank[acc] ? cur : acc;
	}, "operational");
	let overall: ComponentStatus = worstComponent;
	if (activeIncidents.some((i) => i.impact === "critical")) overall = "major_outage";
	else if (activeIncidents.some((i) => i.impact === "major") && overall === "operational")
		overall = "partial_outage";
	else if (activeIncidents.length > 0 && overall === "operational") overall = "degraded";

	return {
		enabled: pages.status_page_enabled,
		portal_enabled: pages.portal_enabled,
		overall,
		components,
		incidents: incidents.map((i) => ({ ...i, updates: byInc.get(i.id) ?? [] })),
		active_incidents: activeIncidents.map((i) => ({ ...i, updates: byInc.get(i.id) ?? [] })),
	};
}

/** Returns the active outage banner (if any unresolved incident exists) for Chat Widget & Help Center. */
export async function activeOutageBanner(organizationId: string) {
	const orgId = await organizationOf(organizationId);
	const inc = await db
		.select()
		.from(schema.statusIncidents)
		.where(
			and(
				eq(schema.statusIncidents.organization_id, orgId),
				ne(schema.statusIncidents.status, "resolved"),
			),
		)
		.orderBy(desc(schema.statusIncidents.created_at))
		.get();
	if (!inc) return null;
	const [org, pages] = await Promise.all([
		db
			.select({ slug: schema.organization.slug })
			.from(schema.organization)
			.where(eq(schema.organization.id, orgId))
			.get(),
		getPublicPagesSettings(orgId),
	]);
	return {
		id: inc.id,
		title: inc.title,
		impact: inc.impact,
		status: inc.status,
		url:
			pages.status_page_enabled && org?.slug
				? `${publicUrl().replace(/\/$/, "")}/status/${encodeURIComponent(org.slug)}`
				: null,
		updated_at: inc.updated_at,
	};
}

export async function saveStatusComponent(organizationId: string, raw: unknown, now = Date.now()) {
	const v = componentInput.parse(raw ?? {});
	const at = iso(now);
	const existing = v.id
		? await db
				.select()
				.from(schema.statusComponents)
				.where(
					and(
						eq(schema.statusComponents.id, v.id),
						eq(schema.statusComponents.organization_id, organizationId),
					),
				)
				.get()
		: null;
	if (v.id && !existing) throw notFound("Status component");

	const row = {
		id: existing?.id ?? `cmpst_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
		organization_id: organizationId,
		name: v.name,
		description: v.description !== undefined ? v.description : (existing?.description ?? null),
		status: v.status,
		position: v.position ?? existing?.position ?? 0,
		created_at: existing?.created_at ?? at,
		updated_at: at,
	};
	if (existing) {
		await db
			.update(schema.statusComponents)
			.set(row)
			.where(eq(schema.statusComponents.id, existing.id));
	} else {
		await db.insert(schema.statusComponents).values(row);
	}
	return row;
}

export async function deleteStatusComponent(organizationId: string, id: string) {
	const [removed] = await db
		.delete(schema.statusComponents)
		.where(
			and(
				eq(schema.statusComponents.id, id),
				eq(schema.statusComponents.organization_id, organizationId),
			),
		)
		.returning({ id: schema.statusComponents.id });
	if (!removed) throw notFound("Status component");
	return { deleted: true, id: removed.id };
}

export async function createStatusIncident(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = incidentInput.parse(raw ?? {});
	const at = iso(now);
	const id = `inc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	await db.insert(schema.statusIncidents).values({
		id,
		organization_id: organizationId,
		title: v.title,
		impact: v.impact,
		status: v.status,
		component_ids: v.component_ids ?? null,
		resolved_at: v.status === "resolved" ? at : null,
		created_at: at,
		updated_at: at,
	});
	await db.insert(schema.statusIncidentUpdates).values({
		id: `incu_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
		incident_id: id,
		status: v.status,
		message: v.message,
		created_by: userId,
		created_at: at,
	});
	if (v.component_ids?.length && v.component_status) {
		await db
			.update(schema.statusComponents)
			.set({ status: v.component_status, updated_at: at })
			.where(
				and(
					eq(schema.statusComponents.organization_id, organizationId),
					inArray(schema.statusComponents.id, v.component_ids),
				),
			);
	}
	return db.select().from(schema.statusIncidents).where(eq(schema.statusIncidents.id, id)).get();
}

export async function postIncidentUpdate(
	organizationId: string,
	raw: unknown,
	userId: string | null = null,
	now = Date.now(),
) {
	const v = updateInput.parse(raw ?? {});
	const inc = await db
		.select()
		.from(schema.statusIncidents)
		.where(
			and(
				eq(schema.statusIncidents.id, v.incident_id),
				eq(schema.statusIncidents.organization_id, organizationId),
			),
		)
		.get();
	if (!inc) throw notFound("Incident");

	const at = iso(now);
	await db.insert(schema.statusIncidentUpdates).values({
		id: `incu_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`,
		incident_id: inc.id,
		status: v.status,
		message: v.message,
		created_by: userId,
		created_at: at,
	});
	await db
		.update(schema.statusIncidents)
		.set({
			status: v.status,
			resolved_at: v.status === "resolved" ? at : null,
			updated_at: at,
		})
		.where(eq(schema.statusIncidents.id, inc.id));
	if (inc.component_ids?.length) {
		const nextStatus =
			v.component_status ?? (v.status === "resolved" ? "operational" : undefined);
		if (nextStatus) {
			await db
				.update(schema.statusComponents)
				.set({ status: nextStatus, updated_at: at })
				.where(
					and(
						eq(schema.statusComponents.organization_id, organizationId),
						inArray(schema.statusComponents.id, inc.component_ids),
					),
				);
		}
	}
	return { ok: true, incident_id: inc.id, status: v.status };
}

async function resolveOrg(slug: string) {
	const clean = slug.trim().toLowerCase();
	return (
		(await db
			.select({
				id: schema.organization.id,
				name: schema.organization.name,
				slug: schema.organization.slug,
			})
			.from(schema.organization)
			.where(eq(schema.organization.slug, clean))
			.get()) ?? null
	);
}

const LABELS: Record<ComponentStatus, { text: string; color: string }> = {
	operational: { text: "All Systems Operational", color: "#10b981" },
	degraded: { text: "Degraded Performance", color: "#f59e0b" },
	partial_outage: { text: "Partial System Outage", color: "#f97316" },
	major_outage: { text: "Major System Outage", color: "#ef4444" },
};

/** Public handler: GET /status/<slug>, /status/<slug>/status.json, /status/<slug>/feed.xml */
export async function handleStatusPage(request: Request): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}
	const url = new URL(request.url);
	const m = /^\/status\/([A-Za-z0-9_-]{1,80})(?:\/(status\.json|feed\.xml))?\/?$/.exec(
		url.pathname,
	);
	if (!m?.[1]) return new Response("Not found", { status: 404 });
	const org = await resolveOrg(m[1]);
	if (!org || !shownHere(org.id)) return new Response("Status page not found", { status: 404 });

	const data = await getStatusPageData(org.id);
	if (!data.enabled) return new Response("Status page not found", { status: 404 });
	const base = publicUrl().replace(/\/$/, "");
	const pageUrl = `${base}/status/${encodeURIComponent(org.slug ?? m[1])}`;

	const publicIncident = (i: (typeof data.incidents)[number]) => ({
		id: i.id,
		title: i.title,
		impact: i.impact,
		status: i.status,
		resolved_at: i.resolved_at,
		created_at: i.created_at,
		updated_at: i.updated_at,
		updates: i.updates.map((u) => ({
			id: u.id,
			status: u.status,
			message: u.message,
			created_at: u.created_at,
		})),
	});

	if (m[2] === "status.json") {
		return Response.json(
			{
				organization: org.name,
				status: data.overall,
				status_label: LABELS[data.overall].text,
				components: data.components.map((c) => ({
					id: c.id,
					name: c.name,
					description: c.description,
					status: c.status,
				})),
				active_incidents: data.active_incidents.map(publicIncident),
				recent_incidents: data.incidents.map(publicIncident),
			},
			{
				headers: {
					"access-control-allow-origin": "*",
					"cache-control": "public, max-age=30",
				},
			},
		);
	}

	if (m[2] === "feed.xml") {
		const items = data.incidents
			.map(
				(i) => `    <item>
      <title>${xmlEsc(`[${i.status.toUpperCase()}] ${i.title}`)}</title>
      <link>${xmlEsc(pageUrl)}</link>
      <guid isPermaLink="false">${xmlEsc(i.id)}</guid>
      <pubDate>${new Date(i.updated_at).toUTCString()}</pubDate>
      <description>${xmlEsc(i.updates[0]?.message ?? i.title)}</description>
    </item>`,
			)
			.join("\n");
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEsc(org.name)} Status</title>
    <link>${xmlEsc(pageUrl)}</link>
    <description>Live system status and incidents for ${xmlEsc(org.name)}</description>
${items}
  </channel>
</rss>`;
		return new Response(xml, {
			headers: {
				"content-type": "application/rss+xml; charset=utf-8",
				"cache-control": "public, max-age=60",
			},
		});
	}

	const badge = LABELS[data.overall];
	const compRows = data.components.length
		? data.components
				.map((c) => {
					const st =
						(c.status as ComponentStatus) in LABELS
							? (c.status as ComponentStatus)
							: "operational";
					return `<div class="row"><div><b>${esc(c.name)}</b>${c.description ? `<p>${esc(c.description)}</p>` : ""}</div><span class="st" style="color:${LABELS[st].color}">● ${esc(st.replace(/_/g, " "))}</span></div>`;
				})
				.join("")
		: `<div class="row"><div><b>Core Services</b></div><span class="st" style="color:${badge.color}">● ${esc(data.overall.replace(/_/g, " "))}</span></div>`;

	const incHtml = data.incidents.length
		? data.incidents
				.map(
					(inc) => `<article class="inc">
  <div class="inc-h"><h3>${esc(inc.title)}</h3><span class="pill ${esc(inc.status)}">${esc(inc.status)}</span></div>
  <ul class="upd">${inc.updates
		.map(
			(u) =>
				`<li><b>${esc(u.status)}</b> — ${esc(u.message)} <time>${esc(new Date(u.created_at).toUTCString())}</time></li>`,
		)
		.join("")}</ul>
</article>`,
				)
				.join("")
		: `<p class="muted">No incidents reported.</p>`;

	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(org.name)} · System Status</title>
<style>
:root{--bg:#fafafa;--card:#fff;--fg:#111215;--muted:#63666f;--line:rgba(17,18,21,.09)}
@media(prefers-color-scheme:dark){:root{--bg:#0e0f12;--card:#15161b;--fg:#f4f5f7;--muted:#989ca8;--line:rgba(255,255,255,.09)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Inter",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:48px 20px 80px}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:24px}
header h1{margin:0;font-size:24px;letter-spacing:-.02em}
.links a{font-size:13px;color:var(--muted);text-decoration:none;margin-left:14px}.links a:hover{color:var(--fg)}
.banner{padding:18px 22px;border-radius:14px;color:#fff;font-weight:600;font-size:17px;margin-bottom:28px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:32px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:14px 18px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row p{margin:2px 0 0;font-size:13px;color:var(--muted)}.st{font-size:13px;font-weight:500;text-transform:capitalize;white-space:nowrap}
h2{font-size:17px;margin:0 0 14px;letter-spacing:-.01em}
.inc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
.inc-h{display:flex;justify-content:space-between;align-items:center;gap:10px}.inc-h h3{margin:0;font-size:15.5px}
.pill{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;padding:2px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}
.pill.resolved{color:#10b981}.upd{margin:10px 0 0;padding-left:18px;font-size:14px}.upd li{margin:6px 0}.upd time{display:block;font-size:12px;color:var(--muted)}
.muted{color:var(--muted);font-size:14px}
</style></head><body><div class="wrap">
<header><h1>${esc(org.name)} Status</h1><div class="links"><a href="${esc(pageUrl)}/status.json">JSON</a><a href="${esc(pageUrl)}/feed.xml">RSS</a></div></header>
<div class="banner" style="background:${badge.color}">${esc(badge.text)}</div>
<div class="card">${compRows}</div>
<h2>Incidents</h2>
${incHtml}
</div></body></html>`;

	return new Response(html, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "public, max-age=30",
		},
	});
}
