import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, FileText, Globe, Sparkles, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { EmailBuilder } from "@/components/email-builder";
import { EmailContent } from "@/components/email-content";
import { LiveFrame } from "@/components/live-frame";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { aiTranslateHelpArticleFn } from "@/functions/ai";
import { articlePageFn, deleteArticleFn, saveArticleFn } from "@/functions/help-center";
import { emailLookFn } from "@/functions/media";
import { kitTheme } from "@/lib/brand-kit";
import { type EmailDoc, renderEmail } from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";

export const Route = createFileRoute("/_app/articles/$id")({
	loader: async ({ params }) => {
		const [page, look] = await Promise.all([
			articlePageFn({ data: { id: params.id } }),
			emailLookFn(),
		]);
		return { ...page, look };
	},
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.article.title ?? "Article"} · Mailroom` }],
	}),
	component: ArticlePage,
});

type Article = Awaited<ReturnType<typeof articlePageFn>>["article"];

type Form = {
	title: string;
	description: string;
	category: string;
	slug: string;
	design: EmailDoc | null;
	html: string;
	text: string;
};

const formOf = (a: Article): Form => ({
	title: a.title,
	description: a.description ?? "",
	category: a.category ?? "",
	slug: a.slug,
	design: (a.design as EmailDoc | null) ?? null,
	html: a.html ?? "",
	text: "",
});

const toFields = (f: Form) => ({
	title: f.title,
	description: f.description || null,
	category: f.category || null,
	slug: f.slug,
	...(f.design ? { design: f.design } : { html: f.html }),
});

function ArticlePage() {
	const data = Route.useLoaderData();
	const saved = data.article;
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "help:edit");
	const [form, setForm] = useState<Form>(() => formOf(saved));
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved article changes
	useEffect(() => setForm(formOf(saved)), [saved.updated_at, saved.id]);
	const dirty = JSON.stringify(toFields(form)) !== JSON.stringify(toFields(formOf(saved)));
	const [busy, setBusy] = useState<"save" | "publish" | "unpublish" | null>(null);
	const [building, setBuilding] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
	const html = form.design
		? renderEmail({
				...form.design,
				blocks: form.design.blocks.filter((b) => b.type !== "footer"),
			})
		: form.html;

	const save = async (status?: "published" | "draft") => {
		setBusy(status === "published" ? "publish" : status === "draft" ? "unpublish" : "save");
		try {
			await saveArticleFn({
				data: {
					id: saved.id,
					fields: { ...toFields(form), ...(status ? { status } : {}) },
				},
			});
			await router.invalidate();
			toast.success(
				status === "published"
					? "Published"
					: status === "draft"
						? "Back to a draft"
						: "Saved",
			);
			return true;
		} catch (error) {
			toast.error(await errorMessage(error));
			return false;
		} finally {
			setBusy(null);
		}
	};

	return (
		<Page className="gap-8">
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this article?"
				description="It leaves the help center at once, and links to it stop working."
				action="Delete article"
				onConfirm={async () => {
					try {
						await deleteArticleFn({ data: { id: saved.id } });
						toast.success("Article deleted");
						await router.navigate({ to: "/articles" });
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			{building && form.design && (
				<EmailBuilder
					doc={form.design}
					onChange={(d) => set("design", d)}
					brand={data.look}
					kit={data.look.kit}
					title={form.title || "Article"}
					variables={[]}
					surveys={false}
					onClose={() => setBuilding(false)}
					actions={
						<>
							<span className="hidden text-xs text-muted-foreground md:inline">
								{dirty ? "Unsaved changes" : "Saved"}
							</span>
							<Button
								onClick={async () => {
									if (dirty && !(await save())) return;
									setBuilding(false);
								}}
							>
								Done
							</Button>
						</>
					}
				/>
			)}
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/articles"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Help center
					</Link>
				</nav>
				<RecordHeader
					icon={FileText}
					tone={saved.status === "published" ? "blue" : "gray"}
					kind="Help article"
					title={saved.title}
					actions={
						<>
							{saved.url && (
								<Button
									variant="outline"
									asChild
								>
									<a
										href={saved.url}
										target="_blank"
										rel="noreferrer"
									>
										<ExternalLink />
										Open
									</a>
								</Button>
							)}
							{canEdit && (
								<>
									<Button
										variant="outline"
										disabled={!dirty || !!busy}
										onClick={() => save()}
									>
										{busy === "save" && <Spinner />}
										Save
									</Button>
									{saved.status === "published" ? (
										<Button
											variant="outline"
											disabled={!!busy}
											onClick={() => save("draft")}
										>
											{busy === "unpublish" && <Spinner />}
											Unpublish
										</Button>
									) : (
										<Button
											disabled={!!busy || !form.title.trim()}
											onClick={() => save("published")}
										>
											{busy === "publish" ? <Spinner /> : <Upload />}
											Publish
										</Button>
									)}
									<Button
										variant="ghost"
										size="icon"
										aria-label="Delete article"
										onClick={() => setDeleting(true)}
									>
										<Trash2 />
									</Button>
								</>
							)}
						</>
					}
				/>
			</div>
			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">{saved.status === "published" ? "Published" : "Draft"}</Fact>
				<Fact label="Views">{saved.views.toLocaleString()}</Fact>
				<Fact label="Helpful">
					{saved.helpful + saved.unhelpful
						? `${saved.helpful} yes · ${saved.unhelpful} no`
						: "No votes yet"}
				</Fact>
				<Fact label="Edited">{formatRelative(saved.updated_at)}</Fact>
				<Fact label="Id">
					<IdChip value={saved.id} />
				</Fact>
			</Facts>
			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-6">
					<Card className="gap-5 p-5">
						<Field>
							<FieldLabel htmlFor="a-title">Title</FieldLabel>
							<Input
								id="a-title"
								maxLength={160}
								value={form.title}
								onChange={(e) => set("title", e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="a-desc">Summary</FieldLabel>
							<Textarea
								id="a-desc"
								rows={2}
								maxLength={300}
								placeholder="One line people see in lists, search and the chat."
								value={form.description}
								onChange={(e) => set("description", e.target.value)}
							/>
						</Field>
						<div className="grid gap-5 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="a-cat">Category</FieldLabel>
								<Input
									id="a-cat"
									list="a-cats"
									maxLength={60}
									placeholder="Bookings"
									value={form.category}
									onChange={(e) => set("category", e.target.value)}
								/>
								<datalist id="a-cats">
									{data.categories.map((c) => (
										<option
											key={c}
											value={c}
										/>
									))}
								</datalist>
							</Field>
							<Field>
								<FieldLabel htmlFor="a-slug">Address</FieldLabel>
								<Input
									id="a-slug"
									className="font-mono"
									spellCheck={false}
									value={form.slug}
									onChange={(e) => set("slug", e.target.value.toLowerCase())}
								/>
								<FieldDescription>
									{data.center
										? `/help/${data.center.slug}/${form.slug}`
										: form.slug}
								</FieldDescription>
							</Field>
						</div>
					</Card>
					<EmailContent
						design={form.design}
						html={form.html}
						text={form.text}
						set={(k, v) => set(k, v as never)}
						look={data.look}
						kit={data.look.kit ? kitTheme(data.look.kit) : null}
						kind="newsletter"
						onBuild={() => setBuilding(true)}
						footer="Written in the email editor; the page shows it without the email's footer."
					/>
					<ArticleTranslationsCard
						article={saved}
						currentHtml={html}
						canEdit={canEdit}
						onUpdated={() => router.invalidate()}
					/>
				</div>
				<Card className="min-w-0 gap-0 overflow-hidden p-0 lg:sticky lg:top-4">
					<div className="flex h-12 items-center border-b border-border/70 px-5 text-sm text-muted-foreground">
						How it reads on the help center
					</div>
					<LiveFrame
						title="Preview"
						html={
							html ||
							"<p style='font:14px system-ui;color:#888;padding:24px'>Nothing written yet.</p>"
						}
						className="block h-[560px] w-full bg-white sm:h-[720px]"
					/>
				</Card>
			</div>
		</Page>
	);
}

const COMMON_LOCALES = [
	{ code: "en", label: "English (en)" },
	{ code: "es", label: "Español (es)" },
	{ code: "fr", label: "Français (fr)" },
	{ code: "de", label: "Deutsch (de)" },
	{ code: "pt", label: "Português (pt)" },
	{ code: "it", label: "Italiano (it)" },
	{ code: "ja", label: "日本語 (ja)" },
	{ code: "zh", label: "中文 (zh)" },
];

function ArticleTranslationsCard({
	article,
	currentHtml,
	canEdit,
	onUpdated,
}: {
	article: Article;
	currentHtml: string;
	canEdit: boolean;
	onUpdated: () => Promise<void>;
}) {
	const existing = (article.translations ?? {}) as Record<
		string,
		{ title: string; description?: string | null; category?: string | null; html: string }
	>;
	const primary = article.locale || "en";
	const [targetLang, setTargetLang] = useState(() => (primary === "en" ? "es" : "en"));
	const [editingLang, setEditingLang] = useState<string | null>(null);
	const [trTitle, setTrTitle] = useState("");
	const [trDesc, setTrDesc] = useState("");
	const [trHtml, setTrHtml] = useState("");
	const [busy, setBusy] = useState<"ai" | "save" | "del" | null>(null);

	const openEditor = (loc: string) => {
		const cur = existing[loc];
		setEditingLang(loc);
		setTrTitle(cur?.title ?? article.title);
		setTrDesc(cur?.description ?? article.description ?? "");
		setTrHtml(cur?.html ?? currentHtml);
	};

	const translateWithAi = async () => {
		if (!targetLang || targetLang === primary) return;
		setBusy("ai");
		try {
			const res = await aiTranslateHelpArticleFn({
				data: {
					title: article.title,
					description: article.description,
					category: article.category,
					html: currentHtml || `<p>${article.title}</p>`,
					locale: targetLang,
				},
			});
			await saveArticleFn({
				data: {
					id: article.id,
					fields: {
						translations: {
							[targetLang]: {
								title: res.title,
								description: res.description,
								category: res.category,
								html: res.html,
							},
						},
					},
				},
			});
			toast.success(`Translated to ${targetLang.toUpperCase()}`);
			await onUpdated();
			setEditingLang(targetLang);
			setTrTitle(res.title);
			setTrDesc(res.description ?? "");
			setTrHtml(res.html);
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const saveTranslation = async () => {
		if (!editingLang || !trTitle.trim()) return;
		setBusy("save");
		try {
			await saveArticleFn({
				data: {
					id: article.id,
					fields: {
						translations: {
							[editingLang]: {
								title: trTitle.trim(),
								description: trDesc.trim() || null,
								html: trHtml,
							},
						},
					},
				},
			});
			toast.success(`Saved ${editingLang.toUpperCase()} translation`);
			await onUpdated();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const deleteTranslation = async (loc: string) => {
		setBusy("del");
		try {
			await saveArticleFn({
				data: { id: article.id, fields: { translations: { [loc]: null } } },
			});
			toast.success(`Removed ${loc.toUpperCase()} translation`);
			if (editingLang === loc) setEditingLang(null);
			await onUpdated();
		} catch (error) {
			toast.error(await errorMessage(error));
		} finally {
			setBusy(null);
		}
	};

	const translatedCodes = Object.keys(existing);

	return (
		<Card className="gap-4 p-5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<Globe className="size-4 text-muted-foreground" />
					<h3 className="text-sm font-medium">Languages &amp; translations</h3>
				</div>
				<span className="text-xs text-muted-foreground">
					Primary: <strong className="uppercase">{primary}</strong>
				</span>
			</div>
			<p className="text-xs text-muted-foreground">
				Published translations show a language switcher on the public Help Center (
				<code>?lang=es</code>) and match visitors' language in the website chat widget.
			</p>
			{translatedCodes.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{translatedCodes.map((loc) => (
						<div
							key={loc}
							className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-xs"
						>
							<button
								type="button"
								onClick={() => openEditor(loc)}
								className="font-medium uppercase hover:underline"
							>
								{loc}
							</button>
							<span className="max-w-36 truncate text-muted-foreground">
								{existing[loc]?.title}
							</span>
							{article.url && (
								<a
									href={`${article.url}?lang=${loc}`}
									target="_blank"
									rel="noreferrer"
									aria-label={`Open ${loc} version`}
									className="text-muted-foreground hover:text-foreground"
								>
									<ExternalLink className="size-3" />
								</a>
							)}
						</div>
					))}
				</div>
			)}
			{canEdit && (
				<div className="flex flex-wrap items-center gap-2">
					<select
						aria-label="Language to add"
						value={targetLang}
						onChange={(e) => setTargetLang(e.target.value)}
						className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					>
						{COMMON_LOCALES.filter((l) => l.code !== primary).map((l) => (
							<option
								key={l.code}
								value={l.code}
							>
								{l.label}
							</option>
						))}
					</select>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy !== null}
						onClick={() => openEditor(targetLang)}
					>
						Add manually
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={busy !== null}
						onClick={() => void translateWithAi()}
					>
						{busy === "ai" ? (
							<Spinner className="size-3.5" />
						) : (
							<Sparkles className="size-3.5 text-brand" />
						)}
						Translate with AI
					</Button>
				</div>
			)}
			{editingLang && (
				<div className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3.5">
					<div className="flex items-center justify-between">
						<span className="text-xs font-semibold uppercase">
							Editing {editingLang} translation
						</span>
						<div className="flex items-center gap-1.5">
							{existing[editingLang] && (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="h-7 text-xs text-destructive"
									disabled={busy !== null}
									onClick={() => void deleteTranslation(editingLang)}
								>
									Remove
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								variant="ghost"
								className="h-7 text-xs"
								onClick={() => setEditingLang(null)}
							>
								Close
							</Button>
						</div>
					</div>
					<Field>
						<FieldLabel htmlFor="tr-title">Translated title</FieldLabel>
						<Input
							id="tr-title"
							value={trTitle}
							onChange={(e) => setTrTitle(e.target.value)}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="tr-desc">Translated summary</FieldLabel>
						<Input
							id="tr-desc"
							value={trDesc}
							onChange={(e) => setTrDesc(e.target.value)}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="tr-html">Translated HTML</FieldLabel>
						<Textarea
							id="tr-html"
							rows={6}
							className="font-mono text-xs"
							value={trHtml}
							onChange={(e) => setTrHtml(e.target.value)}
						/>
					</Field>
					<Button
						type="button"
						size="sm"
						disabled={busy !== null || !trTitle.trim()}
						onClick={() => void saveTranslation()}
					>
						{busy === "save" && <Spinner />}
						Save {editingLang.toUpperCase()} translation
					</Button>
				</div>
			)}
		</Card>
	);
}
