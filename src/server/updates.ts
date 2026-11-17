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

/** GitHub's latest (published, not draft or pre-release) release of the upstream repo. */
async function askGitHub(): Promise<LatestRelease | null> {
	const res = await fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "mailroom-update-check",
			"x-github-api-version": "2022-11-28",
		},
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const r = (await res.json()) as {
		tag_name: string;
		name?: string | null;
		html_url: string;
		published_at?: string | null;
		body?: string | null;
	};
	return {
		version: r.tag_name.replace(/^v/i, ""),
		tag: r.tag_name,
		name: r.name || r.tag_name,
		url: r.html_url,
		publishedAt: r.published_at ?? "",
		highlights: highlights(r.body ?? ""),
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
		next = { release: await askGitHub(), checkedAt: now.toISOString() };
	} catch (error) {
		// Keep what we knew; try again in a few hours.
		next = {
			release: before?.release ?? null,
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
	return {
		current: RUNNING_VERSION,
		commit: typeof __SENTRY_RELEASE__ === "string" ? __SENTRY_RELEASE__ : "",
		repoUrl: REPO_URL,
		upgradeUrl: UPGRADE_URL,
		checking,
		latest,
		updateAvailable: !!latest && compareVersions(latest.version, RUNNING_VERSION) > 0,
		checkedAt: k?.checkedAt ?? null,
	};
}
