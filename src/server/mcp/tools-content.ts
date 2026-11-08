import { z } from "zod";
import { fill, htmlToText } from "../../lib/template-fill";
import {
	automationView,
	cancelRun,
	deleteAutomation,
	duplicateAutomation,
	getAutomation,
} from "../automations";
import {
	broadcastView,
	deleteBroadcast,
	duplicateBroadcast,
	getBroadcast,
	resendBroadcast,
} from "../broadcasts";
import { kickDispatcher, rateGate } from "../dispatcher";
import { baseUrl } from "../env";
import { votersToSegment } from "../polls";
import { brandForSend, createEmails, parseSend } from "../send";
import { applyTemplate, duplicateTemplate, getTemplate, templateView } from "../templates";
import { addressList, brandsOf, logged, orgAt, organization, type Tool } from "./kit";

/** Broadcasts, templates and automations beyond create-edit-send. */

/** A broadcast without its (long) content. */
const brief = (x: Parameters<typeof broadcastView>[0]) => {
	const { html: _h, text: _t, design: _d, ...v } = broadcastView(x) as Record<string, unknown>;
	return v;
};

export const CONTENT_TOOLS: Tool[] = [
	// ── Broadcasts ──
	{
		name: "delete_broadcast",
		title: "Delete a broadcast",
		description: "Deletes a draft or scheduled broadcast (a sent one stays for its report).",
		input: { organization, broadcast: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const x = await getBroadcast(await brandsOf(org.id), a.broadcast as string);
			await deleteBroadcast(x.organization_id, x.id);
			await logged(ctx, org, "broadcast.deleted", {
				type: "broadcast",
				id: x.id,
				name: x.name || x.subject,
			});
			return { deleted: x.id };
		},
	},
	{
		name: "duplicate_broadcast",
		title: "Duplicate a broadcast",
		description: "A new draft with the same content, audience and settings as a broadcast.",
		input: { organization, broadcast: z.string() },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const x = await duplicateBroadcast(
				await brandsOf(org.id),
				a.broadcast as string,
				Date.now(),
				ctx.userId,
			);
			await logged(ctx, org, "broadcast.created", {
				type: "broadcast",
				id: x.id,
				name: x.name,
			});
			return brief(x);
		},
	},
	{
		name: "resend_broadcast",
		title: "Resend to those who didn't open",
		description:
			"Makes a new draft of a sent broadcast for the contacts who didn't open it, with another subject. Send it with send_broadcast (get_broadcast shows how many didn't open).",
		input: { organization, broadcast: z.string(), subject: z.string().min(1).max(998) },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:send");
			const x = await getBroadcast(await brandsOf(org.id), a.broadcast as string);
			const row = await resendBroadcast(x.organization_id, x.id, {
				subject: a.subject as string,
			});
			await logged(
				ctx,
				org,
				"broadcast.created",
				{ type: "broadcast", id: row.id, name: row.name },
				{
					resend_of: x.id,
				},
			);
			return brief(row);
		},
	},
	{
		name: "send_broadcast_test",
		title: "Send a test of a broadcast",
		description:
			"Sends the saved broadcast to test addresses (up to 50), subject prefixed [Test], with sample contact values.",
		input: {
			organization,
			broadcast: z.string(),
			to: z.array(z.string()).min(1).max(50),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const x = await getBroadcast(await brandsOf(org.id), a.broadcast as string);
			const to = addressList(a.to);
			const values = {
				FIRST_NAME: "",
				LAST_NAME: "",
				EMAIL: to[0] ?? "",
				WEB_VERSION_URL: `${baseUrl()}/view/${x.id}`,
				REFERRAL_URL: "#referral-link",
				REFERRAL_PAGE_URL: "#referral-page",
				REFERRAL_COUNT: 0,
				POLL_URL: `${baseUrl()}/poll/web/${x.id}`,
				SURVEY_URL: `${baseUrl()}/s/web`,
			};
			const html = x.html ? fill(x.html, values) : undefined;
			const input = parseSend({
				brand: x.organization_id,
				from: x.from,
				to,
				subject: `[Test] ${fill(x.subject, values)}`,
				reply_to: x.reply_to ?? undefined,
				html,
				text: x.text ? fill(x.text, values) : html ? htmlToText(html) : undefined,
			});
			const [r] = await createEmails(await brandForSend(org.id, [input]), [input], {
				source: "mcp",
				kick: kickDispatcher,
				gate: rateGate,
			});
			if (r?.error) throw r.error;
			return { id: r?.id ?? null, to };
		},
	},
	{
		name: "check_broadcast_links",
		title: "Check a broadcast's links",
		description:
			"Opens every web link in the saved broadcast and reports which are broken or redirect (the pre-send checklist's link check).",
		input: { organization, broadcast: z.string() },
		readOnly: true,
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization);
			const x = await getBroadcast(await brandsOf(org.id), a.broadcast as string);
			const { checkLinks } = await import("../link-check");
			return checkLinks(x.html);
		},
	},
	{
		name: "poll_answers_to_segment",
		title: "Put poll voters in a segment",
		description:
			"Adds the contacts who answered a sent broadcast's poll (one answer by its index, or any with answer null) to a segment. get_broadcast lists its polls and results.",
		input: {
			organization,
			broadcast: z.string(),
			poll: z.string().describe("The poll block's id"),
			answer: z.number().int().nullable(),
			segment_id: z.string(),
		},
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "broadcasts:edit");
			const x = await getBroadcast(await brandsOf(org.id), a.broadcast as string);
			return votersToSegment(
				x.organization_id,
				x.id,
				a.poll as string,
				a.answer as number | null,
				a.segment_id as string,
			);
		},
	},

	// ── Templates ──
	{
		name: "duplicate_template",
		title: "Duplicate a template",
		description: "A new template with a copy of one's draft (not published).",
		input: { organization, template: z.string().describe("Its id or alias") },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "templates:edit");
			const t = await duplicateTemplate(org.id, a.template as string);
			await logged(ctx, org, "template.created", {
				type: "template",
				id: t.id,
				name: t.name,
			});
			const { html: _h, text: _t, ...v } = templateView(t) as Record<string, unknown>;
			return v;
		},
	},
	{
		name: "send_template_test",
		title: "Send a test of a template",
		description:
			"Sends the published template to test addresses with the variables given (missing ones use their fallbacks). from: needed when the template has none.",
		input: {
			organization,
			template: z.string().describe("Its id or alias"),
			to: z.array(z.string()).min(1).max(50),
			from: z.string().optional(),
			variables: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
		},
		openWorld: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "templates:edit");
			await getTemplate(org.id, a.template as string);
			const input = parseSend(
				await applyTemplate(org.id, {
					to: addressList(a.to),
					...(typeof a.from === "string" && a.from.trim() ? { from: a.from.trim() } : {}),
					template: { id: a.template, variables: a.variables ?? {} },
				}),
			);
			const [r] = await createEmails(await brandForSend(org.id, [input]), [input], {
				source: "mcp",
				kick: kickDispatcher,
				gate: rateGate,
			});
			if (r?.error) throw r.error;
			return { id: r?.id ?? null };
		},
	},

	// ── Automations ──
	{
		name: "delete_automation",
		title: "Delete an automation",
		description: "Deletes an automation; its runs in progress stop.",
		input: { organization, automation: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "automations:edit");
			const x = await getAutomation(await brandsOf(org.id), a.automation as string);
			await deleteAutomation(x.organization_id, x.id);
			await logged(ctx, org, "automation.deleted", {
				type: "automation",
				id: x.id,
				name: x.name,
			});
			return { deleted: x.id };
		},
	},
	{
		name: "duplicate_automation",
		title: "Duplicate an automation",
		description: "A new automation (a draft) with the same trigger and steps.",
		input: { organization, automation: z.string() },
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "automations:edit");
			const x = await duplicateAutomation(await brandsOf(org.id), a.automation as string);
			await logged(ctx, org, "automation.created", {
				type: "automation",
				id: x.id,
				name: x.name,
			});
			return automationView(x);
		},
	},
	{
		name: "cancel_automation_run",
		title: "Stop an automation run",
		description:
			"Stops one contact's run of an automation (get_automation lists the runs with their ids).",
		input: { organization, automation: z.string(), run: z.string() },
		destructive: true,
		run: async (a, ctx) => {
			const org = orgAt(ctx, a.organization, "automations:activate");
			const x = await getAutomation(await brandsOf(org.id), a.automation as string);
			await cancelRun(x.organization_id, a.run as string);
			return { canceled: a.run };
		},
	},
];
