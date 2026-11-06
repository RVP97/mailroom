import { useRouter } from "@tanstack/react-router";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Choice, ColorField, SwitchRow } from "@/components/design-controls";
import { ImagePick } from "@/components/email-builder";
import { LiveFrame } from "@/components/live-frame";
import { FontPick, Part, Preview, Row } from "@/components/newsletter-look-editor";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { resetSubscriberPageFn, saveSubscriberPageFn } from "@/functions/subscriber-pages";
import { errorMessage } from "@/lib/errors";
import { PAGE_FONTS, type PageFont } from "@/lib/newsletter-look";
import {
	type BrandDress,
	DEFAULT_PAGE,
	PAGE_TEMPLATES,
	PAGE_TEXTS,
	pageOf,
	previewSubscriberHtml,
	type SubscriberPage,
	type TextKey,
	withTemplate,
} from "@/lib/subscriber-page";
import { cn } from "@/lib/utils";

type State = "ask" | "done" | "back";

/** Which lines show in which state of the preview, so editing one shows it. */
const SHOWN_IN: Record<TextKey, State> = {
	eyebrow: "ask",
	tagline: "ask",
	taglineBody: "ask",
	ask: "ask",
	who: "ask",
	out: "ask",
	prefs: "ask",
	save: "ask",
	saved: "ask",
	done: "done",
	sorry: "done",
	back: "done",
	backDone: "back",
	backBody: "back",
};

/**
 * A brand's unsubscribe and preferences page: what people see after the unsubscribe link of its
 * emails. Logo, colors, fonts, shape and every line, beside a live preview in each of its states.
 */
