import { useSyncExternalStore } from "react";
import { toBase64, unsafeSvg } from "./svg-safety";

/** The square an organization's logo is made into before it's uploaded. */
export const LOGO_PX = 256;

export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml,.svg";

/**
 * A picked image ready to upload: a clean SVG as it is; anything else as a 256 px square (WebP,
 * PNG where the browser can't make WebP), the image fitted inside it, centered, nothing cut off.
 */
export async function squareLogo(file: File): Promise<string> {
	const svg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
	if (!svg && !/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type))
		throw new Error("Pick a PNG, JPEG, WebP or SVG image.");
	if (file.size > 10 * 1024 * 1024) throw new Error("That image is over 10 MB.");
	const text = svg ? await file.text() : "";
	// A clean SVG goes as it is: sharp at every size and usually smaller than any image.
	if (svg && file.size <= 150 * 1024 && !unsafeSvg(text))
		return `data:image/svg+xml;base64,${toBase64(text)}`;
	const url = URL.createObjectURL(svg ? new Blob([text], { type: "image/svg+xml" }) : file);
	try {
		const img = new Image();
		img.decoding = "async";
		img.src = url;
		await img.decode().catch(() => {
			throw new Error("That image couldn't be opened.");
		});
		// An SVG without width/height decodes at 0×0 (or 300×150): draw it by its own shape.
		const w = img.naturalWidth || LOGO_PX;
		const h = img.naturalHeight || LOGO_PX;
		const scale = Math.min(LOGO_PX / w, LOGO_PX / h);
		const dw = Math.round(w * scale);
		const dh = Math.round(h * scale);
		const canvas = document.createElement("canvas");
		canvas.width = LOGO_PX;
		canvas.height = LOGO_PX;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("This browser can't prepare the image.");
		ctx.imageSmoothingQuality = "high";
		ctx.drawImage(img, (LOGO_PX - dw) / 2, (LOGO_PX - dh) / 2, dw, dh);
		const webp = canvas.toDataURL("image/webp", 0.9);
		return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Logos and backgrounds changed in this tab, by organization: the switcher, sidebar and Settings
 * show a new one the moment it's picked, before the save finishes (null: removed). A failed save
 * takes the change back.
 */
const changed = {
	url: new Map<string, string | null>(),
	background: new Map<string, string | null>(),
};
const listeners = new Set<() => void>();
let version = 0;

function override(kind: keyof typeof changed, id: string, value: string | null | undefined) {
	if (value === undefined) changed[kind].delete(id);
	else changed[kind].set(id, value);
	version++;
	for (const l of listeners) l();
}

export const setLogoOverride = (id: string, url: string | null | undefined) =>
	override("url", id, url);

export const setBackgroundOverride = (id: string, background: string | null | undefined) =>
	override("background", id, background);

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};

function useChanged(
	kind: keyof typeof changed,
	id: string | undefined,
	saved: string | null | undefined,
) {
	useSyncExternalStore(
		subscribe,
		() => version,
		() => 0,
	);
	if (id && changed[kind].has(id)) return changed[kind].get(id) ?? null;
	return saved ?? null;
}

/** An organization's logo URL as the dashboard should show it now. */
export const useOrgLogo = (id: string | undefined, saved: string | null | undefined) =>
	useChanged("url", id, saved);

/** What's behind it now: "white", "black", "#rrggbb" or null. */
export const useOrgLogoBackground = (id: string | undefined, saved: string | null | undefined) =>
	useChanged("background", id, saved);

/** A background's CSS color. */
export const backgroundColor = (b: string | null) =>
	b === "white" ? "#ffffff" : b === "black" ? "#000000" : b;
