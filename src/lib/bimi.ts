import { type Dmarc, orgDomain } from "./dmarc";

/**
 * BIMI: the brand logo mailbox providers show beside a domain's emails. It takes three things:
 * a DMARC policy that enforces (quarantine or reject, on all mail), a TXT record at
 * default._bimi.<domain> pointing to the logo, and the logo as an SVG Tiny Portable/Secure file.
 * Yahoo and others show it with just that; Gmail also wants a mark certificate (VMC or CMC, the
 * record's a=), and Apple Mail takes the logo from Apple Business Connect.
 */

/** BIMI's size limit for the logo file. */
export const BIMI_MAX_BYTES = 32 * 1024;

/** Elements SVG Tiny PS doesn't allow: scripts, embedded images, animation, links, foreign. */
const FORBIDDEN = /<\s*(script|image|foreignObject|a|animate\w*|set|iframe|video|audio|style)\b/i;

/**
 * The logo as SVG Tiny PS, or why it can't be one. An ordinary square SVG is made one: the root
 * gets version="1.2" baseProfile="tiny-ps", loses x, y, width and height (the logo scales), and
 * gets a <title> (the brand's name) when it has none. What can't be converted (scripts, embedded
 * images, links, CSS, a logo that isn't square) is refused, so the person fixes the source.
 */
export function prepareBimiSvg(input: string, title: string): { svg: string } | { error: string } {
	let svg = input.replace(/^﻿/, "").trim();
	// The XML prolog, comments, doctype and editor metadata only add weight.
	svg = svg
		.replace(/<\?xml[^>]*\?>/g, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<metadata\b[\s\S]*?<\/metadata>/gi, "")
		.trim();
	const root = /^<svg\b([^>]*)>/i.exec(svg);
	if (!root) return { error: "That isn't an SVG file. Export the logo as SVG." };
	if (FORBIDDEN.test(svg))
		return {
			error: "The logo has scripts, embedded images, links, animation or CSS styles, which BIMI doesn't allow. Export it as plain shapes with fill and stroke attributes.",
		};
	if (/\b(?:xlink:)?href\s*=\s*["'](?!#)/i.test(svg))
		return { error: "The logo points to other files. BIMI logos must be self-contained." };
	const attrs = root[1] ?? "";
	const viewBox = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
	const box = viewBox
		?.trim()
		.split(/[\s,]+/)
		.map(Number);
	const width = Number(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(attrs)?.[1]);
	const height = Number(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i.exec(attrs)?.[1]);
	const [w, h] = box?.length === 4 ? [box[2], box[3]] : [width, height];
	if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h))
		return { error: "The logo needs a viewBox, so it can be scaled." };
	if (Math.abs(w - h) > Math.max(w, h) * 0.01)
		return {
			error: `The logo is ${w}×${h}. BIMI logos are square: inboxes show them in a circle.`,
		};
	const kept = attrs
		.replace(/\s(?:x|y|width|height|version|baseProfile|viewBox)\s*=\s*("[^"]*"|'[^']*')/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	const name = title.replace(/[<>&"]/g, "").trim() || "Logo";
	svg = svg.replace(
		/^<svg\b[^>]*>/i,
		`<svg ${kept.includes("xmlns=") ? kept : `xmlns="http://www.w3.org/2000/svg" ${kept}`.trim()} version="1.2" baseProfile="tiny-ps" viewBox="${box?.length === 4 ? box.join(" ") : `0 0 ${w} ${h}`}">`,
	);
	if (!/<title\b/i.test(svg)) svg = svg.replace(/^(<svg\b[^>]*>)/i, `$1<title>${name}</title>`);
	const bytes = new TextEncoder().encode(svg).length;
	if (bytes > BIMI_MAX_BYTES)
		return {
			error: `The logo is ${Math.ceil(bytes / 1024)} KB; BIMI allows 32 KB. Simplify its paths or export it with fewer decimals.`,
		};
	return { svg };
}

export type Bimi = {
	found: boolean;
	/** Where the record is: default._bimi.<domain>, or its organizational domain's. */
	at: string;
	record: string | null;
	/** The logo's URL (l=). */
	logo: string | null;
	/** The mark certificate's URL (a=), which Gmail requires. */
	certificate: string | null;
};

/** The BIMI record that covers a domain: its own, or else its organizational domain's. */
export async function findBimi(
	name: string,
	lookup: (name: string) => Promise<string[]>,
): Promise<Bimi> {
	const domain = name.toLowerCase().replace(/\.$/, "");
	const org = orgDomain(domain);
	for (const at of org === domain ? [domain] : [domain, org]) {
		const record = (await lookup(`default._bimi.${at}`)).find((t) =>
			/^v=BIMI1\b/i.test(t.trim()),
		);
		if (!record) continue;
		const tag = (k: string) =>
			new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]*)`, "i").exec(record)?.[1]?.trim() || null;
		return { found: true, at, record, logo: tag("l"), certificate: tag("a") };
	}
	return { found: false, at: domain, record: null, logo: null, certificate: null };
}

/**
 * Whether a DMARC record is strict enough for BIMI: p=quarantine or reject on every message
 * (pct absent or 100), and for a subdomain covered by its parent's record, sp not none.
 */
export function dmarcEnforces(d: Dmarc): boolean {
	if (!d.found || d.duplicate || !d.record) return false;
	if (d.policy !== "quarantine" && d.policy !== "reject") return false;
	const tag = (k: string) =>
		new RegExp(`(?:^|;)\\s*${k}\\s*=\\s*([^;]*)`, "i").exec(d.record ?? "")?.[1]?.trim();
	const pct = tag("pct");
	if (pct !== undefined && Number(pct) !== 100) return false;
	if (d.inherited && tag("sp")?.toLowerCase() === "none") return false;
	return true;
}

/** The DMARC record to suggest when a domain wants its logo shown. */
export const ENFORCING_DMARC = '"v=DMARC1; p=quarantine;"';
