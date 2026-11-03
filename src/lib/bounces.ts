import { PROVIDER_LABEL, providerOf } from "./providers";

/**
 * A bounce in plain words: what kind it is and a sentence that says what happened, naming the
 * receiving provider when it's a known one («Gmail says this address doesn't exist»). SES's
 * type and the receiving server's diagnostic code go in; nothing is looked up.
 */
export type BounceCategory =
	| "unknown_recipient"
	| "mailbox_full"
	| "domain_missing"
	| "blocked"
	| "too_large"
	| "suppressed"
	| "temporary"
	| "other";

export interface BounceExplanation {
	category: BounceCategory;
	title: string;
	sentence: string;
	/** Whether sending to the address again can work. */
	retry: boolean;
}

const MATCH: [BounceCategory, RegExp][] = [
	[
		"suppressed",
		/OnAccountSuppressionList|Suppressed|EmailValidationSuppressed|suppression list/i,
	],
	[
		"unknown_recipient",
		/\b5\.1\.1\b|\b5\.1\.10\b|user unknown|unknown user|no such user|does not exist|doesn't exist|not exist|no mailbox|mailbox (?:not found|unavailable)|invalid recipient|recipient (?:address )?rejected|address rejected|account (?:has been )?disabled|inactive|NoEmail/i,
	],
	[
		"mailbox_full",
		/\b5\.2\.2\b|\b4\.2\.2\b|quota|mailbox (?:is )?full|over ?quota|insufficient storage|MailboxFull/i,
	],
	[
		"domain_missing",
		/\b5\.1\.2\b|\b5\.4\.4\b|host (?:or domain name )?not found|no mx|domain (?:not found|does not exist)|NXDOMAIN/i,
	],
	["too_large", /\b5\.3\.4\b|\b5\.2\.3\b|too large|size limit|MessageTooLarge/i],
	[
		"blocked",
		/\b5\.7\.\d+\b|blocked|block list|blacklist|spamhaus|spam|policy|reputation|not authorized|rejected for policy|ContentRejected|AttachmentRejected/i,
	],
];

export function explainBounce(b: {
	type?: string | null;
	subType?: string | null;
	message?: string | null;
	recipient?: string | null;
}): BounceExplanation {
	const text = `${b.subType ?? ""} ${b.message ?? ""}`;
	const transient = /^transient$/i.test(b.type ?? "");
	const found = MATCH.find(([, re]) => re.test(text))?.[0];
	const category: BounceCategory =
		found ?? (transient ? "temporary" : b.subType === "MailboxFull" ? "mailbox_full" : "other");
	const p = providerOf(b.recipient);
	const who = p === "other" ? "The receiving server" : PROVIDER_LABEL[p];
	switch (category) {
		case "unknown_recipient":
			return {
				category,
				title: "Address doesn't exist",
				sentence: `${who} says there's no mailbox at this address. It may be misspelled, or the account was closed. Mailroom won't send to it again.`,
				retry: false,
			};
		case "mailbox_full":
			return {
				category,
				title: "Mailbox full",
				sentence: `${who} says the mailbox is full. It may have room later; the person has to clear it.`,
				retry: true,
			};
		case "domain_missing":
			return {
				category,
				title: "Domain takes no email",
				sentence:
					"The address's domain doesn't exist or has no mail server. Check its spelling after the @.",
				retry: false,
			};
		case "too_large":
			return {
				category,
				title: "Email too large",
				sentence: `${who} turned it away for its size. Send smaller attachments, or a link to them.`,
				retry: true,
			};
		case "blocked":
			return {
				category,
				title: p === "other" ? "Blocked by the receiver" : `Blocked by ${who}`,
				sentence: `${who} refused it by policy (its spam filter, or the sending domain's or IP's reputation), not because of the address${transient ? ", so the address stays off the suppression list" : ""}. If it happens again, check the domain's DMARC and what was sent.`,
				retry: true,
			};
		case "suppressed":
			return {
				category,
				title: "Skipped: on a suppression list",
				sentence:
					"Amazon SES didn't try: the address bounced or complained before, or its check found it can't receive.",
				retry: false,
			};
		case "temporary":
			return {
				category,
				title: "Soft bounce: the server didn't take it for now",
				sentence: `${who} didn't take it for now (busy, down or greylisting) and SES gave up retrying. Sending again later usually works.`,
				retry: true,
			};
		default:
			return {
				category,
				title: transient ? "Soft bounce" : "Bounced",
				sentence: `${who} refused the email${b.message ? `: “${b.message.slice(0, 160)}”` : "."}`,
				retry: transient,
			};
	}
}
