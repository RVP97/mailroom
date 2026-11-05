import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Code, Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BrandFilter } from "@/components/brand-filter";
import { Choice, ColorField, Group, Labeled, SwitchRow } from "@/components/design-controls";
import { ListSelect } from "@/components/list-dialogs";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { listFormsFn, saveFormFn } from "@/functions/signup-forms";
import { errorMessage } from "@/lib/errors";
import { useLiveFrame } from "@/lib/live-frame";
import {
	canvasPage,
	DEFAULT_DESIGN,
	type Display,
	FONT_INFO,
	FONTS,
	type FormDesign,
	type RenderInput,
	TEMPLATE_INFO,
	TEMPLATE_PRESETS,
	TEMPLATES,
	type Template,
	thumbnailPage,
} from "@/lib/signup-form-render";
import { cn } from "@/lib/utils";

/**
 * A sign-up form's builder: the form live on a sketch of a website in the middle, and what it
 * looks like, says and does in the panel beside it.
 */

export const Route = createFileRoute("/_app/contacts/forms/$id")({
	loader: () => listFormsFn(),
	head: () => ({ meta: [{ title: "Sign-up form · Mailroom" }] }),
	component: FormBuilder,
});

type Data = Awaited<ReturnType<typeof listFormsFn>>;
type SignupForm = Data["forms"][number];

type Fields = {
	brand?: string;
	name: string;
	title: string;
	from: string;
	segment_id: string;
	topic_id: string;
	website: string;
	redirect_url: string;
	ask_name: boolean;
	enabled: boolean;
	design: FormDesign;
};

const fieldsOf = (f: SignupForm | null, brand: string | undefined): Fields => ({
	brand: f?.brand_id ?? brand,
	name: f?.name ?? "",
	title: f?.title ?? "",
	from: f?.from ?? "",
	segment_id: f?.segment_id ?? "",
	topic_id: f?.topic_id ?? "",
	website: f?.website ?? "",
	redirect_url: f?.redirect_url ?? "",
	ask_name: f?.ask_name ?? false,
	enabled: f?.enabled ?? true,
	design: f?.design ?? DEFAULT_DESIGN,
});

type Palette = { name: string } & Pick<FormDesign, "accent" | "background" | "text">;

const PALETTES: Palette[] = [
	{ name: "Ink", accent: "#18181b", background: "#ffffff", text: "#18181b" },
	{ name: "Midnight", accent: "#a78bfa", background: "#0c0a14", text: "#f4f3ff" },
	{ name: "Ocean", accent: "#2563eb", background: "#ffffff", text: "#0f172a" },
	{ name: "Forest", accent: "#166534", background: "#f5f8f3", text: "#132a1b" },
	{ name: "Terracotta", accent: "#c2410c", background: "#fbf6f1", text: "#2a1609" },
	{ name: "Rose", accent: "#e11d48", background: "#fff8f9", text: "#2b0d14" },
	{ name: "Sand", accent: "#1c1917", background: "#f6f1e7", text: "#1c1917" },
	{ name: "Electric", accent: "#d9f99d", background: "#0a0a0a", text: "#fafafa" },
];

