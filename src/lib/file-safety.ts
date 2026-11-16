/**
 * Checking that a file is what it says it is, for every file people put into Mailroom: website
 * chat files (src/lib/chat-files.ts), images and fonts for emails (src/server/media.ts),
 * organization and BIMI logos, email attachments sent by the API, SMTP or an inbox reply, and the
 * CSV a contact import reads.
 *
 * A file's type comes from its name, so "invoice.pdf" can be a program. Its first bytes must
 * match that type here, and some things are refused whatever they're called: programs and
 * scripts, Office files with macros or embedded objects, PDFs that launch programs, archives with
 * programs, other archives or a password inside, zip bombs, XML or SVG with a DOCTYPE (entity
 * bombs, external entities) and images with more pixels than any photo. Mailroom never runs
 * these files. This isn't a virus scanner: it keeps out what's disguised, can run or would
 * exhaust whoever opens it, not every bad document. Same rules as Fiscalisto's uploads
 * (RVP97/invoices-retriever src/lib/file-safety.ts).
 */

const messages = (v: string) => ({
	wrong: `This file isn't what its name says, so it can't be ${v}.`,
	program: `Programs can't be ${v}.`,
	macros: `Documents with macros or embedded objects can't be ${v}.`,
	pdfLaunch: `This PDF tries to open a program, so it can't be ${v}.`,
	zipPrograms: `Archives with programs (or other archives) inside can't be ${v}.`,
	zipBomb: `This file unpacks to something far too big, so it can't be ${v}.`,
	zipBroken: "This archive can't be opened.",
	zipLocked: `Archives with a password can't be ${v} (what's inside can't be checked).`,
	xmlDoctype: `XML with a DOCTYPE can't be ${v}.`,
	svgDoctype: `SVGs with a DOCTYPE can't be ${v}. Export it again as plain SVG.`,
	imagePixels: `This image has too many pixels; ${v === "sent" ? "send" : "use"} a smaller one.`,
	unknown: `That kind of file can't be ${v}.`,
});
type Messages = ReturnType<typeof messages>;
const SENT = messages("sent");

/** What the person was doing with the file, for the refusal: "sent", "uploaded", "imported". */
export type FileVerb = "sent" | "uploaded" | "imported";

/** More pixels than this is no photo or scan (a 48 MP phone photo is 8064 × 6048). */
export const MAX_IMAGE_PIXELS = 100_000_000;

export interface ZipLimits {
	/** Records in its directory. */
	entries: number;
	/** Every entry unpacked, as the directory declares it. */
	bytes: number;
	/** Unpacked ÷ packed for any entry over 1 MB unpacked (text deflates ~10×; bombs ~1000×). */
	ratio: number;
	/** Archives inside are refused (they can't be looked into). */
	nested: boolean;
}

/**
 * A zip bomb: a small file that unpacks to something huge (to fill a disk or hang whoever opens
 * it). Mailroom never unpacks files, so it's only a danger to the person who opens it; refused by
 * what its directory says it holds: over 200 MB in all, a file packed over 100 times smaller
 * (past 1 MB), over 1,000 files, or sizes too big to say (zip64: a chat file is 10 MB at most).
 */
export const ZIP_LIMITS: ZipLimits = {
	entries: 1000,
	bytes: 200 * 1024 * 1024,
	ratio: 100,
	nested: true,
};

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const utf16 = (s: string) => [...s].flatMap((ch) => [ch.charCodeAt(0), 0]);

function indexOf(b: Uint8Array, sig: number[], from = 0): number {
	const first = sig[0] ?? 0;
	for (let i = b.indexOf(first, from); i >= 0 && i <= b.length - sig.length; ) {
		if (starts(b, sig, i)) return i;
		i = b.indexOf(first, i + 1);
	}
	return -1;
}
const has = (b: Uint8Array, s: string) => indexOf(b, ascii(s)) >= 0;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis", "avif"];

