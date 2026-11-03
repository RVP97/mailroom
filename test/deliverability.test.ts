import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { checkContent } from "@/lib/content-check";
import { db, schema } from "@/server/db";
import { blocklists, checkDomainHealth } from "@/server/deliverability";
import { seedOrg } from "./helpers";

type Answers = Record<string, string[]>;

/** DNS over HTTPS answering from a table ("name TYPE" → data). */
const dns =
	(answers: Answers, failing: string[] = []): typeof fetch =>
	async (input) => {
		const url = new URL(String(input));
		const name = url.searchParams.get("name") ?? "";
		const type = url.searchParams.get("type") ?? "";
		if (failing.includes(name)) return new Response("", { status: 500 });
		const code = { A: 1, CNAME: 5, MX: 15, TXT: 16 }[type] ?? 0;
		const data = answers[`${name} ${type}`] ?? [];
		return Response.json({
			Status: data.length ? 0 : 3,
			Answer: data.map((d) => ({ type: code, data: d })),
		});
	};

describe("deliverability watch", () => {
	it("finds DNS records that drifted, and remembers what it alerted", async () => {
		const org = await seedOrg();
		const d = await db
			.update(schema.domains)
			.set({ mail_from: `mail.${org.domain}` })
			.where(eq(schema.domains.id, org.domainId))
			.returning()
			.then((r) => r[0] as typeof schema.domains.$inferSelect);
		const good: Answers = {
			[`a._domainkey.${org.domain} CNAME`]: ["a.dkim.amazonses.com."],
			[`b._domainkey.${org.domain} CNAME`]: ["b.dkim.amazonses.com."],
			[`c._domainkey.${org.domain} CNAME`]: ["c.dkim.amazonses.com."],
			[`mail.${org.domain} MX`]: ["10 feedback-smtp.us-east-1.amazonses.com."],
			[`mail.${org.domain} TXT`]: ['"v=spf1 include:amazonses.com ~all"'],
			[`_dmarc.${org.domain} TXT`]: ['"v=DMARC1; p=none;"'],
		};
		const ok = await checkDomainHealth(d, { fetcher: dns(good) });
		expect(ok.problems).toEqual([]);
		expect(ok.alerted).toBeNull();

		const drifted = { ...good, [`b._domainkey.${org.domain} CNAME`]: [] };
		delete drifted[`_dmarc.${org.domain} TXT`];
		const bad = await checkDomainHealth(d, { fetcher: dns(drifted) });
		expect(bad.problems.map((p) => [p.record, p.level])).toEqual([
			["DKIM", "error"],
			["DMARC", "warning"],
		]);
		expect(bad.alerted).toBe(`DKIM:b._domainkey.${org.domain}`);

		// A lookup that fails says nothing (not "missing").
		const unsure = await checkDomainHealth(d, {
			fetcher: dns(good, [`a._domainkey.${org.domain}`]),
		});
		expect(unsure.problems).toEqual([]);
	});

	it("reads blocklists, and a refused public resolver as unknown", async () => {
		expect(
			await blocklists(
				"spam.test",
				dns({
					"spam.test.dbl.spamhaus.org A": ["127.0.1.2"],
					"spam.test.multi.surbl.org A": ["127.0.0.1"],
				}),
			),
		).toEqual([
			{ list: "Spamhaus DBL", status: "listed", detail: "127.0.1.2" },
			{ list: "SURBL", status: "unknown" },
		]);
		expect(
			await blocklists("ok.test", dns({ "ok.test.dbl.spamhaus.org A": ["127.255.255.254"] })),
		).toEqual([
			{ list: "Spamhaus DBL", status: "unknown" },
			{ list: "SURBL", status: "clean" },
		]);
	});
});

describe("content check", () => {
	it("flags what inboxes hold against an email", () => {
		const codes = (c: Parameters<typeof checkContent>[0]) => checkContent(c).map((f) => f.code);
		expect(
			codes({ subject: "Your booking for Friday", html: "<p>See you soon, Ana.</p>" }),
		).toEqual([]);
		expect(
			codes({
				subject: "FREE ROOMS TODAY!!",
				html: `<img src="https://x.test/a.png"><a href="https://bit.ly/x">Click here</a>${"x".repeat(110 * 1024)}`,
				marketing: true,
			}),
		).toEqual([
			"caps_subject",
			"loud_subject",
			"spammy_words",
			"gmail_clip",
			"img_alt",
			"shortener",
			"no_unsubscribe_link",
		]);
		expect(codes({ subject: "Hi", html: "<img src='a.png' alt='Offer'>" })).toContain(
			"image_only",
		);
	});
});
