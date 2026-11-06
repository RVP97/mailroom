import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ExternalLink, MoreHorizontal, Plus, ShieldCheck, SquarePen } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { ContactsHeader } from "@/components/contacts-tabs";
import { CopyIcon, useCopy } from "@/components/copy";
import { Page, TableCard } from "@/components/page";
import { Stamp } from "@/components/record";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
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
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { deleteFormFn, listFormsFn, retryTurnstileFn } from "@/functions/signup-forms";
import { errorMessage } from "@/lib/errors";
import { useMe } from "@/lib/me";
import { allows } from "@/lib/permissions";
import { DEFAULT_DESIGN } from "@/lib/signup-form-render";
import { Ph, pick, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

export const Route = createFileRoute("/_app/contacts/forms/")({
	validateSearch: (s: Record<string, unknown>): { code?: string } =>
		typeof s.code === "string" ? { code: s.code } : {},
	loader: () => listFormsFn(),
	head: () => ({ meta: [{ title: "Sign-up forms · Mailroom" }] }),
	component: Forms,
	pendingComponent: FormsSketch,
});

type Data = Awaited<ReturnType<typeof listFormsFn>>;
type SignupForm = Data["forms"][number];

function FormsSketch() {
	return (
		<Sketch
			data={
				{
					brands: [],
					options: {},
					logos: {},
					turnstileConfigured: true,
					forms: sample(rememberedRows("signup-forms", 2), (i) => ({
						object: "signup_form",
						id: `sketch-${i}`,
						brand_id: "",
						name: pick(i, ["Website footer", "Blog"]),
						title: "The newsletter",
						segment_id: null,
						topic_id: null,
						from: "hola@example.com",
						ask_name: true,
						website: "https://example.com",
						redirect_url: null,
						enabled: true,
						signups: 0,
						confirmed: 0,
						url: "",
						created_at: "",
						updated_at: "",
						html: "",
						script: "",
						turnstile: true,
						turnstileError: null,
						design: DEFAULT_DESIGN,
					})),
				} satisfies Data
			}
		>
			<Forms />
		</Sketch>
	);
}

function Forms() {
	// usePage, not Route.useSearch(): the skeleton renders this outside the route, where that throws.
	const { data, search } = usePage(Route);
	const me = useMe();
	const canManage = allows(me.active?.access, "forms:edit");
	const router = useRouter();
	// A form just made opens its code (?code=), since putting it on the website is next.
	const navigate = Route.useNavigate();
	const code = data.forms.find((f) => f.id === search.code) ?? null;
	const setCode = (f: SignupForm | null) =>
		navigate({ search: f ? { code: f.id } : {}, replace: true });
	const [deleting, setDeleting] = useState<SignupForm | null>(null);
	useRememberRows("signup-forms", data.forms.length);
	const names = new Map(data.brands.map((b) => [b.id, b.name]));
	return (
		<Page>
			<ContactsHeader
				current="forms"
				actions={
					canManage &&
					data.forms.length > 0 && (
						<Button asChild>
							<Link
								to="/contacts/forms/$id"
								params={{ id: "new" }}
							>
								<Plus />
								New form
							</Link>
						</Button>
					)
				}
			/>
			<p className="-mt-2 max-w-3xl text-sm text-muted-foreground">
				A newsletter box for your websites. Whoever signs up gets an email to confirm, and
				only then becomes a contact, in the form's segment and topic, so bots and typos
				never reach your lists.
			</p>
			<CodeDialog
				form={code}
				turnstileConfigured={data.turnstileConfigured}
				onClose={() => setCode(null)}
			/>
			<Confirm
				open={!!deleting}
				onOpenChange={(v) => !v && setDeleting(null)}
				title="Delete this form?"
				description="Websites with it can't sign people up anymore, and links in confirmation emails already sent stop working. Contacts it added stay."
				action="Delete form"
				onConfirm={async () => {
					try {
						await deleteFormFn({ data: { id: deleting?.id ?? "" } });
						toast.success("Form deleted");
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					}
				}}
			/>
			<TableCard>
				{data.forms.length === 0 ? (
					<Empty>
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<SquarePen />
							</EmptyMedia>
							<EmptyTitle>No sign-up forms yet</EmptyTitle>
							<EmptyDescription>
								Make one, paste its code into your website (or share its page), and
								people who confirm become contacts your broadcasts reach.
							</EmptyDescription>
						</EmptyHeader>
						{canManage && (
							<EmptyContent>
								<Button asChild>
									<Link
										to="/contacts/forms/$id"
										params={{ id: "new" }}
									>
										<Plus />
										New form
									</Link>
								</Button>
							</EmptyContent>
						)}
					</Empty>
				) : (
					<Table className="table-fixed">
						<TableHeader>
							<TableRow>
								<TableHead>Form</TableHead>
								<TableHead className="hidden w-40 text-right md:table-cell">
									Confirmed
								</TableHead>
								<TableHead className="w-24">Status</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.forms.map((f) => (
								<TableRow key={f.id}>
									<TableCell className="h-14">
										<span className="flex min-w-0 items-center gap-3">
											<Stamp
												icon={f.turnstile ? ShieldCheck : SquarePen}
												tone="blue"
												className="size-7"
											/>
											<span className="min-w-0">
												{canManage ? (
													<Link
														to="/contacts/forms/$id"
														params={{ id: f.id }}
														className="block max-w-full truncate font-medium hover:underline"
													>
														<Ph>{f.name}</Ph>
													</Link>
												) : (
													<button
														type="button"
														onClick={() => setCode(f)}
														className="block max-w-full truncate text-left font-medium hover:underline"
													>
														<Ph>{f.name}</Ph>
													</button>
												)}
												<span className="block truncate text-xs text-muted-foreground">
													<Ph>
														{[
															data.brands.length > 1
																? names.get(f.brand_id)
																: null,
															f.website
																? new URL(f.website).hostname
																: "Its own page",
															f.turnstile ? "Turnstile" : null,
														]
															.filter(Boolean)
															.join(" · ")}
													</Ph>
												</span>
											</span>
										</span>
									</TableCell>
									<TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
										<Ph>
											{f.confirmed.toLocaleString()} of{" "}
											{f.signups.toLocaleString()}
										</Ph>
									</TableCell>
									<TableCell>
										<StatusBadge
											status={f.enabled ? "ready" : "paused"}
											label={f.enabled ? "On" : "Off"}
										/>
									</TableCell>
									<TableCell className="text-right">
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													size="icon"
													variant="ghost"
													aria-label={`More for ${f.name}`}
												>
													<MoreHorizontal />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem onSelect={() => setCode(f)}>
													Get the code
												</DropdownMenuItem>
												<DropdownMenuItem asChild>
													<a
														href={f.url}
														target="_blank"
														rel="noreferrer"
													>
														Open its page
													</a>
												</DropdownMenuItem>
												{canManage && (
													<>
														<DropdownMenuItem asChild>
															<Link
																to="/contacts/forms/$id"
																params={{ id: f.id }}
															>
																Edit and design
															</Link>
														</DropdownMenuItem>
														<DropdownMenuItem
															variant="destructive"
															onSelect={() => setDeleting(f)}
														>
															Delete
														</DropdownMenuItem>
													</>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</TableCard>
		</Page>
	);
}

function CodeDialog({
	form,
	turnstileConfigured,
	onClose,
}: {
	form: SignupForm | null;
	turnstileConfigured: boolean;
	onClose: () => void;
}) {
	const router = useRouter();
	const snippet = useCopy();
	const link = useCopy();
	const [busy, setBusy] = useState(false);
	const [kind, setKind] = useState<"script" | "html">("script");
	const code = (kind === "script" ? form?.script : form?.html) ?? "";
	return (
		<Dialog
			open={!!form}
			onOpenChange={(v) => !v && onClose()}
		>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>{form?.name}</DialogTitle>
					<DialogDescription>
						Paste it where the form should go on your website.
						{form?.design.display !== "inline" &&
							" It shows over the page by itself, so anywhere on the page works."}
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="gap-4">
					<Field>
						<div className="flex items-center justify-between gap-3">
							<FieldLabel htmlFor="form-code">Code</FieldLabel>
							<ToggleGroup
								type="single"
								variant="outline"
								size="sm"
								value={kind}
								onValueChange={(x) => x && setKind(x as typeof kind)}
							>
								<ToggleGroupItem value="script">Script</ToggleGroupItem>
								<ToggleGroupItem value="html">HTML</ToggleGroupItem>
							</ToggleGroup>
						</div>
						<Textarea
							id="form-code"
							readOnly
							rows={kind === "script" ? 2 : 9}
							className="font-mono text-xs"
							value={code}
						/>
						<FieldDescription>
							{kind === "script"
								? "One line, and it always shows the form as you last saved it: change the design here and your website follows."
								: "The whole form, for sites that don't run scripts from elsewhere. Paste it again after you change the design."}
						</FieldDescription>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="self-start"
							onClick={() => snippet.copy(code)}
						>
							<CopyIcon copied={snippet.copied} />
							Copy code
						</Button>
					</Field>
					<Field>
						<FieldLabel>Or share its page</FieldLabel>
						<div className="flex gap-2">
							<Input
								readOnly
								value={form?.url ?? ""}
								className="font-mono text-xs"
							/>
							<Button
								type="button"
								variant="outline"
								size="icon"
								aria-label="Copy the link"
								onClick={() => link.copy(form?.url ?? "")}
							>
								<CopyIcon copied={link.copied} />
							</Button>
							<Button
								type="button"
								variant="outline"
								size="icon"
								asChild
							>
								<a
									href={form?.url}
									target="_blank"
									rel="noreferrer"
									aria-label="Open its page"
								>
									<ExternalLink />
								</a>
							</Button>
						</div>
					</Field>
					<p className="flex items-start gap-2 text-sm text-muted-foreground">
						<ShieldCheck className="mt-0.5 size-4 shrink-0" />
						<span>
							{form?.turnstile
								? `Cloudflare Turnstile checks each sign-up${form.website ? `, on ${new URL(form.website).hostname} and this page` : " on this page"}. Mailroom added the sites to it.`
								: !turnstileConfigured
									? "Turnstile is off: give Mailroom's Cloudflare API token the Account › Turnstile › Edit permission and set CLOUDFLARE_ACCOUNT_ID. Until then, a hidden field and a limit per IP keep bots out."
									: (form?.turnstileError ??
										"Turnstile isn't set up for this brand yet.")}
						</span>
					</p>
				</DialogBody>
				<DialogFooter>
					{!form?.turnstile && turnstileConfigured && (
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={async () => {
								if (!form) return;
								setBusy(true);
								try {
									const r = await retryTurnstileFn({
										data: { brand: form.brand_id },
									});
									if (r.error) toast.error(r.error);
									else toast.success("Turnstile is on");
									await router.invalidate();
									onClose();
								} catch (error) {
									toast.error(await errorMessage(error));
								} finally {
									setBusy(false);
								}
							}}
						>
							{busy && <Spinner />}
							Set up Turnstile
						</Button>
					)}
					<Button
						type="button"
						onClick={onClose}
					>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