/** Windows, Linux and macOS programs, and scripts, by their first bytes. */
export function isProgram(b: Uint8Array): boolean {
	return (
		starts(b, ascii("MZ")) ||
		starts(b, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
		starts(b, [0xcf, 0xfa, 0xed, 0xfe]) || // Mach-O 64
		starts(b, [0xce, 0xfa, 0xed, 0xfe]) || // Mach-O 32
		starts(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
		starts(b, [0xfe, 0xed, 0xfa, 0xce]) ||
		starts(b, [0xca, 0xfe, 0xba, 0xbe]) || // Mach-O universal, Java class
		starts(b, ascii("#!"))
	);
}

/** Programs and scripts (and macro Office files), by name. */
export const RUNNABLE_NAME =
	/\.(exe|com|scr|pif|bat|cmd|msi|msp|dll|cpl|sys|jar|js|jse|mjs|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|url|reg|inf|sh|bash|command|app|apk|ipa|dmg|pkg|deb|rpm|iso|img|vhd|vhdx|docm|xlsm|pptm|dotm|xltm|xlam|ppam)$/i;
/** Archives, by name (inside a ZIP: what we can't look into). */
export const ARCHIVE_NAME = /\.(zip|7z|rar|gz|tgz|bz2|xz|tar|cab|arj|lzh|zst)$/i;

export interface ZipEntry {
	name: string;
	/** Bytes as stored. */
	compressed: number;
	/** Bytes inflated, as declared. */
	size: number;
	encrypted: boolean;
	/** Its sizes needed zip64 (over 4 GB). */
	zip64: boolean;
}

/**
 * A ZIP's directory, read without inflating anything (null when it isn't a readable ZIP, or has
 * more than `max` records: those are refused before JSZip builds an object per record). Sizes
 * are what the ZIP declares, which can lie: code that inflates still caps what it gets.
 */
export function zipDirectory(bytes: Uint8Array, max = ZIP_LIMITS.entries): ZipEntry[] | null {
	const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let eocd = -1;
	for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
		if (v.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) return null;
	let count = v.getUint16(eocd + 10, true);
	let cdSize = v.getUint32(eocd + 12, true);
	let end = eocd;
	const zip64 = count === 0xffff || cdSize === 0xffffffff;
	if (zip64 || v.getUint32(eocd + 16, true) === 0xffffffff) {
		const loc = eocd - 20;
		if (loc < 0 || v.getUint32(loc, true) !== 0x07064b50) return null;
		const rec = Number(v.getBigUint64(loc + 8, true));
		if (rec + 56 > bytes.length || v.getUint32(rec, true) !== 0x06064b50) return null;
		count = Number(v.getBigUint64(rec + 32, true));
		cdSize = Number(v.getBigUint64(rec + 40, true));
		end = rec;
	}
	if (count > max) return null;
	let p = end - cdSize;
	if (p < 0) return null;
	const out: ZipEntry[] = [];
	const decoder = new TextDecoder();
	while (p + 46 <= bytes.length && v.getUint32(p, true) === 0x02014b50) {
		if (out.length >= max) return null;
		const nameLength = v.getUint16(p + 28, true);
		const extraLength = v.getUint16(p + 30, true);
		let compressed = v.getUint32(p + 20, true);
		let size = v.getUint32(p + 24, true);
		const wide = size === 0xffffffff || compressed === 0xffffffff;
		// ZIP64 sizes are in the extra field (id 1): inflated first, then compressed.
		if (wide) {
			const extra = p + 46 + nameLength;
			for (let e = extra; e + 4 <= extra + extraLength && e + 4 <= bytes.length; ) {
				const id = v.getUint16(e, true);
				const len = v.getUint16(e + 2, true);
				if (id === 1) {
					let at = e + 4;
					if (size === 0xffffffff && at + 8 <= bytes.length) {
						size = Number(v.getBigUint64(at, true));
						at += 8;
					}
					if (compressed === 0xffffffff && at + 8 <= bytes.length)
						compressed = Number(v.getBigUint64(at, true));
					break;
				}
				e += 4 + len;
			}
		}
		out.push({
			name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
			compressed,
			size,
			encrypted: (v.getUint16(p + 8, true) & 1) === 1,
			zip64: wide,
		});
		p += 46 + nameLength + extraLength + v.getUint16(p + 32, true);
	}
	return out;
}

/**
 * Why this ZIP can't be taken (null: it can): a zip bomb by its declared sizes, programs or
 * archives inside, a password (what's inside can't be checked), or a broken directory.
 */
export function zipRefusal(
	bytes: Uint8Array,
	limits: Partial<ZipLimits> = {},
	M: Messages = SENT,
): string | null {
	const l = { ...ZIP_LIMITS, ...limits };
	if (!starts(bytes, ZIP) && !starts(bytes, ZIP_EMPTY)) return M.wrong;
	const entries = zipDirectory(bytes, l.entries);
	if (!entries) {
		// Unreadable, or too many records: tell which.
		return zipDirectory(bytes, Number.MAX_SAFE_INTEGER) ? M.zipBomb : M.zipBroken;
	}
	let total = 0;
	for (const e of entries) {
		total += e.size;
		if (e.zip64 || total > l.bytes) return M.zipBomb;
		if (e.size > 1024 * 1024 && e.size > Math.max(e.compressed, 1) * l.ratio) return M.zipBomb;
		const name = e.name.replace(/\/+$/, "");
		if (RUNNABLE_NAME.test(name) || (l.nested && ARCHIVE_NAME.test(name))) return M.zipPrograms;
		if (e.encrypted) return M.zipLocked;
	}
	return null;
}

/** Width and height from a PNG, JPEG, GIF or WebP header (null when unreadable). */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
	const u16be = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
	const u16le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
	const u32be = (i: number) => u16be(i) * 65536 + u16be(i + 2);
	if (starts(b, PNG)) return b.length >= 24 ? { width: u32be(16), height: u32be(20) } : null;
	if (starts(b, ascii("GIF8")))
		return b.length >= 10 ? { width: u16le(6), height: u16le(8) } : null;
	if (starts(b, ascii("RIFF")) && starts(b, ascii("WEBP"), 8)) {
		const chunk = String.fromCharCode(...b.subarray(12, 16));
		if (chunk === "VP8X" && b.length >= 30) {
			const w = (b[24] ?? 0) | ((b[25] ?? 0) << 8) | ((b[26] ?? 0) << 16);
			const h = (b[27] ?? 0) | ((b[28] ?? 0) << 8) | ((b[29] ?? 0) << 16);
			return { width: w + 1, height: h + 1 };
		}
		if (chunk === "VP8 " && b.length >= 30)
			return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
		if (chunk === "VP8L" && b.length >= 25) {
			const bits =
				(b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24);
			return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
		}
		return null;
	}
	if (starts(b, JPEG)) {
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) {
				i++;
				continue;
			}
			const marker = b[i + 1] ?? 0;
			// SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
				return { height: u16be(i + 5), width: u16be(i + 7) };
			if (
				marker === 0xd8 ||
				marker === 0x01 ||
				marker === 0xff ||
				(marker >= 0xd0 && marker <= 0xd7)
			) {
				i += marker === 0xff ? 1 : 2;
				continue;
			}
			i += 2 + u16be(i + 2);
		}
	}
	return null;
}

