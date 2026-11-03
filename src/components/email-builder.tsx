import {
	AlignCenter,
	AlignLeft,
	AlignRight,
	ArrowDown,
	ArrowLeft,
	ArrowUp,
	Bold,
	BookmarkPlus,
	Braces,
	Code2,
	Columns2,
	Copy,
	GripVertical,
	Heading,
	ImageIcon,
	Italic,
	Link2,
	List,
	ListOrdered,
	MessageSquare,
	Minus,
	Monitor,
	MousePointerClick,
	Paintbrush,
	Plus,
	Quote,
	Share2,
	Smartphone,
	Sparkles,
	Square,
	Trash2,
	Type,
	Underline,
	Upload,
	Vote,
} from "lucide-react";
import {
	type CSSProperties,
	createContext,
	type DragEvent,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { Choice, ColorField, Group, Labeled, SwitchRow } from "@/components/design-controls";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ChipPopover, DEFAULT_GROUPS, TagText, VariableMenu } from "@/components/variables";
import { deleteSectionFn, saveSectionFn, sectionsFn } from "@/functions/collab";
import { uploadMediaFn } from "@/functions/media";
import { type BrandKit, kitSwatches, kitTheme } from "@/lib/brand-kit";
import {
	type Align,
	type Block,
	type BlockType,
	blockInner,
	type ColumnsBlock,
	cloneBlock,
	bodyStack,
	type EmailDoc,
	FONTS,
	type FontKey,
	fontFaceCss,
	gapAbove,
	headingStack,
	type LeafBlock,
	MERGE_TAGS,
	mix,
	newBlock,
	onColor,
	renderEmail,
	starter,
	type Theme,
} from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";
import {
	CHIP,
	chipsHtml,
	htmlWithTags,
	sampleFill,
	TAG,
	tagOf,
	type Variable,
	type VariableGroup,
} from "@/lib/merge-tags";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * The visual email editor: blocks dragged onto a canvas that looks as the email will, text
 * written in place, and each block's (or the whole email's) settings beside it.
 */

type Brand = { logo: string | null; name: string };

const BLOCKS: { type: BlockType; label: string; icon: typeof Type }[] = [
	{ type: "heading", label: "Heading", icon: Heading },
	{ type: "text", label: "Text", icon: Type },
	{ type: "button", label: "Button", icon: MousePointerClick },
	{ type: "image", label: "Image", icon: ImageIcon },
	{ type: "columns", label: "Columns", icon: Columns2 },
	{ type: "divider", label: "Divider", icon: Minus },
	{ type: "spacer", label: "Spacer", icon: Square },
	{ type: "quote", label: "Quote", icon: Quote },
	{ type: "logo", label: "Logo", icon: Sparkles },
	{ type: "social", label: "Links", icon: Share2 },
	{ type: "footer", label: "Footer", icon: Paintbrush },
	{ type: "html", label: "HTML", icon: Code2 },
];
/** Only where Mailroom fills its links (broadcasts). */
const POLL = { type: "poll" as BlockType, label: "Poll", icon: Vote };
const LABEL = Object.fromEntries([...BLOCKS, POLL].map((b) => [b.type, b.label])) as Record<
	BlockType,
	string
>;

type Palette = { name: string } & Pick<
	Theme,
	"background" | "surface" | "text" | "heading" | "accent" | "button_text"
>;
const PALETTES: Palette[] = [
	{
		name: "Paper",
		background: "#f4f4f5",
		surface: "#ffffff",
		text: "#3f3f46",
		heading: "#18181b",
		accent: "#18181b",
		button_text: "#ffffff",
	},
	{
		name: "Indigo",
		background: "#eef2ff",
		surface: "#ffffff",
		text: "#475569",
		heading: "#1e1b4b",
		accent: "#4f46e5",
		button_text: "#ffffff",
	},
	{
		name: "Ocean",
		background: "#e0f2fe",
		surface: "#ffffff",
		text: "#334155",
		heading: "#0c4a6e",
		accent: "#0284c7",
		button_text: "#ffffff",
	},
	{
		name: "Forest",
		background: "#ecfdf5",
		surface: "#ffffff",
		text: "#3f4b45",
		heading: "#14342b",
		accent: "#15803d",
		button_text: "#ffffff",
	},
	{
		name: "Terracotta",
		background: "#fbf3ee",
		surface: "#fffdfb",
		text: "#57443b",
		heading: "#3b2016",
		accent: "#c2410c",
		button_text: "#ffffff",
	},
	{
		name: "Rose",
		background: "#fff1f2",
		surface: "#ffffff",
		text: "#52525b",
		heading: "#4c0519",
		accent: "#e11d48",
		button_text: "#ffffff",
	},
	{
		name: "Sand",
		background: "#f5f0e6",
		surface: "#fffcf5",
		text: "#4a443a",
		heading: "#2a251c",
		accent: "#a16207",
		button_text: "#ffffff",
	},
	{
		name: "Night",
		background: "#09090b",
		surface: "#18181b",
		text: "#d4d4d8",
		heading: "#fafafa",
		accent: "#a78bfa",
		button_text: "#0b0b0f",
	},
];

// ── The document's tree ─────────────────────────────────────────────────────

/** Where a block sits: the email itself, or one column of a columns block. */
type Place = { parent: null } | { parent: string; col: 0 | 1 };
type Spot = Place & { index: number };

const listAt = (blocks: Block[], p: Place): Block[] => {
	if (p.parent === null) return blocks;
	const c = blocks.find((b) => b.id === p.parent) as ColumnsBlock | undefined;
	return c?.columns[p.col] ?? [];
};

function withList(blocks: Block[], p: Place, fn: (list: Block[]) => Block[]): Block[] {
	if (p.parent === null) return fn(blocks);
	return blocks.map((b) => {
		if (b.id !== p.parent || b.type !== "columns") return b;
		const cols = [...b.columns] as ColumnsBlock["columns"];
		cols[p.col] = fn(cols[p.col]) as LeafBlock[];
		return { ...b, columns: cols };
	});
}

function locate(blocks: Block[], id: string): (Spot & { block: Block }) | null {
	for (const [i, b] of blocks.entries()) {
		if (b.id === id) return { parent: null, index: i, block: b };
		if (b.type === "columns")
			for (const col of [0, 1] as const) {
				const j = b.columns[col].findIndex((x) => x.id === id);
				if (j >= 0)
					return { parent: b.id, col, index: j, block: b.columns[col][j] as Block };
			}
	}
	return null;
}

function updateBlock(blocks: Block[], id: string, patch: Partial<Block>): Block[] {
	const at = locate(blocks, id);
	if (!at) return blocks;
	return withList(blocks, at, (l) =>
		l.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)),
	);
}

function removeBlock(blocks: Block[], id: string): Block[] {
	const at = locate(blocks, id);
	if (!at) return blocks;
	return withList(blocks, at, (l) => l.filter((b) => b.id !== id));
}

function insertBlock(blocks: Block[], spot: Spot, b: Block): Block[] {
	if (spot.parent !== null && b.type === "columns") return blocks;
	return withList(blocks, spot, (l) => [...l.slice(0, spot.index), b, ...l.slice(spot.index)]);
}

function moveBlock(blocks: Block[], id: string, to: Spot): Block[] {
	const from = locate(blocks, id);
	if (!from) return blocks;
	if (to.parent !== null && (from.block.type === "columns" || to.parent === id)) return blocks;
	const same =
		from.parent === to.parent &&
		(from.parent === null || ("col" in from && "col" in to && from.col === to.col));
	const index = same && from.index < to.index ? to.index - 1 : to.index;
	return insertBlock(removeBlock(blocks, id), { ...to, index }, from.block);
}

// ── Shared state ────────────────────────────────────────────────────────────

type Ctx = {
	doc: EmailDoc;
	selected: string | null;
	select: (id: string | null) => void;
	patch: (id: string, p: Partial<Block>) => void;
	setBlocks: (fn: (b: Block[]) => Block[]) => void;
	drop: Spot | null;
	setDrop: (s: Spot | null) => void;
	onDrop: (e: DragEvent, spot: Spot) => void;
	brand: Brand;
	phone: boolean;
	variables: VariableGroup[];
	blocks: typeof BLOCKS;
	kit: BrandKit | null;
	/** Comment on a block (the email's comment thread). */
	onComment?: (id: string, label: string) => void;
	/** Save a block as a team section. */
	saveSection: (b: Block) => void;
};
const BuilderCtx = createContext<Ctx | null>(null);
const useB = () => useContext(BuilderCtx) as Ctx;

const DRAG_NEW = "application/x-mailroom-block";
const DRAG_MOVE = "application/x-mailroom-move";

