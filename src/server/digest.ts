import { and, eq, sql } from "drizzle-orm";
import { recipients } from "./alerts";
import { brandIds } from "./brands";
import { db, schema } from "./db";
import { cfg } from "./env";
import { statsByTemplate, timeToInbox } from "./insights";
import { postmasterView } from "./postmaster";
import { dailyStats } from "./queries";
import { sendSystemEmail, systemLayout } from "./system-email";
import { iso } from "./time";

/**
 * The weekly digest: on Mondays (14:37 UTC, the morning in the Americas) each organization's
 * owners and admins get last week in one email: what was sent and how it did against the week
 * before, how long emails took to arrive, and what needs a look (blocklists, DNS problems,
 * paused domains, a template that bounces). On by default; Settings turns it off.
 */

const WEEK = 7 * 86_400_000;

export async function digestEnabled(organizationId: string) {
	const row = await db
		.select({ digest: schema.organizationSettings.digest })
		.from(schema.organizationSettings)
		.where(eq(schema.organizationSettings.organization_id, organizationId))
		.get();
	return row?.digest ?? true;
}

export async function setDigestEnabled(organizationId: string, on: boolean, now = Date.now()) {
	await db
		.insert(schema.organizationSettings)
		.values({ organization_id: organizationId, digest: on, updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.organizationSettings.organization_id,
			set: { digest: on, updated_at: iso(now) },
		});
}

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
const num = (n: number) => new Intl.NumberFormat("en-US").format(n);
const change = (now: number, before: number) => {
	if (!before) return "";
	const d = (now - before) / before;
	if (Math.abs(d) < 0.05) return " (about the same as the week before)";
	return ` (${d > 0 ? "up" : "down"} ${Math.round(Math.abs(d) * 100)}% from the week before)`;
};
const seconds = (s: number | null) =>
	s === null ? "—" : s < 90 ? `${Math.max(1, Math.round(s))} s` : `${Math.round(s / 60)} min`;

/** The digest's lines for one organization, or null when it sent nothing and nothing's wrong. */
export async function digestFor(organizationId: string, now = Date.now()) {
	const scope = { org: organizationId };
	const [week, before, latency, templates, issues] = await Promise.all([
		dailyStats(scope, 7, now),
		dailyStats(scope, 7, now, { offset: 7 }),
		timeToInbox(scope, 7, now),
		statsByTemplate(scope, 7, now),
		problems(organizationId),
	]);
	const t = week.totals;
	if (!t.sent && !before.totals.sent && !issues.length) return null;
	const lines = [
		`Last week you sent ${num(t.sent)} emails${change(t.sent, before.totals.sent)}. ${pct(t.sent ? t.delivered / t.sent : 0)} were delivered, ${pct(t.delivered ? t.opened / t.delivered : 0)} opened and ${pct(t.delivered ? t.clicked / t.delivered : 0)} clicked.`,
		`Bounces were ${pct(week.health.bounceRate)} and spam reports ${pct(week.health.complaintRate)} (SES reviews an account at 5% and 0.1%).`,
	];
	if (latency.all.count)
		lines.push(
			`Emails typically reached the recipient's server in ${seconds(latency.all.median)}; one in ten took over ${seconds(latency.all.p90)}.`,
		);
	const gmail = await postmasterView(await brandIds(organizationId), 7, now).catch(() => []);
	for (const g of gmail.filter((x) => x.spam === "warning" || x.spam === "danger"))
		issues.push(
			`Gmail's spam rate for ${g.domain} is ${pct(g.latest?.spam_rate ?? 0)} (keep it under 0.1%).`,
		);
	const bouncy = templates.filter((x) => x.sent >= 20 && x.bounce !== "ok");
	for (const x of bouncy)
		issues.push(
			`The template "${x.name}" bounced ${pct(x.bounceRate)} of ${num(x.sent)} emails.`,
		);
	lines.push(
		issues.length ? `Needs a look: ${issues.join(" ")}` : "Nothing needs a look this week.",
	);
	return lines;
}

/** Blocklists, DNS problems and paused domains across the organization's brands. */
async function problems(organizationId: string) {
	const d = schema.domains;
	const h = schema.domainHealth;
	const b = schema.brands;
	const inOrg = sql`(${d.organization_id} = ${organizationId} OR ${d.organization_id} IN (SELECT ${b.id} FROM ${b} WHERE ${b.parent_id} = ${organizationId}))`;
	const rows = await db
		.select({
			name: d.name,
			paused_at: d.paused_at,
			problems: h.problems,
			listings: h.listings,
		})
		.from(d)
		.leftJoin(h, eq(h.domain_id, d.id))
		.where(and(inOrg, eq(d.sending, true)));
	const out: string[] = [];
	for (const r of rows) {
		if (r.paused_at) out.push(`${r.name} is paused.`);
		const listed = (r.listings ?? []).filter((l) => l.status === "listed").map((l) => l.list);
		if (listed.length) out.push(`${r.name} is on ${listed.join(", ")}.`);
		const errors = (r.problems ?? []).filter((p) => p.level === "error");
		if (errors.length)
			out.push(`${r.name} has DNS problems (${errors.map((p) => p.record).join(", ")}).`);
	}
	return out;
}

/** Mondays at 14:37 UTC: every organization that wants it and wasn't sent one this week. */
export async function runWeeklyDigest(now = Date.now()) {
	const o = schema.organization;
	const s = schema.organizationSettings;
	const b = schema.brands;
	const os = schema.orgSending;
	const orgs = await db
		.select({ id: o.id, name: o.name, digest: s.digest, sent_at: s.digest_sent_at })
		.from(o)
		.leftJoin(s, eq(s.organization_id, o.id))
		.where(
			// Organizations (not their brands) where something is set up to send.
			sql`${o.id} NOT IN (SELECT ${b.id} FROM ${b}) AND EXISTS (SELECT 1 FROM ${os} WHERE ${os.status} = 'ready' AND (${os.organization_id} = ${o.id} OR ${os.organization_id} IN (SELECT ${b.id} FROM ${b} WHERE ${b.parent_id} = ${o.id})))`,
		);
	for (const org of orgs) {
		if (org.digest === false) continue;
		if (org.sent_at && now - Date.parse(org.sent_at) < WEEK - 3_600_000) continue;
		try {
			await sendDigest(org, now);
		} catch (error) {
			console.error("digest: not sent", org.id, error);
		}
	}
}

/** Sends it to the owners and admins (and records it), or with `to`, only to that address. */
export async function sendDigest(
	org: { id: string; name: string },
	now = Date.now(),
	o: { to?: string } = {},
) {
	const lines = await digestFor(org.id, now);
	if (lines) {
		const subject = `${org.name}: your week in email`;
		const body = systemLayout({
			title: subject,
			lines: [
				...lines,
				"You get this every Monday as an owner or admin. Turn it off in Settings.",
			],
			button: { label: "Open Insights", url: `${cfg().BETTER_AUTH_URL ?? ""}/insights` },
		});
		const to = o.to ? [o.to] : await recipients(org.id);
		const results = await Promise.allSettled(
			to.map((address) => sendSystemEmail({ to: address, subject, ...body })),
		);
		if (to.length && results.every((r) => r.status === "rejected"))
			throw (results[0] as PromiseRejectedResult).reason;
	}
	if (o.to) return lines;
	await db
		.insert(schema.organizationSettings)
		.values({ organization_id: org.id, digest_sent_at: iso(now), updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.organizationSettings.organization_id,
			set: { digest_sent_at: iso(now) },
		});
	return lines;
}
