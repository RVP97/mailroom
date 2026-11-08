import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { and, asc, eq } from "drizzle-orm";
import { NO_PERMISSION_MESSAGE, PERMISSION_LABEL, type Permission } from "../lib/permissions";
import { accessColumns, accessFromRow, roleJoin } from "./access";
import { logActivity } from "./activity";
import { auth } from "./auth";
import { db, schema } from "./db";
import { isAdminEmail } from "./env";

/**
 * The dashboard's data boundary: every server function resolves the Better Auth session and the
 * active organization (the member's role and permissions in it), and refuses the call otherwise.
 */

export type { Role } from "../lib/roles";

import type { Role } from "../lib/roles";

const unauthorized = () => new Response("Sign in again", { status: 401 });
const forbidden = (why = "You don't have access to this") => new Response(why, { status: 403 });

export const sessionMiddleware = createMiddleware().server(async ({ next }) => {
	const session = await auth().api.getSession({ headers: getRequest().headers });
	if (!session) throw unauthorized();
	return next({
		context: {
			userId: session.user.id,
			email: session.user.email,
			name: session.user.name,
			activeOrganizationId: session.session.activeOrganizationId ?? null,
			isAdmin: isAdminEmail(session.user.email),
		},
	});
});

/** The session's organization (or the person's first one), their role and access in it. */
export const orgMiddleware = createMiddleware()
	.middleware([sessionMiddleware])
	.server(async ({ next, context }) => {
		const m = schema.member;
		const rows = await db
			.select({ organizationId: m.organizationId, ...accessColumns })
			.from(m)
			.leftJoin(schema.organizationRole, roleJoin)
			.where(
				context.activeOrganizationId
					? and(
							eq(m.userId, context.userId),
							eq(m.organizationId, context.activeOrganizationId),
						)
					: eq(m.userId, context.userId),
			)
			.orderBy(asc(m.createdAt))
			.limit(1);
		const membership = rows[0];
		if (!membership) throw forbidden("You aren't a member of any organization yet");
		const access = accessFromRow(membership);
		return next({
			context: {
				organizationId: membership.organizationId,
				role: membership.role as Role,
				access,
				/** Sees runs of 4+ digits in emails as dots. */
				masked: !access.can("emails:unmasked"),
			},
		});
	});

const middlewares = new Map<Permission, ReturnType<typeof makeCan>>();

/**
 * Changes the activity log records on their own (src/server/activity.ts): the server function's
 * name → the action and what it's about. Broadcasts, templates and the team log themselves.
 */
