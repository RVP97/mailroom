import { Monitor, Moon, Plus, Smartphone, Sun, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Choice, ColorField } from "@/components/design-controls";
import { ImagePick } from "@/components/email-builder";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { previewNewsletterFn } from "@/functions/newsletters";
import { type Look, PAGE_FONTS, type PageFont } from "@/lib/newsletter-look";
import { cn } from "@/lib/utils";

/**
 * The newsletter page's "How it looks": its logo, cover, colors, fonts, light or dark, layout and
 * header links, beside a live preview of the public page with what's set (saved or not).
 */
export function LookEditor({
	id,
	look,
	accent,
	fields,
	onLook,
	onAccent,
	disabled,
	brandLogo,
}: {
	id: string;
	look: Look;
	accent: string;
	/** What the preview shows besides the look (name, description, form), saved or not. */
	fields: Record<string, unknown>;
	onLook: (l: Look) => void;
	onAccent: (v: string) => void;
	disabled?: boolean;
	brandLogo: boolean;
}) {
	const set = <K extends keyof Look>(k: K, v: Look[K]) => onLook({ ...look, [k]: v });
	const own = look.logo !== "brand" && look.logo !== "none";
	const [custom, setCustom] = useState(own);
	const logoKind = custom || own ? "custom" : look.logo;
	const fonts = Object.entries(PAGE_FONTS) as [PageFont, { label: string; stack: string }][];

	return (
		<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
			<Card className="gap-0 p-0">
				<fieldset
					disabled={disabled}
					className="contents"
				>
					<Part title="Logo">
						<Choice
							value={logoKind}
							onChange={(v) => {
								setCustom(v === "custom");
								if (v !== "custom") set("logo", v);
							}}
							options={[
								["brand", "Brand's"],
								["custom", "Another"],
								["none", "None"],
							]}
						/>
						{logoKind === "brand" && !brandLogo && (
							<p className="text-xs text-muted-foreground">
								This brand has no logo yet. Add one in Brands, or upload another
								here.
							</p>
						)}
						{logoKind === "custom" && (
							<ImagePick
								aspect="aspect-[3/1]"
								value={own ? look.logo : ""}
								onChange={(url) => set("logo", url || "brand")}
							/>
						)}
						{logoKind !== "none" && (
							<>
								<Row label="Shape">
									<Choice
										value={look.logo_shape}
										onChange={(v) => set("logo_shape", v)}
										options={[
											["original", "As is"],
											["rounded", "Rounded"],
											["circle", "Circle"],
										]}
									/>
								</Row>
								<Row label="Size">
									<Choice
										value={look.logo_size}
										onChange={(v) => set("logo_size", v)}
										options={[
											["small", "Small"],
											["medium", "Medium"],
											["large", "Large"],
										]}
									/>
								</Row>
							</>
						)}
					</Part>
					<Part
						title="Cover image"
						hint="A wide picture across the top of the page."
					>
						<ImagePick
							aspect="aspect-[3/1]"
							value={look.cover ?? ""}
							onChange={(url) => set("cover", url || null)}
						/>
					</Part>
					<Part title="Colors">
						<div className="grid grid-cols-2 gap-3">
							<ColorField
								label="Accent"
								value={accent || "#18181b"}
								onChange={onAccent}
							/>
							<ColorField
								label="Background"
								value={look.background}
								onChange={(v) => set("background", v)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<span className="text-xs text-muted-foreground">Light or dark</span>
							<Choice
								value={look.theme}
								onChange={(v) => set("theme", v)}
								options={[
									["auto", "Reader's device"],
									["light", "Light"],
									["dark", "Dark"],
								]}
							/>
						</div>
					</Part>
					<Part title="Fonts">
						<div className="grid grid-cols-2 gap-3">
							<FontPick
								label="Headings"
								value={look.heading_font}
								fonts={fonts}
								onChange={(v) => set("heading_font", v)}
							/>
							<FontPick
								label="Text"
								value={look.font}
								fonts={fonts}
								onChange={(v) => set("font", v)}
							/>
						</div>
					</Part>
					<Part title="Layout">
						<Row label="Issues">
							<Choice
								value={look.layout}
								onChange={(v) => set("layout", v)}
								options={[
									["list", "List"],
									["cards", "Cards"],
								]}
							/>
						</Row>
						<Row label="Header">
							<Choice
								value={look.align}
								onChange={(v) => set("align", v)}
								options={[
									["center", "Centered"],
									["left", "Left"],
								]}
							/>
						</Row>
						<Row label="Sign-up">
							<Choice
								value={look.form_position}
								onChange={(v) => set("form_position", v)}
								options={[
									["top", "Above issues"],
									["bottom", "Below"],
								]}
							/>
						</Row>
					</Part>
					<Part
						title="Style"
						hint="Corners and lines of cards, pictures and buttons, and the bar at the top."
					>
						<Row label="Corners">
							<Choice
								value={look.corners}
								onChange={(v) => set("corners", v)}
								options={[
									["square", "Square"],
									["soft", "Soft"],
									["round", "Round"],
								]}
							/>
						</Row>
						<Row label="Edges">
							<Choice
								value={look.borders ? "line" : "shadow"}
								onChange={(v) => set("borders", v === "line")}
								options={[
									["line", "Thin line"],
									["shadow", "Shadow"],
								]}
							/>
						</Row>
						<Row label="Top bar">
							<Choice
								value={look.bar}
								onChange={(v) => set("bar", v)}
								options={[
									["glass", "Glass"],
									["solid", "Solid"],
									["none", "Plain"],
								]}
							/>
						</Row>
					</Part>
					<Part
						title="Links"
						hint="Buttons under the description: your website, Instagram, booking page…"
					>
						{look.links.map((l, i) => (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
								key={i}
								className="flex gap-1.5"
							>
								<Input
									aria-label={`Link ${i + 1} label`}
									placeholder="Website"
									className="h-8 w-28 text-sm"
									value={l.label}
									onChange={(e) =>
										set(
											"links",
											look.links.map((x, j) =>
												j === i ? { ...x, label: e.target.value } : x,
											),
										)
									}
								/>
								<Input
									aria-label={`Link ${i + 1} address`}
									placeholder="https://"
									spellCheck={false}
									className="h-8 min-w-0 flex-1 text-sm"
									value={l.url}
									onChange={(e) =>
										set(
											"links",
											look.links.map((x, j) =>
												j === i ? { ...x, url: e.target.value } : x,
											),
										)
									}
								/>
								<Button
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label="Remove link"
									onClick={() =>
										set(
											"links",
											look.links.filter((_, j) => j !== i),
										)
									}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						{look.links.length < 6 && (
							<Button
								variant="outline"
								size="sm"
								className="self-start"
								onClick={() =>
									set("links", [...look.links, { label: "", url: "" }])
								}
							>
								<Plus />
								Add a link
							</Button>
						)}
					</Part>
				</fieldset>
			</Card>
			<Preview
				id={id}
				fields={fields}
			/>
		</div>
	);
}

export function Part({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col gap-3 border-b border-border/70 px-5 py-4 last:border-b-0">
			<div>
				<h3 className="text-[13px] font-semibold">{title}</h3>
				{hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
			</div>
			{children}
		</section>
	);
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3">
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

export function FontPick({
	label,
	value,
	fonts,
	onChange,
}: {
	label: string;
	value: PageFont;
	fonts: [PageFont, { label: string; stack: string }][];
	onChange: (v: PageFont) => void;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<Select
				value={value}
				onValueChange={(v) => onChange(v as PageFont)}
			>
				<SelectTrigger
					aria-label={`${label} font`}
					className="w-full"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{fonts.map(([k, f]) => (
						<SelectItem
							key={k}
							value={k}
						>
							{f.label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/**
 * Turns the open preview into `html` by changing only what differs, so nothing blinks: its fonts,
 * images and styles stay loaded while a word or a color changes.
 */
function patchDocument(doc: Document, html: string) {
	const next = new DOMParser().parseFromString(html, "text/html");
	if (doc.title !== next.title) doc.title = next.title;
	morph(doc.documentElement, next.documentElement);
}

function morph(from: Node, to: Node) {
	if (from.nodeType !== Node.ELEMENT_NODE) {
		if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
		return;
	}
	const a = from as Element;
	const b = to as Element;
	for (const at of [...a.attributes]) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
	for (const at of [...b.attributes])
		if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
	const olds = [...a.childNodes];
	const news = [...b.childNodes];
	news.forEach((n, i) => {
		const o = olds[i];
		if (!o) a.appendChild(a.ownerDocument.importNode(n, true));
		else if (
			o.nodeType === n.nodeType &&
			(o.nodeType !== Node.ELEMENT_NODE || (o as Element).tagName === (n as Element).tagName)
		)
			morph(o, n);
		else o.replaceWith(a.ownerDocument.importNode(n, true));
	});
	for (const o of olds.slice(news.length)) o.remove();
}

/**
 * A public page, drawn by the server (`load`) with what's set, a moment after each change. Its
 * look's theme "auto" is shown light or dark as picked here.
 */
export function Preview({
	id,
	fields,
	load,
	theme,
	toolbar,
	height = 640,
	draw,
}: {
	id?: string;
	fields: Record<string, unknown>;
	/** Draws the page from these fields (the newsletter's by default). */
	load?: (fields: Record<string, unknown>) => Promise<string>;
	/** Draws it right here, on every change (no wait for the server). */
	draw?: (fields: Record<string, unknown>, dark: boolean) => string;
	/** The theme when it isn't the look's (fields.look.theme). */
	theme?: "auto" | "light" | "dark";
	/** More buttons in the preview's bar (which state to show…). */
	toolbar?: React.ReactNode;
	height?: number;
}) {
	const [html, setHtml] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [phone, setPhone] = useState(false);
	const [dark, setDark] = useState(false);
	// A page that follows the reader's device: the preview shows the side picked here.
	const look = fields.look as Look | undefined;
	const follows = (theme ?? look?.theme) === "auto";
	const sent = !follows
		? fields
		: look
			? { ...fields, look: { ...look, theme: dark ? "dark" : "light" } }
			: { ...fields, theme: dark ? "dark" : "light" };
	const key = JSON.stringify(sent);
	const seq = useRef(0);
	const loadRef = useRef(load);
	loadRef.current = load;
	const drawn = draw ? draw(fields, dark) : null;
	const frame = useRef<HTMLIFrameElement>(null);
	// Drawn here: written into the open frame, so it changes in place without reloading.
	useEffect(() => {
		const doc = frame.current?.contentDocument;
		if (drawn === null || !doc) return;
		if (!doc.body?.childElementCount) {
			doc.open();
			doc.write(drawn);
			doc.close();
			return;
		}
		patchDocument(doc, drawn);
	}, [drawn]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key stands for fields
	useEffect(() => {
		if (draw) return;
		const n = ++seq.current;
		setBusy(true);
		const t = setTimeout(() => {
			(loadRef.current
				? loadRef.current(sent)
				: previewNewsletterFn({ data: { id: id ?? "", fields: sent } }).then((r) => r.html)
			)
				.then((h) => n === seq.current && setHtml(h))
				.catch(() => {})
				.finally(() => n === seq.current && setBusy(false));
		}, 300);
		return () => clearTimeout(t);
	}, [id, key]);
	const shown = html;
	return (
		<Card className="sticky top-4 gap-0 overflow-hidden p-0">
			<div className="flex h-11 items-center gap-2 border-b border-border/70 px-4">
				<span className="text-sm font-medium">Preview</span>
				{busy && <Spinner className="size-3.5 text-muted-foreground" />}
				<span className="flex-1" />
				{toolbar}
				<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
					{[
						{ on: false, icon: Monitor, label: "Desktop" },
						{ on: true, icon: Smartphone, label: "Phone" },
					].map((w) => (
						<button
							key={w.label}
							type="button"
							aria-label={w.label}
							title={w.label}
							aria-pressed={phone === w.on}
							onClick={() => setPhone(w.on)}
							className={cn(
								"flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
								phone === w.on &&
									"bg-background text-foreground shadow-[0_0_0_1px_var(--border)] dark:bg-white/[0.1]",
							)}
						>
							<w.icon className="size-4" />
						</button>
					))}
				</div>
				{follows && (
					<Button
						variant="ghost"
						size="icon"
						className="size-8"
						aria-label={dark ? "As on a light device" : "As on a dark device"}
						title={dark ? "As on a light device" : "As on a dark device"}
						onClick={() => setDark((d) => !d)}
					>
						{dark ? <Sun /> : <Moon />}
					</Button>
				)}
			</div>
			<div className="flex justify-center bg-muted/40 p-3">
				{drawn !== null ? (
					<iframe
						ref={frame}
						title="Public page preview"
						// Same origin (to write into it) but no scripts: the page has none.
						sandbox="allow-same-origin"
						style={{ height }}
						className={cn(
							"max-w-full rounded-lg border border-border/70 bg-white transition-[width] duration-300 ease-out",
							phone ? "w-[390px]" : "w-full",
						)}
					/>
				) : shown ? (
					<iframe
						title="Public page preview"
						sandbox=""
						srcDoc={shown}
						style={{ height }}
						className={cn(
							"max-w-full rounded-lg border border-border/70 bg-white transition-[width] duration-300 ease-out",
							phone ? "w-[390px]" : "w-full",
						)}
					/>
				) : (
					<div
						style={{ height }}
						className="flex w-full items-center justify-center"
					>
						<Spinner className="text-muted-foreground" />
					</div>
				)}
			</div>
		</Card>
	);
}
