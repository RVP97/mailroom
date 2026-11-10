import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/theme-provider";

/*
 * The toast's glyphs, after Ding's (MIT, github.com/YusufCeng1z/ding): a ring and its marks drawn
 * as strokes, so each one draws itself in and moves in its own way (styles.css, «Toasts»). Each is
 * keyed by its kind, so a toast that turns from loading into its result swaps the glyph with a
 * fresh animation instead of repainting the old one.
 */
const RING = "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18";
const MARKS = {
	success: [RING, "M7.9 12.4l3 3 5.3-6"],
	error: [RING, "M9.3 9.3l5.4 5.4", "M14.7 9.3l-5.4 5.4"],
	warning: [RING, "M12 7.6v5.2", "M12 16.3h.01"],
	info: [RING, "M12 11v5.2", "M12 7.8h.01"],
	loading: [RING],
} as const;

function ToastGlyph({ kind }: { kind: keyof typeof MARKS }) {
	return (
		<span
			className="toast-glyph"
			data-kind={kind}
			aria-hidden
		>
			<svg
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				{MARKS[kind].map((d) => (
					<path
						key={d}
						d={d}
						pathLength={1}
					/>
				))}
			</svg>
		</span>
	);
}

const icons = {
	success: (
		<ToastGlyph
			key="success"
			kind="success"
		/>
	),
	info: (
		<ToastGlyph
			key="info"
			kind="info"
		/>
	),
	warning: (
		<ToastGlyph
			key="warning"
			kind="warning"
		/>
	),
	error: (
		<ToastGlyph
			key="error"
			kind="error"
		/>
	),
	loading: (
		<ToastGlyph
			key="loading"
			kind="loading"
		/>
	),
};

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			gap={8}
			icons={icons}
			toastOptions={{ className: "font-sans" }}
			style={
				{
					"--width": "380px",
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "transparent",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