const LOGGED: Record<string, [action: string, subject: string]> = {
	addDomainFn: ["domain.added", "domain"],
	updateDomainFn: ["domain.updated", "domain"],
	removeDomainFn: ["domain.removed", "domain"],
	setUpSendingFn: ["brand.sending_set_up", "brand"],
	setTrackingFn: ["domain.tracking_changed", "domain"],
	setDomainReceivingFn: ["domain.receiving_changed", "domain"],
	setBimiLogoFn: ["domain.bimi_changed", "domain"],
	setOrgLogoFn: ["settings.logo_changed", "organization"],
	createKeyFn: ["api_key.created", "api_key"],
	deleteKeyFn: ["api_key.deleted", "api_key"],
	createSmtpCredentialsFn: ["smtp.created", "smtp"],
	deleteSmtpCredentialsFn: ["smtp.deleted", "smtp"],
	createWebhookFn: ["webhook.created", "webhook"],
	updateWebhookFn: ["webhook.updated", "webhook"],
	deleteWebhookFn: ["webhook.deleted", "webhook"],
	addSuppressionFn: ["suppression.added", "recipient"],
	removeSuppressionFn: ["suppression.removed", "recipient"],
	resubscribeFn: ["unsubscribe.removed", "recipient"],
	updateFirewallFn: ["firewall.updated", "brand"],
	saveContactFn: ["contact.edited", "contact"],
	deleteContactFn: ["contact.deleted", "contact"],
	importContactsFn: ["contacts.imported", "contacts"],
	cleanUpFn: ["contacts.cleaned_up", "contacts"],
	saveSegmentFn: ["segment.saved", "segment"],
	deleteSegmentFn: ["segment.deleted", "segment"],
	saveTopicFn: ["topic.saved", "topic"],
	deleteTopicFn: ["topic.deleted", "topic"],
	createAutomationFn: ["automation.created", "automation"],
	saveAutomationFn: ["automation.edited", "automation"],
	deleteAutomationFn: ["automation.deleted", "automation"],
	createBrandFn: ["brand.created", "brand"],
	updateBrandFn: ["brand.updated", "brand"],
	removeBrandFn: ["brand.removed", "brand"],
	saveNewsletterFn: ["newsletter.edited", "newsletter"],
	deleteNewsletterFn: ["newsletter.deleted", "newsletter"],
	saveArticleFn: ["article.edited", "article"],
	deleteArticleFn: ["article.deleted", "article"],
	saveHelpCenterFn: ["help_center.edited", "help_center"],
	saveCampaignFn: ["campaign.edited", "campaign"],
	deleteCampaignFn: ["campaign.deleted", "campaign"],
	saveFormFn: ["form.edited", "form"],
	deleteFormFn: ["form.deleted", "form"],
	saveRuleFn: ["inbound_rule.saved", "inbound_rule"],
	deleteRuleFn: ["inbound_rule.deleted", "inbound_rule"],
	replyReceivedFn: ["received.replied", "received"],
	sendConversationReplyFn: ["conversation.replied", "conversation"],
	createInboxFn: ["inbox.created", "inbox"],
	updateInboxFn: ["inbox.updated", "inbox"],
	deleteInboxFn: ["inbox.deleted", "inbox"],
	createInboxCredentialFn: ["inbox_credential.created", "inbox"],
	updateInboxCredentialFn: ["inbox_credential.updated", "inbox"],
	rotateInboxCredentialFn: ["inbox_credential.rotated", "inbox"],
	revokeInboxCredentialFn: ["inbox_credential.revoked", "inbox"],
	createInboxWebhookFn: ["webhook.created", "inbox"],
	setArchiveFn: ["settings.archive_changed", "organization"],
	setDigestFn: ["settings.digest_changed", "organization"],
	setMarketingRulesFn: ["settings.marketing_rules_changed", "organization"],
	saveSectionFn: ["section.saved", "section"],
	deleteSectionFn: ["section.deleted", "section"],
	saveKitFn: ["brand_kit.edited", "brand"],
	saveSubscriberPageFn: ["unsubscribe_page.edited", "brand"],
	resetSubscriberPageFn: ["unsubscribe_page.reset", "brand"],
};

/** What a call is about, from its input: an id and a name people read. */
function subjectOf(data: unknown) {
	const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
	const inner = (d.fields && typeof d.fields === "object" ? d.fields : {}) as Record<
		string,
		unknown
	>;
	const pick = (...keys: string[]) => {
		for (const k of keys) {
			const v = d[k] ?? inner[k];
			if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
		}
		return null;
	};
	return {
		id: pick("id", "brand", "domain"),
		name: pick("name", "email", "address", "url", "domain", "subject", "title"),
	};
}

function makeCan(p: Permission) {
	return createMiddleware({ type: "function" })
		.middleware([orgMiddleware])
		.server(async ({ next, context, data, serverFnMeta }) => {
			if (!context.access.can(p))
				throw forbidden(`${NO_PERMISSION_MESSAGE} (${PERMISSION_LABEL[p].toLowerCase()})`);
			const result = await next();
			const logged = LOGGED[serverFnMeta?.name ?? ""];
			if (logged) {
				const s = subjectOf(data);
				await logActivity({
					organizationId: context.organizationId,
					userId: context.userId,
					action: logged[0],
					subject: { type: logged[1], id: s.id, name: s.name },
				});
			}
			return result;
		});
}

/** orgMiddleware, for members who have permission `p`. */
export function can(p: Permission) {
	let m = middlewares.get(p);
	if (!m) {
		m = makeCan(p);
		middlewares.set(p, m);
	}
	return m;
}

/** The deployment's admins (ADMIN_EMAILS): AWS setup and the account-wide view. */
export const adminMiddleware = createMiddleware()
	.middleware([sessionMiddleware])
	.server(async ({ next, context }) => {
		if (!context.isAdmin) throw forbidden("Only this deployment's admins can do this");
		return next();
	});
