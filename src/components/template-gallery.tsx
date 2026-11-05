import { Eye, LayoutGrid, Monitor, Smartphone } from "lucide-react";
import { useMemo, useState } from "react";
import { Thumb } from "@/components/email-builder";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type EmailDoc, renderEmail, type Theme } from "@/lib/email-doc";
import {
	buildStarter,
	CATEGORIES,
	type LogoChoice,
	STARTERS,
	type StarterDesign,
	type TemplateBrand,
	type TemplateCategory,
} from "@/lib/email-templates";
import { sampleFill } from "@/lib/merge-tags";
import { cn } from "@/lib/utils";

/** Which designs show first: what the email is. */
export type GalleryFor = "broadcast" | "newsletter" | "template";

const FIRST: Record<GalleryFor, TemplateCategory | "all"> = {
	broadcast: "all",
	newsletter: "newsletter",
	template: "all",
};

const LOGO_KEY = "mr:template-logo";
const readLogo = (): LogoChoice => {
	try {
		const v = localStorage.getItem(LOGO_KEY);
		return v === "off" || v === "rounded" || v === "circle" ? v : "original";
	} catch {
		return "original";
	}
};

/**
 * Ready-made designs to start an email from, each shown as the email itself with the brand's
 * logo (shown as it is, rounded, in a circle, or not at all) and, when it has a kit, its colors.
 */
type GalleryProps = {
	brand: TemplateBrand;
	/** Colors and fonts over each design's own (a newsletter's). */
	theme?: Partial<Theme>;
	/** The brand kit's look; offered as "Brand colors" (on by default). */
	kit?: Partial<Theme> | null;
	for?: GalleryFor;
	onPick: (d: EmailDoc) => void;
};

/**
 * The designs where an email's content starts: a few of them in place, and all of them, larger,
 * in a window of their own.
 */
