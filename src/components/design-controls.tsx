import type { ReactNode } from "react";
import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/** The small controls of the builders' side panels (sign-up forms, emails). */

export function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-4 border-b border-border/70 px-5 py-5 last:border-b-0">
			<h3 className="text-[13px] font-semibold">{title}</h3>
			{children}
		</section>
	);
}

// ── Controls ────────────────────────────────────────────────────────────────

export function Labeled({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-3">
			<span className="text-sm text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}

export function SwitchRow({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is a button, which a label names
		<label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
			<span>
				{label}
				{hint && <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>}
			</span>
			<Switch
				checked={checked}
				onCheckedChange={onChange}
			/>
		</label>
	);
}

export function Choice<T extends string>({
	value,
	onChange,
	options,
}: {
	value: T;
	onChange: (v: T) => void;
	options: [T, string][];
}) {
	return (
		<ToggleGroup
			type="single"
			variant="outline"
			size="sm"
			value={value}
			onValueChange={(x) => x && onChange(x as T)}
			className="w-full"
		>
			{options.map(([x, l]) => (
				<ToggleGroupItem
					key={x}
					value={x}
					className="flex-1 px-1.5"
				>
					{l}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

export function ColorField({
	label,
	value,
	onChange,
	swatches,
	locked,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	/** A brand kit's colors, offered first. */
	swatches?: { name: string; value: string }[];
	/** Only the swatches can be picked (a locked brand kit). */
	locked?: boolean;
}) {
	const [text, setText] = useState(value);
	const [was, setWas] = useState(value);
	if (was !== value) {
		setWas(value);
		setText(value);
	}
	if (locked && swatches?.length)
		return (
			<div className="flex flex-col gap-1.5">
				<span className="text-xs text-muted-foreground">{label}</span>
				<Swatches
					label={label}
					value={value}
					swatches={swatches}
					onChange={onChange}
				/>
			</div>
		);
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-xs text-muted-foreground">{label}</span>
			{swatches?.length ? (
				<Swatches
					label={label}
					value={value}
					swatches={swatches}
					onChange={onChange}
				/>
			) : null}
			<span className="flex h-9 items-center gap-2 rounded-md border border-input px-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30">
				<span
					className="relative size-6 shrink-0 overflow-hidden rounded-[5px] border border-black/10"
					style={{ background: value }}
				>
					<input
						type="color"
						aria-label={`${label} color`}
						value={value}
						onChange={(e) => onChange(e.target.value)}
						className="absolute inset-0 size-full cursor-pointer opacity-0"
					/>
				</span>
				<input
					spellCheck={false}
					aria-label={`${label} hex`}
					className="min-w-0 flex-1 bg-transparent font-mono text-xs uppercase outline-none"
					value={text}
					onChange={(e) => {
						const x = e.target.value.trim();
						setText(x);
						const hex = x.startsWith("#") ? x : `#${x}`;
						if (/^#[0-9a-f]{6}$/i.test(hex)) onChange(hex.toLowerCase());
					}}
				/>
			</span>
		</div>
	);
}

function Swatches({
	label,
	value,
	swatches,
	onChange,
}: {
	label: string;
	value: string;
	swatches: { name: string; value: string }[];
	onChange: (v: string) => void;
}) {
	return (
		<fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
			<legend className="sr-only">{`${label}: brand colors`}</legend>
			{swatches.map((s) => (
				<button
					key={s.value}
					type="button"
					aria-pressed={s.value === value}
					aria-label={s.name || s.value.toUpperCase()}
					title={s.name ? `${s.name} ${s.value.toUpperCase()}` : s.value.toUpperCase()}
					onClick={() => onChange(s.value)}
					className={cn(
						"size-5 rounded-[5px] border border-black/10 transition-transform hover:scale-110",
						s.value === value &&
							"ring-2 ring-foreground ring-offset-1 ring-offset-background",
					)}
					style={{ background: s.value }}
				/>
			))}
		</fieldset>
	);
}
