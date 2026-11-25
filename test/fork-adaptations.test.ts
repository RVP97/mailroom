import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { createKey } from "@/server/api-keys";
import { createAutomation, simulateAutomation } from "@/server/automations";
import { createBroadcast } from "@/server/broadcasts";
import { getCompany, listCompanies, upsertCompany } from "@/server/companies";
import { importContacts, upsertContact } from "@/server/contacts";
import { db, schema } from "@/server/db";
import { sign } from "@/server/inbound";
import { handleRate } from "@/server/inbox-workflow";
import {
	conversationSurveyBase,
	createSurvey,
	handleSurveyPage,
	recordResponse,
	surveyBase,
} from "@/server/surveys";
import { iso } from "@/server/time";
import { createWebhook } from "@/server/webhook-admin";
import { emitEvent } from "@/server/webhooks";
import { fakeOutside, seedOrg, uid } from "./helpers";

vi.mock("cloudflare:workers", async (original) => ({
	...(await original<typeof import("cloudflare:workers")>()),
	waitUntil: () => {},
}));

describe("D1 100-parameter limits, non-UUID ids, automation poll/survey conditions & bulk import API", () => {
	it("loads a company with 100 contacts without hitting D1's 100-parameter limit", async () => {
		fakeOutside();
		const org = await seedOrg();
		const domain = `bigco-${uid()}.test`;
		const co = await upsertCompany(org.id, { name: "BigCo", domain });
		await importContacts(
			org.id,
			Array.from({ length: 100 }, (_, i) => ({ email: `u${i}@${domain}` })),
		);
		await db
			.update(schema.contacts)
			.set({ company_id: co.id })
			.where(eq(schema.contacts.organization_id, org.id));

		const detail = await getCompany([org.id], co.id);
		expect(detail.contacts).toHaveLength(100);
		expect(Array.isArray(detail.conversations)).toBe(true);
	});

	it("lists >100 companies without hitting D1's 100-parameter limit", async () => {
		fakeOutside();
		const org = await seedOrg();
		const at = iso();
		const rows = Array.from({ length: 115 }, (_, i) => ({
			id: `co_${uid().replace(/-/g, "").slice(0, 16)}_${i}`,
			organization_id: org.id,
			name: `Co ${i}`,
			domain: `co-${i}-${uid()}.test`,
			created_at: at,
			updated_at: at,
		}));
		for (let i = 0; i < rows.length; i += 10)
			await db.insert(schema.companies).values(rows.slice(i, i + 10));

		const listed = await listCompanies([org.id], { limit: 150 });
		expect(listed).toHaveLength(115);
	});

	it("queues webhook deliveries across 15 endpoints without hitting D1's 100-parameter limit", async () => {
		fakeOutside();
		const org = await seedOrg();
		for (let i = 0; i < 15; i++) {
			await createWebhook(org.id, {
				url: `https://hook-${i}.example.test/webhook`,
				events: ["email.delivered"],
			});
		}
		await emitEvent(org.id, "email.delivered", crypto.randomUUID(), {});
		const queued = await db
			.select({ id: schema.webhookDeliveries.id })
			.from(schema.webhookDeliveries)
			.where(eq(schema.webhookDeliveries.organization_id, org.id));
		expect(queued).toHaveLength(15);
	});

	it("accepts non-UUID contact (ct_*) and conversation (conv_*) ids on surveys and CSAT ratings", async () => {
		fakeOutside();
		const org = await seedOrg();
		const sv = await createSurvey(org.id, {
			name: "NPS",
			kind: "nps",
			question: "Recommend us?",
		});

		const ctId = `ct_${uid().replace(/-/g, "").slice(0, 24)}`;
		const at = iso();
		await db.insert(schema.contacts).values({
			id: ctId,
			organization_id: org.id,
			email: `ct-${uid()}@example.com`,
			properties: { lang: "es" },
			created_at: at,
			updated_at: at,
		});
		const cUrl = `${await surveyBase(ctId)}/${sv.id}/9`;
		const cPage = await handleSurveyPage(new Request(cUrl));
		expect(cPage.status).toBe(200);
		expect(await cPage.text()).toContain("Enviar");

		const convId = `conv_${uid().replace(/-/g, "").slice(0, 20)}`;
		await db.insert(schema.conversations).values({
			id: convId,
			organization_id: org.id,
			channel: "chat",
			subject: "Portal chat",
			contact: "ana@example.com",
			contact_address: "ana@example.com",
			status: "resolved",
			messages: 1,
			last_message_at: at,
			created_at: at,
			updated_at: at,
		});
		const vUrl = `${await conversationSurveyBase(convId)}/${sv.id}/10`;
		const vPage = await handleSurveyPage(new Request(vUrl));
		expect(vPage.status).toBe(200);

		const rateSig = await sign(`csat:${convId}`);
		const rPage = await handleRate(
			new Request(`https://mailroom.test/rate/${convId}/${rateSig}/5`),
		);
		expect(rPage.status).toBe(200);
	});

	it("evaluates poll and survey conditions in automations", async () => {
		fakeOutside();
		const org = await seedOrg();
		const { contact } = await upsertContact(org.id, {
			email: `auto-${uid()}@example.com`,
		});
		const sv = await createSurvey(org.id, { name: "NPS", kind: "nps" });
		await recordResponse(sv, { value: 10, contact_id: contact.id, source: "email" });

		const b = await createBroadcast(org.id, org.id, {
			subject: "Poll broadcast",
			html: "<p>Hi</p>",
		});
		await db.insert(schema.pollVotes).values({
			broadcast_id: b.id,
			poll_id: "p1",
			contact_id: contact.id,
			answer: 0,
			created_at: iso(),
		});

		const auto = await createAutomation(org.id, {
			name: "Poll & survey branch",
			trigger: { type: "event", event: "poll.answered" },
			steps: [
				{
					type: "condition",
					poll_broadcast_id: b.id,
					poll_id: "p1",
					poll_answer: 0,
					no: [],
				},
				{
					type: "condition",
					survey_id: sv.id,
					survey_answer: "promoter",
					no: [],
				},
				{ type: "property", key: "vip", value: "yes" },
			],
		});

		const sim = await simulateAutomation(org.id, auto.id, contact.email);
		expect(sim.steps[0]?.outcome).toBe("branch_yes");
		expect(sim.steps[1]?.outcome).toBe("branch_yes");
		expect(sim.outcome).toBe("complete");
	});

	it("bulk imports contacts through POST /api/contacts/import", async () => {
		fakeOutside();
		const org = await seedOrg();
		const { token } = await createKey({
			organizationId: org.id,
			name: "import-test",
			permission: "full",
		});
		const res = await handleApi(
			new Request("https://mailroom.test/api/contacts/import", {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					rows: [
						{
							email: `a-${uid()}@example.com`,
							first_name: "Ana",
							properties: { lang: "es" },
						},
						{ email: `b-${uid()}@example.com`, first_name: "Luis" },
					],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { added: number; updated: number; skipped: number };
		expect(data.added).toBe(2);
		expect(data.skipped).toBe(0);
	});
});
