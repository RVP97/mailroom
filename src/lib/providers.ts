/**
 * The mailbox provider behind an address, by its domain (Stats by provider, bounce
 * explanations). Company domains hosted at Google or Microsoft count as "other": telling them
 * apart would take an MX lookup per domain.
 */
export type Provider = "gmail" | "outlook" | "yahoo" | "icloud" | "other";

const BY_DOMAIN: Record<string, Provider> = {
	"gmail.com": "gmail",
	"googlemail.com": "gmail",
	"outlook.com": "outlook",
	"hotmail.com": "outlook",
	"hotmail.es": "outlook",
	"hotmail.com.mx": "outlook",
	"live.com": "outlook",
	"live.com.mx": "outlook",
	"msn.com": "outlook",
	"yahoo.com": "yahoo",
	"yahoo.com.mx": "yahoo",
	"yahoo.es": "yahoo",
	"ymail.com": "yahoo",
	"rocketmail.com": "yahoo",
	"aol.com": "yahoo",
	"icloud.com": "icloud",
	"me.com": "icloud",
	"mac.com": "icloud",
};

export const PROVIDERS: Provider[] = ["gmail", "outlook", "yahoo", "icloud", "other"];

export const PROVIDER_LABEL: Record<Provider, string> = {
	gmail: "Gmail",
	outlook: "Outlook",
	yahoo: "Yahoo",
	icloud: "iCloud",
	other: "Other",
};

export function providerOf(address: string | null | undefined): Provider {
	const domain = address?.split("@")[1]?.trim().toLowerCase().replace(/>$/, "") ?? "";
	return BY_DOMAIN[domain] ?? "other";
}

/** The address domains a provider is known by (none for "other": it's every domain but these). */
export const domainsOf = (p: Provider) =>
	Object.entries(BY_DOMAIN).flatMap(([d, q]) => (q === p ? [d] : []));

export const KNOWN_DOMAINS = Object.keys(BY_DOMAIN);
