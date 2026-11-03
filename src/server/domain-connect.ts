import { orgDomain } from "../lib/dmarc";
import { type DnsHelp, dnsHostFromNameservers } from "../lib/dns-hosts";
import type { schema } from "./db";
import { cfg } from "./env";
import { trackingTarget } from "./tracking";

/**
 * One-click DNS: when the domain's DNS host runs Domain Connect (Cloudflare, GoDaddy, IONOS…)
 * and has onboarded this deployment's template (DOMAIN_CONNECT_PROVIDER_ID; see
 * domain-connect/README.md), a signed link adds every record the domain still needs after the
 * person signs in at the host and approves. Only the synchronous flow, signed (RS256) with
 * DOMAIN_CONNECT_PRIVATE_KEY, whose public key is at _dck1.<provider id>.
 * https://www.domainconnect.org
 */
export const DOMAIN_CONNECT = {
	serviceId: "sending-domain",
	keyHost: "_dck1",
} as const;

/** The template's providerId (the deployment's own domain). Empty: one-click DNS is off. */
const providerId = () => cfg().DOMAIN_CONNECT_PROVIDER_ID?.trim() ?? "";

const TIMEOUT_MS = 3000;
const DNS_TYPES = { NS: 2, TXT: 16 } as const;

const get = (url: string, init?: RequestInit) =>
	fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** Answers for one name and type, over DNS-over-HTTPS. Empty on any failure. */
