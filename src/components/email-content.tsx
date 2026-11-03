import { Code2, MoreHorizontal, Paintbrush } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Confirm } from "@/components/confirm";
import { StarterPicker, Thumb } from "@/components/email-builder";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { type EmailDoc, renderEmail, type Theme } from "@/lib/email-doc";
import { htmlToText } from "@/lib/template-fill";

type Fields = { design: EmailDoc | null; html: string; text: string };

/**
 * An email's content on its page (broadcasts, templates): designed in the visual editor, written
 * as HTML, or not started yet (then its starting points).
 */
export function EmailContent({
	design,
	html,
	text,
	set,
	look,
	onBuild,
	extra,
	footer,
	theme,
}: Fields & {
	set: <K extends keyof Fields>(k: K, v: Fields[K]) => void;
	look: { logo: string | null; name: string };
	/** Colors and fonts the starting points take (a newsletter's). */
	theme?: Partial<Theme>;
	onBuild: () => void;
	/** Beside the tabs (a template picker). */
	extra?: ReactNode;
	footer?: ReactNode;
}) {
	const [tab, setTab] = useState("content");
	const [htmlMode, setHtmlMode] = useState(false);
	const [replacing, setReplacing] = useState(false);
	const empty = !design && !html.trim() && !htmlMode;
	const area =
		"h-[480px] resize-y rounded-none border-0 font-mono text-xs leading-relaxed shadow-none [field-sizing:fixed] focus-visible:shadow-none md:text-xs";

	if (empty)
		return (
			<Card className="gap-5 p-5">
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 className="font-semibold">Design the email</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Pick a starting point, then drag in blocks and write in place.
						</p>
					</div>
					{extra}
				</div>
				<StarterPicker
					brand={look}
					theme={theme}
					onPick={(d) => {
						set("design", d);
						onBuild();
					}}
				/>
				<button
					type="button"
					onClick={() => setHtmlMode(true)}
					className="self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					Or write the HTML yourself
				</button>
			</Card>
		);

	return (
		<Card className="min-w-0 gap-0 overflow-hidden p-0">
			<Confirm
				open={replacing}
				onOpenChange={setReplacing}
				title={design ? "Edit the HTML instead?" : "Design it visually instead?"}
				description={
					design
						? "The email becomes HTML you edit by hand. The visual design is left behind."
						: "You'll pick a starting design; the HTML you have now is replaced."
				}
				action={design ? "Switch to HTML" : "Start designing"}
				onConfirm={() => {
					if (design) {
						set("html", renderEmail(design));
						set("design", null);
						setHtmlMode(true);
					} else {
						set("html", "");
						setHtmlMode(false);
					}
				}}
			/>
			<Tabs
				value={tab}
				onValueChange={setTab}
				className="gap-0"
			>
				<div className="flex items-center justify-between gap-3 border-b border-border/70 px-5">
					<TabsList
						variant="line"
						className="justify-start *:after:bottom-0"
					>
						<TabsTrigger value="content">{design ? "Design" : "HTML"}</TabsTrigger>
						<TabsTrigger value="text">Plain text</TabsTrigger>
					</TabsList>
					<div className="flex items-center gap-1">
						{extra}
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label="More"
								>
									<MoreHorizontal />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuItem onSelect={() => setReplacing(true)}>
									{design ? <Code2 /> : <Paintbrush />}
									{design
										? "Edit the HTML instead"
										: "Design it visually instead"}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
				<TabsContent value="content">
					{design ? (
						<div className="flex flex-col items-center gap-4 px-5 py-8 text-center">
							<button
								type="button"
								onClick={onBuild}
								aria-label="Edit design"
								className="relative aspect-[4/3] w-full max-w-sm overflow-hidden rounded-xl bg-muted shadow-[0_0_0_1px_var(--border)] transition-shadow hover:shadow-[0_0_0_1px_var(--border),0_12px_24px_-12px_var(--shadow-color-strong)]"
							>
								<Thumb doc={design} />
							</button>
							<div>
								<p className="text-sm font-medium">Designed in the editor</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{design.blocks.length} blocks. The preview shows what people
									get.
								</p>
							</div>
							<Button onClick={onBuild}>
								<Paintbrush />
								Edit design
							</Button>
						</div>
					) : (
						<Textarea
							aria-label="HTML"
							spellCheck={false}
							wrap="off"
							value={html}
							onChange={(e) => set("html", e.target.value)}
							className={area}
						/>
					)}
				</TabsContent>
				<TabsContent value="text">
					<Textarea
						aria-label="Plain text"
						value={text}
						placeholder={htmlToText(design ? renderEmail(design) : html).slice(0, 2000)}
						onChange={(e) => set("text", e.target.value)}
						className={area}
					/>
				</TabsContent>
			</Tabs>
			{footer && (
				<p className="border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
					{footer}
				</p>
			)}
		</Card>
	);
}
