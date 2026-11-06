import { describe, expect, it } from "vitest";
import { refuseContent } from "@/lib/chat-files";

const bytes = (...parts: (number[] | string)[]) =>
	new Uint8Array(
		parts.flatMap((p) => (typeof p === "string" ? [...new TextEncoder().encode(p)] : p)),
	);

describe("chat files: what they really are", () => {
	it("takes files whose contents match their type", () => {
		expect(refuseContent("image/png", bytes([137, 80, 78, 71, 13, 10, 26, 10]))).toBeNull();
		expect(refuseContent("image/jpeg", bytes([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
		expect(refuseContent("image/gif", bytes("GIF89a"))).toBeNull();
		expect(refuseContent("image/webp", bytes("RIFF", [0, 0, 0, 0], "WEBP"))).toBeNull();
		expect(refuseContent("application/pdf", bytes("%PDF-1.4"))).toBeNull();
		expect(refuseContent("text/csv", bytes("name,email\nAna,ana@x.test\n"))).toBeNull();
		expect(refuseContent("text/plain", bytes("Olá, ¿qué tal?"))).toBeNull();
		const docx = bytes(
			[0x50, 0x4b, 0x03, 0x04],
			"....[Content_Types].xml....word/document.xml",
		);
		expect(
			refuseContent(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				docx,
			),
		).toBeNull();
	});

	it("refuses programs, disguised files, macros and archives with programs inside", () => {
		expect(refuseContent("application/pdf", bytes("MZ", [0x90, 0]))).toMatch(/Programs/);
		expect(refuseContent("text/plain", bytes("#!/bin/sh\nrm -rf /"))).toMatch(/Programs/);
		expect(refuseContent("image/png", bytes("%PDF-1.4"))).toMatch(/isn't what/);
		expect(refuseContent("text/plain", bytes("ab", [0, 1, 2]))).toMatch(/isn't what/);
		const macro = bytes([0x50, 0x4b, 0x03, 0x04], "[Content_Types].xml word/vbaProject.bin");
		expect(
			refuseContent(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				macro,
			),
		).toMatch(/macros/);
		const name = "setup.exe";
		const central = [0x50, 0x4b, 0x01, 0x02, ...new Array(24).fill(0), name.length, 0];
		const zip = bytes(
			[0x50, 0x4b, 0x03, 0x04, 0, 0],
			central,
			new Array(46 - central.length).fill(0),
			name,
		);
		expect(refuseContent("application/zip", zip)).toMatch(/Archives/);
		expect(refuseContent("image/svg+xml", bytes("<svg/>"))).toMatch(/can't be sent/);
	});
});
