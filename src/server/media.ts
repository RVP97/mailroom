import { baseUrl, cfg } from "./env";
import { validation } from "./errors";
import { shownHere } from "./public-host";

/**
 * Images for emails, uploaded in the email editor: kept in R2 under media/<organization>/ and
 * served publicly at /media/<organization>/<file>, as inboxes fetch them without signing in.
 */

export const MEDIA_MAX_BYTES = 3 * 1024 * 1024;

const TYPES: Record<string, { ext: string; check: (b: Uint8Array) => boolean }> = {
	"image/png": { ext: "png", check: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e },
	"image/jpeg": { ext: "jpg", check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	"image/gif": {
		ext: "gif",
		check: (b) => String.fromCharCode(...b.subarray(0, 4)) === "GIF8",
	},
	"image/webp": {
		ext: "webp",
		check: (b) =>
			String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
			String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
	},
	// A brand kit's own fonts (inboxes that show web fonts fetch them from here).
	"font/woff2": {
		ext: "woff2",
		check: (b) => String.fromCharCode(...b.subarray(0, 4)) === "wOF2",
	},
	"font/woff": { ext: "woff", check: (b) => String.fromCharCode(...b.subarray(0, 4)) === "wOFF" },
};
const BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [v.ext, t]));

const bucket = () => {
	const b = cfg().INBOUND;
	if (!b) throw validation("Image uploads need the INBOUND R2 bucket bound.");
	return b;
};

/** Saves an image (a data: URL) and returns where it's served. */
export async function uploadMedia(organizationId: string, dataUrl: string) {
	const m = /^data:([a-z0-9/+.-]+);base64,(.+)$/i.exec(dataUrl);
	let type = m?.[1]?.toLowerCase() ?? "";
	// Browsers name font files differently; what's inside decides.
	if (/woff2/.test(type)) type = "font/woff2";
	else if (/woff/.test(type)) type = "font/woff";
	const kind = TYPES[type];
	if (!m || !kind) throw validation("Upload a PNG, JPEG, GIF or WebP image, or a WOFF2 font.");
	const bytes = Uint8Array.from(atob(m[2] as string), (c) => c.charCodeAt(0));
	if (bytes.byteLength > MEDIA_MAX_BYTES) throw validation("Files can be up to 3 MB.");
	if (!kind.check(bytes)) throw validation("That file isn't what it says it is.");
	const name = `${crypto.randomUUID().replace(/-/g, "")}.${kind.ext}`;
	await bucket().put(`media/${organizationId}/${name}`, bytes, {
		httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
	});
	return { url: `${baseUrl()}/media/${organizationId}/${name}` };
}

/** GET /media/<organization>/<file>. */
export async function serveMedia(pathname: string, head = false) {
	const m =
		/^\/media\/([A-Za-z0-9_-]{1,100})\/([a-f0-9]{32})\.(png|jpg|gif|webp|woff2|woff)$/.exec(
			pathname,
		);
	// On a domain's own host, only its organization's files.
	if (!m || !shownHere(m[1])) return new Response("Not found", { status: 404 });
	const obj = await bucket().get(`media/${m[1]}/${m[2]}.${m[3]}`);
	if (!obj) return new Response("Not found", { status: 404 });
	return new Response(head ? null : obj.body, {
		headers: {
			"content-type": BY_EXT[m[3] as string] ?? "application/octet-stream",
			"cache-control": "public, max-age=31536000, immutable",
			"access-control-allow-origin": "*",
			"content-security-policy": "default-src 'none'",
		},
	});
}
