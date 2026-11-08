import { describe, expect, it } from "vitest";
import {
	answerToArticle,
	answerToSavedReply,
	paragraphs,
	withoutGreeting,
	withoutQuote,
} from "@/server/answer-reuse";
import { db, schema } from "@/server/db";
import { memberActor } from "@/server/inboxes";
import { iso } from "@/server/time";
import { seedOrg, uid } from "./helpers";

const actorOf = (org: string) =>
	memberActor({
		organizationId: org,
		brands: [org],
		userId: "u1",
		name: "Rosa",
		canReply: true,
		masked: false,
	});

async function conversation(org: string, o: Record<string, unknown> = {}) {
	const id = `cv-${uid()}`;
	await db.insert(schema.conversations).values({
		id,
		organization_id: org,
		subject: "Re: Late check-out?",
		contact: "Ana García <ana@example.com>",
		contact_address: "ana@example.com",
		last_message_at: iso(),
		created_at: iso(),
		updated_at: iso(),
		...o,
	});
	return id;
}

describe("a good answer, kept", () => {
	it("cleans a reply: quote, greeting, paragraphs", () => {
		expect(withoutQuote("Yes!\n\nOn Mon, Ana wrote:\n> can I?\n> thanks")).toBe("Yes!");
		expect(withoutGreeting("Hi Ana,\nCheck-out is at noon.")).toBe("Check-out is at noon.");
		expect(withoutGreeting("Check-out is at noon.")).toBe("Check-out is at noon.");
		expect(paragraphs("One <b>\nline\n\nTwo")).toBe(
			"<p>One &#60;b&#62;<br>line</p>\n<p>Two</p>",
		);
	});

	it("turns an email reply into a draft article and a saved reply", async () => {
		const org = await seedOrg();
		const conv = await conversation(org.id);
		const reply = `rp-${uid()}`;
		await db.insert(schema.conversationReplies).values({
			id: reply,
			organization_id: org.id,
			conversation_id: conv,
			status: "sent",
			to: ["ana@example.com"],
			subject: "Re: Late check-out?",
			text: "Hi Ana,\nLate check-out is free until 2 pm, Ana, just tell the front desk.\n\nOn Mon, Ana wrote:\n> Can I leave late?",
			author_type: "person",
			author_name: "Rosa",
			sent_at: iso(),
			created_at: iso(),
			updated_at: iso(),
		});
		const actor = actorOf(org.id);
		const { article } = await answerToArticle(actor, reply, { userId: "u1" });
		expect(article).toMatchObject({
			title: "Late check-out?",
			status: "draft",
			organization_id: org.id,
		});
		expect(article.html).toBe(
			"<p>Late check-out is free until 2 pm, just tell the front desk.</p>",
		);
		const { reply: saved } = await answerToSavedReply(actor, reply);
		expect(saved).toMatchObject({ name: "Late check-out?", inbox_id: null });
		expect(saved.text).toBe(
			"Hi {{contact.first_name}},\nLate check-out is free until 2 pm, {{contact.first_name}}, just tell the front desk.",
		);

		// Another brand's people can't reach it; a draft can't be kept.
		const other = await seedOrg();
		await expect(answerToArticle(actorOf(other.id), reply)).rejects.toThrow(/gone/);
		const draft = `rp-${uid()}`;
		await db.insert(schema.conversationReplies).values({
			id: draft,
			organization_id: org.id,
			conversation_id: conv,
			status: "draft",
			to: [],
			subject: "x",
			text: "x",
			author_type: "person",
			author_name: "Rosa",
			created_at: iso(),
			updated_at: iso(),
		});
		await expect(answerToSavedReply(actor, draft)).rejects.toThrow(/Send it first/);
	});

	it("titles a chat answer by the visitor's question", async () => {
		const org = await seedOrg();
		const conv = await conversation(org.id, {
			subject: "Chat",
			channel: "chat",
			visitor_name: "Luis",
		});
		const line = (author: string, text: string, at: number) => ({
			id: `cm-${uid()}`,
			organization_id: org.id,
			conversation_id: conv,
			author,
			text,
			via: "widget",
			created_at: iso(at),
		});
		const now = Date.now();
		const asked = line("visitor", "Do you have parking?", now - 60_000);
		const answer = line("person", "Hello Luis!\nYes, free parking for guests.", now);
		await db.insert(schema.chatMessages).values([asked, answer]);
		const { article } = await answerToArticle(actorOf(org.id), answer.id);
		expect(article.title).toBe("Do you have parking?");
		expect(article.html).toBe("<p>Yes, free parking for guests.</p>");
		// The visitor's own line isn't an answer.
		await expect(answerToArticle(actorOf(org.id), asked.id)).rejects.toThrow(/team's answers/);
	});
});
