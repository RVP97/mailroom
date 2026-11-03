import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, schema } from "./db";
import { baseUrl, cfg } from "./env";
import { getSetting, setSetting } from "./settings";
import { iso, lastDays } from "./time";

/**
 * Gmail Postmaster Tools (API v2): what Gmail itself sees of each sending domain. Gmail doesn't
 * report spam complaints back to SES, so this is the only spam rate there is for Gmail, plus
 * Gmail's SPF, DKIM and DMARC pass rates, TLS, delivery errors and its bulk-sender compliance.
 *
 * A deployment admin connects a Google account once (OAuth, GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET). Every 6 hours Mailroom registers each verified sending domain with that
 * account, shows the TXT record Google verifies it with (domain page), verifies it once the
 * record is there, and keeps the last days' statistics in D1 (postmaster_stats).
 */

const API = "https://gmailpostmastertools.googleapis.com/v2";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPE = "https://www.googleapis.com/auth/postmaster openid email";
/** Gmail's line: keep the spam rate under 0.1%, never reach 0.3%. */
export const SPAM_RATE = { warning: 0.001, danger: 0.003 } as const;
/** Days of statistics read each run (Gmail's data lags a day or two). */
const DAYS = 7;

export const postmasterConfigured = () => !!cfg().GOOGLE_CLIENT_ID && !!cfg().GOOGLE_CLIENT_SECRET;

const redirectUri = () => `${baseUrl()}/postmaster/callback`;

/** Tests swap Google's fetch for their own. */
let fetcher: typeof fetch = (...a) => fetch(...a);
export const setPostmasterFetcher = (f: typeof fetch | undefined) => {
	fetcher = f ?? ((...a) => fetch(...a));
};

// ── Connecting ─────────────────────────────────────────────────────────────

let hmacKey: Promise<CryptoKey> | null = null;
const key = () => {
	hmacKey ??= crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(
			`postmaster:${(cfg() as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET ?? ""}`,
		),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	return hmacKey;
};
const hex = (b: ArrayBuffer) =>
	[...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function signState(expires: number) {
	const mac = await crypto.subtle.sign(
		"HMAC",
		await key(),
		new TextEncoder().encode(`${expires}`),
	);
	return `${expires}.${hex(mac)}`;
}

async function stateValid(state: string, now = Date.now()) {
	const [expires, mac] = state.split(".");
	if (!expires || !mac || Number(expires) < now) return false;
	return (await signState(Number(expires))) === state;
}

/** Google's consent page for the admin to connect. */
export async function connectUrl(now = Date.now()) {
	const p = new URLSearchParams({
		client_id: cfg().GOOGLE_CLIENT_ID ?? "",
		redirect_uri: redirectUri(),
		response_type: "code",
		scope: SCOPE,
		access_type: "offline",
		prompt: "consent",
		state: await signState(now + 15 * 60_000),
	});
	return `${AUTH_URL}?${p}`;
}

/** /postmaster/callback: keeps the refresh token, then back to the AWS account page. */
export async function handleCallback(request: Request, now = Date.now()) {
	const url = new URL(request.url);
	const back = (status: string) =>
		Response.redirect(`${baseUrl()}/admin?postmaster=${status}`, 302);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state") ?? "";
	if (!code || !(await stateValid(state, now))) return back("failed");
	const r = await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code,
			client_id: cfg().GOOGLE_CLIENT_ID ?? "",
			client_secret: cfg().GOOGLE_CLIENT_SECRET ?? "",
			redirect_uri: redirectUri(),
			grant_type: "authorization_code",
		}),
	});
	if (!r.ok) return back("failed");
	const t = (await r.json()) as { refresh_token?: string; id_token?: string };
	if (!t.refresh_token) return back("failed");
	await setSetting("postmaster_refresh_token", t.refresh_token);
	await setSetting("postmaster_account", emailOf(t.id_token) ?? "");
	await setSetting("postmaster_connected_at", iso(now));
	accessToken = null;
	return back("connected");
}

function emailOf(idToken: string | undefined) {
	try {
		const part = idToken?.split(".")[1];
		if (!part) return null;
		const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
		return typeof json.email === "string" ? json.email : null;
	} catch {
		return null;
	}
}

export async function disconnect() {
	await setSetting("postmaster_refresh_token", "");
	await setSetting("postmaster_account", "");
	accessToken = null;
}

export async function connection() {
	const token = await getSetting("postmaster_refresh_token");
	return {
		configured: postmasterConfigured(),
		connected: !!token,
		account: (await getSetting("postmaster_account")) || null,
		connectedAt: token ? await getSetting("postmaster_connected_at") : null,
	};
}

