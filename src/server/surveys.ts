import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { esc } from "../lib/signup-form-render";
import { npsGroup, scaleOf } from "../lib/survey-scale";
import { db, schema } from "./db";
import { ApiError, notFound, validation } from "./errors";
import { publicUrl } from "./public-host";
import { iso } from "./time";

/**
 * Surveys: one question (NPS 0-10, satisfaction 1-5, or a choice) and maybe a comment, asked
 * wherever a brand meets people. In an email, the editor's survey block links each answer to
 * {{{SURVEY_URL}}}/<survey>/<answer>, signed per contact; on the web at /s/<survey>; in the
 * website chat when a chat ends; and in the email sent after a support conversation. Each answer
 * is kept (survey_responses, one per contact and place: a later answer changes it), recorded on
 * the contact as a "survey.answered" event (automations wait for it), and live segments can pick
 * promoters, detractors or a choice.
 */

const sv = schema.surveys;
const sr = schema.surveyResponses;
export type Survey = typeof sv.$inferSelect;
export type SurveyResponse = typeof sr.$inferSelect;
export type SurveyKind = "nps" | "csat" | "choice";
export type SurveySource = "email" | "web" | "chat" | "conversation";
export { npsGroup, scaleOf };

const DEFAULTS: Record<SurveyKind, { question: string; low: string | null; high: string | null }> =
	{
		nps: {
			question: "How likely are you to recommend us to a friend?",
			low: "Not likely",
			high: "Very likely",
		},
		csat: { question: "How satisfied are you with us?", low: "Not at all", high: "Very" },
		choice: { question: "What should we do next?", low: null, high: null },
	};

const words = (max: number) => z.string().trim().max(max);

export const surveyInput = z.object({
	name: words(80).min(1, "name: give it a name").optional(),
	kind: z.enum(["nps", "csat", "choice"]).optional(),
	question: words(300).min(1).optional(),
	options: z.array(words(120).min(1)).max(10).optional(),
	low_label: words(40).nullish(),
	high_label: words(40).nullish(),
	comment_prompt: words(200).nullish(),
	thanks: words(300).min(1).optional(),
	enabled: z.boolean().optional(),
});

export const surveyUrl = (id: string) => `${publicUrl()}/s/${id}`;

export const surveyView = (s: Survey) => ({
	object: "survey",
	id: s.id,
	brand_id: s.organization_id,
	name: s.name,
	kind: s.kind as SurveyKind,
	question: s.question,
	options: s.options,
	low_label: s.low_label,
	high_label: s.high_label,
	comment_prompt: s.comment_prompt,
	thanks: s.thanks,
	enabled: s.enabled,
	url: surveyUrl(s.id),
	created_at: s.created_at,
	updated_at: s.updated_at,
});

function checked(kind: SurveyKind, options: string[]) {
	if (kind === "choice" && options.length < 2) throw validation("options: give at least two");
}

export async function listSurveys(brands: string[]) {
	if (!brands.length) return [];
	const rows = await db
		.select()
		.from(sv)
		.where(inArray(sv.organization_id, brands))
		.orderBy(desc(sv.created_at));
	if (!rows.length) return [];
	const counts = await db
		.select({
			id: sr.survey_id,
			n: sql<number>`COUNT(*)`,
			last: sql<string | null>`MAX(${sr.updated_at})`,
		})
		.from(sr)
		.where(
			inArray(
				sr.survey_id,
				rows.map((r) => r.id),
			),
		)
		.groupBy(sr.survey_id);
	return rows.map((s) => {
		const c = counts.find((x) => x.id === s.id);
		return { ...surveyView(s), responses: Number(c?.n ?? 0), last_answer_at: c?.last ?? null };
	});
}

export async function getSurvey(brands: string | string[], id: string) {
	const list = Array.isArray(brands) ? brands : [brands];
	const s = list.length
		? await db
				.select()
				.from(sv)
				.where(and(eq(sv.id, id), inArray(sv.organization_id, list)))
				.get()
		: undefined;
	if (!s) throw notFound("Survey");
	return s;
}

