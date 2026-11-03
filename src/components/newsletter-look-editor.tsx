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

function Part({
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-3">
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

function FontPick({
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

/** The public page, drawn from the server with what's set, a moment after each change. */
function Preview({ id, fields }: { id: string; fields: Record<string, unknown> }) {
	const [html, setHtml] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [phone, setPhone] = useState(false);
	const [dark, setDark] = useState(false);
	// A page that follows the reader's device: the preview shows the side picked here.
	const follows = (fields.look as Look | undefined)?.theme === "auto";
	const sent = follows
		? { ...fields, look: { ...(fields.look as Look), theme: dark ? "dark" : "light" } }
		: fields;
	const key = JSON.stringify(sent);
	const seq = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key stands for fields
	useEffect(() => {
		const n = ++seq.current;
		setBusy(true);
		const t = setTimeout(() => {
			previewNewsletterFn({ data: { id, fields: sent } })
				.then((r) => n === seq.current && setHtml(r.html))
				.catch(() => {})
				.finally(() => n === seq.current && setBusy(false));
		}, 350);
		return () => clearTimeout(t);
	}, [id, key]);
	const shown = html;
	return (
		<Card className="sticky top-4 gap-0 overflow-hidden p-0">
			<div className="flex h-11 items-center gap-2 border-b border-border/70 px-4">
				<span className="text-sm font-medium">Preview</span>
				{busy && <Spinner className="size-3.5 text-muted-foreground" />}
				<span className="flex-1" />
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
				{shown ? (
					<iframe
						title="Public page preview"
						sandbox=""
						srcDoc={shown}
						className={cn(
							"h-[640px] rounded-lg border border-border/70 bg-white transition-[width]",
							phone ? "w-[390px]" : "w-full",
						)}
					/>
				) : (
					<div className="flex h-[640px] w-full items-center justify-center">
						<Spinner className="text-muted-foreground" />
					</div>
				)}
			</div>
		</Card>
	);
}
