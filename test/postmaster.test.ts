import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import {
	connectUrl,
	handleCallback,
	postmasterTokens,
	postmasterView,
	setPostmasterFetcher,
	syncPostmaster,
} from "@/server/postmaster";
import { clearSettingsCache, getSetting, setSetting } from "@/server/settings";
import { seedOrg } from "./helpers";

const NOW = Date.parse("2027-03-10T12:00:00.000Z");

/** A fake Google: tokens, the domains list, verification, statistics and compliance. */
function fakeGoogle(o: { verified: Set<string>; dnsReady: Set<string> }) {
	const calls: string[] = [];
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	setPostmasterFetcher((async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		calls.push(`${method} ${url.pathname}`);
		if (url.hostname === "oauth2.googleapis.com") {
			const body = new URLSearchParams(String(init?.body));
			if (body.get("grant_type") === "authorization_code")
				return json({
					refresh_token: "refresh-1",
					id_token: `x.${btoa(JSON.stringify({ email: "owner@example.com" }))}.y`,
				});
			return json({ access_token: "access-1", expires_in: 3600 });
		}
		const path = decodeURIComponent(url.pathname.replace(/^\/v2\//, ""));
		if (method === "GET" && path === "domains")
			return json({
				domains: [...o.verified].map((d) => ({
					name: `domains/${d}`,
					verificationState: "VERIFIED",
				})),
			});
		if (method === "POST" && path === "domains") return json({});
		const name = /^domains\/([^/:]+)/.exec(path)?.[1] ?? "";
		if (path.endsWith("/verificationToken"))
			return json({ token: `google-site-verification=${name}` });
		if (path.endsWith(":verify")) {
			if (!o.dnsReady.has(name)) return json({ error: "not found" }, 400);
			o.verified.add(name);
			return json({});
		}
		if (path.endsWith("/domainStats:query"))
			return json({
				domainStats: [
					{
						metric: "spam_rate",
						date: { year: 2027, month: 3, day: 8 },
						value: { doubleValue: 0.004 },
					},
					{
						metric: "dmarc_rate",
						date: { year: 2027, month: 3, day: 8 },
						value: { doubleValue: 1 },
					},
				],
			});
		if (path.endsWith("/complianceStatus"))
			return json({
				complianceData: {
					rowData: [
						{ requirement: "SPF", status: { status: "COMPLIANT" } },
						{ requirement: "ONE_CLICK_UNSUBSCRIBE", status: { status: "NEEDS_WORK" } },
					],
				},
			});
		return json({ error: "unexpected" }, 404);
	}) as typeof fetch);
	return calls;
}

afterEach(() => setPostmasterFetcher(undefined));

describe("Gmail Postmaster Tools", () => {
	it("connects with a signed state and keeps the refresh token", async () => {
		fakeGoogle({ verified: new Set(), dnsReady: new Set() });
		const url = new URL(await connectUrl(NOW));
		expect(url.searchParams.get("scope")).toContain("postmaster");
		const state = url.searchParams.get("state") ?? "";
		const bad = await handleCallback(
			new Request("https://mailroom.test/postmaster/callback?code=c&state=1.forged"),
			NOW,
		);
		expect(bad.headers.get("location")).toContain("postmaster=failed");
		const ok = await handleCallback(
			new Request(`https://mailroom.test/postmaster/callback?code=c&state=${state}`),
			NOW,
		);
		expect(ok.headers.get("location")).toContain("postmaster=connected");
		clearSettingsCache();
		expect(await getSetting("postmaster_refresh_token")).toBe("refresh-1");
		expect(await getSetting("postmaster_account")).toBe("owner@example.com");
	});

	it("registers a domain, shows its TXT record, verifies it, then reads Gmail's numbers", async () => {
		await setSetting("postmaster_refresh_token", "refresh-1");
		const org = await seedOrg();
		const google = { verified: new Set<string>(), dnsReady: new Set<string>() };
		const calls = fakeGoogle(google);
		await syncPostmaster(NOW);
		expect(calls).toContain("POST /v2/domains");
		const tokens = await postmasterTokens([org.domainId]);
		expect(tokens.get(org.domainId)).toBe(`google-site-verification=${org.domain}`);

		google.dnsReady.add(org.domain);
		await syncPostmaster(NOW);
		expect((await postmasterTokens([org.domainId])).size).toBe(0);
		const [view] = await postmasterView([org.id], 30, NOW);
		expect(view).toMatchObject({ domain: org.domain, status: "verified", spam: "danger" });
		expect(view?.latest?.spam_rate).toBeCloseTo(0.004);
		expect(view?.needsWork).toEqual(["ONE_CLICK_UNSUBSCRIBE"]);
		const stats = await db
			.select()
			.from(schema.postmasterStats)
			.where(eq(schema.postmasterStats.domain, org.domain));
		expect(stats).toHaveLength(1);
	});
});