export function UnsubscribePageCard({
	brand,
	page: saved,
	isSaved,
	dress,
	canEdit,
}: {
	brand: string;
	page: SubscriberPage;
	isSaved: boolean;
	/** The brand's name, logo and kit accent, which the page wears. */
	dress: BrandDress;
	canEdit: boolean;
}) {
	const kitAccent = dress.accent;
	const brandLogo = !!dress.logo;
	const router = useRouter();
	const [page, setPage] = useState(saved);
	const [state, setState] = useState<State>("ask");
	const [lang, setLang] = useState<"en" | "es">("en");
	const [busy, setBusy] = useState<"save" | "reset" | null>(null);
	const [moreLines, setMoreLines] = useState(
		["back", "backDone", "backBody", "prefs", "save", "saved"].some(
			(k) => saved.texts[k as TextKey],
		),
	);
	const own = page.logo !== "brand" && page.logo !== "none";
	const [custom, setCustom] = useState(own);
	const logoKind = custom || own ? "custom" : page.logo;
	const set = <K extends keyof SubscriberPage>(k: K, v: SubscriberPage[K]) =>
		setPage((p) => ({ ...p, [k]: v }));
	const setText = (k: TextKey, v: string) => {
		setPage((p) => ({ ...p, texts: { ...p.texts, [k]: v } }));
		setState(SHOWN_IN[k]);
	};
	const dirty = useMemo(
		() => JSON.stringify(pageOf(page)) !== JSON.stringify(pageOf(saved)),
		[page, saved],
	);
	const fonts = Object.entries(PAGE_FONTS) as [PageFont, { label: string; stack: string }][];
	const shownLang = page.language === "auto" ? lang : page.language;
	const accent = page.accent ?? kitAccent ?? "#14161a";

	const save = async () => {
		setBusy("save");
		try {
			const next = await saveSubscriberPageFn({ data: { brand, page: pageOf(page) } });
			setPage(next);
			toast.success("Unsubscribe page saved");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};
	const reset = async () => {
		setBusy("reset");
		try {
			await resetSubscriberPageFn({ data: { brand } });
			setPage(DEFAULT_PAGE);
			setCustom(false);
			toast.success("Back to the default page");
			await router.invalidate();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const textField = (k: TextKey, long = false) => {
		const id = `unsub-${k}`;
		const props = {
			id,
			value: page.texts[k] ?? "",
			placeholder: PAGE_TEXTS[k][shownLang],
			onFocus: () => setState(SHOWN_IN[k]),
			onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
				setText(k, e.target.value),
		};
		return (
			<div
				key={k}
				className="flex flex-col gap-1.5"
			>
				<label
					htmlFor={id}
					className="text-xs text-muted-foreground"
				>
					{PAGE_TEXTS[k].label}
				</label>
				{long ? (
					<Textarea
						{...props}
						rows={2}
						className="min-h-14 text-sm"
					/>
				) : (
					<Input
						{...props}
						className="h-8 text-sm"
					/>
				)}
			</div>
		);
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle>Unsubscribe page</CardTitle>
				<CardDescription>
					What people see after the unsubscribe link in this brand's emails, and where
					they pick the topics they want. Make it look and sound like the brand.
				</CardDescription>
				{isSaved && canEdit && (
					<CardAction>
						<Button
							variant="ghost"
							size="sm"
							disabled={!!busy}
							onClick={reset}
						>
							{busy === "reset" ? <Spinner /> : <RotateCcw />}
							Reset
						</Button>
					</CardAction>
				)}
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{canEdit && (
					<Templates
						page={page}
						dress={dress}
						onPick={(id) => {
							setPage((p) => withTemplate(p, id));
							setState("ask");
						}}
					/>
				)}
				<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
					<div className="overflow-hidden rounded-xl border border-border/70">
						<fieldset
							disabled={!canEdit}
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
										This brand has no logo yet. Add one above, or upload another
										here.
									</p>
								)}
								{logoKind === "custom" && (
									<ImagePick
										aspect="aspect-[3/1]"
										value={own ? page.logo : ""}
										onChange={(url) => set("logo", url || "brand")}
									/>
								)}
								{logoKind !== "none" && (
									<>
										<Row label="Shape">
											<Choice
												value={page.logo_shape}
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
												value={page.logo_size}
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
							<Part title="Colors">
								<div className="grid grid-cols-2 gap-3">
									<ColorField
										label={page.accent ? "Buttons" : "Buttons (brand kit)"}
										value={accent}
										onChange={(v) => set("accent", v)}
									/>
									<ColorField
										label="Text"
										value={page.text}
										onChange={(v) => set("text", v)}
									/>
									<ColorField
										label="Page"
										value={page.background}
										onChange={(v) => set("background", v)}
									/>
									<ColorField
										label="Card"
										value={page.card}
										onChange={(v) => set("card", v)}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs text-muted-foreground">
										Light or dark
									</span>
									<Choice
										value={page.theme}
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
										value={page.heading_font}
										fonts={fonts}
										onChange={(v) => set("heading_font", v)}
									/>
									<FontPick
										label="Text"
										value={page.font}
										fonts={fonts}
										onChange={(v) => set("font", v)}
									/>
								</div>
							</Part>
							<Part title="Style">
								<Row label="Layout">
									<Choice
										value={page.layout}
										onChange={(v) => set("layout", v)}
										options={[
											["card", "Card"],
											["plain", "Plain"],
											["banner", "Banner"],
											["split", "Split"],
										]}
									/>
								</Row>
								<Row label="Above">
									<Choice
										value={page.mark}
										onChange={(v) => set("mark", v)}
										options={[
											["eyebrow", "Small title"],
											["icon", "Icon"],
											["none", "Nothing"],
										]}
									/>
								</Row>
								<Row label="Heading">
									<Choice
										value={page.heading_size}
										onChange={(v) => set("heading_size", v)}
										options={[
											["md", "Regular"],
											["lg", "Large"],
										]}
									/>
								</Row>
								<Row label="Align">
									<Choice
										value={page.align}
										onChange={(v) => set("align", v)}
										options={[
											["center", "Centered"],
											["left", "Left"],
										]}
									/>
								</Row>
								<Row label="Corners">
									<Choice
										value={page.corners}
										onChange={(v) => set("corners", v)}
										options={[
											["square", "Square"],
											["soft", "Soft"],
											["round", "Round"],
										]}
									/>
								</Row>
								{page.layout !== "plain" && (
									<Row label="Edges">
										<Choice
											value={page.borders ? "line" : "shadow"}
											onChange={(v) => set("borders", v === "line")}
											options={[
												["line", "Thin line"],
												["shadow", "Shadow"],
											]}
										/>
									</Row>
								)}
							</Part>
							<Part
								title="Words"
								hint="Leave a line empty for the default. {name} is the brand, {email} the reader's address."
							>
								<Row label="Language">
									<Choice
										value={page.language}
										onChange={(v) => set("language", v)}
										options={[
											["auto", "Reader's"],
											["en", "English"],
											["es", "Spanish"],
										]}
									/>
								</Row>
								{(page.mark === "eyebrow" || page.template === "editorial") &&
									textField("eyebrow")}
								{page.layout === "split" && textField("tagline")}
								{page.layout === "split" && textField("taglineBody", true)}
								{textField("ask")}
								{textField("who", true)}
								{textField("out")}
								{textField("done")}
								{textField("sorry", true)}
								{moreLines ? (
									<>
										{page.resubscribe && textField("back")}
										{page.resubscribe && textField("backDone")}
										{page.resubscribe && textField("backBody", true)}
										{textField("prefs")}
										{textField("save")}
										{textField("saved")}
									</>
								) : (
									<Button
										variant="outline"
										size="sm"
										className="self-start"
										onClick={() => setMoreLines(true)}
									>
										<ChevronDown />
										More lines
									</Button>
								)}
							</Part>
							<Part title="After they unsubscribe">
								<SwitchRow
									label="Let them subscribe again"
									hint="A button to undo it, right there."
									checked={page.resubscribe}
									onChange={(v) => set("resubscribe", v)}
								/>
								<div className="flex flex-col gap-1.5">
									<span className="text-xs text-muted-foreground">
										A link under the page
									</span>
									<div className="flex gap-1.5">
										<Input
											aria-label="Link label"
											placeholder="Back to our website"
											className="h-8 w-36 text-sm"
											value={page.link?.label ?? ""}
											onChange={(e) =>
												set("link", {
													label: e.target.value,
													url: page.link?.url ?? "",
												})
											}
										/>
										<Input
											aria-label="Link address"
											placeholder="https://"
											spellCheck={false}
											className="h-8 min-w-0 flex-1 text-sm"
											value={page.link?.url ?? ""}
											onChange={(e) =>
												set("link", {
													label: page.link?.label ?? "",
													url: e.target.value,
												})
											}
										/>
									</div>
								</div>
								<div className="flex flex-col gap-1.5">
									<label
										htmlFor="unsub-footer"
										className="text-xs text-muted-foreground"
									>
										Small print at the bottom
									</label>
									<Textarea
										id="unsub-footer"
										rows={2}
										placeholder="Harbor Inn · 12 Ocean Drive, Cancún"
										className="min-h-14 text-sm"
										value={page.footer}
										onChange={(e) => set("footer", e.target.value)}
									/>
								</div>
							</Part>
						</fieldset>
					</div>
					<Preview
						fields={{ ...page, state, lang }}
						theme={page.theme}
						height={600}
						draw={(_f, dark) =>
							previewSubscriberHtml(page, { dress, state, lang, dark })
						}
						toolbar={
							<>
								<Segments
									value={state}
									onChange={setState}
									options={[
										["ask", "Asking"],
										["done", "Unsubscribed"],
										...(page.resubscribe
											? ([["back", "Back"]] as [State, string][])
											: []),
									]}
								/>
								{page.language === "auto" && (
									<Segments
										value={lang}
										onChange={setLang}
										options={[
											["en", "EN"],
											["es", "ES"],
										]}
									/>
								)}
							</>
						}
					/>
				</div>
			</CardContent>
			{canEdit && (
				<CardFooter className="justify-end gap-2">
					{dirty && (
						<Button
							variant="ghost"
							disabled={!!busy}
							onClick={() => {
								setPage(saved);
								setCustom(saved.logo !== "brand" && saved.logo !== "none");
							}}
						>
							Discard
						</Button>
					)}
					<Button
						disabled={!dirty || !!busy}
						onClick={save}
					>
						{busy === "save" && <Spinner />}
						Save page
					</Button>
				</CardFooter>
			)}
		</Card>
	);
}

/** A small segmented switch for the preview's bar. */
function Segments<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (v: T) => void;
	options: [T, string][];
}) {
	return (
		<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
			{options.map(([v, label]) => (
				<button
					key={v}
					type="button"
					aria-pressed={value === v}
					onClick={() => onChange(v)}
					className={cn(
						"h-7 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground",
						value === v &&
							"bg-background text-foreground shadow-[0_0_0_1px_var(--border)] dark:bg-white/[0.1]",
					)}
				>
					{label}
				</button>
			))}
		</div>
	);
}

/** The size each template is drawn at before it's shrunk into its thumbnail. */
const THUMB = { w: 820, h: 640, scale: 0.25 };

/**
 * Ready-made pages, each drawn small with the brand's own logo, color and words, so picking one
 * shows exactly what it gives. Picking one changes only the look, never the words or links.
 */
function Templates({
	page,
	dress,
	onPick,
}: {
	page: SubscriberPage;
	dress: BrandDress;
	onPick: (id: string) => void;
}) {
	// Drawn again only when what they show of the brand changes, not on every change of look.
	const mine = JSON.stringify([page.logo, page.accent, page.language, page.texts]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: mine stands for page
	const thumbs = useMemo(
		() =>
			PAGE_TEMPLATES.map((t) => ({
				...t,
				html: previewSubscriberHtml(withTemplate(page, t.id), {
					dress,
					state: "ask",
					lang: page.language === "es" ? "es" : "en",
				}).replace("</head>", "<style>html,body{overflow:hidden}</style></head>"),
			})),
		[mine, dress],
	);
	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-baseline justify-between gap-3">
				<span className="text-sm font-medium">Start from a template</span>
				<span className="text-xs text-muted-foreground">
					Keeps your logo, color and words
				</span>
			</div>
			<div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pt-1 pb-2">
				{thumbs.map((t) => {
					const on = page.template === t.id;
					return (
						<button
							key={t.id}
							type="button"
							aria-pressed={on}
							onClick={() => onPick(t.id)}
							className="group flex shrink-0 snap-start flex-col gap-2 text-left outline-none"
						>
							<div
								className={cn(
									"relative overflow-hidden rounded-lg border border-border/70 bg-muted shadow-xs transition-[box-shadow,transform] group-hover:-translate-y-0.5 group-hover:shadow-md group-focus-visible:ring-[3px] group-focus-visible:ring-ring/50",
									on &&
										"ring-2 ring-primary ring-offset-2 ring-offset-background",
								)}
								style={{
									width: THUMB.w * THUMB.scale,
									height: THUMB.h * THUMB.scale,
								}}
							>
								<LiveFrame
									title={t.name}
									html={t.html}
									tabIndex={-1}
									aria-hidden
									loading="lazy"
									className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
									style={{
										width: THUMB.w,
										height: THUMB.h,
										transform: `scale(${THUMB.scale})`,
									}}
								/>
							</div>
							<div className="flex flex-col px-0.5">
								<span className="text-sm font-medium">{t.name}</span>
								<span className="text-xs text-muted-foreground">{t.hint}</span>
							</div>
						</button>
					);
				})}
			</div>
		</div>
	);
}
