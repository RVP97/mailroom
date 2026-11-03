import { cfg } from "./env";

/** The address domains put in rua=, e.g. dmarc@mailroom.example.com. Unset: no reports. */
export const dmarcReportsAddress = () => cfg().DMARC_REPORTS_ADDRESS?.trim() || null;

/** Whether a DMARC record already sends its aggregate reports to Mailroom. */
export function sendsReportsHere(record: string | null | undefined): boolean {
	const address = dmarcReportsAddress();
	if (!address || !record) return false;
	const rua = /(?:^|;)\s*rua\s*=\s*([^;]+)/i.exec(record)?.[1] ?? "";
	return rua.split(",").some(
		(u) =>
			u
				.trim()
				.replace(/^mailto:/i, "")
				.split("!")[0]
				?.toLowerCase() === address,
	);
}

/** A DMARC record's text with Mailroom's rua= added (or replacing Mailroom's own). */
export function withReportsAddress(record: string): string {
	const address = dmarcReportsAddress();
	if (!address || sendsReportsHere(record)) return record;
	const parts = record
		.replace(/^"|"$/g, "")
		.split(";")
		.map((p) => p.trim())
		.filter(Boolean);
	const i = parts.findIndex((p) => /^rua\s*=/i.test(p));
	if (i >= 0) parts[i] = `${parts[i]},mailto:${address}`;
	else parts.push(`rua=mailto:${address}`);
	return `${parts.join("; ")};`;
}
