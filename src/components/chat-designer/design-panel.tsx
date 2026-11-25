import {
	CircleHelp,
	Hand,
	Headset,
	ImageIcon,
	MessageCircle,
	MessageSquareText,
	Sparkles,
} from "lucide-react";
import { Choice, ColorField, Group, Labeled, SwitchRow } from "@/components/design-controls";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { getChatSettingsFn } from "@/functions/chat";
import { cn } from "@/lib/utils";

type Widget = NonNullable<Awaited<ReturnType<typeof getChatSettingsFn>>["widget"]>;
export type ChatDesign = Widget["design"];

const PRESETS = ["#2563eb", "#0f766e", "#16a34a", "#9333ea", "#db2777", "#ea580c", "#111827"];

export function DesignPanel({
	design: d,
	look,
	hasLogo,
}: {
	design: ChatDesign;
	look: (x: Partial<ChatDesign>) => void;
	hasLogo: boolean;
}) {
	return (
		<>
			<Group title="Style">
				<div className="grid grid-cols-3 gap-2">
					{STYLES.map((s) => (
						<button
							key={s.name}
							type="button"
							onClick={() => look(s.look)}
							className="group flex flex-col items-start gap-1.5 rounded-lg border border-border/70 p-2 text-left text-xs transition-colors hover:border-foreground/30 hover:bg-muted/50"
						>
							<StyleThumb
								look={{ ...d, ...s.look }}
								color={d.color ?? "#2563eb"}
							/>
							<span className="font-medium">{s.name}</span>
						</button>
					))}
				</div>
				<p className="text-xs text-muted-foreground">
					A starting point: it sets the shape, header, bubbles and type below, and keeps
					your color and texts.
				</p>
			</Group>
			<Group title="Color">
				<ColorField
					label="Accent"
					value={d.color ?? "#2563eb"}
					onChange={(color) => look({ color })}
					swatches={PRESETS.map((value) => ({ name: "", value }))}
				/>
				<Labeled label="Theme">
					<Choice
						value={d.theme ?? "auto"}
						onChange={(theme) => look({ theme })}
						options={[
							["auto", "Auto"],
							["light", "Light"],
							["dark", "Dark"],
						]}
					/>
				</Labeled>
				<p className="text-xs text-muted-foreground">
					Auto follows the visitor's device (light or dark). Text on the accent turns dark
					on light colors, so it always reads.
				</p>
			</Group>
			<Group title="Header">
				<Labeled label="Style">
					<Choice
						value={d.header ?? "solid"}
						onChange={(header) => look({ header })}
						options={[
							["solid", "Color"],
							["gradient", "Gradient"],
							["plain", "Plain"],
						]}
					/>
				</Labeled>
				{d.header === "gradient" && (
					<ColorField
						label="Gradient to"
						value={d.color2 ?? d.color ?? "#2563eb"}
						onChange={(color2) => look({ color2 })}
						swatches={PRESETS.map((value) => ({ name: "", value }))}
					/>
				)}
				<SwitchRow
					label="Show the brand's logo"
					hint={
						hasLogo
							? "The logo from the brand's settings."
							: "This brand has no logo yet: add one in Settings › Brand."
					}
					checked={!!d.show_logo}
					onChange={(show_logo) => look({ show_logo })}
				/>
			</Group>
			<Group title="Shape">
				<Labeled label="Corners">
					<Choice
						value={d.corners ?? "rounded"}
						onChange={(corners) => look({ corners })}
						options={[
							["square", "Square"],
							["soft", "Soft"],
							["rounded", "Round"],
							["pill", "Pill"],
						]}
					/>
				</Labeled>
				<Labeled label="Size">
					<Choice
						value={d.width ?? "regular"}
						onChange={(width) => look({ width })}
						options={[
							["compact", "Compact"],
							["regular", "Regular"],
							["wide", "Wide"],
						]}
					/>
				</Labeled>
				<Labeled label="Shadow">
					<Choice
						value={d.shadow ?? "soft"}
						onChange={(shadow) => look({ shadow })}
						options={[
							["none", "None"],
							["soft", "Soft"],
							["strong", "Strong"],
						]}
					/>
				</Labeled>
			</Group>
			<Group title="Messages">
				<Labeled label="Visitor">
					<Choice
						value={d.bubbles ?? "filled"}
						onChange={(bubbles) => look({ bubbles })}
						options={[
							["filled", "Filled"],
							["soft", "Soft"],
							["outline", "Outline"],
						]}
					/>
				</Labeled>
				<Labeled label="Team">
					<Choice
						value={d.team_bubbles ?? "gray"}
						onChange={(team_bubbles) => look({ team_bubbles })}
						options={[
							["gray", "Gray"],
							["accent", "Tinted"],
							["outline", "Outline"],
						]}
					/>
				</Labeled>
				<Field>
					<FieldLabel>Background</FieldLabel>
					<div className="grid grid-cols-5 gap-1.5">
						{BACKGROUNDS.map(([x, l]) => (
							<button
								key={x}
								type="button"
								aria-pressed={(d.background ?? "plain") === x}
								onClick={() => look({ background: x })}
								className={cn(
									"flex flex-col items-center gap-1 rounded-md border p-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground",
									(d.background ?? "plain") === x
										? "border-foreground/60 text-foreground"
										: "border-border/70",
								)}
							>
								<span
									className="block h-8 w-full rounded-[4px] border border-border/60 bg-background"
									style={backgroundSwatch(x, d.color ?? "#2563eb")}
								/>
								{l}
							</button>
						))}
					</div>
				</Field>
			</Group>
			<Group title="Text">
				<Field>
					<FieldLabel>Font</FieldLabel>
					<Select
						value={d.font ?? "system"}
						onValueChange={(font) => look({ font: font as ChatDesign["font"] })}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{FONT_CHOICES.map(([x, l, family]) => (
								<SelectItem
									key={x}
									value={x}
								>
									<span style={{ fontFamily: family }}>{l}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>
						“Your website's” uses the font of the page it's on, so it blends in.
					</FieldDescription>
				</Field>
				<Labeled label="Size">
					<Choice
						value={d.text_size ?? "medium"}
						onChange={(text_size) => look({ text_size })}
						options={[
							["small", "Small"],
							["medium", "Medium"],
							["large", "Large"],
						]}
					/>
				</Labeled>
				<Field>
					<FieldLabel>Language</FieldLabel>
					<Choice
						value={d.language ?? "en"}
						onChange={(language) => look({ language })}
						options={[
							["en", "English"],
							["es", "Español"],
						]}
					/>
					<FieldDescription>
						The chat's own words: buttons, notices, errors and the emails visitors get
						with your replies. Your greeting and texts stay as you write them.
					</FieldDescription>
				</Field>
			</Group>
			<Group title="Launcher">
				<Labeled label="Shape">
					<Choice
						value={d.launcher ?? "bubble"}
						onChange={(launcher) => look({ launcher })}
						options={[
							["bubble", "Bubble"],
							["label", "With text"],
							["auto", "After first use"],
							["hidden", "None"],
						]}
					/>
				</Labeled>
				{(d.launcher === "hidden" || d.launcher === "auto") && (
					<p className="text-xs text-muted-foreground">
						{d.launcher === "auto"
							? "No button until they open the chat from yours; then the bubble stays, so they can come back to it. They can put it away with its × or «Hide chat» in the ⋯ menu; it comes back when they open the chat again or you reply."
							: "No button:"}{" "}
						Open it from your own, with{" "}
						<code className="font-mono">MailroomChat.open()</code> or a link to{" "}
						<code className="font-mono">#mailroom-chat</code> (see Install).
					</p>
				)}
				{d.launcher !== "hidden" && (
					<Field>
						<FieldLabel>Icon</FieldLabel>
						<div className="grid grid-cols-7 gap-1.5">
							{LAUNCHER_ICONS.map(([x, Icon, l]) => (
								<button
									key={x}
									type="button"
									title={l}
									aria-label={l}
									aria-pressed={(d.launcher_icon ?? "chat") === x}
									disabled={x === "logo" && !hasLogo}
									onClick={() => look({ launcher_icon: x })}
									className={cn(
										"flex aspect-square items-center justify-center rounded-md border transition-colors disabled:opacity-40",
										(d.launcher_icon ?? "chat") === x
											? "border-transparent text-white"
											: "border-border/70 text-muted-foreground hover:text-foreground",
									)}
									style={
										(d.launcher_icon ?? "chat") === x
											? { background: d.color ?? "#2563eb" }
											: undefined
									}
								>
									<Icon className="size-4" />
								</button>
							))}
						</div>
					</Field>
				)}
				{d.launcher !== "hidden" && (
					<Labeled label="Size">
						<Choice
							value={d.launcher_size ?? "medium"}
							onChange={(launcher_size) => look({ launcher_size })}
							options={[
								["small", "Small"],
								["medium", "Medium"],
								["large", "Large"],
							]}
						/>
					</Labeled>
				)}
				{d.launcher === "label" && (
					<Labeled label="Text">
						<Input
							value={d.launcher_text ?? ""}
							maxLength={40}
							placeholder="Chat with us"
							onChange={(e) => look({ launcher_text: e.target.value })}
						/>
					</Labeled>
				)}
				<Labeled label="Corner">
					<Choice
						value={d.position ?? "right"}
						onChange={(position) => look({ position })}
						options={[
							["left", "Bottom left"],
							["right", "Bottom right"],
						]}
					/>
				</Labeled>
				<Labeled label="Spacing">
					<div className="grid grid-cols-2 gap-2">
						<NumberIn
							label="From the side"
							value={d.offset_x ?? 20}
							onChange={(offset_x) => look({ offset_x })}
						/>
						<NumberIn
							label="From the bottom"
							value={d.offset_y ?? 20}
							onChange={(offset_y) => look({ offset_y })}
						/>
					</div>
				</Labeled>
			</Group>
			<Group title="Showing it">
				<Field>
					<FieldLabel>Pop up the greeting</FieldLabel>
					<Select
						value={String(d.nudge_after ?? 0)}
						onValueChange={(x) => look({ nudge_after: Number(x) })}
					>
						<SelectTrigger className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{[
								["0", "Never"],
								["5", "After 5 seconds"],
								["10", "After 10 seconds"],
								["30", "After 30 seconds"],
								["60", "After a minute"],
							].map(([x = "", l]) => (
								<SelectItem
									key={x}
									value={x}
								>
									{l}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<FieldDescription>
						Once a visit, by the launcher, until they open the chat. See it with
						“Pop-up” above the preview.
					</FieldDescription>
				</Field>
				<SwitchRow
					label="Hide the launcher on phones"
					hint="Your own buttons and #mailroom-chat links still open it."
					checked={!!d.hide_mobile}
					onChange={(hide_mobile) => look({ hide_mobile })}
				/>
			</Group>
			<Group title="Advanced">
				<Field>
					<FieldLabel htmlFor="chat-z">Stacking order (z-index)</FieldLabel>
					<Input
						id="chat-z"
						type="number"
						min={1}
						placeholder="2147483000"
						value={d.z_index ?? ""}
						onChange={(e) =>
							look({
								z_index: e.target.value ? Number(e.target.value) || null : null,
							})
						}
						className="tabular-nums"
					/>
					<FieldDescription>
						Only if your site's own popups should sit above the chat.
					</FieldDescription>
				</Field>
				<Field>
					<FieldLabel htmlFor="chat-css">Your own CSS</FieldLabel>
					<Textarea
						id="chat-css"
						rows={6}
						spellCheck={false}
						maxLength={10000}
						placeholder={".head { letter-spacing: .02em }\n.msg { font-weight: 500 }"}
						value={d.custom_css ?? ""}
						onChange={(e) => look({ custom_css: e.target.value || null })}
						className="font-mono text-xs"
					/>
					<FieldDescription>
						Applies inside the chat only. Parts: .launcher, .panel, .head, .body, .msg,
						.me .msg (the visitor's), .foot, .box, .send, .card, .nudge.
					</FieldDescription>
				</Field>
			</Group>
		</>
	);
}

const BACKGROUNDS: [NonNullable<ChatDesign["background"]>, string][] = [
	["plain", "Plain"],
	["tint", "Tint"],
	["gradient", "Glow"],
	["dots", "Dots"],
	["grid", "Grid"],
];

function backgroundSwatch(x: string, color: string) {
	const n = Number.parseInt(color.slice(1), 16);
	const t = (a: number) => `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
	if (x === "tint") return { background: `linear-gradient(180deg,${t(0.14)},${t(0.03)})` };
	if (x === "gradient")
		return { background: `radial-gradient(120% 80% at 50% 0%,${t(0.28)},transparent 70%)` };
	if (x === "dots")
		return {
			backgroundImage: `radial-gradient(${t(0.4)} 1px,transparent 1.2px)`,
			backgroundSize: "6px 6px",
		};
	if (x === "grid")
		return {
			backgroundImage: `linear-gradient(${t(0.18)} 1px,transparent 1px),linear-gradient(90deg,${t(0.18)} 1px,transparent 1px)`,
			backgroundSize: "8px 8px",
		};
	return {};
}

const FONT_CHOICES: [NonNullable<ChatDesign["font"]>, string, string][] = [
	["system", "System (clean, every device)", "system-ui,sans-serif"],
	["site", "Your website's font", "inherit"],
	["rounded", "Rounded (friendly)", "ui-rounded,'SF Pro Rounded',Nunito,system-ui,sans-serif"],
	["serif", "Serif (classic)", "ui-serif,Georgia,serif"],
	["mono", "Monospace (technical)", "ui-monospace,Menlo,monospace"],
];

const LAUNCHER_ICONS: [NonNullable<ChatDesign["launcher_icon"]>, typeof MessageCircle, string][] = [
	["chat", MessageCircle, "Chat bubble"],
	["message", MessageSquareText, "Message"],
	["help", CircleHelp, "Question"],
	["headset", Headset, "Support"],
	["sparkle", Sparkles, "Sparkle"],
	["hand", Hand, "Wave"],
	["logo", ImageIcon, "Your logo"],
];

const STYLES: { name: string; look: Partial<ChatDesign> }[] = [
	{
		name: "Modern",
		look: {
			corners: "rounded",
			header: "solid",
			background: "plain",
			bubbles: "filled",
			team_bubbles: "gray",
			font: "system",
			shadow: "soft",
			width: "regular",
		},
	},
	{
		name: "Minimal",
		look: {
			corners: "soft",
			header: "plain",
			background: "plain",
			bubbles: "soft",
			team_bubbles: "outline",
			font: "site",
			shadow: "none",
			width: "regular",
		},
	},
	{
		name: "Friendly",
		look: {
			corners: "pill",
			header: "gradient",
			background: "tint",
			bubbles: "filled",
			team_bubbles: "accent",
			font: "rounded",
			shadow: "soft",
			width: "regular",
		},
	},
	{
		name: "Elegant",
		look: {
			corners: "soft",
			header: "plain",
			background: "gradient",
			bubbles: "outline",
			team_bubbles: "gray",
			font: "serif",
			shadow: "soft",
			width: "wide",
		},
	},
	{
		name: "Bold",
		look: {
			corners: "square",
			header: "solid",
			background: "grid",
			bubbles: "filled",
			team_bubbles: "gray",
			font: "system",
			shadow: "strong",
			width: "wide",
		},
	},
	{
		name: "Playful",
		look: {
			corners: "pill",
			header: "gradient",
			background: "dots",
			bubbles: "soft",
			team_bubbles: "accent",
			font: "rounded",
			shadow: "strong",
			width: "compact",
		},
	},
];

function StyleThumb({ look: l, color }: { look: Partial<ChatDesign>; color: string }) {
	const r = { square: 2, soft: 5, rounded: 8, pill: 11 }[l.corners ?? "rounded"] ?? 8;
	const head =
		l.header === "plain"
			? { background: "var(--background)", borderBottom: "1px solid var(--border)" }
			: l.header === "gradient"
				? { background: `linear-gradient(135deg,${color},${l.color2 ?? `${color}99`})` }
				: { background: color };
	const me =
		l.bubbles === "soft"
			? { background: `${color}33` }
			: l.bubbles === "outline"
				? { boxShadow: `inset 0 0 0 1.5px ${color}` }
				: { background: color };
	const team =
		l.team_bubbles === "outline"
			? { boxShadow: "inset 0 0 0 1px var(--border)" }
			: l.team_bubbles === "accent"
				? { background: `${color}22` }
				: { background: "var(--muted)" };
	return (
		<span
			className="block w-full overflow-hidden border border-border/70 bg-background"
			style={{ borderRadius: r }}
			aria-hidden="true"
		>
			<span
				className="block h-3"
				style={head}
			/>
			<span
				className="flex h-12 flex-col gap-1 p-1.5"
				style={backgroundSwatch(l.background ?? "plain", color)}
			>
				<span
					className="block h-2.5 w-3/5"
					style={{ ...team, borderRadius: Math.min(r, 6) }}
				/>
				<span
					className="ml-auto block h-2.5 w-1/2"
					style={{ ...me, borderRadius: Math.min(r, 6) }}
				/>
			</span>
		</span>
	);
}

function NumberIn({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (v: number) => void;
}) {
	return (
		<span className="relative">
			<Input
				type="number"
				min={0}
				max={200}
				aria-label={label}
				title={label}
				value={value}
				onChange={(e) => onChange(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
				className="pr-7 tabular-nums"
			/>
			<span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">
				px
			</span>
		</span>
	);
}
