import { Check, Copy, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Method } from "@/components/api-drawer";
import { CodeTabs } from "@/components/code-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

interface Preset {
	id: string;
	label: string;
	method: HttpMethod;
	path: string;
	body?: string;
}

const PRESETS: Preset[] = [
	{ id: "status", label: "Check sending status", method: "GET", path: "/status" },
	{ id: "domains", label: "List domains", method: "GET", path: "/domains" },
	{ id: "templates", label: "List templates", method: "GET", path: "/templates" },
	{ id: "emails", label: "List recent emails", method: "GET", path: "/emails?limit=10" },
	{ id: "contacts", label: "List contacts", method: "GET", path: "/contacts?limit=10" },
	{ id: "stats", label: "30-day sending stats", method: "GET", path: "/stats?days=30" },
	{
		id: "check",
		label: "Check email deliverability",
		method: "POST",
		path: "/emails/check",
		body: JSON.stringify(
			{
				subject: "Welcome to our app",
				html: "<p>Hi there — thanks for signing up!</p>",
				marketing: false,
			},
			null,
			2,
		),
	},
	{
		id: "send",
		label: "Send an email",
		method: "POST",
		path: "/emails",
		body: JSON.stringify(
			{
				from: "hello@your-domain.com",
				to: ["recipient@example.com"],
				subject: "Hello from Mailroom Playground",
				html: "<p>Sent live from the interactive API playground.</p>",
			},
			null,
			2,
		),
	},
];

const STORAGE_KEY = "mailroom:playground-key";