export async function createSurvey(
	brand: string,
	raw: unknown,
	by: string | null = null,
	now = Date.now(),
) {
	const v = surveyInput.parse(raw);
	const kind = v.kind ?? "nps";
	const d = DEFAULTS[kind];
	const options = kind === "choice" ? (v.options ?? ["Yes", "No"]) : [];
	checked(kind, options);
	const [row] = await db
		.insert(sv)
		.values({
			id: `sv_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			organization_id: brand,
			name: v.name || (kind === "nps" ? "NPS" : kind === "csat" ? "Satisfaction" : "Survey"),
			kind,
			question: v.question || d.question,
			options,
			low_label: v.low_label === undefined ? d.low : v.low_label || null,
			high_label: v.high_label === undefined ? d.high : v.high_label || null,
			comment_prompt:
				v.comment_prompt === undefined
					? "What's the main reason?"
					: v.comment_prompt || null,
			thanks: v.thanks || "Thank you! Your answer helps us get better.",
			enabled: v.enabled ?? true,
			created_by: by,
			created_at: iso(now),
			updated_at: iso(now),
		})
		.returning();
	return row as Survey;
}

export async function updateSurvey(brand: string, id: string, raw: unknown, now = Date.now()) {
	const s = await getSurvey(brand, id);
	const v = surveyInput.parse(raw);
	const kind = (v.kind ?? s.kind) as SurveyKind;
	if (kind !== s.kind) {
		const [had] = await db
			.select({ n: sql<number>`COUNT(*)` })
			.from(sr)
			.where(eq(sr.survey_id, s.id));
		if (Number(had?.n ?? 0) > 0)
			throw validation("kind: it has answers already; make a new survey for another kind");
	}
	const options = kind === "choice" ? (v.options ?? s.options) : [];
	checked(kind, options);
	const [row] = await db
		.update(sv)
		.set({
			...(v.name ? { name: v.name } : {}),
			kind,
			...(v.question ? { question: v.question } : {}),
			options,
			...(v.low_label !== undefined ? { low_label: v.low_label || null } : {}),
			...(v.high_label !== undefined ? { high_label: v.high_label || null } : {}),
			...(v.comment_prompt !== undefined ? { comment_prompt: v.comment_prompt || null } : {}),
			...(v.thanks ? { thanks: v.thanks } : {}),
			...(v.enabled !== undefined ? { enabled: v.enabled } : {}),
			updated_at: iso(now),
		})
		.where(eq(sv.id, s.id))
		.returning();
	return row as Survey;
}

/** Deletes a survey and its answers (the contacts' events stay). */
export async function deleteSurvey(brand: string, id: string) {
	const s = await getSurvey(brand, id);
	await db.delete(sr).where(eq(sr.survey_id, s.id));
	await db.delete(sv).where(eq(sv.id, s.id));
	return s;
}

// ── Answers ──────────────────────────────────────────────────────────────────

/** Records an answer (a contact's again changes theirs); null when the answer isn't one. */
export async function recordResponse(
	s: Survey,
	a: {
		value: number;
		comment?: string | null;
		contact_id?: string | null;
		email?: string | null;
		source: SurveySource;
		source_id?: string | null;
	},
	now = Date.now(),
) {
	if (!s.enabled) throw new ApiError(410, "survey_closed", "This survey is closed");
	const pick = scaleOf(s).find(([v]) => v === a.value);
	if (!pick) throw validation("value: not one of the survey's answers");
	const sourceId = a.source_id ?? "";
	const comment = a.comment === undefined ? undefined : a.comment?.slice(0, 2000).trim() || null;
	const choice = s.kind === "choice" ? pick[1] : null;
	// One per contact and place: theirs, or the visitor's of that chat or conversation.
	const before =
		a.contact_id || sourceId
			? await db
					.select()
					.from(sr)
					.where(
						and(
							eq(sr.survey_id, s.id),
							eq(sr.source_id, sourceId),
							a.contact_id ? eq(sr.contact_id, a.contact_id) : isNull(sr.contact_id),
						),
					)
					.get()
			: undefined;
	let row: SurveyResponse;
	if (before) {
		[row] = (await db
			.update(sr)
			.set({
				score: a.value,
				choice,
				...(comment !== undefined ? { comment } : {}),
				updated_at: iso(now),
			})
			.where(eq(sr.id, before.id))
			.returning()) as [SurveyResponse];
	} else {
		[row] = (await db
			.insert(sr)
			.values({
				id: `svr_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
				survey_id: s.id,
				organization_id: s.organization_id,
				contact_id: a.contact_id ?? null,
				email: a.email?.toLowerCase() ?? null,
				score: a.value,
				choice,
				comment: comment ?? null,
				source: a.source,
				source_id: sourceId,
				created_at: iso(now),
				updated_at: iso(now),
			})
			.returning()) as [SurveyResponse];
	}
	if (a.contact_id && (before?.score !== a.value || (comment && comment !== before?.comment))) {
		const { recordEvent } = await import("./automations");
		await recordEvent(
			s.organization_id,
			{
				event: "survey.answered",
				contact_id: a.contact_id,
				create_contact: false,
				data: {
					survey_id: s.id,
					survey: s.name,
					kind: s.kind,
					score: s.kind === "choice" ? null : a.value,
					answer: pick[1],
					...(s.kind === "nps" ? { group: npsGroup(a.value) } : {}),
					...(comment ? { comment: comment.slice(0, 300) } : {}),
					source: a.source,
				},
			},
			now,
			"mailroom",
		).catch((e) => console.error("surveys: event failed", e));
	}
	return row;
}