// ── The editor ──────────────────────────────────────────────────────────────

export function EmailBuilder({
	doc,
	onChange,
	brand,
	title,
	onClose,
	actions,
	subject,
	previewText,
	variables = DEFAULT_GROUPS,
	polls = false,
	kit = null,
	onComment,
	focus = null,
}: {
	doc: EmailDoc;
	onChange: (d: EmailDoc) => void;
	brand: Brand;
	title: string;
	onClose: () => void;
	actions?: ReactNode;
	subject?: string;
	previewText?: string;
	/** The variables its { } menu offers (the contact's by default). */
	variables?: VariableGroup[];
	/** Offer the poll block (broadcasts, whose poll links Mailroom fills per contact). */
	polls?: boolean;
	/** The brand's kit: its colors first in pickers, its fonts, "Apply brand kit". */
	kit?: BrandKit | null;
	onComment?: (id: string, label: string) => void;
	/** A block to open selected (one a comment is on). */
	focus?: string | null;
}) {
	const blocks = polls ? [...BLOCKS.slice(0, 4), POLL, ...BLOCKS.slice(4)] : BLOCKS;
	const [selected, select] = useState<string | null>(focus);
	useEffect(() => {
		if (focus)
			document.querySelector(`[data-block="${focus}"]`)?.scrollIntoView({ block: "center" });
	}, [focus]);
	const [drop, setDrop] = useState<Spot | null>(null);
	const [phone, setPhone] = useState(false);
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const [side, setSide] = useState<"blocks" | "saved">("blocks");
	const [saving, setSaving] = useState<Block | null>(null);
	const sections = useSections();
	const docRef = useRef(doc);
	docRef.current = doc;
	const setBlocks = (fn: (b: Block[]) => Block[]) =>
		onChange({ ...docRef.current, blocks: fn(docRef.current.blocks) });
	const patch = (id: string, p: Partial<Block>) => setBlocks((b) => updateBlock(b, id, p));
	const setTheme = (p: Partial<Theme>) =>
		onChange({ ...docRef.current, theme: { ...docRef.current.theme, ...p } });

	const onDrop = (e: DragEvent, spot: Spot) => {
		e.preventDefault();
		e.stopPropagation();
		setDrop(null);
		const type = e.dataTransfer.getData(DRAG_NEW) as BlockType;
		const move = e.dataTransfer.getData(DRAG_MOVE);
		if (type) {
			if (spot.parent !== null && type === "columns") return;
			const b = newBlock(type, brand);
			setBlocks((l) => insertBlock(l, spot, b));
			select(b.id);
		} else if (move) setBlocks((l) => moveBlock(l, move, spot));
	};

	/** Adds a block after the selected one (or at the end). */
	const add = (type: BlockType) => {
		const b = newBlock(type, brand);
		setBlocks((l) => {
			const at = selected ? locate(l, selected) : null;
			if (at && !(at.parent !== null && type === "columns"))
				return insertBlock(l, { ...at, index: at.index + 1 }, b);
			// Before the footer, if the email ends with one.
			const last = l[l.length - 1];
			const index = last?.type === "footer" && type !== "footer" ? l.length - 1 : l.length;
			return insertBlock(l, { parent: null, index }, b);
		});
		select(b.id);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")
			)
				return;
			if (e.key === "Escape") select(null);
			if ((e.key === "Backspace" || e.key === "Delete") && selected) {
				e.preventDefault();
				setBlocks((l) => removeBlock(l, selected));
				select(null);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	const ctx: Ctx = {
		doc,
		selected,
		select,
		patch,
		setBlocks,
		drop,
		setDrop,
		onDrop,
		brand,
		phone,
		variables,
		blocks,
		kit,
		onComment,
		saveSection: setSaving,
	};
	const current = selected ? locate(doc.blocks, selected)?.block : null;

	/** A saved section's blocks (fresh copies) after the selected block, or at the end. */
	const insertSection = (list: Block[]) => {
		const copies = list.map(cloneBlock);
		if (!copies.length) return;
		setBlocks((l) => {
			const at = selected ? locate(l, selected) : null;
			const top = at && at.parent === null ? at.index + 1 : null;
			const last = l[l.length - 1];
			const index = top ?? (last?.type === "footer" ? l.length - 1 : l.length);
			return [...l.slice(0, index), ...copies, ...l.slice(index)];
		});
		select(copies[0]?.id ?? null);
	};

	return (
		<BuilderCtx.Provider value={ctx}>
			<div className="fixed inset-0 z-50 flex flex-col bg-background">
				<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 px-3 sm:px-4">
					<Button
						variant="ghost"
						size="icon"
						aria-label="Back"
						onClick={onClose}
					>
						<ArrowLeft />
					</Button>
					<span className="min-w-0 truncate text-[15px] font-semibold">{title}</span>
					<span className="flex-1" />
					<div className="flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
						{(["edit", "preview"] as const).map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={mode === m}
								onClick={() => {
									setMode(m);
									select(null);
								}}
								className={cn(
									"h-7 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
									mode === m &&
										"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
								)}
							>
								{m === "edit" ? "Edit" : "Preview"}
							</button>
						))}
					</div>
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
										"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
								)}
							>
								<w.icon className="size-4" />
							</button>
						))}
					</div>
					<span className="flex-1" />
					{actions}
				</header>
				<div className="flex min-h-0 flex-1">
					{mode === "edit" && (
						<aside className="hidden w-[232px] shrink-0 flex-col overflow-y-auto border-r border-border/70 md:flex">
							<div className="mx-4 mt-4 flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
								{(
									[
										["blocks", "Blocks"],
										["saved", "Saved"],
									] as const
								).map(([k, l]) => (
									<button
										key={k}
										type="button"
										aria-pressed={side === k}
										onClick={() => setSide(k)}
										className={cn(
											"h-7 flex-1 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground",
											side === k &&
												"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
										)}
									>
										{l}
										{k === "saved" && sections.rows?.length ? (
											<span className="ml-1 text-muted-foreground tabular-nums">
												{sections.rows.length}
											</span>
										) : null}
									</button>
								))}
							</div>
							{side === "saved" ? (
								<SavedSections
									sections={sections}
									onInsert={insertSection}
								/>
							) : (
								<>
									<p className="px-4 pt-4 pb-2 text-xs font-medium text-muted-foreground">
										Drag onto the email, or click to add
									</p>
									<div className="grid grid-cols-2 gap-2 px-4 pb-4">
										{blocks.map((b) => (
											<button
												key={b.type}
												type="button"
												draggable
												onDragStart={(e) => {
													e.dataTransfer.setData(DRAG_NEW, b.type);
													e.dataTransfer.effectAllowed = "copy";
												}}
												onClick={() => add(b.type)}
												className="group flex aspect-[5/4] cursor-grab flex-col items-center justify-center gap-2 rounded-lg border border-border/80 bg-card text-[12.5px] font-medium text-muted-foreground shadow-[0_1px_2px_var(--shadow-color)] transition-all hover:-translate-y-px hover:border-foreground/25 hover:text-foreground hover:shadow-[0_4px_12px_-4px_var(--shadow-color-strong)] active:cursor-grabbing"
											>
												<b.icon className="size-[18px] text-foreground/70 transition-colors group-hover:text-foreground" />
												{b.label}
											</button>
										))}
									</div>
									<div className="mt-auto border-t border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
										Select a block to change it. Delete removes it, Esc goes
										back to the email's style.
									</div>
								</>
							)}
						</aside>
					)}
					<main
						className="min-w-0 flex-1 overflow-y-auto bg-muted/50"
						onClick={() => select(null)}
						onKeyDown={undefined}
					>
						{mode === "edit" ? (
							<Canvas
								subject={subject}
								previewText={previewText}
							/>
						) : (
							<PreviewFrame
								doc={doc}
								phone={phone}
							/>
						)}
					</main>
					{mode === "edit" && (
						<aside className="hidden w-[320px] shrink-0 flex-col overflow-y-auto border-l border-border/70 lg:flex">
							{current ? (
								<BlockPanel
									key={current.id}
									block={current}
								/>
							) : (
								<StylePanel
									theme={doc.theme}
									set={setTheme}
									kit={kit}
								/>
							)}
						</aside>
					)}
				</div>
			</div>
			<SaveSectionDialog
				block={saving}
				onOpenChange={(o) => !o && setSaving(null)}
				onSaved={() => {
					setSaving(null);
					setSide("saved");
					void sections.load();
				}}
			/>
		</BuilderCtx.Provider>
	);
}

