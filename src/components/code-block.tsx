import { useEffect, useState } from "react";
import { CopyIcon, useCopy } from "@/components/copy";
import { highlight, type Lang } from "@/lib/highlight";
import { cn } from "@/lib/utils";

const WELL =
	"overflow-hidden rounded-lg bg-[oklch(0.19_0.004_265)] text-[oklch(0.93_0.003_265)] shadow-[0_0_0_1px_oklch(0_0_0/0.08)] dark:bg-[oklch(0.13_0.002_265)] dark:shadow-[0_0_0_1px_oklch(1_0_0/0.07)]";

function Code({ code, lang }: { code: string; lang?: Lang }) {
	return (
		<pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-[1.7] [tab-size:2]">
			<code>{highlight(code, lang)}</code>
		</pre>
	);
}

function CopyCode({ code }: { code: string }) {
	const { copied, copy } = useCopy();
	return (
		<button
			type="button"
			aria-label={copied ? "Copied" : "Copy"}
			className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-white/60 hover:bg-white/[0.08] hover:text-white [&_.text-success]:text-[oklch(0.8_0.15_155)]"
			onClick={() => copy(code)}
		>
			<CopyIcon copied={copied} />
			{copied ? "Copied" : "Copy"}
		</button>
	);
}

/** Code in a dark well (in both themes, like a terminal), highlighted, with a copy button. */
export function CodeBlock({
	code,
	lang,
	className,
	title,
	data,
}: {
	code: string;
	lang?: Lang;
	className?: string;
	title?: string;
	/** It shows data (a request's body, an email's source): a placeholder while sketched. */
	data?: boolean;
}) {
	const { copied, copy } = useCopy();
	if (title)
		return (
			<div
				data-ph={data ? "" : undefined}
				className={cn(WELL, className)}
			>
				<div className="flex h-10 items-center gap-2 border-b border-white/[0.07] pr-1.5 pl-4">
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-white/50">
						{title}
					</span>
					<CopyCode code={code} />
				</div>
				<Code
					code={code}
					lang={lang}
				/>
			</div>
		);
	return (
		<div
			data-ph={data ? "" : undefined}
			className={cn("group relative", WELL, className)}
		>
			<Code
				code={code}
				lang={lang}
			/>
			<button
				type="button"
				aria-label={copied ? "Copied" : "Copy"}
				className="pressable absolute top-2 right-2 flex size-7 items-center justify-center rounded-md bg-white/[0.06] text-white/60 opacity-0 backdrop-blur hover:bg-white/[0.12] hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [&_.text-success]:text-[oklch(0.8_0.15_155)]"
				onClick={() => copy(code)}
			>
				<CopyIcon copied={copied} />
			</button>
		</div>
	);
}

const LANG_KEY = "mailroom.api-lang";
const listeners = new Set<(label: string) => void>();

/** The reader's language for code tabs, remembered across pages and shared by every block on one. */
export function useCodeLang() {
	const [label, setLabel] = useState<string | undefined>();
	useEffect(() => {
		try {
			const saved = localStorage.getItem(LANG_KEY);
			// Older versions saved the tab's index; those fall back to the first tab.
			if (saved && Number.isNaN(Number(saved))) setLabel(saved);
		} catch {}
		listeners.add(setLabel);
		return () => {
			listeners.delete(setLabel);
		};
	}, []);
	const choose = (next: string) => {
		try {
			localStorage.setItem(LANG_KEY, next);
		} catch {}
		for (const l of listeners) l(next);
	};
	return [label, choose] as const;
}

export type CodeTab = { label: string; code: string; lang?: Lang };

/** Several versions of one snippet (languages), switched by tabs in the well's header. */
export function CodeTabs({
	tabs,
	title,
	className,
	data,
}: {
	tabs: CodeTab[];
	/** What the snippet does, shown at the left of the header. */
	title?: string;
	className?: string;
	/** Its code shows the organization's own values: a placeholder while sketched. */
	data?: boolean;
}) {
	const [label, choose] = useCodeLang();
	const active = Math.max(
		0,
		tabs.findIndex((t) => t.label === label),
	);
	const tab = tabs[active];
	return (
		<div
			data-ph={data ? "" : undefined}
			className={cn(WELL, className)}
		>
			<div className="flex items-center gap-3 border-b border-white/[0.07] pr-1.5 pl-2">
				{title && (
					<span className="hidden shrink-0 pl-2 font-mono text-xs text-white/50 sm:block">
						{title}
					</span>
				)}
				<div
					role="tablist"
					className={cn(
						"flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none]",
						title && "sm:justify-end",
					)}
				>
					{tabs.map((t, i) => (
						<button
							key={t.label}
							type="button"
							role="tab"
							aria-selected={i === active}
							onClick={() => choose(t.label)}
							className={cn(
								"relative h-10 shrink-0 px-2 text-xs font-medium transition-colors duration-150",
								i === active ? "text-white" : "text-white/50 hover:text-white/80",
								"after:absolute after:inset-x-2 after:-bottom-px after:h-[1.5px] after:rounded-full after:bg-white after:transition-opacity",
								i === active ? "after:opacity-100" : "after:opacity-0",
							)}
						>
							{t.label}
						</button>
					))}
				</div>
				<CopyCode code={tab?.code ?? ""} />
			</div>
			<Code
				code={tab?.code ?? ""}
				lang={tab?.lang}
			/>
		</div>
	);
}
