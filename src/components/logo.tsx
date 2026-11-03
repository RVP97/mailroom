import { useId } from "react";
import { cn } from "@/lib/utils";

/** The holes along a postage stamp's edge, six to a side. */
const PERFORATION: [number, number][] = [
	[0, 0],
	[0, 32],
	[32, 0],
	[5.333, 0],
	[5.333, 32],
	[0, 5.333],
	[32, 5.333],
	[10.667, 0],
	[10.667, 32],
	[0, 10.667],
	[32, 10.667],
	[16, 0],
	[16, 32],
	[0, 16],
	[32, 16],
	[21.333, 0],
	[21.333, 32],
	[0, 21.333],
	[32, 21.333],
	[26.667, 0],
	[26.667, 32],
	[0, 26.667],
	[32, 26.667],
	[32, 32],
];

/**
 * Mailroom's mark: a postage stamp (blue, perforated, with a faint inner frame) carrying an
 * envelope's flap drawn as an M.
 */
export function Mark({ className }: { className?: string }) {
	const id = useId();
	return (
		<svg
			viewBox="0 0 32 32"
			className={cn("size-7 shrink-0", className)}
			aria-hidden="true"
		>
			<defs>
				<mask id={`${id}-perf`}>
					<rect
						width="32"
						height="32"
						fill="#fff"
					/>
					{PERFORATION.map(([cx, cy]) => (
						<circle
							key={`${cx}-${cy}`}
							cx={cx}
							cy={cy}
							r="1.6"
							fill="#000"
						/>
					))}
				</mask>
				<linearGradient
					id={`${id}-fill`}
					x1="0"
					y1="0"
					x2="0"
					y2="1"
				>
					<stop
						offset="0"
						stopColor="#4b82ff"
					/>
					<stop
						offset="1"
						stopColor="#2150e6"
					/>
				</linearGradient>
			</defs>
			<rect
				width="32"
				height="32"
				fill={`url(#${id}-fill)`}
				mask={`url(#${id}-perf)`}
			/>
			<rect
				x="4.25"
				y="4.25"
				width="23.5"
				height="23.5"
				rx="1"
				fill="none"
				stroke="#fff"
				strokeOpacity=".22"
				strokeWidth=".75"
			/>
			<path
				d="M10.25 20.5V12.25L16 17.1l5.75-4.85v8.25"
				fill="none"
				stroke="#fff"
				strokeWidth="2.3"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function Logo({ className }: { className?: string }) {
	return (
		<div className={cn("flex items-center gap-2.5", className)}>
			<Mark className="size-7" />
			<span className="text-[17px] font-semibold tracking-[-0.02em]">Mailroom</span>
		</div>
	);
}
