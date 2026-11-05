/**
 * Amazon SES, played in the browser. Every email the app sends gets what SES would report
 * afterwards (sent, delivered, opened, clicked, a bounce now and then), applied with the app's
 * own applySesEvent, as if it came through SNS. While the seed runs (a fixed clock) the events
 * are written at once with their own times; in the live demo they arrive over the next seconds.
 */
import { applySesEvent, type SesEvent } from "@/server/events";
import { at, clockTime, isFixed, realNow } from "./clock";

interface Sent {
	FromEmailAddress?: string;
	Destination?: { ToAddresses?: string[] };
	Content?: { Raw?: { Data?: string } };
	EmailTags?: { Name: string; Value: string }[];
}

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** A number in [0, 1) from a string, the same every time. */
function hashed(s: string, salt = 0) {
	let h = 2166136261 ^ salt;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return ((h >>> 0) % 100_000) / 100_000;
}

const APPS = [
	// Apple Mail on iPhone and Mac, Gmail's image proxy, Outlook, and a few others.
	[
		"Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
		0.34,
	],
	[
		"Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
		0.3,
	],
	[
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
		0.14,
	],
	["Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)", 0.1],
	[
		"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
		0.07,
	],
	["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Thunderbird/132.0", 0.05],
] as const;

function appFor(r: number) {
	let sum = 0;
	for (const [ua, share] of APPS) {
		sum += share;
		if (r < sum) return ua;
	}
	return APPS[0][0];
}

/** The links in a raw message's HTML part (quoted-printable undone). */
function linksOf(raw: string | undefined): string[] {
	if (!raw) return [];
	let text = "";
	try {
		text = atob(raw);
	} catch {
		return [];
	}
	// The HTML part is base64 (src/server/aws/mime.ts).
	let plain = text.replace(/=\r?\n/g, "").replace(/=3D/gi, "=");
	for (const m of text.matchAll(
		/Content-Type: text\/html[^\r\n]*\r?\nContent-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/g,
	))
		try {
			const bytes = Uint8Array.from(atob((m[1] as string).replace(/\s+/g, "")), (c) =>
				c.charCodeAt(0),
			);
			plain += new TextDecoder().decode(bytes);
		} catch {}
	const out = new Set<string>();
	for (const m of plain.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
		const url = m[1] as string;
		if (!/unsubscribe|\/u\/|\/n\/|list-unsubscribe/i.test(url)) out.add(url);
	}
	return [...out];
}

const tag = (s: Sent, name: string) => s.EmailTags?.find((t) => t.Name === name)?.Value;

/** How engaged a kind of email's readers are: transactional ones are opened more. */
function rates(s: Sent) {
	const marketing =
		!!tag(s, "mailroom_broadcast") ||
		!!tag(s, "broadcast") ||
		/news|weekly|digest/i.test(s.FromEmailAddress ?? "");
	return marketing ? { open: 0.46, click: 0.24 } : { open: 0.68, click: 0.18 };
}

type Planned = { at: number; event: SesEvent };

