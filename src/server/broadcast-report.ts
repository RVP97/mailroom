import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * A sent broadcast's report, as Mailchimp's and Kit's: which links were clicked (the click
 * map), first opens and clicks hour by hour after it went, and the apps people read it in.
 */

/** The email app an open came from, by its User-Agent (or the proxy that fetched for it). */
export function mailApp(ua: string | null | undefined): string {
	const s = ua ?? "";
	if (/GoogleImageProxy|via ggpht\.com/i.test(s)) return "Gmail";
	if (/YahooMailProxy/i.test(s)) return "Yahoo Mail";
	if (/Microsoft Outlook|ms-office|MSOffice|Outlook-iOS|Outlook-Android/i.test(s))
		return "Outlook";
	if (/Thunderbird/i.test(s)) return "Thunderbird";
	if (/(iPhone|iPad).*AppleWebKit(?!.*Safari)/i.test(s)) return "Apple Mail (iPhone)";
	if (/Macintosh.*AppleWebKit(?!.*(Safari|Chrome))/i.test(s)) return "Apple Mail (Mac)";
	if (/Android/i.test(s)) return "Android";
	if (/Chrome|Safari|Firefox|Edg\//i.test(s)) return "Web browser";
	return "Other";
}

const HOURS = 72;

export async function broadcastReport(id: string, startedAt: string | null, now = Date.now()) {
	const e = schema.emails;
	const ev = schema.emailEvents;
	const ofBroadcast = db.select({ id: e.id }).from(e).where(eq(e.broadcast_id, id));
	const [links, opens, clicks, agents] = await Promise.all([
		db
			.select({
				url: sql<string>`json_extract(${ev.data}, '$.click.link')`,
				clicks: sql<number>`COUNT(*)`,
				people: sql<number>`COUNT(DISTINCT ${ev.email_id})`,
			})
			.from(ev)
			.where(and(eq(ev.type, "email.clicked"), inArray(ev.email_id, ofBroadcast)))
			.groupBy(sql`1`)
			.orderBy(sql`3 DESC`)
			.limit(100),
		db
			.select({ hour: sql<string>`substr(${e.opened_at}, 1, 13)`, n: sql<number>`COUNT(*)` })
			.from(e)
			.where(and(eq(e.broadcast_id, id), sql`${e.opened_at} IS NOT NULL`))
			.groupBy(sql`1`),
		db
			.select({ hour: sql<string>`substr(${e.clicked_at}, 1, 13)`, n: sql<number>`COUNT(*)` })
			.from(e)
			.where(and(eq(e.broadcast_id, id), sql`${e.clicked_at} IS NOT NULL`))
			.groupBy(sql`1`),
		db
			.select({ ua: sql<string | null>`json_extract(${ev.data}, '$.open.userAgent')` })
			.from(ev)
			.where(and(eq(ev.type, "email.opened"), inArray(ev.email_id, ofBroadcast)))
			.limit(5000),
	]);

	// Hour by hour from the hour it went, for three days (or until now).
	const timeline: { hour: string; opens: number; clicks: number }[] = [];
	if (startedAt) {
		const start = Date.parse(`${startedAt.slice(0, 13)}:00:00Z`);
		const opened = new Map(opens.map((r) => [r.hour, Number(r.n)]));
		const clicked = new Map(clicks.map((r) => [r.hour, Number(r.n)]));
		const end = Math.min(now, start + HOURS * 3_600_000);
		for (let t = start; t <= end; t += 3_600_000) {
			const key = new Date(t).toISOString().slice(0, 13);
			timeline.push({
				hour: `${key}:00:00.000Z`,
				opens: opened.get(key) ?? 0,
				clicks: clicked.get(key) ?? 0,
			});
		}
	}

	// Quiet hours at the end are left off (a day at least is shown).
	let last = timeline.length - 1;
	while (last > 23 && !timeline[last]?.opens && !timeline[last]?.clicks) last--;
	timeline.splice(Math.min(timeline.length, Math.max(24, last + 7)));

	const apps = new Map<string, number>();
	for (const a of agents) apps.set(mailApp(a.ua), (apps.get(mailApp(a.ua)) ?? 0) + 1);

	return {
		links: links
			.filter((l) => l.url)
			.map((l) => ({ url: l.url, clicks: Number(l.clicks), people: Number(l.people) })),
		timeline,
		apps: [...apps.entries()]
			.map(([name, opens]) => ({ name, opens }))
			.sort((a, b) => b.opens - a.opens),
	};
}
