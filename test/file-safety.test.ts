import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { prepareBimiSvg } from "@/lib/bimi";
import { checkedType, hasDoctype, refuseContent, refuseFile, svgRefusal } from "@/lib/file-safety";
import { unsafeSvg } from "@/lib/svg-safety";

const text = (s: string) => new TextEncoder().encode(s);
const W3C =
	'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
const SQUARE =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe("SVG", () => {
	it("takes plain SVGs and the W3C's own DOCTYPE, refuses any other DOCTYPE", () => {
		expect(svgRefusal(SQUARE)).toBeNull();
		expect(svgRefusal(`<?xml version="1.0"?>\n${W3C}\n${SQUARE}`)).toBeNull();
		const bomb = `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;">]>${SQUARE}`;
		expect(svgRefusal(bomb)).toMatch(/DOCTYPE/);
		expect(svgRefusal(`<!DOCTYPE svg SYSTEM "file:///etc/passwd">${SQUARE}`)).toMatch(
			/DOCTYPE/,
		);
		// An "<svg" hidden in a comment isn't the root: the DOCTYPE after it still counts.
		expect(svgRefusal(`<!-- <svg --><!DOCTYPE svg [<!ENTITY x "y">]>${SQUARE}`)).toMatch(
			/DOCTYPE/,
		);
		expect(svgRefusal("<html><body>hi</body></html>")).toMatch(/isn't what/);
		expect(refuseContent("image/svg+xml", text(bomb), { verb: "uploaded" })).toMatch(
			/can't be uploaded/,
		);
	});

	it("refuses a DOCTYPE in organization and BIMI logos", () => {
		const bomb = `<!DOCTYPE svg [<!ENTITY a "aaaa">]>${SQUARE}`;
		expect(unsafeSvg(bomb)).toMatch(/DOCTYPE/);
		expect(unsafeSvg(SQUARE)).toBeNull();
		expect(prepareBimiSvg(bomb, "Globex")).toMatchObject({
			error: expect.stringMatching(/DOCTYPE/),
		});
		expect(prepareBimiSvg(`${W3C}${SQUARE}`, "Globex")).toHaveProperty("svg");
	});
});

describe("XML", () => {
	it("finds a DOCTYPE after a comment that hides an element", () => {
		expect(hasDoctype('<!-- <a --><!DOCTYPE l [<!ENTITY a "x">]><l/>')).toBe(true);
		expect(hasDoctype("<r><!-- <!DOCTYPE x> --></r>")).toBe(false);
	});
});

describe("files of any kind (attachments)", () => {
	it("checks a file by its extension, else by the type it was given", () => {
		expect(checkedType("Factura.PDF")).toBe("application/pdf");
		expect(checkedType("factura", "application/pdf; name=x")).toBe("application/pdf");
		expect(checkedType("foto", "image/jpg")).toBe("image/jpeg");
		expect(checkedType("cita.ics", "text/calendar")).toBeNull();
	});

	it("refuses programs and macro documents by name and bytes, passes kinds it doesn't check", () => {
		expect(refuseFile("setup.exe", null, text("hello"))).toMatch(/Programs/);
		expect(refuseFile("run.ps1 ", null, text("hello"))).toMatch(/Programs/);
		expect(refuseFile("plan.xlsm", null, text("PK"))).toMatch(/macros/);
		expect(refuseFile("notes.ics", "text/calendar", text("MZ\x90\0"))).toMatch(/Programs/);
		expect(refuseFile("notes.ics", "text/calendar", text("BEGIN:VCALENDAR"))).toBeNull();
		expect(refuseFile("page.html", "text/html", text("<html></html>"))).toBeNull();
		expect(refuseFile("factura.pdf", "application/pdf", text("%PDF-1.7"))).toBeNull();
		expect(refuseFile("photo.jpg", "image/jpeg", text("%PDF-1.7"))).toMatch(/isn't what/);
		const bundle = zipSync({ "inside.exe": text("MZ") });
		expect(refuseFile("bundle.zip", null, bundle)).toMatch(/Archives with programs/);
		expect(
			refuseFile("contacts.csv", "text/csv", text("a,b\0\x01\x02"), { verb: "imported" }),
		).toMatch(/can't be imported/);
	});
});