function plan(s: Sent, messageId: string, sentAt: number): Planned[] {
	const id = tag(s, "mailroom_id");
	const to = (s.Destination?.ToAddresses ?? [])[0]?.toLowerCase() ?? "";
	const mail = {
		messageId,
		timestamp: new Date(sentAt).toISOString(),
		source: s.FromEmailAddress,
		destination: s.Destination?.ToAddresses ?? [],
		tags: { ...(id ? { mailroom_id: [id] } : {}) },
	};
	const out: Planned[] = [{ at: sentAt, event: { eventType: "Send", mail } }];
	const r = hashed(to + messageId);
	const delivered = sentAt + (1.2 + hashed(messageId, 1) * 6) * SEC;
	const hardBounce = /bounce|nobody|invalid|old-address/.test(to) || r < 0.006;
	const softBounce = !hardBounce && (/full-mailbox/.test(to) || r > 0.996);
	if (hardBounce || softBounce) {
		out.push({
			at: delivered,
			event: {
				eventType: "Bounce",
				mail,
				bounce: {
					bounceType: hardBounce ? "Permanent" : "Transient",
					bounceSubType: hardBounce ? "General" : "MailboxFull",
					timestamp: new Date(delivered).toISOString(),
					bouncedRecipients: [
						{
							emailAddress: to,
							status: hardBounce ? "5.1.1" : "4.2.2",
							diagnosticCode: hardBounce
								? "smtp; 550 5.1.1 The email account that you tried to reach does not exist."
								: "smtp; 452 4.2.2 The recipient's mailbox is full.",
						},
					],
				},
			},
		});
		return out;
	}
	out.push({
		at: delivered,
		event: {
			eventType: "Delivery",
			mail,
			delivery: {
				timestamp: new Date(delivered).toISOString(),
				recipients: [to],
				smtpResponse: "250 2.0.0 OK",
			},
		},
	});
	if (/complaint/.test(to) || hashed(to, 9) < 0.0006) {
		const at = delivered + 40 * MIN;
		out.push({
			at,
			event: {
				eventType: "Complaint",
				mail,
				complaint: {
					timestamp: new Date(at).toISOString(),
					complainedRecipients: [{ emailAddress: to }],
					complaintFeedbackType: "abuse",
				},
			},
		});
		return out;
	}
	const { open, click } = rates(s);
	if (hashed(to + messageId, 2) >= open) return out;
	// Most opens come within hours; live, within seconds so a visitor sees them.
	const live = !isFixed();
	const wait = live
		? (4 + hashed(messageId, 3) * 20) * SEC
		: hashed(messageId, 3) ** 2.4 * 30 * HOUR + 2 * MIN;
	const openedAt = delivered + wait;
	const ua = appFor(hashed(to, 4));
	const ip = `198.51.100.${Math.floor(hashed(to, 5) * 250) + 2}`;
	out.push({
		at: openedAt,
		event: {
			eventType: "Open",
			mail,
			open: { timestamp: new Date(openedAt).toISOString(), ipAddress: ip, userAgent: ua },
		},
	});
	const links = linksOf(s.Content?.Raw?.Data);
	if (!links.length || hashed(to + messageId, 6) >= click) return out;
	// The first link (the email's main button) gets most clicks.
	const pick = hashed(to, 7);
	const link = links[
		pick < 0.6 ? 0 : Math.min(links.length - 1, Math.floor(pick * links.length))
	] as string;
	const clickedAt = openedAt + (live ? 3 : 20 + hashed(to, 8) * 300) * SEC;
	out.push({
		at: clickedAt,
		event: {
			eventType: "Click",
			mail,
			click: {
				timestamp: new Date(clickedAt).toISOString(),
				ipAddress: ip,
				userAgent: ua,
				link,
			},
		},
	});
	return out;
}

let n = 0;
const queue: Planned[] = [];

/** The seed's events so far, applied (after the sends that caused them have been recorded). */
export async function flushSes(until = realNow()) {
	queue.sort((a, z) => a.at - z.at);
	while (queue.length && (queue[0] as Planned).at <= until) {
		const p = queue.shift() as Planned;
		if (p.at > realNow()) continue;
		await at(p.at, () =>
			applySesEvent(p.event, `demo-${++n}-${p.event.mail?.messageId}`, p.at),
		);
	}
}

/** Called by demo/outside.ts for every SendEmail. */
export function onSesSend(s: Sent, messageId: string) {
	const sentAt = clockTime();
	const events = plan(s, messageId, sentAt);
	if (isFixed()) {
		queue.push(...events);
		return;
	}
	for (const p of events)
		setTimeout(
			() =>
				void applySesEvent(p.event, `demo-${++n}-${messageId}`, Date.now()).catch(
					console.warn,
				),
			Math.max(0, p.at - sentAt),
		);
}
