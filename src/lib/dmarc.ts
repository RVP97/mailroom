/** Two-label public suffixes, so mail.acme.com.mx falls back to acme.com.mx's DMARC. */
const SUFFIXES = new Set([
	"com.mx",
	"org.mx",
	"net.mx",
	"gob.mx",
	"edu.mx",
	"co.uk",
	"org.uk",
	"com.br",
	"com.ar",
	"com.co",
	"com.au",
	"co.jp",
	"com.es",
	"com.pe",
	"com.cl",
]);

/** A domain's organizational domain: mail.acme.com → acme.com, mail.hotel.com.mx → hotel.com.mx. */
export function orgDomain(name: string): string {
	const labels = name.toLowerCase().replace(/\.$/, "").split(".");
	return labels.slice(SUFFIXES.has(labels.slice(-2).join(".")) ? -3 : -2).join(".");
}

/** A name's TXT records over DNS-over-HTTPS, each one's strings joined. */
export async function txtRecords(name: string): Promise<string[]> {
	const r = await fetch(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
		{ headers: { accept: "application/dns-json" } },
	);
	if (!r.ok) throw new Error(`DNS lookup failed (${r.status})`);
	const body = (await r.json()) as { Answer?: { type: number; data: string }[] };
	return (body.Answer ?? [])
		.filter((a) => a.type === 16)
		.map((a) => a.data.replace(/"\s+"/g, "").replace(/^"|"$/g, ""));
}

export type Dmarc = {
	found: boolean;
	/** Where the record is: the domain itself, or its organizational domain. */
	at: string;
	inherited: boolean;
	record: string | null;
	policy: "none" | "quarantine" | "reject" | null;
	/** More than one DMARC record makes providers ignore them all. */
	duplicate: boolean;
};

/**
 * The DMARC record that covers a domain: its own _dmarc, or else its organizational domain's,
 * which mailbox providers fall back to for subdomains.
 */
export async function findDmarc(
	name: string,
	lookup: (name: string) => Promise<string[]>,
): Promise<Dmarc> {
	const domain = name.toLowerCase().replace(/\.$/, "");
	const org = orgDomain(domain);
	for (const at of org === domain ? [domain] : [domain, org]) {
		const records = (await lookup(`_dmarc.${at}`)).filter((t) => /^v=DMARC1\b/i.test(t.trim()));
		const record = records[0];
		if (!record) continue;
		const policy = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i
			.exec(record)?.[1]
			?.toLowerCase();
		return {
			found: true,
			at,
			inherited: at !== domain,
			record,
			policy: (policy as Dmarc["policy"]) ?? null,
			duplicate: records.length > 1,
		};
	}
	return {
		found: false,
		at: domain,
		inherited: false,
		record: null,
		policy: null,
		duplicate: false,
	};
}
