import { Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { clearAiSettingsFn, getAiSettingsFn, saveAiSettingsFn } from "@/functions/ai";
import { errorMessage } from "@/lib/errors";
import { useSketching } from "@/lib/sketch";

type AiConfig = Awaited<ReturnType<typeof getAiSettingsFn>>;

const MODEL_HINTS: Record<AiConfig["provider"], string> = {
	anthropic: "claude-sonnet-4-5",
	openai: "gpt-4o-mini",
	compatible: "meta-llama/llama-3.3-70b-instruct",
};

/**
 * Optional BYO-key AI Copilot & Auto-Responder configuration (Settings → General).
 */
export function AiSettingsCard({ canEdit }: { canEdit: boolean }) {
	const sketching = useSketching();
	const [config, setConfig] = useState<AiConfig | null>(null);
	const [provider, setProvider] = useState<AiConfig["provider"]>("anthropic");
	const [model, setModel] = useState("claude-sonnet-4-5");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [copilot, setCopilot] = useState(true);
	const [autoMode, setAutoMode] = useState<AiConfig["auto_mode"]>("off");
	const [systemPrompt, setSystemPrompt] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (sketching) return;
		getAiSettingsFn()
			.then((c) => {
				setConfig(c);
				setProvider(c.provider);
				setModel(c.model);
				setBaseUrl(c.base_url ?? "");
				setCopilot(c.copilot_enabled);
				setAutoMode(c.auto_mode);
				setSystemPrompt(c.system_prompt ?? "");
			})
			.catch(() => {});
	}, [sketching]);

	const save = async () => {
		setBusy(true);
		try {
			const next = await saveAiSettingsFn({
				data: {
					provider,
					model: model.trim() || MODEL_HINTS[provider],
					base_url: baseUrl.trim() || null,
					...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
					copilot_enabled: copilot,
					auto_mode: autoMode,
					system_prompt: systemPrompt.trim() || null,
				},
			});
			setConfig(next);
			setApiKey("");
			toast.success("AI assistant settings saved");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	const removeKey = async () => {
		setBusy(true);
		try {
			const next = await clearAiSettingsFn();
			setConfig(next);
			setApiKey("");
			setAutoMode("off");
			toast.success("AI key removed");
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Sparkles className="size-4 text-brand" />
					AI Copilot &amp; Auto-Responder
				</CardTitle>
				<CardDescription>
					Bring your own Anthropic, OpenAI, or OpenAI-compatible API key (encrypted with
					BETTER_AUTH_SECRET). Powers one-click reply drafts, thread summaries, and
					optional Help Center auto-responses in the Inbox.
				</CardDescription>
				<CardAction>
					{config?.configured ? (
						<Badge variant="brand">Connected ({config.api_key_hint})</Badge>
					) : (
						<Badge variant="outline">Optional</Badge>
					)}
				</CardAction>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-2">
					<Field>
						<FieldLabel htmlFor="ai-provider">Provider</FieldLabel>
						<Select
							value={provider}
							disabled={!canEdit}
							onValueChange={(v) => {
								const next = v as AiConfig["provider"];
								setProvider(next);
								if (!model || Object.values(MODEL_HINTS).includes(model))
									setModel(MODEL_HINTS[next]);
							}}
						>
							<SelectTrigger id="ai-provider">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="anthropic">Anthropic (Claude)</SelectItem>
								<SelectItem value="openai">OpenAI</SelectItem>
								<SelectItem value="compatible">
									OpenAI-compatible (OpenRouter, Ollama, Workers AI…)
								</SelectItem>
							</SelectContent>
						</Select>
					</Field>
					<Field>
						<FieldLabel htmlFor="ai-model">Model</FieldLabel>
						<Input
							id="ai-model"
							value={model}
							disabled={!canEdit}
							placeholder={MODEL_HINTS[provider]}
							onChange={(e) => setModel(e.target.value)}
						/>
					</Field>
				</div>

				{provider === "compatible" && (
					<Field>
						<FieldLabel htmlFor="ai-base">Base URL</FieldLabel>
						<Input
							id="ai-base"
							value={baseUrl}
							disabled={!canEdit}
							placeholder="https://openrouter.ai/api/v1"
							onChange={(e) => setBaseUrl(e.target.value)}
						/>
						<FieldDescription>Any OpenAI-compatible `/v1` endpoint.</FieldDescription>
					</Field>
				)}

				<Field>
					<FieldLabel htmlFor="ai-key">
						API key{config?.api_key_hint ? ` (saved: ${config.api_key_hint})` : ""}
					</FieldLabel>
					<Input
						id="ai-key"
						type="password"
						autoComplete="off"
						value={apiKey}
						disabled={!canEdit}
						placeholder={
							config?.configured
								? "Leave blank to keep the saved key"
								: provider === "anthropic"
									? "sk-ant-…"
									: "sk-…"
						}
						onChange={(e) => setApiKey(e.target.value)}
					/>
				</Field>

				<div className="flex items-center justify-between gap-4 rounded-lg border px-3.5 py-2.5">
					<div>
						<p className="text-sm font-medium">Inbox Copilot</p>
						<p className="text-xs text-muted-foreground">
							Show Draft reply, Summarize thread, and Tone polish buttons in the
							composer.
						</p>
					</div>
					<Switch
						checked={copilot}
						disabled={!canEdit}
						onCheckedChange={setCopilot}
					/>
				</div>

				<Field>
					<FieldLabel htmlFor="ai-auto">Automatic replies</FieldLabel>
					<Select
						value={autoMode}
						disabled={!canEdit}
						onValueChange={(v) => setAutoMode(v as AiConfig["auto_mode"])}
					>
						<SelectTrigger id="ai-auto">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="off">Off — human-triggered Copilot only</SelectItem>
							<SelectItem value="draft">
								Auto-draft — write a draft for a teammate to approve
							</SelectItem>
							<SelectItem value="reply">
								Auto-reply — answer from Help Center when confident, else draft
								&amp; hand off
							</SelectItem>
						</SelectContent>
					</Select>
					<FieldDescription>
						Suspicious or held messages are never sent to AI automatically.
					</FieldDescription>
				</Field>

				<Field>
					<FieldLabel htmlFor="ai-prompt">Brand instructions (optional)</FieldLabel>
					<Textarea
						id="ai-prompt"
						rows={3}
						value={systemPrompt}
						disabled={!canEdit}
						placeholder="Tone, refund guidelines, or sign-off style (e.g. concise, friendly, never promise refunds over $50 without a manager)."
						onChange={(e) => setSystemPrompt(e.target.value)}
					/>
				</Field>
			</CardContent>
			{canEdit && (
				<CardFooter className="justify-between gap-2">
					{config?.configured ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => void removeKey()}
						>
							<Trash2 />
							Remove key
						</Button>
					) : (
						<span />
					)}
					<Button
						type="button"
						disabled={busy || (!config?.configured && !apiKey.trim())}
						onClick={() => void save()}
					>
						{busy && <Spinner />}
						Save AI settings
					</Button>
				</CardFooter>
			)}
		</Card>
	);
}
