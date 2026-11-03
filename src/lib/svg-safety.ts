/**
 * Why an SVG can't be an organization's logo, or null. Shown only in <img> (where nothing runs)
 * and served with a CSP that allows nothing, but refused anyway when it carries code or reaches
 * out: scripts, foreign HTML, event handlers, outside links or images.
 */
export function unsafeSvg(svg: string): string | null {
	if (!/<svg\b[^>]*>/i.test(svg)) return "That isn't an SVG file.";
	if (/<\s*(script|foreignObject|iframe|embed|object)\b/i.test(svg))
		return "The logo has scripts or embedded HTML. Export it as plain shapes.";
	if (/\son[a-z]+\s*=/i.test(svg)) return "The logo has scripts in its attributes.";
	if (/\b(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpeg|webp);)/i.test(svg))
		return "The logo points to other files. Export it self-contained.";
	if (/url\(\s*["']?(?!#|data:image\/(?:png|jpeg|webp);)/i.test(svg) || /@import/i.test(svg))
		return "The logo's styles load other files. Export it self-contained.";
	return null;
}

/** Text as base64 (UTF-8), without spreading big arrays into one call. */
export function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(out);
}
