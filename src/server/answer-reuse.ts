import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { esc } from "../lib/email-doc";
import { displayName } from "../lib/reply-variables";
import { db, schema } from "./db";
import { ApiError } from "./errors";
import type { InboxActor } from "./inboxes";

/*
 * A good answer, kept: one of the team's replies in a conversation (an email reply or a chat
 * line) becomes a help center article (a draft to polish and publish) or a saved reply, in one
 * click. The greeting and the person's name are taken out, so it reads for everyone.
 */

const c = schema.conversations;
const rp = schema.conversationReplies;
const cm = schema.chatMessages;

export interface AnswerSource {
	brand: string;
	conversationId: string;
	inboxId: string | null;
	subject: string;
	/** The question it answered, when known (the visitor's chat line before it). */
	question: string | null;
	text: string;
	/** The person's first name, if any (to take out or turn into a variable). */
	firstName: string | null;
}

/** The reply (or chat line) by id, from a conversation the actor can see. */
export async function answerSource(actor: InboxActor, messageId: string): Promise<AnswerSource> {
	if (!actor.brands.length) throw notFound();
	const visible = and(
		inArray(c.organization_id, actor.brands),
		actor.inboxIds ? inArray(c.inbox_id, actor.inboxIds) : undefined,
	);
	const reply = await db
		.select({ r: rp, c })
		.from(rp)
		.innerJoin(c, eq(c.id, rp.conversation_id))
		.where(and(eq(rp.id, messageId), visible))
		.get();
	if (reply) {
		if (reply.r.status !== "sent") throw new ApiError(409, "not_sent", "Send it first");
		return {
			brand: reply.c.organization_id,
			conversationId: reply.c.id,
			inboxId: reply.c.inbox_id,
			subject: reply.c.subject,
			question: null,
			text: withoutQuote(reply.r.text),
			firstName: firstNameOf(reply.c.contact),
		};
	}
	const line = await db
		.select({ m: cm, c })
		.from(cm)
		.innerJoin(c, eq(c.id, cm.conversation_id))
		.where(and(eq(cm.id, messageId), visible))
		.get();
	if (!line) throw notFound();
	if (!["person", "agent", "api"].includes(line.m.author))
		throw new ApiError(422, "validation_error", "Pick one of the team's answers");
	const asked = await db
		.select({ text: cm.text })
		.from(cm)
		.where(
			and(
				eq(cm.conversation_id, line.c.id),
				eq(cm.author, "visitor"),
				lt(cm.created_at, line.m.created_at),
			),
		)
		.orderBy(desc(cm.created_at))
		.get();
	return {
		brand: line.c.organization_id,
		conversationId: line.c.id,
		inboxId: line.c.inbox_id,
		subject: line.c.subject,
		question: asked?.text.trim() || null,
		text: line.m.text,
		firstName: firstNameOf(line.c.visitor_name ?? line.c.contact),
	};
}

const notFound = () => new ApiError(404, "not_found", "That reply is gone");

function firstNameOf(who: string | null) {
	const name = who ? displayName(who) || (who.includes("@") ? "" : who) : "";
	const first = name.trim().split(/\s+/)[0] ?? "";
	return first.length > 1 ? first : null;
}

/** An email reply without the quoted message under it ("On … wrote:" and "> " lines). */
export function withoutQuote(text: string) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const cut = lines.findIndex(
		(l) => /^On .+wrote:\s*$/i.test(l.trim()) || /^El .+escribió:\s*$/i.test(l.trim()),
	);
	return (cut >= 0 ? lines.slice(0, cut) : lines)
		.filter((l) => !l.startsWith(">"))
		.join("\n")
		.trim();
}

const GREETING =
	/^(hi|hello|hey|dear|good (morning|afternoon|evening)|hola|buen[oa]s (días|dias|tardes|noches)|estimad[oa]|querid[oa])\b[^\n]{0,40}$/i;

/** Without its first line when that's a greeting ("Hi Ana,"). */
export function withoutGreeting(text: string) {
	const [first, ...rest] = text.trim().split("\n");
	return first && GREETING.test(first.trim()) && rest.length
		? rest.join("\n").trim()
		: text.trim();
}

/** "Re: Fwd: Late check-out?" → "Late check-out?" */
const cleanSubject = (s: string) => s.replace(/^(\s*(re|fwd?|rv|fw)\s*:\s*)+/i, "").trim();

const words = (name: string) =>
	new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");

/** Without the person's name: "…2 pm, Ana, just…" → "…2 pm, just…". */
export function withoutName(text: string, name: string) {
	const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text
		.replace(new RegExp(`,\\s*\\b${n}\\b`, "g"), "")
		.replace(new RegExp(`\\b${n}\\b,?\\s?`, "g"), "")
		.replace(/ {2,}/g, " ");
}

/** The text as article HTML: paragraphs, line breaks kept. */
export function paragraphs(text: string) {
	return text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean)
		.map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

/** A draft help article from the answer: titled by the question (or the subject). */
export async function answerToArticle(
	actor: InboxActor,
	messageId: string,
	o: { title?: string | null; userId?: string | null; now?: number } = {},
) {
	const src = await answerSource(actor, messageId);
	let body = withoutGreeting(src.text);
	if (src.firstName) body = withoutName(body, src.firstName);
	const title = (
		o.title?.trim() ||
		(src.question && src.question.length <= 120 ? src.question : "") ||
		cleanSubject(src.subject) ||
		"An answer from support"
	).slice(0, 160);
	const { createArticle } = await import("./help-center");
	const article = await createArticle(
		src.brand,
		{ title, html: paragraphs(body), status: "draft" },
		o.userId ?? null,
		o.now,
	);
	return { article, source: src };
}

/** A saved reply from the answer: the person's first name becomes {{contact.first_name}}. */
export async function answerToSavedReply(
	actor: InboxActor,
	messageId: string,
	o: { name?: string | null; userId?: string | null; now?: number } = {},
) {
	const src = await answerSource(actor, messageId);
	const text = src.firstName
		? src.text.replace(words(src.firstName), "{{contact.first_name}}")
		: src.text;
	const name = (o.name?.trim() || cleanSubject(src.subject) || "Saved answer").slice(0, 100);
	const { saveSavedReply } = await import("./inbox-workflow");
	const reply = await saveSavedReply(
		src.brand,
		{ name, text, inbox_id: null },
		{ userId: o.userId, now: o.now },
	);
	return { reply, source: src };
}