export function ApiPlayground({ origin }: { origin: string }) {
	const [apiKey, setApiKey] = useState(() => {
		if (typeof window === "undefined") return "";
		try {
			return sessionStorage.getItem(STORAGE_KEY) ?? "";
		} catch {
			return "";
		}
	});
	const [presetId, setPresetId] = useState<string>("status");
	const [method, setMethod] = useState<HttpMethod>("GET");
	const [path, setPath] = useState("/status");
	const [body, setBody] = useState("");
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	const [result, setResult] = useState<{
		status: number;
		ok: boolean;
		ms: number;
		text: string;
	} | null>(null);

	const applyPreset = (id: string) => {
		const p = PRESETS.find((x) => x.id === id);
		if (!p) return;
		setPresetId(id);
		setMethod(p.method);
		setPath(p.path);
		setBody(p.body ?? "");
		setResult(null);
	};

	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	const fullUrl = `${origin}/api${normalizedPath}`;
	const hasBody = method === "POST" || method === "PATCH";
	const displayKey = apiKey.trim() || "mr_your_api_key";

	const snippets = useMemo(() => {
		const compactBody = hasBody && body.trim() ? body.trim() : null;
		const curl = [
			`curl -X ${method} "${fullUrl}" \\`,
			`  -H "Authorization: Bearer ${displayKey}"${compactBody ? " \\" : ""}`,
			...(compactBody
				? [
						'  -H "Content-Type: application/json" \\',
						`  -d '${compactBody.replace(/'/g, "'\\''")}'`,
					]
				: []),
		].join("\n");

		const ts = [
			`const res = await fetch("${fullUrl}", {`,
			`  method: "${method}",`,
			"  headers: {",
			`    Authorization: "Bearer ${displayKey}",`,
			...(compactBody ? ['    "Content-Type": "application/json",'] : []),
			"  },",
			...(compactBody ? [`  body: JSON.stringify(${compactBody}),`] : []),
			"});",
			"const data = await res.json();",
			"console.log(res.status, data);",
		].join("\n");

		const py = [
			"import requests",
			"",
			`res = requests.${method.toLowerCase()}(`,
			`    "${fullUrl}",`,
			`    headers={"Authorization": "Bearer ${displayKey}"},`,
			...(compactBody
				? [
						`    json=${compactBody
							.replace(/\btrue\b/g, "True")
							.replace(/\bfalse\b/g, "False")
							.replace(/\bnull\b/g, "None")},`,
					]
				: []),
			")",
			"print(res.status_code, res.json())",
		].join("\n");

		return [
			{ label: "cURL", lang: "bash" as const, code: curl },
			{ label: "TypeScript", lang: "js" as const, code: ts },
			{ label: "Python", lang: "python" as const, code: py },
		];
	}, [method, fullUrl, displayKey, hasBody, body]);

	const run = async () => {
		if (!apiKey.trim()) {
			toast.error("Paste a Mailroom API key first (from API keys)");
			return;
		}
		if (hasBody && body.trim()) {
			try {
				JSON.parse(body);
			} catch {
				toast.error("Request body must be valid JSON");
				return;
			}
		}
		setBusy(true);
		const t0 = performance.now();
		try {
			const res = await fetch(fullUrl, {
				method,
				headers: {
					Authorization: `Bearer ${apiKey.trim()}`,
					...(hasBody && body.trim() ? { "Content-Type": "application/json" } : {}),
				},
				...(hasBody && body.trim() ? { body } : {}),
			});
			const ms = Math.round(performance.now() - t0);
			const raw = await res.text();
			let pretty = raw;
			try {
				pretty = JSON.stringify(JSON.parse(raw), null, 2);
			} catch {
				// Leave plain text as-is
			}
			setResult({ status: res.status, ok: res.ok, ms, text: pretty || "(empty response)" });
		} catch (error) {
			setResult({
				status: 0,
				ok: false,
				ms: Math.round(performance.now() - t0),
				text: error instanceof Error ? error.message : "Network error",
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
			<Card className="gap-5 p-5">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<h2 className="text-base font-semibold">Interactive API Playground</h2>
						<p className="text-xs text-muted-foreground">
							Run live requests against{" "}
							<code className="font-mono">{origin}/api</code> using one of your API
							keys. Keys stay only in this browser tab.
						</p>
					</div>
				</div>

				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="pg-preset">Preset</FieldLabel>
						<Select
							value={presetId}
							onValueChange={applyPreset}
						>
							<SelectTrigger id="pg-preset">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PRESETS.map((p) => (
									<SelectItem
										key={p.id}
										value={p.id}
									>
										{p.method} {p.path} — {p.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>

					<Field>
						<FieldLabel htmlFor="pg-key">API key</FieldLabel>
						<Input
							id="pg-key"
							type="password"
							autoComplete="off"
							placeholder="mr_…"
							value={apiKey}
							onChange={(e) => {
								setApiKey(e.target.value);
								try {
									sessionStorage.setItem(STORAGE_KEY, e.target.value);
								} catch {}
							}}
						/>
						<FieldDescription>Stored in sessionStorage only.</FieldDescription>
					</Field>
				</div>

				<div className="flex flex-wrap items-end gap-2">
					<div className="w-28">
						<Field>
							<FieldLabel htmlFor="pg-method">Method</FieldLabel>
							<Select
								value={method}
								onValueChange={(v) => setMethod(v as HttpMethod)}
							>
								<SelectTrigger id="pg-method">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(["GET", "POST", "PATCH", "DELETE"] as HttpMethod[]).map(
										(m) => (
											<SelectItem
												key={m}
												value={m}
											>
												{m}
											</SelectItem>
										),
									)}
								</SelectContent>
							</Select>
						</Field>
					</div>
					<div className="min-w-0 flex-1">
						<Field>
							<FieldLabel htmlFor="pg-path">Path</FieldLabel>
							<Input
								id="pg-path"
								className="font-mono text-xs"
								value={path}
								onChange={(e) => setPath(e.target.value)}
							/>
						</Field>
					</div>
					<Button
						type="button"
						disabled={busy}
						onClick={() => void run()}
					>
						{busy ? <Spinner /> : <Play className="size-3.5" />}
						Send request
					</Button>
				</div>

				{hasBody && (
					<Field>
						<FieldLabel htmlFor="pg-body">JSON body</FieldLabel>
						<Textarea
							id="pg-body"
							rows={8}
							className="font-mono text-xs"
							value={body}
							onChange={(e) => setBody(e.target.value)}
						/>
					</Field>
				)}

				{result && (
					<div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
						<div className="flex items-center justify-between gap-2">
							<div className="flex items-center gap-2">
								<Method m={method} />
								<Badge variant={result.ok ? "default" : "destructive"}>
									{result.status || "ERR"}
								</Badge>
								<span className="text-xs text-muted-foreground tabular-nums">
									{result.ms} ms
								</span>
							</div>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 px-2 text-xs"
								onClick={async () => {
									await navigator.clipboard
										?.writeText(result.text)
										.catch(() => {});
									setCopied(true);
									setTimeout(() => setCopied(false), 1400);
								}}
							>
								{copied ? (
									<Check className="size-3" />
								) : (
									<Copy className="size-3" />
								)}
								Copy JSON
							</Button>
						</div>
						<pre className="max-h-80 overflow-auto rounded bg-background p-3 font-mono text-xs leading-relaxed">
							{result.text}
						</pre>
					</div>
				)}
			</Card>

			<div className="min-w-0 space-y-3">
				<h3 className="text-sm font-semibold">Live code snippet</h3>
				<p className="text-xs text-muted-foreground">
					Updates automatically as you edit the method, path, or JSON payload.
				</p>
				<CodeTabs tabs={snippets} />
			</div>
		</div>
	);
}