/** The brand's contact with this address, if there's one. */
async function contactByEmail(brand: string, email: string | null | undefined) {
	if (!email?.includes("@")) return null;
	return (
		(await db
			.select({ id: schema.contacts.id, email: schema.contacts.email })
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.organization_id, brand),
					eq(schema.contacts.email, email.toLowerCase()),
				),
			)
			.get()) ?? null
	);
}

/** An answer after a support conversation (the inbox's follow-up email, or its chat). */
export async function answerForConversation(
	s: Survey,
	conversationId: string,
	value: number,
	comment: string | null | undefined,
	source: "conversation" | "chat",
	now = Date.now(),
) {
	const x = await db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId))
		.get();
	if (!x || x.organization_id !== s.organization_id) throw notFound("Conversation");
	const address = x.contact_address ?? (x.contact.includes("@") ? x.contact : null);
	const contact = await contactByEmail(s.organization_id, address);
	const row = await recordResponse(
		s,
		{ value, comment, contact_id: contact?.id, email: address, source, source_id: x.id },
		now,
	);
	// A satisfaction survey is the conversation's rating too.
	if (s.kind === "csat") {
		const { recordCsat } = await import("./inbox-workflow");
		await recordCsat(x, value, comment ?? null, now);
	}
	return row;
}

// ── Results ──────────────────────────────────────────────────────────────────

/** How it's going: the score (NPS, average or most picked), each answer's count, by place. */
export async function surveyResults(s: Survey, o: { days?: number; now?: number } = {}) {
	const now = o.now ?? Date.now();
	const window = o.days ? gte(sr.updated_at, iso(now - o.days * 86_400_000)) : undefined;
	const where = and(eq(sr.survey_id, s.id), window);
	const [by, places] = await Promise.all([
		db
			.select({ score: sr.score, n: sql<number>`COUNT(*)` })
			.from(sr)
			.where(where)
			.groupBy(sr.score),
		db
			.select({ source: sr.source, n: sql<number>`COUNT(*)` })
			.from(sr)
			.where(where)
			.groupBy(sr.source),
	]);
	const count = (v: number) => Number(by.find((b) => b.score === v)?.n ?? 0);
	const total = by.reduce((a, b) => a + Number(b.n), 0);
	const scale = scaleOf(s);
	const distribution = scale.map(([value, label]) => ({ value, label, count: count(value) }));
	const pct = (n: number) => (total ? Math.round((n / total) * 100) : 0);
	let summary: {
		nps?: number | null;
		promoters?: number;
		passives?: number;
		detractors?: number;
		average?: number | null;
		satisfied_pct?: number | null;
		top?: string | null;
	};
	if (s.kind === "nps") {
		const promoters = distribution.filter((d) => d.value >= 9).reduce((a, d) => a + d.count, 0);
		const detractors = distribution
			.filter((d) => d.value <= 6)
			.reduce((a, d) => a + d.count, 0);
		summary = {
			nps: total ? pct(promoters) - pct(detractors) : null,
			promoters,
			passives: total - promoters - detractors,
			detractors,
		};
	} else if (s.kind === "csat") {
		const sum = distribution.reduce((a, d) => a + d.value * d.count, 0);
		const happy = count(4) + count(5);
		summary = {
			average: total ? Math.round((sum / total) * 10) / 10 : null,
			satisfied_pct: total ? pct(happy) : null,
		};
	} else {
		const top = [...distribution].sort((a, b) => b.count - a.count)[0];
		summary = { top: total && top ? top.label : null };
	}
	return {
		total,
		...summary,
		distribution: distribution.map((d) => ({ ...d, pct: pct(d.count) })),
		by_source: Object.fromEntries(places.map((p) => [p.source, Number(p.n)])),
	};
}