function FormBuilder() {
	const data = Route.useLoaderData();
	const { id } = Route.useParams();
	const router = useRouter();
	const navigate = useNavigate();
	const existing = id === "new" ? null : (data.forms.find((f) => f.id === id) ?? null);
	const first = data.brands[0]?.id;
	const [v, setV] = useState<Fields>(() => fieldsOf(existing, first));
	const [saved, setSaved] = useState(() => JSON.stringify(fieldsOf(existing, first)));
	const [busy, setBusy] = useState(false);
	const set = <K extends keyof Fields>(k: K, x: Fields[K]) => setV((f) => ({ ...f, [k]: x }));
	const look = (x: Partial<FormDesign>) => setV((f) => ({ ...f, design: { ...f.design, ...x } }));
	const brand = v.brand ?? first ?? "";
	const opts = data.options[brand];
	const dirty = JSON.stringify(v) !== saved;
	const turnstile = existing ? existing.turnstile : data.turnstileConfigured;

	if (id !== "new" && !existing)
		return (
			<div className="p-10 text-sm text-muted-foreground">
				This form doesn't exist anymore.{" "}
				<Link
					to="/contacts/forms"
					className="underline underline-offset-2"
				>
					Back to sign-up forms
				</Link>
			</div>
		);

	const input: RenderInput = {
		id: existing?.id ?? "frm_new",
		action: existing?.url ?? "#",
		title: v.title || "The newsletter",
		ask_name: v.ask_name,
		logo: data.logos[brand] ?? null,
		brand: data.brands.find((b) => b.id === brand)?.name,
	};

	const save = async () => {
		setBusy(true);
		try {
			const out = await saveFormFn({
				data: {
					id: existing?.id,
					fields: {
						brand: v.brand,
						name: v.name,
						title: v.title || v.name,
						from: v.from,
						segment_id: v.segment_id || null,
						topic_id: v.topic_id || null,
						website: v.website || null,
						redirect_url: v.redirect_url || null,
						ask_name: v.ask_name,
						enabled: v.enabled,
						design: v.design,
					},
				},
			});
			setSaved(JSON.stringify(v));
			toast.success(
				existing
					? "Saved. Websites with the script show it within a minute."
					: "Form created",
			);
			await router.invalidate();
			// A new form's next step is putting it on the website: its code opens.
			if (!existing) navigate({ to: "/contacts/forms", search: { code: out.id } });
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	const missing = !v.name.trim()
		? "Name it in Settings"
		: !v.from.trim()
			? "Set who the confirmation email is from, in Settings"
			: null;

	return (
		<div className="flex flex-col lg:h-[calc(100svh-1rem)]">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
				<Button
					variant="ghost"
					size="icon"
					asChild
				>
					<Link
						to="/contacts/forms"
						aria-label="Back to sign-up forms"
					>
						<ArrowLeft />
					</Link>
				</Button>
				<input
					aria-label="Form name"
					value={v.name}
					placeholder="Untitled form"
					onChange={(e) => set("name", e.target.value)}
					className="h-9 min-w-0 flex-1 rounded-md bg-transparent px-2 text-[15px] font-semibold outline-none placeholder:text-muted-foreground/70 hover:bg-muted/60 focus:bg-muted/60 sm:max-w-xs"
				/>
				<span className="hidden text-xs text-muted-foreground md:inline">
					{dirty ? "Unsaved changes" : existing ? "All changes saved" : ""}
				</span>
				<span className="flex-1" />
				{existing && (
					<Button
						variant="outline"
						className="hidden sm:inline-flex"
						asChild
					>
						<Link
							to="/contacts/forms"
							search={{ code: existing.id }}
						>
							<Code />
							Get the code
						</Link>
					</Button>
				)}
				<Button
					disabled={busy || !!missing || (!!existing && !dirty)}
					title={missing ?? undefined}
					onClick={save}
				>
					{busy && <Spinner />}
					{existing ? "Save" : "Create form"}
				</Button>
			</header>
			<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
				<Canvas
					input={input}
					design={v.design}
					turnstile={turnstile}
					host={hostOf(v.website)}
				/>
				<aside className="flex min-h-0 w-full shrink-0 flex-col border-border/70 lg:w-[400px] lg:border-l">
					<Tabs
						defaultValue={existing ? "design" : "design"}
						className="min-h-0 flex-1 gap-0"
					>
						<div className="border-b border-border/70 px-5">
							<TabsList variant="line">
								<TabsTrigger value="design">Design</TabsTrigger>
								<TabsTrigger value="content">Content</TabsTrigger>
								<TabsTrigger value="settings">
									Settings
									{missing && (
										<span className="size-1.5 rounded-full bg-amber-500" />
									)}
								</TabsTrigger>
							</TabsList>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							<TabsContent value="design">
								<DesignPanel
									input={input}
									design={v.design}
									look={look}
								/>
							</TabsContent>
							<TabsContent value="content">
								<ContentPanel
									v={v}
									set={set}
									look={look}
								/>
							</TabsContent>
							<TabsContent value="settings">
								<SettingsPanel
									v={v}
									set={set}
									setV={setV}
									data={data}
									existing={!!existing}
									opts={opts}
								/>
							</TabsContent>
						</div>
					</Tabs>
				</aside>
			</div>
		</div>
	);
}

const hostOf = (url: string) => {
	try {
		return new URL(url).hostname;
	} catch {
		return "yourwebsite.com";
	}
};

// ── The canvas ──────────────────────────────────────────────────────────────

function Canvas({
	input,
	design,
	turnstile,
	host,
}: {
	input: RenderInput;
	design: FormDesign;
	turnstile: boolean;
	host: string;
}) {
	const [phone, setPhone] = useState(false);
	// Switching between desktop and phone: the page fades out, the frame resizes, it fades back.
	const [resizing, setResizing] = useState(false);
	const timers = useRef<number[]>([]);
	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	const pickPhone = (x: boolean) => {
		if (x === phone) return;
		timers.current.forEach(clearTimeout);
		setResizing(true);
		timers.current = [
			window.setTimeout(() => setPhone(x), 140),
			window.setTimeout(() => setResizing(false), 520),
		];
	};
	const [state, setState] = useState<"form" | "done">("form");
	const [site, setSite] = useState<"light" | "dark">("light");
	const doc = useMemo(
		() =>
			canvasPage(input, design, {
				preview: state,
				sitekey: turnstile ? "preview" : null,
				site,
			}),
		[input, design, state, turnstile, site],
	);
	// What a change of template, placement or state swaps out; those fade in rather than snap.
	const kind = `${design.template}|${design.display}|${state}|${design.logo_position}`;
	const lastKind = useRef(kind);
	const frame = useLiveFrame(doc, (d, apply) => {
		const slot = d.querySelector<HTMLElement>(".mr-slot");
		const before = slot?.offsetHeight ?? 0;
		const swapped = lastKind.current !== kind;
		lastKind.current = kind;
		apply();
		const after = d.querySelector<HTMLElement>(".mr-slot");
		const ease = "cubic-bezier(.2,.8,.2,1)";
		// The page below the form glides to its new place instead of jumping.
		if (after && after === slot && before && after.offsetHeight !== before)
			after.animate(
				[
					{ height: `${before}px`, overflow: "clip", overflowClipMargin: "32px" },
					{
						height: `${after.offsetHeight}px`,
						overflow: "clip",
						overflowClipMargin: "32px",
					},
				],
				{ duration: 340, easing: ease },
			);
		if (swapped && design.display === "inline")
			d.querySelector(".mr-signup .mr-box")?.animate(
				[
					{ opacity: 0, transform: "translateY(6px) scale(.985)" },
					{ opacity: 1, transform: "none" },
				],
				{ duration: 300, easing: ease },
			);
	});
	const seg =
		"flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground";
	const on =
		"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]";
	return (
		<section className="relative flex min-h-[560px] min-w-0 flex-1 flex-col bg-muted/40 [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px] lg:min-h-0">
			<div className="flex flex-wrap items-center justify-center gap-2 px-4 pt-4">
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{(
						[
							["form", "Form"],
							["done", "Signed up"],
						] as const
					).map(([x, l]) => (
						<button
							key={x}
							type="button"
							aria-pressed={state === x}
							onClick={() => setState(x)}
							className={cn(seg, state === x && on)}
						>
							{l}
						</button>
					))}
				</div>
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{(
						[
							["light", Sun, "Light website"],
							["dark", Moon, "Dark website"],
						] as const
					).map(([x, Icon, l]) => (
						<button
							key={x}
							type="button"
							aria-label={l}
							title={l}
							aria-pressed={site === x}
							onClick={() => setSite(x)}
							className={cn(seg, site === x && on)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
				<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
					{(
						[
							[false, Monitor, "Desktop"],
							[true, Smartphone, "Phone"],
						] as const
					).map(([x, Icon, l]) => (
						<button
							key={l}
							type="button"
							aria-label={l}
							title={l}
							aria-pressed={phone === x}
							onClick={() => pickPhone(x)}
							className={cn(seg, phone === x && on)}
						>
							<Icon className="size-3.5" />
						</button>
					))}
				</div>
			</div>
			<div className="flex min-h-0 flex-1 items-stretch justify-center p-4 sm:p-6">
				<div
					className={cn(
						"flex w-full flex-col overflow-hidden border border-border/80 bg-background shadow-[0_1px_2px_var(--shadow-color),0_24px_48px_-24px_var(--shadow-color-strong)] transition-[max-width,border-radius] duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)]",
						phone ? "max-w-[390px] rounded-[28px]" : "max-w-[1180px] rounded-xl",
					)}
				>
					<div className="flex h-9 shrink-0 items-center gap-3 border-b border-border/70 bg-muted/50 px-3">
						{!phone && (
							<span className="flex gap-1.5">
								<i className="size-2.5 rounded-full bg-[#ff5f57]" />
								<i className="size-2.5 rounded-full bg-[#febc2e]" />
								<i className="size-2.5 rounded-full bg-[#28c840]" />
							</span>
						)}
						<span className="mx-auto max-w-[60%] truncate rounded-md bg-background/80 px-3 py-0.5 text-[11px] text-muted-foreground">
							{host}
						</span>
						{!phone && <span className="w-[42px]" />}
					</div>
					<iframe
						title="How the form looks on a website"
						ref={frame.ref}
						sandbox={frame.sandbox}
						srcDoc={frame.srcDoc}
						onLoad={frame.onLoad}
						className={cn(
							"block min-h-[480px] w-full flex-1 transition-opacity ease-out",
							resizing ? "opacity-0 duration-150" : "opacity-100 duration-300",
						)}
					/>
				</div>
			</div>
		</section>
	);
}

// ── Design ──────────────────────────────────────────────────────────────────

function Thumb({
	template,
	input,
	design,
	selected,
	onPick,
}: {
	template: Template;
	input: RenderInput;
	design: FormDesign;
	selected: boolean;
	onPick: () => void;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(0.3);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const measure = () => setScale(el.clientWidth / 680);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const doc = useMemo(
		() =>
			thumbnailPage(
				{ ...input, id: `thumb-${template}` },
				{ ...design, ...TEMPLATE_PRESETS[template], template },
			),
		[input, design, template],
	);
	const frame = useLiveFrame(doc);
	return (
		<button
			type="button"
			onClick={onPick}
			aria-pressed={selected}
			className="group flex flex-col gap-1.5 text-left"
		>
			<div
				ref={ref}
				className={cn(
					"relative aspect-[4/3] w-full overflow-hidden rounded-lg border bg-muted transition-[box-shadow,border-color]",
					selected
						? "border-foreground/70 shadow-[0_0_0_1px_var(--foreground)]"
						: "border-border group-hover:border-foreground/30",
				)}
			>
				<iframe
					title={TEMPLATE_INFO[template].name}
					ref={frame.ref}
					sandbox={frame.sandbox}
					srcDoc={frame.srcDoc}
					onLoad={frame.onLoad}
					tabIndex={-1}
					className="pointer-events-none absolute top-0 left-0 h-[510px] w-[680px] origin-top-left"
					style={{ transform: `scale(${scale})` }}
				/>
			</div>
			<span className="text-xs font-medium">{TEMPLATE_INFO[template].name}</span>
		</button>
	);
}

function DesignPanel({
	input,
	design: d,
	look,
}: {
	input: RenderInput;
	design: FormDesign;
	look: (x: Partial<FormDesign>) => void;
}) {
	const hasLogo = !!input.logo;
	return (
		<>
			<Group title="Template">
				<div className="grid grid-cols-2 gap-3">
					{TEMPLATES.map((t) => (
						<Thumb
							key={t}
							template={t}
							input={input}
							design={d}
							selected={d.template === t}
							onPick={() => look({ template: t, ...TEMPLATE_PRESETS[t] })}
						/>
					))}
				</div>
				<p className="text-xs text-muted-foreground">{TEMPLATE_INFO[d.template].hint}.</p>
				{d.template === "split" && (
					<Field>
						<FieldLabel htmlFor="form-image">Picture</FieldLabel>
						<Input
							id="form-image"
							type="url"
							spellCheck={false}
							placeholder="https://… (optional)"
							value={d.image_url}
							onChange={(e) => look({ image_url: e.target.value })}
						/>
						<FieldDescription>
							A link to a photo. Without one, the panel is your color.
						</FieldDescription>
					</Field>
				)}
			</Group>
			<Group title="Where it shows">
				<Choice<Display>
					value={d.display}
					onChange={(x) => look({ display: x })}
					options={[
						["inline", "In the page"],
						["popup", "Popup"],
						["slide_in", "Slide-in"],
						["bar", "Top bar"],
					]}
				/>
				{d.display === "popup" && (
					<Labeled label="Behind it">
						<Choice
							value={d.overlay}
							onChange={(x) => look({ overlay: x })}
							options={[
								["dim", "Dim"],
								["blur", "Blur"],
								["light", "Light"],
								["none", "None"],
							]}
						/>
					</Labeled>
				)}
				{d.display === "slide_in" && (
					<Labeled label="Corner">
						<Choice
							value={d.slide_position}
							onChange={(x) => look({ slide_position: x })}
							options={[
								["left", "Bottom left"],
								["right", "Bottom right"],
							]}
						/>
					</Labeled>
				)}
				{d.display === "bar" && (
					<>
						<Labeled label="Position">
							<Choice
								value={d.bar_position}
								onChange={(x) => look({ bar_position: x })}
								options={[
									["top", "Top"],
									["bottom", "Bottom"],
								]}
							/>
						</Labeled>
						<Labeled label="Style">
							<Choice
								value={d.bar_style}
								onChange={(x) => look({ bar_style: x })}
								options={[
									["floating", "Floating"],
									["full", "Full width"],
								]}
							/>
						</Labeled>
						<Labeled label="Color">
							<Choice
								value={d.bar_tone}
								onChange={(x) => look({ bar_tone: x })}
								options={[
									["surface", "Background"],
									["accent", "Button color"],
								]}
							/>
						</Labeled>
					</>
				)}
				{d.display !== "inline" && (
					<>
						<div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-2">
							<Field>
								<FieldLabel>Shows</FieldLabel>
								<Select
									value={d.trigger}
									onValueChange={(x) =>
										look({
											trigger: x as FormDesign["trigger"],
											trigger_value: x === "scroll" ? 40 : 8,
										})
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="delay">After a few seconds</SelectItem>
										<SelectItem value="scroll">After scrolling</SelectItem>
										<SelectItem value="exit">
											When they're about to leave
										</SelectItem>
									</SelectContent>
								</Select>
							</Field>
							{d.trigger !== "exit" && (
								<Field>
									<FieldLabel htmlFor="form-trigger">
										{d.trigger === "scroll" ? "Percent" : "Seconds"}
									</FieldLabel>
									<Input
										id="form-trigger"
										type="number"
										min={0}
										max={d.trigger === "scroll" ? 100 : 600}
										value={d.trigger_value}
										onChange={(e) =>
											look({ trigger_value: Number(e.target.value) || 0 })
										}
									/>
								</Field>
							)}
						</div>
						<Field>
							<FieldLabel htmlFor="form-frequency">
								After someone closes it
							</FieldLabel>
							<Select
								value={String(d.frequency_days)}
								onValueChange={(x) => look({ frequency_days: Number(x) })}
							>
								<SelectTrigger id="form-frequency">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="0">Show it again next visit</SelectItem>
									<SelectItem value="1">Wait a day</SelectItem>
									<SelectItem value="7">Wait a week</SelectItem>
									<SelectItem value="30">Wait a month</SelectItem>
									<SelectItem value="365">Don't show it again</SelectItem>
								</SelectContent>
							</Select>
							<FieldDescription>
								Once someone signs up, it never shows to them again.
							</FieldDescription>
						</Field>
					</>
				)}
			</Group>
			<Group title="Colors">
				<div className="grid grid-cols-4 gap-2">
					{PALETTES.map((p) => {
						const picked =
							d.accent === p.accent &&
							d.background === p.background &&
							d.text === p.text;
						return (
							<button
								key={p.name}
								type="button"
								aria-pressed={picked}
								onClick={() =>
									look({
										accent: p.accent,
										background: p.background,
										text: p.text,
									})
								}
								className="group flex flex-col items-center gap-1.5"
							>
								<span
									className={cn(
										"flex h-11 w-full flex-col justify-end gap-1 rounded-lg border p-1.5 transition-[box-shadow,border-color]",
										picked
											? "border-foreground/70 shadow-[0_0_0_1px_var(--foreground)]"
											: "border-border group-hover:border-foreground/30",
									)}
									style={{ background: p.background }}
								>
									<i
										className="block h-1 w-3/4 rounded-full opacity-60"
										style={{ background: p.text }}
									/>
									<i
										className="block h-2.5 w-full rounded-[3px]"
										style={{ background: p.accent }}
									/>
								</span>
								<span className="text-[11px] text-muted-foreground group-aria-pressed:text-foreground">
									{p.name}
								</span>
							</button>
						);
					})}
				</div>
				<div className="grid grid-cols-3 gap-2">
					<ColorField
						label="Button"
						value={d.accent}
						onChange={(x) => look({ accent: x })}
					/>
					<ColorField
						label="Background"
						value={d.background}
						onChange={(x) => look({ background: x })}
					/>
					<ColorField
						label="Text"
						value={d.text}
						onChange={(x) => look({ text: x })}
					/>
				</div>
				<SwitchRow
					label="Gradient"
					hint="A soft glow of your button color."
					checked={d.gradient}
					onChange={(x) => look({ gradient: x })}
				/>
			</Group>
			<Group title="Logo">
				<SwitchRow
					label="Show the brand's logo"
					hint={
						hasLogo
							? undefined
							: "This brand has no logo yet: add one in Settings › Organization."
					}
					checked={d.show_logo}
					onChange={(x) => look({ show_logo: x })}
				/>
				{d.show_logo && (
					<>
						<Labeled label="Shape">
							<Choice
								value={d.logo_shape}
								onChange={(x) => look({ logo_shape: x })}
								options={[
									["original", "As is"],
									["rounded", "Rounded"],
									["circle", "Circle"],
								]}
							/>
						</Labeled>
						<Labeled label="Size">
							<Choice
								value={d.logo_size}
								onChange={(x) => look({ logo_size: x })}
								options={[
									["small", "S"],
									["medium", "M"],
									["large", "L"],
								]}
							/>
						</Labeled>
						{d.template !== "split" && d.display !== "bar" && (
							<Labeled label="Place">
								<Choice
									value={d.logo_position}
									onChange={(x) => look({ logo_position: x })}
									options={[
										["top", "Above title"],
										["beside", "Beside title"],
									]}
								/>
							</Labeled>
						)}
					</>
				)}
			</Group>
			<Group title="Box">
				<Labeled label="Width">
					<Choice
						value={d.width}
						onChange={(x) => look({ width: x })}
						options={[
							["narrow", "Narrow"],
							["regular", "Regular"],
							["wide", "Wide"],
						]}
					/>
				</Labeled>
				<Labeled label="Border">
					<Choice
						value={d.border}
						onChange={(x) => look({ border: x })}
						options={[
							["none", "None"],
							["subtle", "Subtle"],
							["accent", "Color"],
						]}
					/>
				</Labeled>
				<Labeled label="Corners">
					<Choice
						value={d.radius}
						onChange={(x) => look({ radius: x })}
						options={[
							["none", "None"],
							["small", "S"],
							["medium", "M"],
							["large", "L"],
							["full", "Pill"],
						]}
					/>
				</Labeled>
				<Labeled label="Spacing">
					<Choice
						value={d.size}
						onChange={(x) => look({ size: x })}
						options={[
							["compact", "Compact"],
							["regular", "Regular"],
							["large", "Roomy"],
						]}
					/>
				</Labeled>
				<SwitchRow
					label="Shadow"
					checked={d.shadow}
					onChange={(x) => look({ shadow: x })}
				/>
			</Group>
			<Group title="Text and fields">
				<Field>
					<FieldLabel>Font</FieldLabel>
					<Select
						value={d.font}
						onValueChange={(x) => look({ font: x as FormDesign["font"] })}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FONTS.map((x) => (
								<SelectItem
									key={x}
									value={x}
								>
									{FONT_INFO[x].name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
				<Labeled label="Title">
					<Choice
						value={d.title_size}
						onChange={(x) => look({ title_size: x })}
						options={[
							["small", "Small"],
							["regular", "Regular"],
							["large", "Large"],
						]}
					/>
				</Labeled>
				<Labeled label="Button">
					<Choice
						value={d.button_style}
						onChange={(x) => look({ button_style: x })}
						options={[
							["solid", "Solid"],
							["soft", "Soft"],
							["outline", "Outline"],
						]}
					/>
				</Labeled>
				<Labeled label="Fields">
					<Choice
						value={d.fields}
						onChange={(x) => look({ fields: x })}
						options={[
							["outline", "Outline"],
							["filled", "Filled"],
							["underline", "Underline"],
						]}
					/>
				</Labeled>
				<Labeled label="Align">
					<Choice
						value={d.align}
						onChange={(x) => look({ align: x })}
						options={[
							["left", "Left"],
							["center", "Center"],
						]}
					/>
				</Labeled>
			</Group>
		</>
	);
}

// ── Content ─────────────────────────────────────────────────────────────────

function ContentPanel({
	v,
	set,
	look,
}: {
	v: Fields;
	set: <K extends keyof Fields>(k: K, x: Fields[K]) => void;
	look: (x: Partial<FormDesign>) => void;
}) {
	const d = v.design;
	return (
		<>
			<Group title="Header">
				<Field>
					<FieldLabel htmlFor="form-eyebrow">Small line on top</FieldLabel>
					<Input
						id="form-eyebrow"
						placeholder="Newsletter (optional)"
						value={d.eyebrow}
						onChange={(e) => look({ eyebrow: e.target.value })}
					/>
				</Field>
				<Field>
					<div className="flex items-center justify-between">
						<FieldLabel htmlFor="form-title">Title</FieldLabel>
						<Switch
							aria-label="Show the title"
							checked={d.show_title}
							onCheckedChange={(x) => look({ show_title: x })}
						/>
					</div>
					<Input
						id="form-title"
						placeholder="The Harbor newsletter"
						value={v.title}
						onChange={(e) => set("title", e.target.value)}
					/>
					<FieldDescription>
						Also what the confirmation email says they signed up for.
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-description">Description</FieldLabel>
					<Textarea
						id="form-description"
						rows={3}
						value={d.description}
						onChange={(e) => look({ description: e.target.value })}
					/>
				</Field>
			</Group>
			<Group title="Fields">
				<SwitchRow
					label="Ask for their first name"
					checked={v.ask_name}
					onChange={(x) => set("ask_name", x)}
				/>
				{v.ask_name && (
					<Field>
						<FieldLabel htmlFor="form-name-label">Name field</FieldLabel>
						<Input
							id="form-name-label"
							value={d.name_label}
							onChange={(e) => look({ name_label: e.target.value })}
						/>
					</Field>
				)}
				<Field>
					<FieldLabel htmlFor="form-placeholder">Email field</FieldLabel>
					<Input
						id="form-placeholder"
						value={d.email_placeholder}
						onChange={(e) => look({ email_placeholder: e.target.value })}
					/>
				</Field>
				<SwitchRow
					label="Labels above the fields"
					checked={d.show_labels}
					onChange={(x) => look({ show_labels: x })}
				/>
				{d.show_labels && (
					<Field>
						<FieldLabel htmlFor="form-email-label">Email label</FieldLabel>
						<Input
							id="form-email-label"
							value={d.email_label}
							onChange={(e) => look({ email_label: e.target.value })}
						/>
					</Field>
				)}
				<Field>
					<FieldLabel htmlFor="form-button">Button</FieldLabel>
					<Input
						id="form-button"
						value={d.button}
						onChange={(e) => look({ button: e.target.value })}
					/>
				</Field>
			</Group>
			<Group title="Under the form">
				<Field>
					<FieldLabel htmlFor="form-proof">Social proof</FieldLabel>
					<Input
						id="form-proof"
						placeholder="Join 2,400+ readers (optional)"
						value={d.proof}
						onChange={(e) => look({ proof: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-fine">Fine print</FieldLabel>
					<Input
						id="form-fine"
						placeholder="Unsubscribe anytime. (optional)"
						value={d.fine_print}
						onChange={(e) => look({ fine_print: e.target.value })}
					/>
				</Field>
			</Group>
			<Group title="After they sign up">
				<Field>
					<FieldLabel htmlFor="form-success-title">Heading</FieldLabel>
					<Input
						id="form-success-title"
						value={d.success_title}
						onChange={(e) => look({ success_title: e.target.value })}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-success">Message</FieldLabel>
					<Textarea
						id="form-success"
						rows={2}
						value={d.success}
						onChange={(e) => look({ success: e.target.value })}
					/>
					<FieldDescription>Switch the canvas to “Signed up” to see it.</FieldDescription>
				</Field>
			</Group>
		</>
	);
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsPanel({
	v,
	set,
	setV,
	data,
	existing,
	opts,
}: {
	v: Fields;
	set: <K extends keyof Fields>(k: K, x: Fields[K]) => void;
	setV: (f: (x: Fields) => Fields) => void;
	data: Data;
	existing: boolean;
	opts: Data["options"][string] | undefined;
}) {
	return (
		<>
			<Group title="Who signs up">
				{!existing && data.brands.length > 1 && (
					<Field>
						<FieldLabel>Brand</FieldLabel>
						<BrandFilter
							brands={data.brands}
							value={v.brand}
							all={null}
							onChange={(b) =>
								setV((f) => ({
									...f,
									brand: b,
									segment_id: "",
									topic_id: "",
									from: "",
								}))
							}
							className="w-full sm:w-full"
						/>
					</Field>
				)}
				<Field>
					<FieldLabel htmlFor="form-name">Name</FieldLabel>
					<Input
						id="form-name"
						placeholder="Website footer"
						value={v.name}
						onChange={(e) => set("name", e.target.value)}
					/>
					<FieldDescription>Only you see it.</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-segment">Add them to</FieldLabel>
					<ListSelect
						kind="segment"
						id="form-segment"
						brand={v.brand}
						value={v.segment_id}
						onChange={(x) => set("segment_id", x)}
						items={opts?.segments ?? []}
						none="No segment"
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-topic">Subscribe them to</FieldLabel>
					<ListSelect
						kind="topic"
						id="form-topic"
						brand={v.brand}
						value={v.topic_id}
						onChange={(x) => set("topic_id", x)}
						items={opts?.topics ?? []}
						none="No topic"
					/>
				</Field>
			</Group>
			<Group title="Confirmation">
				<Field>
					<FieldLabel htmlFor="form-from">Email it from</FieldLabel>
					<Input
						id="form-from"
						type="email"
						spellCheck={false}
						list="form-from-domains"
						placeholder={
							opts?.domains[0] ? `hola@${opts.domains[0]}` : "hola@yourdomain.com"
						}
						value={v.from}
						onChange={(e) => set("from", e.target.value)}
					/>
					<datalist id="form-from-domains">
						{opts?.domains.map((x) => (
							<option
								key={x}
								value={`hola@${x}`}
							/>
						))}
					</datalist>
					<FieldDescription>
						{opts?.domains.length
							? `People confirm by clicking a link in this email. An address on ${opts.domains.join(", ")}.`
							: "This brand needs a verified sending domain first."}
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="form-redirect">After confirming, go to</FieldLabel>
					<Input
						id="form-redirect"
						type="url"
						spellCheck={false}
						placeholder="https://… (optional)"
						value={v.redirect_url}
						onChange={(e) => set("redirect_url", e.target.value)}
					/>
					<FieldDescription>Empty: Mailroom's “You're subscribed” page.</FieldDescription>
				</Field>
			</Group>
			<Group title="Website">
				<Field>
					<FieldLabel htmlFor="form-website">Where it's used</FieldLabel>
					<Input
						id="form-website"
						type="url"
						spellCheck={false}
						placeholder="https://harborinn.com"
						value={v.website}
						onChange={(e) => set("website", e.target.value)}
					/>
					<FieldDescription>
						Mailroom lets Cloudflare Turnstile run there, so bots can't sign up.
					</FieldDescription>
				</Field>
				<SwitchRow
					label="Taking sign-ups"
					hint="Off, it disappears from websites."
					checked={v.enabled}
					onChange={(x) => set("enabled", x)}
				/>
			</Group>
		</>
	);
}
