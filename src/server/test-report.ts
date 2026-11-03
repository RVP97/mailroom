import type { Email } from "postal-mime";
import { checkContent } from "../lib/content-check";
import { bareAddress } from "./aws/mime";
import { lookup } from "./deliverability";

/**
 * A received email's deliverability report, like mail-tester: send an email to a brand's Mailroom
 * address (or any receiving domain) and Mailroom says how a mailbox provider sees it. SES's
 * verdicts (SPF, DKIM, DMARC, spam, viruses) plus what Gmail's and Yahoo's sender rules and spam
 * filters look at: alignment with the From domain, the DMARC policy, one-click unsubscribe,
 * Message-ID, a plain-text part, links, images and the content checks the editors run.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
	id: string;
	group: "authentication" | "headers" | "content";
	status: CheckStatus;
	title: string;
	detail: string;
}

export interface TestReport {
	/** Out of 10, like mail-tester: 2 off per failure, 0.5 per warning. */
	score: number;
	checks: Check[];
}

export interface ReportInput {
	from: string;
	subject: string;
	verdicts: {
		spam: string | null;
		virus: string | null;
		spf: string | null;
		dkim: string | null;
		dmarc: string | null;
	};
	parsed: Pick<Email, "headers" | "html" | "text"> | null;
}

const domainOf = (address: string) => bareAddress(address).split("@")[1]?.toLowerCase() ?? "";

/** The registrable part, roughly (mail.acme.com and acme.com align, relaxed DMARC). */
export const orgDomain = (d: string) => {
	const parts = d.toLowerCase().split(".").filter(Boolean);
	const twoLevel = /^(com|net|org|gob|edu|co)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
	return parts.slice(twoLevel ? -3 : -2).join(".");
};
const aligned = (a: string, b: string) => !!a && !!b && orgDomain(a) === orgDomain(b);

const headerValues = (parsed: ReportInput["parsed"], name: string) =>
	(parsed?.headers ?? []).filter((h) => h.key?.toLowerCase() === name).map((h) => h.value ?? "");

/** The d= of each DKIM-Signature header. */
export const dkimDomains = (parsed: ReportInput["parsed"]) =>
	headerValues(parsed, "dkim-signature")
		.map((v) => /(?:^|;)\s*d=([^;\s]+)/i.exec(v)?.[1]?.toLowerCase())
		.filter((d): d is string => !!d);

