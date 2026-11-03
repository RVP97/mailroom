import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { cn } from "@/lib/utils";

/**
 * The sign-in page's right half: Mailroom at work. Emails arrive at the top of a log and walk
 * through their lives (queued, sent, delivered, opened) while the counters tick. Always dark,
 * whatever the theme, like a window onto the product. Still when motion is reduced.
 */

const SAMPLES = [
	{ to: "ana.lucia@lumen.travel", subject: "Your reservation is confirmed" },
	{ to: "billing@northwind.io", subject: "Invoice A-1029 is ready" },
	{ to: "marco@pliego.app", subject: "482193 is your sign-in code" },
	{ to: "sofia.paz@gmail.com", subject: "Your receipt from Globex" },
	{ to: "team@acme.com", subject: "Weekly sending report" },
	{ to: "diego.r@outlook.com", subject: "Payment received, thank you" },
	{ to: "laura@studionorte.co", subject: "New sign-in from Safari on Mac" },
	{ to: "ops@orbita.dev", subject: "Your export is ready to download" },
];

const STAGES = ["queued", "sent", "delivered", "opened"] as const;
const ROW = 52;
const SHOWN = 5;
const TICK = 1800;

type Row = { id: number; born: number };

export function AuthShowcase({ className }: { className?: string }) {
	const [tick, setTick] = useState(SHOWN + 3);
	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const t = setInterval(() => setTick((n) => n + 1), TICK);
		return () => clearInterval(t);
	}, []);
	// The newest row was born this tick; one more trails below, clipped, as the list moves down.
	const rows: Row[] = Array.from({ length: SHOWN + 1 }, (_, i) => ({
		id: tick - i,
		born: tick - i,
	}));
	// Each tick the whole list starts one row up and glides down together, so rows never cross.
	const list = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per tick
	useLayoutEffect(() => {
		const el = list.current;
		if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		el.style.transition = "none";
		el.style.transform = `translateY(-${ROW}px)`;
		void el.offsetHeight;
		el.style.transition = "transform 700ms cubic-bezier(0.23, 1, 0.32, 1)";
		el.style.transform = "translateY(0)";
	}, [tick]);
	const sent = 38_442 + tick * 3;
	return (
		<div
			className={cn(
				"dark relative isolate flex flex-col items-center justify-center overflow-hidden bg-[oklch(0.155_0.008_268)] px-10 py-16 text-foreground shadow-[inset_0_1px_0_oklch(1_0_0/0.05),0_0_0_1px_oklch(1_0_0/0.07)]",
				className,
			)}
		>
			{/* Dot grid, fading toward the edges, and a stamp-blue glow behind the log. */}
			<div
				aria-hidden="true"
				className="absolute inset-0 -z-10 [background-image:radial-gradient(oklch(1_0_0/0.13)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_45%,#000_30%,transparent_100%)]"
			/>
			<div
				aria-hidden="true"
				className="absolute top-[18%] left-1/2 -z-10 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-[oklch(0.55_0.21_263/0.3)] blur-[120px]"
			/>
			<Postmark className="absolute top-10 right-10 w-44 text-white/[0.09]" />

			<div className="flex w-full max-w-[460px] flex-col">
				<div
					aria-hidden="true"
					className="w-full overflow-hidden rounded-xl bg-[oklch(0.17_0.006_268/0.85)] shadow-[inset_0_1px_0_oklch(1_0_0/0.06),0_0_0_1px_oklch(1_0_0/0.08),0_24px_64px_-12px_oklch(0_0_0/0.6)] backdrop-blur"
				>
					<div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
						<span className="flex items-center gap-2 text-xs font-medium">
							<span className="relative flex size-1.5">
								<span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60 [animation-duration:1.8s]" />
								<span className="relative inline-flex size-1.5 rounded-full bg-success" />
							</span>
							Emails
						</span>
						<span className="text-xs text-white/50 tabular-nums">
							{sent.toLocaleString("en-US")} sent · 98.7% delivered
						</span>
					</div>
					<div
						className="relative overflow-hidden [mask-image:linear-gradient(to_bottom,#000_72%,transparent)]"
						style={{ height: ROW * SHOWN }}
					>
						<div ref={list}>
							{rows.map((r, i) => {
								const sample = SAMPLES[
									((r.id % SAMPLES.length) + SAMPLES.length) % SAMPLES.length
								] as (typeof SAMPLES)[number];
								const stage =
									STAGES[Math.min(tick - r.born, STAGES.length - 1)] ?? "queued";
								return (
									<div
										key={r.id}
										className={cn(
											"flex items-center gap-3 border-b border-white/[0.06] px-4",
											i === 0 &&
												"animate-[fade-in_500ms_cubic-bezier(0.23,1,0.32,1)_120ms_both]",
										)}
										style={{ height: ROW }}
									>
										<div className="min-w-0 flex-1">
											<p className="truncate text-[13px] font-medium">
												{sample.to}
											</p>
											<p className="truncate text-xs text-white/45">
												{sample.subject}
											</p>
										</div>
										<StatusBadge status={stage} />
									</div>
								);
							})}
						</div>
					</div>
				</div>

				<div className="mt-12">
					<h2 className="max-w-md text-[28px] leading-[1.15] font-semibold tracking-[-0.025em] text-balance">
						Every email, accounted for.
					</h2>
					<p className="mt-3 max-w-md text-[15px] leading-relaxed text-white/55 text-pretty">
						Sending, events and reputation for each of your businesses, on your own
						Amazon SES.
					</p>
				</div>
			</div>
		</div>
	);
}

/** A postmark's wavy cancellation lines and its round date stamp. */
function Postmark({ className }: { className?: string }) {
	const wave = "M0 6 Q 10 0 20 6 T 40 6 T 60 6 T 80 6 T 100 6 T 120 6";
	return (
		<svg
			viewBox="0 0 180 72"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			className={className}
			aria-hidden="true"
		>
			<circle
				cx="36"
				cy="36"
				r="30"
			/>
			<circle
				cx="36"
				cy="36"
				r="23"
				strokeWidth="1.2"
			/>
			{[14, 26, 38, 50].map((y) => (
				<path
					key={y}
					d={wave}
					transform={`translate(64 ${y - 6})`}
				/>
			))}
		</svg>
	);
}
