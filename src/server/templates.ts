import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { type EmailDoc, parseDoc, renderEmail } from "../lib/email-doc";
import { fill, htmlToText } from "../lib/template-fill";
import { bareAddress } from "./aws/mime";
import { db, schema } from "./db";
import type { TemplateContent, TemplateVariable } from "./db/schema";
import { ApiError, notFound, validation } from "./errors";
import { iso } from "./time";
import { PLACEHOLDERS } from "./unsubscribes";

/**
 * Email templates, Resend's way: HTML (and text) with {{{VARIABLES}}}, a default From, subject
 * and Reply-To, and up to 50 declared variables, each with a type and an optional fallback. Edits
 * change the draft; `publish` copies it to what sends use, so a template can be reworked without
 * touching the emails going out. A send names it by id or alias:
 *
 *   POST /emails { "to": "…", "template": { "id": "welcome", "variables": { "NAME": "Ana" } } }
 *
 * and may still set from, subject and reply_to (the template's are defaults). Templates belong
 * to the organization: every brand can send them.
 */

export const MAX_VARIABLES = 50;

/**
 * Names filled from the contact in broadcasts and automations (FIRST_NAME, LAST_NAME, EMAIL) and
 * by Mailroom itself (UNSUBSCRIBE_URL): a template can use them without declaring them.
 */
export const RESERVED = ["FIRST_NAME", "LAST_NAME", "EMAIL", "UNSUBSCRIBE_URL", "contact", "this"];

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const variable = z
	.object({
		key: z
			.string()
			.regex(KEY, "variable keys take letters, numbers and _ (PRODUCT_NAME)")
			.refine((k) => !RESERVED.includes(k), "is a reserved name"),
		type: z.enum(["string", "number"]).default("string"),
		fallback_value: z.union([z.string().max(2000), z.number()]).nullish(),
		fallbackValue: z.union([z.string().max(2000), z.number()]).nullish(),
	})
	.transform(({ fallbackValue, fallback_value, ...v }, ctx) => {
		const fallback = fallback_value ?? fallbackValue ?? null;
		if (fallback !== null && v.type === "number" && !Number.isFinite(Number(fallback))) {
			ctx.addIssue({ code: "custom", message: "the fallback of a number must be a number" });
			return z.NEVER;
		}
		return {
			...v,
			...(fallback !== null
				? { fallback_value: v.type === "number" ? Number(fallback) : String(fallback) }
				: {}),
		} as TemplateVariable;
	});

const addresses = z
	.union([z.string().max(320), z.array(z.string().max(320)).max(50)])
	.transform((v) => (Array.isArray(v) ? v : [v]));

export const templateInput = z.object({
	name: z.string().trim().min(1).max(120),
	alias: z
		.string()
		.trim()
		.toLowerCase()
		.regex(ALIAS, "an alias takes lowercase letters, numbers, _ and - (welcome-email)")
		.nullish(),
	from: z.string().trim().max(320).nullish(),
	subject: z.string().max(998).nullish(),
	reply_to: addresses.nullish(),
	replyTo: addresses.nullish(),
	html: z.string().max(512_000),
	text: z.string().max(512_000).nullish(),
	variables: z.array(variable).max(MAX_VARIABLES).optional(),
	/** Blocks from the visual editor (src/lib/email-doc.ts): html is made from them. */
	design: z.unknown().nullish(),
});
type Input = z.input<typeof templateInput>;

/** Declared variables must be unique, and the ones used in the content should be declared. */
function checkVariables(variables: TemplateVariable[]) {
	const seen = new Set<string>();
	for (const v of variables) {
		if (seen.has(v.key)) throw validation(`The variable ${v.key} is declared twice`);
		seen.add(v.key);
	}
}

function contentOf(v: z.output<typeof templateInput>, base?: TemplateContent): TemplateContent {
	const variables = v.variables ?? base?.variables ?? [];
	checkVariables(variables);
	let html = v.html;
	let design = base?.design ?? null;
	if (v.design !== undefined) {
		design = v.design === null ? null : parseDoc(v.design);
		if (v.design !== null && !design) throw validation("design: not a design from the editor");
		if (design) html = renderEmail(design);
	} else if (!base || v.html !== base.html) design = null;
	return {
		from: v.from === undefined ? (base?.from ?? null) : v.from || null,
		subject: v.subject === undefined ? (base?.subject ?? null) : v.subject || null,
		reply_to:
			v.reply_to !== undefined || v.replyTo !== undefined
				? (v.reply_to ?? v.replyTo)?.length
					? (v.reply_to ?? v.replyTo ?? null)
					: null
				: (base?.reply_to ?? null),
		html,
		text: v.text === undefined ? (base?.text ?? null) : (v.text ?? null),
		variables,
		...(design ? { design } : {}),
	};
}

