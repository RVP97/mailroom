import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";
import { baseUrl } from "./env";

/**
 * A domain's own host (links.<domain>, the tracking host of src/server/tracking.ts) serves more
 * than opens and clicks: everything a reader of its emails can land on. Its unsubscribe page,
 * web versions, newsletter archive, polls, referral links, sign-up forms and uploaded images
 * are all there, so its emails never show Mailroom's address.
 * - Sending: deliver() moves the email's links to Mailroom's public pages onto the host
 *   (onOwnHost), so every link built before it (merge tags, the unsubscribe line) follows.
 * - Serving: a request on the host runs inside its scope (publicScope), so publicUrl() and the
 *   pages' own links stay on it, and pages of another organization aren't served there.
 * Without one (or before its certificate), everything stays on Mailroom's address.
 */

export interface PublicScope {
	/** https://links.example.com */
	base: string;
	organizationId: string;
	/** The domain the host belongs to: example.com. */
	domain: string;
}

const scope = new AsyncLocalStorage<PublicScope>();

export const inPublicScope = <T>(s: PublicScope, fn: () => T) => scope.run(s, fn);

export const currentPublicScope = () => scope.getStore();

/** Where reader-facing links go: the host this request came in on, else Mailroom's address. */
export const publicUrl = () => scope.getStore()?.base ?? baseUrl();

/**
 * Whether something of this organization may be shown here: always on Mailroom's address, and on
 * a domain's host only when it's that domain's organization.
 */
export const shownHere = (organizationId: string | null | undefined) => {
	const s = scope.getStore();
	return !s || s.organizationId === organizationId;
};

/** The paths a domain's host serves besides /c/ and /o/ (and / itself). */
export const PUBLIC_PATH =
	/^\/(?:unsubscribe$|view\/|n\/|help\/|poll\/|r\/|media\/|subscribe\/|logos\/|bimi\/)/;

const hosts = new Map<string, { at: number; value: PublicScope | null }>();

/** The domain whose live host this is, or null (a host still pending serves nothing). */
export async function scopeForHost(hostname: string): Promise<PublicScope | null> {
	const name = hostname.toLowerCase();
	const hit = hosts.get(name);
	if (hit && hit.at > Date.now() - 60_000) return hit.value;
	const d = schema.domains;
	const row = await db
		.select({ organization_id: d.organization_id, name: d.name })
		.from(d)
		.where(and(eq(d.tracking_host, name), eq(d.tracking_status, "active")))
		.get();
	const value = row
		? { base: `https://${name}`, organizationId: row.organization_id, domain: row.name }
		: null;
	hosts.set(name, { at: Date.now(), value });
	return value;
}

export const forgetHosts = () => hosts.clear();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * An email's links to Mailroom's public pages, on the domain's host instead (`base`, like
 * https://links.example.com). Links to the dashboard and anything else stay as they are.
 */
export function onOwnHost<
	T extends { html?: string; text?: string; headers?: Record<string, string> },
>(content: T, base: string | null): T {
	const own = baseUrl();
	if (!base || !own || base === own) return content;
	const re = new RegExp(
		`${escapeRe(own)}(?=/(?:unsubscribe\\b|view/|n/|poll/|r/|media/|subscribe/|logos/|bimi/))`,
		"g",
	);
	const move = (s: string | undefined) => (s === undefined ? s : s.replace(re, base));
	return {
		...content,
		html: move(content.html),
		text: move(content.text),
		headers: content.headers
			? Object.fromEntries(Object.entries(content.headers).map(([k, v]) => [k, move(v) ?? v]))
			: content.headers,
	};
}

/** A domain's host for public pages, once its certificate is live; else null. */
export const ownHostBase = (d: { tracking_host: string | null; tracking_status: string | null }) =>
	d.tracking_host && d.tracking_status === "active" ? `https://${d.tracking_host}` : null;
