import { useRouter } from "@tanstack/react-router";
import {
	Lock,
	MoreHorizontal,
	Pencil,
	Plus,
	RotateCcw,
	Trash2,
	UserCog,
	UserMinus,
	UserPlus,
	X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Confirm } from "@/components/confirm";
import { UserAvatar } from "@/components/org-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	cancelInvitationFn,
	changeMemberFn,
	deleteRoleFn,
	inviteFn,
	removeMemberFn,
	resetRoleFn,
	saveRoleFn,
	setApprovalFn,
	type teamFn,
} from "@/functions/team";
import { errorMessage } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMe } from "@/lib/me";
import {
	ALL_PERMISSIONS,
	allows,
	CATALOG,
	OWNER_ROLE,
	type Permission,
	REQUIRES,
	withRequirements,
} from "@/lib/permissions";
import { Ph } from "@/lib/sketch";
import { cn } from "@/lib/utils";

/*
 * Settings › Members, Roles and the approval rule: who's in the organization, what each role
 * allows (Owner fixed; the starter roles editable; the organization's own), and per person
 * permissions added or taken away. Nobody hands out more than they have; the server checks it.
 */

export type Team = Awaited<ReturnType<typeof teamFn>>;
type Role = Team["roles"][number];
type Member = Team["members"][number];

const reload = (router: ReturnType<typeof useRouter>) =>
	router.invalidate({ filter: (m) => m.routeId === "/_app/settings" });

async function attempt(fn: () => Promise<unknown>, done: string) {
	try {
		await fn();
		toast.success(done);
		return true;
	} catch (error) {
		toast.error(await errorMessage(error));
		return false;
	}
}

/** What a role gives, resolved like the server does. */
function roleGrants(r: Pick<Role, "all" | "permissions">): Set<Permission> {
	return r.all ? new Set(ALL_PERMISSIONS) : withRequirements(r.permissions);
}

function useMine() {
	const me = useMe();
	const access = me.active?.access;
	return {
		access,
		owner: !!access?.owner,
		has: (p: Permission) => allows(access, p),
	};
}