function PreviewFrame({ doc, phone }: { doc: EmailDoc; phone: boolean }) {
	const html = useMemo(() => sampleFill(renderEmail(doc)), [doc]);
	return (
		<div className={cn("flex min-h-full justify-center", phone ? "px-4 py-8" : "")}>
			<iframe
				title="Preview"
				sandbox=""
				srcDoc={html}
				className={cn(
					"block w-full bg-white",
					phone
						? "h-[760px] max-w-[390px] rounded-[28px] shadow-[0_0_0_1px_var(--border),0_24px_48px_-16px_var(--shadow-color-strong)]"
						: "min-h-[calc(100svh-3.5rem)]",
				)}
			/>
		</div>
	);
}

// ── The canvas ──────────────────────────────────────────────────────────────

function Canvas({ subject, previewText }: { subject?: string; previewText?: string }) {
	const { doc, phone, drop, setDrop, onDrop, brand, variables } = useB();
	const t = doc.theme;
	const pad = phone ? 24 : t.padding;
	const googleFonts = [...new Set([t.font, t.heading_font])]
		.map((k) => (FONTS[k] as { google?: string }).google)
		.filter(Boolean);
	return (
		<div
			className="min-h-full px-3 py-8 sm:px-8"
			style={{ background: t.background }}
		>
			{googleFonts.length > 0 && (
				<link
					rel="stylesheet"
					href={`https://fonts.googleapis.com/css2?${googleFonts.map((f) => `family=${f}`).join("&")}&display=swap`}
				/>
			)}
			<style>{`${fontFaceCss(t)}
.eb-rich p{margin:0 0 .9em}
.eb-rich p:last-child,.eb-rich ul:last-child,.eb-rich ol:last-child{margin-bottom:0}
.eb-rich ul,.eb-rich ol{margin:0 0 .9em;padding:0 0 0 24px}
.eb-rich ul{list-style:disc}.eb-rich ol{list-style:decimal}
.eb-rich li{margin:0 0 6px}
.eb-rich a{color:${t.accent};text-decoration:underline}
.eb-rich[data-muted] a{color:inherit}
.eb-rich:empty::before{content:attr(data-placeholder);color:${mix(t.text, t.surface, 0.55)}}
.eb-rich:focus{outline:none}
.eb-rich .mt-chip{--chip-fg:${t.accent}}
.eb-rich[data-muted] .mt-chip{--chip-fg:currentColor}
`}</style>
			{(subject !== undefined || previewText) && (
				<div
					className="mx-auto mb-4 flex items-center gap-3 rounded-xl bg-white/70 px-4 py-2.5 text-[13px] text-zinc-600 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] backdrop-blur dark:bg-white/80"
					style={{ maxWidth: phone ? 390 : t.width }}
				>
					<span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600">
						{brand.logo ? (
							<img
								src={brand.logo}
								alt=""
								className="size-full object-cover"
							/>
						) : (
							brand.name.slice(0, 1).toUpperCase()
						)}
					</span>
					<span className="min-w-0 flex-1 truncate">
						<span className="font-semibold text-zinc-900">
							{subject ? (
								<TagText
									text={subject}
									groups={variables}
								/>
							) : (
								"No subject yet"
							)}
						</span>
						{previewText && (
							<span className="text-zinc-500">
								{" "}
								—{" "}
								<TagText
									text={previewText}
									groups={variables}
								/>
							</span>
						)}
					</span>
				</div>
			)}
			<div
				className="mx-auto transition-[max-width] duration-300"
				style={{
					maxWidth: phone ? 390 : t.width,
					background: t.surface,
					borderRadius: phone ? 0 : t.radius,
					fontFamily: bodyStack(t),
					boxShadow: "0 1px 2px rgba(0,0,0,.04), 0 12px 32px -12px rgba(0,0,0,.12)",
				}}
			>
				<div style={{ height: pad }} />
				{doc.blocks.map((b, i) => (
					<BlockShell
						key={b.id}
						block={b}
						spot={{ parent: null, index: i }}
						gap={i === 0 ? 0 : gapAbove(b)}
						pad={pad}
						inner={(phone ? 390 : t.width) - pad * 2}
					/>
				))}
				{/* The end of the email, a place to drop. */}
				<div
					onDragOver={(e) => {
						e.preventDefault();
						setDrop({ parent: null, index: doc.blocks.length });
					}}
					onDrop={(e) => onDrop(e, { parent: null, index: doc.blocks.length })}
					style={{ padding: `0 ${pad}px`, minHeight: doc.blocks.length ? pad : 160 }}
					className="relative flex items-center justify-center"
				>
					{drop?.parent === null && drop.index === doc.blocks.length && <DropLine />}
					{doc.blocks.length === 0 && (
						<p
							className="text-sm"
							style={{ color: mix(t.text, t.surface, 0.5) }}
						>
							Drag a block here to start
						</p>
					)}
				</div>
			</div>
			<AddMenuButton />
		</div>
	);
}

function DropLine({ top }: { top?: boolean }) {
	return (
		<div
			className={cn(
				"pointer-events-none absolute inset-x-2 z-20 h-[3px] rounded-full bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,.2)]",
				top ? "-top-[2px]" : "-bottom-[2px]",
			)}
		/>
	);
}

