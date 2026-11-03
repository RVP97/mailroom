/**
 * What each email status means, in one place: the badge, the Emails filter, the email page, the
 * Overview and the API docs all read these words, so a soft bounce never reads as "failed" on one
 * page and "soft bounce" on another.
 *
 * - failed: it never reached a mail server (SES refused it, or no recipient could take email).
 * - soft_bounced: the receiving server didn't take it (full, down, looping, or refused it by
 *   policy, like iCloud's 554 5.7.1). The address is fine and isn't suppressed.
 * - bounced: a hard bounce, the address doesn't exist or refuses mail for good. Suppressed.
 * - suppressed: not sent, every recipient was on the suppression list, unsubscribed or blocked.
 */

export interface StatusInfo {
	label: string;
	/** One sentence: what happened and what it means for the address. */
	description: string;
}

export const STATUS_INFO: Record<string, StatusInfo> = {
	scheduled: { label: "Scheduled", description: "Waits for its scheduled time." },
	queued: { label: "Queued", description: "In line to go to SES." },
	sending: { label: "Sending", description: "Going to SES right now." },
	sent: {
		label: "Sent",
		description: "SES took it; the recipient's server hasn't answered yet.",
	},
	delivery_delayed: {
		label: "Delivery delayed",
		description: "The recipient's server asked SES to try later. SES keeps trying.",
	},
	delivered: { label: "Delivered", description: "The recipient's mail server accepted it." },
	opened: { label: "Opened", description: "Delivered and opened (its images loaded)." },
	clicked: { label: "Clicked", description: "Delivered and a link in it was clicked." },
	complained: {
		label: "Complained",
		description: "Delivered, then marked as spam. The address is now suppressed.",
	},
	soft_bounced: {
		label: "Soft bounced",
		description:
			"The recipient's server didn't take it (full, down, looping or refused by policy). The address is fine and isn't suppressed.",
	},
	bounced: {
		label: "Bounced",
		description: "Hard bounce: the address doesn't exist or refuses mail. Now suppressed.",
	},
	failed: {
		label: "Failed",
		description:
			"Never reached a mail server: SES refused it, or no recipient could take email.",
	},
	suppressed: {
		label: "Suppressed",
		description:
			"Not sent: the address is suppressed, unsubscribed or blocked by the firewall.",
	},
	blocked: {
		label: "Blocked by firewall",
		description: "Not sent: the brand's firewall left out every recipient.",
	},
	unsubscribed: {
		label: "Unsubscribed",
		description: "Not sent: every recipient had unsubscribed from this group.",
	},
	canceled: { label: "Canceled", description: "Canceled before it went out." },
};

/** The four ways an email can end up not delivered, worst for the address first. */
export const NOT_DELIVERED = ["bounced", "soft_bounced", "failed", "suppressed"] as const;

/**
 * What the Emails list can filter by: a status, opened/clicked (delivered emails that were), or
 * the "not delivered" group.
 */
export const EMAIL_FILTERS = [
	"not_delivered",
	"delivered",
	"opened",
	"clicked",
	"complained",
	"sent",
	"delivery_delayed",
	"scheduled",
	"queued",
	"bounced",
	"soft_bounced",
	"failed",
	"suppressed",
	"firewall",
	"unsubscribed",
	"canceled",
] as const;
export type EmailFilterValue = (typeof EMAIL_FILTERS)[number];

export const FILTER_INFO: Record<EmailFilterValue, StatusInfo> = {
	...(STATUS_INFO as Record<EmailFilterValue, StatusInfo>),
	not_delivered: {
		label: "Not delivered",
		description: "Bounced, soft bounced, failed or suppressed.",
	},
	firewall: {
		label: "Blocked by firewall",
		description: "The brand's firewall left out one or more of its recipients.",
	},
	unsubscribed: {
		label: "Unsubscribed",
		description: "One or more recipients had unsubscribed, so they were left out.",
	},
};

export const statusInfo = (s: string): StatusInfo =>
	STATUS_INFO[s.replace(/^email\./, "")] ?? {
		label: s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " "),
		description: "",
	};

/**
 * What a row shows, the same on every page: its status, except that delivered emails that were
 * opened or clicked say so.
 */
export function shownStatus(e: {
	status: string;
	last_event?: string | null;
	open_count?: number | null;
	click_count?: number | null;
	dropped?: Record<string, string> | null;
}) {
	if (e.status === "suppressed" && e.dropped) {
		// Not sent: say whose rule kept it (firewall, unsubscribe, or the suppression list).
		const why = Object.values(e.dropped);
		if (why.length && why.every((r) => r.startsWith("firewall"))) return "blocked";
		if (why.length && why.every((r) => r.startsWith("unsubscribed"))) return "unsubscribed";
	}
	if (e.status !== "delivered") return e.status;
	if (e.click_count || e.last_event === "clicked") return "clicked";
	if (e.open_count || e.last_event === "opened") return "opened";
	return e.status;
}

/** Why a recipient was left out, in words: whose rule it was and what it said. */
export function leftOutLabel(why: string): { kind: string; label: string } {
	if (why.startsWith("firewall: "))
		return { kind: "blocked", label: `Firewall: ${why.slice(10)}` };
	if (why.startsWith("unsubscribed"))
		return { kind: "unsubscribed", label: `Unsubscribed ${why.slice(13)}`.trim() };
	if (why.startsWith("suppressed")) {
		const reason = /\((\w+)\)/.exec(why)?.[1] ?? "";
		const words: Record<string, string> = {
			bounce: "hard bounce",
			complaint: "spam complaint",
			manual: "added by hand",
		};
		return { kind: "suppressed", label: `Suppressed: ${words[reason] ?? "on the list"}` };
	}
	return { kind: "failed", label: why.charAt(0).toUpperCase() + why.slice(1) };
}
