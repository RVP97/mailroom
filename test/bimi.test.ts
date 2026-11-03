import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { dmarcEnforces, findBimi, prepareBimiSvg } from "@/lib/bimi";
import { findDmarc } from "@/lib/dmarc";
import { db, schema } from "@/server/db";
import { bimiLogo, dnsRecords, setBimiLogo } from "@/server/provision";
import { seedOrg } from "./helpers";

const dns = (zone: Record<string, string[]>) => async (name: string) => zone[name] ?? [];

const LOGO = `<?xml version="1.0" encoding="UTF-8"?>
<!-- exported -->
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" x="0" y="0" viewBox="0 0 64 64"><metadata>junk</metadata><rect width="64" height="64" fill="#0D2B29"/><path d="M13 37L23 48" stroke="#F6C945"/></svg>`;

describe("prepareBimiSvg", () => {
	it("makes an ordinary square SVG Tiny PS, with a title", () => {
		const r = prepareBimiSvg(LOGO, "Globex");
		if ("error" in r) throw new Error(r.error);
		expect(r.svg).toMatch(
			/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" version="1.2" baseProfile="tiny-ps" viewBox="0 0 64 64"><title>Globex<\/title>/,
		);
		expect(r.svg).not.toMatch(/<\?xml|<!--|metadata| x=| width="64" height="64" x/);
		expect(r.svg).toContain('<rect width="64" height="64" fill="#0D2B29"/>');
	});

	it("keeps a title it already has", () => {
		const r = prepareBimiSvg(
			'<svg viewBox="0 0 10 10"><title>Acme</title><circle r="4"/></svg>',
			"Other",
		);
		expect("svg" in r && r.svg.match(/<title>/g)?.length).toBe(1);
		expect("svg" in r && r.svg).toContain("<title>Acme</title>");
	});

	it("refuses what BIMI can't take", () => {
		const refused = (svg: string) => "error" in prepareBimiSvg(svg, "X");
		expect(refused("<png/>")).toBe(true);
		expect(refused('<svg viewBox="0 0 20 10"><rect/></svg>')).toBe(true);
		expect(refused("<svg><rect/></svg>")).toBe(true);
		expect(refused('<svg viewBox="0 0 9 9"><script>x()</script></svg>')).toBe(true);
		expect(refused('<svg viewBox="0 0 9 9"><image href="a.png"/></svg>')).toBe(true);
		expect(refused('<svg viewBox="0 0 9 9"><use href="https://x.test/a.svg#b"/></svg>')).toBe(
			true,
		);
		expect(refused(`<svg viewBox="0 0 9 9"><path d="${"M1 1".repeat(9000)}"/></svg>`)).toBe(
			true,
		);
		expect(refused('<svg viewBox="0 0 9 9"><use href="#a"/></svg>')).toBe(false);
	});
});

describe("findBimi and dmarcEnforces", () => {
	it("finds a domain's record, or its organizational domain's", async () => {
		const own = await findBimi(
			"news.globex.com",
			dns({
				"default._bimi.news.globex.com": [
					"v=BIMI1; l=https://m.test/bimi/news.globex.com.svg; a=https://m.test/vmc.pem",
				],
			}),
		);
		expect(own).toMatchObject({
			found: true,
			at: "news.globex.com",
			logo: "https://m.test/bimi/news.globex.com.svg",
			certificate: "https://m.test/vmc.pem",
		});
		const parent = await findBimi(
			"mail.hotel.com.mx",
			dns({ "default._bimi.hotel.com.mx": ["v=BIMI1; l=https://h.test/l.svg;"] }),
		);
		expect(parent).toMatchObject({ found: true, at: "hotel.com.mx", certificate: null });
		expect(await findBimi("acme.com", dns({}))).toMatchObject({ found: false });
	});

	it("only counts DMARC that enforces on all mail", async () => {
		const at = async (zone: Record<string, string[]>, name = "acme.com") =>
			dmarcEnforces(await findDmarc(name, dns(zone)));
		expect(await at({ "_dmarc.acme.com": ["v=DMARC1; p=none"] })).toBe(false);
		expect(await at({ "_dmarc.acme.com": ["v=DMARC1; p=quarantine"] })).toBe(true);
		expect(await at({ "_dmarc.acme.com": ["v=DMARC1; p=reject; pct=50"] })).toBe(false);
		expect(
			await at({ "_dmarc.acme.com": ["v=DMARC1; p=quarantine; sp=none"] }, "m.acme.com"),
		).toBe(false);
		expect(
			await at({ "_dmarc.acme.com": ["v=DMARC1; p=quarantine; pct=100"] }, "m.acme.com"),
		).toBe(true);
	});
});

describe("a domain's logo", () => {
	it("is stored as Tiny PS, served by name, and adds the BIMI record and a DMARC that enforces", async () => {
		const org = await seedOrg();
		await setBimiLogo(org.id, org.domainId, LOGO);
		const svg = await bimiLogo(org.domain);
		expect(svg).toContain('baseProfile="tiny-ps"');
		expect(svg).toContain(`<title>Org ${org.id}</title>`);
		const row = await db
			.select()
			.from(schema.domains)
			.where(eq(schema.domains.id, org.domainId))
			.get();
		const records = dnsRecords(row as NonNullable<typeof row>);
		expect(records.find((r) => r.record === "DMARC")?.value).toBe(
			'"v=DMARC1; p=quarantine; rua=mailto:dmarc@mailroom.test;"',
		);
		expect(records.find((r) => r.record === "BIMI")).toMatchObject({
			type: "TXT",
			name: `default._bimi.${org.domain}`,
			value: expect.stringMatching(new RegExp(`^"v=BIMI1; l=.*/bimi/${org.domain}\\.svg;"$`)),
		});

		await expect(setBimiLogo(org.id, org.domainId, "<svg><rect/></svg>")).rejects.toThrow(
			/viewBox/,
		);
		await expect(setBimiLogo((await seedOrg()).id, org.domainId, LOGO)).rejects.toThrow(
			/not found/i,
		);
		await setBimiLogo(org.id, org.domainId, null);
		expect(await bimiLogo(org.domain)).toBeNull();
	});
});
