import { Image as ImageIcon, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

const hasRemoteImages = (html: string) => /<img[^>]+src\s*=\s*["']?https?:/i.test(html);

const csp = (images: boolean) =>
	`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: cid:${images ? " https: http:" : ""}; font-src data:">`;

const BASE = `<base target="_blank" rel="noopener noreferrer"><style>html,body{margin:0;padding:0;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#18181b;background:#ffffff;word-break:break-word}img{max-width:100%;height:auto}table{max-width:100%!important}a{color:#2563eb}pre,code{white-space:pre-wrap;font-size:13px}blockquote{margin:8px 0;padding-left:12px;border-left:2px solid #e4e4e7;color:#52525b}</style>`;

/**
 * Sandboxed inline HTML email renderer for conversation threads.
 * Scripts and forms are blocked via `sandbox=""` + strict CSP; remote images stay off until clicked.
 */
export function EmailHtmlFrame({
	html,
	title = "Email message",
	compact = false,
}: {
	html: string;
	title?: string;
	compact?: boolean;
}) {
	const [showImages, setShowImages] = useState(false);
	const [height, setHeight] = useState(compact ? 220 : 320);
	const remote = useMemo(() => hasRemoteImages(html), [html]);
	const srcDoc = useMemo(() => `${csp(showImages)}${BASE}${html}`, [html, showImages]);

	return (
		<div className="flex flex-col gap-2">
			{remote && !showImages && (
				<div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<ShieldAlert className="size-3.5 shrink-0" />
						Remote images hidden to protect your privacy
					</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						className="h-6 px-2 text-xs"
						onClick={() => setShowImages(true)}
					>
						<ImageIcon className="size-3" />
						Load images
					</Button>
				</div>
			)}
			<div className="overflow-hidden rounded-lg border border-border/70 bg-white">
				<iframe
					title={title}
					sandbox=""
					srcDoc={srcDoc}
					style={{ height: `${height}px` }}
					className="block w-full border-0 bg-white"
				/>
				<div className="flex items-center justify-end gap-1 border-t border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-500">
					<button
						type="button"
						className="rounded px-1.5 py-0.5 hover:bg-zinc-200/70 hover:text-zinc-900"
						onClick={() => setHeight((h) => (h >= 640 ? 280 : h + 220))}
					>
						{height >= 640 ? "Compact view" : "Expand message"}
					</button>
				</div>
			</div>
		</div>
	);
}
