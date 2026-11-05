import { X } from "lucide-react";
import { useState } from "react";

/** A thin line over the dashboard: this is a demo, nothing is sent, and the way back. */
export function DemoBar() {
	const [open, setOpen] = useState(true);
	if (!open) return null;
	const site = import.meta.env.BASE_URL.replace(/demo\/?$/, "");
	return (
		<div className="fixed inset-x-0 bottom-3 z-[60] flex justify-center px-3 pointer-events-none">
			<div className="pointer-events-auto flex items-center gap-3 rounded-full bg-[oklch(0.2_0.006_265)] py-1.5 pr-1.5 pl-4 text-xs text-white/80 shadow-[0_0_0_1px_oklch(1_0_0/0.1),0_8px_24px_-6px_oklch(0_0_0/0.5)]">
				<span className="size-1.5 rounded-full bg-[oklch(0.67_0.18_263)]" />
				<span>
					A live demo: it runs in your browser and sends nothing. Changes last until you
					reload.
				</span>
				<a
					href={site}
					className="rounded-full bg-white/10 px-2.5 py-1 font-medium text-white hover:bg-white/15"
				>
					Mailroom
				</a>
				<button
					type="button"
					aria-label="Hide"
					onClick={() => setOpen(false)}
					className="grid size-6 place-items-center rounded-full text-white/50 hover:bg-white/10 hover:text-white"
				>
					<X className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
