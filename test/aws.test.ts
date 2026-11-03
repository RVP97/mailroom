import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bareAddress, buildMime, encodeAddress, encodeHeader } from "@/server/aws/mime";
import { signV4 } from "@/server/aws/sigv4";
import { spkiOfCertificate, trustedSnsUrl, verifySns } from "@/server/aws/sns";
import cert from "./fixtures/sns-test-cert.pem?raw";
import { CERT_URL, signedSns, TOPIC } from "./helpers";

const decodeWords = (header: string) =>
	[...header.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
		.map((m) =>
			new TextDecoder().decode(Uint8Array.from(atob(m[1] as string), (c) => c.charCodeAt(0))),
		)
		.join("");

describe("MIME", () => {
	const mime = buildMime({
		from: '"Acme Viajes Málaga" <reservas@acmeviajes.test>',
		to: ["ana@cliente.test", "Luis <luis@cliente.test>"],
		cc: ["conta@cliente.test"],
		replyTo: ["recepcion@acmeviajes.test"],
		subject: "Confirmación de su reserva — 31 de diciembre",
		text: "Hola, ¿cómo está?",
		html: '<p>Hola</p><img src="cid:logo">',
		attachments: [
			{ filename: "reserva.pdf", content: btoa("%PDF-1.7") },
			{ filename: "logo.png", content: btoa("png"), contentId: "logo" },
			{ filename: "Año nuevo.ics", content: btoa("BEGIN:VCALENDAR") },
		],
		headers: {
			"List-Unsubscribe": "<mailto:baja@acmeviajes.test>",
			Bcc: "spy@evil.test",
			"X-Bad\r\nInjected": "1",
		},
	});
	const head = mime.slice(0, mime.indexOf("\r\n\r\n"));

	it("nests mixed ⊃ related ⊃ alternative, inline images by Content-ID", () => {
		expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="=_mix_/);
		expect(mime).toMatch(/multipart\/related; boundary="=_rel_/);
		expect(mime).toMatch(/multipart\/alternative; boundary="=_alt_/);
		expect(mime).toContain("Content-ID: <logo>");
		expect(mime).toContain('Content-Disposition: attachment; filename="reserva.pdf"');
		expect(mime).toContain("filename*=UTF-8''A%C3%B1o%20nuevo.ics");
		expect(mime).toContain("Content-Type: text/calendar");
	});

	it("encodes names and subjects, keeps addresses, and drops reserved or broken headers", () => {
		expect(head).toMatch(/^From: =\?UTF-8\?B\?[^?]+\?= <reservas@acmeviajes\.test>/);
		expect(head).toContain('To: ana@cliente.test, "Luis" <luis@cliente.test>');
		expect(head).toContain("Reply-To: recepcion@acmeviajes.test");
		expect(decodeWords(/Subject: ([\s\S]*?)\r\nDate:/.exec(head)?.[1] ?? "")).toBe(
			"Confirmación de su reserva — 31 de diciembre",
		);
		expect(head).toContain("List-Unsubscribe: <mailto:baja@acmeviajes.test>");
		expect(head).not.toMatch(/^Bcc:/m);
		expect(head).not.toContain("Injected");
	});

	it("keeps every line within RFC 5322's 998 characters, even a long accented subject", () => {
		const subject = "Ñandú ".repeat(160);
		const long = buildMime({
			from: "a@b.test",
			to: ["c@d.test"],
			subject,
			text: "x".repeat(5000),
		});
		expect(Math.max(...long.split("\r\n").map((l) => l.length))).toBeLessThanOrEqual(998);
		const folded = /Subject: ([\s\S]*?)\r\nDate:/.exec(long)?.[1] ?? "";
		// Folded words, each at most 75 characters, decoding back to the subject.
		for (const line of folded.split("\r\n")) expect(line.trim().length).toBeLessThanOrEqual(75);
		expect(decodeWords(folded)).toBe(subject.replace(/[\r\n]+/g, " "));
		expect(mime.split("\r\n").every((l) => l.length <= 998)).toBe(true);
	});

	it("is only the alternative without attachments, and single-part with one body", () => {
		const plain = buildMime({
			from: "a@b.test",
			to: ["c@d.test"],
			subject: "s",
			text: "t",
			html: "h",
		});
		expect(plain).toMatch(/Content-Type: multipart\/alternative/);
		expect(plain).not.toMatch(/multipart\/mixed|multipart\/related/);
		const text = buildMime({ from: "a@b.test", to: ["c@d.test"], subject: "s", text: "t" });
		expect(text).not.toContain("multipart");
		expect(text).toContain("Content-Type: text/plain; charset=UTF-8");
	});

	it("handles header injection and address forms", () => {
		expect(encodeHeader("a\r\nBcc: x@y.z")).toBe("a Bcc: x@y.z");
		expect(encodeAddress("Globex <hola@globex.test>")).toBe('"Globex" <hola@globex.test>');
		expect(encodeAddress("ana@cliente.test")).toBe("ana@cliente.test");
		expect(bareAddress("Ana Pérez <ana@cliente.test>")).toBe("ana@cliente.test");
	});
});

describe("Signature V4", () => {
	it("matches an independent implementation (node:crypto), with the path encoded twice", async () => {
		const credentials = {
			accessKeyId: "AKIDEXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		};
		const url = new URL(
			"https://email.us-east-1.amazonaws.com/v2/email/identities/hotel%40acme.test?b=2&a=1&a=0",
		);
		const body = '{"x":1}';
		const now = new Date("2026-12-31T23:30:00Z");
		const headers = await signV4({
			method: "PUT",
			url,
			body,
			region: "us-east-1",
			service: "ses",
			credentials,
			now,
		});

		const sha = (s: string) => createHash("sha256").update(s).digest("hex");
		const hmac = (k: string | Buffer, s: string) => createHmac("sha256", k).update(s).digest();
		const amzDate = "20261231T233000Z";
		const canonical = [
			"PUT",
			"/v2/email/identities/hotel%2540acme.test",
			"a=0&a=1&b=2",
			"content-type:application/json",
			"host:email.us-east-1.amazonaws.com",
			`x-amz-content-sha256:${sha(body)}`,
			`x-amz-date:${amzDate}`,
			"",
			"content-type;host;x-amz-content-sha256;x-amz-date",
			sha(body),
		].join("\n");
		const scope = "20261231/us-east-1/ses/aws4_request";
		const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical)].join("\n");
		let key = hmac(`AWS4${credentials.secretAccessKey}`, "20261231");
		for (const part of ["us-east-1", "ses", "aws4_request"]) key = hmac(key, part);
		const signature = createHmac("sha256", key).update(toSign).digest("hex");

		expect(headers["x-amz-date"]).toBe(amzDate);
		expect(headers.authorization).toBe(
			`AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/${scope}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
		);
	});
});

describe("SNS signatures", () => {
	const fetchCert = (async () => new Response(cert)) as unknown as typeof fetch;

	it("only trusts certificates from SNS's own hosts over HTTPS", () => {
		expect(trustedSnsUrl(CERT_URL)).not.toBeNull();
		expect(trustedSnsUrl("https://sns.us-east-1.amazonaws.com.evil.test/c.pem")).toBeNull();
		expect(trustedSnsUrl("http://sns.us-east-1.amazonaws.com/c.pem")).toBeNull();
		expect(trustedSnsUrl("https://evil.test/sns.us-east-1.amazonaws.com")).toBeNull();
		expect(trustedSnsUrl(undefined)).toBeNull();
	});

	it("reads the public key out of an X.509 certificate", async () => {
		const der = Uint8Array.from(atob(cert.replace(/-----[^-]+-----|\s+/g, "")), (c) =>
			c.charCodeAt(0),
		);
		const key = await crypto.subtle.importKey(
			"spki",
			spkiOfCertificate(der) as BufferSource,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		expect(key.type).toBe("public");
	});

	it("accepts a signed message and refuses any change to it", async () => {
		const m = await signedSns({
			Type: "Notification",
			MessageId: "m-1",
			TopicArn: TOPIC,
			Message: '{"eventType":"Delivery"}',
			Timestamp: "2026-12-31T23:30:00.000Z",
		});
		expect(await verifySns(m, fetchCert)).toBe(true);
		expect(await verifySns({ ...m, Message: '{"eventType":"Bounce"}' }, fetchCert)).toBe(false);
		expect(await verifySns({ ...m, TopicArn: `${TOPIC}-other` }, fetchCert)).toBe(false);
		expect(await verifySns({ ...m, SignatureVersion: "3" }, fetchCert)).toBe(false);
		expect(
			await verifySns({ ...m, SigningCertURL: "https://evil.test/cert.pem" }, fetchCert),
		).toBe(false);
		expect(await verifySns({ ...m, Signature: btoa("nope") }, fetchCert)).toBe(false);
	});
});