// ── The API ────────────────────────────────────────────────────────────────

let accessToken: { value: string; until: number } | null = null;

async function token(now = Date.now()) {
	if (accessToken && accessToken.until > now + 60_000) return accessToken.value;
	const refresh = await getSetting("postmaster_refresh_token");
	if (!refresh) throw new PostmasterError(401, "Google isn't connected");
	const r = await fetcher(TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: refresh,
			client_id: cfg().GOOGLE_CLIENT_ID ?? "",
			client_secret: cfg().GOOGLE_CLIENT_SECRET ?? "",
			grant_type: "refresh_token",
		}),
	});
	if (!r.ok) throw new PostmasterError(r.status, `Google's token: ${await r.text()}`);
	const t = (await r.json()) as { access_token: string; expires_in?: number };
	accessToken = { value: t.access_token, until: now + (t.expires_in ?? 3600) * 1000 };
	return t.access_token;
}

export class PostmasterError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const r = await fetcher(`${API}/${path}`, {
		method,
		headers: {
			authorization: `Bearer ${await token()}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await r.text();
	if (!r.ok) throw new PostmasterError(r.status, text.slice(0, 300));
	return (text ? JSON.parse(text) : {}) as T;
}

const domainPath = (name: string) => `domains/${encodeURIComponent(name)}`;

type Verification = "UNVERIFIED" | "VERIFIED" | "VERIFICATION_STATE_UNSPECIFIED";

// ── Statistics ─────────────────────────────────────────────────────────────

/** The statistics read, by the names Mailroom gives them. */
const METRICS = [
	{ name: "spam_rate", baseMetric: { standardMetric: "SPAM_RATE" } },
	{
		name: "spf_rate",
		baseMetric: { standardMetric: "AUTH_SUCCESS_RATE" },
		filter: 'auth_type = "spf"',
	},
	{
		name: "dkim_rate",
		baseMetric: { standardMetric: "AUTH_SUCCESS_RATE" },
		filter: 'auth_type = "dkim"',
	},
	{
		name: "dmarc_rate",
		baseMetric: { standardMetric: "AUTH_SUCCESS_RATE" },
		filter: 'auth_type = "dmarc"',
	},
	{
		name: "tls_rate",
		baseMetric: { standardMetric: "TLS_ENCRYPTION_RATE" },
		filter: 'traffic_direction = "inbound"',
	},
	{ name: "delivery_error_rate", baseMetric: { standardMetric: "DELIVERY_ERROR_RATE" } },
] as const;
type MetricName = (typeof METRICS)[number]["name"];

interface StatValue {
	floatValue?: number;
	doubleValue?: number;
	intValue?: string;
}
interface DomainStat {
	metric?: string;
	date?: { year: number; month: number; day: number };
	value?: StatValue;
}

const statValue = (v: StatValue | undefined) => {
	const n = v?.doubleValue ?? v?.floatValue ?? (v?.intValue ? Number(v.intValue) : undefined);
	return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const dateOf = (d: { year: number; month: number; day: number }) =>
	`${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const toDate = (day: string) => {
	const [year, month, d] = day.split("-").map(Number) as [number, number, number];
	return { year, month, day: d };
};

/** One domain's daily statistics over the last DAYS days, by day. */
export async function queryStats(domain: string, now = Date.now()) {
	const days = lastDays(DAYS + 1, now, "UTC");
	const byDay = new Map<string, Partial<Record<MetricName, number | null>>>();
	let pageToken: string | undefined;
	for (let page = 0; page < 10; page++) {
		const r = await call<{ domainStats?: DomainStat[]; nextPageToken?: string }>(
			"POST",
			`${domainPath(domain)}/domainStats:query`,
			{
				metricDefinitions: METRICS,
				timeQuery: {
					dateRanges: {
						dateRanges: [
							{
								start: toDate(days[0] as string),
								end: toDate(days.at(-1) as string),
							},
						],
					},
				},
				aggregationGranularity: "DAILY",
				pageSize: 200,
				...(pageToken ? { pageToken } : {}),
			},
		);
		for (const s of r.domainStats ?? []) {
			if (!s.date || !s.metric) continue;
			const day = dateOf(s.date);
			const row = byDay.get(day) ?? {};
			row[s.metric as MetricName] = statValue(s.value);
			byDay.set(day, row);
		}
		pageToken = r.nextPageToken || undefined;
		if (!pageToken) break;
	}
	return byDay;
}

export interface Compliance {
	/** "COMPLIANT" | "NEEDS_WORK" per requirement (SPF, DKIM, DMARC_POLICY…). */
	requirements: { requirement: string; status: string }[];
	deliverability: { state: string | null; reason: string | null } | null;
	oneClickUnsubscribe: { status: string | null; reason: string | null } | null;
}

export async function complianceOf(domain: string): Promise<Compliance> {
	type Row = { requirement?: string; status?: { status?: string } };
	type Data = {
		rowData?: Row[];
		deliverabilityStatusVerdict?: { state?: { status?: string }; reason?: string };
		oneClickUnsubscribeVerdict?: { status?: { status?: string }; reason?: string };
	};
	const r = await call<{ complianceData?: Data; subdomainComplianceData?: Data }>(
		"GET",
		`${domainPath(domain)}/complianceStatus`,
	);
	const d = r.subdomainComplianceData ?? r.complianceData ?? {};
	return {
		requirements: (d.rowData ?? [])
			.filter((x) => x.requirement)
			.map((x) => ({
				requirement: x.requirement as string,
				status: x.status?.status ?? "STATE_UNSPECIFIED",
			})),
		deliverability: d.deliverabilityStatusVerdict
			? {
					state: d.deliverabilityStatusVerdict.state?.status ?? null,
					reason: d.deliverabilityStatusVerdict.reason ?? null,
				}
			: null,
		oneClickUnsubscribe: d.oneClickUnsubscribeVerdict
			? {
					status: d.oneClickUnsubscribeVerdict.status?.status ?? null,
					reason: d.oneClickUnsubscribeVerdict.reason ?? null,
				}
			: null,
	};
}

// ── The daily run ──────────────────────────────────────────────────────────

/**
 * Every 6 hours: registers new verified sending domains with Google, verifies the ones whose
 * TXT record is in place, and reads verified ones' statistics and compliance.
 */
export async function syncPostmaster(now = Date.now()) {
	if (!postmasterConfigured() || !(await getSetting("postmaster_refresh_token"))) return;
	const d = schema.domains;
	const pm = schema.postmasterDomains;
	const domains = await db
		.select({ id: d.id, name: d.name, organization_id: d.organization_id })
		.from(d)
		.where(and(eq(d.status, "verified"), eq(d.sending, true)));
	if (!domains.length) return;
	const known = new Map(
		(
			await db
				.select()
				.from(pm)
				.where(
					inArray(
						pm.domain_id,
						domains.map((x) => x.id),
					),
				)
		).map((r) => [r.domain_id, r]),
	);
	// What Google already has, verified or not.
	const listed = new Map<string, Verification>();
	try {
		let pageToken = "";
		for (let i = 0; i < 20; i++) {
			const r = await call<{
				domains?: { name: string; verificationState?: Verification }[];
				nextPageToken?: string;
			}>("GET", `domains?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
			for (const x of r.domains ?? [])
				listed.set(
					x.name.replace(/^domains\//, "").toLowerCase(),
					x.verificationState ?? "UNVERIFIED",
				);
			if (!r.nextPageToken) break;
			pageToken = encodeURIComponent(r.nextPageToken);
		}
	} catch (error) {
		console.error("postmaster: list failed", error);
		return;
	}
	for (const domain of domains) {
		try {
			await syncDomain(domain, known.get(domain.id) ?? null, listed.get(domain.name), now);
		} catch (error) {
			console.error("postmaster:", domain.name, error);
			await upsert(domain, { error: String((error as Error).message).slice(0, 300) }, now);
		}
	}
}

type PmRow = typeof schema.postmasterDomains.$inferSelect;

async function upsert(
	domain: { id: string; organization_id: string },
	set: Partial<Omit<PmRow, "domain_id" | "organization_id">>,
	now: number,
) {
	const row = { ...set, checked_at: iso(now) };
	await db
		.insert(schema.postmasterDomains)
		.values({ domain_id: domain.id, organization_id: domain.organization_id, ...row })
		.onConflictDoUpdate({ target: schema.postmasterDomains.domain_id, set: row });
}

async function syncDomain(
	domain: { id: string; name: string; organization_id: string },
	row: PmRow | null,
	state: Verification | undefined,
	now: number,
) {
	if (!state) {
		try {
			await call("POST", "domains", { domainId: domain.name });
		} catch (error) {
			if (!(error instanceof PostmasterError) || error.status !== 409) throw error;
		}
		state = "UNVERIFIED";
	}
	if (state !== "VERIFIED") {
		let token = row?.token ?? null;
		if (!token) {
			const t = await call<{ token?: string }>(
				"GET",
				`${domainPath(domain.name)}/verificationToken?verificationMethod=TXT`,
			);
			token = t.token ?? null;
		}
		// Google answers an error while the record isn't there yet.
		const verified = await call("POST", `${domainPath(domain.name)}:verify`, {
			verificationMethod: "TXT",
		}).then(
			() => true,
			() => false,
		);
		if (!verified) {
			await upsert(domain, { status: "pending", token, error: null }, now);
			return;
		}
	}
	const [stats, compliance] = await Promise.all([
		queryStats(domain.name, now),
		complianceOf(domain.name).catch(() => null),
	]);
	await upsert(domain, { status: "verified", compliance, error: null }, now);
	for (const [day, s] of stats) {
		const values = {
			spam_rate: s.spam_rate ?? null,
			spf_rate: s.spf_rate ?? null,
			dkim_rate: s.dkim_rate ?? null,
			dmarc_rate: s.dmarc_rate ?? null,
			tls_rate: s.tls_rate ?? null,
			delivery_error_rate: s.delivery_error_rate ?? null,
		};
		await db
			.insert(schema.postmasterStats)
			.values({
				domain: domain.name,
				organization_id: domain.organization_id,
				day,
				...values,
			})
			.onConflictDoUpdate({
				target: [schema.postmasterStats.domain, schema.postmasterStats.day],
				set: values,
			});
	}
}

// ── Reading ────────────────────────────────────────────────────────────────

const level = (spam: number | null): "unknown" | "ok" | "warning" | "danger" =>
	spam === null
		? "unknown"
		: spam >= SPAM_RATE.danger
			? "danger"
			: spam >= SPAM_RATE.warning
				? "warning"
				: "ok";

/** The brands' domains with Gmail's latest day and the last days' average, for Insights. */
export async function postmasterView(brandIds: string[], days = 30, now = Date.now()) {
	if (!brandIds.length) return [];
	const d = schema.domains;
	const pm = schema.postmasterDomains;
	const rows = await db
		.select({
			id: d.id,
			name: d.name,
			status: pm.status,
			token: pm.token,
			compliance: pm.compliance,
			error: pm.error,
			checked_at: pm.checked_at,
		})
		.from(d)
		.leftJoin(pm, eq(pm.domain_id, d.id))
		.where(
			and(
				inArray(d.organization_id, brandIds),
				eq(d.status, "verified"),
				eq(d.sending, true),
			),
		);
	if (!rows.length) return [];
	const from = lastDays(days, now)[0] as string;
	const s = schema.postmasterStats;
	const stats = await db
		.select()
		.from(s)
		.where(
			and(
				inArray(
					s.domain,
					rows.map((r) => r.name),
				),
				gte(s.day, from),
			),
		)
		.orderBy(desc(s.day));
	return rows
		.map((r) => {
			const mine = stats.filter((x) => x.domain === r.name);
			const latest = mine.find((x) => x.spam_rate !== null) ?? mine[0] ?? null;
			const avg = (k: "spam_rate" | "dmarc_rate") => {
				const v = mine.map((x) => x[k]).filter((x): x is number => x !== null);
				return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
			};
			const needsWork = (r.compliance?.requirements ?? [])
				.filter((x) => x.status === "NEEDS_WORK")
				.map((x) => x.requirement);
			return {
				id: r.id,
				domain: r.name,
				/** Gmail's bulk-sender requirements not met (SPF, DMARC_POLICY…); null: not read yet. */
				needsWork: r.compliance ? needsWork : null,
				status: (r.status ?? "not_registered") as "not_registered" | "pending" | "verified",
				error: r.error,
				checked_at: r.checked_at,
				latest,
				spamAverage: avg("spam_rate"),
				spam: level(latest?.spam_rate ?? null),
				series: mine
					.slice()
					.reverse()
					.map((x) => ({ day: x.day, spam_rate: x.spam_rate })),
				compliance: r.compliance,
			};
		})
		.sort(
			(a, b) => (b.latest ? 1 : 0) - (a.latest ? 1 : 0) || a.domain.localeCompare(b.domain),
		);
}

/** The TXT records Google verifies domains with, by domain id, while they wait for them. */
export async function postmasterTokens(domainIds: string[]) {
	const out = new Map<string, string>();
	const pm = schema.postmasterDomains;
	for (let i = 0; i < domainIds.length; i += 90) {
		const rows = await db
			.select({ id: pm.domain_id, status: pm.status, token: pm.token })
			.from(pm)
			.where(inArray(pm.domain_id, domainIds.slice(i, i + 90)));
		for (const r of rows) if (r.status === "pending" && r.token) out.set(r.id, r.token);
	}
	return out;
}
