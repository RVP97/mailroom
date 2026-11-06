import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { History } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { AccessLogCard } from "@/components/access-log-card";
import { ArchiveCard } from "@/components/archive-card";
import { DigestCard } from "@/components/digest-card";
import { FirewallCard, FirewallsOverview } from "@/components/firewall-card";
import { OrgAvatar } from "@/components/org-avatar";
import { OrgLogoCard } from "@/components/org-logo-card";
import { Page, PageHeader } from "@/components/page";
import { OrganizationLimitsCard } from "@/components/sending-limits";
import { SesAccountCard } from "@/components/ses-account-card";
import { ApprovalCard, MembersCard, RolesCard } from "@/components/team";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accessLogFn, firewallsFn } from "@/functions/recipients";
import { renameOrganizationFn, teamFn } from "@/functions/team";
import { errorMessage } from "@/lib/errors";
import { forgetMe, useMe } from "@/lib/me";
import { allows, STARTER_ROLES } from "@/lib/permissions";
import { ago, Ph, rememberedRows, Sketch, sample, usePage, useRememberRows } from "@/lib/sketch";

const SETTINGS_TABS = ["general", "team", "sending", "data"] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];

export const Route = createFileRoute("/_app/settings")({
	validateSearch: z.object({ tab: z.enum(SETTINGS_TABS).optional().catch(undefined) }),
	loader: async () => {
		const [team, firewalls, log] = await Promise.all([teamFn(), firewallsFn(), accessLogFn()]);
		return { team, firewalls, log };
	},
	head: () => ({ meta: [{ title: "Settings · Mailroom" }] }),
	component: Settings,
	pendingComponent: SettingsSketch,
});

function SettingsSketch() {
	const me = useMe();
	const firewall = {
		block_disposable: false,
		block_free: false,
		block_plus: false,
		never: [],
		always: [],
		updated_at: null,
		on: false,
		blocked: { total: 0, never: 0, disposable: 0, free: 0, plus: 0 },
	};
	return (
		<Sketch
			data={{
				team: {
					members: sample(rememberedRows("settings:members", 1), (i) => ({
						id: `sketch-${i}`,
						userId: i === 0 ? me.user.id : `user-${i}`,
						role: i === 0 ? (me.active?.role ?? "owner") : "member",
						add: [],
						remove: [],
						name: i === 0 ? me.user.name : "Teammate",
						email: i === 0 ? me.user.email : "teammate@example.com",
						joined: ago(60 * 24 * 30),
					})),
					invitations: sample(rememberedRows("settings:invitations", 0), (i) => ({
						id: `invite-${i}`,
						email: "someone@example.com",
						role: "member",
						expiresAt: ago(-60 * 24 * 2),
					})),
					roles: [
						{
							slug: "owner",
							name: "Owner",
							description: "Everything, always.",
							all: true,
							permissions: [],
							starter: true,
							edited: false,
							members: 1,
							invitations: 0,
						},
						...STARTER_ROLES.map((r) => ({
							...r,
							edited: false,
							members: 0,
							invitations: 0,
						})),
					],
					needs_approval: false,
				},
				firewalls: sample(Math.max(1, me.brands.length), (i) => ({
					brand_id: me.brands[i]?.id ?? me.active?.id ?? "",
					...firewall,
				})),
				log: sample(rememberedRows("settings:log", 3), (i) => ({
					id: `sketch-${i}`,
					who: "Someone",
					action: "lookup",
					channel: "dashboard",
					subject: "guest@example.com",
					created_at: ago(i * 60),
				})),
			}}
		>
			<Settings />
		</Sketch>
	);
}

