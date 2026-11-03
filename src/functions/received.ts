import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { maskDigits } from "@/lib/roles";
import { brandIn, viewScope } from "@/server/brands";
import { db, schema } from "@/server/db";
import { kickDispatcher, rateGate } from "@/server/dispatcher";
import { ApiError } from "@/server/errors";
import {
	attachmentsView,
	getReceived,
	inboundAddresses,
	listReceived,
	parsedMessage,
	receivedView,
	receivingStatus,
	setInboundAddress,
	setUpReceiving,
} from "@/server/inbound";
import {
	createRule,
	deleteRule,
	getRule,
	listRules,
	ruleView,
	updateRule,
} from "@/server/inbound-rules";
import { adminMiddleware, can, orgMiddleware } from "@/server/middleware";
import { brandForSend, createEmails, parseSend } from "@/server/send";
import { testReport } from "@/server/test-report";
import { call } from "./call";

/** The Received pages: what the brands received, and turning receiving on. */

const textOnly = (html: string) =>
	html.replace(/>([^<]+)</g, (_, t: string) => `>${maskDigits(t)}<`);

export const listReceivedFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(
		z.object({
			search: z.string().max(200).nullish(),
			brand: z.string().nullish(),
			after: z.string().nullish(),
		}),
	)
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId, data.brand);
		const own = typeof scope === "string" ? scope : context.organizationId;
		const [page, addresses] = await Promise.all([
			listReceived(scope, { search: data.search, after: data.after, limit: 50 }),
			inboundAddresses(own),
		]);
		const address = addresses.own ?? addresses.fallback;
		const dots = context.masked;
		return {
			has_more: page.has_more,
			data: page.data.map((r) => ({
				id: r.id,
				brand_id: r.organization_id,
				from: r.from,
				to: r.to,
				subject: dots ? maskDigits(r.subject) : r.subject,
				attachments: r.attachments?.length ?? 0,
				spam: r.spam === "FAIL",
				created_at: r.created_at,
			})),
			brands,
			/** The brand's Mailroom address (the organization's own, without a brand picked). */
			address,
			/** Its own address and the default one, and where it can pick one. */
			addresses,
			/** The brand they're for. */
			addressBrand: own,
		};
	});

/** A brand's own inbound address on one of its receiving domains, or null for the default. */
export const setInboundAddressFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:rules")])
	.validator(z.object({ brand: z.string(), address: z.string().max(254).nullable() }))
	.handler(({ data, context }) =>
		call(async () =>
			setInboundAddress(await brandIn(context.organizationId, data.brand), data.address),
		),
	);

export const getReceivedFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const { scope, brands } = await viewScope(context.organizationId);
		const row = await getReceived(scope, data.id);
		if (!row) throw new Response("Email not found", { status: 404 });
		const [view, attachments, answers] = await Promise.all([
			receivedView(row),
			attachmentsView(row),
			row.answers_email_id
				? db
						.select({ id: schema.emails.id, subject: schema.emails.subject })
						.from(schema.emails)
						.where(eq(schema.emails.id, row.answers_email_id))
						.get()
				: null,
		]);
		const dots = context.masked;
		return {
			email: {
				...view,
				subject: dots ? maskDigits(view.subject) : view.subject,
				html: dots && view.html ? textOnly(view.html) : view.html,
				text: dots && view.text ? maskDigits(view.text) : view.text,
			},
			attachments,
			answers: answers ?? null,
			brand: brands.find((b) => b.id === row.organization_id) ?? null,
		};
	});