export type TemplateRow = typeof schema.templates.$inferSelect;

/** A template as the API shows it (Resend's fields, the draft's content). */
export function templateView(t: TemplateRow) {
	const changed = !!t.published && JSON.stringify(t.published) !== JSON.stringify(t.draft);
	return {
		object: "template",
		id: t.id,
		name: t.name,
		alias: t.alias,
		status: t.published ? "published" : "draft",
		/** The draft differs from what sends use: publish to send it. */
		has_unpublished_changes: changed,
		published_at: t.published_at,
		from: t.draft.from,
		subject: t.draft.subject,
		reply_to: t.draft.reply_to,
		html: t.draft.html,
		text: t.draft.text,
		variables: t.draft.variables,
		design: t.draft.design ?? null,
		created_at: t.created_at,
		updated_at: t.updated_at,
	};
}

const tt = schema.templates;

/**
 * A design with a template's own variables filled in (as its HTML is when a broadcast is made
 * from it); values go in as JSON text so the design stays whole.
 */
export function designFilled(design: EmailDoc, values: Record<string, unknown>) {
	const json = fill(
		JSON.stringify(design),
		Object.fromEntries(
			Object.entries(values).map(([k, v]) => [
				k,
				v === null || v === undefined ? v : JSON.stringify(String(v)).slice(1, -1),
			]),
		) as Record<string, string | null | undefined>,
	);
	try {
		return parseDoc(JSON.parse(json));
	} catch {
		return null;
	}
}

/** A template by id or alias, of the organization. */
export async function getTemplate(organizationId: string, ref: string): Promise<TemplateRow> {
	const r = ref.trim();
	const row = await db
		.select()
		.from(tt)
		.where(
			and(
				eq(tt.organization_id, organizationId),
				or(eq(tt.id, r), eq(tt.alias, r.toLowerCase())),
			),
		)
		.get();
	if (!row) throw notFound("Template");
	return row;
}

export async function listTemplates(organizationId: string) {
	return db
		.select()
		.from(tt)
		.where(eq(tt.organization_id, organizationId))
		.orderBy(desc(tt.updated_at));
}

async function aliasFree(organizationId: string, alias: string | null | undefined, id?: string) {
	if (!alias) return;
	const other = await db
		.select({ id: tt.id })
		.from(tt)
		.where(and(eq(tt.organization_id, organizationId), eq(tt.alias, alias)))
		.get();
	if (other && other.id !== id)
		throw new ApiError(409, "alias_taken", `Another template is already called ${alias}`);
}

export async function createTemplate(
	organizationId: string,
	raw: unknown,
	o: { publish?: boolean; now?: number } = {},
) {
	const v = templateInput.parse(raw);
	await aliasFree(organizationId, v.alias);
	const now = iso(o.now);
	const draft = contentOf(v);
	const row: TemplateRow = {
		id: crypto.randomUUID(),
		organization_id: organizationId,
		name: v.name,
		alias: v.alias ?? null,
		draft,
		published: o.publish ? draft : null,
		published_at: o.publish ? now : null,
		created_at: now,
		updated_at: now,
	};
	await db.insert(tt).values(row);
	return row;
}

/** Changes the draft (and the name or alias, which apply at once). */
export async function updateTemplate(
	organizationId: string,
	ref: string,
	raw: unknown,
	o: { now?: number } = {},
) {
	const t = await getTemplate(organizationId, ref);
	const v = templateInput.partial().parse(raw ?? {}) as Partial<z.output<typeof templateInput>>;
	if (v.alias !== undefined) await aliasFree(organizationId, v.alias, t.id);
	const draft = contentOf(
		{ ...v, name: v.name ?? t.name, html: v.html ?? t.draft.html },
		t.draft,
	);
	const [row] = await db
		.update(tt)
		.set({
			name: v.name ?? t.name,
			alias: v.alias === undefined ? t.alias : (v.alias ?? null),
			draft,
			updated_at: iso(o.now),
		})
		.where(eq(tt.id, t.id))
		.returning();
	return row as TemplateRow;
}

/** What the draft says becomes what sends use. */
export async function publishTemplate(organizationId: string, ref: string, now = Date.now()) {
	const t = await getTemplate(organizationId, ref);
	const [row] = await db
		.update(tt)
		.set({ published: t.draft, published_at: iso(now), updated_at: iso(now) })
		.where(eq(tt.id, t.id))
		.returning();
	return row as TemplateRow;
}

/** A copy, as a draft («Name (copy)», no alias). */
export async function duplicateTemplate(organizationId: string, ref: string) {
	const t = await getTemplate(organizationId, ref);
	return createTemplate(organizationId, {
		...t.draft,
		name: `${t.name} (copy)`.slice(0, 120),
	} satisfies Input);
}