export async function testReport(
	m: ReportInput,
	fetcher: typeof fetch = fetch,
): Promise<TestReport> {
	const checks: Check[] = [];
	const add = (c: Check) => checks.push(c);
	const from = domainOf(m.from);
	const v = m.verdicts;
	const verdict = (x: string | null) => x?.toUpperCase() ?? "";

	// ── Authentication ──
	const returnPath = domainOf(headerValues(m.parsed, "return-path")[0] ?? "");
	add({
		id: "spf",
		group: "authentication",
		status: verdict(v.spf) === "PASS" ? "pass" : verdict(v.spf) === "FAIL" ? "fail" : "warn",
		title: verdict(v.spf) === "PASS" ? "SPF passes" : "SPF doesn't pass",
		detail:
			verdict(v.spf) === "PASS"
				? `The sending server may send for ${returnPath || "the envelope's domain"}.`
				: `SES's SPF verdict: ${v.spf ?? "none"}. Add the sending service to the SPF record of the MAIL FROM domain.`,
	});
	if (returnPath)
		add({
			id: "spf_alignment",
			group: "authentication",
			status: aligned(returnPath, from) ? "pass" : "warn",
			title: aligned(returnPath, from)
				? "The envelope's domain matches From"
				: "The envelope's domain isn't From's",
			detail: aligned(returnPath, from)
				? `Bounces go to ${returnPath}, part of ${orgDomain(from)}, so SPF counts toward DMARC.`
				: `Bounces go to ${returnPath}. Set a custom MAIL FROM (like bounce.${from}) so SPF counts toward DMARC.`,
		});
	const dkim = dkimDomains(m.parsed);
	const alignedDkim = dkim.find((d) => aligned(d, from));
	add({
		id: "dkim",
		group: "authentication",
		status: verdict(v.dkim) === "PASS" ? (alignedDkim ? "pass" : "warn") : "fail",
		title:
			verdict(v.dkim) !== "PASS"
				? "DKIM doesn't pass"
				: alignedDkim
					? `Signed by ${alignedDkim}`
					: "Signed, but not by From's domain",
		detail:
			verdict(v.dkim) !== "PASS"
				? `SES's DKIM verdict: ${v.dkim ?? "none"}. Publish the DKIM records of ${from}.`
				: alignedDkim
					? "A DKIM signature of the From domain passes, which is what DMARC and Gmail look for."
					: `Signatures: ${dkim.join(", ") || "none read"}. Sign with ${from}'s own DKIM key.`,
	});
	const dmarcRecord = from
		? ((await lookup(`_dmarc.${orgDomain(from)}`, "TXT", fetcher))?.find((r) =>
				r.startsWith("v=dmarc1"),
			) ?? null)
		: null;
	const policy = /(?:^|;)\s*p=(\w+)/.exec(dmarcRecord ?? "")?.[1] ?? null;
	add({
		id: "dmarc",
		group: "authentication",
		status:
			verdict(v.dmarc) === "FAIL"
				? "fail"
				: !dmarcRecord
					? "fail"
					: verdict(v.dmarc) === "PASS"
						? "pass"
						: "warn",
		title: !dmarcRecord
			? `${orgDomain(from) || "The domain"} has no DMARC record`
			: verdict(v.dmarc) === "PASS"
				? "DMARC passes"
				: verdict(v.dmarc) === "FAIL"
					? "DMARC fails"
					: `DMARC: ${v.dmarc?.toLowerCase() ?? "not checked"}`,
		detail: !dmarcRecord
			? "Gmail and Yahoo require one from bulk senders. Start with v=DMARC1; p=none; rua=mailto:… and tighten it later."
			: `Its policy is p=${policy ?? "?"}.${policy === "none" ? " Once reports show only your own services, move to quarantine." : ""}`,
	});

	// ── Headers ──
	add({
		id: "spam",
		group: "headers",
		status: verdict(v.spam) === "FAIL" ? "fail" : verdict(v.spam) === "PASS" ? "pass" : "info",
		title: verdict(v.spam) === "FAIL" ? "SES's spam filter flags it" : "Not flagged as spam",
		detail:
			verdict(v.spam) === "FAIL"
				? "Look at its content and links, and at the domains it links to."
				: `SES's spam verdict: ${v.spam ?? "not checked"}.`,
	});
	if (verdict(v.virus) === "FAIL")
		add({
			id: "virus",
			group: "headers",
			status: "fail",
			title: "SES found a virus",
			detail: "An attachment carries malware.",
		});
	const unsubscribe = headerValues(m.parsed, "list-unsubscribe")[0];
	const oneClick = /one-click/i.test(headerValues(m.parsed, "list-unsubscribe-post")[0] ?? "");
	add({
		id: "unsubscribe",
		group: "headers",
		status: unsubscribe && oneClick ? "pass" : unsubscribe ? "warn" : "info",
		title:
			unsubscribe && oneClick
				? "One-click unsubscribe"
				: unsubscribe
					? "Unsubscribe, but not one-click"
					: "No List-Unsubscribe header",
		detail:
			unsubscribe && oneClick
				? "Gmail and Yahoo show their own unsubscribe button."
				: unsubscribe
					? "Add List-Unsubscribe-Post: List-Unsubscribe=One-Click; Gmail and Yahoo require it for marketing email."
					: "Fine for receipts and codes. Newsletters need it: send with unsubscribe_group, or from a marketing domain.",
	});
	const messageId = headerValues(m.parsed, "message-id")[0];
	add({
		id: "message_id",
		group: "headers",
		status: messageId ? "pass" : "fail",
		title: messageId ? "Has a Message-ID" : "No Message-ID",
		detail: messageId
			? (messageId.match(/@([^>]+)>?$/)?.[1] ?? messageId)
			: "Gmail rejects or delays email without one.",
	});

	// ── Content ──
	const html = m.parsed?.html ?? "";
	const text = m.parsed?.text ?? "";
	if (html)
		add({
			id: "text_part",
			group: "content",
			status: text.trim() ? "pass" : "warn",
			title: text.trim() ? "Has a plain-text part" : "HTML only",
			detail: text.trim()
				? "Text-only readers and spam filters get a version too."
				: "Add a text version: HTML-only email looks more like spam.",
		});
	const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)].map(
		(x) => x[1] ?? "",
	);
	const web = links.filter((l) => /^https?:/i.test(l));
	const insecure = web.filter((l) => /^http:/i.test(l));
	if (web.length)
		add({
			id: "links",
			group: "content",
			status: insecure.length ? "warn" : "pass",
			title: insecure.length
				? `${insecure.length} of ${web.length} links aren't https`
				: `${web.length} link${web.length === 1 ? "" : "s"}, all https`,
			detail: insecure.length
				? `Like ${insecure[0]}. Some filters and browsers warn about plain http.`
				: `They go to ${[...new Set(web.map((l) => new URL(l, "https://x").hostname))].slice(0, 4).join(", ")}.`,
		});
	const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((x) => x[0]);
	const noAlt = images.filter(
		(i) => !/\balt\s*=/i.test(i) && !/width\s*=\s*["']?1["'\s>]/i.test(i),
	);
	if (images.length)
		add({
			id: "alt",
			group: "content",
			status: noAlt.length ? "warn" : "pass",
			title: noAlt.length
				? `${noAlt.length} image${noAlt.length === 1 ? " has" : "s have"} no alt text`
				: "Every image has alt text",
			detail: noAlt.length
				? "Most inboxes block images at first; alt text is what people see then."
				: "People who don't load images still see what they are.",
		});
	for (const f of checkContent({ subject: m.subject, html, text }))
		add({
			id: f.code,
			group: "content",
			status: f.level === "warning" ? "warn" : "info",
			title: f.message,
			detail: "",
		});

	const score =
		10 -
		checks.reduce((n, c) => n + (c.status === "fail" ? 2 : c.status === "warn" ? 0.5 : 0), 0);
	return { score: Math.max(0, Math.round(score * 10) / 10), checks };
}