function AddMenuButton() {
	const { setBlocks, doc, select, brand, blocks } = useB();
	return (
		<div className="mx-auto mt-5 flex justify-center">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						onClick={(e) => e.stopPropagation()}
						className="flex h-9 items-center gap-1.5 rounded-full bg-white px-4 text-[13px] font-medium text-zinc-700 shadow-[0_0_0_1px_rgba(0,0,0,.08),0_2px_6px_-2px_rgba(0,0,0,.12)] transition-colors hover:text-zinc-950"
					>
						<Plus className="size-4" />
						Add a block
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="center"
					className="w-48"
				>
					{blocks.map((b) => (
						<DropdownMenuItem
							key={b.type}
							onSelect={() => {
								const x = newBlock(b.type, brand);
								const last = doc.blocks[doc.blocks.length - 1];
								const index =
									last?.type === "footer" && b.type !== "footer"
										? doc.blocks.length - 1
										: doc.blocks.length;
								setBlocks((l) => insertBlock(l, { parent: null, index }, x));
								select(x.id);
							}}
						>
							<b.icon />
							{b.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** A block on the canvas: its outline, tools, drop places and the block itself. */
function BlockShell({
	block,
	spot,
	gap,
	pad,
	inner,
	nested,
}: {
	block: Block;
	spot: Spot;
	gap: number;
	pad: number;
	inner: number;
	nested?: boolean;
}) {
	const { selected, select, drop, setDrop, onDrop, setBlocks, onComment, saveSection } = useB();
	const on = selected === block.id;
	const [dragging, setDragging] = useState(false);
	const sameList = (s: Spot | null) =>
		!!s &&
		s.parent === spot.parent &&
		("col" in s ? s.col : -1) === ("col" in spot ? spot.col : -1);
	const before = sameList(drop) && drop?.index === spot.index;
	const after = sameList(drop) && drop?.index === spot.index + 1;
	const move = (d: -1 | 1) =>
		setBlocks((l) => {
			const list = listAt(l, spot);
			const to = spot.index + d;
			if (to < 0 || to >= list.length) return l;
			return moveBlock(l, block.id, { ...spot, index: d > 0 ? to + 1 : to });
		});
	return (
		<div
			style={{ paddingTop: gap }}
			data-block={block.id}
			className={cn("relative", dragging && "opacity-40")}
			onDragOver={(e) => {
				if (nested && block.type === "columns") return;
				e.preventDefault();
				e.stopPropagation();
				const r = e.currentTarget.getBoundingClientRect();
				const index = e.clientY < r.top + r.height / 2 ? spot.index : spot.index + 1;
				if (drop?.index !== index || !sameList(drop)) setDrop({ ...spot, index });
			}}
			onDrop={(e) => drop && sameList(drop) && onDrop(e, drop)}
		>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: the panel is the keyboard way */}
			<div
				onClick={(e) => {
					e.stopPropagation();
					select(block.id);
				}}
				className={cn("group/block relative", !nested && "mx-0")}
				style={{ padding: nested ? 0 : `0 ${pad}px` }}
			>
				<div
					className={cn(
						"pointer-events-none absolute z-10 rounded-[6px] transition-shadow",
						nested ? "-inset-1.5" : "inset-x-2 -inset-y-1.5",
						on
							? "shadow-[0_0_0_2px_#3b82f6]"
							: "group-hover/block:shadow-[0_0_0_1px_rgba(59,130,246,.55)]",
					)}
				/>
				{on && (
					<div
						className={cn(
							"absolute z-30 flex items-center gap-px rounded-md bg-blue-500 p-0.5 text-white shadow-lg",
							nested
								? "-top-8 right-0"
								: "top-[-6px] left-[calc(100%+10px)] flex-col max-sm:top-[-34px] max-sm:right-2 max-sm:left-auto max-sm:flex-row",
						)}
					>
						<span className="px-1.5 text-[11px] font-semibold">
							{LABEL[block.type]}
						</span>
						<span
							draggable
							onDragStart={(e) => {
								e.stopPropagation();
								e.dataTransfer.setData(DRAG_MOVE, block.id);
								e.dataTransfer.effectAllowed = "move";
								setDragging(true);
							}}
							onDragEnd={() => {
								setDragging(false);
								setDrop(null);
							}}
							title="Drag to move"
							className="flex size-6 cursor-grab items-center justify-center rounded hover:bg-white/20 active:cursor-grabbing"
						>
							<GripVertical className="size-3.5" />
						</span>
						<ToolBtn
							label="Move up"
							onClick={() => move(-1)}
						>
							<ArrowUp />
						</ToolBtn>
						<ToolBtn
							label="Move down"
							onClick={() => move(1)}
						>
							<ArrowDown />
						</ToolBtn>
						<ToolBtn
							label="Duplicate"
							onClick={() => {
								const copy = cloneBlock(block);
								setBlocks((l) =>
									insertBlock(l, { ...spot, index: spot.index + 1 }, copy),
								);
								select(copy.id);
							}}
						>
							<Copy />
						</ToolBtn>
						{!nested && (
							<ToolBtn
								label="Save as a section"
								onClick={() => saveSection(block)}
							>
								<BookmarkPlus />
							</ToolBtn>
						)}
						{onComment && (
							<ToolBtn
								label="Comment"
								onClick={() => onComment(block.id, LABEL[block.type])}
							>
								<MessageSquare />
							</ToolBtn>
						)}
						<ToolBtn
							label="Delete"
							onClick={() => {
								setBlocks((l) => removeBlock(l, block.id));
								select(null);
							}}
						>
							<Trash2 />
						</ToolBtn>
					</div>
				)}
				{!on && (
					<span
						draggable
						onDragStart={(e) => {
							e.stopPropagation();
							e.dataTransfer.setData(DRAG_MOVE, block.id);
							e.dataTransfer.effectAllowed = "move";
							setDragging(true);
						}}
						onDragEnd={() => {
							setDragging(false);
							setDrop(null);
						}}
						title="Drag to move"
						className={cn(
							"absolute top-0 z-20 hidden size-6 cursor-grab items-center justify-center rounded-md bg-white text-zinc-500 shadow-[0_0_0_1px_rgba(0,0,0,.1),0_1px_3px_rgba(0,0,0,.1)] group-hover/block:flex active:cursor-grabbing",
							nested ? "-left-8" : "left-[-14px] sm:-left-3",
						)}
					>
						<GripVertical className="size-3.5" />
					</span>
				)}
				<BlockBody
					block={block}
					inner={inner}
				/>
			</div>
			{before && <DropLine top />}
			{after && <DropLine />}
		</div>
	);
}

function ToolBtn({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="flex size-6 items-center justify-center rounded hover:bg-white/20 [&_svg]:size-3.5"
		>
			{children}
		</button>
	);
}

/** CSS text (as the renderer writes it) as a React style. */
function cssOf(s: string): CSSProperties {
	const out: Record<string, string> = {};
	for (const part of s.split(";")) {
		const i = part.indexOf(":");
		if (i < 0) continue;
		const k = part
			.slice(0, i)
			.trim()
			.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
		if (k) out[k] = part.slice(i + 1).trim();
	}
	return out as CSSProperties;
}

/**
 * An HTML block on the canvas: its HTML in a frame where nothing runs (no scripts, forms or
 * navigation), so a design saved by another member or through the API can't act as whoever opens
 * it. Same-origin only so the canvas can read its height; scripts stay off, which is what matters.
 */
function HtmlBlockPreview({ html, theme: t }: { html: string; theme: Theme }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(40);
	const doc = useMemo(
		() =>
			`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; font-src https: data:"><style>html,body{margin:0;background:transparent;overflow:hidden}body{font-family:${bodyStack(t).replace(/</g, "")};font-size:${t.size}px;line-height:1.65;color:${t.text}}img{max-width:100%}</style></head><body>${html}</body></html>`,
		[html, t],
	);
	useEffect(() => {
		const frame = ref.current;
		if (!frame) return;
		let observer: ResizeObserver | null = null;
		const measure = () => {
			const body = frame.contentDocument?.body;
			if (!body) return;
			setHeight(Math.max(20, Math.ceil(body.scrollHeight)));
			observer?.disconnect();
			observer = new ResizeObserver(() =>
				setHeight(Math.max(20, Math.ceil(body.scrollHeight))),
			);
			observer.observe(body);
		};
		frame.addEventListener("load", measure);
		measure();
		return () => {
			frame.removeEventListener("load", measure);
			observer?.disconnect();
		};
	}, []);
	return (
		<iframe
			ref={ref}
			title="HTML block"
			srcDoc={doc}
			sandbox="allow-same-origin"
			className="pointer-events-none block w-full border-0"
			style={{ height }}
		/>
	);
}

function BlockBody({ block: b, inner }: { block: Block; inner: number }) {
	const { doc, patch, phone } = useB();
	const t = doc.theme;
	if (b.type === "text" || b.type === "quote" || b.type === "footer" || b.type === "heading") {
		const muted = mix(t.text, t.surface, 0.62);
		if (b.type === "heading") {
			const size = { 1: 30, 2: 24, 3: 19 }[b.level];
			return (
				<Rich
					id={b.id}
					html={b.html}
					single
					placeholder="Heading"
					onChange={(html) => patch(b.id, { html })}
					style={{
						fontFamily: headingStack(t),
						fontSize: size,
						lineHeight: 1.25,
						fontWeight: b.level === 3 ? 600 : 700,
						letterSpacing: b.level === 1 ? "-0.02em" : "-0.01em",
						color: t.heading,
						textAlign: b.align,
					}}
				/>
			);
		}
		if (b.type === "quote")
			return (
				<div style={{ borderLeft: `3px solid ${t.accent}`, padding: "4px 0 4px 18px" }}>
					<Rich
						id={b.id}
						html={b.html}
						placeholder="A quote"
						onChange={(html) => patch(b.id, { html })}
						style={{
							fontFamily: bodyStack(t),
							fontStyle: "italic",
							fontSize: t.size + 2,
							lineHeight: 1.55,
							color: t.heading,
						}}
					/>
				</div>
			);
		if (b.type === "footer")
			return (
				<div
					style={{
						textAlign: "center",
						fontFamily: bodyStack(t),
						fontSize: 13,
						lineHeight: 1.6,
						color: muted,
					}}
				>
					<Rich
						id={b.id}
						html={b.html}
						placeholder="Who you are, and why they get this"
						onChange={(html) => patch(b.id, { html })}
						style={{ color: muted }}
						linkColor={muted}
					/>
					<div style={{ marginTop: 10 }}>
						<span style={{ textDecoration: "underline" }}>{b.unsubscribe}</span>
					</div>
				</div>
			);
		return (
			<Rich
				id={b.id}
				html={b.html}
				placeholder="Write something…"
				onChange={(html) => patch(b.id, { html })}
				style={{
					fontFamily: bodyStack(t),
					fontSize: t.size,
					lineHeight: 1.65,
					color: t.text,
					textAlign: b.align,
				}}
			/>
		);
	}
	if (b.type === "columns")
		return (
			<ColumnsBody
				block={b}
				inner={inner}
				phone={phone}
			/>
		);
	if (b.type === "logo" && !b.src)
		return (
			<div
				className="flex justify-center py-3 text-sm"
				style={{ color: mix(t.text, t.surface, 0.5) }}
			>
				No logo yet: add one in the panel →
			</div>
		);
	if (b.type === "html")
		return (
			<HtmlBlockPreview
				html={b.html}
				theme={t}
			/>
		);
	return (
		<div
			// biome-ignore lint/security/noDangerouslySetInnerHtml: rendered from the block's cleaned values
			dangerouslySetInnerHTML={{ __html: blockInner(b, t, inner) }}
			style={cssOf("pointer-events:none")}
		/>
	);
}

function ColumnsBody({
	block,
	inner,
	phone,
}: {
	block: ColumnsBlock;
	inner: number;
	phone: boolean;
}) {
	const { drop, setDrop, onDrop, doc } = useB();
	const [a] = block.ratio === "1-2" ? [33] : block.ratio === "2-1" ? [67] : [50];
	const gap = 24;
	const wa = Math.round(((inner - gap) * a) / 100);
	const widths = [wa, inner - gap - wa];
	return (
		<div className={cn("flex", phone ? "flex-col gap-5" : "gap-6")}>
			{([0, 1] as const).map((col) => {
				const list = block.columns[col];
				const spotEnd: Spot = { parent: block.id, col, index: list.length };
				const here = drop && drop.parent === block.id && "col" in drop && drop.col === col;
				return (
					<div
						key={col}
						className="relative min-w-0"
						style={{ flex: phone ? "none" : `${widths[col]} 1 0` }}
						onDragOver={(e) => {
							e.preventDefault();
							e.stopPropagation();
							if (!list.length) setDrop(spotEnd);
						}}
						onDrop={(e) => {
							if (!list.length || (here && drop))
								onDrop(e, here && drop ? drop : spotEnd);
						}}
					>
						{list.length === 0 && (
							<div
								className="flex h-20 items-center justify-center rounded-md border border-dashed text-xs"
								style={{
									borderColor: mix(doc.theme.text, doc.theme.surface, 0.7),
									color: mix(doc.theme.text, doc.theme.surface, 0.45),
								}}
							>
								Drop a block here
								{here && <DropLine />}
							</div>
						)}
						{list.map((x, i) => (
							<BlockShell
								key={x.id}
								block={x}
								spot={{ parent: block.id, col, index: i }}
								gap={i === 0 ? 0 : gapAbove(x)}
								pad={0}
								inner={widths[col] as number}
								nested
							/>
						))}
					</div>
				);
			})}
		</div>
	);
}

// ── Rich text in place ──────────────────────────────────────────────────────

function Rich({
	id,
	html,
	onChange,
	style,
	single,
	placeholder,
	linkColor,
}: {
	id: string;
	html: string;
	onChange: (html: string) => void;
	style: CSSProperties;
	single?: boolean;
	placeholder: string;
	linkColor?: string;
}) {
	const { selected, variables } = useB();
	const ref = useRef<HTMLDivElement>(null);
	const [focused, setFocused] = useState(false);
	const [chip, setChip] = useState<HTMLElement | null>(null);
	const range = useRef<Range | null>(null);
	const keep = () => {
		const s = window.getSelection();
		if (s?.rangeCount && ref.current?.contains(s.anchorNode))
			range.current = s.getRangeAt(0).cloneRange();
	};
	useEffect(() => {
		const el = ref.current;
		if (el && document.activeElement !== el && htmlWithTags(el) !== html)
			el.innerHTML = chipsHtml(html, variables);
	}, [html, variables]);
	const emit = () => {
		if (ref.current) onChange(htmlWithTags(ref.current));
	};
	const on = selected === id;
	return (
		<div className="relative">
			{on && (focused || chip) && (
				<FormatBar
					single={single}
					onVariable={(v) => {
						const el = ref.current;
						if (!el) return;
						el.focus();
						const sel = window.getSelection();
						let r = range.current;
						if (
							!r ||
							!el.contains(r.commonAncestorContainer) ||
							r.startContainer === el
						) {
							// Into the text's last paragraph, not after it.
							r = document.createRange();
							r.selectNodeContents(el.lastElementChild ?? el);
							r.collapse(false);
						}
						sel?.removeAllRanges();
						sel?.addRange(r);
						// By hand: Chrome's insertHTML puts an uneditable chip after the paragraph.
						r.deleteContents();
						const tpl = document.createElement("template");
						tpl.innerHTML = `${chipsHtml(tagOf(v.key, v.fallback), variables)}\u00a0`;
						const last = tpl.content.lastChild;
						r.insertNode(tpl.content);
						if (last) {
							const after = document.createRange();
							after.setStartAfter(last);
							after.collapse(true);
							sel?.removeAllRanges();
							sel?.addRange(after);
						}
						emit();
					}}
				/>
			)}
			<ChipPopover
				chip={chip}
				groups={variables}
				onClose={() => setChip(null)}
				onChanged={emit}
			/>
			{/* biome-ignore lint/a11y/useSemanticElements: rich text needs an editable element, not an input */}
			<div
				ref={ref}
				role="textbox"
				tabIndex={0}
				aria-multiline={!single}
				aria-label={placeholder}
				contentEditable
				suppressContentEditableWarning
				data-placeholder={placeholder}
				className="eb-rich cursor-text"
				data-muted={linkColor ? "" : undefined}
				style={style}
				onFocus={() => {
					setFocused(true);
					document.execCommand("defaultParagraphSeparator", false, "p");
				}}
				onKeyUp={keep}
				onMouseUp={keep}
				onBlur={(e) => {
					keep();
					// The toolbar's menus take the focus for a moment: the toolbar stays.
					const to = e.relatedTarget as HTMLElement | null;
					if (to?.closest("[data-radix-popper-content-wrapper]")) return;
					setFocused(false);
				}}
				onInput={emit}
				onClick={(e) => {
					const c = (e.target as HTMLElement).closest<HTMLElement>(`.${CHIP}`);
					if (c) setChip(c);
				}}
				onKeyDown={(e) => {
					if (single && e.key === "Enter") e.preventDefault();
				}}
				onPaste={(e) => {
					// Text only: what's pasted takes the email's look (its variables as chips).
					e.preventDefault();
					const text = e.clipboardData.getData("text/plain");
					if (text.match(TAG))
						document.execCommand(
							"insertHTML",
							false,
							chipsHtml(
								text
									.replace(/&/g, "&amp;")
									.replace(/</g, "&lt;")
									.replace(/\n/g, "<br>"),
								variables,
							),
						);
					else document.execCommand("insertText", false, text);
				}}
			/>
		</div>
	);
}

/** Bold, italic, links, lists and merge tags for the text being written. */
function FormatBar({
	single,
	onVariable,
}: {
	single?: boolean;
	onVariable: (v: Variable) => void;
}) {
	const { variables } = useB();
	const [linkOpen, setLinkOpen] = useState(false);
	const [url, setUrl] = useState("");
	const saved = useRef<Range | null>(null);
	const keep = (e: { preventDefault: () => void }) => e.preventDefault();
	const cmd = (c: string, v?: string) => document.execCommand(c, false, v);
	const items = [
		{ label: "Bold", icon: Bold, run: () => cmd("bold") },
		{ label: "Italic", icon: Italic, run: () => cmd("italic") },
		{ label: "Underline", icon: Underline, run: () => cmd("underline") },
		...(single
			? []
			: [
					{ label: "Bulleted list", icon: List, run: () => cmd("insertUnorderedList") },
					{
						label: "Numbered list",
						icon: ListOrdered,
						run: () => cmd("insertOrderedList"),
					},
				]),
	];
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: keeps the text's selection while a button is pressed
		<div
			onMouseDown={keep}
			onClick={(e) => e.stopPropagation()}
			className="absolute -top-12 left-0 z-40 flex items-center gap-px rounded-lg border border-zinc-200 bg-white p-1 text-zinc-700 shadow-[0_8px_24px_-6px_rgba(0,0,0,.25)]"
		>
			{items.map((x) => (
				<button
					key={x.label}
					type="button"
					aria-label={x.label}
					title={x.label}
					onClick={x.run}
					className="flex size-7 items-center justify-center rounded-md hover:bg-zinc-100 [&_svg]:size-4"
				>
					<x.icon />
				</button>
			))}
			<Popover
				open={linkOpen}
				onOpenChange={setLinkOpen}
			>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label="Link"
						title="Link"
						onClick={() => {
							const s = window.getSelection();
							saved.current = s?.rangeCount ? s.getRangeAt(0).cloneRange() : null;
							setUrl("https://");
						}}
						className="flex size-7 items-center justify-center rounded-md hover:bg-zinc-100 [&_svg]:size-4"
					>
						<Link2 />
					</button>
				</PopoverTrigger>
				<PopoverContent
					className="w-72 p-2"
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					<form
						className="flex gap-1.5"
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							const s = window.getSelection();
							if (saved.current && s) {
								s.removeAllRanges();
								s.addRange(saved.current);
							}
							if (url.trim() && url.trim() !== "https://")
								cmd("createLink", url.trim());
							else cmd("unlink");
							setLinkOpen(false);
						}}
					>
						<Input
							autoFocus
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="https://…"
							className="h-8 text-sm"
						/>
						<Button
							size="sm"
							type="submit"
						>
							Link
						</Button>
					</form>
				</PopoverContent>
			</Popover>
			<span className="mx-0.5 h-5 w-px bg-zinc-200" />
			<VariableMenu
				groups={variables}
				align="start"
				onPick={onVariable}
			>
				<button
					type="button"
					title="Add a variable"
					className="flex h-7 items-center gap-1 rounded-md px-1.5 text-xs font-medium hover:bg-zinc-100 data-[state=open]:bg-zinc-100"
				>
					<Braces className="size-3.5" />
					Personalize
				</button>
			</VariableMenu>
		</div>
	);
}

// ── Side panels ─────────────────────────────────────────────────────────────

function PanelHead({ title, hint }: { title: string; hint?: string }) {
	return (
		<div className="border-b border-border/70 px-5 py-4">
			<h2 className="text-sm font-semibold">{title}</h2>
			{hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
		</div>
	);
}

function Field2({ label, children }: { label: string; children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is the child
		<label className="flex flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			{children}
		</label>
	);
}

function AlignPick({ value, onChange }: { value: Align; onChange: (a: Align) => void }) {
	return (
		<Labeled label="Align">
			<div className="flex gap-1 rounded-lg bg-muted p-0.5">
				{(
					[
						["left", AlignLeft],
						["center", AlignCenter],
						["right", AlignRight],
					] as const
				).map(([a, Icon]) => (
					<button
						key={a}
						type="button"
						aria-label={`Align ${a}`}
						aria-pressed={value === a}
						onClick={() => onChange(a)}
						className={cn(
							"flex h-7 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground",
							value === a &&
								"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
						)}
					>
						<Icon className="size-4" />
					</button>
				))}
			</div>
		</Labeled>
	);
}

function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	unit = "px",
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	unit?: string;
	onChange: (v: number) => void;
}) {
	return (
		<Labeled label={label}>
			<div className="flex items-center gap-3">
				<input
					type="range"
					aria-label={label}
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					className="h-1.5 min-w-0 flex-1 cursor-pointer accent-foreground"
				/>
				<span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
					{value}
					{unit}
				</span>
			</div>
		</Labeled>
	);
}

export function ImagePick({
	value,
	onChange,
	aspect = "aspect-[16/9]",
}: {
	value: string;
	onChange: (url: string) => void;
	/** The drop zone's shape. */
	aspect?: string;
}) {
	const [busy, setBusy] = useState(false);
	const file = useRef<HTMLInputElement>(null);
	const upload = async (f: File) => {
		setBusy(true);
		try {
			const data = await shrink(f);
			const { url } = await uploadMediaFn({ data: { data } });
			onChange(url);
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="flex flex-col gap-2">
			<div
				onDragOver={(e) => e.preventDefault()}
				onDrop={(e) => {
					e.preventDefault();
					const f = e.dataTransfer.files[0];
					if (f) upload(f);
				}}
				className={cn(
					"relative flex items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/40",
					aspect,
				)}
			>
				{value ? (
					<img
						src={value}
						alt=""
						className="size-full object-contain"
					/>
				) : (
					<span className="text-xs text-muted-foreground">Drop an image here</span>
				)}
				{busy && (
					<span className="absolute inset-0 flex items-center justify-center bg-background/70">
						<Spinner />
					</span>
				)}
			</div>
			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					className="flex-1"
					disabled={busy}
					onClick={() => file.current?.click()}
				>
					<Upload />
					{value ? "Replace" : "Upload"}
				</Button>
				{value && (
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onChange("")}
					>
						Remove
					</Button>
				)}
			</div>
			<input
				ref={file}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				className="hidden"
				onChange={(e) => {
					const f = e.target.files?.[0];
					if (f) upload(f);
					e.target.value = "";
				}}
			/>
			<Input
				value={value}
				placeholder="Or paste an image URL"
				onChange={(e) => onChange(e.target.value)}
				className="h-8 text-xs"
			/>
		</div>
	);
}

/** An image, at most 1200 px wide (twice the email's width) unless it's a GIF, as a data: URL. */
async function shrink(f: File): Promise<string> {
	const read = (b: Blob) =>
		new Promise<string>((ok, no) => {
			const r = new FileReader();
			r.onload = () => ok(String(r.result));
			r.onerror = () => no(r.error);
			r.readAsDataURL(b);
		});
	if (f.type === "image/gif") return read(f);
	const bitmap = await createImageBitmap(f);
	if (bitmap.width <= 1200 && f.size < 1_500_000) return read(f);
	const scale = Math.min(1, 1200 / bitmap.width);
	const c = document.createElement("canvas");
	c.width = Math.round(bitmap.width * scale);
	c.height = Math.round(bitmap.height * scale);
	c.getContext("2d")?.drawImage(bitmap, 0, 0, c.width, c.height);
	const type = f.type === "image/png" ? "image/png" : "image/jpeg";
	return c.toDataURL(type, 0.86);
}

function BlockPanel({ block: b }: { block: Block }) {
	const { patch, select, kit } = useB();
	const set = (p: Record<string, unknown>) => patch(b.id, p as Partial<Block>);
	const head = (
		<PanelHead
			title={LABEL[b.type]}
			hint={HINTS[b.type]}
		/>
	);
	const back = (
		<div className="mt-auto border-t border-border/70 px-5 py-3">
			<button
				type="button"
				onClick={() => select(null)}
				className="text-xs font-medium text-muted-foreground hover:text-foreground"
			>
				← The email's style
			</button>
		</div>
	);
	let body: ReactNode = null;
	switch (b.type) {
		case "heading":
			body = (
				<Group title="Settings">
					<Labeled label="Size">
						<Choice
							value={String(b.level) as "1" | "2" | "3"}
							onChange={(v) => set({ level: Number(v) })}
							options={[
								["1", "Large"],
								["2", "Medium"],
								["3", "Small"],
							]}
						/>
					</Labeled>
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
				</Group>
			);
			break;
		case "text":
			body = (
				<Group title="Settings">
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
				</Group>
			);
			break;
		case "button":
			body = (
				<Group title="Settings">
					<Field2 label="Label">
						<Input
							value={b.label}
							onChange={(e) => set({ label: e.target.value })}
						/>
					</Field2>
					<Field2 label="Link">
						<Input
							value={b.url}
							placeholder="https://"
							spellCheck={false}
							onChange={(e) => set({ url: e.target.value })}
						/>
					</Field2>
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
					<SwitchRow
						label="Full width"
						checked={b.full}
						onChange={(full) => set({ full })}
					/>
					<SwitchRow
						label="Its own color"
						hint="Otherwise the email's accent"
						checked={!!b.color}
						onChange={(on) => set({ color: on ? "#2563eb" : null })}
					/>
					{b.color && (
						<ColorField
							label="Color"
							value={b.color}
							onChange={(color) => set({ color })}
							swatches={kit ? kitSwatches(kit) : undefined}
							locked={!!kit?.locked}
						/>
					)}
				</Group>
			);
			break;
		case "image":
		case "logo":
			body = (
				<Group title="Settings">
					<ImagePick
						value={b.src}
						onChange={(src) => set({ src })}
					/>
					<Field2 label="Description (for screen readers and blocked images)">
						<Input
							value={b.alt}
							onChange={(e) => set({ alt: e.target.value })}
						/>
					</Field2>
					<Field2 label="Link (optional)">
						<Input
							value={b.href}
							placeholder="https://"
							spellCheck={false}
							onChange={(e) => set({ href: e.target.value })}
						/>
					</Field2>
					{b.type === "image" ? (
						<Slider
							label="Width"
							value={b.width}
							min={20}
							max={100}
							step={5}
							unit="%"
							onChange={(width) => set({ width })}
						/>
					) : (
						<Slider
							label="Width"
							value={b.width}
							min={40}
							max={320}
							step={4}
							onChange={(width) => set({ width })}
						/>
					)}
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
				</Group>
			);
			break;
		case "spacer":
			body = (
				<Group title="Settings">
					<Slider
						label="Height"
						value={b.height}
						min={8}
						max={120}
						step={4}
						onChange={(height) => set({ height })}
					/>
				</Group>
			);
			break;
		case "social":
			body = (
				<Group title="Settings">
					{b.links.map((l, i) => (
						<div
							key={`${i}-${l.label}`}
							className="flex flex-col gap-1.5 rounded-lg border border-border/70 p-2.5"
						>
							<div className="flex gap-1.5">
								<Input
									value={l.label}
									aria-label="Label"
									className="h-8 text-sm"
									onChange={(e) =>
										set({
											links: b.links.map((x, j) =>
												j === i ? { ...x, label: e.target.value } : x,
											),
										})
									}
								/>
								<Button
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label="Remove link"
									onClick={() =>
										set({ links: b.links.filter((_, j) => j !== i) })
									}
								>
									<Trash2 />
								</Button>
							</div>
							<Input
								value={l.url}
								aria-label="URL"
								placeholder="https://"
								spellCheck={false}
								className="h-8 text-xs"
								onChange={(e) =>
									set({
										links: b.links.map((x, j) =>
											j === i ? { ...x, url: e.target.value } : x,
										),
									})
								}
							/>
						</div>
					))}
					<Button
						variant="outline"
						size="sm"
						onClick={() => set({ links: [...b.links, { label: "Link", url: "" }] })}
					>
						<Plus />
						Add a link
					</Button>
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
				</Group>
			);
			break;
		case "footer":
			body = (
				<Group title="Settings">
					<Field2 label="Unsubscribe link text">
						<Input
							value={b.unsubscribe}
							onChange={(e) => set({ unsubscribe: e.target.value })}
						/>
					</Field2>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Write the rest (your business's name and address, why they get this) on the
						canvas. The link unsubscribes each contact from this email's topic.
					</p>
				</Group>
			);
			break;
		case "poll":
			body = (
				<Group title="Settings">
					<Field2 label="Question">
						<Input
							value={b.question}
							onChange={(e) => set({ question: e.target.value })}
						/>
					</Field2>
					<div className="flex flex-col gap-1.5">
						<span className="text-sm text-muted-foreground">Answers</span>
						{b.options.map((o, i) => (
							<div
								key={i}
								className="flex gap-1.5"
							>
								<Input
									value={o}
									aria-label={`Answer ${i + 1}`}
									className="h-8 text-sm"
									onChange={(e) =>
										set({
											options: b.options.map((x, j) =>
												j === i ? e.target.value : x,
											),
										})
									}
								/>
								<Button
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label="Remove answer"
									disabled={b.options.length <= 2}
									onClick={() =>
										set({ options: b.options.filter((_, j) => j !== i) })
									}
								>
									<Trash2 />
								</Button>
							</div>
						))}
						{b.options.length < 6 && (
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									set({
										options: [...b.options, `Answer ${b.options.length + 1}`],
									})
								}
							>
								<Plus />
								Add an answer
							</Button>
						)}
					</div>
					<AlignPick
						value={b.align}
						onChange={(align) => set({ align })}
					/>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Each answer is a button: one click records it and shows the results so far.
						The broadcast's page counts the answers and can put each answer's people in
						a segment. Answers are kept in place: reordering them after sending mixes up
						the count.
					</p>
				</Group>
			);
			break;
		case "html":
			body = (
				<Group title="Settings">
					<Textarea
						spellCheck={false}
						value={b.html}
						onChange={(e) => set({ html: e.target.value })}
						className="h-72 font-mono text-xs"
					/>
				</Group>
			);
			break;
		case "columns":
			body = (
				<Group title="Settings">
					<Labeled label="Widths">
						<Choice
							value={b.ratio}
							onChange={(ratio) => set({ ratio })}
							options={[
								["1-1", "½ ½"],
								["2-1", "⅔ ⅓"],
								["1-2", "⅓ ⅔"],
							]}
						/>
					</Labeled>
					<p className="text-xs leading-relaxed text-muted-foreground">
						Drag blocks into either column. On phones they stack, left first.
					</p>
				</Group>
			);
			break;
		default:
			body = null;
	}
	return (
		<>
			{head}
			{body}
			{back}
		</>
	);
}

const HINTS: Partial<Record<BlockType, string>> = {
	heading: "Click the heading on the canvas to write it.",
	text: "Click the text to write. Select words to make them bold, link them or personalize.",
	quote: "Click the quote to write it.",
	divider: "A thin line between sections.",
	footer: "Every marketing email needs a way out; this one carries it.",
	poll: "A question your readers answer in one click, from the email.",
};

function StylePanel({
	theme: t,
	set,
	kit,
}: {
	theme: Theme;
	set: (p: Partial<Theme>) => void;
	kit: BrandKit | null;
}) {
	const locked = !!kit?.locked;
	const swatches = kit ? kitSwatches(kit) : undefined;
	const kitLook = kit ? kitTheme(kit) : null;
	const onKit =
		!!kitLook &&
		(Object.keys(kitLook) as (keyof Theme)[]).every(
			(k) => JSON.stringify(t[k] ?? null) === JSON.stringify(kitLook[k] ?? null),
		);
	const colorProps = { swatches, locked };
	return (
		<>
			<PanelHead
				title="Email style"
				hint="Colors and type for the whole email. Select a block to change just it."
			/>
			{kit && kitLook && (
				<Group title="Brand kit">
					<p className="-mt-2 text-xs leading-relaxed text-muted-foreground">
						{locked
							? "This brand's kit is locked: colors and fonts come from it."
							: "Its colors show first in every color picker."}
					</p>
					<Button
						variant="outline"
						size="sm"
						disabled={onKit}
						onClick={() => set(kitLook)}
					>
						<Paintbrush />
						{onKit ? "Uses the brand kit" : "Apply brand kit"}
					</Button>
				</Group>
			)}
			{!locked && (
				<Group title="Palette">
					<div className="grid grid-cols-4 gap-2">
						{PALETTES.map((p) => {
							const on =
								p.background === t.background &&
								p.accent === t.accent &&
								p.surface === t.surface;
							return (
								<button
									key={p.name}
									type="button"
									title={p.name}
									aria-pressed={on}
									onClick={() => {
										const { name: _, ...rest } = p;
										set(rest);
									}}
									className={cn(
										"flex flex-col items-center gap-1.5 rounded-lg p-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted",
										on && "bg-muted text-foreground",
									)}
								>
									<span
										className={cn(
											"relative flex h-10 w-full items-end justify-center overflow-hidden rounded-md pb-1.5 shadow-[inset_0_0_0_1px_rgba(0,0,0,.08)]",
											on &&
												"ring-2 ring-foreground ring-offset-1 ring-offset-background",
										)}
										style={{ background: p.background }}
									>
										<span
											className="flex h-6 w-[70%] flex-col justify-center gap-1 rounded-[3px] px-1.5"
											style={{ background: p.surface }}
										>
											<span
												className="h-[3px] w-3/4 rounded-full"
												style={{ background: p.heading }}
											/>
											<span
												className="h-[3px] w-1/2 rounded-full"
												style={{ background: p.accent }}
											/>
										</span>
									</span>
									{p.name}
								</button>
							);
						})}
					</div>
				</Group>
			)}
			<Group title="Colors">
				<div className="grid grid-cols-2 gap-3">
					<ColorField
						label="Background"
						value={t.background}
						onChange={(background) => set({ background })}
						{...colorProps}
					/>
					<ColorField
						label="Email"
						value={t.surface}
						onChange={(surface) => set({ surface })}
						{...colorProps}
					/>
					<ColorField
						label="Headings"
						value={t.heading}
						onChange={(heading) => set({ heading })}
						{...colorProps}
					/>
					<ColorField
						label="Text"
						value={t.text}
						onChange={(text) => set({ text })}
						{...colorProps}
					/>
					<ColorField
						label="Accent"
						value={t.accent}
						onChange={(accent) => set({ accent, button_text: onColor(accent) })}
						{...colorProps}
					/>
					<ColorField
						label="Button text"
						value={t.button_text}
						onChange={(button_text) => set({ button_text })}
						{...colorProps}
					/>
				</div>
			</Group>
			<Group title="Type">
				<Labeled label="Text">
					<FontSelect
						value={t.font_face?.family ?? t.font}
						kit={kit}
						onChange={(key, face) => set({ font: key, font_face: face })}
					/>
				</Labeled>
				<Labeled label="Headings">
					<FontSelect
						value={t.heading_face?.family ?? t.heading_font}
						kit={kit}
						onChange={(key, face) => set({ heading_font: key, heading_face: face })}
					/>
				</Labeled>
				{(t.font_face || t.heading_face) && (
					<p className="-mt-1 text-xs leading-relaxed text-muted-foreground">
						Brand fonts show in Apple Mail, iOS and some Android apps. Gmail and Outlook
						show the fallback font.
					</p>
				)}
				<Labeled label="Size">
					<Choice
						value={String(t.size) as "15" | "16" | "17"}
						onChange={(v) => set({ size: Number(v) })}
						options={[
							["15", "Small"],
							["16", "Medium"],
							["17", "Large"],
						]}
					/>
				</Labeled>
			</Group>
			<Group title="Layout">
				<Labeled label="Width">
					<Choice
						value={String(t.width) as "560" | "600" | "640"}
						onChange={(v) => set({ width: Number(v) })}
						options={[
							["560", "560"],
							["600", "600"],
							["640", "640"],
						]}
					/>
				</Labeled>
				<Slider
					label="Margins"
					value={t.padding}
					min={16}
					max={64}
					step={4}
					onChange={(padding) => set({ padding })}
				/>
				<Slider
					label="Corners"
					value={t.radius}
					min={0}
					max={24}
					step={2}
					onChange={(radius) => set({ radius })}
				/>
			</Group>
		</>
	);
}

/**
 * A font: the built-in ones, and a brand kit's own (a web font over a built-in fallback). A
 * locked kit offers only its own fonts and the built-in ones it names.
 */
function FontSelect({
	value,
	kit,
	onChange,
}: {
	/** A built-in key, or a kit font's family. */
	value: string;
	kit: BrandKit | null;
	onChange: (key: FontKey, face: { family: string; url: string } | null) => void;
}) {
	const builtIn = (Object.entries(FONTS) as [FontKey, (typeof FONTS)[FontKey]][]).filter(
		([k]) => !kit?.locked || k === kit.font || k === kit.heading_font || k === value,
	);
	const own = kit?.fonts ?? [];
	return (
		<Select
			value={`${own.some((f) => f.family === value) ? "kit" : "font"}:${value}`}
			onValueChange={(v) => {
				const [kind, name] = [v.slice(0, v.indexOf(":")), v.slice(v.indexOf(":") + 1)];
				const face = kind === "kit" ? own.find((f) => f.family === name) : null;
				if (face) onChange(face.fallback, { family: face.family, url: face.url });
				else onChange(name as FontKey, null);
			}}
		>
			<SelectTrigger className="w-full">
				<SelectValue />
			</SelectTrigger>
			<SelectContent className="z-[60]">
				{own.length > 0 && (
					<>
						<style>
							{own
								.map(
									(f) =>
										`@font-face{font-family:'${f.family}';src:url('${f.url}');font-display:swap}`,
								)
								.join("\n")}
						</style>
						{own.map((f) => (
							<SelectItem
								key={`kit:${f.family}`}
								value={`kit:${f.family}`}
							>
								<span
									style={{
										fontFamily: `'${f.family}',${FONTS[f.fallback].stack}`,
									}}
								>
									{f.family}
								</span>
								<span className="text-xs text-muted-foreground">Brand</span>
							</SelectItem>
						))}
					</>
				)}
				{builtIn.map(([k, f]) => (
					<SelectItem
						key={k}
						value={`font:${k}`}
					>
						<span style={{ fontFamily: f.stack }}>{f.label}</span>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

// ── Saved sections ──────────────────────────────────────────────────────────

type Section = Awaited<ReturnType<typeof sectionsFn>>[number];

/** The organization's saved sections, loaded once the editor opens. */
function useSections() {
	const [rows, setRows] = useState<Section[] | null>(null);
	const load = () =>
		sectionsFn()
			.then(setRows)
			.catch(() => setRows([]));
	// biome-ignore lint/correctness/useExhaustiveDependencies: once
	useEffect(() => {
		void load();
	}, []);
	return { rows, load };
}

function SavedSections({
	sections,
	onInsert,
}: {
	sections: ReturnType<typeof useSections>;
	onInsert: (blocks: Block[]) => void;
}) {
	const { doc } = useB();
	const me = useMe();
	const canEdit = allows(me.active?.access, "library:edit");
	if (sections.rows === null) return <Spinner className="mx-auto my-8" />;
	if (!sections.rows.length)
		return (
			<p className="px-4 py-6 text-xs leading-relaxed text-muted-foreground">
				Sections your team saves show here, ready to add to any email: a header with the
				logo, a sign-off, a product card. Select a block and press{" "}
				<BookmarkPlus className="inline size-3.5 align-[-2px]" /> to save it.
			</p>
		);
	return (
		<div className="flex flex-col gap-3 px-4 py-4">
			<p className="text-xs text-muted-foreground">Click to add after the selected block</p>
			{sections.rows.map((s) => (
				<div
					key={s.id}
					className="group relative"
				>
					<button
						type="button"
						onClick={() => onInsert(s.blocks)}
						className="flex w-full flex-col gap-1.5 text-left"
					>
						<span className="relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-muted shadow-[0_0_0_1px_var(--border)] transition-all group-hover:-translate-y-px group-hover:shadow-[0_0_0_1px_var(--border),0_8px_16px_-8px_var(--shadow-color-strong)]">
							<Thumb
								doc={{ version: 1, theme: doc.theme, blocks: s.blocks }}
								height={520}
							/>
						</span>
						<span className="truncate text-[13px] font-medium">{s.name}</span>
						<span className="-mt-1.5 truncate text-[11px] text-muted-foreground">
							{s.blocks.length === 1 ? "1 block" : `${s.blocks.length} blocks`}
							{s.who ? ` · ${s.who}` : ""}
						</span>
					</button>
					{canEdit && (
						<button
							type="button"
							aria-label={`Delete ${s.name}`}
							title="Delete for everyone"
							className="absolute top-1.5 right-1.5 hidden size-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground shadow-sm group-hover:flex hover:text-destructive"
							onClick={async () => {
								try {
									await deleteSectionFn({ data: { id: s.id } });
									toast.success("Section deleted");
									await sections.load();
								} catch (error) {
									toast.error(await errorMessage(error));
								}
							}}
						>
							<Trash2 className="size-3.5" />
						</button>
					)}
				</div>
			))}
		</div>
	);
}

function SaveSectionDialog({
	block,
	onOpenChange,
	onSaved,
}: {
	block: Block | null;
	onOpenChange: (o: boolean) => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<Dialog
			open={!!block}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="z-[60]">
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						if (!block || !name.trim()) return;
						setBusy(true);
						try {
							await saveSectionFn({ data: { name: name.trim(), blocks: [block] } });
							toast.success("Saved for your team");
							setName("");
							onSaved();
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Save as a section</DialogTitle>
						<DialogDescription>
							Everyone in the organization can add it to their emails from Saved. It's
							copied in, so changing it later doesn't change emails that used it.
						</DialogDescription>
					</DialogHeader>
					<DialogBody>
						<Input
							autoFocus
							aria-label="Section name"
							placeholder="Header with logo"
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !name.trim()}
						>
							{busy ? <Spinner /> : <BookmarkPlus />}
							Save section
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

// ── Starting points ─────────────────────────────────────────────────────────

const STARTERS = [
	{ kind: "newsletter", name: "Newsletter", hint: "Stories, an image and two columns" },
	{ kind: "announcement", name: "Announcement", hint: "One big message and a button" },
	{ kind: "letter", name: "Plain letter", hint: "Reads like a personal email" },
	{ kind: "blank", name: "Blank", hint: "Start from nothing" },
] as const;

/** Picks how a new design starts, each shown as a small live email. */
export function StarterPicker({
	brand,
	theme,
	onPick,
}: {
	brand: Brand;
	/** Colors and fonts over each starting point's own (a newsletter's). */
	theme?: Partial<Theme>;
	onPick: (d: EmailDoc) => void;
}) {
	const key = JSON.stringify(theme ?? {});
	// biome-ignore lint/correctness/useExhaustiveDependencies: key stands for theme
	const docs = useMemo(
		() =>
			STARTERS.map((s) => {
				const doc = starter(s.kind, brand);
				return { ...s, doc: theme ? { ...doc, theme: { ...doc.theme, ...theme } } : doc };
			}),
		[brand, key],
	);
	return (
		<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
			{docs.map((s) => (
				<button
					key={s.kind}
					type="button"
					onClick={() => onPick(s.doc)}
					className="group flex flex-col gap-2.5 text-left"
				>
					<span className="relative block aspect-[3/4] w-full overflow-hidden rounded-xl bg-muted shadow-[0_0_0_1px_var(--border)] transition-all group-hover:-translate-y-0.5 group-hover:shadow-[0_0_0_1px_var(--border),0_12px_24px_-12px_var(--shadow-color-strong)]">
						<Thumb doc={s.doc} />
					</span>
					<span>
						<span className="block text-sm font-medium">{s.name}</span>
						<span className="block text-xs text-muted-foreground">{s.hint}</span>
					</span>
				</button>
			))}
		</div>
	);
}

/** A design shrunk to fit its box. */
export function Thumb({ doc, height = 900 }: { doc: EmailDoc; height?: number }) {
	const box = useRef<HTMLSpanElement>(null);
	const [scale, setScale] = useState(0.3);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setScale(el.clientWidth / 680));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const html = useMemo(() => sampleFill(renderEmail(doc)), [doc]);
	return (
		<span
			ref={box}
			className="pointer-events-none absolute inset-0 block overflow-hidden"
		>
			<iframe
				title="Design"
				sandbox=""
				tabIndex={-1}
				srcDoc={html}
				style={{
					width: 680,
					height,
					transform: `scale(${scale})`,
					transformOrigin: "0 0",
					border: 0,
				}}
			/>
		</span>
	);
}
