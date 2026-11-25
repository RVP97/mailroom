import interLatin from "@fontsource-variable/inter/files/inter-latin-opsz-normal.woff2?url";
import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import { useEffect } from "react";
import { PageMissing } from "@/components/route-states";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keepTapsInScrollLocks } from "@/lib/tap-slop";
import { FirstPaint } from "@/routes/_app";
import appCss from "@/styles.css?url";

// Dark unless you picked light (or "system" on a light system): Mailroom is designed dark first.
const themeScript = `(function(){var d=true;try{var t=localStorage.getItem('theme');d=t==='system'?matchMedia('(prefers-color-scheme: dark)').matches:t!=='light'}catch(e){}document.documentElement.classList.toggle('dark',d)})();`;

export const Route = createRootRoute({
	// Lets the public pages (about, privacy, terms) render on the server; the dashboard's routes
	// keep defaultSsr: false.
	ssr: true,
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				content:
					"width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content",
			},
			{ title: "Mailroom" },
			{ name: "robots", content: "noindex" },
			{ name: "theme-color", content: "#0c0c0d" },
			{ name: "apple-mobile-web-app-capable", content: "yes" },
			{ name: "apple-mobile-web-app-title", content: "Mailroom" },
		],
		links: [
			{
				rel: "preload",
				href: interLatin,
				as: "font",
				type: "font/woff2",
				crossOrigin: "anonymous",
			},
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
			{ rel: "manifest", href: "/manifest.webmanifest" },
		],
	}),
	shellComponent: RootDocument,
	// The server's page for every address (the dashboard renders in the browser).
	pendingComponent: FirstPaint,
	notFoundComponent: PageMissing,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	useEffect(() => keepTapsInScrollLocks(), []);
	return (
		<html
			lang="en"
			suppressHydrationWarning
		>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme bootstrap, before paint */}
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
				<HeadContent />
			</head>
			<body>
				<ThemeProvider>
					<TooltipProvider>
						{children}
						<Toaster position="bottom-right" />
					</TooltipProvider>
				</ThemeProvider>
				<Scripts />
			</body>
		</html>
	);
}
