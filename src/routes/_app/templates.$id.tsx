import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
	Copy,
	History,
	LayoutTemplate,
	MessageSquare,
	Monitor,
	MoreHorizontal,
	Plus,
	Send,
	Smartphone,
	Trash2,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiDrawer } from "@/components/api-drawer";
import { CommentsSheet, HistorySheet, useComments } from "@/components/collab";
import { Confirm } from "@/components/confirm";
import { ContentChecks } from "@/components/content-checks";
import { useCopy } from "@/components/copy";
import { EmailBuilder } from "@/components/email-builder";
import { EmailContent } from "@/components/email-content";
import { Page } from "@/components/page";
import { Fact, Facts, IdChip, RecordHeader } from "@/components/record";
import { TemplateStatus } from "@/components/template-status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { TagField } from "@/components/variables";
import { emailLookFn } from "@/functions/media";
import {
	deleteTemplateFn,
	duplicateTemplateFn,
	getTemplateFn,
	saveTemplateFn,
	sendTemplateTestFn,
} from "@/functions/templates";
import { kitTheme } from "@/lib/brand-kit";
import { type EmailDoc, renderEmail } from "@/lib/email-doc";
import { errorMessage } from "@/lib/errors";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import { contactGroups, labelOf } from "@/lib/merge-tags";
import { allows } from "@/lib/permissions";
import { ago, listedRow, Ph, Sketch, usePage } from "@/lib/sketch";
import { fill, previewValues, usedKeys } from "@/lib/template-fill";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/templates/$id")({
	loader: async ({ params }) => {
		const [template, look] = await Promise.all([
			getTemplateFn({ data: { id: params.id } }),
			emailLookFn(),
		]);
		return { template, look };
	},
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.template.name ?? "Template"} · Mailroom` }],
	}),
	component: TemplatePage,
	pendingComponent: TemplateSketch,
});

type Template = Awaited<ReturnType<typeof getTemplateFn>>;

function TemplateSketch() {
	const { params } = usePage(Route);
	const row = listedRow<{ name: string; alias: string | null; subject: string | null }>(
		"templates",
		params.id,
	);
	return (
		<Sketch
			data={{
				template: {
					object: "template",
					id: params.id ?? "",
					name: row?.name ?? "Template",
					alias: row?.alias ?? null,
					status: "published",
					has_unpublished_changes: false,
					published_at: ago(60),
					from: "Mailroom <hello@example.com>",
					subject: row?.subject ?? "Welcome",
					reply_to: null,
					html: "<p>…</p>",
					text: null,
					design: null,
					variables: [],
					created_at: ago(60 * 24),
					updated_at: ago(60),
				} satisfies Template,
				look: { logo: null, logoBackground: null, name: "", kit: null },
			}}
		>
			<TemplatePage />
		</Sketch>
	);
}

type Variable = { key: string; type: "string" | "number"; fallback_value: string };

type Form = {
	name: string;
	alias: string;
	from: string;
	subject: string;
	reply_to: string;
	html: string;
	text: string;
	design: EmailDoc | null;
	variables: Variable[];
};

const formOf = (t: Template): Form => ({
	name: t.name,
	alias: t.alias ?? "",
	from: t.from ?? "",
	subject: t.subject ?? "",
	reply_to: t.reply_to?.join(", ") ?? "",
	html: t.html,
	text: t.text ?? "",
	design: (t.design as EmailDoc | null) ?? null,
	variables: t.variables.map((v) => ({
		key: v.key,
		type: v.type,
		fallback_value:
			v.fallback_value === undefined || v.fallback_value === null
				? ""
				: String(v.fallback_value),
	})),
});

const toFields = (f: Form) => ({
	name: f.name,
	alias: f.alias || null,
	from: f.from || null,
	subject: f.subject || null,
	reply_to: f.reply_to || null,
	html: f.design ? renderEmail(f.design) : f.html,
	text: f.text || null,
	design: f.design,
	variables: f.variables
		.filter((v) => v.key.trim())
		.map((v) => ({
			key: v.key.trim(),
			type: v.type,
			fallback_value:
				v.fallback_value === ""
					? null
					: v.type === "number"
						? Number(v.fallback_value)
						: v.fallback_value,
		})),
});

/** Names Mailroom fills itself: no need to declare them. */
const RESERVED = new Set(["FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL"]);
const OWN = new Set(["MAILROOM_UNSUBSCRIBE_URL", "RESEND_UNSUBSCRIBE_URL"]);

function TemplatePage() {
	const { data } = usePage(Route);
	const saved = data.template;
	const router = useRouter();
	const me = useMe();
	const canEdit = allows(me.active?.access, "templates:edit");
	const subject = { type: "template", id: saved.id } as const;
	const comments = useComments(subject);
	const [commenting, setCommenting] = useState(false);
	const [history, setHistory] = useState(false);
	const [form, setForm] = useState<Form>(() => formOf(saved));
	// A save (or another tab's) brings the saved values in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the saved template changes
	useEffect(() => setForm(formOf(saved)), [saved.updated_at, saved.id]);
	const dirty = JSON.stringify(toFields(form)) !== JSON.stringify(toFields(formOf(saved)));
	const [busy, setBusy] = useState<"save" | "publish" | null>(null);
	const [testing, setTesting] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [phone, setPhone] = useState(false);
	const [building, setBuilding] = useState(false);
	const html = form.design ? renderEmail(form.design) : form.html;
	const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

	const declared = new Set(form.variables.map((v) => v.key.trim()).filter(Boolean));
	const undeclared = usedKeys(form.subject, html, form.text).filter(
		(k) => !declared.has(k) && !RESERVED.has(k) && !OWN.has(k) && !k.startsWith("contact."),
	);
	const values = useMemo(
		() => ({
			FIRST_NAME: "Ana",
			LAST_NAME: "García",
			EMAIL: me.user.email,
			UNSUBSCRIBE_URL: "#unsubscribe",
			...previewValues(toFields(form).variables),
		}),
		[form, me.user.email],
	);
	const preview = fill(html, values);
	const groups = useMemo(
		() =>
			contactGroups([], {
				label: "This template's",
				items: form.variables
					.filter((v) => v.key.trim())
					.map((v) => ({ key: v.key.trim(), label: labelOf(v.key.trim()) })),
			}),
		[form.variables],
	);
	const previewSubject = fill(form.subject, values);

	const save = async (publish: boolean) => {
		setBusy(publish ? "publish" : "save");
		try {
			await saveTemplateFn({ data: { id: saved.id, fields: toFields(form), publish } });
			toast.success(publish ? "Published: sends use it from now on" : "Draft saved");
			await router.invalidate();
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
			<div className="flex flex-col gap-5">
				<nav
					aria-label="Breadcrumb"
					className="text-sm text-muted-foreground"
				>
					<Link
						to="/templates"
						className="rounded-sm transition-colors hover:text-foreground"
					>
						Templates
					</Link>
				</nav>
				<RecordHeader
					icon={LayoutTemplate}
					tone={saved.status === "draft" ? "gray" : "blue"}
					kind="Template"
					title={saved.name}
					actions={
						<>
							{canEdit && (
								<>
									<Button
										variant="outline"
										className="hidden sm:inline-flex"
										disabled={!dirty || !!busy}
										onClick={() => save(false)}
									>
										{busy === "save" && <Spinner />}
										Save draft
									</Button>
									<Button
										disabled={
											!!busy ||
											(!dirty &&
												saved.status === "published" &&
												!saved.has_unpublished_changes)
										}
										onClick={() => save(true)}
									>
										{busy === "publish" ? <Spinner /> : <Upload />}
										Publish
									</Button>
								</>
							)}
							<Button
								variant="outline"
								aria-label="Comments"
								onClick={() => setCommenting(true)}
							>
								<MessageSquare />
								{comments.open > 0 ? (
									<span className="tabular-nums">{comments.open}</span>
								) : (
									<span className="hidden lg:inline">Comments</span>
								)}
							</Button>
							<ApiDrawer
								title="This template in the API"
								description="Sends use the published version. Needs a full-access key to edit it."
								calls={[
									{
										title: "Send it",
										method: "POST",
										path: "/emails",
										body: {
											to: "ana@example.com",
											template: {
												id: saved.alias ?? saved.id,
												variables: previewValues(saved.variables),
											},
										},
									},
									{
										title: "Change its draft",
										method: "PATCH",
										path: `/templates/${saved.id}`,
										body: { subject: saved.subject ?? "" },
									},
									{
										title: "Publish the draft",
										method: "POST",
										path: `/templates/${saved.id}/publish`,
									},
								]}
							/>
							<More
								template={saved}
								onTest={() => setTesting(true)}
								onDelete={() => setDeleting(true)}
								onSave={() => save(false)}
								canSave={dirty && !busy}
								canEdit={canEdit}
								onHistory={() => setHistory(true)}
							/>
						</>
					}
				/>
			</div>
			<CommentsSheet
				subject={subject}
				comments={comments}
				open={commenting}
				onOpenChange={setCommenting}
				canComment
			/>
			<HistorySheet
				subject={subject}
				open={history}
				onOpenChange={setHistory}
				canRestore={canEdit}
				onRestored={() => router.invalidate()}
			/>
			<Confirm
				open={deleting}
				onOpenChange={setDeleting}
				title="Delete this template?"
				description="Sends that name it are refused from then on. Emails already sent keep their content."
				action="Delete template"
				onConfirm={async () => {
					try {
						await deleteTemplateFn({ data: { id: saved.id } });
						toast.success("Template deleted");
						await router.navigate({ to: "/templates" });
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
					title={form.name || "Template"}
					subject={form.subject}
					variables={groups}
					onClose={() => setBuilding(false)}
					actions={
						<>
							<span className="hidden text-xs text-muted-foreground md:inline">
								{dirty ? "Unsaved changes" : "Saved"}
							</span>
							<Button
								variant="outline"
								disabled={!dirty || !!busy}
								onClick={() => save(false)}
							>
								{busy === "save" && <Spinner />}
								Save draft
							</Button>
							<Button
								onClick={async () => {
									if (dirty && !(await save(false))) return;
									setBuilding(false);
								}}
							>
								Done
							</Button>
						</>
					}
				/>
			)}
			<SendTest
				open={testing}
				onOpenChange={setTesting}
				template={saved}
				defaultTo={me.user.email}
			/>

			<Facts className="border-b border-border/70 pb-8">
				<Fact label="Status">
					<TemplateStatus t={saved} />
				</Fact>
				<Fact label="Published">
					{saved.published_at ? (
						<span
							className="tabular-nums"
							title={formatDateTime(saved.published_at)}
						>
							{formatRelative(saved.published_at)}
						</span>
					) : (
						<span className="text-muted-foreground">Not yet</span>
					)}
				</Fact>
				<Fact label="Send it as">
					<span className="font-mono text-[13px]">{saved.alias ?? "—"}</span>
				</Fact>
				<Fact label="Id">
					<IdChip value={saved.id} />
				</Fact>
			</Facts>

			<div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
				<div className="flex min-w-0 flex-col gap-6">
					<Card className="gap-5 p-5">
						<div className="grid gap-5 sm:grid-cols-2">
							<Field>
								<FieldLabel htmlFor="t-name">Name</FieldLabel>
								<Input
									id="t-name"
									value={form.name}
									onChange={(e) => set("name", e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="t-alias">Alias</FieldLabel>
								<Input
									id="t-alias"
									className="font-mono"
									spellCheck={false}
									placeholder="welcome-email"
									value={form.alias}
									onChange={(e) => set("alias", e.target.value.toLowerCase())}
								/>
							</Field>
						</div>
						<Field>
							<FieldLabel htmlFor="t-from">From</FieldLabel>
							<Input
								id="t-from"
								spellCheck={false}
								placeholder="Harbor Inn <hello@harborinn.com>"
								value={form.from}
								onChange={(e) => set("from", e.target.value)}
							/>
							<FieldDescription>
								A default: a send's own From wins. Without one here, every send
								needs its own.
							</FieldDescription>
						</Field>
						<Field>
							<FieldLabel htmlFor="t-subject">Subject</FieldLabel>
							<TagField
								id="t-subject"
								placeholder="Welcome to the hotel"
								groups={groups}
								value={form.subject}
								onChange={(v) => set("subject", v)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="t-reply">Reply-To</FieldLabel>
							<Input
								id="t-reply"
								spellCheck={false}
								placeholder="Optional"
								value={form.reply_to}
								onChange={(e) => set("reply_to", e.target.value)}
							/>
						</Field>
					</Card>

					<Variables
						variables={form.variables}
						undeclared={undeclared}
						onChange={(v) => set("variables", v)}
					/>

					<EmailContent
						design={form.design}
						html={form.html}
						text={form.text}
						set={(k, v) => set(k, v as never)}
						look={data.look}
						kit={data.look.kit ? kitTheme(data.look.kit) : null}
						kind="template"
						onBuild={() => setBuilding(true)}
						footer="The plain text, left empty, is made from the email."
					/>
				</div>

				<Card className="min-w-0 gap-0 overflow-hidden p-0 lg:sticky lg:top-4">
					<div className="flex h-12 items-center gap-2 border-b border-border/70 pr-3 pl-5">
						<p className="min-w-0 flex-1 truncate text-sm">
							<span className="text-muted-foreground">Subject </span>
							<Ph>{previewSubject || "No subject"}</Ph>
						</p>
						<div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
							{[
								{ on: false, icon: Monitor, label: "Desktop width" },
								{ on: true, icon: Smartphone, label: "Phone width" },
							].map((w) => (
								<button
									key={w.label}
									type="button"
									aria-label={w.label}
									title={w.label}
									aria-pressed={phone === w.on}
									onClick={() => setPhone(w.on)}
									className={cn(
										"flex size-6 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:text-foreground",
										phone === w.on &&
											"bg-background text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_var(--shadow-color)] dark:bg-white/[0.1]",
									)}
								>
									<w.icon className="size-3.5" />
								</button>
							))}
						</div>
					</div>
					<div
						className={cn(
							"bg-muted/60 transition-[padding] duration-300 ease-out",
							phone && "px-4 py-6",
						)}
					>
						<iframe
							title="Preview"
							sandbox=""
							srcDoc={preview}
							className={cn(
								"mx-auto block h-[560px] w-full bg-white sm:h-[720px]",
								phone &&
									"max-w-[390px] rounded-2xl shadow-[0_0_0_1px_var(--border),0_8px_24px_-8px_var(--shadow-color-strong)]",
							)}
						/>
					</div>
					<p className="border-t border-border/70 px-5 py-2.5 text-xs text-muted-foreground">
						Shown with each variable's fallback (or its name), and Ana García as the
						contact.
					</p>
					<ContentChecks
						subject={previewSubject}
						html={preview}
						text={form.text}
					/>
				</Card>
			</div>
		</Page>
	);
}

function Variables({
	variables,
	undeclared,
	onChange,
}: {
	variables: Variable[];
	undeclared: string[];
	onChange: (v: Variable[]) => void;
}) {
	const update = (i: number, change: Partial<Variable>) =>
		onChange(variables.map((v, j) => (j === i ? { ...v, ...change } : v)));
	return (
		<Card className="gap-4 p-5">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h2 className="font-semibold">Variables</h2>
					<p className="mt-0.5 text-sm text-muted-foreground">
						Write <span className="font-mono text-[13px]">{"{{{KEY}}}"}</span> in the
						subject or body. Without a fallback, a send must give the value.
					</p>
				</div>
				<Button
					size="sm"
					variant="outline"
					disabled={variables.length >= 50}
					onClick={() =>
						onChange([...variables, { key: "", type: "string", fallback_value: "" }])
					}
				>
					<Plus />
					Add
				</Button>
			</div>
			{variables.length > 0 && (
				<div className="flex flex-col gap-2">
					{variables.map((v, i) => (
						<div
							key={i}
							className="grid grid-cols-[minmax(0,1fr)_6.5rem_2rem] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,1fr)_2rem]"
						>
							<Input
								aria-label="Key"
								className="font-mono"
								spellCheck={false}
								placeholder="PRODUCT"
								value={v.key}
								onChange={(e) =>
									update(i, {
										key: e.target.value
											.toUpperCase()
											.replace(/[^A-Z0-9_]/g, "_"),
									})
								}
							/>
							<Select
								value={v.type}
								onValueChange={(type) =>
									update(i, { type: type as Variable["type"] })
								}
							>
								<SelectTrigger aria-label="Type">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="string">Text</SelectItem>
									<SelectItem value="number">Number</SelectItem>
								</SelectContent>
							</Select>
							<Input
								aria-label="Fallback"
								className="order-last col-span-3 sm:order-none sm:col-span-1"
								placeholder="Fallback (optional)"
								inputMode={v.type === "number" ? "decimal" : undefined}
								value={v.fallback_value}
								onChange={(e) => update(i, { fallback_value: e.target.value })}
							/>
							<Button
								size="icon"
								variant="ghost"
								aria-label={`Remove ${v.key || "variable"}`}
								onClick={() => onChange(variables.filter((_, j) => j !== i))}
							>
								<X />
							</Button>
						</div>
					))}
				</div>
			)}
			{undeclared.length > 0 && (
				<p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
					Used but not declared:
					{undeclared.map((k) => (
						<button
							key={k}
							type="button"
							onClick={() =>
								onChange([
									...variables,
									{ key: k, type: "string", fallback_value: "" },
								])
							}
							className="rounded-md bg-warning/12 px-1.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-warning/20"
							title="Declare it"
						>
							{k}
						</button>
					))}
				</p>
			)}
			<p className="text-xs text-muted-foreground">
				FIRST_NAME, LAST_NAME, EMAIL and UNSUBSCRIBE_URL are filled by Mailroom (from the
				contact in broadcasts); give a fallback inline:{" "}
				<span className="font-mono">{"{{{FIRST_NAME|there}}}"}</span>.
			</p>
		</Card>
	);
}

function More({
	template,
	onTest,
	onDelete,
	onSave,
	canSave,
	canEdit,
	onHistory,
}: {
	template: Template;
	onTest: () => void;
	onDelete: () => void;
	onSave: () => void;
	canSave: boolean;
	canEdit: boolean;
	onHistory: () => void;
}) {
	const router = useRouter();
	const { copy } = useCopy();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					aria-label="More"
				>
					<MoreHorizontal />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{canEdit && (
					<DropdownMenuItem
						className="sm:hidden"
						disabled={!canSave}
						onSelect={onSave}
					>
						Save draft
					</DropdownMenuItem>
				)}
				<DropdownMenuItem
					disabled={template.status === "draft"}
					onSelect={onTest}
				>
					<Send />
					Send a test
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onHistory}>
					<History />
					History
				</DropdownMenuItem>
				<DropdownMenuItem
					disabled={!canEdit}
					onSelect={async () => {
						try {
							const { id } = await duplicateTemplateFn({ data: { id: template.id } });
							toast.success("Copied as a new draft");
							await router.navigate({ to: "/templates/$id", params: { id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						}
					}}
				>
					<Copy />
					Duplicate
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={() => copy(template.id)}>
					<Copy />
					Copy template id
				</DropdownMenuItem>
				{canEdit && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							variant="destructive"
							onSelect={onDelete}
						>
							<Trash2 />
							Delete template
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function SendTest({
	open,
	onOpenChange,
	template,
	defaultTo,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
	template: Template;
	defaultTo: string;
}) {
	const [to, setTo] = useState(defaultTo);
	const [from, setFrom] = useState(template.from ?? "");
	const [busy, setBusy] = useState(false);
	const router = useRouter();
	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="sm:max-w-md">
				<form
					className="contents"
					onSubmit={async (e) => {
						e.preventDefault();
						setBusy(true);
						try {
							const { id } = await sendTemplateTestFn({
								data: {
									id: template.id,
									to,
									from,
									variables: previewValues(template.variables),
								},
							});
							toast.success("Test sent");
							onOpenChange(false);
							if (id) await router.navigate({ to: "/emails/$id", params: { id } });
						} catch (error) {
							toast.error(await errorMessage(error));
						} finally {
							setBusy(false);
						}
					}}
				>
					<DialogHeader>
						<DialogTitle>Send a test</DialogTitle>
						<DialogDescription>
							The published version, with each variable's fallback (or its name).
							{template.has_unpublished_changes &&
								" Publish first to test your changes."}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="gap-5">
						<Field>
							<FieldLabel htmlFor="test-to">To</FieldLabel>
							<Input
								id="test-to"
								type="email"
								required
								value={to}
								onChange={(e) => setTo(e.target.value)}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="test-from">From</FieldLabel>
							<Input
								id="test-from"
								required={!template.from}
								placeholder={template.from ?? "Hotel <hola@your-domain.com>"}
								value={from}
								onChange={(e) => setFrom(e.target.value)}
							/>
							<FieldDescription>
								An address on one of your verified domains.
							</FieldDescription>
						</Field>
					</DialogBody>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={busy || !to.trim()}
						>
							{busy && <Spinner />}
							Send test
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