/** An answer from the dashboard, in the same thread (In-Reply-To and References). */
export const replyReceivedFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:reply")])
	.validator(
		z.object({
			id: z.string(),
			from: z.string(),
			to: z.string(),
			cc: z.string().optional(),
			subject: z.string(),
			text: z.string().min(1).max(100_000),
		}),
	)
	.handler(({ data, context }) =>
		call(async () => {
			const { scope } = await viewScope(context.organizationId);
			const row = await getReceived(scope, data.id);
			if (!row) throw new Response("Email not found", { status: 404 });
			const list = (v?: string) =>
				(v ?? "")
					.split(/[,;]+/)
					.map((a) => a.trim())
					.filter(Boolean);
			const parent = row.message_id ? `<${row.message_id.replace(/^<|>$/g, "")}>` : null;
			const escaped = data.text
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;");
			const quoted = `On ${new Date(row.created_at).toUTCString()}, ${row.from} wrote: "${row.subject}"`;
			const input = parseSend({
				brand: row.organization_id,
				from: data.from,
				to: list(data.to),
				...(list(data.cc).length ? { cc: list(data.cc) } : {}),
				subject: data.subject,
				text: `${data.text}\n\n${quoted}`,
				html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${escaped}</div>`,
				...(parent ? { headers: { "In-Reply-To": parent, References: parent } } : {}),
				tags: [{ name: "reply_to_received", value: row.id }],
			});
			const brand = await brandForSend(context.organizationId, [input]);
			const [r] = await createEmails(brand, [input], {
				source: "dashboard",
				kick: kickDispatcher,
				gate: rateGate,
			});
			if (r?.error) throw r.error;
			return { id: r?.id ?? null };
		}),
	);

export const receivingStatusFn = createServerFn({ method: "GET" })
	.middleware([adminMiddleware])
	.handler(() => receivingStatus());

export const setUpReceivingFn = createServerFn({ method: "POST" })
	.middleware([adminMiddleware])
	.validator(z.object({}).optional())
	.handler(async () => {
		try {
			return await setUpReceiving();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Response(message, { status: error instanceof ApiError ? error.status : 502 });
		}
	});

export const listRulesFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.handler(async ({ context }) => {
		const { brands } = await viewScope(context.organizationId);
		const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
		return { brands, rules: (await listRules(ids)).map(ruleView) };
	});

const ruleFields = z.object({
	brand: z.string().nullish(),
	name: z.string(),
	match_to: z.string(),
	match_from: z.string().nullable(),
	match_subject: z.string().nullable(),
	action: z.enum(["forward", "drop"]),
	forward_to: z.string().nullable(),
	continue: z.boolean(),
	enabled: z.boolean(),
});

export const saveRuleFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:rules")])
	.validator(z.object({ id: z.string().optional(), fields: ruleFields }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brand: named, ...f } = data.fields;
			const fields = { ...f, match_to: f.match_to.trim() || "*" };
			if (data.id) {
				const { brands } = await viewScope(context.organizationId);
				const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
				const x = await getRule(ids, data.id);
				return ruleView(await updateRule(x.organization_id, x.id, fields));
			}
			const brand = named
				? await brandIn(context.organizationId, named)
				: context.organizationId;
			return ruleView(await createRule(brand, fields));
		}),
	);

export const deleteRuleFn = createServerFn({ method: "POST" })
	.middleware([can("inbox:rules")])
	.validator(z.object({ id: z.string() }))
	.handler(({ data, context }) =>
		call(async () => {
			const { brands } = await viewScope(context.organizationId);
			const ids = brands.length ? brands.map((b) => b.id) : [context.organizationId];
			const x = await getRule(ids, data.id);
			await deleteRule(x.organization_id, x.id);
			return { ok: true };
		}),
	);

/** A received email's deliverability report (src/server/test-report.ts), when its tab opens. */
export const receivedReportFn = createServerFn({ method: "GET" })
	.middleware([orgMiddleware])
	.validator(z.object({ id: z.string() }))
	.handler(async ({ data, context }) => {
		const { scope } = await viewScope(context.organizationId);
		const row = await getReceived(scope, data.id);
		if (!row) throw new Response("Email not found", { status: 404 });
		const parsed = await parsedMessage(row).catch(() => null);
		return testReport({
			from: row.from,
			subject: row.subject,
			verdicts: {
				spam: row.spam,
				virus: row.virus,
				spf: row.spf,
				dkim: row.dkim,
				dmarc: row.dmarc,
			},
			parsed,
		});
	});
