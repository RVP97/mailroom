import { Link } from "@tanstack/react-router";
import { UserAvatar } from "@/components/org-avatar";
import type { activityFn } from "@/functions/team";
import { formatAgo, formatDateTime } from "@/lib/format";
import { Ph } from "@/lib/sketch";

export type ActivityRow = Awaited<ReturnType<typeof activityFn>>[number];

/** What each action reads as: "<who> <verb> <what>". */
const VERB: Record<string, string> = {
	"broadcast.created": "created the broadcast",
	"broadcast.edited": "edited the broadcast",
	"broadcast.sent": "sent the broadcast",
	"broadcast.scheduled": "scheduled the broadcast",
	"broadcast.canceled": "canceled the broadcast",
	"broadcast.deleted": "deleted the broadcast",
	"broadcast.restored": "restored an earlier version of the broadcast",
	"broadcast.commented": "commented on the broadcast",
	"broadcast.review_requested": "asked for a review of the broadcast",
	"broadcast.review_withdrawn": "withdrew the review request of the broadcast",
	"broadcast.approved": "approved the broadcast",
	"broadcast.changes_requested": "asked for changes to the broadcast",
	"template.created": "created the template",
	"template.edited": "edited the template",
	"template.published": "published the template",
	"template.deleted": "deleted the template",
	"template.restored": "restored an earlier version of the template",
	"template.commented": "commented on the template",
	"member.invited": "invited",
	"member.invitation_canceled": "canceled the invitation of",
	"member.changed": "changed the access of",
	"member.removed": "removed",
	"role.created": "created the role",
	"role.updated": "edited the role",
	"role.deleted": "deleted the role",
	"role.reset": "reset the role",
	"domain.added": "added the domain",
	"domain.updated": "changed the domain",
	"domain.removed": "removed the domain",
	"domain.tracking_changed": "changed tracking of",
	"domain.receiving_changed": "changed receiving of",
	"domain.bimi_changed": "changed the BIMI logo of",
	"brand.sending_set_up": "set up sending for",
	"brand.created": "added the brand",
	"brand.updated": "changed the brand",
	"brand.removed": "removed the brand",
	"brand_kit.edited": "edited the brand kit of",
	"unsubscribe_page.edited": "edited the unsubscribe page of",
	"unsubscribe_page.reset": "reset the unsubscribe page of",
	"api_key.created": "created the API key",
	"api_key.deleted": "deleted the API key",
	"smtp.created": "created SMTP credentials",
	"smtp.deleted": "deleted SMTP credentials",
	"webhook.created": "added the webhook",
	"webhook.updated": "changed the webhook",
	"webhook.deleted": "deleted the webhook",
	"suppression.added": "blocked",
	"suppression.removed": "let receive again",
	"unsubscribe.removed": "subscribed again",
	"firewall.updated": "changed the firewall",
	"contact.edited": "edited the contact",
	"contact.deleted": "deleted the contact",
	"contact.merged": "merged another contact into",
	"contacts.imported": "imported contacts",
	"contacts.cleaned_up": "cleaned up the list",
	"segment.saved": "saved the segment",
	"segment.deleted": "deleted the segment",
	"topic.saved": "saved the topic",
	"topic.deleted": "deleted the topic",
	"automation.created": "created the automation",
	"automation.edited": "edited the automation",
	"automation.deleted": "deleted the automation",
	"newsletter.edited": "edited the newsletter",
	"newsletter.deleted": "deleted the newsletter",
	"campaign.edited": "edited the campaign",
	"campaign.deleted": "deleted the campaign",
	"form.edited": "edited the sign-up form",
	"form.deleted": "deleted the sign-up form",
	"inbound_rule.saved": "saved the inbound rule",
	"inbound_rule.deleted": "deleted the inbound rule",
	"received.replied": "replied to an email",
	"section.saved": "saved the section",
	"section.deleted": "deleted the section",
	"settings.renamed": "renamed the organization to",
	"settings.logo_changed": "changed the organization's logo",
	"settings.archive_changed": "changed the archive setting",
	"settings.digest_changed": "changed the weekly digest",
	"settings.approval_required": "made approval required before sending",
	"settings.approval_not_required": "stopped requiring approval before sending",
};

const verbOf = (action: string) =>
	VERB[action] ?? action.replace(/[._]/g, " ").replace(/^(\w+) (\w+)$/, "$2 the $1");

/** Where a subject's page is (if it has one). */
function linkOf(r: ActivityRow) {
	if (!r.subject_id || r.action.endsWith(".deleted")) return null;
	if (r.subject_type === "broadcast")
		return { to: "/broadcasts/$id", params: { id: r.subject_id } } as const;
	if (r.subject_type === "template")
		return { to: "/templates/$id", params: { id: r.subject_id } } as const;
	return null;
}

export function ActivityFeed({ rows, compact }: { rows: ActivityRow[]; compact?: boolean }) {
	const now = Date.now();
	if (!rows.length)
		return (
			<p className="px-5 py-6 text-center text-sm text-muted-foreground">
				Nothing yet. Changes people make show up here.
			</p>
		);
	return (
		<ul>
			{rows.map((r) => {
				const to = compact ? null : linkOf(r);
				const name = r.subject_name ? (
					to ? (
						<Link
							{...to}
							className="font-medium text-foreground underline-offset-4 hover:underline"
						>
							<Ph>{r.subject_name}</Ph>
						</Link>
					) : (
						<span className="font-medium text-foreground">
							<Ph>{r.subject_name}</Ph>
						</span>
					)
				) : null;
				return (
					<li
						key={r.id}
						className="flex items-start gap-3 border-b border-border/70 px-5 py-2.5 text-sm last:border-0"
					>
						<UserAvatar
							name={r.actor}
							className="mt-0.5 size-6 text-[10px]"
						/>
						<p className="min-w-0 flex-1 text-muted-foreground">
							<span className="font-medium text-foreground">
								<Ph>{r.actor}</Ph>
							</span>{" "}
							{compact
								? verbOf(r.action).replace(/ the (broadcast|template)$/, "")
								: verbOf(r.action)}
							{!compact && name ? <> {name}</> : null}
							{r.detail &&
							typeof r.detail.to === "string" &&
							r.action === "member.changed" ? (
								<> (now {r.detail.to})</>
							) : null}
						</p>
						<time
							dateTime={r.created_at}
							title={formatDateTime(r.created_at)}
							className="shrink-0 text-xs text-muted-foreground tabular-nums"
						>
							{formatAgo(r.created_at, now)}
						</time>
					</li>
				);
			})}
		</ul>
	);
}