export function TemplatePicker(props: GalleryProps) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<TemplateGallery
				{...props}
				limit={6}
				onMore={() => setOpen(true)}
			/>
			<Dialog
				open={open}
				onOpenChange={setOpen}
			>
				<DialogContent className="sm:h-[calc(100svh-4rem)] sm:max-w-6xl">
					<DialogHeader>
						<DialogTitle>Pick a design</DialogTitle>
						<DialogDescription>
							Each one is made with your logo and, if you have a brand kit, your
							colors. Everything in it can be changed.
						</DialogDescription>
					</DialogHeader>
					<div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
						{open && (
							<TemplateGallery
								{...props}
								onPick={(d) => {
									setOpen(false);
									props.onPick(d);
								}}
							/>
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

export function TemplateGallery({
	brand,
	theme,
	kit,
	for: kind = "broadcast",
	onPick,
	limit,
	onMore,
}: GalleryProps & {
	/** Show only this many, then a way to see them all. */
	limit?: number;
	onMore?: () => void;
}) {
	const [category, setCategory] = useState<TemplateCategory | "all">(FIRST[kind]);
	const [logo, setLogoState] = useState<LogoChoice>(readLogo);
	const [useKit, setUseKit] = useState(!!kit);
	const [preview, setPreview] = useState<StarterDesign | null>(null);
	const setLogo = (v: LogoChoice) => {
		setLogoState(v);
		try {
			localStorage.setItem(LOGO_KEY, v);
		} catch {}
	};
	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const look = useKit && kit ? { ...kit, ...theme } : (theme ?? null);
	const key = JSON.stringify([brand, look, logo]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: key stands for what the designs use
	const docs = useMemo(
		() =>
			new Map(
				STARTERS.map((s) => [s.id, buildStarter(s, brand, { logo, origin, kit: look })]),
			),
		[key, origin],
	);
	const all = STARTERS.filter((s) =>
		category === "all"
			? s.category !== "transactional" || kind === "template"
			: s.category === category,
	);
	// The transactional ones first for a template.
	const sorted =
		kind === "template" && category === "all"
			? [
					...all.filter((s) => s.category === "transactional"),
					...all.filter((s) => s.category !== "transactional"),
				]
			: all;
	const shown = limit ? sorted.slice(0, limit) : sorted;
	const pick = (s: StarterDesign) => {
		// A fresh copy, so two emails started from one design don't share block ids.
		onPick(buildStarter(s, brand, { logo, origin, kit: look }));
	};

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<div
					role="tablist"
					aria-label="Kinds of email"
					className="-mx-1 flex min-w-0 max-w-full gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
				>
					{[{ id: "all" as const, label: "All" }, ...CATEGORIES].map((c) => (
						<button
							key={c.id}
							type="button"
							role="tab"
							aria-selected={category === c.id}
							onClick={() => setCategory(c.id)}
							className={cn(
								"h-7 shrink-0 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition-colors",
								category === c.id
									? "bg-foreground text-background"
									: "text-muted-foreground hover:bg-muted hover:text-foreground",
							)}
						>
							{c.label}
						</button>
					))}
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
					<div className="flex items-center gap-2">
						<span className="text-xs text-muted-foreground">Logo</span>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={logo}
							onValueChange={(v) => v && setLogo(v as LogoChoice)}
							aria-label="How the logo shows"
						>
							{(
								[
									["off", "Off"],
									["original", "As is"],
									["rounded", "Rounded"],
									["circle", "Circle"],
								] as const
							).map(([v, l]) => (
								<ToggleGroupItem
									key={v}
									value={v}
									className="h-7 px-2.5 text-xs"
								>
									{l}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</div>
					{kit && (
						// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is a button, which a label names
						<label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
							<Switch
								checked={useKit}
								onCheckedChange={setUseKit}
							/>
							Brand colors
						</label>
					)}
				</div>
			</div>
			<div
				className={cn(
					"grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3",
					!limit && "lg:grid-cols-4",
				)}
			>
				{shown.map((s) => {
					const doc = docs.get(s.id) as EmailDoc;
					return (
						<div
							key={s.id}
							className="group relative flex min-w-0 flex-col gap-2.5"
						>
							<button
								type="button"
								onClick={() => pick(s)}
								aria-label={`Start from ${s.name}`}
								className="relative block aspect-[3/4] w-full overflow-hidden rounded-xl bg-muted shadow-[0_0_0_1px_var(--border)] transition-all group-hover:-translate-y-0.5 group-hover:shadow-[0_0_0_1px_var(--border),0_12px_24px_-12px_var(--shadow-color-strong)]"
							>
								<Thumb
									doc={doc}
									height={1100}
								/>
								<span className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/45 to-transparent pt-10 pb-3 opacity-0 transition-opacity group-hover:opacity-100">
									<span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-zinc-900 shadow">
										Use this design
									</span>
								</span>
							</button>
							<button
								type="button"
								onClick={() => setPreview(s)}
								aria-label={`Preview ${s.name}`}
								className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full bg-white/90 text-zinc-700 opacity-0 shadow-[0_0_0_1px_rgba(0,0,0,.08),0_2px_6px_-2px_rgba(0,0,0,.2)] backdrop-blur transition-opacity group-hover:opacity-100 hover:text-zinc-950 focus-visible:opacity-100 max-sm:opacity-100"
							>
								<Eye className="size-3.5" />
							</button>
							<span className="min-w-0">
								<span className="block truncate text-sm font-medium">{s.name}</span>
								<span className="block text-xs text-muted-foreground text-pretty">
									{s.hint}
								</span>
							</span>
						</div>
					);
				})}
			</div>
			{onMore && sorted.length > shown.length && (
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					onClick={onMore}
				>
					<LayoutGrid />
					See all {sorted.length} designs
				</Button>
			)}
			<PreviewDialog
				design={preview}
				doc={preview ? (docs.get(preview.id) ?? null) : null}
				onClose={() => setPreview(null)}
				onUse={() => {
					if (preview) pick(preview);
					setPreview(null);
				}}
			/>
		</div>
	);
}

function PreviewDialog({
	design,
	doc,
	onClose,
	onUse,
}: {
	design: StarterDesign | null;
	doc: EmailDoc | null;
	onClose: () => void;
	onUse: () => void;
}) {
	const [phone, setPhone] = useState(false);
	const html = useMemo(() => (doc ? sampleFill(renderEmail(doc)) : ""), [doc]);
	return (
		<Dialog
			open={!!design}
			onOpenChange={(o) => !o && onClose()}
		>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader className="flex-row items-start justify-between gap-4">
					<div className="min-w-0">
						<DialogTitle>{design?.name}</DialogTitle>
						<DialogDescription>{design?.hint}</DialogDescription>
					</div>
				</DialogHeader>
				<div className="relative min-h-0 flex-1 overflow-hidden border-y border-border/70 bg-muted/50">
					<div className="absolute top-3 right-3 z-10 flex items-center gap-0.5 rounded-md bg-background/90 p-0.5 shadow-[0_0_0_1px_var(--border)] backdrop-blur">
						{(
							[
								[false, Monitor, "Desktop"],
								[true, Smartphone, "Phone"],
							] as const
						).map(([v, Icon, label]) => (
							<button
								key={label}
								type="button"
								aria-label={label}
								aria-pressed={phone === v}
								onClick={() => setPhone(v)}
								className={cn(
									"flex size-7 items-center justify-center rounded text-muted-foreground",
									phone === v && "bg-muted text-foreground",
								)}
							>
								<Icon className="size-4" />
							</button>
						))}
					</div>
					<div className="flex h-[min(70svh,760px)] justify-center overflow-hidden">
						<iframe
							title="Preview"
							sandbox=""
							srcDoc={html}
							className={cn(
								"block h-full bg-white transition-[max-width]",
								phone
									? "my-4 h-[calc(100%-2rem)] w-full max-w-[375px] rounded-[24px] shadow-[0_0_0_1px_var(--border),0_24px_48px_-16px_var(--shadow-color-strong)]"
									: "w-full",
							)}
						/>
					</div>
				</div>
				<div className="flex justify-end gap-2 px-5 py-3">
					<Button
						variant="outline"
						size="sm"
						onClick={onClose}
					>
						Close
					</Button>
					<Button
						size="sm"
						onClick={onUse}
					>
						Use this design
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