const tooManyPixels = (b: Uint8Array) => {
	const s = imageSize(b);
	return !!s && s.width * s.height > MAX_IMAGE_PIXELS;
};

/** An XML text's start: after a byte-order mark and spaces, it must open a tag. */
function xmlRefusal(b: Uint8Array, M: Messages): string | null {
	let i = starts(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
	while (i < b.length && [0x20, 0x09, 0x0a, 0x0d].includes(b[i] ?? 0)) i++;
	if (b[i] !== 0x3c || b.subarray(0, 65_536).includes(0)) return M.wrong;
	return hasDoctype(b) ? M.xmlDoctype : null;
}

/**
 * What comes before the root element (`root`: its pattern, any element by default), comments
 * taken out first: a "<a" inside a comment isn't the root, and the DOCTYPE after it still counts.
 */
function prologOf(text: string, root = /<[A-Za-z_:]/): string {
	const bare = text.replace(/<!--[\s\S]*?-->/g, "");
	const at = bare.search(root);
	return bare.slice(0, at < 0 ? bare.length : at);
}

/**
 * A DOCTYPE (with its ENTITY declarations) in the XML's prolog: how entity bombs («billion
 * laughs») and external entities (XXE) start. A CFDI, a retención or a SAT answer never has one.
 * Only the prolog is looked at (a DOCTYPE is only valid before the root element), so an addenda
 * carrying "<!DOCTYPE html>" inside CDATA isn't mistaken for one. Mailroom never parses a chat
 * file, but the team's tools (an accounting app, a spreadsheet) may.
 */
export function hasDoctype(xml: Uint8Array | string): boolean {
	return prologOf(typeof xml === "string" ? xml : new TextDecoder().decode(xml)).includes(
		"<!DOCTYPE",
	);
}

/**
 * The W3C's own SVG DOCTYPE (old Illustrator and Inkscape exports carry it): public, no entities,
 * nothing a reader fetches or expands.
 */
const SVG_DOCTYPE =
	/^<!DOCTYPE\s+svg\s+PUBLIC\s+"-\/\/W3C\/\/DTD SVG [\d.]+(?: Tiny| Basic)?\/\/EN"\s+"https?:\/\/www\.w3\.org\/Graphics\/SVG\/[\w./-]+\.dtd"\s*>$/i;

/**
 * Why this SVG can't be taken: it isn't text with an <svg> root, or its prolog has a DOCTYPE
 * other than the W3C's plain one (entity bombs and external entities start there). What it may
 * draw or run is each caller's own check (unsafeSvg, prepareBimiSvg).
 */
export function svgRefusal(b: Uint8Array | string, verb: FileVerb = "sent"): string | null {
	return svgCheck(b, messages(verb));
}

function svgCheck(b: Uint8Array | string, M: Messages): string | null {
	const text = typeof b === "string" ? b : new TextDecoder().decode(b);
	if (text.slice(0, 65_536).includes("\0")) return M.wrong;
	if (!/<svg\b/i.test(text.replace(/<!--[\s\S]*?-->/g, ""))) return M.wrong;
	const prolog = prologOf(text, /<svg\b/i);
	// Each DOCTYPE to its end: through an internal subset ([…]) when it has one.
	const doctypes = prolog.match(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>|<!DOCTYPE[\s\S]*$/gi) ?? [];
	if (doctypes.length > 1 || doctypes.some((d) => !SVG_DOCTYPE.test(d.trim())))
		return M.svgDoctype;
	return null;
}

function textRefusal(b: Uint8Array, M: Messages): string | null {
	const head = b.subarray(0, 65_536);
	if (head.includes(0)) return M.wrong;
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(
			head.subarray(0, Math.max(0, head.length - 4)),
		);
		return null;
	} catch {
		// Latin-1 and friends are text too; binary has control bytes.
		return head.some((x) => x < 9 || (x > 13 && x < 32 && x !== 27)) ? M.wrong : null;
	}
}