export async function listResponses(
	s: Survey,
	o: { limit?: number; offset?: number; comments?: boolean; days?: number; now?: number } = {},
) {
	const now = o.now ?? Date.now();
	const rows = await db
		.select()
		.from(sr)
		.where(
			and(
				eq(sr.survey_id, s.id),
				o.comments ? sql`${sr.comment} IS NOT NULL` : undefined,
				o.days ? gte(sr.updated_at, iso(now - o.days * 86_400_000)) : undefined,
			),
		)
		.orderBy(desc(sr.updated_at))
		.limit(Math.min(o.limit ?? 50, 200))
		.offset(o.offset ?? 0);
	return rows.map((r) => responseView(s, r));
}

export const responseView = (s: Survey, r: SurveyResponse) => ({
	object: "survey_response",
	id: r.id,
	survey_id: r.survey_id,
	contact_id: r.contact_id,
	email: r.email,
	score: s.kind === "choice" ? null : r.score,
	answer: s.kind === "choice" ? r.choice : String(r.score),
	...(s.kind === "nps" && r.score !== null ? { group: npsGroup(r.score) } : {}),
	comment: r.comment,
	source: r.source,
	conversation_id: r.source_id || null,
	created_at: r.created_at,
	updated_at: r.updated_at,
});

/** A contact's answers (their page in the dashboard). */
export async function contactResponses(brand: string, contactId: string) {
	const rows = await db
		.select({ r: sr, s: sv })
		.from(sr)
		.innerJoin(sv, eq(sv.id, sr.survey_id))
		.where(and(eq(sr.organization_id, brand), eq(sr.contact_id, contactId)))
		.orderBy(desc(sr.updated_at))
		.limit(20);
	return rows.map(({ r, s }) => ({ ...responseView(s, r), survey: s.name, kind: s.kind }));
}

// ── Links ────────────────────────────────────────────────────────────────────

/** The start of a contact's survey links ({{{SURVEY_URL}}}): /s/c/<contact>/<signature>. */
export async function surveyBase(contactId: string) {
	const { sign } = await import("./inbound");
	return `${publicUrl()}/s/c/${contactId}/${await sign(`survey:${contactId}`)}`;
}

/** The start of a conversation's survey links: /s/v/<conversation>/<signature>. */
export async function conversationSurveyBase(conversationId: string) {
	const { sign } = await import("./inbound");
	return `${publicUrl()}/s/v/${conversationId}/${await sign(`survey-conversation:${conversationId}`)}`;
}

async function verified(value: string, signature: string) {
	const { sign } = await import("./inbound");
	const expected = await sign(value);
	let diff = expected.length ^ signature.length;
	for (let i = 0; i < expected.length; i++)
		diff |= expected.charCodeAt(i) ^ (signature.charCodeAt(i) || 0);
	return !diff;
}

// ── Public pages ────────────────────────────────────────────────────────────

