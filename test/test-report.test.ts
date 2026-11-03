import { describe, expect, it } from "vitest";
import { dkimDomains, orgDomain, testReport } from "@/server/test-report";

const dns = (records: Record<string, string[]>) =>
	(async (url: string | URL | Request) => {
		const name = new URL(String(url)).searchParams.get("name") ?? "";
		return Response.json({
			Status: 0,
			Answer: (records[name] ?? []).map((data) => ({ type: 16, data: `"${data}"` })),
		});
	}) as typeof fetch;

const headers = (h: Record<string, string>) =>
	Object.entries(h).map(([key, value]) => ({ key, value }));

describe("deliverability report", () => {
	it("passes a well-set-up email", async () => {
		const r = await testReport(
			{
				from: "Acme <hola@mail.acme.com.mx>",
				subject: "Your receipt",
				verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "PASS" },
				parsed: {
					headers: headers({
						"return-path": "<0100abc@bounce.acme.com.mx>",
						"dkim-signature": "v=1; a=rsa-sha256; d=acme.com.mx; s=abc; h=from",
						"message-id": "<0100abc@email.amazonses.com>",
						"list-unsubscribe": "<https://x/u>",
						"list-unsubscribe-post": "List-Unsubscribe=One-Click",
					}),
					html: '<p>Thanks for your order. Your receipt for the two nights at the hotel is below, with the total and how you paid.</p><a href="https://acme.com.mx/r">See it</a><img src="https://x/y.png" alt="Logo">',
					text: "Thanks",
				},
			},
			dns({ "_dmarc.acme.com.mx": ["v=DMARC1; p=quarantine"] }),
		);
		expect(r.checks.filter((c) => c.status === "fail" || c.status === "warn")).toEqual([]);
		expect(r.score).toBe(10);
	});

	it("flags missing DMARC, foreign signatures, http links and images without alt", async () => {
		const r = await testReport(
			{
				from: "x@shop.test",
				subject: "Hi",
				verdicts: { spam: "PASS", virus: "PASS", spf: "PASS", dkim: "PASS", dmarc: "GRAY" },
				parsed: {
					headers: headers({
						"return-path": "<a@amazonses.com>",
						"dkim-signature": "v=1; d=amazonses.com; s=x",
					}),
					html: '<a href="http://shop.test">x</a><img src="a.png">',
					text: "",
				},
			},
			dns({}),
		);
		const bad = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
		expect(bad).toMatchObject({
			dmarc: "fail",
			dkim: "warn",
			spf_alignment: "warn",
			links: "warn",
			alt: "warn",
			text_part: "warn",
			message_id: "fail",
		});
		expect(r.score).toBeLessThan(6);
	});

	it("reads DKIM domains and registrable domains", () => {
		expect(orgDomain("mail.acme.com.mx")).toBe("acme.com.mx");
		expect(orgDomain("news.acme.com")).toBe("acme.com");
		expect(
			dkimDomains({
				headers: headers({ "dkim-signature": "v=1; d=Acme.com; s=a" }),
				html: "",
				text: "",
			}),
		).toEqual(["acme.com"]);
	});
});