export async function deleteTemplate(organizationId: string, ref: string) {
	const t = await getTemplate(organizationId, ref);
	await db.delete(tt).where(eq(tt.id, t.id));
	return t;
}

// ── Rendering (fill and htmlToText: src/lib/template-fill.ts) ─────────────────

/**
 * The values a send gives, checked against the template's variables: a declared one left out
 * takes its fallback, or refuses the send without one; a number must be a number.
 */
export function variableValues(
	declared: TemplateVariable[],
	given: Record<string, unknown> = {},
	where = "template.variables",
): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const v of declared) {
		const value = given[v.key];
		if (value === undefined || value === null) {
			if (v.fallback_value === undefined || v.fallback_value === null)
				throw validation(
					`${where}.${v.key} is required (the template gives it no fallback)`,
				);
			out[v.key] = v.fallback_value;
			continue;
		}
		if (v.type === "number") {
			const n = typeof value === "number" ? value : Number(value);
			if (!Number.isFinite(n)) throw validation(`${where}.${v.key} must be a number`);
			out[v.key] = n;
		} else out[v.key] = typeof value === "string" ? value : String(value);
	}
	// Values the template doesn't declare still fill their placeholders (Resend's reserved ones).
	for (const [k, value] of Object.entries(given))
		if (!(k in out) && (typeof value === "string" || typeof value === "number")) out[k] = value;
	return out;
}

/** A template's content with the values in: subject, html and text. */
export function renderContent(
	c: Pick<TemplateContent, "subject" | "html" | "text">,
	values: Record<string, string | number | null | undefined>,
) {
	const html = fill(c.html, values);
	return {
		subject: c.subject === null ? null : fill(c.subject, values),
		html,
		// "" opts out of a text part, as Resend's.
		text: c.text === "" ? undefined : c.text ? fill(c.text, values) : htmlToText(html),
	};
}

export const templateRef = z.object({
	id: z.string().trim().min(1).max(200),
	variables: z.record(z.string(), z.unknown()).optional(),
});

/**
 * A send that names a template becomes a plain one: the published template's content with the
 * variables in, its From, subject and Reply-To unless the send has its own. Anything else goes
 * through as it is. `template_id` tells which template it was.
 */
export async function applyTemplate(
	organizationId: string,
	raw: unknown,
	where = "",
): Promise<unknown> {
	if (!raw || typeof raw !== "object" || !("template" in raw)) return raw;
	const { template, ...send } = raw as Record<string, unknown> & { template: unknown };
	if (template === undefined || template === null) return send;
	const ref = templateRef.safeParse(template);
	if (!ref.success)
		throw validation(
			`${where}template: give { id, variables } (the id or alias of a template)`,
		);
	if (send.html !== undefined || send.text !== undefined || send.react !== undefined)
		throw validation(`${where}template: html and text come from the template; leave them out`);
	const t = await getTemplate(organizationId, ref.data.id).catch(() => {
		throw validation(`${where}template.id: no template ${ref.data.id}`);
	});
	if (!t.published)
		throw validation(`${where}template.id: ${t.name} isn't published yet; publish it first`);
	const p = t.published;
	const values = variableValues(p.variables, ref.data.variables, `${where}template.variables`);
	// The reserved names, for sends that aren't to a contact: the first recipient's address, and
	// no name (so {{{FIRST_NAME|there}}} reads "there").
	const to = Array.isArray(send.to) ? send.to[0] : send.to;
	const r = renderContent(p, {
		FIRST_NAME: "",
		LAST_NAME: "",
		EMAIL: typeof to === "string" ? bareAddress(to) : "",
		...values,
	});
	const subject = (send.subject as string | undefined) ?? r.subject;
	const from = (send.from as string | undefined) ?? p.from;
	if (!from) throw validation(`${where}from is required (the template has no default From)`);
	if (subject === null || subject === undefined)
		throw validation(`${where}subject is required (the template has no default subject)`);
	// A template with an unsubscribe link needs a group for it: the template's own, unless the
	// send names one.
	const wantsLink = PLACEHOLDERS.some((ph) => r.html.includes(ph) || r.text?.includes(ph));
	const group =
		wantsLink && send.unsubscribe_group === undefined && send.unsubscribeGroup === undefined
			? { unsubscribe_group: `template:${t.alias ?? t.id}` }
			: {};
	return {
		...send,
		...group,
		from,
		subject,
		...(send.reply_to === undefined && send.replyTo === undefined && p.reply_to
			? { reply_to: p.reply_to }
			: {}),
		html: r.html,
		...(r.text !== undefined ? { text: r.text } : {}),
		template_id: t.id,
	};
}

export { fill, htmlToText, previewValues, usedKeys } from "../lib/template-fill";
