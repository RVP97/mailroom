import { env } from "cloudflare:workers";
import type { AwsConfig } from "./aws/ses";

/** The deployment's configuration (wrangler.jsonc vars and secrets). */
export interface MailroomEnv {
	AWS_ACCESS_KEY_ID?: string;
	AWS_SECRET_ACCESS_KEY?: string;
	AWS_REGION?: string;
	TIMEZONE?: string;
	ADMIN_EMAILS?: string;
	MAX_SEND_RATE?: string;
	BODY_RETENTION_DAYS?: string;
	LOG_RETENTION_DAYS?: string;
	REQUEST_LOG_RETENTION_DAYS?: string;
	BETTER_AUTH_URL?: string;
	SYSTEM_FROM?: string;
	SYSTEM_FROM_SES?: string;
	/** Signs Domain Connect links (one-click DNS at the domain's DNS host); PKCS8 PEM. */
	DOMAIN_CONNECT_PRIVATE_KEY?: string;
	/** The onboarded Domain Connect template's providerId. Empty: no one-click DNS. */
	DOMAIN_CONNECT_PROVIDER_ID?: string;
	/** Who runs the deployment, named on the public About, Privacy and Terms pages. */
	OPERATOR_NAME?: string;
	CONTACT_EMAIL?: string;
	/** Tracking on each domain's own host (links.<domain>), as Cloudflare for SaaS custom
	 * hostnames: the SaaS zone, the CNAME target (its fallback origin) and an API token. */
	TRACKING_ZONE_ID?: string;
	TRACKING_CNAME_TARGET?: string;
	CLOUDFLARE_API_TOKEN?: string;
	/** Where domains send DMARC aggregate reports (rua=), routed to this Worker by Email Routing. */
	DMARC_REPORTS_ADDRESS?: string;
	/** Each brand's Mailroom address is <brand slug>@INBOUND_DOMAIN (received through SES). */
	INBOUND_DOMAIN?: string;
	/** Days received emails are kept (the row and the message in R2). */
	INBOUND_RETENTION_DAYS?: string;
	/** Days contacts' app events are kept (395 by default). */
	EVENT_RETENTION_DAYS?: string;
	/** R2: every received message, whole. */
	INBOUND?: R2Bucket;
	/** R2: the long-term archive of what retention deletes (falls back to INBOUND). */
	ARCHIVE?: R2Bucket;
	/** "false" turns the archive off: past retention, rows are only deleted. */
	ARCHIVE_EMAILS?: string;
	/** The Cloudflare account Turnstile widgets for sign-up forms are made in (with
	 * CLOUDFLARE_API_TOKEN: Account › Turnstile › Edit). */
	CLOUDFLARE_ACCOUNT_ID?: string;
	/** A Google OAuth client (Web application, redirect URI <BETTER_AUTH_URL>/postmaster/callback)
	 * for Gmail Postmaster Tools (src/server/postmaster.ts). Secrets. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Emailable (src/server/mailbox-checks.ts): checks first-time recipients' mailboxes before
	 * their first email. Secret; empty: off. */
	EMAILABLE_API_KEY?: string;
	/** Emailable checks a month at most (default 1000). */
	EMAILABLE_MONTHLY_LIMIT?: string;
}

export const cfg = () => env as unknown as MailroomEnv;

export const region = () => cfg().AWS_REGION || "us-east-1";
export const timezone = () => cfg().TIMEZONE || "UTC";
export const baseUrl = () => (cfg().BETTER_AUTH_URL ?? "").replace(/\/$/, "");

export const awsConfigured = () => !!cfg().AWS_ACCESS_KEY_ID && !!cfg().AWS_SECRET_ACCESS_KEY;

/** Tests swap AWS's fetch for their own. */
let fetcher: typeof fetch | undefined;
export const setAwsFetcher = (f: typeof fetch | undefined) => {
	fetcher = f;
};
export const awsFetcher = () => fetcher;

export function aws(): AwsConfig {
	const e = cfg();
	if (!e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY)
		throw new Error("AWS is not configured: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
	return {
		region: region(),
		credentials: { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY },
		fetcher,
	};
}

export const adminEmails = () =>
	(cfg().ADMIN_EMAILS ?? "")
		.split(",")
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);

export const isAdminEmail = (email: string) => adminEmails().includes(email.trim().toLowerCase());

const days = (v: string | undefined, fallback: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const bodyRetentionDays = () => days(cfg().BODY_RETENTION_DAYS, 7);
export const logRetentionDays = () => days(cfg().LOG_RETENTION_DAYS, 90);
export const requestLogRetentionDays = () => days(cfg().REQUEST_LOG_RETENTION_DAYS, 30);
export const inboundRetentionDays = () => days(cfg().INBOUND_RETENTION_DAYS, 30);
/** Days contacts' app events are kept (src/server/contact-events.ts). */
export const eventRetentionDays = () => days(cfg().EVENT_RETENTION_DAYS, 395);
export const inboundDomain = () => cfg().INBOUND_DOMAIN?.trim().toLowerCase() || null;
export const maxSendRate = () => days(cfg().MAX_SEND_RATE, 14);
