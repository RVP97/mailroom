import { useRouter } from "@tanstack/react-router";
import { Lock, Plus, Trash2, Upload, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ColorField, SwitchRow } from "@/components/design-controls";
import { Thumb } from "@/components/email-builder";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { removeKitFn, saveKitFn } from "@/functions/collab";
import { uploadMediaFn } from "@/functions/media";
import { type BrandKit, DEFAULT_KIT, type KitFont, kitOf, kitTheme } from "@/lib/brand-kit";
import { FONTS, type FontKey, onColor, starter } from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";

/**
 * A brand's kit, edited on its page: colors, its own fonts (WOFF2 files), corners, and whether
 * the email editor keeps to them. Beside it, a starting email in the kit, as it'll look.
 */
export function BrandKitCard({
	brand,
	name,
	logo,
	kit: saved,
	canEdit,
}: {
	brand: string;
	name: string;
	logo: string | null;
	kit: BrandKit | null;
	canEdit: boolean;
}) {
	const router = useRouter();
	const [kit, setKit] = useState<BrandKit>(saved ?? DEFAULT_KIT);
	const [was, setWas] = useState(saved);
	if (was !== saved) {
		setWas(saved);
		setKit(saved ?? DEFAULT_KIT);
	}
	const [busy, setBusy] = useState<"save" | "remove" | "font" | null>(null);
	const file = useRef<HTMLInputElement>(null);
	const set = (p: Partial<BrandKit>) => setKit((k) => ({ ...k, ...p }));
	const dirty = JSON.stringify(kitOf(kit)) !== JSON.stringify(saved ?? DEFAULT_KIT);
	const preview = useMemo(() => {
		const doc = starter("announcement", { logo, name });
		return { ...doc, theme: { ...doc.theme, ...kitTheme(kitOf(kit)) } };
	}, [kit, logo, name]);

	const upload = async (f: File) => {
		if (kit.fonts.length >= 6) return toast.error("A kit holds up to 6 fonts");
		if (!/\.woff2?$/i.test(f.name)) return toast.error("Upload a .woff2 or .woff file");
		setBusy("font");
		try {
			const data = await new Promise<string>((resolve, reject) => {
				const r = new FileReader();
				r.onload = () => resolve(String(r.result));
				r.onerror = () => reject(r.error);
				r.readAsDataURL(f);
			});
			// Browsers rarely name a font's type; the server checks the file itself.
			const typed = data.replace(
				/^data:[^;]*;/,
				`data:font/${/\.woff2$/i.test(f.name) ? "woff2" : "woff"};`,
			);
			const { url } = await uploadMediaFn({ data: { data: typed } });
			// "fraunces-latin-600-normal.woff2" → "Fraunces"
			const family = f.name
				.replace(/\.woff2?$/i, "")
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.split(/[-_\s]+/)
				.filter(
					(w) =>
						!/^(regular|bold|medium|semibold|light|book|roman|normal|italic|latin|ext|subset|variable|vf|webfont|wght|\d+)$/i.test(
							w,
						),
				)
				.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
				.join(" ")
				.replace(/[^\p{L}\p{N} ]/gu, "")
				.trim()
				.slice(0, 40);
			const weight = /bold|700/i.test(f.name)
				? 700
				: /semibold|600/i.test(f.name)
					? 600
					: /medium|500/i.test(f.name)
						? 500
						: 400;
			set({
				fonts: [
					...kit.fonts,
					{ family: family || "Brand font", url, fallback: "modern", weight },
				],
			});
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
			if (file.current) file.current.value = "";
		}
	};
	const setFont = (i: number, p: Partial<KitFont>) =>
		set({
			fonts: kit.fonts.map((f, j) => {
				if (j !== i) return f;
				const next = { ...f, ...p };
				return next;
			}),
			// A renamed font stays the one picked.
			...(p.family !== undefined && kit.font === kit.fonts[i]?.family
				? { font: p.family }
				: {}),
			...(p.family !== undefined && kit.heading_font === kit.fonts[i]?.family
				? { heading_font: p.family }
				: {}),
		});

	const fontChoices = [
		...kit.fonts.filter((f) => f.family).map((f) => [f.family, `${f.family} (brand)`] as const),
		...(Object.entries(FONTS) as [FontKey, (typeof FONTS)[FontKey]][]).map(
			([k, f]) => [k, f.label] as const,
		),
	];

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					Brand kit
					{kit.locked && <Lock className="size-3.5 text-muted-foreground" />}
				</CardTitle>
				<CardDescription>
					The colors and fonts this brand's emails are built with. New designs start in
					it, the editor offers its colors first, and locking it keeps every email to
					them.
				</CardDescription>
				{saved && canEdit && (
					<CardAction>
						<Button
							variant="ghost"
							size="sm"
							disabled={!!busy}
							onClick={async () => {
								setBusy("remove");
								try {
									await removeKitFn({ data: { brand } });
									toast.success("Brand kit removed");
									await router.invalidate();
								} catch (error) {
									toast.error(await errorMessage(error));
								} finally {
									setBusy(null);
								}
							}}
						>
							{busy === "remove" ? <Spinner /> : <Trash2 />}
							Remove
						</Button>
					</CardAction>
				)}
			</CardHeader>
			<CardContent>
				<fieldset
					disabled={!canEdit}
					className="grid gap-8 md:grid-cols-[minmax(0,1fr)_220px]"
				>
					<div className="flex min-w-0 flex-col gap-6">
						<section className="flex flex-col gap-3">
							<h3 className="text-[13px] font-semibold">Colors</h3>
							<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
								<ColorField
									label="Background"
									value={kit.background}
									onChange={(background) => set({ background })}
								/>
								<ColorField
									label="Email"
									value={kit.surface}
									onChange={(surface) => set({ surface })}
								/>
								<ColorField
									label="Headings"
									value={kit.heading}
									onChange={(heading) => set({ heading })}
								/>
								<ColorField
									label="Text"
									value={kit.text}
									onChange={(text) => set({ text })}
								/>
								<ColorField
									label="Accent"
									value={kit.accent}
									onChange={(accent) =>
										set({ accent, button_text: onColor(accent) })
									}
								/>
								<ColorField
									label="Button text"
									value={kit.button_text}
									onChange={(button_text) => set({ button_text })}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<span className="text-xs text-muted-foreground">
									More brand colors, for blocks and buttons
								</span>
								{kit.colors.map((c, i) => (
									<div
										key={i}
										className="flex items-end gap-2"
									>
										<Input
											aria-label="Color name"
											className="h-9 w-36"
											placeholder="Name"
											value={c.name}
											onChange={(e) =>
												set({
													colors: kit.colors.map((d, j) =>
														j === i
															? { ...d, name: e.target.value }
															: d,
													),
												})
											}
										/>
										<div className="w-36">
											<ColorField
												label=""
												value={c.value}
												onChange={(value) =>
													set({
														colors: kit.colors.map((d, j) =>
															j === i ? { ...d, value } : d,
														),
													})
												}
											/>
										</div>
										<Button
											variant="ghost"
											size="icon"
											aria-label="Remove color"
											onClick={() =>
												set({
													colors: kit.colors.filter((_, j) => j !== i),
												})
											}
										>
											<X />
										</Button>
									</div>
								))}
								{kit.colors.length < 10 && canEdit && (
									<Button
										variant="outline"
										size="sm"
										className="self-start"
										onClick={() =>
											set({
												colors: [
													...kit.colors,
													{ name: "", value: kit.accent },
												],
											})
										}
									>
										<Plus />
										Add a color
									</Button>
								)}
							</div>
						</section>

						<section className="flex flex-col gap-3">
							<h3 className="text-[13px] font-semibold">Fonts</h3>
							{kit.fonts.length > 0 && (
								<>
									<style>
										{kit.fonts
											.map(
												(f) =>
													`@font-face{font-family:'${f.family}';src:url('${f.url}');font-weight:${f.weight};font-display:swap}`,
											)
											.join("\n")}
									</style>
									<ul className="flex flex-col gap-2">
										{kit.fonts.map((f, i) => (
											<li
												key={i}
												className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 p-2"
											>
												<span
													className="w-12 shrink-0 text-center text-xl"
													style={{
														fontFamily: `'${f.family}',${FONTS[f.fallback].stack}`,
														fontWeight: f.weight,
													}}
												>
													Aa
												</span>
												<Input
													aria-label="Font name"
													className="h-8 min-w-0 flex-1"
													value={f.family}
													onChange={(e) =>
														setFont(i, { family: e.target.value })
													}
												/>
												<Select
													value={f.fallback}
													onValueChange={(v) =>
														setFont(i, { fallback: v as FontKey })
													}
												>
													<SelectTrigger
														size="sm"
														className="w-40"
														aria-label="Fallback font"
													>
														<span className="truncate">
															Else {FONTS[f.fallback].label}
														</span>
													</SelectTrigger>
													<SelectContent>
														{(
															Object.entries(FONTS) as [
																FontKey,
																(typeof FONTS)[FontKey],
															][]
														).map(([k, x]) => (
															<SelectItem
																key={k}
																value={k}
															>
																{x.label}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												<Button
													variant="ghost"
													size="icon"
													aria-label={`Remove ${f.family}`}
													onClick={() =>
														set({
															fonts: kit.fonts.filter(
																(_, j) => j !== i,
															),
															...(kit.font === f.family
																? { font: DEFAULT_KIT.font }
																: {}),
															...(kit.heading_font === f.family
																? {
																		heading_font:
																			DEFAULT_KIT.heading_font,
																	}
																: {}),
														})
													}
												>
													<X />
												</Button>
											</li>
										))}
									</ul>
								</>
							)}
							{canEdit && (
								<div className="flex flex-wrap items-center gap-3">
									<input
										ref={file}
										type="file"
										accept=".woff2,.woff,font/woff2,font/woff"
										className="hidden"
										onChange={(e) => {
											const f = e.target.files?.[0];
											if (f) void upload(f);
										}}
									/>
									<Button
										variant="outline"
										size="sm"
										disabled={busy === "font" || kit.fonts.length >= 6}
										onClick={() => file.current?.click()}
									>
										{busy === "font" ? <Spinner /> : <Upload />}
										Upload a font
									</Button>
									<span className="text-xs text-muted-foreground">
										WOFF2 or WOFF, up to 3 MB. Only use fonts your license lets
										you embed.
									</span>
								</div>
							)}
							<div className="grid gap-3 sm:grid-cols-2">
								<FontPick
									label="Text"
									value={kit.font}
									choices={fontChoices}
									onChange={(font) => set({ font })}
								/>
								<FontPick
									label="Headings"
									value={kit.heading_font}
									choices={fontChoices}
									onChange={(heading_font) => set({ heading_font })}
								/>
							</div>
							<p className="text-xs leading-relaxed text-muted-foreground">
								Brand fonts show in Apple Mail, iOS Mail, Samsung Mail and
								Thunderbird. Gmail and Outlook don't load web fonts, so they show
								the fallback.
							</p>
						</section>

						<section className="flex flex-col gap-3">
							<h3 className="text-[13px] font-semibold">Shape</h3>
							<label className="flex max-w-xs items-center gap-3 text-sm">
								<span className="w-20 text-muted-foreground">Corners</span>
								<input
									type="range"
									min={0}
									max={24}
									step={2}
									value={kit.radius}
									onChange={(e) => set({ radius: Number(e.target.value) })}
									className="flex-1 accent-foreground"
								/>
								<span className="w-10 text-right tabular-nums">{kit.radius}px</span>
							</label>
						</section>

						<SwitchRow
							label="Lock the kit"
							hint="The email editor offers only these colors and fonts, and hides its palettes."
							checked={kit.locked}
							onChange={(locked) => set({ locked })}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<span className="text-xs text-muted-foreground">
							How a new email starts
						</span>
						<span className="relative block aspect-[3/4] w-full overflow-hidden rounded-xl bg-muted shadow-[0_0_0_1px_var(--border)]">
							<Thumb doc={preview} />
						</span>
					</div>
				</fieldset>
			</CardContent>
			{canEdit && (
				<CardFooter className="justify-end gap-2">
					{dirty && (
						<Button
							variant="ghost"
							onClick={() => setKit(saved ?? DEFAULT_KIT)}
						>
							Discard
						</Button>
					)}
					<Button
						disabled={!dirty || !!busy}
						onClick={async () => {
							setBusy("save");
							try {
								await saveKitFn({ data: { brand, kit: kitOf(kit) } });
								toast.success("Brand kit saved");
								await router.invalidate();
							} catch (error) {
								toast.error(await errorMessage(error));
							} finally {
								setBusy(null);
							}
						}}
					>
						{busy === "save" && <Spinner />}
						{saved ? "Save kit" : "Create kit"}
					</Button>
				</CardFooter>
			)}
		</Card>
	);
}

function FontPick({
	label,
	value,
	choices,
	onChange,
}: {
	label: string;
	value: string;
	choices: (readonly [string, string])[];
	onChange: (v: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			<Select
				value={value}
				onValueChange={onChange}
			>
				<SelectTrigger
					className="w-full"
					aria-label={`${label} font`}
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{choices.map(([v, l]) => (
						<SelectItem
							key={v}
							value={v}
						>
							{l}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
