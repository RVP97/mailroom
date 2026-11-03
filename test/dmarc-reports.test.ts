import { gzipSync, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sendsReportsHere, withReportsAddress } from "@/server/dmarc-address";
import { dmarcSummary, reportsInEmail, storeReport } from "@/server/dmarc-reports";
import { seedOrg, uid } from "./helpers";

type Row = { ip: string; count: number; dkim: string; spf: string; signer: string; from?: string };

/** A provider's aggregate report, as Google writes them. */
function reportXml(domain: string, id: string, rows: Row[], begin = 1_793_404_800) {
	const records = rows
		.map(
			(r) =>
				`<record><row><source_ip>${r.ip}</source_ip><count>${r.count}</count><policy_evaluated><disposition>none</disposition><dkim>${r.dkim}</dkim><spf>${r.spf}</spf></policy_evaluated></row><identifiers><header_from>${r.from ?? domain}</header_from></identifiers><auth_results><dkim><domain>${r.signer}</domain><result>${r.dkim}</result></dkim><spf><domain>bounce.${domain}</domain><result>${r.spf}</result></spf></auth_results></record>`,
		)
		.join("");
	return `<?xml version="1.0" encoding="UTF-8" ?><feedback><report_metadata><org_name>google.com</org_name><email>noreply-dmarc-support@google.com</email><report_id>${id}</report_id><date_range><begin>${begin}</begin><end>${begin + 86_399}</end></date_range></report_metadata><policy_published><domain>${domain}</domain><adkim>r</adkim><aspf>r</aspf><p>none</p></policy_published>${records}</feedback>`;
}

/** The report attached to an email, base64 like providers send it. */
function email(name: string, type: string, bytes: Uint8Array) {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return [
		"From: noreply-dmarc-support@google.com",
		"To: dmarc@mailroom.test",
		`Subject: Report domain: x Submitter: google.com Report-ID: ${uid()}`,
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"This is an aggregate report.",
		"--b",
		`Content-Type: ${type}; name="${name}"`,
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: attachment; filename="${name}"`,
		"",
		btoa(bin).replace(/.{76}/g, "$&\r\n"),
		"--b--",
		"",
	].join("\r\n");
}

/** The one report an email held. */
function first<T>(list: T[]): T {
	const [one] = list;
	if (!one) throw new Error("no report found");
	return one;
}

describe("DMARC reports", () => {
	it("reads gzipped and zipped reports and keeps only domains Mailroom sends from", async () => {
		const { domain } = await seedOrg();
		const now = Date.parse("2026-10-30T12:00:00Z");
		const begin = Math.floor(now / 1000) - 2 * 86_400;
		// 150 sources: more than one insert's worth, and the scale real reports reach.
		const rows: Row[] = Array.from({ length: 150 }, (_, i) => ({
			ip: `54.240.0.${i}`,
			count: 10,
			dkim: "pass",
			spf: "pass",
			signer: domain,
		}));
		rows.push({ ip: "203.0.113.9", count: 7, dkim: "fail", spf: "fail", signer: "brevo.com" });
		const xml = reportXml(domain, "r-1", rows, begin);

		const gz = await reportsInEmail(
			email("google.com!x!1!2.xml.gz", "application/gzip", gzipSync(strToU8(xml))),
		);
		expect(gz).toHaveLength(1);
		expect(gz[0]?.rows).toHaveLength(151);
		expect(await storeReport(first(gz), now)).toBe(true);
		// The provider sending it again changes nothing.
		expect(await storeReport(first(gz), now)).toBe(false);

		const zip = await reportsInEmail(
			email(
				"report.zip",
				"application/zip",
				zipSync({ "r.xml": strToU8(reportXml(domain, "r-2", rows.slice(0, 2), begin)) }),
			),
		);
		expect(await storeReport(first(zip), now)).toBe(true);

		// Someone else's domain is dropped.
		const other = await reportsInEmail(
			email("o.xml", "text/xml", strToU8(reportXml("not-ours.test", "r-3", rows))),
		);
		expect(await storeReport(first(other), now)).toBe(false);

		const s = await dmarcSummary(domain, 30, now);
		expect(s.messages).toBe(1500 + 7 + 20);
		expect(s.passed).toBe(1520);
		expect(s.reporters).toEqual([{ reporter: "google.com", messages: 1527, passed: 1520 }]);
		// Failing sources come first.
		expect(s.sources[0]).toMatchObject({
			source_ip: "203.0.113.9",
			dkim_domain: "brevo.com",
			messages: 7,
			passed: 0,
		});
		expect(s.last_report_at).toBe(new Date(now).toISOString());
		// Older than the window: not counted.
		expect((await dmarcSummary(domain, 1, now)).messages).toBe(0);
	});

	it("adds Mailroom's address to a DMARC record, keeping other report addresses", () => {
		expect(withReportsAddress("v=DMARC1; p=none;")).toBe(
			"v=DMARC1; p=none; rua=mailto:dmarc@mailroom.test;",
		);
		expect(withReportsAddress('"v=DMARC1; p=quarantine; rua=mailto:a@acme.com"')).toBe(
			"v=DMARC1; p=quarantine; rua=mailto:a@acme.com,mailto:dmarc@mailroom.test;",
		);
		expect(
			sendsReportsHere("v=DMARC1; p=none; rua=mailto:a@acme.com, mailto:DMARC@mailroom.test"),
		).toBe(true);
		expect(sendsReportsHere("v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com")).toBe(false);
		expect(sendsReportsHere(null)).toBe(false);
	});
});