const OOXML = new Set([
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

/**
 * Why these bytes can't be taken as `type` (null: they can). The reason is for the person who
 * gave the file, with `verb` saying what they were doing ("sent" by default).
 */
export function refuseContent(
	type: string,
	bytes: Uint8Array | ArrayBuffer,
	o: { zip?: Partial<ZipLimits>; verb?: FileVerb } = {},
): string | null {
	const M = o.verb ? messages(o.verb) : SENT;
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	if (isProgram(b)) return M.program;
	switch (type) {
		case "image/png":
		case "image/jpeg":
		case "image/gif":
		case "image/webp": {
			const ok =
				type === "image/png"
					? starts(b, PNG)
					: type === "image/jpeg"
						? starts(b, JPEG)
						: type === "image/gif"
							? starts(b, ascii("GIF87a")) || starts(b, ascii("GIF89a"))
							: starts(b, ascii("RIFF")) && starts(b, ascii("WEBP"), 8);
			if (!ok) return M.wrong;
			return tooManyPixels(b) ? M.imagePixels : null;
		}
		case "image/heic": {
			const brand = new TextDecoder().decode(b.subarray(8, 12));
			return starts(b, ascii("ftyp"), 4) && HEIF_BRANDS.includes(brand) ? null : M.wrong;
		}
		case "application/pdf":
			// "%PDF-" at the start (some writers put a little before it).
			if (indexOf(b.subarray(0, 1024), ascii("%PDF-")) < 0) return M.wrong;
			// A /Launch action opens a program when the PDF is opened.
			return has(b, "/Launch") ? M.pdfLaunch : null;
		case "image/svg+xml":
			return svgCheck(b, M);
		case "font/woff2":
			return starts(b, ascii("wOF2")) ? null : M.wrong;
		case "font/woff":
			return starts(b, ascii("wOFF")) ? null : M.wrong;
		case "application/msword":
		case "application/vnd.ms-excel":
		case "application/vnd.ms-powerpoint":
			if (!starts(b, OLE)) return M.wrong;
			if (indexOf(b, utf16("_VBA_PROJECT")) >= 0 || indexOf(b, utf16("Macros")) >= 0)
				return M.macros;
			return null;
		case "application/xml":
		case "text/xml":
			return xmlRefusal(b, M);
		case "text/plain":
		case "text/csv":
			return textRefusal(b, M);
		case "application/zip":
			return zipRefusal(b, o.zip, M);
		default: {
			if (!OOXML.has(type)) return M.unknown;
			if (!starts(b, ZIP)) return M.wrong;
			const entries = zipDirectory(b);
			if (!entries) return M.wrong;
			if (!entries.some((e) => e.name === "[Content_Types].xml")) return M.wrong;
			// Macros (vbaProject.bin), OLE packages that can wrap a program or an exploit
			// (oleObject*.bin, the Equation Editor's), ActiveX controls.
			if (
				entries.some(
					(e) =>
						/(^|\/)(vbaProject|vbaData)\.(bin|xml)$/i.test(e.name) ||
						/(^|\/)embeddings\/oleObject\d*\.bin$/i.test(e.name) ||
						/(^|\/)activeX\//i.test(e.name) ||
						RUNNABLE_NAME.test(e.name),
				)
			)
				return M.macros;
			// An Office file is a ZIP: the same bomb limits.
			return zipRefusal(b, { ...o.zip, nested: false }, M);
		}
	}
}

/** The types refuseContent checks, by a file's extension. */
const TYPE_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	jpe: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	heic: "image/heic",
	heif: "image/heic",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	doc: "application/msword",
	xls: "application/vnd.ms-excel",
	ppt: "application/vnd.ms-powerpoint",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	txt: "text/plain",
	csv: "text/csv",
	xml: "application/xml",
	zip: "application/zip",
	woff: "font/woff",
	woff2: "font/woff2",
};
const CHECKED = new Set(Object.values(TYPE_BY_EXT).concat(["text/xml", "image/jpg"]));

/**
 * The type a file is checked as: its extension's (what whoever opens it goes by), else the type
 * it was given when that's one checked here; null: neither (only programs are refused).
 */
export function checkedType(filename: string, declared?: string | null): string | null {
	const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase() ?? "";
	const byName = TYPE_BY_EXT[ext];
	if (byName) return byName;
	const d = declared?.split(";")[0]?.trim().toLowerCase() ?? "";
	return CHECKED.has(d) ? (d === "image/jpg" ? "image/jpeg" : d) : null;
}

/**
 * Why a file of any kind, by its name and bytes, can't be taken (null: it can): for what takes
 * every kind of file, such as an email's attachments. Programs and macro files are refused by
 * name and by their bytes; a type refuseContent knows (by extension, else as declared) must be
 * what its bytes are, with its rules; other kinds (.ics, .html, .json…) pass.
 */
export function refuseFile(
	filename: string,
	declared: string | null | undefined,
	bytes: Uint8Array | ArrayBuffer,
	o: { zip?: Partial<ZipLimits>; verb?: FileVerb } = {},
): string | null {
	const M = o.verb ? messages(o.verb) : SENT;
	const name = filename.trim().replace(/[\s.]+$/, "");
	if (RUNNABLE_NAME.test(name))
		return /\.(docm|xlsm|pptm|dotm|xltm|xlam|ppam)$/i.test(name) ? M.macros : M.program;
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const type = checkedType(name, declared);
	if (type) return refuseContent(type, b, o);
	return isProgram(b) ? M.program : null;
}
