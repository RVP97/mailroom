import { describe, expect, it } from "vitest";
import { findDmarc } from "@/lib/dmarc";

const dns = (zone: Record<string, string[]>) => async (name: string) => zone[name] ?? [];

describe("findDmarc", () => {
	it("finds a domain's own record and its policy", async () => {
		const d = await findDmarc(
			"mail.acme.com",
			dns({ "_dmarc.mail.acme.com": ["v=DMARC1; p=quarantine; rua=mailto:d@acme.com"] }),
		);
		expect(d).toMatchObject({ found: true, inherited: false, policy: "quarantine" });
	});

	it("falls back to the organizational domain for a subdomain", async () => {
		const d = await findDmarc(
			"news.globex.com",
			dns({ "_dmarc.globex.com": ["v=DMARC1; p=none;"] }),
		);
		expect(d).toMatchObject({
			found: true,
			inherited: true,
			at: "globex.com",
			policy: "none",
		});
	});

	it("knows two-label suffixes like com.mx", async () => {
		const d = await findDmarc(
			"mail.hotel.com.mx",
			dns({ "_dmarc.hotel.com.mx": ["v=DMARC1; p=reject"] }),
		);
		expect(d).toMatchObject({ found: true, at: "hotel.com.mx", policy: "reject" });
	});

	it("ignores other TXT records and flags two DMARC records", async () => {
		expect(
			await findDmarc("acme.com", dns({ "_dmarc.acme.com": ["google-site-verification=x"] })),
		).toMatchObject({ found: false });
		expect(
			await findDmarc(
				"acme.com",
				dns({ "_dmarc.acme.com": ["v=DMARC1; p=none", "v=DMARC1; p=reject"] }),
			),
		).toMatchObject({ found: true, duplicate: true });
	});
});