const CSS = `main{max-width:560px;margin:0 auto;padding:48px 20px}
.box{background:var(--card,#fff);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{margin:0 0 18px;font-size:22px;line-height:1.35}
p{margin:0 0 18px;color:var(--soft);font-size:15px;line-height:1.55}
.scale{display:flex;gap:6px;margin:0}.scale label{flex:1;min-width:0}
.scale.choice{flex-direction:column}
.scale input{position:absolute;opacity:0;pointer-events:none}
.scale span{display:block;text-align:center;border:1px solid var(--line);border-radius:10px;padding:12px 4px;font-weight:600;cursor:pointer}
.scale.choice span{text-align:left;padding:12px 16px;font-weight:500}
.scale input:checked+span{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent)}
.scale input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.ends{display:flex;justify-content:space-between;font-size:12px;color:var(--soft);margin:8px 2px 0}
.c{display:block;font-size:14px;margin:22px 0 6px;color:var(--soft)}
textarea{width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;background:transparent;color:inherit}
button{margin-top:16px;border:0;border-radius:10px;padding:11px 20px;font:500 15px/1 var(--font);background:var(--accent);color:var(--on-accent);cursor:pointer}
.note{font-size:13px;margin:14px 0 0}
@media (max-width:480px){.scale.nps{flex-wrap:wrap}.scale.nps label{flex:0 0 calc((100% - 30px)/6)}}`;

async function page(
	brand: string | null,
	title: string,
	body: string,
	o: { status?: number; nonce?: string } = {},
) {
	const { dressOf, dressPage, dressBar } = await import("./newsletters");
	const { lookOf } = await import("../lib/newsletter-look");
	const d = brand
		? await dressOf(null, brand)
		: {
				look: lookOf(null),
				accent: null,
				logo: null,
				brand: "",
				name: "",
				home: null,
				subscribe: false,
			};
	return new Response(
		dressPage(d, {
			title,
			head: '<meta name="robots" content="noindex">',
			css: CSS,
			body: `${d.home ? dressBar(d) : ""}<main><div class="box">${body}</div></main>`,
		}),
		{
			status: o.status ?? 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": `default-src 'none'; img-src * data:; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; form-action 'self'; base-uri 'none'${o.nonce ? `; script-src 'nonce-${o.nonce}'; connect-src 'self'` : ""}`,
			},
		},
	);
}

function form(s: Survey, picked: number | null, comment: string | null) {
	const scale = scaleOf(s);
	const items = scale
		.map(
			([v, l]) =>
				`<label><input type="radio" name="value" value="${v}"${v === picked ? " checked" : ""} required><span>${esc(l)}</span></label>`,
		)
		.join("");
	const ends =
		s.kind !== "choice" && (s.low_label || s.high_label)
			? `<div class="ends"><span>${esc(s.low_label ?? "")}</span><span>${esc(s.high_label ?? "")}</span></div>`
			: "";
	const c = s.comment_prompt
		? `<label class="c" for="comment">${esc(s.comment_prompt)} (optional)</label><textarea id="comment" name="comment" rows="4" maxlength="2000">${esc(comment ?? "")}</textarea>`
		: "";
	return `<h1>${esc(s.question)}</h1><form method="post"><fieldset style="border:0;padding:0;margin:0"><legend style="position:absolute;left:-9999px">${esc(s.question)}</legend><div class="scale ${s.kind}">${items}</div>${ends}</fieldset>${c}<button type="submit">Send</button></form>`;
}

const missing = () =>
	page(
		null,
		"Not found",
		"<h1>This survey isn't available</h1><p>The link may be incomplete.</p>",
		{
			status: 404,
		},
	);

/**
 * /s/<survey>[?v=]: anyone answers (a website's link); /s/web/<survey>/<v>: an email's web
 * version; /s/c/<contact>/<sig>/<survey>/<v>: a contact's link from an email; and
 * /s/v/<conversation>/<sig>/<survey>/<v>: the email after a support conversation. Opening a
 * signed link shows the page with that answer picked and its script records it (mail scanners
 * open links but don't run scripts); the form sends the answer again with a comment.
 */
