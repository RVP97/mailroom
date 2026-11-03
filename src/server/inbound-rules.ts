import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Email } from "postal-mime";
import { z } from "zod";
import { bareAddress } from "./aws/mime";
import { db, schema } from "./db";
import { notFound, validation } from "./errors";
import { orgContext } from "./org";
import { createEmails, parseSend } from "./send";
import { iso } from "./time";

/**
 * Inbound rules: what a brand does with what it receives, before it's kept. The first rule that
 * matches decides (or each, while they say `continue`): forward a copy to other addresses (sent
 * from the address it came to, when that domain sends, with Reply-To the sender), or drop it
 * (neither kept nor sent to webhooks). Forwards carry X-Mailroom-Forwarded and a message with it
 * isn't forwarded again, so two brands forwarding to each other don't loop.
 */

export type InboundRule = typeof schema.inboundRules.$inferSelect;
const t = schema.inboundRules;

/** Attachments forwarded up to this size in all (larger ones are named in the text). */
const FORWARD_ATTACHMENTS_MAX = 1_000_000;

const pattern = z
	.string()
	.trim()
	.toLowerCase()
	.max(320)
	.regex(/^(\*|[^\s@*]+)@(\*|[^\s@*]+)$|^\*$/, "to: an address, *@domain, name@* or *");

export const ruleInput = z.object({
	name: z.string().trim().min(1).max(200),
	match_to: pattern.optional(),
	match_from: z.string().trim().max(320).nullish(),
	match_subject: z.string().trim().max(200).nullish(),
	action: z.enum(["forward", "drop"]),
	forward_to: z
		.union([z.string(), z.array(z.string())])
		.transform((v) =>
			(Array.isArray(v) ? v : v.split(/[,;\s]+/)).map((a) => a.trim()).filter(Boolean),
		)
		.nullish(),
	continue: z.boolean().optional(),
	enabled: z.boolean().optional(),
	position: z.number().int().min(0).max(10_000).optional(),
});

export const ruleView = (r: InboundRule) => ({
	object: "inbound_rule",
	id: r.id,
	brand_id: r.organization_id,
	name: r.name,
	match_to: r.match_to,
	match_from: r.match_from,
	match_subject: r.match_subject,
	action: r.action,
	forward_to: r.forward_to ?? [],
	continue: r.continue,
	enabled: r.enabled,
	position: r.position,
	created_at: r.created_at,
	updated_at: r.updated_at,
});

function checkForward(action: string, to: string[] | null | undefined) {
	if (action !== "forward") return null;
	if (!to?.length) throw validation("forward_to: give the addresses to forward to");
	if (to.length > 10) throw validation("forward_to: up to 10 addresses");
	for (const a of to)
		if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(bareAddress(a)))
			throw validation(`forward_to: ${a} isn't an email address`);
	return to;
}

export async function listRules(brands: string[]) {
	return db
		.select()
		.from(t)
		.where(inArray(t.organization_id, brands))
		.orderBy(asc(t.position), asc(t.created_at));
}

export async function getRule(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const row = await db
		.select()
		.from(t)
		.where(and(eq(t.id, id), inArray(t.organization_id, list)))
		.get();
	if (!row) throw notFound("Rule");
	return row;
}