async function lookup(name: string, type: keyof typeof DNS_TYPES): Promise<string[]> {
	try {
		const r = await get(
			`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
			{ headers: { accept: "application/dns-json" } },
		);
		if (!r.ok) return [];
		const body = (await r.json()) as { Answer?: { type: number; data: string }[] };
		return (body.Answer ?? [])
			.filter((a) => a.type === DNS_TYPES[type])
			.map((a) => a.data.replace(/"\s*"/g, "").replace(/"/g, "").trim());
	} catch {
		return [];
	}
}

interface Provider {
	providerName?: string;
	providerDisplayName?: string;
	urlSyncUX?: string;
	urlAPI?: string;
}

/** The DNS host's Domain Connect settings for this zone, if it has Mailroom's template. */
async function discover(root: string): Promise<(Provider & { urlSyncUX: string }) | null> {
	if (!providerId()) return null;
	const [apiHost] = await lookup(`_domainconnect.${root}`, "TXT");
	if (!apiHost) return null;
	try {
		const settings = await get(`https://${apiHost}/v2/${encodeURIComponent(root)}/settings`);
		if (!settings.ok) return null;
		const p = (await settings.json()) as Provider;
		if (!p.urlSyncUX || !p.urlAPI) return null;
		// A 404 here: the host hasn't onboarded the template (yet).
		const template = await get(
			`${p.urlAPI.replace(/\/$/, "")}/v2/domainTemplates/providers/${providerId()}/services/${DOMAIN_CONNECT.serviceId}`,
		);
		if (!template.ok) return null;
		return { ...p, urlSyncUX: p.urlSyncUX };
	} catch {
		return null;
	}
}

type Domain = Pick<
	typeof schema.domains.$inferSelect,
	| "name"
	| "region"
	| "dkim_tokens"
	| "dkim_status"
	| "mail_from"
	| "mail_from_status"
	| "status"
	| "tracking_host"
	| "tracking_status"
> & { bimi_logo?: string | null; has_logo?: boolean };

/** What Mailroom found in DNS itself (SES doesn't check these). */
export interface Found {
	/** Any DMARC record covers the domain (its own or its organizational domain's). */
	dmarc: boolean;
	/** A BIMI record is already at default._bimi (any logo): the template would add a second. */
	bimi: boolean;
}

/**
 * The template's groups and variables for what this domain still needs. Null when nothing is
 * missing or the records don't fit the template (another app's MAIL FROM, say): then it's set
 * up by hand, never half written.
 */
export function connectRecords(
	d: Domain,
	found: Found,
): { variables: Record<string, string>; groups: string[] } | null {
	const groups: string[] = [];
	const variables: Record<string, string> = {};
	if (d.dkim_status !== "SUCCESS") {
		if (d.dkim_tokens.length !== 3 || !d.dkim_tokens.every((t) => /^[a-z0-9]{20,64}$/.test(t)))
			return null;
		d.dkim_tokens.forEach((t, i) => {
			variables[`dkim${i + 1}`] = t;
		});
		groups.push("dkim");
	}
	if (d.mail_from && d.mail_from_status !== "SUCCESS") {
		if (d.mail_from !== `bounce.${d.name}` || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(d.region))
			return null;
		variables.region = d.region;
		groups.push("mailfrom");
	}
	if (!found.dmarc) groups.push("dmarc");
	if (
		d.tracking_host === `links.${d.name}` &&
		d.tracking_status !== "active" &&
		// The template's links CNAME points at this deployment's TRACKING_CNAME_TARGET.
		!!trackingTarget()
	)
		groups.push("tracking");
	if ((d.bimi_logo || d.has_logo) && !found.bimi) groups.push("bimi");
	return groups.length ? { variables, groups } : null;
}

function pemToDer(pem: string): ArrayBuffer {
	const base64 = pem
		.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
		.replace(/\\n/g, "")
		.replace(/\s+/g, "");
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

/** RS256 over the query string, base64: the Domain Connect signature. */
export async function signQuery(query: string, privateKeyPem: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(query));
	return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** The signed apply link. Cloudflare wants the signature last: `key`, then `sig`, both outside
 * the signed query. */
export async function applyUrl(input: {
	urlSyncUX: string;
	domain: string;
	variables: Record<string, string>;
	groups: string[];
	redirectUri: string;
	privateKeyPem: string;
}): Promise<string> {
	const root = orgDomain(input.domain);
	const params = new URLSearchParams();
	params.set("domain", root);
	params.set("host", input.domain === root ? "" : input.domain.slice(0, -(root.length + 1)));
	params.set("groupId", input.groups.join(","));
	for (const [k, v] of Object.entries(input.variables)) params.set(k, v);
	params.set("redirect_uri", input.redirectUri);
	const query = params.toString();
	const sig = await signQuery(query, input.privateKeyPem);
	return `${input.urlSyncUX.replace(/\/$/, "")}/v2/domainTemplates/providers/${providerId()}/services/${DOMAIN_CONNECT.serviceId}/apply?${query}&key=${DOMAIN_CONNECT.keyHost}&sig=${encodeURIComponent(sig)}`;
}

/** A zone's DNS host and Domain Connect settings change rarely: kept 10 minutes per isolate. */
const cache = new Map<
	string,
	{ until: number; value: Promise<[DnsHelp["host"], Awaited<ReturnType<typeof discover>>]> }
>();

/** Forgets what was looked up (tests). */
export const forgetDnsHosts = () => cache.clear();

function zoneInfo(root: string) {
	const hit = cache.get(root);
	if (hit && hit.until > Date.now()) return hit.value;
	const value = Promise.all([
		lookup(root, "NS").then((ns) => dnsHostFromNameservers(ns, root)),
		discover(root),
	]);
	cache.set(root, { until: Date.now() + 10 * 60_000, value });
	return value;
}

/** The domain's DNS host, and a one-click link for what it still needs. Best effort. */
export async function dnsHelp(d: Domain, found: Found, redirectUri: string): Promise<DnsHelp> {
	const root = orgDomain(d.name);
	const [host, provider] = await zoneInfo(root);
	const key = cfg().DOMAIN_CONNECT_PRIVATE_KEY;
	const records = connectRecords(d, found);
	let connect: DnsHelp["connect"] = null;
	if (provider && key && records)
		try {
			connect = {
				providerName:
					provider.providerDisplayName ?? provider.providerName ?? host?.name ?? "",
				url: await applyUrl({
					urlSyncUX: provider.urlSyncUX,
					domain: d.name,
					...records,
					redirectUri,
					privateKeyPem: key,
				}),
			};
		} catch (error) {
			console.error("domain-connect: link not signed", error);
		}
	return { root, host, connect };
}
