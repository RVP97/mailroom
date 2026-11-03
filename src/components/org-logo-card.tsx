import { useRouter } from "@tanstack/react-router";
import { Check, ImageUp, Plus, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { OrgAvatar } from "@/components/org-avatar";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { setOrgLogoBackgroundFn, setOrgLogoFn } from "@/functions/settings";
import { errorMessage } from "@/lib/errors";
import { forgetMe, useMe } from "@/lib/me";
import {
	backgroundColor,
	LOGO_ACCEPT,
	setBackgroundOverride,
	setLogoOverride,
	squareLogo,
	useOrgLogo,
	useOrgLogoBackground,
} from "@/lib/org-logo";
import { cn } from "@/lib/utils";

/**
 * The organization's logo, which the switcher, sidebar and command menu show. Dropped or picked,
 * it shows everywhere at once while it uploads. Without one, a domain's brand logo (BIMI) stands
 * in, else the initial.
 */
export function OrgLogoCard({ canManage }: { canManage: boolean }) {
	const me = useMe();
	const router = useRouter();
	const org = me.active;
	const logo = org?.logo ?? null;
	const input = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const [busy, setBusy] = useState(false);
	const [removing, setRemoving] = useState(false);
	const shown = useOrgLogo(org?.id, logo?.url);
	if (!org) return null;
	const id = org.id;
	// What's showing: an uploaded logo, a domain's, or none.
	const own = shown !== null && (shown.startsWith("data:") || shown.startsWith("/logos/"));
	const bimiDomain = !own && shown ? (logo?.domain ?? logo?.fallback?.domain) : undefined;

	async function save(image: string | null, optimistic: string | null) {
		setLogoOverride(id, optimistic);
		setBusy(true);
		try {
			await setOrgLogoFn({ data: { image } });
			forgetMe();
			await router.invalidate();
			toast.success(image ? "Logo saved" : "Logo removed");
			// The saved one is what Me now has; a new upload keeps its own copy, already loaded.
			if (!image) setLogoOverride(id, undefined);
		} catch (error) {
			setLogoOverride(id, undefined);
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	}

	async function pick(file: File | undefined) {
		if (input.current) input.current.value = "";
		if (!file || !canManage) return;
		let image: string;
		try {
			image = await squareLogo(file);
		} catch (error) {
			return void toast.error(error instanceof Error ? error.message : "Not an image");
		}
		await save(image, image);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle>Logo</CardTitle>
				<CardDescription>
					Shows in the organization switcher, so it's easy to tell organizations apart.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="flex items-center gap-4">
					<button
						type="button"
						disabled={!canManage || busy}
						onClick={() => input.current?.click()}
						onDragOver={(e) => {
							if (!canManage) return;
							e.preventDefault();
							setDragging(true);
						}}
						onDragLeave={() => setDragging(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDragging(false);
							void pick(e.dataTransfer.files[0]);
						}}
						aria-label={shown ? "Replace the logo" : "Upload a logo"}
						className={cn(
							"group relative size-16 shrink-0 rounded-xl transition-[box-shadow,transform] enabled:cursor-pointer enabled:active:scale-[0.97]",
							dragging && "ring-2 ring-primary ring-offset-2 ring-offset-card",
						)}
					>
						{shown ? (
							<OrgAvatar
								name={org.name}
								id={id}
								logo={logo?.url}
								background={logo?.background}
								className="size-16 rounded-xl"
							/>
						) : (
							<span className="flex size-16 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed border-border-strong bg-muted/40 text-[11px] text-muted-foreground transition-colors group-enabled:group-hover:border-primary group-enabled:group-hover:text-foreground">
								<ImageUp className="size-4" />
								{canManage ? "Drop" : "None"}
							</span>
						)}
						{shown && canManage && (
							<span className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/45 text-white opacity-0 transition-opacity group-enabled:group-hover:opacity-100 group-focus-visible:opacity-100">
								<ImageUp className="size-4" />
							</span>
						)}
					</button>
					<input
						ref={input}
						type="file"
						accept={LOGO_ACCEPT}
						className="hidden"
						onChange={(e) => void pick(e.target.files?.[0])}
					/>
					<div className="min-w-0 flex-1 text-sm">
						<p className="font-medium">
							{own
								? "Your logo"
								: bimiDomain
									? `The brand logo of ${bimiDomain}`
									: "No logo yet"}
						</p>
						<p className="mt-0.5 text-xs text-muted-foreground text-pretty">
							{own
								? "Shown as a square. Replace it any time."
								: bimiDomain
									? "Mailroom uses the domain's inbox logo (BIMI) until you upload one."
									: "A square PNG, JPEG, WebP or SVG works best. Without one, the switcher shows its initial."}
						</p>
					</div>
				</div>
				{shown && (
					<BackgroundPicker
						id={id}
						saved={logo?.background ?? null}
						canManage={canManage}
					/>
				)}
			</CardContent>
			{canManage && (
				<CardFooter className="gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => input.current?.click()}
					>
						<ImageUp />
						{own ? "Replace logo" : "Upload logo"}
					</Button>
					{own && (
						<Button
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => setRemoving(true)}
						>
							<Trash2 />
							Remove
						</Button>
					)}
				</CardFooter>
			)}
			<Confirm
				open={removing}
				onOpenChange={setRemoving}
				title="Remove the logo?"
				description={
					logo?.fallback
						? `The switcher shows the brand logo of ${logo.fallback.domain} instead.`
						: "The switcher shows the organization's initial instead."
				}
				action="Remove logo"
				cancel="Keep it"
				onConfirm={() => void save(null, logo?.fallback?.url ?? null)}
			/>
		</Card>
	);
}

const PRESETS = ["#0d2b29", "#1d2a44", "#7a1f2b", "#f6c945", "#eef0f3"];

/**
 * What shows behind the logo: nothing (the logo as it is), white, black or any color. Mostly for
 * transparent logos, which otherwise sit straight on the sidebar.
 */
function BackgroundPicker({
	id,
	saved,
	canManage,
}: {
	id: string;
	saved: string | null;
	canManage: boolean;
}) {
	const router = useRouter();
	const current = useOrgLogoBackground(id, saved);
	const [custom, setCustom] = useState("");
	const [open, setOpen] = useState(false);
	const isCustom = current !== null && current !== "white" && current !== "black";

	async function choose(value: string | null) {
		setOpen(false);
		if (value === current) return;
		setBackgroundOverride(id, value);
		try {
			await setOrgLogoBackgroundFn({ data: { background: value } });
			forgetMe();
			await router.invalidate();
		} catch (error) {
			setBackgroundOverride(id, undefined);
			toast.error(await errorMessage(error));
		}
	}

	const swatch = (value: string | null, label: string) => (
		<button
			key={label}
			type="button"
			aria-pressed={current === value}
			aria-label={label}
			title={label}
			disabled={!canManage}
			onClick={() => void choose(value)}
			className={cn(
				"relative flex size-7 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_oklch(0.5_0_0/0.3)] transition-transform enabled:cursor-pointer enabled:active:scale-90",
				current === value && "ring-2 ring-primary ring-offset-2 ring-offset-card",
			)}
			style={value ? { background: backgroundColor(value) ?? undefined } : undefined}
		>
			{value === null && (
				// None: a slash across an empty circle.
				<span className="absolute h-px w-5 rotate-45 bg-muted-foreground" />
			)}
		</button>
	);

	return (
		<div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/70 pt-4">
			<span className="text-sm font-medium">Background</span>
			<fieldset
				aria-label="Background"
				className="flex items-center gap-2.5"
			>
				{swatch(null, "None")}
				{swatch("white", "White")}
				{swatch("black", "Black")}
				<Popover
					open={open}
					onOpenChange={(v) => {
						setOpen(v);
						if (v) setCustom(isCustom ? (current ?? "") : "");
					}}
				>
					<PopoverTrigger asChild>
						<button
							type="button"
							disabled={!canManage}
							aria-label="Another color"
							title="Another color"
							className={cn(
								"flex size-7 items-center justify-center rounded-full text-muted-foreground shadow-[inset_0_0_0_1px_oklch(0.5_0_0/0.3)] transition-transform enabled:cursor-pointer enabled:active:scale-90",
								isCustom && "ring-2 ring-primary ring-offset-2 ring-offset-card",
							)}
							style={isCustom ? { background: current ?? undefined } : undefined}
						>
							{!isCustom && <Plus className="size-3.5" />}
						</button>
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="w-60 p-3"
					>
						<div className="flex gap-2">
							{PRESETS.map((c) => (
								<button
									key={c}
									type="button"
									aria-label={c}
									title={c}
									onClick={() => void choose(c)}
									className="flex size-7 cursor-pointer items-center justify-center rounded-full shadow-[inset_0_0_0_1px_oklch(0.5_0_0/0.3)] active:scale-90"
									style={{ background: c }}
								>
									{current === c && (
										<Check className="size-3.5 text-white mix-blend-difference" />
									)}
								</button>
							))}
						</div>
						<form
							className="mt-3 flex items-center gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								const v = custom
									.trim()
									.replace(/^(?!#)/, "#")
									.toLowerCase();
								if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v))
									return void toast.error("Type a color like #0d2b29.");
								void choose(
									v.length === 4
										? `#${[...v.slice(1)].map((c) => c + c).join("")}`
										: v,
								);
							}}
						>
							<span
								aria-hidden="true"
								className="size-7 shrink-0 rounded-md shadow-[inset_0_0_0_1px_oklch(0.5_0_0/0.3)]"
								style={{
									background: /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(custom.trim())
										? custom.trim().replace(/^(?!#)/, "#")
										: undefined,
								}}
							/>
							<Input
								value={custom}
								onChange={(e) => setCustom(e.target.value)}
								placeholder="#0d2b29"
								aria-label="Color"
								className="h-8 font-mono text-sm"
								spellCheck={false}
							/>
							<Button
								type="submit"
								size="sm"
							>
								Use
							</Button>
						</form>
					</PopoverContent>
				</Popover>
			</fieldset>
			<span className="text-xs text-muted-foreground">
				Behind a transparent logo. None shows the logo as it is.
			</span>
		</div>
	);
}
