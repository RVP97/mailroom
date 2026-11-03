import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/components/theme-provider";
import { Spinner } from "@/components/ui/spinner";

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();
	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			gap={8}
			icons={{
				success: <CircleCheck className="size-4 text-success" />,
				info: <Info className="size-4 text-brand" />,
				warning: <TriangleAlert className="size-4 text-warning" />,
				error: <CircleAlert className="size-4 text-destructive" />,
				loading: <Spinner className="size-4 text-muted-foreground" />,
			}}
			toastOptions={{
				classNames: {
					toast: "!rounded-lg !border-0 !shadow-popover !py-3 !px-3.5 !gap-2.5 !text-sm !font-sans",
					title: "!font-medium",
					description: "!text-muted-foreground",
				},
			}}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "transparent",
					"--border-radius": "var(--radius-lg)",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
