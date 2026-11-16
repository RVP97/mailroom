/**
 * What a website chat takes as a file. Each file is checked to be what it says it is by
 * refuseContent (src/lib/file-safety.ts, the rules every upload in Mailroom follows), and served
 * sandboxed (images and PDFs shown, the rest downloaded).
 */

export {
	hasDoctype,
	imageSize,
	isProgram,
	MAX_IMAGE_PIXELS,
	refuseContent,
	ZIP_LIMITS,
	zipDirectory,
	zipRefusal,
} from "./file-safety";

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
