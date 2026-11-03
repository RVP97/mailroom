import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, schema } from "@/server/db";
import {
	orgLogoImage,
	orgLogos,
	setOrgLogo,
	setOrgLogoBackground,
	svgDataUrl,
	unsafeSvg,
} from "@/server/org-logos";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

// A 1×1 PNG.
const PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function brandOf(parent: string, domain: string, logo: boolean) {
	const id = `org_${uid()}`;
	await db
		.insert(schema.organization)
		.values({ id, name: `Brand ${id}`, slug: id.replace(/_/g, "-"), createdAt: new Date() });
	await db.insert(schema.brands).values({ id, parent_id: parent, created_at: iso() });
	await db.insert(schema.domains).values({
		id: `dom_${uid()}`,
		organization_id: id,
		name: domain,
		status: "verified",
		dkim_tokens: ["a", "b", "c"],
		region: "us-east-1",
		created_at: iso(),
		bimi_logo: logo ? "<svg/>" : null,
		bimi_updated_at: logo ? iso() : null,
	});
	return id;
}

describe("organization logos", () => {
	it("saves, serves and removes an uploaded logo", async () => {
		const org = await seedOrg();
		const url = await setOrgLogo(org.id, PNG);
		expect(url).toMatch(new RegExp(`^/logos/${org.id}\\?v=`));
		const image = await orgLogoImage(org.id);
		expect(image?.type).toBe("image/png");
		expect(image?.bytes[1]).toBe(0x50);
		expect((await orgLogos([org.id])).get(org.id)).toMatchObject({ source: "own", url });
		await setOrgLogo(org.id, null);
		expect(await orgLogoImage(org.id)).toBeNull();
		expect((await orgLogos([org.id])).get(org.id)).toBeUndefined();
	});

	it("refuses what isn't a small PNG, JPEG, WebP or SVG", async () => {
		const org = await seedOrg();
		await expect(setOrgLogo(org.id, "data:image/gif;base64,R0lGODlh")).rejects.toThrow();
		// Says PNG, is JPEG bytes.
		await expect(setOrgLogo(org.id, "data:image/png;base64,/9j/4AAQ")).rejects.toThrow();
		const big = `data:image/png;base64,${btoa(`\x89PNG${"x".repeat(210 * 1024)}`)}`;
		await expect(setOrgLogo(org.id, big)).rejects.toThrow(/200 KB/);
	});

	it("falls back to a domain's BIMI logo: the organization's own domains first", async () => {
		const org = await seedOrg();
		await brandOf(org.id, `b-${uid()}.test`, true);
		const brandOnly = (await orgLogos([org.id])).get(org.id);
		expect(brandOnly?.source).toBe("bimi");
		await db.update(schema.domains).set({ bimi_logo: "<svg/>", bimi_updated_at: iso() });
		const both = (await orgLogos([org.id])).get(org.id);
		expect(both).toMatchObject({ source: "bimi", domain: org.domain });
		expect(both?.url).toMatch(new RegExp(`^/bimi/${org.domain}\\.svg\\?v=`));

		// An uploaded logo wins, and the domain's is kept for when it's removed.
		await setOrgLogo(org.id, PNG);
		const own = (await orgLogos([org.id])).get(org.id);
		expect(own?.source).toBe("own");
		expect(own?.fallback?.domain).toBe(org.domain);
	});

	it("handles many organizations with many brands in one query set", async () => {
		const orgs = await Promise.all(Array.from({ length: 30 }, () => seedOrg()));
		for (const o of orgs.slice(0, 10)) await brandOf(o.id, `m-${uid()}.test`, true);
		const logos = await orgLogos(orgs.map((o) => o.id));
		for (const o of orgs.slice(0, 10)) expect(logos.get(o.id)?.source).toBe("bimi");
	});

	it("keeps a background for the uploaded logo or the domain's", async () => {
		const org = await seedOrg();
		await db
			.update(schema.domains)
			.set({ bimi_logo: "<svg/>", bimi_updated_at: iso() })
			.where(eq(schema.domains.id, org.domainId));
		expect(await setOrgLogoBackground(org.id, "#ABC")).toBe("#aabbcc");
		expect((await orgLogos([org.id])).get(org.id)).toMatchObject({
			source: "bimi",
			background: "#aabbcc",
		});
		await setOrgLogo(org.id, PNG);
		expect((await orgLogos([org.id])).get(org.id)).toMatchObject({
			source: "own",
			background: "#aabbcc",
		});
		// Removing the upload keeps the background for the domain's logo.
		await setOrgLogo(org.id, null);
		expect(await orgLogoImage(org.id)).toBeNull();
		expect((await orgLogos([org.id])).get(org.id)?.background).toBe("#aabbcc");
		await setOrgLogoBackground(org.id, null);
		const rows = await db
			.select()
			.from(schema.orgLogos)
			.where(eq(schema.orgLogos.organization_id, org.id));
		expect(rows).toHaveLength(0);
		await expect(setOrgLogoBackground(org.id, "red; x")).rejects.toThrow();
	});

	it("keeps a clean SVG as it is and refuses one that runs or reaches out", async () => {
		const org = await seedOrg();
		const svg =
			'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="20mm" viewBox="0 0 50 20"><style><![CDATA[.f{fill:#c9a227}]]></style><path class="f" d="M0 0h50v20z"/><use href="#x"/></svg>';
		await setOrgLogo(org.id, svgDataUrl(svg));
		const image = await orgLogoImage(org.id);
		expect(image?.type).toBe("image/svg+xml");
		expect(new TextDecoder().decode(image?.bytes)).toBe(svg);
		for (const bad of [
			"<svg><script>alert(1)</script></svg>",
			'<svg onload="x()"></svg>',
			'<svg><image href="https://evil.test/a.png"/></svg>',
			'<svg><rect style="fill:url(https://evil.test/a)"/></svg>',
			"<svg><foreignObject><div/></foreignObject></svg>",
			"<png/>",
		]) {
			expect(unsafeSvg(bad)).not.toBeNull();
			await expect(setOrgLogo(org.id, svgDataUrl(bad))).rejects.toThrow();
		}
		// A big logo with accents (UTF-8) round-trips.
		const big = `<svg viewBox="0 0 1 1"><title>Harbor ñ</title>${'<path d="M0 0"/>'.repeat(6000)}</svg>`;
		await setOrgLogo(org.id, svgDataUrl(big));
		expect(new TextDecoder().decode((await orgLogoImage(org.id))?.bytes)).toBe(big);
	});
});