export async function handleSurveyPage(request: Request, now = Date.now()): Promise<Response> {
	const u = new URL(request.url);
	const post = request.method === "POST";
	const m =
		/^\/s\/(?:(c|v)\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{10,40})\/|web\/)?(sv_[a-z0-9]{20})(?:\/(\d{1,2}))?\/?$/.exec(
			u.pathname,
		);
	if (!m) return missing();
	const [, who, ref, sig, id, raw] = m as unknown as (string | undefined)[];
	const s = await db
		.select()
		.from(sv)
		.where(eq(sv.id, id as string))
		.get();
	if (!s) return missing();
	if (!s.enabled)
		return page(
			s.organization_id,
			"Survey closed",
			"<h1>This survey is closed</h1><p>Thanks for wanting to answer.</p>",
		);
	let contactId: string | null = null;
	let conversationId: string | null = null;
	if (who === "c") {
		if (!(await verified(`survey:${ref}`, sig as string))) return missing();
		const c = await db
			.select({ id: schema.contacts.id })
			.from(schema.contacts)
			.where(
				and(
					eq(schema.contacts.id, ref as string),
					eq(schema.contacts.organization_id, s.organization_id),
				),
			)
			.get();
		if (!c) return missing();
		contactId = c.id;
	} else if (who === "v") {
		if (!(await verified(`survey-conversation:${ref}`, sig as string))) return missing();
		conversationId = ref as string;
	}
	const signed = !!(contactId || conversationId);
	const fromUrl = raw ?? u.searchParams.get("v");
	let value = fromUrl === null || fromUrl === "" ? null : Number(fromUrl);
	let comment: string | null | undefined;
	const auto = post && request.headers.get("x-mailroom-survey") === "auto";
	if (post && !auto) {
		const f = await request.formData().catch(() => null);
		const v = f?.get("value");
		if (v !== null && v !== undefined && v !== "") value = Number(v);
		comment = String(f?.get("comment") ?? "").trim() || null;
	}
	if (value !== null && !scaleOf(s).some(([v]) => v === value)) value = null;
	if (post) {
		if (value === null)
			return page(
				s.organization_id,
				s.question,
				`<p>Pick an answer first.</p>${form(s, null, comment ?? null)}`,
				{
					status: 422,
				},
			);
		if (!signed) {
			const { limitIp } = await import("./rate-limit");
			try {
				await limitIp(request);
			} catch {
				return page(
					s.organization_id,
					s.question,
					"<h1>One moment</h1><p>Too many answers from here; try again in a minute.</p>",
					{ status: 429 },
				);
			}
		}
		if (conversationId)
			await answerForConversation(
				s,
				conversationId,
				value,
				comment,
				"conversation",
				now,
			).catch(() => null);
		else
			await recordResponse(
				s,
				{
					value,
					comment,
					contact_id: contactId,
					source: contactId ? "email" : "web",
				},
				now,
			);
		if (auto)
			return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
		return page(
			s.organization_id,
			"Thank you",
			`<h1>${esc(s.thanks)}</h1><p>${comment ? "Your comment is with the team." : "Your answer is recorded."}</p>`,
		);
	}
	if (signed && value !== null) {
		const nonce = crypto.randomUUID().replace(/-/g, "");
		const had = contactId
			? await db
					.select({ comment: sr.comment })
					.from(sr)
					.where(
						and(
							eq(sr.survey_id, s.id),
							eq(sr.contact_id, contactId),
							eq(sr.source_id, ""),
						),
					)
					.get()
			: null;
		return page(
			s.organization_id,
			s.question,
			`${form(s, value, had?.comment ?? null)}<p id="n" class="note">Press Send to record your answer.</p><script nonce="${nonce}">fetch(location.href,{method:"POST",headers:{"x-mailroom-survey":"auto"}}).then(function(r){if(r.ok)document.getElementById("n").textContent=${JSON.stringify(s.comment_prompt ? "Your answer is in. Add a comment if you like." : "Your answer is in. Thank you!")}})</script>`,
			{ nonce },
		);
	}
	return page(s.organization_id, s.question, form(s, value, null));
}

/** The survey asked in a chat widget (its design's survey_id), or null. */
export async function chatSurvey(brand: string, id: string | null | undefined) {
	if (!id) return null;
	const s = await db
		.select()
		.from(sv)
		.where(and(eq(sv.id, id), eq(sv.organization_id, brand)))
		.get();
	return s?.enabled ? s : null;
}

/** Checks a survey is the brand's (the chat's and the inbox's settings). */
export async function checkSurvey(brand: string, id: string | null | undefined) {
	if (!id) return;
	await getSurvey(brand, id).catch(() => {
		throw validation("survey_id: no survey of this brand has that id");
	});
}