function Settings() {
	const me = useMe();
	const canManage = allows(me.active?.access, "settings:manage");
	const { team, firewalls, log } = usePage(Route).data;
	useRememberRows("settings:log", log.length);
	useRememberRows("settings:members", team.members.length);
	useRememberRows("settings:invitations", team.invitations.length);
	const only = firewalls.length === 1 ? firewalls[0] : null;
	const { search } = usePage(Route);
	const navigate = useNavigate();
	const tab: SettingsTab = search.tab ?? "general";
	const setTab = (t: string) =>
		navigate({
			to: ".",
			search: { tab: t === "general" ? undefined : (t as SettingsTab) },
			replace: true,
			resetScroll: false,
		});
	return (
		<Page className="max-w-4xl">
			<PageHeader
				title="Settings"
				description={
					<>
						<Ph>{me.active?.name ?? "This organization"}</Ph>: who's in it, what they
						can do, and who its emails may go to. Each brand's sending setup is on its
						page in Brands.
					</>
				}
			/>
			<Tabs
				value={tab}
				onValueChange={setTab}
				className="gap-6"
			>
				<div className="-mx-1 overflow-x-auto border-b border-border/70 px-1">
					<TabsList variant="line">
						<TabsTrigger value="general">General</TabsTrigger>
						<TabsTrigger value="team">
							Team
							<span className="text-muted-foreground tabular-nums">
								{team.members.length}
							</span>
						</TabsTrigger>
						<TabsTrigger value="sending">Sending</TabsTrigger>
						<TabsTrigger value="data">Reports and data</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent
					value="general"
					className="flex flex-col gap-6"
				>
					<Organization canManage={canManage} />
					<OrgLogoCard canManage={canManage} />
				</TabsContent>
				<TabsContent
					value="team"
					className="flex flex-col gap-6"
				>
					<MembersCard team={team} />
					<RolesCard team={team} />
					<ApprovalCard team={team} />
					{allows(me.active?.access, "activity:view") && (
						<Card>
							<CardHeader>
								<CardTitle>Activity</CardTitle>
								<CardDescription>
									Who changed what: broadcasts sent and approved, templates
									edited, people invited, domains and keys added.
								</CardDescription>
								<CardAction>
									<Button
										variant="outline"
										size="sm"
										asChild
									>
										<Link to="/activity">
											<History />
											See activity
										</Link>
									</Button>
								</CardAction>
							</CardHeader>
						</Card>
					)}
				</TabsContent>
				<TabsContent
					value="sending"
					className="flex flex-col gap-6"
				>
					{only ? (
						<FirewallCard
							brand={only.brand_id}
							firewall={only}
							canManage={allows(me.active?.access, "recipients:block")}
							description="Checks every recipient before an email is sent. Each check is optional. Blocked recipients are left out and the email shows which rule did it. With more brands, each gets its own."
						/>
					) : (
						<FirewallsOverview firewalls={firewalls} />
					)}
					<OrganizationLimitsCard />
					<SesAccountCard />
				</TabsContent>
				<TabsContent
					value="data"
					className="flex flex-col gap-6"
				>
					<DigestCard canManage={canManage} />
					<ArchiveCard canManage={canManage} />
					<AccessLogCard rows={log} />
				</TabsContent>
			</Tabs>
		</Page>
	);
}

function Organization({ canManage }: { canManage: boolean }) {
	const me = useMe();
	const router = useRouter();
	const [name, setName] = useState(me.active?.name ?? "");
	const [busy, setBusy] = useState(false);
	const changed = name.trim() !== "" && name.trim() !== me.active?.name;
	return (
		<Card>
			<form
				onSubmit={async (e) => {
					e.preventDefault();
					if (!changed) return;
					setBusy(true);
					try {
						await renameOrganizationFn({ data: { name: name.trim() } });
						toast.success("Name saved");
						forgetMe();
						await router.invalidate();
					} catch (error) {
						toast.error(await errorMessage(error));
					} finally {
						setBusy(false);
					}
				}}
			>
				<CardHeader>
					<CardTitle>Organization name</CardTitle>
					<CardDescription>
						How it shows in the sidebar and in invitations.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex max-w-md items-center gap-3">
						<OrgAvatar
							name={name || me.active?.name || ""}
							id={me.active?.id}
							logo={me.active?.logo?.url}
							background={me.active?.logo?.background}
							className="size-8 rounded-lg text-sm"
						/>
						<Input
							id="org-name"
							aria-label="Organization name"
							value={name}
							disabled={!canManage}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
				</CardContent>
				<CardFooter>
					<span className="mr-auto text-xs">
						Its slug,{" "}
						<code className="font-mono">
							<Ph>{me.active?.slug}</Ph>
						</code>
						, names its SES tenant, so it never changes.
					</span>
					{canManage && (
						<Button
							type="submit"
							size="sm"
							disabled={busy || !changed}
						>
							{busy && <Spinner />}
							Save
						</Button>
					)}
				</CardFooter>
			</form>
		</Card>
	);
}
