/**
 * Where a domain's DNS lives, told apart by its nameservers, so the domain page can name it
 * (with its logo), link to its DNS page and write record names the way it wants them typed.
 * No server dependencies: safe for the browser.
 */

export type DnsHostId =
	| "cloudflare"
	| "godaddy"
	| "namecheap"
	| "hostinger"
	| "wix"
	| "squarespace"
	| "googleCloud"
	| "route53"
	| "ionos"
	| "digitalocean"
	| "vercel"
	| "netlify"
	| "porkbun"
	| "hetzner"
	| "ovh"
	| "gandi"
	| "namesilo"
	| "hostgator"
	| "bluehost"
	| "neubox"
	| "akky"
	| "azure";

interface DnsHostInfo {
	/** Brand name, never translated. */
	name: string;
	/** Matches one of the domain's nameservers. */
	nameserver: RegExp;
	/** The host's DNS page for this domain, when it has a stable link. */
	dnsUrl?: (root: string) => string;
	/** Wants the full hostname in the Name field instead of the part before the domain. */
	fullNames?: boolean;
}

/** Checked in order: Google Cloud's nameservers also end in googledomains.com. */
export const DNS_HOSTS: Record<DnsHostId, DnsHostInfo> = {
	cloudflare: {
		name: "Cloudflare",
		nameserver: /\.ns\.cloudflare\.com$/,
		dnsUrl: (root) => `https://dash.cloudflare.com/?to=/:account/${root}/dns/records`,
	},
	godaddy: {
		name: "GoDaddy",
		nameserver: /\.domaincontrol\.com$/,
		dnsUrl: (root) => `https://dcc.godaddy.com/manage/${root}/dns`,
	},
	namecheap: {
		name: "Namecheap",
		nameserver: /\.registrar-servers\.com$/,
		dnsUrl: (root) =>
			`https://ap.www.namecheap.com/Domains/DomainControlPanel/${root}/advancedns`,
	},
	hostinger: {
		name: "Hostinger",
		nameserver: /(\.dns-parking\.com|hostinger\.[a-z.]+)$/,
		dnsUrl: (root) => `https://hpanel.hostinger.com/domain/${root}/dns`,
	},
	wix: {
		name: "Wix",
		nameserver: /\.wixdns\.net$/,
		dnsUrl: () => "https://manage.wix.com/account/domains",
	},
	googleCloud: {
		name: "Google Cloud DNS",
		nameserver: /^ns-cloud-[a-z0-9]+\.googledomains\.com$/,
		dnsUrl: () => "https://console.cloud.google.com/net-services/dns/zones",
		fullNames: true,
	},
	squarespace: {
		name: "Squarespace",
		nameserver: /(\.squarespacedns\.com|\.googledomains\.com)$/,
		dnsUrl: (root) =>
			`https://account.squarespace.com/domains/managed/${root}/dns/dns-settings`,
	},
	route53: {
		name: "Amazon Route 53",
		nameserver: /\.awsdns-[0-9]+\.[a-z.]+$/,
		dnsUrl: () => "https://console.aws.amazon.com/route53/v2/hostedzones",
		fullNames: true,
	},
	ionos: {
		name: "IONOS",
		nameserver: /\.ui-dns\.[a-z.]+$/,
		dnsUrl: () => "https://my.ionos.com/domains",
	},
	digitalocean: {
		name: "DigitalOcean",
		nameserver: /\.digitalocean\.com$/,
		dnsUrl: (root) => `https://cloud.digitalocean.com/networking/domains/${root}`,
	},
	vercel: {
		name: "Vercel",
		nameserver: /\.vercel-dns\.com$/,
		dnsUrl: () => "https://vercel.com/dashboard/domains",
	},
	netlify: {
		name: "Netlify",
		nameserver: /^dns[0-9]\.p[0-9]+\.nsone\.net$/,
		dnsUrl: () => "https://app.netlify.com/teams/dns",
	},
	porkbun: {
		name: "Porkbun",
		nameserver: /\.porkbun\.com$/,
		dnsUrl: () => "https://porkbun.com/account/domainsSpeedy",
	},
	hetzner: {
		name: "Hetzner",
		nameserver: /\.(hetzner\.com|your-dns\.com|second-ns\.(de|com))$/,
		dnsUrl: () => "https://dns.hetzner.com",
	},
	ovh: { name: "OVHcloud", nameserver: /\.ovh\.(net|ca)$/ },
	gandi: { name: "Gandi", nameserver: /\.gandi\.net$/ },
	namesilo: { name: "NameSilo", nameserver: /\.dnsowl\.com$/ },
	hostgator: {
		name: "HostGator",
		nameserver: /(hostgator\.[a-z.]+|\.websitewelcome\.com)$/,
	},
	bluehost: { name: "Bluehost", nameserver: /\.bluehost\.com$/ },
	neubox: { name: "Neubox", nameserver: /neubox\.[a-z.]+$/ },
	akky: { name: "Akky", nameserver: /akky\.[a-z.]+$/ },
	azure: { name: "Azure DNS", nameserver: /\.azure-dns\.[a-z.]+$/, fullNames: true },
};

export interface DnsHost {
	id: DnsHostId;
	name: string;
	dnsUrl: string | null;
	fullNames: boolean;
}

/** The DNS host behind these nameservers, or null when we don't know it. */
export function dnsHostFromNameservers(nameservers: string[], root: string): DnsHost | null {
	const names = nameservers.map((n) => n.toLowerCase().replace(/\.$/, ""));
	for (const [id, info] of Object.entries(DNS_HOSTS) as [DnsHostId, DnsHostInfo][])
		if (names.some((n) => info.nameserver.test(n)))
			return {
				id,
				name: info.name,
				dnsUrl: info.dnsUrl?.(root) ?? null,
				fullNames: info.fullNames ?? false,
			};
	return null;
}

/**
 * A record's Name as this host wants it typed: most add the zone for you («bounce.mail»), a few
 * want the whole hostname.
 */
export function recordNameForHost(fullName: string, root: string, host: DnsHost | null): string {
	if (!host || host.fullNames) return fullName;
	if (fullName === root) return "@";
	return fullName.endsWith(`.${root}`) ? fullName.slice(0, -(root.length + 1)) : fullName;
}

/** What the domain page shows to help with DNS. */
export interface DnsHelp {
	/** The zone the domain's records live in (the registered domain). */
	root: string;
	host: DnsHost | null;
	/** One-click setup at the DNS host, when it supports Mailroom's Domain Connect template. */
	connect: { providerName: string; url: string } | null;
}