export async function createRule(brand: string, raw: unknown, now = Date.now()) {
	const v = ruleInput.parse(raw);
	const forward = checkForward(v.action, v.forward_to);
	const last = await db
		.select({ n: sql<number>`COALESCE(MAX(${t.position}), -1)` })
		.from(t)
		.where(eq(t.organization_id, brand))
		.get();
	const [row] = await db
		.insert(t)
		.values({
			id: crypto.randomUUID(),
			organization_id: brand,
			name: v.name,
			match_to: v.match_to ?? "*",
			match_from: v.match_from || null,
			match_subject: v.match_subject || null,
			action: v.action,
			forward_to: forward,
			continue: v.continue ?? false,
			enabled: v.enabled ?? true,
			position: v.position ?? Number(last?.n ?? -1) + 1,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as InboundRule;
}

export async function updateRule(brand: string, id: string, raw: unknown, now = Date.now()) {
	const x = await getRule(brand, id);
	const v = ruleInput.partial().parse(raw ?? {});
	const action = v.action ?? x.action;
	const forward = checkForward(action, v.forward_to ?? x.forward_to);
	const [row] = await db
		.update(t)
		.set({
			name: v.name ?? x.name,
			match_to: v.match_to ?? x.match_to,
			match_from: v.match_from !== undefined ? v.match_from || null : x.match_from,
			match_subject:
				v.match_subject !== undefined ? v.match_subject || null : x.match_subject,
			action,
			forward_to: forward,
			continue: v.continue ?? x.continue,
			enabled: v.enabled ?? x.enabled,
			position: v.position ?? x.position,
			updated_at: iso(now),
		})
		.where(eq(t.id, id))
		.returning();
	return row as InboundRule;
}

export async function deleteRule(brand: string, id: string) {
	const x = await getRule(brand, id);
	await db.delete(t).where(eq(t.id, id));
	return x;
}

const glob = (p: string, v: string) => p === "*" || p === v;

/** Whether a rule takes an email that came to `to`. */
export function matches(
	r: Pick<InboundRule, "match_to" | "match_from" | "match_subject" | "enabled">,
	m: { to: string; from: string; subject: string },
) {
	if (!r.enabled) return false;
	const to = m.to.toLowerCase();
	if (r.match_to !== "*") {
		const [pl, pd] = r.match_to.split("@") as [string, string];
		const at = to.lastIndexOf("@");
		const local = to.slice(0, at).replace(/\+.*$/, "");
		if (!glob(pd, to.slice(at + 1)) || !(glob(pl, local) || glob(pl, to.slice(0, at))))
			return false;
	}
	if (r.match_from && !m.from.toLowerCase().includes(r.match_from.toLowerCase())) return false;
	if (r.match_subject && !m.subject.toLowerCase().includes(r.match_subject.toLowerCase()))
		return false;
	return true;
}

export interface Incoming {
	brandId: string;
	recipients: string[];
	from: string;
	subject: string;
	replyTo: string[] | null;
	parsed: Email | null;
}

/** The rules that apply to an email, in order (stopping at one that doesn't continue). */
export async function rulesFor(m: Incoming) {
	const rules = await db
		.select()
		.from(t)
		.where(and(eq(t.organization_id, m.brandId), eq(t.enabled, true)))
		.orderBy(asc(t.position), asc(t.created_at));
	const out: { rule: InboundRule; to: string }[] = [];
	for (const rule of rules) {
		const to = m.recipients.find((x) =>
			matches(rule, { to: x, from: m.from, subject: m.subject }),
		);
		if (!to) continue;
		out.push({ rule, to });
		if (!rule.continue) break;
	}
	return out;
}

const headerOf = (parsed: Email | null, name: string) =>
	(parsed?.headers as { key: string; value: string }[] | undefined)?.find(
		(h) => h.key.toLowerCase() === name,
	)?.value;

/** A copy to the rule's addresses; what happened, in words. */
export async function forward(m: Incoming, rule: InboundRule, to: string, receivedId: string) {
	if (headerOf(m.parsed, "x-mailroom-forwarded"))
		return "Not forwarded: it was already forwarded once";
	const ctx = await orgContext(m.brandId);
	const domain = to.split("@")[1]?.toLowerCase();
	const own = ctx.domains.find((d) => d.verified && d.name === domain);
	const fallback = ctx.domains.find((d) => d.verified && !d.paused);
	if (!ctx.ready || !(own ?? fallback))
		return "Not forwarded: this brand has no verified sending domain";
	const fromAddress = own ? to : `forwarding@${fallback?.name}`;
	const name = (/^\s*"?([^"<]+?)"?\s*</.exec(m.from)?.[1] ?? bareAddress(m.from))
		.replace(/["\\]/g, "")
		.slice(0, 80);
	let size = 0;
	const attachments = [];
	const skipped: string[] = [];
	for (const a of m.parsed?.attachments ?? []) {
		const bytes =
			typeof a.content === "string"
				? new TextEncoder().encode(a.content)
				: new Uint8Array(a.content);
		if (size + bytes.byteLength > FORWARD_ATTACHMENTS_MAX) {
			skipped.push(a.filename ?? "attachment");
			continue;
		}
		size += bytes.byteLength;
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000)
			bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		attachments.push({
			filename: a.filename || "attachment",
			content: btoa(bin),
			content_type: a.mimeType,
			...(a.contentId ? { content_id: a.contentId } : {}),
		});
	}
	const note = skipped.length
		? `\n\n[Too large to forward: ${skipped.join(", ")}. See it in Mailroom › Received.]`
		: "";
	const text = `${m.parsed?.text ?? ""}${note}`;
	const input = parseSend({
		from: `"${name} via Mailroom" <${fromAddress}>`,
		to: rule.forward_to ?? [],
		reply_to: m.replyTo?.length ? m.replyTo : [m.from],
		subject: m.subject || "(no subject)",
		...(m.parsed?.html ? { html: m.parsed.html } : {}),
		text: text.trim() ? text : "(no text)",
		...(attachments.length ? { attachments } : {}),
		headers: { "X-Mailroom-Forwarded": receivedId },
		tags: [{ name: "forwarded", value: receivedId }],
	});
	const { kickDispatcher } = await import("./dispatcher");
	const [r] = await createEmails(m.brandId, [input], {
		source: "system",
		queue: true,
		kick: kickDispatcher,
		onlyDomainId: null,
	});
	if (r?.error) return `Not forwarded: ${r.error.message}`;
	return `Forwarded to ${(rule.forward_to ?? []).join(", ")}`;
}

/** Our email an incoming one answers: its In-Reply-To or References name our Message-ID. */
export async function answers(brandId: string, parsed: Email | null) {
	const ids = [parsed?.inReplyTo, parsed?.references]
		.filter(Boolean)
		.join(" ")
		.match(/<([^<>@\s]+)@[^<>\s]*amazonses\.com>/g);
	const locals = [...new Set((ids ?? []).map((x) => x.slice(1, x.indexOf("@"))))].slice(0, 20);
	if (!locals.length) return null;
	const row = await db
		.select({ id: schema.emails.id })
		.from(schema.emails)
		.where(
			and(
				eq(schema.emails.organization_id, brandId),
				inArray(schema.emails.message_id, locals),
			),
		)
		.get();
	return row?.id ?? null;
}
