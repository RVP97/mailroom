import { Link } from "@tanstack/react-router";
import { ArrowUpRight, CodeXml } from "lucide-react";
import { useEffect, useState } from "react";
import { type CodeTab, CodeTabs } from "@/components/code-block";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The «</>» button on a page: what that page does, as API calls ready to paste, in the reader's
 * language (remembered across pages).
 */

export type Call = {
	title: string;
	method: "GET" | "POST" | "PATCH" | "DELETE";
	path: string;
	body?: unknown;
};

const METHOD: Record<string, string> = {
	GET: "bg-brand/10 text-brand",
	POST: "bg-success/10 text-success",
	PATCH: "bg-warning/12 text-[color-mix(in_oklch,var(--warning),var(--foreground)_30%)]",
	DELETE: "bg-destructive/10 text-destructive",
};

export function Method({ m, className }: { m: string; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex h-5 w-14 shrink-0 items-center justify-center rounded font-mono text-2xs font-semibold",
				METHOD[m],
				className,
			)}
		>
			{m}
		</span>
	);
}

const indent = (s: string, by: string) => s.replace(/\n/g, `\n${by}`);

/** JSON as a Python literal. */
function py(v: unknown, pad = ""): string {
	if (v === null || v === undefined) return "None";
	if (v === true) return "True";
	if (v === false) return "False";
	if (Array.isArray(v)) {
		if (v.every((x) => typeof x !== "object" || x === null))
			return `[${v.map((x) => py(x)).join(", ")}]`;
		return `[\n${v.map((x) => `${pad}    ${py(x, `${pad}    `)}`).join(",\n")},\n${pad}]`;
	}
	if (typeof v === "object")
		return `{\n${Object.entries(v as Record<string, unknown>)
			.map(([k, x]) => `${pad}    ${JSON.stringify(k)}: ${py(x, `${pad}    `)}`)
			.join(",\n")},\n${pad}}`;
	return JSON.stringify(v);
}

/** JSON indented, with short lists of plain values kept on one line: "to": ["a@b.com"]. */
export const pretty = (v: unknown) =>
	JSON.stringify(v, null, 2).replace(
		/\[\n\s*((?:"[^"\n]*"|[\d.]+|true|false|null)(?:,\n\s*(?:"[^"\n]*"|[\d.]+|true|false|null))*)\n\s*\]/g,
		(_, items: string) => `[${items.replace(/,\n\s*/g, ", ")}]`,
	);

export function snippets(base: string, c: Call) {
	const url = `${base}${c.path}`;
	const json = c.body === undefined ? null : pretty(c.body);
	const curl = [
		`curl -X ${c.method} "${url}"`,
		`  -H "Authorization: Bearer $MAILROOM_API_KEY"`,
		...(json ? [`  -H "Content-Type: application/json"`, `  -d '${json}'`] : []),
	].join(" \\\n");
	const node = `const res = await fetch("${url}", {
  method: "${c.method}",
  headers: {
    Authorization: \`Bearer \${process.env.MAILROOM_API_KEY}\`,${json ? `\n    "Content-Type": "application/json",` : ""}
  },${json ? `\n  body: JSON.stringify(${indent(json, "  ")}),` : ""}
});
const data = await res.json();`;
	const python = `import os, requests

r = requests.${c.method.toLowerCase()}(
    "${url}",
    headers={"Authorization": f"Bearer {os.environ['MAILROOM_API_KEY']}"},${c.body === undefined ? "" : `\n    json=${py(c.body, "    ")},`}
)
print(r.json())`;
	return [
		{ label: "cURL", code: curl, lang: "bash" },
		{ label: "Node.js", code: node, lang: "js" },
		{ label: "Python", code: python, lang: "python" },
	] satisfies CodeTab[];
}

export function ApiDrawer({
	title,
	description,
	calls,
}: {
	title: string;
	description?: string;
	calls: Call[];
}) {
	const [base, setBase] = useState("https://mailroom.example.com/api");
	useEffect(() => setBase(`${window.location.origin}/api`), []);
	return (
		<Sheet>
			<Tooltip>
				<TooltipTrigger asChild>
					<SheetTrigger asChild>
						<Button
							variant="outline"
							size="icon"
							aria-label="API"
						>
							<CodeXml />
						</Button>
					</SheetTrigger>
				</TooltipTrigger>
				<TooltipContent>Do this with the API</TooltipContent>
			</Tooltip>
			<SheetContent className="sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>{title}</SheetTitle>
					<SheetDescription>
						{description ??
							"Authenticate with an API key. Resend's SDKs work too, pointed at Mailroom."}
					</SheetDescription>
				</SheetHeader>
				<div className="flex min-h-0 min-w-0 flex-1 flex-col gap-7 overflow-y-auto px-5 py-5">
					{calls.map((c) => (
						<section
							key={`${c.method}${c.path}${c.title}`}
							className="flex min-w-0 flex-col gap-2.5"
						>
							<div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
								<h3 className="text-sm font-medium whitespace-nowrap">{c.title}</h3>
								<span className="flex min-w-0 items-center gap-1.5 sm:ml-auto">
									<Method m={c.method} />
									<code className="truncate font-mono text-xs text-muted-foreground">
										{c.path}
									</code>
								</span>
							</div>
							<CodeTabs tabs={snippets(base, c)} />
						</section>
					))}
					<Link
						to="/docs"
						className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
					>
						Every endpoint, SMTP and webhooks
						<ArrowUpRight className="size-3.5" />
					</Link>
				</div>
			</SheetContent>
		</Sheet>
	);
}
