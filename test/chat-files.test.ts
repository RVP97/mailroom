import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { hasDoctype, imageSize, refuseContent, zipDirectory } from "@/lib/chat-files";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
	);
const text = (s: string) => new TextEncoder().encode(s);

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A real .zip of these files (deflated). */
const zip = (files: Record<string, string | Uint8Array>) =>
	zipSync(
		Object.fromEntries(
			Object.entries(files).map(([n, d]) => [n, typeof d === "string" ? text(d) : d]),
		),
	);

/**
 * A .zip whose directory declares these sizes (nothing behind them): what a bomb's directory
 * says, without making one.
 */
function declared(...records: { name: string; packed: number; size: number }[]) {
	const central = records.flatMap(({ name, packed, size }) => {
		const r = new Uint8Array(46);
		r.set([0x50, 0x4b, 0x01, 0x02]);
		const v = new DataView(r.buffer);
		v.setUint32(20, packed, true);
		v.setUint32(24, size, true);
		v.setUint16(28, name.length, true);
		return [...r, ...text(name)];
	});
	const local = [0x50, 0x4b, 0x03, 0x04, 0, 0];
	const end = new Uint8Array(22);
	end.set([0x50, 0x4b, 0x05, 0x06]);
	const v = new DataView(end.buffer);
	v.setUint16(8, records.length, true);
	v.setUint16(10, records.length, true);
	v.setUint32(12, central.length, true);
	v.setUint32(16, local.length, true);
	return new Uint8Array([...local, ...central, ...end]);
}

function png(width: number, height: number) {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	const v = new DataView(b.buffer);
	v.setUint32(16, width);
	v.setUint32(20, height);
	return b;
}

describe("chat files: what they really are", () => {
	it("takes files whose contents match their type", () => {
		expect(refuseContent("image/png", png(1200, 800))).toBeNull();
		expect(refuseContent("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
		expect(refuseContent("image/gif", bytes("GIF89a", [10, 0, 10, 0]))).toBeNull();
		expect(refuseContent("image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBeNull();
		expect(refuseContent("application/pdf", bytes("%PDF-1.4"))).toBeNull();
		expect(refuseContent("text/csv", bytes("name,email\nAna,ana@x.test\n"))).toBeNull();
		expect(refuseContent("text/plain", bytes("Olá, ¿qué tal?"))).toBeNull();
		expect(refuseContent("application/xml", bytes('<?xml version="1.0"?><cfdi/>'))).toBeNull();
		const docx = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w/>" });
		expect(refuseContent(DOCX, docx)).toBeNull();
		expect(
			refuseContent("application/zip", zip({ "a.pdf": "%PDF-1.4", "b.txt": "hi" })),
		).toBeNull();
	});

	it("refuses programs, disguised files, macros and archives with programs inside", () => {
		expect(refuseContent("application/pdf", bytes("MZ", [0x90, 0]))).toMatch(/Programs/);
		expect(refuseContent("text/plain", bytes("#!/bin/sh\nrm -rf /"))).toMatch(/Programs/);
		expect(refuseContent("image/png", bytes([0xce, 0xfa, 0xed, 0xfe]))).toMatch(/Programs/);
		expect(refuseContent("image/png", bytes("%PDF-1.4"))).toMatch(/isn't what/);
		expect(refuseContent("text/plain", bytes("ab", [0, 1, 2]))).toMatch(/isn't what/);
		const macro = zip({ "[Content_Types].xml": "<Types/>", "word/vbaProject.bin": "x" });
		expect(refuseContent(DOCX, macro)).toMatch(/macros/);
		const ole = zip({ "[Content_Types].xml": "<Types/>", "xl/embeddings/oleObject1.bin": "x" });
		expect(refuseContent(XLSX, ole)).toMatch(/embedded/);
		expect(refuseContent(DOCX, zip({ "word/document.xml": "<w/>" }))).toMatch(/isn't what/);
		expect(refuseContent("application/zip", zip({ "setup.exe": "MZ" }))).toMatch(/Archives/);
		expect(refuseContent("application/zip", zip({ "more.7z": "x" }))).toMatch(/Archives/);
		expect(refuseContent("image/svg+xml", bytes("<svg/>"))).toMatch(/can't be sent/);
	});

	it("refuses archives with a password, PDFs that launch programs and XML with a DOCTYPE", () => {
		const locked = zip({ "a.txt": "hi" });
		const cd = locked.findIndex(
			(_, i) =>
				locked[i] === 0x50 &&
				locked[i + 1] === 0x4b &&
				locked[i + 2] === 1 &&
				locked[i + 3] === 2,
		);
		locked[cd + 8] = (locked[cd + 8] ?? 0) | 1;
		expect(refuseContent("application/zip", locked)).toMatch(/password/);
		const launch = bytes("%PDF-1.4\n1 0 obj << /OpenAction << /S /Launch /F (cmd.exe) >> >>");
		expect(refuseContent("application/pdf", launch)).toMatch(/open a program/);
		const laughs = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "lol"><!ENTITY b "&a;&a;&a;">]><r>&b;</r>`;
		expect(refuseContent("text/xml", bytes(laughs))).toMatch(/DOCTYPE/);
		expect(hasDoctype("<r><![CDATA[<!DOCTYPE html>]]></r>")).toBe(false);
	});

	it("refuses zip bombs: small files that unpack to something huge", () => {
		// One entry: 40 KB packed, 400 MB unpacked.
		const one = declared({ name: "zeros.txt", packed: 40_000, size: 400_000_000 });
		expect(refuseContent("application/zip", one)).toMatch(/far too big/);
		// A real one: 20 MB of zeros pack to ~20 KB.
		const real = zip({ "zeros.txt": new Uint8Array(20 * 1024 * 1024) });
		expect(real.byteLength).toBeLessThan(100_000);
		expect(zipDirectory(real)?.[0]?.size).toBe(20 * 1024 * 1024);
		expect(refuseContent("application/zip", real)).toMatch(/far too big/);
		// Many files that add up past 200 MB, each packed sensibly.
		const many = Array.from({ length: 30 }, (_, i) => ({
			name: `photo${i}.jpg`,
			packed: 7_000_000,
			size: 8_000_000,
		}));
		expect(refuseContent("application/zip", declared(...many))).toMatch(/far too big/);
		// Over 1,000 files.
		const crowd = Array.from({ length: 1001 }, (_, i) => ({
			name: `${i}.txt`,
			packed: 1,
			size: 1,
		}));
		expect(refuseContent("application/zip", declared(...crowd))).toMatch(/far too big/);
		// Sizes too big to say (zip64).
		const wide = declared({ name: "x.bin", packed: 0xffffffff, size: 0xffffffff });
		expect(refuseContent("application/zip", wide)).toMatch(/far too big/);
		// A normal archive is fine.
		const normal = declared({ name: "notes.txt", packed: 2_000, size: 9_000 });
		expect(refuseContent("application/zip", normal)).toBeNull();
	});

	it("refuses images with more pixels than any photo", () => {
		expect(imageSize(png(4032, 3024))).toEqual({ width: 4032, height: 3024 });
		expect(refuseContent("image/png", png(8064, 6048))).toBeNull();
		expect(refuseContent("image/png", png(50_000, 50_000))).toMatch(/too many pixels/);
		const jpeg = bytes([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0xea, 0x60, 0xea, 0x60, 3, 0, 0]);
		expect(refuseContent("image/jpeg", jpeg)).toMatch(/too many pixels/);
	});
});
