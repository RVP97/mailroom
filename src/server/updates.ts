import { REPO_URL, UPGRADE_URL, UPSTREAM_REPO, VERSION } from "@/lib/version";
import { cfg } from "./env";
import { getSetting, setSetting } from "./settings";

/**
 * New versions of Mailroom. The running version is package.json's (built into the Worker); the
 * newest is the latest GitHub release of the upstream repo, asked for at most once a day by the
 * Worker itself (never by each visitor's browser) and kept in app_settings. GitHub not answering
 * (offline, rate limited) is quiet: the last answer stays, and it's asked again a few hours later.
 * UPDATE_CHECK=false turns the check off.
 */

export const RUNNING_VERSION = VERSION;

const REFRESH_MS = 24 * 3600_000;
const FAILED_MS = 6 * 3600_000;
const TIMEOUT_MS = 5_000;

export interface LatestRelease {
	/** "1.2.0" (the tag without its "v"). */
	version: string;
	tag: string;
	name: string;
	url: string;
	publishedAt: string;
	/** The release notes' first few bullet points, as plain text. */
	highlights: string[];
}

interface Kept {
	release: LatestRelease | null;
	/** Versions whose release fixes a security problem. */
	securityVersions?: string[];
	checkedAt: string;
	error?: string;
}

export interface VersionStatus {
	current: string;
	/** The commit this build is from (Workers Builds' or git's), or "". */
	commit: string;
	repoUrl: string;
	upgradeUrl: string;
	/** False with UPDATE_CHECK=false: nothing is asked of GitHub. */
	checking: boolean;
	latest: LatestRelease | null;
	updateAvailable: boolean;
	/** A release newer than this one fixes a security problem: update soon. */
	securityUpdate: boolean;
	checkedAt: string | null;
}

export const updateCheckOn = () => cfg().UPDATE_CHECK !== "false";

/** -1, 0 or 1, comparing "1.2.3"-style versions by number (a leading "v" and any "-beta" ignored). */
export function compareVersions(a: string, b: string): number {
	const parts = (v: string) =>
		v
			.trim()
			.replace(/^v/i, "")
			.replace(/[-+].*$/, "")
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d) return d > 0 ? 1 : -1;
	}
	return 0;
}

/** The release notes' bullet points ("- …" or "* …"), without Markdown, at most `max`. */
export function highlights(body: string, max = 4): string[] {
	return body
		.split("\n")
		.map((l) => l.match(/^\s*[-*]\s+(.+)/)?.[1])
		.filter((l): l is string => !!l)
		.map((l) =>
			l
				.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
				.replace(/[*_`]/g, "")
				.trim(),
		)
		.filter(Boolean)
		.slice(0, max);
}

async function kept(): Promise<Kept | null> {
	const raw = await getSetting("latest_release");
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Kept;
	} catch {
		return null;
	}
}

/** A release that fixes a security problem: "security" in its title or tag. */
export const isSecurityRelease = (r: { name?: string | null; tag_name: string }) =>
	/\bsecurity\b/i.test(`${r.name ?? ""} ${r.tag_name}`);

/**
 * The upstream repo's recent published releases (not drafts or pre-releases): the newest, and
 * the versions that fix a security problem (so a deployment several versions behind hears about
 * a security fix even when the newest release isn't one).
 */
async function askGitHub(): Promise<Pick<Kept, "release" | "securityVersions">> {
	const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=30`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "mailroom-update-check",
			"x-github-api-version": "2022-11-28",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const all = (await res.json()) as {
		tag_name: string;
		name?: string | null;
		html_url: string;
		published_at?: string | null;
		body?: string | null;
		draft?: boolean;
		prerelease?: boolean;
	}[];
	const published = all.filter((r) => !r.draft && !r.prerelease);
	const r = published.reduce<(typeof published)[number] | null>(
		(best, x) => (!best || compareVersions(x.tag_name, best.tag_name) > 0 ? x : best),
		null,
	);
	return {
		release: r && {
			version: r.tag_name.replace(/^v/i, ""),
			tag: r.tag_name,
			name: r.name || r.tag_name,
			url: r.html_url,
			publishedAt: r.published_at ?? "",
			highlights: highlights(r.body ?? ""),
		},
		securityVersions: published
			.filter(isSecurityRelease)
			.map((x) => x.tag_name.replace(/^v/i, "")),
	};
}

/** The newest release: what's kept while it's fresh, else GitHub's answer (kept for next time). */
export async function latestRelease(now = new Date()): Promise<Kept | null> {
	if (!updateCheckOn()) return null;
	const before = await kept();
	if (before) {
		const age = now.getTime() - Date.parse(before.checkedAt);
		if (age >= 0 && age < (before.error ? FAILED_MS : REFRESH_MS)) return before;
	}
	let next: Kept;
	try {
		next = { ...(await askGitHub()), checkedAt: now.toISOString() };
	} catch (error) {
		// Keep what we knew; try again in a few hours.
		next = {
			release: before?.release ?? null,
			securityVersions: before?.securityVersions,
			checkedAt: now.toISOString(),
			error: error instanceof Error ? error.message : String(error),
		};
	}
	await setSetting("latest_release", JSON.stringify(next)).catch(() => {});
	return next;
}

export async function versionStatus(): Promise<VersionStatus> {
	const checking = updateCheckOn();
	const k = checking ? await latestRelease().catch(() => null) : null;
	const latest = k?.release ?? null;
	const updateAvailable = !!latest && compareVersions(latest.version, RUNNING_VERSION) > 0;
	return {
		current: RUNNING_VERSION,
		commit: typeof __SENTRY_RELEASE__ === "string" ? __SENTRY_RELEASE__ : "",
		repoUrl: REPO_URL,
		upgradeUrl: UPGRADE_URL,
		checking,
		latest,
		updateAvailable,
		securityUpdate:
			updateAvailable &&
			(k?.securityVersions ?? []).some((v) => compareVersions(v, RUNNING_VERSION) > 0),
		checkedAt: k?.checkedAt ?? null,
	};
}

/**
 * Cron (hourly; GitHub is still asked at most once a day): when a newer release fixes a security
 * problem, email the deployment's admins once per newest version.
 */
export async function alertSecurityUpdate() {
	const s = await versionStatus();
	if (!s.securityUpdate || !s.latest) return;
	if ((await getSetting("security_update_emailed")) === s.latest.version) return;
	const { adminEmails } = await import("./env");
	const { sendSystemEmail, systemLayout } = await import("./system-email");
	const { html, text } = systemLayout({
		title: `Update Mailroom: ${s.latest.version} fixes a security problem`,
		lines: [
			`This deployment runs Mailroom ${s.current}. A newer release fixes a security problem, so please update soon.`,
			'If your repo has the Mailroom update action, merge its "Update Mailroom" pull request; the release notes say if anything else is needed.',
		],
		button: { label: "What's in the release", url: s.latest.url },
	});
	for (const to of adminEmails())
		await sendSystemEmail({
			to,
			subject: `Security update: Mailroom ${s.latest.version}`,
			html,
			text,
		}).catch((error) => console.error("updates: security email failed", error));
	await setSetting("security_update_emailed", s.latest.version);
}
