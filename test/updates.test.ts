import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSettingsCache } from "@/server/settings";
import {
	compareVersions,
	highlights,
	latestRelease,
	RUNNING_VERSION,
	versionStatus,
} from "@/server/updates";

const RELEASE = {
	tag_name: "v99.1.0",
	name: "Mailroom 99.1",
	html_url: "https://github.com/RVP97/mailroom/releases/tag/v99.1.0",
	published_at: "2026-11-17T12:00:00Z",
	body: "Some intro.\n\n## What's new\n- **Faster** broadcasts\n* A [new page](https://x.test) for polls\n- `code` here\n- four\n- five\n",
};

function fakeGitHub(answer: () => Response) {
	const calls: string[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		calls.push(url);
		return answer();
	});
	return calls;
}

describe("new versions", () => {
	beforeEach(() => clearSettingsCache());
	afterEach(() => {
		vi.restoreAllMocks();
		(env as { UPDATE_CHECK?: string }).UPDATE_CHECK = undefined;
	});

	it("compares versions by number", () => {
		expect(compareVersions("1.10.0", "1.9.3")).toBe(1);
		expect(compareVersions("v1.0.0", "1.0")).toBe(0);
		expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
		expect(compareVersions("2.0.0-beta.1", "1.9.0")).toBe(1);
	});

	it("takes the release notes' bullet points as plain text", () => {
		expect(highlights(RELEASE.body)).toEqual([
			"Faster broadcasts",
			"A new page for polls",
			"code here",
			"four",
		]);
	});

	it("asks GitHub once a day and says when an update is out", async () => {
		const calls = fakeGitHub(() => Response.json(RELEASE));
		const s = await versionStatus();
		expect(calls).toEqual(["https://api.github.com/repos/RVP97/mailroom/releases/latest"]);
		expect(s.current).toBe(RUNNING_VERSION);
		expect(s.updateAvailable).toBe(true);
		expect(s.latest?.version).toBe("99.1.0");
		expect(s.latest?.highlights[0]).toBe("Faster broadcasts");

		await versionStatus();
		expect(calls).toHaveLength(1);
		// A day later it asks again.
		await latestRelease(new Date(Date.now() + 25 * 3600_000));
		expect(calls).toHaveLength(2);
	});

	it("is quiet when GitHub doesn't answer, keeping what it knew", async () => {
		fakeGitHub(() => Response.json(RELEASE));
		const t0 = new Date("2030-01-01T00:00:00Z");
		await latestRelease(t0);
		clearSettingsCache();
		vi.restoreAllMocks();
		const calls = fakeGitHub(() => new Response("rate limited", { status: 403 }));
		const k = await latestRelease(new Date(t0.getTime() + 25 * 3600_000));
		expect(calls).toHaveLength(1);
		expect(k?.error).toMatch(/403/);
		expect(k?.release?.version).toBe("99.1.0");
		// Not asked again for a few hours after a failure.
		await latestRelease(new Date(t0.getTime() + 27 * 3600_000));
		expect(calls).toHaveLength(1);
	});

	it("no update when the running version is the newest", async () => {
		fakeGitHub(() => Response.json({ ...RELEASE, tag_name: `v${RUNNING_VERSION}` }));
		const s = await versionStatus();
		expect(s.updateAvailable).toBe(false);
	});

	it("UPDATE_CHECK=false never asks GitHub", async () => {
		(env as { UPDATE_CHECK?: string }).UPDATE_CHECK = "false";
		const calls = fakeGitHub(() => Response.json(RELEASE));
		const s = await versionStatus();
		expect(calls).toHaveLength(0);
		expect(s.checking).toBe(false);
		expect(s.updateAvailable).toBe(false);
	});
});
