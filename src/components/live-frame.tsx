import type { ComponentProps } from "react";
import { useLiveFrame } from "@/lib/live-frame";

/**
 * An iframe showing `html` that changes in place when `html` changes (see useLiveFrame), so a
 * preview never flashes white while someone edits. No scripts run in it.
 */
export function LiveFrame({
	html,
	...props
}: { html: string } & Omit<ComponentProps<"iframe">, "srcDoc" | "sandbox" | "ref" | "onLoad">) {
	const frame = useLiveFrame(html);
	return (
		<iframe
			{...props}
			ref={frame.ref}
			sandbox={frame.sandbox}
			srcDoc={frame.srcDoc}
			onLoad={frame.onLoad}
		/>
	);
}
