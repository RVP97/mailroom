import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { recipients } from "./alerts";
import { brandIds } from "./brands";
import { chunk, db, schema } from "./db";
import { baseUrl } from "./env";
import { statsByTemplate, timeToInbox } from "./insights";
import { appLink } from "./org-handles";
import { postmasterView } from "./postmaster";
import { dailyStats, rate } from "./queries";
import { sendSystemEmail, systemLayout, systemSectionsLayout } from "./system-email";
import { iso } from "./time";

/**
 * The weekly digest: on Mondays (14:37 UTC, the morning in the Americas) each organization's
 * owners and admins get last week in one email: what was sent and how it did against the week
 * before, how long emails took to arrive, and what needs a look (blocklists, DNS problems,
 * paused domains, a template that bounces). On by default; Settings turns it off per
 * organization, and people in several organizations can combine all of theirs into one email.
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

/** Whether a person combines all of their organizations' weekly digests into one email. */
export async function combineDigestsEnabled(userId: string) {
	const row = await db
		.select({ combine: schema.userSettings.combine_digests })
		.from(schema.userSettings)
		.where(eq(schema.userSettings.user_id, userId))
		.get();
	return row?.combine ?? false;
}

export async function setCombineDigests(userId: string, combine: boolean, now = Date.now()) {
	await db
		.insert(schema.userSettings)
		.values({ user_id: userId, combine_digests: combine, updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.userSettings.user_id,
			set: { combine_digests: combine, updated_at: iso(now) },
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

interface DigestData {
	sent: number;
	delivered: number;
	issues: string[];
	lines: string[];
}

async function digestData(organizationId: string, now = Date.now()): Promise<DigestData | null> {
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
		`Last week you sent ${num(t.sent)} emails${change(t.sent, before.totals.sent)}. ${pct(rate(t.delivered, t.sent))} were delivered, ${pct(rate(t.opened, t.delivered))} opened and ${pct(rate(t.clicked, t.delivered))} clicked.`,
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
	return { sent: t.sent, delivered: t.delivered, issues, lines };
}

/** The digest's lines for one organization, or null when it sent nothing and nothing's wrong. */
export async function digestFor(organizationId: string, now = Date.now()) {
	return (await digestData(organizationId, now))?.lines ?? null;
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

async function singleEmail(org: { id: string; name: string }, lines: string[]) {
	const subject = `${org.name}: your week in email`;
	const body = systemLayout({
		title: subject,
		lines: [
			...lines,
			"You get this every Monday as an owner or admin. Turn it off in Settings.",
		],
		button: { label: "Open Insights", url: await appLink(org.id, "/insights") },
	});
	return { subject, ...body };
}

type OrgDigest = { org: { id: string; name: string }; data: DigestData };

async function combinedEmail(items: OrgDigest[]) {
	// Organizations that need a look come first, then busiest, then alphabetical.
	const ordered = [...items].sort(
		(a, b) =>
			b.data.issues.length - a.data.issues.length ||
			b.data.sent - a.data.sent ||
			a.org.name.localeCompare(b.org.name),
	);
	const totalSent = ordered.reduce((n, x) => n + x.data.sent, 0);
	const totalDelivered = ordered.reduce((n, x) => n + x.data.delivered, 0);
	const withIssues = ordered.filter((x) => x.data.issues.length > 0).length;
	const subject = `Your week in email · ${ordered.length} organizations`;
	const intro = `Across ${ordered.length} organizations last week: ${num(totalSent)} emails sent${
		totalSent ? `, ${pct(rate(totalDelivered, totalSent))} delivered` : ""
	}. ${
		withIssues
			? `${withIssues === 1 ? "1 organization needs" : `${withIssues} organizations need`} a look.`
			: "Nothing needs a look."
	}`;
	const sections = await Promise.all(
		ordered.map(async (item) => ({
			title: item.org.name,
			lines: item.data.lines,
			link: { label: "Open Insights", url: await appLink(item.org.id, "/insights") },
		})),
	);
	const body = systemSectionsLayout({
		title: subject,
		intro,
		sections,
		footer: "You get this combined Monday email because you turned it on in Account. Turn off any organization's digest in its Settings.",
		button: { label: "Manage in Account", url: `${baseUrl()}/account` },
	});
	return { subject, ...body };
}

/** Recipient addresses (lowercase) whose Mailroom user has combined weekly digests turned on. */
async function combinedRecipients(addresses: string[]): Promise<Set<string>> {
	if (!addresses.length) return new Set();
	const u = schema.user;
	const us = schema.userSettings;
	const out = new Set<string>();
	for (const part of chunk(addresses)) {
		const rows = await db
			.select({ email: u.email })
			.from(us)
			.innerJoin(u, eq(u.id, us.user_id))
			.where(and(eq(us.combine_digests, true), inArray(sql`lower(${u.email})`, part)));
		for (const r of rows) out.add(r.email.toLowerCase());
	}
	return out;
}

async function markDigestSent(organizationId: string, now: number) {
	await db
		.insert(schema.organizationSettings)
		.values({ organization_id: organizationId, digest_sent_at: iso(now), updated_at: iso(now) })
		.onConflictDoUpdate({
			target: schema.organizationSettings.organization_id,
			set: { digest_sent_at: iso(now) },
		});
}

/** Top-level organizations (not brands) with at least one ready sending setup. */
function sendingOrganizations() {
	const o = schema.organization;
	const s = schema.organizationSettings;
	const b = schema.brands;
	const os = schema.orgSending;
	return db
		.select({ id: o.id, name: o.name, digest: s.digest, sent_at: s.digest_sent_at })
		.from(o)
		.leftJoin(s, eq(s.organization_id, o.id))
		.where(
			sql`${o.id} NOT IN (SELECT ${b.id} FROM ${b}) AND EXISTS (SELECT 1 FROM ${os} WHERE ${os.status} = 'ready' AND (${os.organization_id} = ${o.id} OR ${os.organization_id} IN (SELECT ${b.id} FROM ${b} WHERE ${b.parent_id} = ${o.id})))`,
		)
		.orderBy(asc(o.name));
}

/** Mondays at 14:37 UTC: every organization that wants it and wasn't sent one this week. */
export async function runWeeklyDigest(now = Date.now()) {
	const orgs = await sendingOrganizations();
	const active: (OrgDigest & { to: string[] })[] = [];
	for (const org of orgs) {
		if (org.digest === false) continue;
		if (org.sent_at && now - Date.parse(org.sent_at) < WEEK - 3_600_000) continue;
		try {
			const data = await digestData(org.id, now);
			if (!data) {
				await markDigestSent(org.id, now);
				continue;
			}
			active.push({
				org: { id: org.id, name: org.name },
				data,
				to: await recipients(org.id),
			});
		} catch (error) {
			console.error("digest: not built", org.id, error);
		}
	}
	if (!active.length) return;

	const combineFor = await combinedRecipients([...new Set(active.flatMap((x) => x.to))]);
	const outcome = new Map(active.map((x) => [x.org.id, { attempted: 0, succeeded: 0 }]));
	const byCombined = new Map<string, OrgDigest[]>();
	const singleCache = new Map<string, Awaited<ReturnType<typeof singleEmail>>>();
	const getSingle = async (item: OrgDigest) => {
		let m = singleCache.get(item.org.id);
		if (!m) {
			m = await singleEmail(item.org, item.data.lines);
			singleCache.set(item.org.id, m);
		}
		return m;
	};

	const sendOne = async (address: string, item: OrgDigest) => {
		const o = outcome.get(item.org.id);
		if (o) o.attempted++;
		try {
			await sendSystemEmail({ to: address, ...(await getSingle(item)) });
			if (o) o.succeeded++;
		} catch (error) {
			console.error("digest: not sent", item.org.id, error);
		}
	};

	const tasks: Promise<void>[] = [];
	for (const item of active) {
		for (const address of item.to) {
			if (combineFor.has(address)) {
				const list = byCombined.get(address) ?? [];
				list.push({ org: item.org, data: item.data });
				byCombined.set(address, list);
			} else {
				tasks.push(sendOne(address, item));
			}
		}
	}

	for (const [address, items] of byCombined) {
		if (items.length === 1) {
			tasks.push(sendOne(address, items[0] as OrgDigest));
			continue;
		}
		tasks.push(
			(async () => {
				for (const item of items) {
					const o = outcome.get(item.org.id);
					if (o) o.attempted++;
				}
				try {
					await sendSystemEmail({ to: address, ...(await combinedEmail(items)) });
					for (const item of items) {
						const o = outcome.get(item.org.id);
						if (o) o.succeeded++;
					}
				} catch (error) {
					console.error("digest: combined not sent", address, error);
				}
			})(),
		);
	}

	await Promise.all(tasks);
	for (const item of active) {
		const o = outcome.get(item.org.id);
		if (!o || o.attempted === 0 || o.succeeded > 0) await markDigestSent(item.org.id, now);
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
		const email = await singleEmail(org, lines);
		const to = o.to ? [o.to] : await recipients(org.id);
		const results = await Promise.allSettled(
			to.map((address) => sendSystemEmail({ to: address, ...email })),
		);
		if (to.length && results.every((r) => r.status === "rejected"))
			throw (results[0] as PromiseRejectedResult).reason;
	}
	if (o.to) return lines;
	await markDigestSent(org.id, now);
	return lines;
}

/**
 * Last week's combined digest across every organization a person receives digests for, sent now
 * only to them (never updates `digest_sent_at`).
 */
export async function sendCombinedDigest(
	who: { userId: string; email: string; isAdmin: boolean },
	now = Date.now(),
) {
	const all = await sendingOrganizations();
	let eligible = all.filter((o) => o.digest !== false);
	if (!who.isAdmin) {
		const m = schema.member;
		const owned = await db
			.select({ organizationId: m.organizationId })
			.from(m)
			.where(and(eq(m.userId, who.userId), inArray(m.role, ["owner", "admin"])));
		const allowed = new Set(owned.map((r) => r.organizationId));
		eligible = eligible.filter((o) => allowed.has(o.id));
	}
	const items: OrgDigest[] = [];
	for (const org of eligible) {
		const data = await digestData(org.id, now);
		if (data) items.push({ org: { id: org.id, name: org.name }, data });
	}
	const first = items[0];
	if (!first) return { sent: false, count: 0, to: who.email };
	const email =
		items.length === 1
			? await singleEmail(first.org, first.data.lines)
			: await combinedEmail(items);
	await sendSystemEmail({ to: who.email, ...email });
	return { sent: true, count: items.length, to: who.email };
}