export function MembersCard({ team }: { team: Team }) {
	const me = useMe();
	const router = useRouter();
	const mine = useMine();
	const canInvite = mine.has("team:invite");
	const canManage = mine.has("team:manage");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("member");
	const [busy, setBusy] = useState(false);
	const [adjusting, setAdjusting] = useState<Member | null>(null);
	const roleBy = new Map(team.roles.map((r) => [r.slug, r]));
	const givable = team.roles.filter((r) => r.slug !== OWNER_ROLE);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Members</CardTitle>
				<CardDescription>
					Everyone here can look at everything. What they can change comes from their
					role, plus anything added or taken away for them alone.
				</CardDescription>
			</CardHeader>
			<ul className="border-t border-border/70">
				{team.members.map((m) => {
					const r = roleBy.get(m.role);
					const self = m.userId === me.user.id;
					const editable = canManage && !self && (m.role !== OWNER_ROLE || mine.owner);
					const custom = m.add.length + m.remove.length;
					return (
						<li
							key={m.id}
							className="flex items-center gap-3 border-b border-border/70 px-5 py-2.5 last:border-0"
						>
							<UserAvatar
								name={m.name || m.email}
								className="size-8 text-xs"
							/>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium">
									<Ph>{m.name || m.email}</Ph>
									{self && (
										<span className="ml-1.5 font-normal text-muted-foreground">
											(you)
										</span>
									)}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									<Ph>{m.email}</Ph>
									{custom > 0 && (
										<span className="text-foreground/80">
											{" · "}
											{[
												m.add.length ? `+${m.add.length}` : "",
												m.remove.length ? `−${m.remove.length}` : "",
											]
												.filter(Boolean)
												.join(" ")}{" "}
											on top of the role
										</span>
									)}
								</p>
							</div>
							{editable ? (
								<>
									<Select
										value={m.role}
										onValueChange={(v) =>
											void attempt(
												() =>
													changeMemberFn({
														data: {
															member: m.id,
															role: v,
															add: m.add,
															remove: m.remove,
														},
													}).then(() => reload(router)),
												`${m.name || m.email} is now ${(roleBy.get(v)?.name ?? v).toLowerCase()}`,
											)
										}
									>
										<SelectTrigger
											data-ph
											size="sm"
											className="w-32"
											aria-label={`Role of ${m.email}`}
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											<RoleItems roles={mine.owner ? team.roles : givable} />
										</SelectContent>
									</Select>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label={`More for ${m.email}`}
											>
												<MoreHorizontal />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											{m.role !== OWNER_ROLE && (
												<DropdownMenuItem onSelect={() => setAdjusting(m)}>
													<UserCog />
													Adjust their access
												</DropdownMenuItem>
											)}
											<DropdownMenuSeparator />
											<RemoveItem member={m} />
										</DropdownMenuContent>
									</DropdownMenu>
								</>
							) : (
								<Badge
									data-ph
									variant="secondary"
								>
									{r?.name ?? m.role}
								</Badge>
							)}
						</li>
					);
				})}
				{team.invitations.map((i) => (
					<li
						key={i.id}
						className="flex items-center gap-3 border-b border-border/70 px-5 py-2.5 last:border-0"
					>
						<span className="flex size-8 shrink-0 items-center justify-center rounded-full shadow-[inset_0_0_0_1px_var(--border-strong)] [background:repeating-linear-gradient(-45deg,transparent_0_3px,var(--muted)_3px_6px)]" />
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium">
								<Ph>{i.email}</Ph>
							</p>
							<p className="text-xs text-muted-foreground">
								<Ph>
									Invited as{" "}
									{roleBy.get(i.role)?.starter === false
										? roleBy.get(i.role)?.name
										: (roleBy.get(i.role)?.name ?? i.role).toLowerCase()}{" "}
									· expires {formatRelative(i.expiresAt)}
								</Ph>
							</p>
						</div>
						<Badge variant="outline">Pending</Badge>
						{canInvite && (
							<Confirm
								trigger={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Cancel the invitation to ${i.email}`}
										title="Cancel invitation"
									>
										<X />
									</Button>
								}
								title={`Cancel the invitation to ${i.email}?`}
								description="Its link stops working. You can invite them again later."
								action="Cancel invitation"
								cancel="Keep it"
								onConfirm={() =>
									void attempt(
										() =>
											cancelInvitationFn({ data: { id: i.id } }).then(() =>
												reload(router),
											),
										"Invitation canceled",
									)
								}
							/>
						)}
					</li>
				))}
			</ul>
			{canInvite && (
				<CardFooter>
					<form
						className="flex w-full flex-col gap-2 sm:flex-row"
						onSubmit={async (e) => {
							e.preventDefault();
							setBusy(true);
							const ok = await attempt(
								() =>
									inviteFn({ data: { email: email.trim(), role } }).then(() =>
										reload(router),
									),
								`Invitation sent to ${email.trim()}`,
							);
							setBusy(false);
							if (ok) setEmail("");
						}}
					>
						<Input
							type="email"
							required
							aria-label="Email to invite"
							placeholder="teammate@company.com"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							className="flex-1 bg-background"
						/>
						<Select
							value={role}
							onValueChange={setRole}
						>
							<SelectTrigger
								className="bg-background sm:w-36"
								aria-label="Role"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<RoleItems roles={givable} />
							</SelectContent>
						</Select>
						<Button
							type="submit"
							disabled={busy || !email.trim()}
						>
							{busy ? <Spinner /> : <UserPlus />}
							Invite
						</Button>
					</form>
				</CardFooter>
			)}
			{adjusting && (
				<MemberAccessDialog
					member={adjusting}
					roles={givable}
					onClose={() => setAdjusting(null)}
				/>
			)}
		</Card>
	);
}

function RemoveItem({ member }: { member: Member }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	return (
		<>
			<DropdownMenuItem
				variant="destructive"
				onSelect={(e) => {
					e.preventDefault();
					setOpen(true);
				}}
			>
				<UserMinus />
				Remove from organization
			</DropdownMenuItem>
			<Confirm
				open={open}
				onOpenChange={setOpen}
				title={`Remove ${member.email}?`}
				description="They lose access to this organization at once."
				action="Remove"
				onConfirm={() =>
					void attempt(
						() =>
							removeMemberFn({ data: { member: member.id } }).then(() =>
								reload(router),
							),
						`${member.email} removed`,
					)
				}
			/>
		</>
	);
}

function RoleItems({ roles }: { roles: Role[] }) {
	return (
		<>
			{roles.map((r) => (
				<SelectItem
					key={r.slug}
					value={r.slug}
					textValue={r.name}
				>
					<span className="flex max-w-72 flex-col">
						<span>{r.name}</span>
						<span className="text-xs whitespace-normal text-muted-foreground in-data-[slot=select-value]:hidden">
							{r.description || describe(r)}
						</span>
					</span>
				</SelectItem>
			))}
		</>
	);
}

/** "12 permissions", "Everything", for a role without a description. */
function describe(r: Pick<Role, "all" | "permissions">) {
	if (r.all) return "Everything, including future permissions";
	const n = roleGrants(r).size;
	return n ? `${n} permission${n === 1 ? "" : "s"}` : "Looks only";
}

/** One person's access: their role, plus permissions added or taken away for them alone. */
function MemberAccessDialog({
	member,
	roles,
	onClose,
}: {
	member: Member;
	roles: Role[];
	onClose: () => void;
}) {
	const router = useRouter();
	const mine = useMine();
	const [role, setRole] = useState(member.role);
	const [add, setAdd] = useState<Set<Permission>>(new Set(member.add));
	const [remove, setRemove] = useState<Set<Permission>>(new Set(member.remove));
	const [busy, setBusy] = useState(false);
	const r = roles.find((x) => x.slug === role);
	const fromRole = r ? roleGrants(r) : new Set<Permission>();
	const has = (p: Permission) => (fromRole.has(p) || add.has(p)) && !remove.has(p);
	const toggle = (p: Permission, on: boolean) => {
		const a = new Set(add);
		const rm = new Set(remove);
		if (on) {
			rm.delete(p);
			if (!fromRole.has(p)) a.add(p);
			for (const req of REQUIRES[p] ?? []) {
				rm.delete(req);
				if (!fromRole.has(req)) a.add(req);
			}
		} else {
			a.delete(p);
			if (fromRole.has(p)) rm.add(p);
			// What needs it goes too.
			for (const [q, reqs] of Object.entries(REQUIRES) as [Permission, Permission[]][])
				if (reqs.includes(p)) {
					a.delete(q);
					if (fromRole.has(q)) rm.add(q);
				}
		}
		setAdd(a);
		setRemove(rm);
	};
	return (
		<Sheet
			open
			onOpenChange={(o) => !o && onClose()}
		>
			<SheetContent className="sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>{member.name || member.email}'s access</SheetTitle>
					<SheetDescription>
						Their role sets the start. Tick or untick to give them more, or less, than
						the role.
					</SheetDescription>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="member-role">Role</Label>
						<Select
							value={role}
							onValueChange={setRole}
						>
							<SelectTrigger
								id="member-role"
								className="w-full"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<RoleItems roles={roles} />
							</SelectContent>
						</Select>
					</div>
					<PermissionList
						checked={has}
						onToggle={toggle}
						disabled={(p) => !mine.has(p)}
						note={(p) =>
							add.has(p)
								? "Added for them"
								: remove.has(p)
									? "Taken away for them"
									: null
						}
					/>
				</div>
				<SheetFooter className="flex-row justify-end">
					{(add.size > 0 || remove.size > 0) && (
						<Button
							variant="ghost"
							className="mr-auto"
							onClick={() => {
								setAdd(new Set());
								setRemove(new Set());
							}}
						>
							<RotateCcw />
							Just the role
						</Button>
					)}
					<Button
						variant="outline"
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							const ok = await attempt(
								() =>
									changeMemberFn({
										data: {
											member: member.id,
											role,
											add: [...add].filter((p) => !fromRole.has(p)),
											remove: [...remove].filter((p) => fromRole.has(p)),
										},
									}).then(() => reload(router)),
								"Access saved",
							);
							setBusy(false);
							if (ok) onClose();
						}}
					>
						{busy && <Spinner />}
						Save
					</Button>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}

/** The catalog as checkboxes, grouped. */
function PermissionList({
	checked,
	onToggle,
	disabled,
	note,
}: {
	checked: (p: Permission) => boolean;
	onToggle: (p: Permission, on: boolean) => void;
	disabled: (p: Permission) => boolean;
	note?: (p: Permission) => string | null;
}) {
	return (
		<div className="flex flex-col gap-4">
			{CATALOG.map((g) => (
				<fieldset
					key={g.id}
					className="flex flex-col gap-1"
				>
					<legend className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
						{g.title}
					</legend>
					{g.actions.map((a) => {
						const off = disabled(a.id);
						const n = note?.(a.id);
						return (
							// biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is a button, which a label names
							<label
								key={a.id}
								className={cn(
									"flex items-start gap-3 rounded-lg px-2 py-1.5 hover:bg-muted/60",
									off && "opacity-60 hover:bg-transparent",
								)}
							>
								<Checkbox
									className="mt-0.5"
									checked={checked(a.id)}
									disabled={off}
									onCheckedChange={(v) => onToggle(a.id, v === true)}
								/>
								<span className="min-w-0 flex-1">
									<span className="block text-sm">{a.label}</span>
									{(a.hint || n || off) && (
										<span className="block text-xs text-muted-foreground">
											{[
												n,
												a.hint,
												off ? "You don't have this yourself" : null,
											]
												.filter(Boolean)
												.join(" · ")}
										</span>
									)}
								</span>
							</label>
						);
					})}
				</fieldset>
			))}
		</div>
	);
}

export function RolesCard({ team }: { team: Team }) {
	const mine = useMine();
	const canEdit = mine.has("team:roles");
	const [editing, setEditing] = useState<Role | "new" | null>(null);
	return (
		<Card className="gap-0 pb-0">
			<CardHeader className="pb-4">
				<CardTitle>Roles</CardTitle>
				<CardDescription>
					What each role can change. Edit the starting ones or make your own, like
					"Designer" or "Agency".
				</CardDescription>
				{canEdit && (
					<CardAction>
						<Button
							size="sm"
							variant="outline"
							onClick={() => setEditing("new")}
						>
							<Plus />
							New role
						</Button>
					</CardAction>
				)}
			</CardHeader>
			<ul className="border-t border-border/70">
				{team.roles.map((r) => {
					const people = r.members + r.invitations;
					return (
						<li
							key={r.slug}
							className="flex items-center gap-3 border-b border-border/70 px-5 py-3 last:border-0"
						>
							<div className="min-w-0 flex-1">
								<p className="flex flex-wrap items-center gap-2 font-medium">
									{r.name}
									{r.slug === OWNER_ROLE ? (
										<Lock
											className="size-3.5 text-muted-foreground"
											aria-label="Fixed"
										/>
									) : r.edited ? (
										<Badge variant="outline">Edited</Badge>
									) : !r.starter ? (
										<Badge variant="secondary">Custom</Badge>
									) : null}
								</p>
								<p className="truncate text-xs text-muted-foreground">
									{r.description || describe(r)}
								</p>
							</div>
							<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
								{people === 0
									? "Nobody"
									: `${people} ${people === 1 ? "person" : "people"}`}
							</span>
							{r.slug !== OWNER_ROLE && (
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={canEdit ? `Edit ${r.name}` : `See ${r.name}`}
									onClick={() => setEditing(r)}
								>
									<Pencil />
								</Button>
							)}
						</li>
					);
				})}
			</ul>
			{editing && (
				<RoleDialog
					role={editing === "new" ? null : editing}
					readOnly={!canEdit}
					onClose={() => setEditing(null)}
				/>
			)}
		</Card>
	);
}

function RoleDialog({
	role,
	readOnly,
	onClose,
}: {
	role: Role | null;
	readOnly: boolean;
	onClose: () => void;
}) {
	const router = useRouter();
	const mine = useMine();
	const [name, setName] = useState(role?.name ?? "");
	const [description, setDescription] = useState(role?.description ?? "");
	const [all, setAll] = useState(role?.all ?? false);
	const [perms, setPerms] = useState<Set<Permission>>(new Set(role ? roleGrants(role) : []));
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const toggle = (p: Permission, on: boolean) => {
		const next = new Set(perms);
		if (on) for (const q of withRequirements([p])) next.add(q);
		else {
			next.delete(p);
			for (const [q, reqs] of Object.entries(REQUIRES) as [Permission, Permission[]][])
				if (reqs.includes(p)) next.delete(q);
		}
		setPerms(next);
	};
	const canAll = mine.owner || (mine.access?.all ?? false);
	const done = async (fn: () => Promise<unknown>, msg: string) => {
		setBusy(true);
		const ok = await attempt(() => fn().then(() => reload(router)), msg);
		setBusy(false);
		if (ok) onClose();
	};
	return (
		<Sheet
			open
			onOpenChange={(o) => !o && !busy && onClose()}
		>
			<SheetContent className="sm:max-w-lg">
				<SheetHeader>
					<SheetTitle>
						{role ? (readOnly ? role.name : `Edit ${role.name}`) : "New role"}
					</SheetTitle>
					<SheetDescription>
						{role && role.members + role.invitations > 0
							? `Changes apply at once to the ${role.members + role.invitations} ${role.members + role.invitations === 1 ? "person" : "people"} who have it.`
							: "Give it a name people recognize, then pick what it can change."}
					</SheetDescription>
				</SheetHeader>
				<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="role-name">Name</Label>
							<Input
								id="role-name"
								value={name}
								disabled={readOnly}
								placeholder="Designer"
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="role-description">What it's for</Label>
							<Textarea
								id="role-description"
								rows={2}
								value={description}
								disabled={readOnly}
								placeholder="Designs emails and the brand kit; doesn't send."
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
					</div>
					{/* biome-ignore lint/a11y/noLabelWithoutControl: the switch inside is a button, which a label names */}
					<label className="flex items-start gap-3 rounded-xl bg-muted/50 p-3">
						<Switch
							checked={all}
							disabled={readOnly || !canAll}
							onCheckedChange={setAll}
							className="mt-0.5"
						/>
						<span>
							<span className="block text-sm font-medium">
								Every permission, including future ones
							</span>
							<span className="block text-xs text-muted-foreground">
								{canAll
									? "Anything Mailroom adds later is theirs too."
									: "Only someone with every permission can give this."}
							</span>
						</span>
					</label>
					{!all && (
						<PermissionList
							checked={(p) => perms.has(p)}
							onToggle={toggle}
							disabled={(p) => readOnly || !mine.has(p)}
						/>
					)}
				</div>
				<SheetFooter className="flex-row items-center">
					{!readOnly && role?.starter && role.edited && (
						<Button
							variant="ghost"
							className="mr-auto"
							disabled={busy}
							onClick={() =>
								done(
									() => resetRoleFn({ data: { slug: role.slug } }),
									`${role.name} reset`,
								)
							}
						>
							<RotateCcw />
							Reset to Mailroom's
						</Button>
					)}
					{!readOnly && role && !role.starter && (
						<Button
							variant="ghost"
							className="mr-auto text-destructive hover:text-destructive"
							disabled={busy || role.members + role.invitations > 0}
							title={
								role.members + role.invitations > 0
									? "Give the people who have it another role first"
									: undefined
							}
							onClick={() => setDeleting(true)}
						>
							<Trash2 />
							Delete role
						</Button>
					)}
					<Button
						variant="outline"
						className="ml-auto"
						onClick={onClose}
					>
						{readOnly ? "Close" : "Cancel"}
					</Button>
					{!readOnly && (
						<Button
							disabled={busy || name.trim().length < 2}
							onClick={() =>
								done(
									() =>
										saveRoleFn({
											data: {
												slug: role?.slug,
												name,
												description,
												all,
												permissions: all ? [] : [...perms],
											},
										}),
									role ? "Role saved" : `${name.trim()} created`,
								)
							}
						>
							{busy && <Spinner />}
							{role ? "Save" : "Create role"}
						</Button>
					)}
				</SheetFooter>
				{role && !role.starter && (
					<Confirm
						open={deleting}
						onOpenChange={setDeleting}
						title={`Delete ${role.name}?`}
						description="Nobody has it, so nothing else changes. It can't be given to anyone after this."
						action="Delete role"
						onConfirm={() =>
							done(
								() => deleteRoleFn({ data: { slug: role.slug } }),
								`${role.name} deleted`,
							)
						}
					/>
				)}
			</SheetContent>
		</Sheet>
	);
}

/** "Every broadcast needs approval". */
export function ApprovalCard({ team }: { team: Team }) {
	const router = useRouter();
	const mine = useMine();
	const [busy, setBusy] = useState(false);
	return (
		<Card>
			<CardHeader>
				<CardTitle>Approval before sending</CardTitle>
				<CardDescription>
					Every broadcast needs someone with "Approve" to approve it before it's sent or
					scheduled, and editing it after asks again. Off, anyone who can send sends; they
					can still ask for a review.
				</CardDescription>
				<CardAction>
					<Switch
						checked={team.needs_approval}
						disabled={busy || !mine.has("settings:manage")}
						aria-label="Every broadcast needs approval"
						onCheckedChange={async (on) => {
							setBusy(true);
							await attempt(
								() => setApprovalFn({ data: { on } }).then(() => reload(router)),
								on ? "Broadcasts now need approval" : "Approval no longer required",
							);
							setBusy(false);
						}}
					/>
				</CardAction>
			</CardHeader>
		</Card>
	);
}
