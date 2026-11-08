import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { parseDoc, renderEmail } from "@/lib/email-doc";
import { contactValues, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { surveyEmail } from "@/server/inbox-workflow";
import { previewRules } from "@/server/live-segments";
import {
	answerForConversation,
	createSurvey,
	handleSurveyPage,
	listResponses,
	recordResponse,
	surveyResults,
	updateSurvey,
} from "@/server/surveys";
import { seedOrg, uid } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

const at = (path: string, init?: RequestInit) =>
	handleSurveyPage(new Request(`https://mailroom.test${path}`, init));

async function people() {
	const org = await seedOrg();
	const ana = (await upsertContact(org.id, { email: `ana-${uid()}@example.com` })).contact;
	const luis = (await upsertContact(org.id, { email: `luis-${uid()}@example.com` })).contact;
	return { org, ana, luis };
}

describe("surveys", () => {
	it("asks in an email: signed links per contact, recorded once by the page's script", async () => {
		const { org, ana } = await people();
		const s = await createSurvey(org.id, { kind: "nps" });
		expect(s.question).toMatch(/recommend/);
		// The editor's block links each answer to the contact's survey links.
		const doc = parseDoc({
			version: 1,
			blocks: [
				{
					type: "survey",
					survey_id: s.id,
					kind: "nps",
					question: s.question,
					align: "left",
				},
			],
		});
		const html = renderEmail(doc as NonNullable<typeof doc>);
		expect(html).toContain(`{{{SURVEY_URL}}}/${s.id}/10`);
		const values = await contactValues(org.id, ana);
		const base = String(values.SURVEY_URL);
		expect(base).toMatch(new RegExp(`/s/c/${ana.id}/`));
		const path = new URL(`${base}/${s.id}/9`).pathname;
		// Opening it (a mail scanner) records nothing.
		const page = await at(path);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('value="9" checked');
		expect(await listResponses(s)).toHaveLength(0);
		// The page's script records it; the comment form changes the same answer.
		const auto = await at(path, { method: "POST", headers: { "x-mailroom-survey": "auto" } });
		expect(auto.status).toBe(204);
		const form = new FormData();
		form.set("value", "10");
		form.set("comment", "Lovely rooms");
		const sent = await at(path, { method: "POST", body: form });
		expect(await sent.text()).toContain("Your comment is with the team");
		const rows = await listResponses(s);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			contact_id: ana.id,
			score: 10,
			group: "promoter",
			comment: "Lovely rooms",
			source: "email",
		});
		// On the contact, for automations.
		const events = await db
			.select()
			.from(schema.contactEvents)
			.where(
				and(
					eq(schema.contactEvents.contact_id, ana.id),
					eq(schema.contactEvents.name, "survey.answered"),
				),
			);
		expect(events.length).toBeGreaterThanOrEqual(1);
		expect(events.at(-1)?.data).toMatchObject({ survey_id: s.id, group: "promoter" });
		// Someone else's signature is refused.
		expect((await at(path.replace(ana.id, crypto.randomUUID()))).status).toBe(404);
	});

	it("takes a visitor's answer on the web, and closes", async () => {
		const { org } = await people();
		const s = await createSurvey(org.id, {
			kind: "choice",
			question: "What brought you here?",
			options: ["A friend", "Instagram", "Google"],
		});
		const page = await at(`/s/${s.id}`);
		expect(await page.text()).toContain("Instagram");
		const form = new FormData();
		form.set("value", "1");
		const sent = await at(`/s/${s.id}`, { method: "POST", body: form });
		expect(sent.status).toBe(200);
		const [r] = await listResponses(s);
		expect(r).toMatchObject({ contact_id: null, answer: "Instagram", source: "web" });
		await updateSurvey(org.id, s.id, { enabled: false });
		expect(await (await at(`/s/${s.id}`)).text()).toContain("closed");
		// Its kind can't change once it has answers.
		await expect(updateSurvey(org.id, s.id, { kind: "nps" })).rejects.toThrow(/answers/);
	});

	it("scores NPS and picks promoters and detractors in live segments", async () => {
		const { org, ana, luis } = await people();
		const s = await createSurvey(org.id, { kind: "nps" });
		await recordResponse(s, { value: 10, contact_id: ana.id, source: "email" });
		await recordResponse(s, { value: 3, contact_id: luis.id, source: "email" });
		await recordResponse(s, { value: 8, source: "web" });
		const r = await surveyResults(s);
		expect(r).toMatchObject({ total: 3, promoters: 1, passives: 1, detractors: 1, nps: 0 });
		const promoters = await previewRules(org.id, {
			conditions: [{ type: "survey", survey_id: s.id, answer: "promoter" }],
		});
		expect(promoters.sample.map((c) => c.id)).toEqual([ana.id]);
		// Luis changes his mind: his latest answer counts.
		await recordResponse(s, { value: 9, contact_id: luis.id, source: "email" });
		const now = await previewRules(org.id, {
			conditions: [{ type: "survey", survey_id: s.id, answer: "at_least", value: 9 }],
		});
		expect(now.count).toBe(2);
		await expect(
			previewRules((await seedOrg()).id, {
				conditions: [{ type: "survey", survey_id: s.id, answer: "any" }],
			}),
		).rejects.toThrow(/survey this brand doesn't have/);
	});

	it("follows a support conversation, and rates it with a satisfaction survey", async () => {
		const { org, ana } = await people();
		const s = await createSurvey(org.id, { kind: "csat", question: "How was our help?" });
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		await db.insert(schema.conversations).values({
			id,
			organization_id: org.id,
			subject: "Late check-out",
			contact: ana.email,
			contact_address: ana.email,
			status: "resolved",
			last_message_at: now,
			created_at: now,
			updated_at: now,
		});
		const x = (await db
			.select()
			.from(schema.conversations)
			.where(eq(schema.conversations.id, id))
			.get()) as typeof schema.conversations.$inferSelect;
		const mail = await surveyEmail(x, {
			enabled: true,
			question: "How did we do?",
			thanks: "Thanks",
			delay_minutes: 10,
			survey_id: s.id,
		});
		expect(mail.subject).toContain("How was our help?");
		const link = /href="([^"]+\/s\/v\/[^"]+\/5)"/.exec(mail.html)?.[1] as string;
		expect(link).toBeTruthy();
		await at(new URL(link).pathname, {
			method: "POST",
			headers: { "x-mailroom-survey": "auto" },
		});
		const [r] = await listResponses(s);
		expect(r).toMatchObject({ contact_id: ana.id, score: 5, source: "conversation" });
		const after = await db
			.select({ rating: schema.conversations.csat_rating })
			.from(schema.conversations)
			.where(eq(schema.conversations.id, id))
			.get();
		expect(after?.rating).toBe(5);
		// The same conversation again changes its answer, not adds one.
		await answerForConversation(s, id, 4, "Quick", "chat");
		expect(await listResponses(s)).toHaveLength(1);
	});
});
