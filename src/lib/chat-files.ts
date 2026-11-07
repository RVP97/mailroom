/**
 * What a website chat takes as a file, and checking that a file is what it says it is.
 *
 * A browser says a file's type from its name, so "invoice.pdf" can be a program. Each file's
 * first bytes must match its type here, and some things are refused whatever they're called:
 * programs and scripts, Office files with macros, archives with programs inside. Files are never
 * run by Mailroom, and they're served sandboxed (images and PDFs shown, the rest downloaded).
 * This isn't a virus scanner: it keeps out what's disguised or can run, not every bad document.
 */

/** The kinds a chat can take (its file_kinds), each with its types. */
export const FILE_KINDS = {
	images: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"],
	pdf: ["application/pdf"],
	documents: [
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"text/plain",
		"text/csv",
		// Facturas (CFDI) and other XML.
		"application/xml",
		"text/xml",
	],
	archives: ["application/zip"],
} as const;

export type FileKind = keyof typeof FILE_KINDS;
export const FILE_KIND_NAMES = Object.keys(FILE_KINDS) as FileKind[];
/** What a new chat takes: everything but archives (a .zip can hold anything). */
export const DEFAULT_FILE_KINDS: FileKind[] = ["images", "pdf", "documents"];

/** The widget's file picker filter, for these kinds. */
const ACCEPT: Record<FileKind, string> = {
	images: "image/png,image/jpeg,image/gif,image/webp,image/heic,.heic",
	pdf: "application/pdf,.pdf",
	documents: ".doc,.docx,.xls,.xlsx,.csv,.txt,.xml",
	archives: ".zip",
};
export const acceptFor = (kinds: FileKind[]) => kinds.map((k) => ACCEPT[k]).join(",");

export const typesFor = (kinds: FileKind[]) =>
	new Set<string>(kinds.flatMap((k) => FILE_KINDS[k] ?? []));

