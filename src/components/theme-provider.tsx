import { createContext, useCallback, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextValue {
	theme: Theme;
	resolvedTheme: "light" | "dark";
	setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
	theme: "dark",
	resolvedTheme: "dark",
	setTheme: () => {},
});

export function useTheme() {
	return useContext(ThemeContext);
}

function getSystemTheme(): "light" | "dark" {
	if (typeof window === "undefined") return "dark";
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "light" | "dark") {
	const root = document.documentElement;
	if (resolved === "dark") {
		root.classList.add("dark");
	} else {
		root.classList.remove("dark");
	}
	// The installed app's bar takes the sidebar's color of the theme in use (__root.tsx).
	const bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
	if (bar) bar.content = resolved === "dark" ? "#0b0c0e" : "#f6f7f9";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setThemeState] = useState<Theme>("dark");
	const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("dark");
	const [isMounted, setIsMounted] = useState(false);

	useEffect(() => {
		const stored = localStorage.getItem("theme") as Theme | null;
		// Dark first: until you choose, Mailroom is dark.
		const initial = stored ?? "dark";
		setThemeState(initial);

		const resolved = initial === "system" ? getSystemTheme() : initial;
		setResolvedTheme(resolved);
		applyTheme(resolved);
		setIsMounted(true);
	}, []);

	useEffect(() => {
		if (!isMounted) return;

		const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
		function handleChange() {
			if (theme === "system") {
				const resolved = getSystemTheme();
				setResolvedTheme(resolved);
				applyTheme(resolved);
			}
		}
		mediaQuery.addEventListener("change", handleChange);
		return () => mediaQuery.removeEventListener("change", handleChange);
	}, [theme, isMounted]);

	const setTheme = useCallback((newTheme: Theme) => {
		setThemeState(newTheme);
		localStorage.setItem("theme", newTheme);

		const resolved = newTheme === "system" ? getSystemTheme() : newTheme;
		setResolvedTheme(resolved);
		applyTheme(resolved);
	}, []);

	return (
		<ThemeContext.Provider value={{ theme, resolvedTheme, setTheme }}>
			{children}
		</ThemeContext.Provider>
	);
}
