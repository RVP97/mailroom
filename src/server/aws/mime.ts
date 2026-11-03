/**
 * Raw MIME for SES (SendEmail's Content.Raw): our own, so inline images, attachments and any
 * header travel exactly as given.
 */

export interface MimeAttachment {
	filename: string;
	/** Base64. */
	content: string;
	contentType?: string;
	/** Set for an inline image (cid:…). */
	contentId?: string;
}

export interface MimeMessage {
	from: string;
	to: string[];
	cc?: string[];
	replyTo?: string[];
	subject: string;
	text?: string;
	html?: string;
	attachments?: MimeAttachment[];
	headers?: Record<string, string>;
	/** Fixed for tests; otherwise now. */
	date?: Date;
	messageId?: string;
}

export const utf8Base64 = (s: string | Uint8Array) => {
	const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
};

/** Base64 in lines of 76 characters (RFC 2045). */
const wrap = (b64: string) => b64.replace(/\s+/g, "").replace(/.{1,76}/g, "$&\r\n");

/** UTF-8 bytes per encoded word, so each stays within RFC 2047's 75 characters. */
const WORD_BYTES = 45;

/**
 * A header value with anything outside ASCII (or too long for one line) as RFC 2047 encoded
 * words, folded onto lines of their own; a character is never split between two words.
 */
export function encodeHeader(value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ");
	if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 900) return clean;
	const words: string[] = [];
	let chunk = "";
	let bytes = 0;
	for (const ch of clean) {
		const size = new TextEncoder().encode(ch).length;
		if (bytes + size > WORD_BYTES && chunk) {
			words.push(chunk);
			chunk = "";
			bytes = 0;
		}
		chunk += ch;
		bytes += size;
	}
	if (chunk) words.push(chunk);
	return words.map((w) => `=?UTF-8?B?${utf8Base64(w)}?=`).join("\r\n ");
}

/** "Name" <a@b> with the display name encoded; the address stays as it is. */
export function encodeAddress(raw: string): string {
	// A header value is one line: a line break in an address would start a header of its own.
	const address = raw.replace(/[\r\n\0]+/g, " ");
	const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(address);
	if (!m) return address.trim();
	const name = (m[1] ?? "").trim();
	if (!name) return `<${m[2]}>`;
	const encoded = encodeHeader(name);
	return encoded === name ? `"${name.replace(/["\\]/g, "")}" <${m[2]}>` : `${encoded} <${m[2]}>`;
}

/** The bare address of "Name <a@b>" (lowercased domain kept as given). */
export const bareAddress = (a: string) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim();

const MIME_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	xml: "application/xml",
	json: "application/json",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	csv: "text/csv",
	zip: "application/zip",
	ics: "text/calendar",
	txt: "text/plain",
	html: "text/html",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const typeOf = (filename: string) =>
	MIME_TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

const boundary = (tag: string) => `=_${tag}_${crypto.randomUUID().replace(/-/g, "")}`;

/** The filename parameter, RFC 2231-encoded when it isn't plain ASCII. */
function filenameParam(name: string) {
	const clean = name.replace(/["\\\r\n]/g, "");
	return /^[\x20-\x7e]*$/.test(clean)
		? `filename="${clean}"`
		: `filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function part(headers: string[], body: string) {
	return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function multipart(type: string, tag: string, parts: string[]) {
	const b = boundary(tag);
	return {
		header: `Content-Type: multipart/${type}; boundary="${b}"`,
		body: `${parts.map((p) => `--${b}\r\n${p}\r\n`).join("")}--${b}--`,
	};
}

/** Headers the caller can't set: they're built from the message itself. */
const RESERVED =
	/^(from|to|cc|bcc|subject|date|mime-version|content-type|content-transfer-encoding|reply-to)$/i;

/**
 * The message as MIME: mixed (attachments) ⊃ related (inline images by Content-ID) ⊃
 * alternative (text and HTML), each level only when it has something to hold.
 */
export function buildMime(m: MimeMessage): string {
	const bodies: string[] = [];
	if (m.text !== undefined)
		bodies.push(
			part(
				["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"],
				wrap(utf8Base64(m.text)),
			),
		);
	if (m.html !== undefined)
		bodies.push(
			part(
				["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64"],
				wrap(utf8Base64(m.html)),
			),
		);
	if (!bodies.length)
		bodies.push(
			part(
				["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 7bit"],
				"",
			),
		);
	let body: { header: string; body: string };
	if (bodies.length === 2) body = multipart("alternative", "alt", bodies);
	else {
		const only = bodies[0] as string;
		const split = only.indexOf("\r\n\r\n");
		body = { header: only.slice(0, split), body: only.slice(split + 4) };
	}
	const inline = (m.attachments ?? []).filter((a) => a.contentId);
	const files = (m.attachments ?? []).filter((a) => !a.contentId);
	if (inline.length)
		body = multipart("related", "rel", [
			part([body.header], body.body),
			...inline.map((a) =>
				part(
					[
						`Content-Type: ${a.contentType ?? typeOf(a.filename)}`,
						"Content-Transfer-Encoding: base64",
						`Content-ID: <${a.contentId}>`,
						`Content-Disposition: inline; ${filenameParam(a.filename)}`,
					],
					wrap(a.content),
				),
			),
		]);
	if (files.length)
		body = multipart("mixed", "mix", [
			part([body.header], body.body),
			...files.map((a) =>
				part(
					[
						`Content-Type: ${a.contentType ?? typeOf(a.filename)}; name="${a.filename.replace(/["\\\r\n]/g, "")}"`,
						"Content-Transfer-Encoding: base64",
						`Content-Disposition: attachment; ${filenameParam(a.filename)}`,
					],
					wrap(a.content),
				),
			),
		]);
	const headers = [
		`From: ${encodeAddress(m.from)}`,
		...(m.to.length ? [`To: ${m.to.map(encodeAddress).join(", ")}`] : []),
		...(m.cc?.length ? [`Cc: ${m.cc.map(encodeAddress).join(", ")}`] : []),
		...(m.replyTo?.length ? [`Reply-To: ${m.replyTo.map(encodeAddress).join(", ")}`] : []),
		`Subject: ${encodeHeader(m.subject)}`,
		`Date: ${(m.date ?? new Date()).toUTCString().replace("GMT", "+0000")}`,
		...(m.messageId ? [`Message-ID: <${m.messageId}>`] : []),
		"MIME-Version: 1.0",
		...Object.entries(m.headers ?? {})
			.filter(([k]) => /^[!-9;-~]+$/.test(k) && !RESERVED.test(k))
			.map(([k, v]) => `${k}: ${encodeHeader(v)}`),
		body.header,
	];
	return `${headers.join("\r\n")}\r\n\r\n${body.body}\r\n`;
}