/** The kinds as people read them: "images, PDFs and documents". */
export function kindsText(kinds: FileKind[]) {
	const names: Record<FileKind, string> = {
		images: "images",
		pdf: "PDFs",
		documents: "documents",
		archives: ".zip files",
	};
	const n = kinds.map((k) => names[k]);
	return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n.at(-1)}` : (n[0] ?? "no files");
}

const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const has = (b: Uint8Array, s: string) => indexOf(b, ascii(s)) >= 0;
const utf16 = (s: string) => [...s].flatMap((ch) => [ch.charCodeAt(0), 0]);

function indexOf(b: Uint8Array, sig: number[], from = 0) {
	const first = sig[0];
	for (let i = b.indexOf(first ?? 0, from); i >= 0 && i <= b.length - sig.length; ) {
		if (starts(b, sig, i)) return i;
		i = b.indexOf(first ?? 0, i + 1);
	}
	return -1;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis", "avif"];

/** Programs and scripts, by name, inside an archive. */
const RUNNABLE =
	/\.(exe|com|scr|pif|bat|cmd|msi|msp|dll|cpl|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|lnk|reg|sh|app|apk|dmg|pkg|iso|img|docm|xlsm|pptm|dotm|xltm)$/i;

/** The names in a .zip's directory (its central records). */
function zipEntries(b: Uint8Array) {
	const out: { name: string; packed: number; size: number }[] = [];
	const sig = [0x50, 0x4b, 0x01, 0x02];
	const u32 = (i: number) =>
		((b[i] ?? 0) |
			((b[i + 1] ?? 0) << 8) |
			((b[i + 2] ?? 0) << 16) |
			((b[i + 3] ?? 0) << 24)) >>>
		0;
	for (let i = indexOf(b, sig); i >= 0 && out.length < 5000; i = indexOf(b, sig, i + 4)) {
		const len = (b[i + 28] ?? 0) | ((b[i + 29] ?? 0) << 8);
		out.push({
			name: new TextDecoder().decode(b.subarray(i + 46, i + 46 + len)),
			packed: u32(i + 20),
			size: u32(i + 24),
		});
	}
	return out;
}
const zipNames = (b: Uint8Array) => zipEntries(b).map((e) => e.name);

/**
 * A zip bomb: a small file that unpacks to something huge (to fill a disk or hang whoever opens
 * it). Mailroom never unpacks files, so it's only a danger to the person who opens it; refused
 * by what its directory says it holds: over 200 MB in all, a file packed over 100 times
 * smaller (past 1 MB), over 1,000 files, or sizes too big to say (zip64).
 */
function zipBomb(b: Uint8Array) {
	const entries = zipEntries(b);
	if (entries.length > 1000) return true;
	let total = 0;
	for (const e of entries) {
		if (e.size === 0xffffffff || e.packed === 0xffffffff) return true;
		if (e.size > 1024 * 1024 && e.size > e.packed * 100) return true;
		total += e.size;
	}
	return total > 200 * 1024 * 1024;
}
const BOMB = "This file unpacks to something far too big, so it can't be sent.";

/**
 * Why these bytes can't be sent as `type` (null: they can). The reason is for the visitor.
 */
export function refuseContent(type: string, bytes: Uint8Array | ArrayBuffer): string | null {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	const wrong = "This file isn't what its name says, so it can't be sent.";
	// Programs, whatever their name: Windows, Linux, macOS, scripts.
	if (
		starts(b, ascii("MZ")) ||
		starts(b, [0x7f, 0x45, 0x4c, 0x46]) ||
		starts(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
		starts(b, [0xca, 0xfe, 0xba, 0xbe]) ||
		starts(b, ascii("#!"))
	)
		return "Programs can't be sent.";
	switch (type) {
		case "image/png":
			return starts(b, PNG) ? null : wrong;
		case "image/jpeg":
			return starts(b, JPEG) ? null : wrong;
		case "image/gif":
			return starts(b, ascii("GIF87a")) || starts(b, ascii("GIF89a")) ? null : wrong;
		case "image/webp":
			return starts(b, ascii("RIFF")) && starts(b, ascii("WEBP"), 8) ? null : wrong;
		case "image/heic": {
			const brand = new TextDecoder().decode(b.subarray(8, 12));
			return starts(b, ascii("ftyp"), 4) && HEIF_BRANDS.includes(brand) ? null : wrong;
		}
		case "application/pdf":
			// "%PDF-" at the start (some writers put a little before it).
			return indexOf(b.subarray(0, 1024), ascii("%PDF-")) >= 0 ? null : wrong;
		case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
		case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
			if (!starts(b, ZIP)) return wrong;
			if (!has(b, "[Content_Types].xml")) return wrong;
			if (has(b, "vbaProject.bin")) return "Documents with macros can't be sent.";
			// A .docx or .xlsx is a zip too.
			if (zipBomb(b)) return BOMB;
			return null;
		}
		case "application/msword":
		case "application/vnd.ms-excel":
			if (!starts(b, OLE)) return wrong;
			if (indexOf(b, utf16("_VBA_PROJECT")) >= 0 || indexOf(b, utf16("Macros")) >= 0)
				return "Documents with macros can't be sent.";
			return null;
		case "application/xml":
		case "text/xml": {
			// Text that opens with a tag (after a byte-order mark or spaces).
			let i = starts(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
			while (i < b.length && [0x20, 0x09, 0x0a, 0x0d].includes(b[i] ?? 0)) i++;
			if (b[i] !== 0x3c || b.subarray(0, 65_536).includes(0)) return wrong;
			return null;
		}
		case "text/plain":
		case "text/csv": {
			const head = b.subarray(0, 65_536);
			if (head.includes(0)) return wrong;
			try {
				new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - 4));
				return null;
			} catch {
				// Latin-1 and friends are text too; binary has control bytes.
				return head.some((x) => x < 9 || (x > 13 && x < 32 && x !== 27)) ? wrong : null;
			}
		}
		case "application/zip": {
			if (!starts(b, ZIP) && !starts(b, ZIP_EMPTY)) return wrong;
			if (zipBomb(b)) return BOMB;
			const names = zipNames(b);
			if (names.some((n) => RUNNABLE.test(n) || /\.zip$/i.test(n)))
				return "Archives with programs (or other archives) inside can't be sent.";
			return null;
		}
		default:
			return "That kind of file can't be sent.";
	}
}
